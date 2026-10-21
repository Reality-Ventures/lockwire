/**
 * One writer per repository at a time. Agents make parallel tool calls, and hooks, the CLI and the
 * MCP server can all run at once; each write is a read-modify-write of `lockwire.lock`, the ledger
 * and a doc, so two of them interleaved lose one's update. Everything that writes runs inside
 * `withRepoLock`:
 *
 *  - within a process (the MCP server serving parallel calls), writers queue on a promise chain;
 *  - across processes, a `.lockwire/lock` file created exclusively (`wx`); a lock older than
 *    STALE_MS, or whose process is gone, is taken over.
 *
 * Reentrant: a locked operation that calls another (resolve calls link) doesn't wait on itself.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const STALE_MS = 30_000;
const TIMEOUT_MS = 15_000;
const POLL_MS = 20;

const chains = new Map<string, Promise<void>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

export const repoLockPath = (repoRoot: string) => join(repoRoot, ".lockwire", "lock");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireFile(repoRoot: string): Promise<(() => void) | null> {
  // No `.lockwire/` (a repo that hasn't run `init`): nothing else is writing, and creating the
  // directory just to lock it would leave lockwire's files in a repo that never opted in.
  if (!existsSync(join(repoRoot, ".lockwire"))) return null;
  const path = repoLockPath(repoRoot);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now(), token }), {
        flag: "wx",
      });
      return () => {
        try {
          if (JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null; // unwritable: don't block
    }
    try {
      const { pid, at } = JSON.parse(readFileSync(path, "utf8"));
      if (Date.now() - Number(at) > STALE_MS || !alive(Number(pid))) {
        unlinkSync(path);
        continue;
      }
    } catch {
      // half-written or vanished between our attempts: try again
    }
    if (Date.now() > deadline)
      throw new Error(
        `lockwire is busy: another lockwire process holds ${path} (remove it if no lockwire is running)`,
      );
    await sleep(POLL_MS);
  }
}

export async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(repoRoot);
  const mine = held.getStore();
  if (mine?.has(key)) return fn();

  const previous = chains.get(key) ?? Promise.resolve();
  let done!: () => void;
  const gate = new Promise<void>((r) => {
    done = r;
  });
  const current = previous.then(() => gate);
  chains.set(key, current);
  await previous;
  let releaseFile: (() => void) | null = null;
  try {
    releaseFile = await acquireFile(repoRoot);
    return await held.run(new Set([...(mine ?? []), key]), fn);
  } finally {
    releaseFile?.();
    done();
    if (chains.get(key) === current) chains.delete(key);
  }
}
