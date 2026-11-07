import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { ack, check, linkDoc, repoint } from "../src/actions.js";
import { newerWriterNotice, READER_LEVEL, unreadableReason } from "../src/compat.js";
import { readLockfile, writeLockfile } from "../src/lockfile.js";
import { createServer } from "../src/mcp-server.js";
import type { Anchor } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const actor = { type: "human" as const };
const repos: string[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await rm(r, { recursive: true, force: true });
});

/** A repo with two linked claims, one of which a newer lockwire is made to have stamped. */
async function repoWithNewerAnchor(change: Partial<Anchor> = { fingerprintVersion: 99 }) {
  const repo = await mkdtemp(join(tmpdir(), "lockwire-compat-"));
  repos.push(repo);
  await mkdir(join(repo, "src"));
  await writeFile(
    join(repo, "src/a.ts"),
    "export function a(x: number) {\n  return x;\n}\nexport function b(y: string) {\n  return y;\n}\n",
  );
  await writeFile(
    join(repo, "CLAUDE.md"),
    "<!-- lockwire src/a.ts#a -->\n`a` takes a number.\n\n<!-- lockwire src/a.ts#b -->\n`b` takes a string.\n",
  );
  await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
  const lock = await readLockfile(repo);
  const newer = lock.anchors.find((x) => x.target.symbol === "a");
  if (!newer) throw new Error("no anchor for a");
  // What a newer lockwire would have written: fingerprints this one computes differently.
  const stamped: Anchor = {
    ...newer,
    ...change,
    fingerprints: { ...newer.fingerprints, sig: "future", body: "future" },
  };
  await writeLockfile(repo, {
    version: 1,
    anchors: lock.anchors.map((x) => (x.id === newer.id ? stamped : x)),
  });
  return { repo, id: newer.id };
}

describe("a lockwire older than the one that stamped some claims", () => {
  it("knows which anchors it can't read", () => {
    const base = { tiers: ["sig"], fingerprintVersion: 2 } as Anchor;
    expect(unreadableReason(base)).toBeNull();
    expect(unreadableReason({ ...base, fingerprintVersion: 99 })).toMatch(/fingerprint version 99/);
    expect(unreadableReason({ ...base, level: READER_LEVEL + 1 })).toMatch(/reader level/);
    expect(unreadableReason({ ...base, tiers: ["sig", "future" as never] })).toMatch(/tier future/);
  });

  it("check leaves them alone instead of reporting drift that isn't there, and keeps them as written", async () => {
    const { repo, id } = await repoWithNewerAnchor();
    const before = (await readLockfile(repo)).anchors.find((a) => a.id === id);
    const result = await check(repo, DEFAULT_CONFIG);
    const r = result.results.find((x) => x.anchor.id === id);
    expect(r).toMatchObject({ skipped: true, status: "fresh" });
    expect(r?.unreadable).toMatch(/fingerprint version 99/);
    expect(result.summary).toMatchObject({ anchors: 1, fresh: 1, drifted: 0, orphaned: 0 });
    expect((await readLockfile(repo)).anchors.find((a) => a.id === id)).toEqual(before);
  });

  it("refuses to re-stamp them: link, ack and repoint all say to update", async () => {
    const { repo, id } = await repoWithNewerAnchor({ level: READER_LEVEL + 1 });
    const linked = await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor, { reviewed: true });
    expect(linked.skipped).toEqual([
      expect.objectContaining({ target: "src/a.ts#a", reason: expect.stringMatching(/newer lockwire/) }),
    ]);
    await expect(ack(repo, id, "updated", undefined, actor, DEFAULT_CONFIG)).rejects.toThrow(
      /newer lockwire/,
    );
    const moved = await repoint(repo, DEFAULT_CONFIG, actor, {
      ids: [id],
      to: { path: "src/a.ts", symbol: "b" },
    });
    expect(moved.skipped[0]?.reason).toMatch(/newer lockwire/);
    // Retiring a claim needs no reading of it.
    await expect(ack(repo, id, "superseded", undefined, actor, DEFAULT_CONFIG)).resolves.toBeDefined();
  });

  it("the lockfile records a level only above 1, and never lowers one", async () => {
    const { repo, id } = await repoWithNewerAnchor({ level: 7 });
    const raw = await readFile(join(repo, "lockwire.lock"), "utf8");
    expect(raw.match(/"level"/g)).toHaveLength(1);
    await check(repo, DEFAULT_CONFIG);
    expect((await readLockfile(repo)).anchors.find((a) => a.id === id)?.level).toBe(7);
  });

  it("says how to update the lockwire that is running", async () => {
    const { repo } = await repoWithNewerAnchor();
    const lock = await readLockfile(repo);
    const saved = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      process.env.CLAUDE_PLUGIN_ROOT = "/plugins/lockwire";
      expect(newerWriterNotice(lock, "agent")).toMatch(
        /1 claim stamped by a newer lockwire.*Tell the user.*claude plugin update lockwire@lockwire/,
      );
      delete process.env.CLAUDE_PLUGIN_ROOT;
      expect(newerWriterNotice(lock, "cli")).toMatch(/^warning: .*npm install -g lockwire@latest/);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = saved;
    }
    expect(newerWriterNotice({ version: 1, anchors: [] }, "cli")).toBeNull();
  });
});

describe.skipIf(!existsSync(CLI))("where the update notice shows up", () => {
  const run = (cwd: string, args: string[], input = "", env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      input,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: "", ...env },
    });

  it("the SessionStart hook tells Claude once per session, and is silent when all is readable", async () => {
    const { repo } = await repoWithNewerAnchor();
    const out = run(repo, ["hook", "claude-session"], JSON.stringify({ cwd: repo }), {
      CLAUDE_PLUGIN_ROOT: "/plugins/lockwire",
    });
    const payload = JSON.parse(out.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toMatch(/claude plugin update/);

    const plain = await mkdtemp(join(tmpdir(), "lockwire-compat-plain-"));
    repos.push(plain);
    expect(run(plain, ["hook", "claude-session"], JSON.stringify({ cwd: plain })).stdout).toBe("");
    expect(existsSync(join(plain, ".lockwire"))).toBe(false);
  });

  it("the CLI warns on stderr, leaving JSON on stdout parseable", async () => {
    const { repo } = await repoWithNewerAnchor();
    const out = run(repo, ["check", "--format", "json", "--no-write"]);
    expect(out.stderr).toMatch(/warning: lockwire.lock has 1 claim stamped by a newer lockwire/);
    expect(JSON.parse(out.stdout).summary.anchors).toBe(1);
  });
});

describe("MCP clients", () => {
  it("are told at initialize, so the model can suggest updating", async () => {
    const { repo } = await repoWithNewerAnchor();
    const server = createServer(repo);
    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(s)]);
    expect(client.getInstructions()).toMatch(/newer lockwire.*Tell the user/);
  });
});
