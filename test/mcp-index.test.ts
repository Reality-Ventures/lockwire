import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { unlinkedForWithin } from "../src/actions.js";
import { type IndexStats, indexPath, loadDocIndex, RACY_MS } from "../src/docindex.js";
import { createServer } from "../src/mcp-server.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const doc = (sentence: string, target = "src/a.ts#alpha") =>
  `# D\n\n<!-- lockwire ${target} sig -->\n${sentence}\n`;

async function repo(files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-mcpidx-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), A_TS, "utf8");
  writeFileSync(join(dir, "lockwire.lock"), '{"version":1,"anchors":[]}', "utf8");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content, "utf8");
  }
  return dir;
}

/** Give everything an old mtime, as a checkout from yesterday would: otherwise it's inside the racy window. */
function age(root: string) {
  const old = Math.floor(Date.now() / 1000) - 24 * 3600;
  let n = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      utimesSync(p, old + ++n, old + n);
    }
    utimesSync(dir, old + ++n, old + n);
  };
  walk(root);
}

async function connect(dir: string) {
  const seen: IndexStats[] = [];
  const server = createServer(dir, { onIndexStats: (s) => seen.push(s) });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  const claimsFor = async (path = "src/a.ts") => {
    const res = (await client.callTool({ name: "lockwire_claims_for", arguments: { path } })) as {
      content: { text: string }[];
    };
    return JSON.parse(res.content[0]?.text ?? "{}") as {
      anchors: unknown[];
      unlinked: { doc: string; excerpt: string }[];
    };
  };
  return { client, claimsFor, seen };
}
/** What a from-scratch scan says, for comparison. */
const reference = async (dir: string, path = "src/a.ts") =>
  (await unlinkedForWithin(dir, DEFAULT_CONFIG, path, undefined, Number.POSITIVE_INFINITY, { persist: false }))
    .claims.map((c) => `${c.doc}:${c.line}:${c.excerpt}`)
    .sort();
const summarize = (u: { doc: string; line?: number; excerpt: string }[]) =>
  u.map((c) => `${c.doc}:${(c as { line: number }).line}:${c.excerpt}`).sort();

describe("lockwire_claims_for keeps the doc index in memory across calls", () => {
  it("the first call builds it, and later calls re-read nothing", async () => {
    const dir = await repo({ "NOTES.md": doc("one."), "docs/b.md": doc("two."), "docs/c.md": doc("three.") });
    age(dir);
    const { claimsFor, seen } = await connect(dir);
    await claimsFor();
    await claimsFor();
    await claimsFor();
    expect(seen[0]).toMatchObject({ rebuilt: true, docsRead: 3 });
    for (const later of seen.slice(1)) expect(later).toMatchObject({ rebuilt: false, docsRead: 0, dirsRescanned: 0 });
    expect(seen).toHaveLength(3);
  });

  it("never writes anything: no cache directory, and an existing index is left byte-for-byte alone", async () => {
    const dir = await repo({ "NOTES.md": doc("one.") });
    const { claimsFor } = await connect(dir);
    await claimsFor();
    await writeFile(join(dir, "MORE.md"), doc("two."), "utf8");
    await claimsFor();
    expect(existsSync(join(dir, ".lockwire"))).toBe(false);

    // With an index a hook built, the tool reads it, refreshes its own copy, and leaves the file alone.
    const built = await unlinkedForWithin(dir, DEFAULT_CONFIG, "src/a.ts", undefined, 10_000);
    expect(built.index.wrote).toBe(true);
    const before = await readFile(indexPath(dir), "utf8");
    const fresh = await connect(dir);
    await writeFile(join(dir, "THIRD.md"), doc("three."), "utf8");
    await fresh.claimsFor();
    await fresh.claimsFor();
    expect(fresh.seen[0]?.rebuilt).toBe(false); // started from the one on disk
    expect(await readFile(indexPath(dir), "utf8")).toBe(before);
    expect(readdirSync(join(dir, ".lockwire", "cache"))).toEqual(["doc-index.json"]);
  });

  it("a stale on-disk index is refreshed in memory once, then reused", async () => {
    const dir = await repo({ "NOTES.md": doc("one.") });
    await unlinkedForWithin(dir, DEFAULT_CONFIG, "src/a.ts", undefined, 10_000); // writes the index
    await writeFile(join(dir, "NEW.md"), doc("added after the index was written."), "utf8");
    age(dir);
    const { claimsFor, seen } = await connect(dir);
    const first = await claimsFor();
    await claimsFor();
    expect(first.unlinked.map((u) => u.doc).sort()).toEqual(["NEW.md", "NOTES.md"]);
    expect(seen[0]?.dirsRescanned).toBeGreaterThan(0);
    expect(seen[1]).toMatchObject({ docsRead: 0, dirsRescanned: 0 });
  });

  it("two servers on two repos don't share an index", async () => {
    const a = await repo({ "A.md": doc("claim in repo A.") });
    const b = await repo({ "B.md": doc("claim in repo B.") });
    const sa = await connect(a);
    const sb = await connect(b);
    expect((await sa.claimsFor()).unlinked.map((u) => u.doc)).toEqual(["A.md"]);
    expect((await sb.claimsFor()).unlinked.map((u) => u.doc)).toEqual(["B.md"]);
    expect(sa.seen[0]?.rebuilt).toBe(true);
    expect(sb.seen[0]?.rebuilt).toBe(true);
  });
});

