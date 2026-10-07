/**
 * A cache of which docs hold `<!-- lockwire … -->` markers, so a latency-sensitive caller (the
 * PreToolUse hook) doesn't have to walk the tree and read every doc on every edit.
 *
 * The index stores, per doc, its markers and the mtime/size it had when read; and per directory, its
 * mtime. Validating it is a `stat` of every recorded directory and doc — no tree walk, no reads:
 *
 *  - a directory whose mtime moved had entries added, removed or renamed: it's re-listed;
 *  - a doc whose mtime or size moved was edited: it's re-read;
 *  - a recorded path that's gone is dropped.
 *
 * Staleness is the one way this can go wrong, so it fails towards re-reading:
 *  - Entries modified within RACY_MS of the index being written are re-checked every time (a second
 *    write in the same timestamp tick would otherwise be invisible) and the index is refreshed once
 *    it has aged past that window.
 *  - A changed `docs`/`exclude` config, a different schema version, a corrupt file, or an index older
 *    than MAX_AGE_MS all rebuild from scratch.
 *  - A build or refresh that ran out of its time budget is never persisted.
 *  - Writes are atomic (temp file + rename), and any failure to read or write the cache just means it
 *    isn't used.
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanMarkers } from "./markers.js";
import { isScannedDoc, isSkippedEntry, stripBom } from "./repo.js";
import type { LockwireConfig } from "./types.js";

const INDEX_VERSION = 1;
/** Timestamp granularity we guard against: HFS+ is 1 s, FAT 2 s. */
export const RACY_MS = 2000;
/** Rebuild from scratch at least this often, in case a filesystem didn't keep its mtimes honest. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const indexPath = (repoRoot: string) =>
  join(repoRoot, ".lockwire", "cache", "doc-index.json");

/** What the rest of lockwire needs to know about a marker: enough to classify it and show its claim. */
export interface IndexedMarker {
  line: number;
  target: { path: string; symbol?: string };
  id: string | null;
  claimExcerpt: string;
}

interface DocEntry {
  mtimeMs: number;
  size: number;
  markers: IndexedMarker[];
}

interface IndexData {
  v: number;
  /** The `docs`/`exclude` globs the index was built for. */
  configKey: string;
  builtAt: number;
  dirs: Record<string, number>;
  docs: Record<string, DocEntry>;
}

export interface IndexStats {
  dirsStatted: number;
  dirsRescanned: number;
  docsStatted: number;
  docsRead: number;
  /** Built from scratch (no usable index) rather than refreshed. */
  rebuilt: boolean;
  wrote: boolean;
}

export interface DocIndex {
  /** Every doc the config selects, sorted. Only complete when `complete` is true. */
  docs: string[];
  markersOf(doc: string): IndexedMarker[] | undefined;
  /** False when the time budget ran out: `docs`/`markersOf` are then only what was reached. */
  complete: boolean;
  stats: IndexStats;
}

export interface LoadOptions {
  /** Stop and report `complete: false` after this long. Default: no limit. */
  budgetMs?: number;
  /** Write the refreshed index back. Default true; read-only callers pass false. */
  persist?: boolean;
  /** Ignore any existing index. */
  rebuild?: boolean;
  /** Clock, for tests. */
  now?: () => number;
}

const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const joinRel = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`);
const configKeyOf = (config: LockwireConfig) => JSON.stringify([config.docs, config.exclude]);

function tryStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

async function readIndexFile(repoRoot: string): Promise<IndexData | null> {
  try {
    const parsed = JSON.parse(stripBom(await readFile(indexPath(repoRoot), "utf8")));
    if (
      parsed?.v === INDEX_VERSION &&
      typeof parsed.configKey === "string" &&
      typeof parsed.builtAt === "number" &&
      parsed.dirs &&
      typeof parsed.dirs === "object" &&
      parsed.docs &&
      typeof parsed.docs === "object"
    )
      return parsed as IndexData;
  } catch {
    // missing or corrupt: rebuild
  }
  return null;
}

/** Keeps the cache (and hook.log) out of git: `.lockwire/` itself is committed. Never overwrites the user's. */
export async function ensureLockwireGitignore(repoRoot: string): Promise<void> {
  const path = join(repoRoot, ".lockwire", ".gitignore");
  const wanted = ["cache/", "hook.log"];
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    // none yet
  }
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = wanted.filter((w) => !have.has(w));
  if (missing.length === 0) return;
  await mkdir(join(repoRoot, ".lockwire"), { recursive: true });
  const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
  if (current === "")
    await writeFile(
      path,
      `# lockwire's derived, machine-local files\n${missing.join("\n")}\n`,
      "utf8",
    );
  else await appendFile(path, `${prefix}${missing.join("\n")}\n`, "utf8");
}

