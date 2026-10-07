import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changedFiles, resolveBase } from "../src/changed.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const B_TS = "export function beta(s: string): string {\n  return s;\n}\n";
const DOC = (extra = "") =>
  `# D\n\n<!-- lockwire src/a.ts#alpha sig,body -->\nalpha adds one.\n\n<!-- lockwire src/b.ts#beta sig,body -->\nbeta echoes.\n${extra}`;

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}
const cli = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_BASE_REF: "", ...env },
  });

/** A repo on `main` with two linked docs-anchors committed, then a `feature` branch checked out. */
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-changed-"));
  git(dir, "init", "-q", "-b", "main");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), A_TS, "utf8");
  await writeFile(join(dir, "src", "b.ts"), B_TS, "utf8");
  await writeFile(join(dir, "CLAUDE.md"), DOC(), "utf8");
  cli(dir, ["init"]);
  cli(dir, ["link", "CLAUDE.md"]);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  return dir;
}
const edit = (dir: string, file: string, from: string, to: string) =>
  readFile(join(dir, file), "utf8").then((t) => writeFile(join(dir, file), t.replace(from, to), "utf8"));

describe("changedFiles", () => {
  it("lists committed, uncommitted and untracked changes against the merge base, nothing else", async () => {
    const dir = await repo();
    expect(changedFiles(dir)).toEqual([]);

    await edit(dir, "src/a.ts", "x + 1", "x + 2");
    git(dir, "commit", "-qam", "committed change");
    await edit(dir, "src/b.ts", "return s", "return s.trim()"); // uncommitted
    await writeFile(join(dir, "new.ts"), "export {};\n", "utf8"); // untracked
    expect(changedFiles(dir)).toEqual(["new.ts", "src/a.ts", "src/b.ts"]);
  });

  it("ignores what landed on main after the branch point", async () => {
    const dir = await repo();
    git(dir, "checkout", "-q", "main");
    await writeFile(join(dir, "other.ts"), "export {};\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "main moves on");
    git(dir, "checkout", "-q", "feature");
    await edit(dir, "src/a.ts", "x + 1", "x + 2");
    expect(changedFiles(dir)).toEqual(["src/a.ts"]);
  });

  it("lists both sides of a rename so the old path's anchors are still examined", async () => {
    const dir = await repo();
    await rename(join(dir, "src", "a.ts"), join(dir, "src", "moved.ts"));
    git(dir, "add", "-A");
    expect(changedFiles(dir)).toEqual(["src/a.ts", "src/moved.ts"]);
  });

  it("--staged is only what's in the index", async () => {
    const dir = await repo();
    await edit(dir, "src/a.ts", "x + 1", "x + 2");
    git(dir, "add", "src/a.ts");
    await edit(dir, "src/b.ts", "return s", "return s.trim()"); // unstaged
    expect(changedFiles(dir, { staged: true })).toEqual(["src/a.ts"]);
  });

  it("paths are relative to the lockwire root when it sits below the git root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-mono-"));
    git(dir, "init", "-q", "-b", "main");
    await mkdir(join(dir, "pkg", "src"), { recursive: true });
    await writeFile(join(dir, "pkg", "src", "a.ts"), A_TS, "utf8");
    await writeFile(join(dir, "top.txt"), "x", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    git(dir, "checkout", "-q", "-b", "feature");
    await edit(dir, "pkg/src/a.ts", "x + 1", "x + 2");
    await edit(dir, "top.txt", "x", "y");
    expect(changedFiles(join(dir, "pkg"))).toEqual(["src/a.ts"]);
  });

  it("explains how to name a base instead of guessing, and rejects an unknown --base", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-nobase-"));
    git(dir, "init", "-q", "-b", "trunk");
    await writeFile(join(dir, "a.txt"), "x", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "only commit");
    expect(() => changedFiles(dir)).toThrow(/Pass --base <ref>/);
    expect(() => changedFiles(dir, { base: "nope" })).toThrow(/can't find that ref/);
    expect(changedFiles(dir, { base: "trunk" })).toEqual([]);
  });

  it("outside a git repository it says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-nogit-"));
    expect(() => changedFiles(dir)).toThrow(/git repository/);
  });

  it("resolveBase prefers GITHUB_BASE_REF so a PR job compares against its target branch", async () => {
    const dir = await repo();
    git(dir, "branch", "release");
    const run = (args: string[]) => git(dir, ...args);
    expect(resolveBase(run, undefined, { GITHUB_BASE_REF: "release" })).toBe("release");
    expect(resolveBase(run, undefined, {})).toBe("main");
    expect(resolveBase(run, "release", { GITHUB_BASE_REF: "main" })).toBe("release");
  });
});

