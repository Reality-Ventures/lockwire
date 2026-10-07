import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { linkDoc } from "../src/actions.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const DOC = "# D\n\n<!-- lockwire src/a.ts#alpha sig -->\nalpha adds one.\n";
const ADAPTERS = ["claude-pre", "claude-post", "codex-pre", "codex-post"] as const;

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-failopen-"));
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, "src", "a.ts"), A_TS, "utf8");
  await writeFile(join(dir, "CLAUDE.md"), DOC, "utf8");
  await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });
  return dir;
}
const payloadFor = (adapter: string, dir: string) =>
  JSON.stringify(
    adapter.startsWith("codex")
      ? {
          tool_name: "apply_patch",
          tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n" },
          cwd: dir,
        }
      : { tool_name: "Edit", tool_input: { file_path: join(dir, "src", "a.ts") }, cwd: dir },
  );
const run = (dir: string, adapter: string, input: string) =>
  spawnSync(process.execPath, [CLI, "hook", adapter], { cwd: dir, input, encoding: "utf8" });

describe.skipIf(!existsSync(CLI))("hooks fail open: a broken lockwire never breaks a tool call", () => {
  it.each(ADAPTERS)("%s: a corrupt lockfile -> exit 0, no output, error logged to hook.log", async (adapter) => {
    const dir = await repo();
    await writeFile(join(dir, "lockwire.lock"), "{ this is not json", "utf8");
    const r = run(dir, adapter, payloadFor(adapter, dir));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const log = await readFile(join(dir, ".lockwire", "hook.log"), "utf8");
    expect(log).toContain(adapter);
    expect(log).toMatch(/not valid JSON/);
  });

  it.each(ADAPTERS)("%s: an unresolved merge conflict in the lockfile fails open too", async (adapter) => {
    const dir = await repo();
    await writeFile(join(dir, "lockwire.lock"), "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n", "utf8");
    const r = run(dir, adapter, payloadFor(adapter, dir));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(await readFile(join(dir, ".lockwire", "hook.log"), "utf8")).toMatch(/merge conflicts/);
  });

  it.each(ADAPTERS)("%s: malformed stdin -> exit 0 and silent", async (adapter) => {
    const dir = await repo();
    for (const input of ["", "not json at all", "{", "[]", "null"]) {
      const r = run(dir, adapter, input);
      expect(r.status, `input ${JSON.stringify(input)}`).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it.each(ADAPTERS)("%s: a corrupt config.json -> exit 0 and silent", async (adapter) => {
    const dir = await repo();
    await mkdir(join(dir, ".lockwire"), { recursive: true });
    await writeFile(join(dir, ".lockwire", "config.json"), "{{{", "utf8");
    const r = run(dir, adapter, payloadFor(adapter, dir));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("an edit to a file with no anchors is silent and exits 0 (the common case)", async () => {
    const dir = await repo();
    await writeFile(join(dir, "unrelated.ts"), "export {};\n", "utf8");
    const payload = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: join(dir, "unrelated.ts") },
      cwd: dir,
    });
    for (const adapter of ["claude-pre", "claude-post"]) {
      const r = run(dir, adapter, payload);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(existsSync(join(dir, ".lockwire", "hook.log"))).toBe(false);
  });

  it("a healthy repo still injects claims (fail-open doesn't mean fail-silent)", async () => {
    const dir = await repo();
    const r = run(dir, "claude-pre", payloadFor("claude-pre", dir));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("alpha adds one.");
  });
});
