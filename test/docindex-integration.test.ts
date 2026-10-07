import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { unlinkedForWithin } from "../src/actions.js";
import { indexPath } from "../src/docindex.js";
import { createServer } from "../src/mcp-server.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const doc = (target: string, sentence: string) =>
  `# D\n\n<!-- lockwire ${target} sig -->\n${sentence}\n`;

async function repo(files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-dix-int-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), A_TS, "utf8");
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content, "utf8");
  }
  return dir;
}
const cli = (cwd: string, args: string[], input?: string) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLAUDECODE: "", CI: "" },
    ...(input === undefined ? {} : { input }),
  });
const pre = (dir: string, file = "src/a.ts") => {
  const r = cli(dir, ["hook", "claude-pre"], JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(dir, file) }, cwd: dir }));
  return { status: r.status, text: r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string) : "" };
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe.skipIf(!existsSync(CLI))("the hook uses the index, and never serves a stale answer", () => {
  it("the first hook run builds the cache, keeps it out of git, and answers correctly", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "alpha is pure.") });
    git(dir, "init", "-q", "-b", "main");
    cli(dir, ["init"]);
    expect(existsSync(indexPath(dir))).toBe(false);
    const r = pre(dir);
    expect(r.text).toContain("NOTES.md:3 asserts \"alpha is pure.\"");
    expect(existsSync(indexPath(dir))).toBe(true);
    const status = git(dir, "status", "--porcelain", "-uall");
    expect(status).not.toMatch(/cache|doc-index|hook\.log/);
    expect(status).toContain(".lockwire/.gitignore");
  });

  it("the very next edit sees a doc added in between, an edited claim, a link, and a deletion", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "first claim.") });
    cli(dir, ["init"]);
    expect(pre(dir).text).toContain("first claim.");

    await writeFile(join(dir, "MORE.md"), doc("src/a.ts#alpha", "an added claim."), "utf8");
    const added = pre(dir).text;
    expect(added).toContain("first claim.");
    expect(added).toContain("an added claim.");

    await writeFile(join(dir, "NOTES.md"), doc("src/a.ts#alpha", "a reworded claim."), "utf8");
    const edited = pre(dir).text;
    expect(edited).toContain("a reworded claim.");
    expect(edited).not.toContain("first claim.");

    cli(dir, ["link", "MORE.md"]);
    const linked = pre(dir).text;
    expect(linked).toContain("documentation makes claims about this code"); // MORE.md is now anchored
    expect(linked).toContain("NOTES.md:3 asserts"); // NOTES.md is still unlinked

    rmSync(join(dir, "NOTES.md"));
    const deleted = pre(dir).text;
    expect(deleted).not.toContain("NOTES.md:3");

    await mkdir(join(dir, "deep", "er"), { recursive: true });
    await writeFile(join(dir, "deep", "er", "x.md"), doc("src/a.ts#alpha", "a claim in a new directory."), "utf8");
    expect(pre(dir).text).toContain("a claim in a new directory.");
  });

  it("matches what an uncached full scan says, after a burst of changes", async () => {
    const dir = await repo();
    cli(dir, ["init"]);
    for (let i = 0; i < 12; i++) {
      await mkdir(join(dir, `d${i % 4}`), { recursive: true });
      await writeFile(join(dir, `d${i % 4}`, `p${i}.md`), doc("src/a.ts#alpha", `claim ${i}.`), "utf8");
      if (i % 3 === 0) pre(dir); // interleave cached reads with the writes
    }
    rmSync(join(dir, "d1"), { recursive: true });
    const cached = pre(dir).text;
    const fresh = await unlinkedForWithin(dir, DEFAULT_CONFIG, "src/a.ts", undefined, 10_000, { persist: false });
    const claimsInText = (cached.match(/asserts "claim \d+\./g) ?? []).length;
    expect(claimsInText).toBe(Math.min(fresh.claims.length, 8)); // capped by maxClaimsInContext
    expect(fresh.claims.map((c) => c.excerpt)).not.toContain("claim 1."); // d1 is gone
  });

  it("with hook.unlinkedClaims off, no cache is built", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "a claim.") });
    await mkdir(join(dir, ".lockwire"));
    await writeFile(join(dir, ".lockwire", "config.json"), JSON.stringify({ version: 1, hook: { unlinkedClaims: false } }), "utf8");
    expect(pre(dir).text).toBe("");
    expect(existsSync(indexPath(dir))).toBe(false);
  });

  it("a corrupt cache is rebuilt silently; the hook never fails over it", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "a claim.") });
    cli(dir, ["init"]);
    pre(dir);
    await writeFile(indexPath(dir), "{ not json", "utf8");
    const r = pre(dir);
    expect(r.status).toBe(0);
    expect(r.text).toContain("a claim.");
    JSON.parse(await readFile(indexPath(dir), "utf8"));
    expect(existsSync(join(dir, ".lockwire", "hook.log"))).toBe(false);
  });
});

describe.skipIf(!existsSync(CLI))("`lockwire index`", () => {
  it("builds the index and reports it, and --rebuild starts over", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "a."), "docs/b.md": doc("src/a.ts#alpha", "b.") });
    cli(dir, ["init"]);
    const first = cli(dir, ["index"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("indexed 2 docs (2 markers) → .lockwire/cache/doc-index.json");
    expect(first.stdout).toContain("built from scratch: read 2 docs");
    expect(existsSync(indexPath(dir))).toBe(true);

    const rebuilt = cli(dir, ["index", "--rebuild"]);
    expect(rebuilt.stdout).toContain("built from scratch");
  });

  it("reports an empty repo plainly", async () => {
    const dir = await repo();
    cli(dir, ["init"]);
    expect(cli(dir, ["index"]).stdout).toContain("indexed 0 docs (0 markers)");
  });
});

describe("`lockwire init` keeps derived files out of git", () => {
  it.skipIf(!existsSync(CLI))("writes .lockwire/.gitignore for the cache and hook.log, and re-running doesn't duplicate it", async () => {
    const dir = await repo();
    cli(dir, ["init"]);
    const path = join(dir, ".lockwire", ".gitignore");
    const once = await readFile(path, "utf8");
    expect(once).toContain("cache/");
    expect(once).toContain("hook.log");
    cli(dir, ["init"]);
    expect(await readFile(path, "utf8")).toBe(once);
  });
});

describe("the read-only MCP tool stays read-only", () => {
  it("lockwire_claims_for finds unlinked claims without creating a cache; an existing one is read, not written", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "an unlinked claim.") });
    await writeFile(join(dir, "lockwire.lock"), '{"version":1,"anchors":[]}', "utf8");
    const server = createServer(dir);
    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(s)]);
    const call = async () =>
      JSON.parse(
        ((await client.callTool({ name: "lockwire_claims_for", arguments: { path: "src/a.ts" } })) as { content: { text: string }[] })
          .content[0]?.text ?? "{}",
      );

    expect((await call()).unlinked).toHaveLength(1);
    expect(existsSync(join(dir, ".lockwire"))).toBe(false); // nothing created at all

    // A cache that a hook built is used, and the new doc is still seen, without the tool rewriting it.
    const built = await unlinkedForWithin(dir, DEFAULT_CONFIG, "src/a.ts", undefined, 10_000);
    expect(built.index.wrote).toBe(true);
    await writeFile(join(dir, "MORE.md"), doc("src/a.ts#alpha", "another one."), "utf8");
    const before = await readFile(indexPath(dir), "utf8");
    expect((await call()).unlinked).toHaveLength(2);
    expect(await readFile(indexPath(dir), "utf8")).toBe(before);
  });
});