async function writeIndexFile(repoRoot: string, data: IndexData): Promise<boolean> {
  const final = indexPath(repoRoot);
  const tmp = `${final}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await ensureLockwireGitignore(repoRoot);
    await mkdir(join(repoRoot, ".lockwire", "cache"), { recursive: true });
    await writeFile(tmp, JSON.stringify(data), "utf8");
    await rename(tmp, final);
    return true;
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
}

/** Reads (and, unless told not to, refreshes) the doc index for `repoRoot`. Never throws. */
export async function loadDocIndex(
  repoRoot: string,
  config: LockwireConfig,
  opts: LoadOptions = {},
): Promise<DocIndex> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? Number.POSITIVE_INFINITY);
  const stats: IndexStats = {
    dirsStatted: 0,
    dirsRescanned: 0,
    docsStatted: 0,
    docsRead: 0,
    rebuilt: false,
    wrote: false,
  };
  const configKey = configKeyOf(config);
  const abs = (rel: string) => (rel === "" ? repoRoot : join(repoRoot, rel));
  const over = () => now() > deadline;

  let data = opts.rebuild ? null : await readIndexFile(repoRoot);
  if (data && (data.configKey !== configKey || now() - data.builtAt > MAX_AGE_MS)) data = null;

  let complete = true;
  let changed = false;
  let sawRacy = false;
  const readThisRun = new Set<string>();

  /** Stat, then read: an edit landing in between leaves a newer mtime than we recorded, so it's caught next time. */
  function readDoc(rel: string): void {
    const st = tryStat(abs(rel));
    if (!st?.isFile() || !data) return;
    let markers: IndexedMarker[];
    try {
      markers = scanMarkers(readFileSync(abs(rel), "utf8")).map((m) => ({
        line: m.line,
        target: m.target,
        id: m.id,
        claimExcerpt: m.claimExcerpt,
      }));
    } catch {
      return; // unreadable now: leave it as it was; a later run will try again
    }
    stats.docsRead++;
    const prev = data.docs[rel];
    data.docs[rel] = { mtimeMs: st.mtimeMs, size: st.size, markers };
    readThisRun.add(rel);
    // Re-reading an unchanged (merely racy) doc isn't a change worth rewriting the index for.
    if (
      !prev ||
      prev.mtimeMs !== st.mtimeMs ||
      prev.size !== st.size ||
      JSON.stringify(prev.markers) !== JSON.stringify(markers)
    )
      changed = true;
  }

  function listDir(rel: string): { dirs: string[]; docs: string[] } | null {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs(rel), { withFileTypes: true });
    } catch {
      return null;
    }
    const dirs: string[] = [];
    const docs: string[] = [];
    for (const e of entries) {
      const child = joinRel(rel, e.name);
      if (isSkippedEntry(e.name, child, config.exclude)) continue;
      if (e.isDirectory()) dirs.push(child);
      else if (isScannedDoc(child, config)) docs.push(child);
    }
    return { dirs, docs };
  }

  function buildSubtree(rel: string): void {
    if (!data) return;
    if (over()) {
      complete = false;
      return;
    }
    const st = tryStat(abs(rel));
    if (!st?.isDirectory()) return;
    const listing = listDir(rel);
    if (!listing) return;
    data.dirs[rel] = st.mtimeMs; // recorded from the stat taken before the listing
    changed = true;
    for (const doc of listing.docs) {
      if (over()) {
        complete = false;
        return;
      }
      readDoc(doc);
    }
    for (const dir of listing.dirs) buildSubtree(dir);
  }

  function dropSubtree(rel: string): void {
    if (!data) return;
    const prefix = rel === "" ? "" : `${rel}/`;
    for (const d of Object.keys(data.dirs))
      if (d === rel || d.startsWith(prefix)) delete data.dirs[d];
    for (const d of Object.keys(data.docs)) if (d.startsWith(prefix)) delete data.docs[d];
    changed = true;
  }

  if (!data) {
    stats.rebuilt = true;
    // Create the cache directory first: doing it after the walk would bump the repo root's mtime past
    // the one we recorded, and the next load would re-list the root for nothing.
    if (opts.persist !== false)
      await mkdir(join(repoRoot, ".lockwire", "cache"), { recursive: true }).catch(() => undefined);
    data = { v: INDEX_VERSION, configKey, builtAt: now(), dirs: {}, docs: {} };
    buildSubtree("");
  } else {
    const index = data;
    const racy = (mtimeMs: number) => mtimeMs >= index.builtAt - RACY_MS;

    // 1. Which recorded directories moved? Parents first, so dropping one covers its children.
    const dirty: { rel: string; mtimeMs: number }[] = [];
    for (const rel of Object.keys(index.dirs).sort((a, b) => a.length - b.length)) {
      if (!(rel in index.dirs)) continue; // already dropped with its parent
      if (over()) {
        complete = false;
        break;
      }
      stats.dirsStatted++;
      const st = tryStat(abs(rel));
      if (!st?.isDirectory()) {
        dropSubtree(rel);
        continue;
      }
      if (racy(st.mtimeMs)) sawRacy = true;
      if (st.mtimeMs !== index.dirs[rel] || racy(st.mtimeMs))
        dirty.push({ rel, mtimeMs: st.mtimeMs });
    }

    // 2. Re-list those, reconciling added and removed entries.
    for (const { rel, mtimeMs } of dirty) {
      if (!complete) break;
      if (!(rel in index.dirs)) continue;
      stats.dirsRescanned++;
      const listing = listDir(rel);
      if (!listing) {
        dropSubtree(rel);
        continue;
      }
      const wantDirs = new Set(listing.dirs);
      const wantDocs = new Set(listing.docs);
      for (const d of Object.keys(index.dirs))
        if (d !== rel && parentOf(d) === rel && !wantDirs.has(d)) dropSubtree(d);
      for (const d of Object.keys(index.docs))
        if (parentOf(d) === rel && !wantDocs.has(d)) {
          delete index.docs[d];
          changed = true;
        }
      for (const dir of listing.dirs) if (!(dir in index.dirs)) buildSubtree(dir);
      for (const doc of listing.docs) if (!(doc in index.docs)) readDoc(doc);
      if (index.dirs[rel] !== mtimeMs) {
        index.dirs[rel] = mtimeMs;
        changed = true;
      }
    }

    // 3. Which recorded docs were edited or removed?
    if (complete) {
      for (const rel of Object.keys(index.docs)) {
        if (readThisRun.has(rel)) continue;
        if (over()) {
          complete = false;
          break;
        }
        stats.docsStatted++;
        const st = tryStat(abs(rel));
        const entry = index.docs[rel];
        if (!st?.isFile() || !entry) {
          delete index.docs[rel];
          changed = true;
          continue;
        }
        if (racy(st.mtimeMs)) sawRacy = true;
        if (st.mtimeMs !== entry.mtimeMs || st.size !== entry.size || racy(st.mtimeMs))
          readDoc(rel);
      }
    }
  }

  const index = data;
  if (complete && opts.persist !== false) {
    // Rewrite when something changed, or when racy entries have aged enough to be trusted.
    const settled = sawRacy && now() - index.builtAt > RACY_MS;
    if (changed || settled || stats.rebuilt) {
      index.builtAt = now();
      stats.wrote = await writeIndexFile(repoRoot, index);
    }
  }

  return {
    docs: Object.keys(index.docs).sort(),
    markersOf: (doc) => index.docs[doc]?.markers,
    complete,
    stats,
  };
}
