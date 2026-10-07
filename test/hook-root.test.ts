import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { linkDoc } from "../src/actions.js";
import { absoluteHookPath, resolveHookRoot } from "../src/hook-common.js";
import { tryFindRepoRoot } from "../src/repo.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const DOC = "# D\n\n<!-- lockwire src/a.ts#alpha sig,body -->\nalpha adds one.\n";

/** A workspace folder (no .git, no lockwire.lock) holding one repo, like Desktop/THG/<project>. */
async function workspaceWithRepo() {
  const workspace = await mkdtemp(join(tmpdir(), "lockwire-ws-"));
  const repo = join(workspace, "project");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, ".git"));
  await writeFile(join(repo, "src", "a.ts"), A_TS, "utf8");
  await writeFile(join(repo, "CLAUDE.md"), DOC, "utf8");
  await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });
  return { workspace, repo };
}

describe("hook root discovery", () => {
  it("tryFindRepoRoot reports nothing found instead of guessing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-none-"));
    expect(tryFindRepoRoot(dir)).toBeUndefined();
  });

  it("finds the repo from the edited file even when the session cwd is above it", async () => {
    const { workspace, repo } = await workspaceWithRepo();
    const abs = join(repo, "src", "a.ts");
    expect(resolveHookRoot(workspace, { cwd: workspace }, abs)).toBe(repo);
  });

  it("resolves relative file paths against the hook's cwd, not the repo root", async () => {
    const { workspace } = await workspaceWithRepo();
    expect(absoluteHookPath({ cwd: workspace }, "project/src/a.ts")).toBe(
      join(workspace, "project", "src", "a.ts"),
    );
  });

  it.skipIf(!existsSync(CLI))("claude-pre still injects claims end to end when the session started above the repo", async () => {
    const { workspace, repo } = await workspaceWithRepo();
    const run = (adapter: string) =>
      spawnSync(process.execPath, [CLI, "hook", adapter], {
          cwd: workspace,
          input: JSON.stringify({
            tool_name: "Edit",
            tool_input: { file_path: join(repo, "src", "a.ts") },
            cwd: workspace,
          }),
          encoding: "utf8",
        },
      );
    const pre = run("claude-pre");
    expect(pre.status).toBe(0);
    expect(pre.stdout).toContain("alpha adds one.");

    await writeFile(join(repo, "src", "a.ts"), A_TS.replace("x + 1", "x + 9"), "utf8");
    const post = run("claude-post");
    expect(post.stdout).toContain("drifted");
  });
});

describe("repo root precedence: the nearest lockwire.lock or .git wins", () => {
  async function tree() {
    const outer = await mkdtemp(join(tmpdir(), "lockwire-prec-"));
    await writeFile(join(outer, "lockwire.lock"), '{"version":1,"anchors":[]}', "utf8"); // a stray lockfile
    const inner = join(outer, "project");
    await mkdir(join(inner, "src"), { recursive: true });
    await mkdir(join(inner, ".git"));
    await writeFile(join(inner, "src", "a.ts"), "export const a = 1;\n", "utf8");
    return { outer, inner };
  }

  it("a stray lockwire.lock above a project with its own .git doesn't capture it", async () => {
    const { outer, inner } = await tree();
    expect(tryFindRepoRoot(join(inner, "src"))).toBe(inner);
    expect(resolveHookRoot(outer, { cwd: outer }, join(inner, "src", "a.ts"))).toBe(inner);
  });

  it("`lockwire init` in that project creates its own lockfile and leaves the stray one alone", async () => {
    if (!existsSync(CLI)) return;
    const { outer, inner } = await tree();
    const before = readFileSync(join(outer, "lockwire.lock"), "utf8");
    const r = spawnSync(process.execPath, [CLI, "init"], { cwd: join(inner, "src"), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(existsSync(join(inner, "lockwire.lock"))).toBe(true);
    expect(readFileSync(join(outer, "lockwire.lock"), "utf8")).toBe(before);
  });

  it("with no .git or lockfile in between, the outer lockfile still applies to a plain subfolder", async () => {
    const { outer } = await tree();
    await mkdir(join(outer, "plain", "deep"), { recursive: true });
    expect(tryFindRepoRoot(join(outer, "plain", "deep"))).toBe(outer);
  });

  it("a nested project that has its own lockwire.lock keeps it", async () => {
    const { outer, inner } = await tree();
    await writeFile(join(inner, "lockwire.lock"), '{"version":1,"anchors":[]}', "utf8");
    expect(tryFindRepoRoot(join(inner, "src"))).toBe(inner);
    expect(outer).not.toBe(inner);
  });
});
