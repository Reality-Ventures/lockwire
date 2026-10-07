import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globToRegExp, isPathGitignored } from "../src/repo.js";

let dirs: string[] = [];
async function tempRepo(gitignore?: string) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-repo-"));
  dirs.push(dir);
  if (gitignore !== undefined) await writeFile(join(dir, ".gitignore"), gitignore, "utf8");
  return dir;
}
afterEach(async () => {
  dirs = [];
});

describe("isPathGitignored", () => {
  it("is false when there's no .gitignore", async () => {
    const repo = await tempRepo();
    expect(isPathGitignored(repo, "lockwire.lock")).toBe(false);
  });

  it("catches an exact filename match", async () => {
    const repo = await tempRepo("lockwire.lock\n");
    expect(isPathGitignored(repo, "lockwire.lock")).toBe(true);
  });

  it("catches a generic *.lock rule -- the reported footgun", async () => {
    const repo = await tempRepo("node_modules/\n*.lock\n");
    expect(isPathGitignored(repo, "lockwire.lock")).toBe(true);
  });

  it("catches a root-anchored pattern", async () => {
    const repo = await tempRepo("/lockwire.lock\n");
    expect(isPathGitignored(repo, "lockwire.lock")).toBe(true);
  });

  it("does not match an unrelated pattern", async () => {
    const repo = await tempRepo("*.log\ndist/\n");
    expect(isPathGitignored(repo, "lockwire.lock")).toBe(false);
  });

  it("does not match a pattern anchored to a different directory", async () => {
    const repo = await tempRepo("subdir/lockwire.lock\n");
    expect(isPathGitignored(repo, "lockwire.lock")).toBe(false);
  });

  it("ignores directory-only patterns (trailing slash) -- lockwire.lock is a file", async () => {
    const repo = await tempRepo("lockwire.lock/\n");
    expect(isPathGitignored(repo, "lockwire.lock")).toBe(false);
  });

  it("skips blank lines and comments", async () => {
    const repo = await tempRepo("\n# a comment\n\n*.lock\n");
    expect(isPathGitignored(repo, "lockwire.lock")).toBe(true);
  });

  it("a later negation re-includes an earlier match, matching git's own precedence", async () => {
    const repo = await tempRepo("*.lock\n!lockwire.lock\n");
    expect(isPathGitignored(repo, "lockwire.lock")).toBe(false);
  });
});

describe("globToRegExp", () => {
  const m = (glob: string, path: string) => globToRegExp(glob).test(path);

  it("`**/` matches zero or more whole directories, never part of a segment", () => {
    expect(m("src/**/test.md", "src/test.md")).toBe(true);
    expect(m("src/**/test.md", "src/a/b/test.md")).toBe(true);
    expect(m("src/**/test.md", "src/xtest.md")).toBe(false);
    expect(m("**/CLAUDE.md", "CLAUDE.md")).toBe(true);
    expect(m("**/CLAUDE.md", "a/b/CLAUDE.md")).toBe(true);
    expect(m("**/CLAUDE.md", "MYCLAUDE.md")).toBe(false);
  });

  it("keeps the default doc globs working", () => {
    expect(m("**/*.md", "README.md")).toBe(true);
    expect(m("**/*.md", "docs/a/b.md")).toBe(true);
    expect(m("node_modules/**", "node_modules/x/y.md")).toBe(true);
    expect(m("docs/**", "docs/a.md")).toBe(true);
  });

  it("`*` stays within one segment and regex metacharacters are literal", () => {
    expect(m("*.md", "a/README.md")).toBe(false);
    expect(m("docs/*.md", "docs/a/b.md")).toBe(false);
    expect(m("a+b(c).md", "a+b(c).md")).toBe(true);
    expect(m("a+b(c).md", "aab(c).md")).toBe(false);
  });
});
