import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DocIndex, indexPath, loadDocIndex, MAX_AGE_MS, RACY_MS } from "../src/docindex.js";
import { scanMarkers } from "../src/markers.js";
import { isScannedDoc, walkFiles } from "../src/repo.js";
import { DEFAULT_CONFIG } from "../src/types.js";

/** The reference answer: a fresh walk of the tree, reading and scanning every doc. */
function fullScan(root: string, config = DEFAULT_CONFIG) {
  const out: Record<string, unknown[]> = {};
  for (const rel of walkFiles(root, config.exclude)) {
    if (!isScannedDoc(rel, config)) continue;
    out[rel] = scanMarkers(readFileSync(join(root, rel), "utf8")).map((m) => ({
      line: m.line,
      target: m.target,
      id: m.id,
      claimExcerpt: m.claimExcerpt,
    }));
  }
  return out;
}
const asMap = (idx: DocIndex) =>
  Object.fromEntries(idx.docs.map((d) => [d, idx.markersOf(d) as unknown[]]));

const HOUR = 3600;
/** A clock far in the future of every mtime the tests set, so entries are trusted, not "racy". */
const BASE = Date.now() + 5 * HOUR * 1000;
const OLD = Math.floor(Date.now() / 1000) - 48 * HOUR; // seconds; mtimes live here, well before any index
let tick = 0;
/** Gives a path a distinct, old mtime (the way an edit changes it) without making it look recent. */
const touch = (path: string) => {
  const t = OLD + ++tick;
  utimesSync(path, t, t);
};

const marker = (target: string, id = "") => `<!-- lockwire ${target} sig${id} -->`;
const docText = (n: number, markers = 1) =>
  `# Doc ${n}\n\n${Array.from({ length: markers }, (_, i) => `${marker(`src/f${i}.ts#sym${i}`)}\nClaim ${n}.${i}.\n`).join("\n")}`;

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "lockwire-docindex-"));
  return root;
}
const put = (root: string, rel: string, content: string) => {
  const abs = join(root, rel);
  const existed = existsSync(abs);
  // Everything created on the way (new dirs) and the parent that gained an entry get an old mtime.
  // An edit of an existing file changes only that file's mtime, as on a real filesystem.
  const created: string[] = [];
  let d = dirname(abs);
  while (!existsSyncSafe(d) && d.startsWith(root) && d !== root) {
    created.push(d);
    d = dirname(d);
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  touch(abs);
  for (const c of created) touch(c);
  if (!existed) touch(d); // the nearest pre-existing dir gained an entry
};
const existsSyncSafe = (p: string) => existsSync(p);
const remove = (root: string, rel: string) => {
  rmSync(join(root, rel), { recursive: true, force: true });
  touch(dirname(join(root, rel)));
};
const settleTree = (root: string) => {
  // give every file and directory an old mtime, as a checkout from yesterday would have
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      touch(p);
    }
    touch(dir);
  };
  walk(root);
};

