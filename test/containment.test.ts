/**
 * lockwire only ever reads files inside the repository. The paths it reads come from docs (marker
 * targets), the lockfile (anchor targets and docs) and the doc index cache — all of which anyone can
 * change in a pull request — so a path that escapes the repo, directly or through a symlink, must be
 * refused before anything is read, and nothing from outside may reach the lockfile, the ledger or
 * any output.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ack, check, linkDoc, unlinkedFor, unlinkedForWithin } from "../src/actions.js";
import { indexPath, loadDocIndex } from "../src/docindex.js";
import { formatGithub, formatJson, formatText } from "../src/format.js";
import { createServer } from "../src/mcp-server.js";
import { resolveInsideRepo } from "../src/repo.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const SECRET = "s3cr3t-token-value";
const actor = { type: "human" as const };
const canSymlink = process.platform !== "win32";
const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";

/** <tmp>/outer/{secret.json, outside.md, outside.ts} and <tmp>/outer/repo (the repository). */
async function layout() {
  const outer = await mkdtemp(join(tmpdir(), "lockwire-contain-"));
  writeFileSync(join(outer, "secret.json"), JSON.stringify({ token: SECRET }), "utf8");
  writeFileSync(
    join(outer, "outside.md"),
    `# Outside\n\n<!-- lockwire src/a.ts#alpha sig id=hostile1 -->\nOUTSIDE-CLAIM ${SECRET}\n`,
    "utf8",
  );
  writeFileSync(join(outer, "outside.ts"), A_TS, "utf8");
  const repo = join(outer, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, "src", "a.ts"), A_TS, "utf8");
  writeFileSync(join(repo, "lockwire.lock"), '{"version":1,"anchors":[]}', "utf8");
  return { outer, repo };
}
const everything = (repo: string) =>
  [join(repo, "lockwire.lock"), join(repo, ".lockwire", "ledger.jsonl"), indexPath(repo)]
    .filter(existsSync)
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");

/** A lockfile someone edited by hand in a pull request. */
function hostileAnchor(target: { path: string; symbol?: string }, doc: string | null = "CLAUDE.md") {
  return {
    id: "hostile1",
    doc,
    claim: doc ? { line: 3, hash: "b3:0", excerpt: "x" } : null,
    target,
    tiers: ["value"],
    fingerprints: { path: "b3:0", sig: "", body: "", deps: "", value: "b3:0" },
    linked: { at: "2026-10-01T00:00:00.000Z", commit: null, by: actor },
    status: "fresh",
    waiver: null,
  };
}

describe("resolveInsideRepo", () => {
  it("accepts paths inside the repo, including ones that wander and come back", async () => {
    const { repo } = await layout();
    expect(resolveInsideRepo(repo, "src/a.ts")).toBe(join(repo, "src", "a.ts"));
    expect(resolveInsideRepo(repo, "src/../src/a.ts")).toBe(join(repo, "src", "a.ts"));
    expect(resolveInsideRepo(repo, "not/yet/created.json")).toBe(join(repo, "not", "yet", "created.json"));
    expect(resolveInsideRepo(repo, "..notes.md")).toBe(join(repo, "..notes.md")); // a name, not a parent
  });

  it("refuses parent escapes, absolute paths, drive letters and NUL bytes", async () => {
    const { repo } = await layout();
    for (const p of ["../secret.json", "src/../../secret.json", "..", "/etc/passwd", "C:/x.json", "c:\\x.json", "a\0b", ""])
      expect(resolveInsideRepo(repo, p), JSON.stringify(p)).toBeNull();
  });

  it.skipIf(!canSymlink)("refuses a symlink that points outside, and follows one that stays inside", async () => {
    const { outer, repo } = await layout();
    symlinkSync(join(outer, "secret.json"), join(repo, "leak.json"));
    symlinkSync(outer, join(repo, "up"));
    symlinkSync(join(repo, "src", "a.ts"), join(repo, "alias.ts"));
    expect(resolveInsideRepo(repo, "leak.json")).toBeNull();
    expect(resolveInsideRepo(repo, "up/secret.json")).toBeNull();
    expect(resolveInsideRepo(repo, "alias.ts")).toBe(join(repo, "alias.ts"));
  });
});

