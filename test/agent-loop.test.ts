/**
 * The work queue end to end, the way a user's own agent would use it: a scripted "agent" talks to the
 * real `lockwire mcp` binary over stdio, works through lockwire_tasks until it is empty, and only ever
 * edits documentation. Nothing here is mocked: real files, real git, the built CLI.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { verifyLedger } from "../src/ledger.js";
import type { Task, TaskContext } from "../src/tasks.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const run = (cwd: string, ...args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDECODE: "", CI: "" } });
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const SESSION = (params: string) => `export function createSession(${params}): string {\n  return mint();\n}\n`;

/** A repo with five claims, committed, then a change that breaks four of them and adds an unlinked one. */
async function project() {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-agentloop-"));
  const files: Record<string, string> = {
    "src/session.ts": `${SESSION("userId: string, ttl = 3600")}export function legacyLogin(user: string): void {}\n`,
    "results/bench.json": JSON.stringify({ latency: { p50: 12.4, p99: 40.2 }, model: "baseline-v2" }),
    "CLAUDE.md": [
      "# Project notes",
      "",
      "<!-- lockwire src/session.ts#createSession sig -->",
      "`createSession(userId, ttl)` returns a session token.",
      "",
      "<!-- lockwire results/bench.json#latency.p50 -->",
      "Median latency is 12.4 ms.",
      "",
      "<!-- lockwire results/bench.json#latency.p99 -->",
      "Tail latency (p99) is 40.2 ms.",
      "",
      "<!-- lockwire results/bench.json#model -->",
      "Benchmarks use baseline-v2.",
      "",
      "<!-- lockwire src/session.ts#legacyLogin sig -->",
      "`legacyLogin` is kept for old clients.",
      "",
    ].join("\n"),
    "src/untouched.ts": "export const keep = 1;\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content, "utf8");
  }
  git(dir, "init", "-q", "-b", "main");
  run(dir, "init");
  run(dir, "link", "CLAUDE.md");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  // The change: a new parameter, a rerun, a removed function, and a new claim nobody linked.
  await writeFile(join(dir, "src/session.ts"), SESSION("userId: string, ttl = 3600, scope: string[] = []"), "utf8");
  await writeFile(join(dir, "results/bench.json"), JSON.stringify({ latency: { p50: 15.1, p99: 40.24 }, model: "baseline-v2" }), "utf8");
  const doc = await readFile(join(dir, "CLAUDE.md"), "utf8");
  await writeFile(join(dir, "CLAUDE.md"), `${doc}\n<!-- lockwire results/bench.json#latency.p99 -->\nNobody linked this: p99 is 40.2 ms.\n`, "utf8");
  return dir;
}