describe("doc index: the basics", () => {
  it("a cold build matches a full scan, persists, and the next load re-reads nothing", async () => {
    const root = await tree();
    put(root, "CLAUDE.md", docText(1));
    put(root, "docs/a/guide.md", docText(2, 2));
    put(root, "docs/a/deep/more.md", docText(3, 0));
    put(root, "src/code.ts", "export {};\n");
    settleTree(root);

    const first = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    expect(first.stats.rebuilt).toBe(true);
    expect(first.stats.wrote).toBe(true);
    expect(first.complete).toBe(true);
    expect(asMap(first)).toEqual(fullScan(root));
    expect(existsSync(indexPath(root))).toBe(true);

    const second = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 60_000 });
    expect(second.stats).toMatchObject({ rebuilt: false, docsRead: 0, dirsRescanned: 0, wrote: false });
    expect(second.stats.dirsStatted).toBeGreaterThan(0);
    expect(second.stats.docsStatted).toBe(3);
    expect(asMap(second)).toEqual(fullScan(root));
  });

  it("only re-reads the doc that changed, and only re-lists the directory that gained an entry", async () => {
    const root = await tree();
    for (let i = 0; i < 6; i++) put(root, `docs/d${i}/page.md`, docText(i));
    settleTree(root);
    await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });

    put(root, "docs/d3/page.md", docText(33, 2)); // edit one
    const edit = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 60_000 });
    expect(edit.stats).toMatchObject({ docsRead: 1, dirsRescanned: 0 });
    expect(asMap(edit)).toEqual(fullScan(root));

    put(root, "docs/d1/extra.md", docText(99)); // add one
    const add = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 120_000 });
    expect(add.stats).toMatchObject({ docsRead: 1, dirsRescanned: 1 });
    expect(asMap(add)).toEqual(fullScan(root));
  });

  it("handles an empty repo and one with no docs", async () => {
    const root = await tree();
    const empty = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    expect(empty.docs).toEqual([]);
    put(root, "src/a.ts", "x");
    settleTree(root);
    const again = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 1000 });
    expect(again.docs).toEqual([]);
    expect(again.complete).toBe(true);
  });

  it("selects docs exactly as a full scan would: excluded, vendored and non-markdown files never appear", async () => {
    const root = await tree();
    put(root, "CLAUDE.md", docText(1));
    put(root, "CHANGELOG.md", docText(2)); // excluded by default
    put(root, "node_modules/x/README.md", docText(3));
    put(root, "dist/y.md", docText(4)); // excluded by default
    put(root, "notes.txt", docText(5));
    put(root, ".lockwire/z.md", docText(6));
    settleTree(root);
    const idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    expect(idx.docs).toEqual(["CLAUDE.md"]);
    expect(asMap(idx)).toEqual(fullScan(root));
  });

  it.skipIf(process.platform === "win32")("doesn't follow a symlinked directory, so a loop can't hang it", async () => {
    const root = await tree();
    put(root, "docs/a.md", docText(1));
    symlinkSync(root, join(root, "docs", "loop"));
    settleTree(root);
    const idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    expect(idx.docs).toEqual(["docs/a.md"]);
  });
});