describe("link refuses targets and docs outside the repo, and copies nothing from them", () => {
  it.each([
    ["a ../ data target", "../secret.json#token"],
    ["an absolute data target", "ABS#token"],
    ["a ../ code target", "../outside.ts#alpha"],
  ])("%s", async (_name, target) => {
    const { outer, repo } = await layout();
    const t = target.replace("ABS", join(outer, "secret.json"));
    writeFileSync(join(repo, "CLAUDE.md"), `# A\n\n<!-- lockwire ${t} -->\nThe token is ${SECRET}.\n`, "utf8");
    const r = await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    expect(r.created).toBe(0);
    expect(r.skipped[0]?.reason).toContain("is outside the repository");
    expect(r.skipped[0]?.reason).not.toContain(SECRET);
    expect(everything(repo)).not.toContain(SECRET);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).not.toContain("id="); // nothing stamped
  });

  it.skipIf(!canSymlink)("a data file inside the repo that is a symlink to one outside is refused too", async () => {
    const { outer, repo } = await layout();
    symlinkSync(join(outer, "secret.json"), join(repo, "results.json"));
    writeFileSync(join(repo, "CLAUDE.md"), `# A\n\n<!-- lockwire results.json#token -->\nThe token is ${SECRET}.\n`, "utf8");
    const r = await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    expect(r.created).toBe(0);
    expect(everything(repo)).not.toContain(SECRET);
  });

  it("a doc outside the repo can't be linked", async () => {
    const { repo } = await layout();
    await expect(linkDoc(repo, "../outside.md", DEFAULT_CONFIG, actor)).rejects.toThrow(/outside the repository/);
    expect(readFileSync(join(repo, "lockwire.lock"), "utf8")).not.toContain("hostile1");
  });
});

describe("a hand-edited lockfile can't make check, ack or any output read outside the repo", () => {
  async function withLock(anchor: object, claude = "# A\n\n<!-- lockwire x id=hostile1 -->\nThe token is something.\n") {
    const { outer, repo } = await layout();
    writeFileSync(join(repo, "CLAUDE.md"), claude, "utf8");
    writeFileSync(join(repo, "lockwire.lock"), JSON.stringify({ version: 1, anchors: [anchor] }), "utf8");
    return { outer, repo };
  }

  it("an anchor targeting a file outside is orphaned with the reason, and its value never appears anywhere", async () => {
    const { repo } = await withLock(hostileAnchor({ path: "../secret.json", symbol: "token" }));
    const result = await check(repo, DEFAULT_CONFIG);
    expect(result.results[0]?.status).toBe("orphaned");
    const outputs = [formatText(result), formatJson(result, null), formatGithub(result)].join("\n");
    expect(outputs).not.toContain(SECRET);
    expect(everything(repo)).not.toContain(SECRET);
    expect(readFileSync(join(repo, ".lockwire", "ledger.jsonl"), "utf8")).toContain("is outside the repository");
  });

  it("an anchor whose doc is outside the repo never reads that doc", async () => {
    const { repo } = await withLock({
      ...hostileAnchor({ path: "src/a.ts", symbol: "alpha" }, "../outside.md"),
      tiers: ["sig"],
    });
    const result = await check(repo, DEFAULT_CONFIG);
    expect(result.results[0]?.status).toBe("orphaned"); // its marker can't be found
    expect([formatText(result), formatJson(result, null), formatGithub(result)].join("\n")).not.toContain("OUTSIDE-CLAIM");
  });

  it("ack refuses to re-stamp an anchor that points outside", async () => {
    const { repo } = await withLock(hostileAnchor({ path: "../secret.json", symbol: "token" }));
    await expect(ack(repo, "hostile1", "updated", undefined, actor, DEFAULT_CONFIG)).rejects.toThrow();
    expect(everything(repo)).not.toContain(SECRET);
  });

  it.skipIf(!existsSync(CLI))("the CLI fails the run and prints nothing from outside, in every format", async () => {
    const { repo } = await withLock(hostileAnchor({ path: "../secret.json", symbol: "token" }));
    for (const fmt of ["text", "json", "github"]) {
      const r = spawnSync(process.execPath, [CLI, "check", "--no-write", "--format", fmt], { cwd: repo, encoding: "utf8" });
      expect(r.status, fmt).toBe(1);
      expect(r.stdout + r.stderr, fmt).not.toContain(SECRET);
    }
  });
});

describe("the MCP server can't be pointed outside the repo", () => {
  it("lockwire_link on a doc outside fails without linking anything", async () => {
    const { outer, repo } = await layout();
    const server = createServer(repo);
    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(s)]);
    for (const doc of ["../outside.md", join(outer, "outside.md")]) {
      const res = (await client.callTool({ name: "lockwire_link", arguments: { doc } })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(res.isError, doc).toBe(true);
      expect(res.content[0]?.text).not.toContain("OUTSIDE-CLAIM");
    }
    expect(readFileSync(join(repo, "lockwire.lock"), "utf8")).not.toContain("hostile1");
  });
});

