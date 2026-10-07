import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check, linkDoc } from "../src/actions.js";
import { readLedger, verifyLedger } from "../src/ledger.js";
import type { LedgerRecord } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const A_DRIFTED = "export function alpha(x: number, y: number): number {\n  return x + y;\n}\n";
const DOC = "# D\n\n<!-- lockwire src/a.ts#alpha sig -->\nalpha adds one.\n";
const NO_AGENT_ENV = {
  CLAUDECODE: "",
  CLAUDE_CODE_ENTRYPOINT: "",
  CODEX_SANDBOX: "",
  CODEX_HOME: "",
  CI: "",
};

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
async function repo({ withGit }: { withGit: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-attr-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), A_TS, "utf8");
  await writeFile(join(dir, "CLAUDE.md"), DOC, "utf8");
  await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });
  if (withGit) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
  }
  return dir;
}
const events = async (dir: string, kind: string): Promise<LedgerRecord[]> =>
  (await readLedger(dir)).filter((e) => e.event === kind);
const cli = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...NO_AGENT_ENV, ...env },
    ...(input === undefined ? {} : { input }),
  });

describe("ledger attribution: who noticed, and on which commit", () => {
  it("a drift event carries the actor that ran the check", async () => {
    const dir = await repo({ withGit: false });
    await writeFile(join(dir, "src", "a.ts"), A_DRIFTED, "utf8");
    const actor = { type: "ai" as const, tool: { name: "claude-code" }, session: "sess-42" };
    await check(dir, DEFAULT_CONFIG, undefined, { actor });
    const [drift] = await events(dir, "anchor.drifted");
    expect(drift?.actor).toEqual(actor);
    expect((await verifyLedger(dir)).ok).toBe(true);
  });

  it("with no actor given the event says `unknown` rather than inventing one", async () => {
    const dir = await repo({ withGit: false });
    await writeFile(join(dir, "src", "a.ts"), A_DRIFTED, "utf8");
    await check(dir, DEFAULT_CONFIG);
    expect((await events(dir, "anchor.drifted"))[0]?.actor).toEqual({ type: "unknown" });
  });

  it("every event records the HEAD commit it happened on, and null when there isn't one", async () => {
    const inGit = await repo({ withGit: true });
    const head = git(inGit, "rev-parse", "--short", "HEAD");
    await writeFile(join(inGit, "src", "a.ts"), A_DRIFTED, "utf8");
    await check(inGit, DEFAULT_CONFIG);
    const drift = (await events(inGit, "anchor.drifted"))[0];
    expect(drift?.commit).toBe(head);
    // ...including events recorded before the first commit existed (null), which stay null.
    expect((await events(inGit, "anchor.created"))[0]?.commit).toBeNull();
    expect((await verifyLedger(inGit)).ok).toBe(true);

    const noGit = await repo({ withGit: false });
    await writeFile(join(noGit, "src", "a.ts"), A_DRIFTED, "utf8");
    await check(noGit, DEFAULT_CONFIG);
    expect((await events(noGit, "anchor.drifted"))[0]?.commit).toBeNull();
  });

  it("a dry run records nothing, attribution or otherwise", async () => {
    const dir = await repo({ withGit: true });
    const before = await readFile(join(dir, ".lockwire", "ledger.jsonl"), "utf8");
    await writeFile(join(dir, "src", "a.ts"), A_DRIFTED, "utf8");
    await check(dir, DEFAULT_CONFIG, undefined, { write: false });
    expect(await readFile(join(dir, ".lockwire", "ledger.jsonl"), "utf8")).toBe(before);
  });
});

describe.skipIf(!existsSync(CLI))("attribution through the real entry points", () => {
  it("the PostToolUse hook attributes drift to the AI tool and its session", async () => {
    const dir = await repo({ withGit: true });
    await writeFile(join(dir, "src", "a.ts"), A_DRIFTED, "utf8");
    const payload = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: join(dir, "src", "a.ts") },
      session_id: "abc-123",
      cwd: dir,
    });
    const run = cli(dir, ["hook", "claude-post"], {}, payload);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("drifted");
    const [drift] = await events(dir, "anchor.drifted");
    expect(drift?.actor).toEqual({ type: "ai", tool: { name: "claude-code" }, session: "abc-123" });
    expect(drift?.commit).toBe(git(dir, "rev-parse", "--short", "HEAD"));
  });

  it("the codex hook says codex", async () => {
    const dir = await repo({ withGit: false });
    await writeFile(join(dir, "src", "a.ts"), A_DRIFTED, "utf8");
    const payload = JSON.stringify({
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n" },
      cwd: dir,
    });
    cli(dir, ["hook", "codex-post"], {}, payload);
    expect((await events(dir, "anchor.drifted"))[0]?.actor).toMatchObject({
      type: "ai",
      tool: { name: "codex" },
    });
  });

  it("the CLI attributes to whoever ran it: a person, CI, or an agent shell", async () => {
    const actorFor = async (env: Record<string, string>) => {
      const dir = await repo({ withGit: false });
      await writeFile(join(dir, "src", "a.ts"), A_DRIFTED, "utf8");
      cli(dir, ["check"], env);
      return (await events(dir, "anchor.drifted"))[0]?.actor;
    };
    expect(await actorFor({})).toEqual({ type: "human" });
    expect(await actorFor({ CI: "true" })).toEqual({ type: "unknown", tool: { name: "ci" } });
    expect(await actorFor({ CLAUDECODE: "1" })).toEqual({ type: "ai", tool: { name: "claude-code" } });
  });

  it("`lockwire history` shows the events in order, with their notes", async () => {
    const dir = await repo({ withGit: true });
    await writeFile(join(dir, "src", "a.ts"), A_DRIFTED, "utf8");
    cli(dir, ["check"]);
    const id = (await readLedger(dir))[0]?.anchor ?? "";
    const out = cli(dir, ["history", id]).stdout.trim().split("\n");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z {2}anchor\.created/);
    expect(out[1]).toMatch(/anchor\.drifted +sig$/);
  });
});