describe("doc index: it never goes stale (differential against a full scan)", () => {
  /** Small seeded PRNG so a failure reproduces. */
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: 40 random edits, adds, deletes, renames and moves — the index always equals a fresh scan`, async () => {
      const rand = rng(seed);
      const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(rand() * xs.length)];
      const root = await tree();
      const docsNow = () => Object.keys(fullScan(root));
      const dirsNow = () => {
        const out: string[] = [];
        const walk = (rel: string) => {
          for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
            if (e.isDirectory() && !["node_modules", ".git", ".lockwire"].includes(e.name)) {
              const r = rel ? `${rel}/${e.name}` : e.name;
              out.push(r);
              walk(r);
            }
          }
        };
        walk("");
        return out;
      };
      const dirNames = ["docs", "guides", "api", "notes", "a", "b"];
      const newDocPath = () => {
        const depth = Math.floor(rand() * 3);
        const parts = Array.from({ length: depth }, () => pick(dirNames) as string);
        return [...parts, `p${Math.floor(rand() * 1000)}.md`].join("/");
      };

      put(root, "CLAUDE.md", docText(0));
      for (let i = 0; i < 5; i++) put(root, newDocPath(), docText(i, i % 3));
      settleTree(root);
      let step = 0;
      let idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + ++step * 60_000 });
      expect(asMap(idx)).toEqual(fullScan(root));

      for (let op = 0; op < 40; op++) {
        const kind = Math.floor(rand() * 11);
        const docs = docsNow();
        const label = `seed ${seed} op ${op} kind ${kind}`;
        switch (kind) {
          case 0:
          case 1:
            put(root, newDocPath(), docText(op, Math.floor(rand() * 3)));
            break;
          case 2: {
            const d = pick(docs);
            if (d) put(root, d, docText(1000 + op, Math.floor(rand() * 3))); // edit, new content and size
            break;
          }
          case 3: {
            const d = pick(docs);
            if (d) {
              // same size, different content: only the new mtime can reveal it
              const text = readFileSync(join(root, d), "utf8");
              put(root, d, text.replace(/Claim (\d)/, (_, n) => `Claim ${(Number(n) + 1) % 10}`));
            }
            break;
          }
          case 4: {
            const d = pick(docs);
            if (d) remove(root, d);
            break;
          }
          case 5: {
            const d = pick(docs);
            if (d) {
              const to = newDocPath();
              mkdirSync(dirname(join(root, to)), { recursive: true });
              renameSync(join(root, d), join(root, to));
              touch(join(root, to));
              touch(dirname(join(root, d)));
              touch(dirname(join(root, to)));
            }
            break;
          }
          case 6: {
            const d = pick(dirsNow());
            if (d) remove(root, d);
            break;
          }
          case 7: {
            const from = pick(dirsNow());
            if (from) {
              const to = `${pick(dirNames)}-moved${op}`;
              renameSync(join(root, from), join(root, to));
              touch(join(root, to));
              touch(dirname(join(root, from)));
              touch(root);
            }
            break;
          }
          case 8:
            put(root, `${pick(dirNames)}/code${op}.ts`, "export {};\n"); // a non-doc: must not show up
            break;
          case 9:
            put(root, pick(["CHANGELOG.md", "node_modules/p/README.md", "dist/x.md"]) as string, docText(op)); // excluded
            break;
          default:
            break; // no-op: the next load must be quiet
        }
        idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + ++step * 60_000 });
        expect(asMap(idx), label).toEqual(fullScan(root));
        const quiet = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + ++step * 60_000 });
        expect(quiet.stats, `${label}: a second load with nothing changed must do no work`).toMatchObject({
          docsRead: 0,
          dirsRescanned: 0,
          wrote: false,
        });
        expect(asMap(quiet), label).toEqual(fullScan(root));
      }
    });
  }
});

describe("doc index: racy entries and the limits of mtimes", () => {
  it("a doc rewritten with the same size and the same mtime inside the racy window is still caught", async () => {
    const root = await tree();
    put(root, "a.md", `# A\n\n${marker("src/x.ts#one")}\nClaim 1.\n`);
    settleTree(root);
    // Index it "now", and give the doc an mtime just before that: racy.
    const builtAt = BASE;
    const racyMtime = (builtAt - 500) / 1000;
    utimesSync(join(root, "a.md"), racyMtime, racyMtime);
    const first = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => builtAt });
    expect(first.markersOf("a.md")?.[0]?.target.symbol).toBe("one");

    // Same length, same mtime: only the racy rule can tell.
    writeFileSync(join(root, "a.md"), `# A\n\n${marker("src/x.ts#two")}\nClaim 1.\n`, "utf8");
    utimesSync(join(root, "a.md"), racyMtime, racyMtime);
    const second = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => builtAt + 1000 });
    expect(second.markersOf("a.md")?.[0]?.target.symbol).toBe("two");
  });

  it("once the racy window has passed, the index refreshes itself and goes quiet", async () => {
    const root = await tree();
    put(root, "a.md", docText(1));
    settleTree(root);
    const builtAt = BASE;
    const recent = (builtAt - 200) / 1000;
    utimesSync(join(root, "a.md"), recent, recent);
    await loadDocIndex(root, DEFAULT_CONFIG, { now: () => builtAt });

    const during = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => builtAt + 500 });
    expect(during.stats.docsRead).toBe(1); // still racy: re-read, though unchanged
    expect(during.stats.wrote).toBe(false); // ...and not rewritten for nothing

    const after = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => builtAt + RACY_MS + 5000 });
    expect(after.stats.wrote).toBe(true); // aged out: record a fresh builtAt so it's trusted from now on
    const quiet = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => builtAt + RACY_MS + 10_000 });
    expect(quiet.stats).toMatchObject({ docsRead: 0, dirsRescanned: 0, wrote: false });
  });

  it("KNOWN LIMIT: a content change that keeps both size and mtime, outside the racy window, is invisible until a rebuild", async () => {
    // The price of trusting mtimes, shared by make, rsync --update and git's own index. It takes a
    // deliberate `touch -r`-style restore; ordinary edits, checkouts and renames all move
    // mtime. `lockwire index --rebuild` is the escape hatch, and the index rebuilds itself daily.
    const root = await tree();
    put(root, "a.md", `# A\n\n${marker("src/x.ts#one")}\nClaim 1.\n`);
    settleTree(root);
    const recorded = statSync(join(root, "a.md")).mtimeMs / 1000;
    const first = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    expect(first.markersOf("a.md")?.[0]?.target.symbol).toBe("one");

    writeFileSync(join(root, "a.md"), `# A\n\n${marker("src/x.ts#two")}\nClaim 1.\n`, "utf8");
    utimesSync(join(root, "a.md"), recorded, recorded); // same size, same mtime
    const stale = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 60_000 });
    expect(stale.markersOf("a.md")?.[0]?.target.symbol).toBe("one"); // knowingly stale

    const rebuilt = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 120_000, rebuild: true });
    expect(rebuilt.markersOf("a.md")?.[0]?.target.symbol).toBe("two");
  });
});

