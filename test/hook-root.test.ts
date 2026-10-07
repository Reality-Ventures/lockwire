import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