describe("...and never serves a stale answer while the repo changes under it", () => {
  it("sees an added doc, a reworded claim, a deleted doc and a new directory on the very next call", async () => {
    const dir = await repo({ "NOTES.md": doc("first.") });
    const { claimsFor } = await connect(dir);
    expect((await claimsFor()).unlinked.map((u) => u.excerpt)).toEqual(["first."]);

    await writeFile(join(dir, "MORE.md"), doc("added."), "utf8");
    expect((await claimsFor()).unlinked.map((u) => u.excerpt).sort()).toEqual(["added.", "first."]);

    await writeFile(join(dir, "NOTES.md"), doc("reworded."), "utf8");
    expect((await claimsFor()).unlinked.map((u) => u.excerpt).sort()).toEqual(["added.", "reworded."]);

    rmSync(join(dir, "MORE.md"));
    expect((await claimsFor()).unlinked.map((u) => u.excerpt)).toEqual(["reworded."]);

    await mkdir(join(dir, "deep", "er"), { recursive: true });
    await writeFile(join(dir, "deep", "er", "x.md"), doc("in a new directory."), "utf8");
    expect((await claimsFor()).unlinked.map((u) => u.excerpt).sort()).toEqual(["in a new directory.", "reworded."]);

    rmSync(join(dir, "deep"), { recursive: true });
    expect((await claimsFor()).unlinked.map((u) => u.excerpt)).toEqual(["reworded."]);
  });

  it("linking through the same server moves a claim from `unlinked` to `anchors`", async () => {
    const dir = await repo({ "NOTES.md": doc("to be linked.") });
    const { client, claimsFor } = await connect(dir);
    expect((await claimsFor()).unlinked).toHaveLength(1);
    await client.callTool({ name: "lockwire_link", arguments: { doc: "NOTES.md" } });
    const after = await claimsFor();
    expect(after.unlinked).toEqual([]);
    expect(after.anchors).toHaveLength(1);
  });

  it("a config change between calls rebuilds the in-memory index and follows the new config", async () => {
    const dir = await repo({ "NOTES.md": doc("top level."), "docs/g.md": doc("in docs.") });
    const { claimsFor, seen } = await connect(dir);
    expect((await claimsFor()).unlinked.map((u) => u.doc).sort()).toEqual(["NOTES.md", "docs/g.md"]);
    mkdirSync(join(dir, ".lockwire"));
    writeFileSync(join(dir, ".lockwire", "config.json"), JSON.stringify({ version: 1, docs: ["docs/**/*.md"] }), "utf8");
    expect((await claimsFor()).unlinked.map((u) => u.doc)).toEqual(["docs/g.md"]);
    expect(seen[1]?.rebuilt).toBe(true);
  });

  it("agrees with a from-scratch scan after every step of a burst of random changes", async () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const dir = await repo();
    const { claimsFor } = await connect(dir);
    const names = ["a", "b", "c"];
    for (let step = 0; step < 30; step++) {
      const rel = `${names[Math.floor(rand() * 3)]}/p${Math.floor(rand() * 6)}.md`;
      const roll = rand();
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      if (roll < 0.5) writeFileSync(join(dir, rel), doc(`claim ${step}.`), "utf8");
      else if (roll < 0.75 && existsSync(join(dir, rel))) rmSync(join(dir, rel));
      else if (roll < 0.9) writeFileSync(join(dir, rel), doc(`other ${step}.`, "src/other.ts#x"), "utf8");
      const got = summarize((await claimsFor()).unlinked as never);
      expect(got, `step ${step}`).toEqual(await reference(dir));
    }
  });
});