describe("doc index: each signal works on its own (defence in depth)", () => {
  const seeded = async () => {
    const root = await tree();
    put(root, "docs/a.md", `# A\n\n${marker("src/x.ts#one")}\nClaim 1.\n`);
    put(root, "docs/b.md", docText(2));
    settleTree(root);
    await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    return root;
  };

  it("a doc whose size changed is re-read even if its mtime didn't move", async () => {
    const root = await seeded();
    const recorded = statSync(join(root, "docs", "a.md")).mtimeMs / 1000;
    writeFileSync(join(root, "docs", "a.md"), `# A\n\n${marker("src/x.ts#one")}\nClaim 1.\n\nMore text.\n${marker("src/y.ts#two")}\nClaim 2.\n`, "utf8");
    utimesSync(join(root, "docs", "a.md"), recorded, recorded);
    const idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 60_000 });
    expect(idx.markersOf("docs/a.md")).toHaveLength(2);
  });

  it("a deleted doc is dropped even when its directory's mtime didn't move (filesystems that don't update it)", async () => {
    const root = await seeded();
    const dirMtime = statSync(join(root, "docs")).mtimeMs / 1000;
    rmSync(join(root, "docs", "b.md"));
    utimesSync(join(root, "docs"), dirMtime, dirMtime); // pretend the FS never touched it
    const idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 60_000 });
    expect(idx.docs).toEqual(["docs/a.md"]);
    expect(asMap(idx)).toEqual(fullScan(root));
  });

  it("an added doc is found by re-listing its directory, with no help from any doc mtime", async () => {
    const root = await seeded();
    writeFileSync(join(root, "docs", "new.md"), docText(5), "utf8");
    utimesSync(join(root, "docs", "new.md"), OLD + 9000, OLD + 9000);
    utimesSync(join(root, "docs"), OLD + 9001, OLD + 9001); // only the directory moved
    const idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 60_000 });
    expect(idx.docs).toEqual(["docs/a.md", "docs/b.md", "docs/new.md"]);
  });

  it("a removed directory takes its docs with it, and a new one appearing in its place is read fresh", async () => {
    const root = await seeded();
    rmSync(join(root, "docs"), { recursive: true });
    touch(root);
    expect((await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 60_000 })).docs).toEqual([]);
    put(root, "docs/c.md", docText(7));
    const back = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 120_000 });
    expect(back.docs).toEqual(["docs/c.md"]);
    expect(asMap(back)).toEqual(fullScan(root));
  });
});

describe("doc index: invalidation", () => {
  const seeded = async () => {
    const root = await tree();
    put(root, "CLAUDE.md", docText(1));
    put(root, "docs/g.md", docText(2));
    settleTree(root);
    await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    return root;
  };

  it("a changed `docs`/`exclude` config rebuilds, and selects according to the new config", async () => {
    const root = await seeded();
    const narrowed = { ...DEFAULT_CONFIG, docs: ["docs/**/*.md"] };
    const idx = await loadDocIndex(root, narrowed, { now: () => BASE + 1000 });
    expect(idx.stats.rebuilt).toBe(true);
    expect(idx.docs).toEqual(["docs/g.md"]);
    expect(asMap(idx)).toEqual(fullScan(root, narrowed));

    const widened = { ...DEFAULT_CONFIG, exclude: [] };
    expect((await loadDocIndex(root, widened, { now: () => BASE + 2000 })).stats.rebuilt).toBe(true);
  });

  it("rebuilds from scratch after MAX_AGE_MS, in case a filesystem's mtimes can't be trusted", async () => {
    const root = await seeded();
    expect((await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + MAX_AGE_MS - 1000 })).stats.rebuilt).toBe(false);
    expect((await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + MAX_AGE_MS + 10_000 })).stats.rebuilt).toBe(true);
  });

  it.each([
    ["truncated JSON", '{"v":1,"configKey":"x","builtAt":'],
    ["not JSON", "this is not json"],
    ["a different schema version", JSON.stringify({ v: 99, configKey: "x", builtAt: 1, dirs: {}, docs: {} })],
    ["the wrong shape", JSON.stringify({ v: 1, configKey: "x", builtAt: "soon", dirs: [], docs: null })],
    ["an empty file", ""],
  ])("a corrupt index (%s) is rebuilt, not trusted and not fatal", async (_name, content) => {
    const root = await seeded();
    writeFileSync(indexPath(root), content, "utf8");
    const idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 1000 });
    expect(idx.stats.rebuilt).toBe(true);
    expect(asMap(idx)).toEqual(fullScan(root));
    JSON.parse(await readFile(indexPath(root), "utf8")); // and it's valid again
  });

  it("`rebuild: true` ignores a perfectly good index", async () => {
    const root = await seeded();
    expect((await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 1000, rebuild: true })).stats.rebuilt).toBe(true);
  });

  it("a doc that becomes unreadable is dropped rather than failing the load", async () => {
    const root = await seeded();
    rmSync(join(root, "docs", "g.md"));
    mkdirSync(join(root, "docs", "g.md")); // a directory where the doc was
    touch(join(root, "docs"));
    const idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 1000 });
    expect(idx.docs).toEqual(["CLAUDE.md"]);
  });
});