describe("the doc index never reaches outside the repo or the config", () => {
  async function seeded() {
    const { outer, repo } = await layout();
    writeFileSync(join(repo, "NOTES.md"), "# N\n\n<!-- lockwire src/a.ts#alpha sig -->\na real claim.\n", "utf8");
    writeFileSync(join(repo, "CHANGELOG.md"), "# C\n\n<!-- lockwire src/a.ts#alpha sig -->\nexcluded.\n", "utf8");
    await unlinkedForWithin(repo, DEFAULT_CONFIG, "src/a.ts", undefined, 10_000);
    const data = JSON.parse(readFileSync(indexPath(repo), "utf8"));
    const save = () => writeFileSync(indexPath(repo), JSON.stringify(data), "utf8");
    return { outer, repo, data, save };
  }
  const docsReported = async (repo: string) => {
    const hook = (await unlinkedForWithin(repo, DEFAULT_CONFIG, "src/a.ts", undefined, 10_000)).claims;
    const mcp = await unlinkedFor(repo, DEFAULT_CONFIG, "src/a.ts");
    return [...new Set([...hook, ...mcp].map((c) => c.doc))];
  };
  const entry = { mtimeMs: 1, size: 1, markers: [{ line: 3, target: { path: "src/a.ts", symbol: "alpha" }, id: null, claimExcerpt: "OUTSIDE-CLAIM" }] };

  it.each([
    ["a ../ doc", (d: { docs: Record<string, unknown> }, outer: string) => { d.docs["../outside.md"] = entry; void outer; }],
    ["an absolute doc", (d: { docs: Record<string, unknown> }, outer: string) => { d.docs[join(outer, "outside.md")] = entry; }],
    ["a backslash doc", (d: { docs: Record<string, unknown> }) => { d.docs["..\\outside.md"] = entry; }],
    ["an excluded doc", (d: { docs: Record<string, unknown> }) => { d.docs["CHANGELOG.md"] = entry; }],
    ["a vendored doc", (d: { docs: Record<string, unknown> }) => { d.docs["node_modules/p/README.md"] = entry; }],
    ["a ../ directory", (d: { dirs: Record<string, number> }) => { d.dirs[".."] = 1; d.dirs["../x"] = 1; }],
    ["a .git directory", (d: { dirs: Record<string, number> }) => { d.dirs[".git"] = 1; }],
  ] as const)("%s planted in the cache is dropped, never read, and the cache is rewritten clean", async (_n, plant) => {
    const { outer, repo, data, save } = await seeded();
    (plant as (d: typeof data, o: string) => void)(data, outer);
    save();
    expect(await docsReported(repo)).toEqual(["NOTES.md"]);
    await loadDocIndex(repo, DEFAULT_CONFIG); // a persisting load rewrites it
    const after = JSON.parse(await readFile(indexPath(repo), "utf8"));
    expect(Object.keys(after.docs)).toEqual(["NOTES.md"]);
    expect(Object.keys(after.dirs).every((d) => !d.includes("..") && !d.startsWith(".git"))).toBe(true);
  });

  it("an index that lost its root record is rebuilt rather than trusted empty", async () => {
    const { repo, data, save } = await seeded();
    data.dirs = {};
    data.docs = {};
    save();
    expect(await docsReported(repo)).toEqual(["NOTES.md"]);
  });

  it.skipIf(!canSymlink)("a .md symlink pointing outside is never read, by check, the hook scan or claims_for", async () => {
    const { outer, repo } = await layout();
    symlinkSync(join(outer, "outside.md"), join(repo, "LEAK.md"));
    const result = await check(repo, DEFAULT_CONFIG);
    expect(result.unlinked).toEqual([]);
    expect(await docsReported(repo)).toEqual([]);
    expect(formatText(result)).not.toContain("OUTSIDE-CLAIM");
  });

  it.skipIf(!existsSync(CLI) || !canSymlink)("`lockwire link` with no doc skips a symlinked doc outside", async () => {
    const { outer, repo } = await layout();
    symlinkSync(join(outer, "outside.md"), join(repo, "LEAK.md"));
    const r = spawnSync(process.execPath, [CLI, "link"], { cwd: repo, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readFileSync(join(outer, "outside.md"), "utf8")).not.toMatch(/id=(?!hostile1)/); // not stamped
    expect(readFileSync(join(repo, "lockwire.lock"), "utf8")).not.toContain("OUTSIDE");
  });
});

describe.skipIf(!existsSync(CLI))("the PreToolUse hook doesn't surface claims from outside the repo", () => {
  it.skipIf(!canSymlink)("a symlinked doc's claims are not injected", async () => {
    const { outer, repo } = await layout();
    symlinkSync(join(outer, "outside.md"), join(repo, "LEAK.md"));
    await writeFile(join(repo, "NOTES.md"), "# N\n\n<!-- lockwire src/a.ts#alpha sig -->\nan inside claim.\n", "utf8");
    const r = spawnSync(process.execPath, [CLI, "hook", "claude-pre"], {
      cwd: repo,
      encoding: "utf8",
      input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(repo, "src", "a.ts") }, cwd: repo }),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("an inside claim.");
    expect(r.stdout).not.toContain("OUTSIDE-CLAIM");
  });
});
