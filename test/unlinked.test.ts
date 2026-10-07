import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check, linkDoc } from "../src/actions.js";
import { formatGithub, formatText } from "../src/format.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const M = (extra = "") => `<!-- lockwire src/a.ts#alpha sig${extra} -->`;
const doc = (marker: string, sentence = "alpha adds one.") => `# D\n\n${marker}\n${sentence}\n`;
const actor = { type: "human" as const };

async function repo(files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-unlinked-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), A_TS, "utf8");
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content, "utf8");
  }
  return dir;
}
const unlinkedOf = async (dir: string, paths?: string[]) =>
  (await check(dir, DEFAULT_CONFIG, paths, { write: false })).unlinked;
const cli = (cwd: string, args: string[], input?: string) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLAUDECODE: "", CI: "" },
    ...(input === undefined ? {} : { input }),
  });

describe("check reports markers that no anchor backs", () => {
  it("a marker with no id is 'not linked yet', with its line and target, and linking clears it", async () => {
    const dir = await repo({ "CLAUDE.md": `# D\n\nintro\n\n${M()}\nalpha adds one.\n` });
    expect(await unlinkedOf(dir)).toEqual([
      {
        doc: "CLAUDE.md",
        line: 5,
        target: "src/a.ts#alpha",
        reason: "not linked yet",
        excerpt: "alpha adds one.",
      },
    ]);
    await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, actor);
    expect(await unlinkedOf(dir)).toEqual([]);
  });

  it("an id that matches no anchor is reported (a lockfile out of date, or a hand-written id)", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M(" id=ghost001")) });
    const [u] = await unlinkedOf(dir);
    expect(u?.reason).toBe("id ghost001 matches no anchor");
  });

  it("a marker copy-pasted into another doc is flagged until `link` mints it a new id", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M(" id=orig0001")) });
    await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, actor);
    await writeFile(join(dir, "COPY.md"), doc(M(" id=orig0001")), "utf8");
    expect(await unlinkedOf(dir)).toEqual([
      {
        doc: "COPY.md",
        line: 3,
        target: "src/a.ts#alpha",
        reason: "id orig0001 belongs to the marker in CLAUDE.md",
        excerpt: "alpha adds one.",
      },
    ]);
    await linkDoc(dir, "COPY.md", DEFAULT_CONFIG, actor);
    expect(await unlinkedOf(dir)).toEqual([]);
  });

  it("a doc that was renamed (the original no longer has the marker) isn't flagged as a copy", async () => {
    const dir = await repo({ "OLD.md": doc(M(" id=move0001")) });
    await linkDoc(dir, "OLD.md", DEFAULT_CONFIG, actor);
    await writeFile(join(dir, "NEW.md"), doc(M(" id=move0001")), "utf8");
    await writeFile(join(dir, "OLD.md"), "# gone\n", "utf8");
    expect(await unlinkedOf(dir)).toEqual([]);
  });

  it("the same id twice in one doc flags the second", async () => {
    const dir = await repo({
      "CLAUDE.md": `# D\n\n${M(" id=dupe0001")}\nOne.\n\n${M(" id=dupe0001")}\nTwo.\n`,
    });
    await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, actor); // second marker is re-stamped with its own id
    expect(await unlinkedOf(dir)).toEqual([]);
    await writeFile(join(dir, "CLAUDE.md"), `# D\n\n${M(" id=dupe0001")}\nOne.\n\n${M(" id=dupe0001")}\nTwo.\n`, "utf8");
    const found = await unlinkedOf(dir);
    expect(found.map((u) => u.line)).toEqual([6]);
    expect(found[0]?.reason).toContain("appears twice");
  });

  it("markers in fenced code blocks are examples and never reported", async () => {
    const dir = await repo({ "README.md": `# R\n\n\`\`\`markdown\n${M()}\nexample.\n\`\`\`\n` });
    expect(await unlinkedOf(dir)).toEqual([]);
  });

  it("only the docs the config selects are scanned: excluded, vendored and non-matching files are ignored", async () => {
    const dir = await repo({
      "CLAUDE.md": doc(M()),
      "CHANGELOG.md": doc(M()), // excluded by default
      "node_modules/pkg/README.md": doc(M()),
      "notes.txt": doc(M()), // not a *.md
      "docs/deep/guide.md": doc(M()),
    });
    expect((await unlinkedOf(dir)).map((u) => u.doc)).toEqual(["CLAUDE.md", "docs/deep/guide.md"]);

    const narrowed = await check(dir, { ...DEFAULT_CONFIG, docs: ["docs/**/*.md"] }, undefined, { write: false });
    expect(narrowed.unlinked.map((u) => u.doc)).toEqual(["docs/deep/guide.md"]);
  });

  it("counts them in the summary, and creates no lockfile just to say so", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M()), "docs/b.md": doc(M()) });
    const result = await check(dir, DEFAULT_CONFIG);
    expect(result.summary.unlinked).toBe(2);
    expect(existsSync(join(dir, "lockwire.lock"))).toBe(false);
  });
});