describe("doc index: budget, persistence and failure modes", () => {
  it("an exhausted budget reports complete: false and leaves a good index untouched", async () => {
    const root = await tree();
    for (let i = 0; i < 4; i++) put(root, `d${i}/p.md`, docText(i));
    settleTree(root);
    await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    const before = await readFile(indexPath(root), "utf8");
    put(root, "d2/p.md", docText(77, 2)); // there is real work pending

    const starved = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 60_000, budgetMs: -1 });
    expect(starved.complete).toBe(false);
    expect(starved.stats.wrote).toBe(false);
    expect(await readFile(indexPath(root), "utf8")).toBe(before);

    const ok = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 120_000 });
    expect(ok.complete).toBe(true);
    expect(asMap(ok)).toEqual(fullScan(root));
  });

  it("a cold build that runs out of budget is never persisted", async () => {
    const root = await tree();
    for (let i = 0; i < 5; i++) put(root, `d${i}/p.md`, docText(i));
    settleTree(root);
    const idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE, budgetMs: -1 });
    expect(idx.complete).toBe(false);
    expect(existsSync(indexPath(root))).toBe(false);
  });

  it("persist: false reads and validates but writes nothing, not even the cache directory", async () => {
    const root = await tree();
    put(root, "a.md", docText(1));
    settleTree(root);
    const idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE, persist: false });
    expect(idx.docs).toEqual(["a.md"]);
    expect(idx.stats.wrote).toBe(false);
    expect(existsSync(join(root, ".lockwire"))).toBe(false);

    await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE }); // a persisting caller builds it
    put(root, "b.md", docText(2));
    const before = await readFile(indexPath(root), "utf8");
    const ro = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 60_000, persist: false });
    expect(ro.docs).toEqual(["a.md", "b.md"]); // it still sees the change...
    expect(await readFile(indexPath(root), "utf8")).toBe(before); // ...without touching the file
  });

  it("two loads at once both succeed and leave one valid index and no temp files", async () => {
    const root = await tree();
    for (let i = 0; i < 10; i++) put(root, `d${i}/p.md`, docText(i));
    settleTree(root);
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + n })),
    );
    for (const r of results) expect(asMap(r)).toEqual(fullScan(root));
    JSON.parse(await readFile(indexPath(root), "utf8"));
    expect(readdirSync(join(root, ".lockwire", "cache")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("an unwritable cache location costs nothing but the caching", async () => {
    const root = await tree();
    put(root, "a.md", docText(1));
    settleTree(root);
    writeFileSync(join(root, ".lockwire"), "i am a file where the directory should be", "utf8");
    const idx = await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    expect(idx.docs).toEqual(["a.md"]);
    expect(idx.stats.wrote).toBe(false);
  });
});

describe("the cache stays out of git", () => {
  it("writing the index creates .lockwire/.gitignore covering the cache and hook.log, once", async () => {
    const root = await tree();
    put(root, "a.md", docText(1));
    settleTree(root);
    await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    const path = join(root, ".lockwire", ".gitignore");
    const text = await readFile(path, "utf8");
    expect(text).toContain("cache/");
    expect(text).toContain("hook.log");
    put(root, "b.md", docText(2));
    await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE + 60_000 });
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("keeps the user's own .gitignore entries and only adds what's missing", async () => {
    const root = await tree();
    mkdirSync(join(root, ".lockwire"), { recursive: true });
    await writeFile(join(root, ".lockwire", ".gitignore"), "hook.log\nmy-local-notes.txt", "utf8");
    put(root, "a.md", docText(1));
    settleTree(root);
    await loadDocIndex(root, DEFAULT_CONFIG, { now: () => BASE });
    const lines = (await readFile(join(root, ".lockwire", ".gitignore"), "utf8")).split("\n").filter(Boolean);
    expect(lines).toEqual(["hook.log", "my-local-notes.txt", "cache/"]);
  });
});
