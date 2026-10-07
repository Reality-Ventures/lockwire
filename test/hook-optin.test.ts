import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { isLockwireRepo, toDisplayPath } from "../src/repo.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const MARKED = "# Notes\n\n<!-- lockwire src/app.ts#thing sig -->\nA claim about thing.\n";

/** An ordinary git repo with docs, that has never heard of lockwire. */
async function plainRepo(extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-optin-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "src", "app.ts"), "export const thing = 1;\n", "utf8");
  await writeFile(join(dir, "README.md"), "# Plain project\n", "utf8");
  await writeFile(join(dir, "docs", "d.md"), MARKED, "utf8"); // a marker, to be sure a scan WOULD find something
  for (const [rel, content] of Object.entries(extra)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content, "utf8");
  }
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, status: () => execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir, encoding: "utf8" }) };
}
const listing = (dir: string) => readdirSync(dir).sort();
const run = (dir: string, adapter: string, input: unknown) =>
  spawnSync(process.execPath, [CLI, "hook", adapter], { cwd: dir, input: JSON.stringify(input), encoding: "utf8" });
const claudeEdit = (dir: string, file: string) => ({ tool_name: "Edit", tool_input: { file_path: join(dir, file) }, cwd: dir });
const codexEdit = (dir: string, file: string) => ({
  tool_name: "apply_patch",
  tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n` },
  cwd: dir,
});

describe("isLockwireRepo", () => {
  it("is true for a lockwire.lock or a .lockwire/config.json, and false otherwise", async () => {
    const { dir } = await plainRepo();
    expect(isLockwireRepo(dir)).toBe(false);
    await mkdir(join(dir, ".lockwire"));
    expect(isLockwireRepo(dir)).toBe(false); // a bare directory isn't an opt-in
    await writeFile(join(dir, ".lockwire", "config.json"), "{}", "utf8");
    expect(isLockwireRepo(dir)).toBe(true);
    const other = (await plainRepo()).dir;
    await writeFile(join(other, "lockwire.lock"), '{"version":1,"anchors":[]}', "utf8");
    expect(isLockwireRepo(other)).toBe(true);
  });
});

describe.skipIf(!existsSync(CLI))("the hooks leave a repo that never opted into lockwire completely alone", () => {
  it.each([
    ["claude-pre", claudeEdit],
    ["codex-pre", codexEdit],
  ] as const)("%s: silent, scans nothing, creates no files, and `git status` stays clean", async (adapter, input) => {
    const { dir, status } = await plainRepo();
    const before = listing(dir);
    const r = run(dir, adapter, input(dir, adapter.startsWith("codex") ? "src/app.ts" : "src/app.ts"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(listing(dir)).toEqual(before);
    expect(existsSync(join(dir, ".lockwire"))).toBe(false);
    expect(status()).toBe("");
  });

  it.each([
    ["claude-post", claudeEdit],
    ["codex-post", codexEdit],
  ] as const)("%s: editing code or a plain doc is silent and writes nothing", async (adapter, input) => {
    const { dir, status } = await plainRepo();
    const before = listing(dir);
    for (const file of ["src/app.ts", "README.md"]) {
      const r = run(dir, adapter, input(dir, file));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(listing(dir)).toEqual(before);
    expect(status()).toBe("");
  });

  it("an error in the hook doesn't leave a .lockwire/hook.log in a repo that hasn't opted in", async () => {
    const { dir, status } = await plainRepo();
    for (const bad of ["not json at all", "{"]) {
      const r = spawnSync(process.execPath, [CLI, "hook", "claude-pre"], { cwd: dir, input: bad, encoding: "utf8" });
      expect(r.status).toBe(0);
    }
    expect(existsSync(join(dir, ".lockwire"))).toBe(false);
    expect(status()).toBe("");
  });

  it("...but in a repo that has a .lockwire directory already, errors are still logged there", async () => {
    const { dir } = await plainRepo();
    await mkdir(join(dir, ".lockwire"));
    spawnSync(process.execPath, [CLI, "hook", "claude-pre"], { cwd: dir, input: "{", encoding: "utf8" });
    expect(existsSync(join(dir, ".lockwire", "hook.log"))).toBe(true);
  });
});

describe.skipIf(!existsSync(CLI))("each real opt-in signal turns the unlinked-claims scan on", () => {
  const text = (dir: string) => {
    const r = run(dir, "claude-pre", claudeEdit(dir, "src/app.ts"));
    return r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string) : "";
  };

  it("a lockwire.lock", async () => {
    const { dir } = await plainRepo({ "lockwire.lock": '{"version":1,"anchors":[]}' });
    expect(text(dir)).toContain("docs/d.md:3 asserts");
  });

  it("a .lockwire/config.json on its own", async () => {
    const { dir } = await plainRepo({ ".lockwire/config.json": '{"version":1}' });
    expect(text(dir)).toContain("docs/d.md:3 asserts");
  });

  it("neither: nothing, even though the same doc is sitting there", async () => {
    const { dir } = await plainRepo();
    expect(text(dir)).toBe("");
  });
});

describe.skipIf(!existsSync(CLI))("explicit commands still work anywhere", () => {
  it("`lockwire index` builds the index in a repo that hasn't opted in, because you asked it to", async () => {
    const { dir } = await plainRepo();
    const r = spawnSync(process.execPath, [CLI, "index"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("indexed 2 docs (1 marker)");
    expect(await readFile(join(dir, ".lockwire", ".gitignore"), "utf8")).toContain("cache/");
  });
});

describe("toDisplayPath", () => {
  it("shows forward slashes for a Windows root, the case that failed CI on windows-latest", () => {
    const root = "D:\\a\\lockwire\\repo";
    const index = "D:\\a\\lockwire\\repo\\.lockwire\\cache\\doc-index.json";
    expect(toDisplayPath(root, index, path.win32)).toBe(".lockwire/cache/doc-index.json");
    // the previous implementation, for the record: slicing the root off leaves the native separators
    expect(index.slice(root.length + 1)).toBe(".lockwire\\cache\\doc-index.json");
  });

  it("is the same on POSIX paths, and for paths outside the root", () => {
    expect(toDisplayPath("/r", "/r/.lockwire/cache/x.json", path.posix)).toBe(".lockwire/cache/x.json");
    expect(toDisplayPath("/r", "/elsewhere/x.json", path.posix)).toBe("../elsewhere/x.json");
    expect(toDisplayPath("C:\\r", "C:\\other\\x.json", path.win32)).toBe("../other/x.json");
  });
});