describe("scoped runs only look at the docs in scope, and never walk the tree", () => {
  it("a run scoped to a code path (what the PostToolUse hook does) ignores unlinked markers elsewhere", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M()) });
    expect(await unlinkedOf(dir, ["src/a.ts"])).toEqual([]);
  });

  it("a run scoped to a doc reports that doc's markers, and only that doc's", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M()), "docs/b.md": doc(M()) });
    expect((await unlinkedOf(dir, ["docs/b.md"])).map((u) => u.doc)).toEqual(["docs/b.md"]);
  });

  it("a scoped run doesn't scan a path that isn't a configured doc, even if it holds markers", async () => {
    const dir = await repo({ "CHANGELOG.md": doc(M()), "notes.txt": doc(M()) });
    expect(await unlinkedOf(dir, ["CHANGELOG.md", "notes.txt", "missing.md"])).toEqual([]);
  });
});

describe("how it's reported", () => {
  it("text output lists them and the summary counts them, and says nothing when there are none", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M()) });
    const text = formatText(await check(dir, DEFAULT_CONFIG, undefined, { write: false }));
    expect(text).toContain("Unlinked markers");
    expect(text).toContain("CLAUDE.md:3  src/a.ts#alpha  not linked yet");
    expect(text).toContain("Run `lockwire link CLAUDE.md` to link them.");
    expect(text).toMatch(/0 orphaned · 1 unlinked/);

    await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, actor);
    const clean = formatText(await check(dir, DEFAULT_CONFIG, undefined, { write: false }));
    expect(clean).not.toContain("Unlinked");
    expect(clean).not.toContain("unlinked");
  });

  it("GitHub annotations are warnings by default and errors when unlinked markers are made to fail", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M()) });
    const result = await check(dir, DEFAULT_CONFIG, undefined, { write: false });
    expect(formatGithub(result)).toMatch(/^::warning file=CLAUDE\.md,line=3::lockwire:/);
    expect(formatGithub(result, { failOnUnlinked: true })).toMatch(/^::error file=CLAUDE\.md,line=3::/);
  });
});

describe.skipIf(!existsSync(CLI))("through the CLI and hooks", () => {
  it("it's a warning that doesn't fail the run, unless --fail-on-unlinked says it should", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M()) });
    const warn = cli(dir, ["check", "--no-write"]);
    expect(warn.status).toBe(0);
    expect(warn.stdout).toContain("Unlinked markers");
    const strict = cli(dir, ["check", "--no-write", "--fail-on-unlinked"]);
    expect(strict.status).toBe(1);
    expect(cli(dir, ["check", "--no-write", "--fail-on-unlinked", "--format", "github"]).stdout).toContain("::error");

    cli(dir, ["link", "CLAUDE.md"]);
    expect(cli(dir, ["check", "--no-write", "--fail-on-unlinked"]).status).toBe(0);
  });

  it("the flag doesn't swallow a following path", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M()) });
    const run = cli(dir, ["check", "--fail-on-unlinked", "--no-write", "CLAUDE.md", "--format", "json"]);
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).unlinked).toHaveLength(1);
  });

  it("--changed catches a marker added to a doc on this branch", async () => {
    const dir = await repo({ "CLAUDE.md": "# D\n\nNothing yet.\n" });
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "feature");
    expect(cli(dir, ["check", "--changed", "--no-write", "--fail-on-unlinked"]).status).toBe(0);
    await writeFile(join(dir, "CLAUDE.md"), doc(M()), "utf8");
    const run = cli(dir, ["check", "--changed", "--no-write", "--fail-on-unlinked"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("CLAUDE.md:3");
  });

  it("the PostToolUse hook tells an agent that its edit left an unlinked marker, and `link` fixes it", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M()) });
    await mkdir(join(dir, ".git"));
    const payload = (file: string) =>
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(dir, file) }, cwd: dir });
    const post = cli(dir, ["hook", "claude-post"], payload("CLAUDE.md"));
    expect(post.status).toBe(0);
    const text = JSON.parse(post.stdout).hookSpecificOutput.additionalContext as string;
    expect(text).toContain("has markers that no anchor backs");
    expect(text).toContain("- line 3: src/a.ts#alpha (not linked yet)");
    expect(text).toContain("`lockwire link CLAUDE.md`");

    // an edit to the code is not the place to nag about a doc
    expect(cli(dir, ["hook", "claude-post"], payload("src/a.ts")).stdout).toBe("");

    cli(dir, ["link", "CLAUDE.md"]);
    expect(cli(dir, ["hook", "claude-post"], payload("CLAUDE.md")).stdout).toBe("");
  });

  it("a drifted doc and an unlinked marker are both reported in one hook message", async () => {
    const dir = await repo({ "CLAUDE.md": doc(M(" id=both0001")) });
    await mkdir(join(dir, ".git"));
    cli(dir, ["link", "CLAUDE.md"]); // links the first claim; `link` links every marker in the doc
    // now reword that claim so it drifts, and add a second marker that nobody links
    const edited = (await readFile(join(dir, "CLAUDE.md"), "utf8")).replace(
      "alpha adds one.",
      "alpha subtracts one.",
    );
    await writeFile(join(dir, "CLAUDE.md"), `${edited}\n${M()}\nA second, unlinked claim.\n`, "utf8");
    const post = cli(
      dir,
      ["hook", "claude-post"],
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(dir, "CLAUDE.md") }, cwd: dir }),
    );
    const text = JSON.parse(post.stdout).hookSpecificOutput.additionalContext as string;
    expect(text).toContain("this edit drifted documentation claims");
    expect(text).toContain("has markers that no anchor backs");
    expect(text).toContain("(claim)");
  });
});