describe("the in-memory chain at the module level", () => {
  it("settles racy entries without ever writing, so a long-lived server stops re-reading fresh docs", async () => {
    const dir = await repo({ "a.md": doc("x.") });
    const t0 = Date.now();
    const first = await loadDocIndex(dir, DEFAULT_CONFIG, { persist: false, now: () => t0 });
    // The doc was just written, so it's racy: re-read on the next load...
    const second = await loadDocIndex(dir, DEFAULT_CONFIG, { persist: false, prior: first.state, now: () => t0 + 100 });
    expect(second.stats.docsRead).toBe(1);
    // ...but after the window has passed the chain records that, and goes quiet.
    const third = await loadDocIndex(dir, DEFAULT_CONFIG, { persist: false, prior: second.state, now: () => t0 + RACY_MS + 5000 });
    expect(third.stats.docsRead).toBe(1);
    const fourth = await loadDocIndex(dir, DEFAULT_CONFIG, { persist: false, prior: third.state, now: () => t0 + RACY_MS + 6000 });
    expect(fourth.stats).toMatchObject({ docsRead: 0, dirsRescanned: 0, wrote: false });
    expect(existsSync(join(dir, ".lockwire"))).toBe(false);
  });

  it("a prior state from a different config, or that is too old, is thrown away", async () => {
    const dir = await repo({ "a.md": doc("x."), "docs/b.md": doc("y.") });
    const t0 = Date.now();
    const first = await loadDocIndex(dir, DEFAULT_CONFIG, { persist: false, now: () => t0 });
    const narrowed = { ...DEFAULT_CONFIG, docs: ["docs/**/*.md"] };
    const other = await loadDocIndex(dir, narrowed, { persist: false, prior: first.state, now: () => t0 + 10 });
    expect(other.stats.rebuilt).toBe(true);
    expect(other.docs).toEqual(["docs/b.md"]);
    const old = await loadDocIndex(dir, DEFAULT_CONFIG, { persist: false, prior: first.state, now: () => t0 + 25 * 3600 * 1000 });
    expect(old.stats.rebuilt).toBe(true);
  });

  it("an interrupted refresh leaves a state that still validates correctly next time", async () => {
    const dir = await repo({ "a.md": doc("x."), "b/c.md": doc("y.") });
    const t0 = Date.now();
    const built = await loadDocIndex(dir, DEFAULT_CONFIG, { persist: false, now: () => t0 });
    writeFileSync(join(dir, "b", "d.md"), doc("z."), "utf8");
    const starved = await loadDocIndex(dir, DEFAULT_CONFIG, { persist: false, prior: built.state, budgetMs: -1, now: () => t0 + 10 });
    expect(starved.complete).toBe(false);
    const recovered = await loadDocIndex(dir, DEFAULT_CONFIG, { persist: false, prior: starved.state, now: () => t0 + 20 });
    expect(recovered.complete).toBe(true);
    expect(recovered.docs).toEqual(["a.md", "b/c.md", "b/d.md"]);
    expect(readFileSync(join(dir, "b", "d.md"), "utf8")).toContain("z.");
  });
});