async function connect(dir: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: dir, stderr: "ignore" });
  const client = new Client({ name: "scripted-agent", version: "1.0.0" });
  await client.connect(transport);
  const call = async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`);
    return JSON.parse(r.content[0]?.text ?? "null") as T;
  };
  return { client, call };
}

/** Replace the claim at `claimLine` (1-based); `null` deletes the claim and the marker line above it. */
async function editClaim(dir: string, doc: string, claimLine: number, fn: (claim: string) => string | null) {
  const lines = (await readFile(join(dir, doc), "utf8")).split("\n");
  const idx = claimLine - 1;
  const replaced = fn(lines[idx] ?? "");
  if (replaced === null) lines.splice(idx - 1, 2);
  else lines[idx] = replaced;
  await writeFile(join(dir, doc), lines.join("\n"), "utf8");
}

describe.skipIf(!existsSync(CLI))("a scripted agent works the queue to empty over real MCP stdio", () => {
  it("fixes numbers, rewords a changed contract, retires a dead claim, links the unlinked one", async () => {
    const dir = await project();
    const { client, call } = await connect(dir);
    const log: string[] = [];
    try {
      const initial = await call<Task[]>("lockwire_tasks");
      expect(initial.map((t) => t.kind).sort()).toEqual(["code-changed", "target-missing", "unlinked", "value-wrong"].sort());

      for (let round = 0; round < 10; round++) {
        const tasks = await call<Task[]>("lockwire_tasks");
        if (tasks.length === 0) break;
        const t = tasks[0]!;
        const ctx = await call<TaskContext>("lockwire_task_context", { id: t.id });
        const claimLine = t.line ?? 0;
        switch (t.kind) {
          case "value-wrong":
            await editClaim(dir, t.doc!, claimLine, (claim) => claim.replace(/\d+(\.\d+)?(?= ms)/, ctx.now.source ?? ""));
            break;
          case "code-changed":
            expect(ctx.stamped?.exact).toBe(true);
            expect(ctx.stamped?.source).toContain("ttl = 3600)");
            expect(ctx.now.source).toContain("scope: string[]");
            await editClaim(dir, t.doc!, claimLine, () => "`createSession(userId, ttl, scope)` returns a session token limited to `scope`.");
            break;
          case "target-missing": {
            await editClaim(dir, t.doc!, claimLine, () => null);
            const acked = await call<{ status: string }>("lockwire_ack", { anchor: t.id, resolution: "superseded", note: "legacyLogin was removed" });
            expect(acked.status).toBe("superseded");
            log.push(`${t.kind} ${t.id}: retired`);
            continue;
          }
          case "unlinked":
            expect(ctx.now.source).toBe("40.24");
            break; // the sentence (40.2) is true at its precision: just start checking it
          default:
            throw new Error(`unexpected task ${t.kind}`);
        }
        const out = await call<{ status: string; reason?: string }>("lockwire_resolve", { id: t.id, note: `fixed ${t.kind}` });
        expect(out.status, `${t.kind}: ${out.reason}`).toBe("resolved");
        log.push(`${t.kind} ${t.id}: ${out.status}`);
      }

      expect(await call<Task[]>("lockwire_tasks")).toEqual([]);
    } finally {
      await client.close();
    }

    // The repo now checks clean, the ledger verifies, and the agent only touched docs and lockwire's files.
    expect(log).toHaveLength(4);
    expect(run(dir, "check", "--no-write")).toContain("0 drifted · 0 orphaned");
    expect((await verifyLedger(dir)).ok).toBe(true);
    const changed = git(dir, "status", "--porcelain", "-z").split("\0").filter(Boolean).map((l) => l.slice(3)).sort();
    expect(changed.filter((f) => !/^(CLAUDE\.md|lockwire\.lock|\.lockwire\/|src\/session\.ts|results\/bench\.json)/.test(f))).toEqual([]);
    expect(git(dir, "diff", "--", "src/session.ts", "results/bench.json")).not.toBe(""); // the setup's changes, untouched by the agent
    const doc = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(doc).toContain("Median latency is 15.1 ms.");
    expect(doc).toContain("limited to `scope`");
    expect(doc).not.toContain("legacyLogin");
    expect(doc).toContain("Tail latency (p99) is 40.2 ms."); // within precision: left alone
    const history = run(dir, "history", "CLAUDE.md");
    expect(history.match(/resolved by scripted-agent/g)?.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("a wrong fix is refused over MCP and the agent can recover in the next round", async () => {
    const dir = await project();
    const { client, call } = await connect(dir);
    try {
      const value = (await call<Task[]>("lockwire_tasks")).find((t) => t.kind === "value-wrong")!;
      await editClaim(dir, value.doc!, value.line!, (c) => c.replace("12.4", "14.0"));
      const bad = await call<{ status: string; reason: string }>("lockwire_resolve", { id: value.id });
      expect(bad.status).toBe("refused");
      expect(bad.reason).toContain("is 15.1");
      await editClaim(dir, value.doc!, value.line!, (c) => c.replace("14.0", "15.1"));
      expect((await call<{ status: string }>("lockwire_resolve", { id: value.id })).status).toBe("resolved");
    } finally {
      await client.close();
    }
  }, 60_000);
});