describe.skipIf(!existsSync(CLI))("lockwire check --changed / --staged / --no-write", () => {
  it("--changed examines only anchors on touched files, and unrelated ones can't fail the run", async () => {
    const dir = await repo();
    await edit(dir, "src/a.ts", "x + 1", "x + 2");
    const run = cli(dir, ["check", "--changed", "--format", "json"]);
    expect(run.status).toBe(1);
    const out = JSON.parse(run.stdout);
    expect(out.anchors.map((a: { target: string }) => a.target)).toEqual(["src/a.ts#alpha"]);
    expect(out.summary).toMatchObject({ anchors: 1, drifted: 1 });
  });

  it("a branch that touches nothing bound passes, even if another anchor is stored as drifted", async () => {
    const dir = await repo();
    await edit(dir, "src/b.ts", "return s", "return s.trim()"); // drift beta ...
    cli(dir, ["check"]); // ... and persist it as `drifted` in the lock
    git(dir, "checkout", "-q", "--", "src/b.ts");
    await writeFile(join(dir, "README.txt"), "unrelated", "utf8");
    const run = cli(dir, ["check", "--changed"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("0 anchors");
  });

  it("editing the doc is enough to put its anchors in scope", async () => {
    const dir = await repo();
    await edit(dir, "CLAUDE.md", "alpha adds one", "alpha subtracts one");
    const run = cli(dir, ["check", "--changed"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("(claim)");
  });

  it("a moved file orphans its anchors", async () => {
    const dir = await repo();
    await rename(join(dir, "src", "a.ts"), join(dir, "src", "moved.ts"));
    const run = cli(dir, ["check", "--changed"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("ORPHANED");
  });

  it("--staged ignores unstaged work", async () => {
    const dir = await repo();
    await edit(dir, "src/a.ts", "x + 1", "x + 2"); // unstaged only
    expect(cli(dir, ["check", "--staged", "--no-write"]).status).toBe(0);
    git(dir, "add", "src/a.ts");
    expect(cli(dir, ["check", "--staged", "--no-write"]).status).toBe(1);
  });

  it("--no-write leaves lockwire.lock and the ledger byte-for-byte alone, even when it finds drift", async () => {
    const dir = await repo();
    await edit(dir, "src/a.ts", "x + 1", "x + 2");
    const snap = async () =>
      [await readFile(join(dir, "lockwire.lock"), "utf8"), await readFile(join(dir, ".lockwire", "ledger.jsonl"), "utf8")];
    const before = await snap();
    const dry = cli(dir, ["check", "--changed", "--no-write"]);
    expect(dry.status).toBe(1);
    expect(await snap()).toEqual(before);
    expect(git(dir, "status", "--porcelain")).not.toMatch(/lockwire\.lock|ledger/);

    // Same run without the flag records the drift, as before.
    cli(dir, ["check", "--changed"]);
    expect(await snap()).not.toEqual(before);
  });

  it("--no-write also works without --changed, and after a flag a path is still a path", async () => {
    const dir = await repo();
    await edit(dir, "src/a.ts", "x + 1", "x + 2");
    const before = await readFile(join(dir, "lockwire.lock"), "utf8");
    const run = cli(dir, ["check", "--no-write", "src/a.ts", "--format", "json"]);
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).anchors).toHaveLength(1);
    expect(await readFile(join(dir, "lockwire.lock"), "utf8")).toBe(before);
  });

  it("works from a subdirectory", async () => {
    const dir = await repo();
    await edit(dir, "src/a.ts", "x + 1", "x + 2");
    expect(cli(join(dir, "src"), ["check", "--changed", "--no-write"]).status).toBe(1);
  });

  it("refuses paths together with --changed, and says so when there's no base", async () => {
    const dir = await repo();
    const both = cli(dir, ["check", "--changed", "src/a.ts"]);
    expect(both.status).not.toBe(0);
    expect(both.stderr).toMatch(/not both/);

    const lone = await mkdtemp(join(tmpdir(), "lockwire-lone-"));
    git(lone, "init", "-q", "-b", "trunk");
    await writeFile(join(lone, "a.txt"), "x", "utf8");
    git(lone, "add", "-A");
    git(lone, "commit", "-qm", "c");
    cli(lone, ["init"]);
    const noBase = cli(lone, ["check", "--changed"]);
    expect(noBase.status).not.toBe(0);
    expect(noBase.stderr).toMatch(/--base <ref>/);
    expect(cli(lone, ["check", "--changed", "--base", "trunk"]).status).toBe(0);
  });

  it("uses GITHUB_BASE_REF the way a pull-request job sees it", async () => {
    const dir = await repo();
    await edit(dir, "src/a.ts", "x + 1", "x + 2");
    git(dir, "commit", "-qam", "change");
    git(dir, "branch", "-m", "main", "base-branch");
    const run = cli(dir, ["check", "--changed", "--no-write"], { GITHUB_BASE_REF: "base-branch" });
    expect(run.status).toBe(1);
  });
});
