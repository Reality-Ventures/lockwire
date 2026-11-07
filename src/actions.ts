import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { headCommit } from "./changed.js";
import { unreadableReason } from "./compat.js";
import { type IndexState, type IndexStats, loadDocIndex } from "./docindex.js";
import {
  computeWholeFileTiers,
  extractFileSymbols,
  FINGERPRINT_VERSION,
  fileExportsFingerprint,
} from "./extract.js";
import { type LangId, langForPath, parserFor } from "./grammar.js";
import { fingerprint, fingerprintSet } from "./hash.js";
import { appendEvent, historyFor, readLedger } from "./ledger.js";
import {
  anchorsForPath,
  lockfilePath,
  newAnchorId,
  readLockfile,
  removeAnchor,
  upsertAnchor,
  writeFileAtomic,
  writeLockfile,
} from "./lockfile.js";
import {
  claimUnchanged,
  type DocMarker,
  retargetMarkerLine,
  scanMarkers,
  stampMarkerLine,
} from "./markers.js";
import { isTrivialBody, type MoveHint, NO_DEPS, SourceIndex, sigFingerprints } from "./moves.js";
import { extractReExports, NO_REEXPORTS, type ReExports, resolveModule } from "./reexports.js";
import {
  canonicalDocPath,
  globToRegExp,
  isScannedDoc,
  matchesAny,
  outsideRepoMessage,
  resolveInsideRepo,
  stripBom,
  walkFiles,
} from "./repo.js";
import type {
  Actor,
  Anchor,
  AnchorTarget,
  FileSymbols,
  Fingerprints,
  Lockfile,
  LockwireConfig,
  Tier,
} from "./types.js";
import { ALL_TIERS, tierFingerprint } from "./types.js";
import {
  checkClaimAgainstValue,
  dataFormatOf,
  resolveValue,
  valueFingerprintInput,
  wholeFileContent,
} from "./values.js";

export interface TargetResolution {
  found: boolean;
  fingerprints: Fingerprints;
  symbols?: FileSymbols;
  /** For a value anchor: the value now, and how to show it. */
  value?: { raw: unknown; display: string };
  /** When not found and there's more to say (an ambiguous CSV row, a missing column). */
  reason?: string;
  /**
   * Where the symbol is really defined, when the target's file only re-exports it (a name kept at the
   * old path for compatibility after a move). Absent when it is defined where the target says.
   */
  definedAt?: AnchorTarget;
}

/** How many re-exports deep `resolveTarget` follows a name before giving up (`a` → `b` → `c` …). */
const MAX_REEXPORT_HOPS = 8;

/** The fingerprint version an anchor was stamped with (anchors from before versions are version 1). */
export const versionOf = (anchor: Pick<Anchor, "fingerprintVersion">) =>
  anchor.fingerprintVersion ?? 1;

/**
 * Recomputes all four tier fingerprints for a target, or reports it unresolved (file/symbol not found).
 * `version` is how to compute them: the current way to stamp, an anchor's own to compare with it.
 */
export async function resolveTarget(
  repoRoot: string,
  target: { path: string; symbol?: string },
  config: LockwireConfig,
  version: number = FINGERPRINT_VERSION,
): Promise<(TargetResolution & { source?: string }) | null> {
  const absPath = resolveInsideRepo(repoRoot, target.path);
  if (!absPath) throw new Error(outsideRepoMessage(target.path));
  if (!existsSync(absPath)) return null;
  const here = await resolveTargetInText(target, await readFile(absPath, "utf8"), config, version);
  if (here.found || !target.symbol || !here.reExports) return here;
  const via = await followReExport(repoRoot, target, here.reExports, config, version, [
    target.path,
  ]);
  if (!via) return here;
  // Bound to the old path: `path` stays that path's, and the claim keeps the name it was stamped under.
  return { ...via, fingerprints: { ...via.fingerprints, path: here.fingerprints.path } };
}

/**
 * The symbol a file doesn't define but re-exports, resolved where it is defined, with its `sig`
 * rendered under the name the target asks for (`export { fooV2 as foo }` answers for `foo`).
 * `seen` is the chain so far, so a re-export cycle ends instead of looping.
 */
async function followReExport(
  repoRoot: string,
  target: { path: string; symbol?: string },
  reExports: ReExports,
  config: LockwireConfig,
  version: number,
  seen: string[],
): Promise<(TargetResolution & { source?: string }) | null> {
  const symbol = target.symbol;
  if (!symbol || seen.length > MAX_REEXPORT_HOPS) return null;
  const dot = symbol.indexOf(".");
  const head = dot < 0 ? symbol : symbol.slice(0, dot);
  const rest = dot < 0 ? "" : symbol.slice(dot + 1);
  const routes: { from: string; symbol: string }[] = [];
  for (const r of reExports.named) {
    if (r.name !== head || r.imported === "default") continue;
    if (r.imported === "*") {
      if (rest) routes.push({ from: r.from, symbol: rest }); // `ns.foo` through `export * as ns`
    } else routes.push({ from: r.from, symbol: rest ? `${r.imported}.${rest}` : r.imported });
  }
  for (const from of reExports.star) routes.push({ from, symbol });

  for (const route of routes) {
    const file = resolveModule(repoRoot, target.path, route.from);
    if (!file || seen.includes(file)) continue;
    const abs = resolveInsideRepo(repoRoot, file);
    if (!abs) continue;
    let there: Awaited<ReturnType<typeof resolveTargetInText>>;
    try {
      there = await resolveTargetInText(
        { path: file, symbol: route.symbol },
        await readFile(abs, "utf8"),
        config,
        version,
      );
    } catch {
      continue;
    }
    if (!there.found) {
      if (!there.reExports) continue;
      const deeper = await followReExport(
        repoRoot,
        { path: file, symbol: route.symbol },
        there.reExports,
        config,
        version,
        [...seen, file],
      );
      if (deeper) return renamedAs(deeper, symbol, route.symbol);
      continue;
    }
    return renamedAs(
      { ...there, definedAt: { path: file, symbol: route.symbol } },
      symbol,
      route.symbol,
    );
  }
  return null;
}

/** A re-exported symbol's `sig` under the name it is asked for, when an alias renamed it on the way. */
function renamedAs<R extends TargetResolution>(r: R, asked: string, defined: string): R {
  const name = (p: string) => p.slice(p.lastIndexOf(".") + 1);
  if (name(asked) === name(defined)) return r;
  const def = r.symbols?.bySymbolPath.get(r.definedAt?.symbol ?? defined);
  const sig = def?.sigFor?.(name(asked));
  return sig ? { ...r, fingerprints: { ...r.fingerprints, sig: fingerprint(sig) } } : r;
}

/** A source file's symbols, parsed (or served from the parse cache) the way `version` reads them. */
export async function symbolsOfSource(
  path: string,
  content: string,
  config: LockwireConfig,
  version: number = FINGERPRINT_VERSION,
): Promise<FileSymbols | null> {
  const lang = langForPath(path);
  if (!lang) return null;
  return (await parseSource(path, content, lang, config, version, false)).symbols;
}

/**
 * {@link resolveTarget} on given file contents rather than the file on disk — used to fingerprint a
 * target as it was at an earlier commit. `source` is the bound symbol's declaration as written.
 */
export async function resolveTargetInText(
  target: { path: string; symbol?: string },
  content: string,
  config: LockwireConfig,
  version: number = FINGERPRINT_VERSION,
): Promise<TargetResolution & { source?: string; reExports?: ReExports }> {
  // A data file (JSON, LaTeX macros): the target is a value in it, not a symbol.
  const dataFormat = dataFormatOf(target.path);
  if (dataFormat) {
    const text = stripBom(content);
    const pathFp = fingerprint(target.path);
    const empty = { path: pathFp, sig: "", body: "", deps: "", value: "" };
    if (!target.symbol)
      return {
        found: true,
        fingerprints: { ...empty, body: fingerprint(wholeFileContent(text, dataFormat)) },
        source: text,
      };
    const v = resolveValue(text, dataFormat, target.symbol);
    if (!v.found)
      return { found: false, fingerprints: empty, ...(v.reason ? { reason: v.reason } : {}) };
    return {
      found: true,
      fingerprints: { ...empty, value: fingerprint(valueFingerprintInput(v.value)) },
      value: { raw: v.value, display: v.display ?? "" },
      source: v.display ?? "",
    };
  }

  const lang = langForPath(target.path);
  if (!lang)
    throw new Error(
      `lockwire supports TypeScript, TSX, JavaScript, and Python source, and values in JSON, CSV, TSV and LaTeX (.tex) files — "${target.path}" is none of these`,
    );

  // A symbol anchor never needs the whole file serialized, which is the costly part in a big file.
  const parsed = await parseSource(target.path, content, lang, config, version, !target.symbol);
  const { symbols } = parsed;
  const pathFp = fingerprint(target.path);

  if (target.symbol) {
    const symbol = symbols.bySymbolPath.get(target.symbol);
    if (!symbol)
      return {
        found: false,
        fingerprints: { path: pathFp, sig: "", body: "", deps: "" },
        symbols,
        reExports: parsed.reExports,
      };
    return {
      found: true,
      fingerprints: {
        path: pathFp,
        sig: fingerprint(symbol.sigTokens),
        body: fingerprint(symbol.bodyNormalized),
        deps: fingerprintSet(symbol.deps),
      },
      symbols,
      source: symbol.sourceText,
    };
  }

  return {
    found: true,
    fingerprints: {
      path: pathFp,
      sig: fileExportsFingerprint(symbols),
      body: fingerprint(parsed.whole?.bodyNormalized ?? ""),
      deps: fingerprintSet(parsed.whole?.deps ?? []),
    },
    symbols,
    source: content,
  };
}

interface ParsedSource {
  content: string;
  symbols: FileSymbols;
  /** Names the file makes available without defining them (see reexports.ts). */
  reExports: ReExports;
  /** Only computed once a whole-file anchor asks for it. */
  whole?: { bodyNormalized: string; deps: string[] };
}

/**
 * The last parse of each file, reused while its content is the same: a check with many anchors on one
 * file parses it once, not once per anchor. Keyed on the content itself rather than mtime, so an edit
 * within the same millisecond can't be served stale.
 */
const parseCache = new Map<string, ParsedSource>();
const PARSE_CACHE_SIZE = 256;

async function parseSource(
  path: string,
  content: string,
  lang: LangId,
  config: LockwireConfig,
  version: number,
  needWhole: boolean,
): Promise<ParsedSource> {
  const key = `${version}|${config.normalizeLocals}|${lang}|${path}`;
  const hit = parseCache.get(key);
  if (hit && hit.content === content && (hit.whole || !needWhole)) {
    parseCache.delete(key); // most recently used last
    parseCache.set(key, hit);
    return hit;
  }
  const tree = (await parserFor(lang)).parse(content);
  if (!tree) throw new Error(`failed to parse ${path}`);
  // Everything kept is read out as strings, so the tree (wasm memory) is freed straight away.
  let parsed: ParsedSource;
  try {
    parsed = {
      content,
      symbols:
        hit?.content === content
          ? hit.symbols
          : extractFileSymbols(tree.rootNode, lang, config.normalizeLocals, version),
      reExports:
        hit?.content === content
          ? hit.reExports
          : safeReExports(() => extractReExports(tree.rootNode, lang)),
      ...(needWhole
        ? { whole: computeWholeFileTiers(tree.rootNode, lang, config.normalizeLocals, version) }
        : {}),
    };
  } finally {
    tree.delete();
  }
  parseCache.delete(key);
  parseCache.set(key, parsed);
  if (parseCache.size > PARSE_CACHE_SIZE) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  return parsed;
}

/** Re-exports are a convenience on top of resolution: a form this reader trips on just isn't followed. */
function safeReExports(read: () => ReExports): ReExports {
  try {
    return read();
  } catch {
    return NO_REEXPORTS;
  }
}

/**
 * Same-file rename detection: if a symbol vanished but exactly one other symbol in the file has the
 * same signature apart from its name, relink to it. `sig` fingerprints include the symbol's name,
 * so each candidate is re-rendered under the missing symbol's old name before comparing -- that
 * keeps stored fingerprints valid. Symbols already bound by another anchor are skipped, so an
 * unrelated neighbour with the same shape isn't mistaken for the rename target. A symbol moved to a
 * different file is found by `SourceIndex.findMove` (moves.ts) and re-pointed by {@link repoint}.
 */
export function findRelocationCandidate(
  symbols: FileSymbols,
  missingSigFp: string,
  oldName: string,
  taken: ReadonlySet<string> = new Set(),
  /**
   * The vanished symbol's stamped body and deps. When given, a candidate must also match one of them:
   * a rename keeps the implementation, while a deleted function's look-alike neighbour (same
   * parameters, different code) is not where its claim went. An empty body or no calls at all is no
   * evidence: any two functions with the same parameters would "match" on it (`findPosX` and
   * `findPosY`, both calling nothing).
   */
  stamped?: Pick<Fingerprints, "body" | "deps">,
): string | null {
  const candidates: string[] = [];
  for (const [path, symbol] of symbols.bySymbolPath) {
    if (taken.has(path)) continue;
    const sig =
      symbol.sigFor?.(oldName) ??
      symbol.sigTokens
        .replace(`fn ${symbol.name}(`, `fn ${oldName}(`)
        .replace(`class ${symbol.name} [`, `class ${oldName} [`);
    if (fingerprint(sig) !== missingSigFp) continue;
    if (
      stamped &&
      !(!isTrivialBody(stamped.body) && fingerprint(symbol.bodyNormalized) === stamped.body) &&
      !(stamped.deps !== NO_DEPS && fingerprintSet(symbol.deps) === stamped.deps)
    )
      continue;
    candidates.push(path);
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export interface LinkResult {
  created: number;
  refreshed: number;
  /** Markers whose anchor was already fresh and current: nothing was written for them. */
  unchanged: number;
  skipped: { reason: string; target: string }[];
}

/** Tiers a marker binds when it doesn't say: `value` for a value in a data file, `sig` for a symbol, `path,body` for a file. */
/** The tiers a target can actually produce: a tier it can't would be empty forever, so never drift. */
export function applicableTiers(target: { path: string; symbol?: string }): Tier[] {
  if (dataFormatOf(target.path)) return target.symbol ? ["value", "path"] : ["path", "body"];
  return ["path", "sig", "body", "deps"];
}

/** Why `tiers` can't be bound to `target`, or null when they all can. */
export function inapplicableTiersReason(
  target: { path: string; symbol?: string },
  tiers: readonly Tier[],
): string | null {
  const allowed = applicableTiers(target);
  const bad = tiers.filter((t) => !allowed.includes(t));
  if (bad.length === 0) return null;
  const label = `${target.path}${target.symbol ? `#${target.symbol}` : ""}`;
  return `${bad.length === 1 ? "tier" : "tiers"} ${bad.join(", ")} can't apply to ${label}, which can bind ${allowed.join(", ")}`;
}

function defaultTiers(
  target: { path: string; symbol?: string },
  resolved?: TargetResolution | null,
): Tier[] {
  if (resolved?.value || (target.symbol && dataFormatOf(target.path))) return ["value"];
  return target.symbol ? ["sig"] : ["path", "body"];
}

/** Scans a markdown doc for `<!-- lockwire ... -->` markers and creates/refreshes their anchors. */
export async function linkDoc(
  repoRoot: string,
  docPath: string,
  config: LockwireConfig,
  actor: Actor,
  opts: {
    reviewed?: boolean;
    commit?: string | null;
    /** Only (re-)stamp the markers this accepts; leave the rest of the doc alone. */
    only?: (marker: DocMarker) => boolean;
    /** Why, for the ledger (e.g. an agent's account of what it checked). */
    note?: string;
  } = {},
): Promise<LinkResult> {
  const absDoc = resolveInsideRepo(repoRoot, docPath);
  if (!absDoc) throw new Error(outsideRepoMessage(docPath));
  // A symlinked doc is bound under the file it points to, so naming either one gives the same anchors.
  docPath = canonicalDocPath(repoRoot, docPath, absDoc);
  const text = await readFile(absDoc, "utf8");
  const markers = scanMarkers(text);
  const lockfile = await readLockfile(repoRoot);
  const result: LinkResult = { created: 0, refreshed: 0, unchanged: 0, skipped: [] };
  // Keep each line's own terminator: stamping a marker must change that one line, not rewrite every
  // CRLF in the file to LF. `parts` alternates line, terminator, line, terminator, ...
  const parts = text.split(/(\r?\n)/);
  let docChanged = false;
  let current = lockfile;
  const idsSeenInDoc = new Set<string>();
  const commit = opts.commit ?? headCommit(repoRoot);

  for (const marker of markers) {
    if (opts.only && !opts.only(marker)) {
      // Not ours to stamp, but it still counts when spotting a duplicated id further down.
      if (marker.id) idsSeenInDoc.add(marker.id);
      continue;
    }
    const targetLabel = `${marker.target.path}${marker.target.symbol ? `#${marker.target.symbol}` : ""}`;
    if (marker.problem) {
      result.skipped.push({ reason: marker.problem, target: targetLabel });
      continue;
    }
    let existing = marker.id ? current.anchors.find((a) => a.id === marker.id) : undefined;

    // A marker copy-pasted into another doc carries the original's id. If the original doc still
    // holds that marker, this is a second claim, not the same one moved -- binding it to the
    // existing anchor would silently stop checking the original sentence.
    let copiedId = false;
    // The same id twice in one doc (a duplicated marker) is a copy too: the second one gets its own.
    if (marker.id && idsSeenInDoc.has(marker.id)) {
      copiedId = true;
      existing = undefined;
    }
    if (existing?.doc && existing.doc !== docPath) {
      const originalPath = resolveInsideRepo(repoRoot, existing.doc);
      const stillThere =
        originalPath !== null &&
        existsSync(originalPath) &&
        scanMarkers(await readFile(originalPath, "utf8")).some((m) => m.id === existing?.id);
      if (stillThere) {
        copiedId = true;
        existing = undefined;
      }
    }

    // Re-stamping what a newer lockwire wrote would downgrade it to what this one understands.
    const tooNew = existing && !copiedId ? unreadableReason(existing) : null;
    if (tooNew) {
      result.skipped.push({
        reason: `stamped by a newer lockwire (${tooNew}): update this lockwire to re-link it`,
        target: targetLabel,
      });
      continue;
    }

    // One unsupported or unparseable target must not stop the rest of the doc from linking.
    let resolved: TargetResolution | null;
    try {
      resolved = await resolveTarget(repoRoot, marker.target, config);
    } catch (err) {
      result.skipped.push({
        reason: err instanceof Error ? err.message : String(err),
        target: targetLabel,
      });
      continue;
    }

    // The marker names a symbol that's gone, but its anchor was relocated to a renamed one (`check`
    // does that, and only updates the lockfile). Follow the anchor and fix the marker to match.
    let target = marker.target;
    let retargeted = false;
    if (!resolved?.found && existing) {
      const moved = existing.target;
      if (moved.path !== marker.target.path || moved.symbol !== marker.target.symbol) {
        try {
          const viaAnchor = await resolveTarget(repoRoot, moved, config);
          if (viaAnchor?.found) {
            resolved = viaAnchor;
            target = moved;
            retargeted = true;
          }
        } catch {
          // fall through to "target not found"
        }
      }
    }
    if (!resolved?.found) {
      result.skipped.push({
        reason: resolved?.reason ? `target not found: ${resolved.reason}` : "target not found",
        target: targetLabel,
      });
      continue;
    }

    // Compare with the anchor as it was computed: an anchor stamped by an older fingerprint version is
    // compared under that version, so upgrading lockwire never reads as changed code.
    const compared =
      existing && versionOf(existing) !== FINGERPRINT_VERSION
        ? await resolveTarget(repoRoot, target, config, versionOf(existing)).catch(() => null)
        : resolved;
    const then = compared?.found ? compared : resolved;

    // Re-stamping an anchor whose bound code moved since it was stamped accepts code nobody has looked
    // at, so it needs a human's say-so -- whether or not a `check` has recorded the drift yet. A moved
    // value the sentence already states is the fix itself, not unreviewed code.
    const codeDrifted =
      existing?.tiers.some((t) => {
        if (tierFingerprint(then.fingerprints, t) === tierFingerprint(existing.fingerprints, t))
          return false;
        if (t !== "value" || !resolved.value) return true;
        const verdict = checkClaimAgainstValue(marker.claimText, resolved.value.raw);
        return !(verdict.checkable && verdict.matches);
      }) === true;
    if (codeDrifted && !opts.reviewed) {
      result.skipped.push({
        reason: "the code changed since this claim was stamped: review it, then link --reviewed",
        target: targetLabel,
      });
      continue;
    }

    const tiers = marker.tiers ?? defaultTiers(target, resolved);
    const tierProblem = inapplicableTiersReason(target, tiers);
    if (tierProblem) {
      result.skipped.push({ reason: tierProblem, target: targetLabel });
      continue;
    }

    // Stamping a value anchor whose sentence states a different value would bind a false claim.
    if (tiers.includes("value") && resolved.value) {
      const verdict = checkClaimAgainstValue(marker.claimText, resolved.value.raw);
      if (verdict.checkable && !verdict.matches) {
        result.skipped.push({
          reason: `the claim states ${verdict.claimed.length ? verdict.claimed.join(", ") : "something else"} but ${targetLabel} is ${resolved.value.display}: fix the sentence, then link`,
          target: targetLabel,
        });
        continue;
      }
    }
    const isNew = !marker.id || copiedId;
    const id = isNew || !marker.id ? newAnchorId() : marker.id;
    idsSeenInDoc.add(id);
    if (marker.id) idsSeenInDoc.add(marker.id);

    // Nothing to re-stamp: same claim, same place, same code. Leave the anchor and the ledger alone.
    if (
      existing &&
      !isNew &&
      !retargeted &&
      existing.status === "fresh" &&
      versionOf(existing) === FINGERPRINT_VERSION &&
      existing.doc === docPath &&
      existing.claim?.hash === marker.claimHash &&
      existing.claim?.line === marker.claimLine &&
      existing.tiers.join() === tiers.join() &&
      ALL_TIERS.every(
        (t) =>
          tierFingerprint(existing.fingerprints, t) === tierFingerprint(resolved.fingerprints, t),
      )
    ) {
      result.unchanged++;
      continue;
    }

    const anchor: Anchor = {
      id,
      doc: docPath,
      claim: {
        line: marker.claimLine,
        hash: marker.claimHash,
        normHash: marker.claimNormHash,
        excerpt: marker.claimExcerpt,
      },
      target,
      tiers,
      fingerprints: resolved.fingerprints,
      fingerprintVersion: FINGERPRINT_VERSION,
      linked: { at: new Date().toISOString(), commit, by: actor },
      status: "fresh",
      waiver: null,
      ...(resolved.value ? { value: resolved.value.display } : {}),
    };
    current = upsertAnchor(current, anchor);

    if (isNew) {
      const partIdx = (marker.line - 1) * 2;
      const original = parts[partIdx];
      if (original !== undefined) {
        parts[partIdx] = stampMarkerLine(original, id);
        docChanged = true;
      }
      result.created++;
      await appendEvent(repoRoot, {
        ts: anchor.linked.at,
        event: "anchor.created",
        anchor: id,
        actor,
        commit,
        ...(opts.note ? { note: opts.note } : {}),
      });
    } else {
      result.refreshed++;
      if (retargeted) {
        const partIdx = (marker.line - 1) * 2;
        const original = parts[partIdx];
        if (original !== undefined) {
          parts[partIdx] = retargetMarkerLine(original, target);
          docChanged = true;
        }
      }
      await appendEvent(repoRoot, {
        ts: anchor.linked.at,
        event: "anchor.resolved",
        anchor: id,
        actor,
        commit,
        note: [
          retargeted
            ? `re-stamped via link; marker retargeted ${targetLabel} -> ${target.path}${target.symbol ? `#${target.symbol}` : ""}`
            : "re-stamped via link",
          opts.note,
        ]
          .filter(Boolean)
          .join("; "),
      });
    }
  }

  // Nothing stamped (everything skipped or refused): leave the lockfile exactly as it was.
  if (result.created + result.refreshed > 0) await writeLockfile(repoRoot, current);
  if (docChanged) await writeFileAtomic(absDoc, parts.join(""));
  return result;
}

/** `lockwire link <doc> <target>` — a lockfile-only anchor with no inline marker, for whole-doc-to-file bindings. */
export async function linkLockfileOnly(
  repoRoot: string,
  docPath: string,
  target: { path: string; symbol?: string },
  tiers: Tier[],
  config: LockwireConfig,
  actor: Actor,
): Promise<Anchor> {
  const tierProblem = inapplicableTiersReason(target, tiers);
  if (tierProblem) throw new Error(tierProblem);
  const resolved = await resolveTarget(repoRoot, target, config);
  if (!resolved?.found)
    throw new Error(`target not found: ${target.path}${target.symbol ? `#${target.symbol}` : ""}`);
  const lockfile = await readLockfile(repoRoot);
  const anchor: Anchor = {
    id: newAnchorId(),
    doc: docPath,
    claim: null,
    target,
    tiers,
    fingerprints: resolved.fingerprints,
    fingerprintVersion: FINGERPRINT_VERSION,
    linked: { at: new Date().toISOString(), commit: null, by: actor },
    status: "fresh",
    waiver: null,
    ...(resolved.value ? { value: resolved.value.display } : {}),
  };
  await writeLockfile(repoRoot, upsertAnchor(lockfile, anchor));
  await appendEvent(repoRoot, {
    ts: anchor.linked.at,
    event: "anchor.created",
    anchor: anchor.id,
    actor,
    commit: null,
  });
  return anchor;
}

export interface AnchorCheckResult {
  anchor: Anchor;
  status: Anchor["status"];
  driftedTiers: Tier[];
  /** The claim sentence in the doc was edited (or its marker removed) since the anchor was stamped. */
  claimChanged?: boolean;
  /** Outside the scope of a path-limited run: reported with its stored status, not re-examined. */
  skipped?: boolean;
  /** Why this lockwire can't check the anchor: a newer one stamped it (see compat.ts). Also `skipped`. */
  unreadable?: string;
  /**
   * For a value anchor whose value moved or no longer matches its sentence: what it was when stamped,
   * what it is now, the numbers the sentence states, and whether the sentence still holds.
   */
  value?: { was?: string; now: string; claimed: string[]; matches: boolean };
  /**
   * The bound symbol's code as stamped was found in another file: where it went (`to`, when there is
   * exactly one place) and every place it was found. Set on an orphaned anchor, and on a drifted one
   * whose code changed where it was. `lockwire repoint` re-points the claim to `to`.
   */
  moved?: MoveHint;
  /**
   * On an orphaned anchor: the one other symbol in the file with the same signature, when nothing
   * else ties it to the missing one (a renamed function whose body also changed looks just like a
   * look-alike neighbour). Not acted on; `lockwire repoint <id> --to` re-points the claim to it.
   */
  similar?: AnchorTarget;
  /** Where the symbol is really defined, when the target's file only re-exports it. */
  definedAt?: AnchorTarget;
  singleHashWouldFlag: boolean; // any of the four tiers changed, regardless of binding
}

export interface CheckSummary {
  anchors: number;
  fresh: number;
  drifted: number;
  relocated: number;
  orphaned: number;
  waived: number;
  superseded: number;
  /** Anchors whose code moved, unchanged, to exactly one other place: `lockwire repoint` re-points them. */
  moved: number;
  /** Markers in the scanned docs that no anchor backs: those claims aren't being checked. */
  unlinked: number;
  noise: { singleHashWouldFlag: number; tieredFlagged: number; reductionPercent: number };
}

/** A marker in a doc that isn't backed by an anchor, so the claim under it is not being checked. */
export interface UnlinkedMarker {
  doc: string;
  line: number;
  target: string;
  reason: string;
  /** The claim sentence under the marker, so a reader can see what is being asserted. */
  excerpt: string;
}

export interface CheckResult {
  summary: CheckSummary;
  results: AnchorCheckResult[];
  unlinked: UnlinkedMarker[];
}

/** A cached reader of a doc's markers, or null when the doc doesn't exist. */
export function markerReader(repoRoot: string) {
  const cache = new Map<string, DocMarker[] | null>();
  return async (doc: string): Promise<DocMarker[] | null> => {
    if (!cache.has(doc)) {
      const abs = resolveInsideRepo(repoRoot, doc);
      cache.set(doc, abs && existsSync(abs) ? scanMarkers(await readFile(abs, "utf8")) : null);
    }
    return cache.get(doc) ?? null;
  };
}

/** The part of a marker needed to classify it and show its claim; DocMarker and the doc index both have it. */
export type MarkerView = Pick<DocMarker, "id" | "target" | "line" | "claimExcerpt" | "problem">;

/**
 * Markers in `docs` that no anchor in `lockfile` backs: no `id=` yet, an id that matches no anchor, an
 * id that belongs to the marker in another doc (a copy-paste), or one used twice in a doc. Until
 * `lockwire link` runs, such a claim isn't being checked at all.
 */
export async function findUnlinkedMarkers(
  lockfile: Lockfile,
  docs: readonly string[],
  readMarkers: (doc: string) => Promise<readonly MarkerView[] | null>,
  /** When given, a marker whose target file is missing says so instead of "not linked yet". */
  repoRoot?: string,
): Promise<UnlinkedMarker[]> {
  const unlinked: UnlinkedMarker[] = [];
  for (const doc of [...docs].sort()) {
    const markers = await readMarkers(doc);
    if (!markers) continue;
    const seenIds = new Set<string>();
    for (const m of markers) {
      let reason: string | null = null;
      const anchor = m.id ? lockfile.anchors.find((a) => a.id === m.id) : undefined;
      if (!m.id && m.problem) reason = `not linked: ${m.problem}`;
      else if (!m.id) {
        const abs = repoRoot ? resolveInsideRepo(repoRoot, m.target.path) : undefined;
        // `link` can't fix a marker that points nowhere: say what's wrong with it instead.
        reason =
          abs === null
            ? `${m.target.path} is outside the repository`
            : abs !== undefined && !existsSync(abs)
              ? `not linked: ${m.target.path} doesn't exist`
              : "not linked yet";
      } else if (!anchor) reason = `id ${m.id} matches no anchor`;
      else if (seenIds.has(m.id)) reason = `id ${m.id} appears twice in this doc`;
      else if (anchor.doc && anchor.doc !== doc) {
        const stillThere = (await readMarkers(anchor.doc))?.some((x) => x.id === m.id);
        if (stillThere) reason = `id ${m.id} belongs to the marker in ${anchor.doc}`;
      }
      if (m.id) seenIds.add(m.id);
      if (reason)
        unlinked.push({
          doc,
          line: m.line,
          target: `${m.target.path}${m.target.symbol ? `#${m.target.symbol}` : ""}`,
          reason,
          excerpt: m.claimExcerpt,
        });
    }
  }
  return unlinked;
}

const claimsAbout = (u: UnlinkedMarker, path: string, symbol?: string) =>
  symbol ? u.target === `${path}#${symbol}` : u.target === path || u.target.startsWith(`${path}#`);

/**
 * A holder a long-lived caller keeps between calls so the doc index lives in memory and each call
 * only re-validates it.
 */
export interface IndexSession {
  state?: IndexState;
}

/**
 * Claims written in the docs about this file (or symbol) that no anchor backs. Read-only: it never
 * writes the on-disk doc index (the MCP tool built on this is annotated read-only). It will read one
 * that exists, and with a `session` it keeps the index in memory across calls.
 */
export async function unlinkedFor(
  repoRoot: string,
  config: LockwireConfig,
  path: string,
  symbol?: string,
  session?: IndexSession,
  onStats?: (stats: IndexStats) => void,
): Promise<UnlinkedMarker[]> {
  const result = await unlinkedForWithin(repoRoot, config, path, symbol, Number.POSITIVE_INFINITY, {
    persist: false,
    ...(session?.state ? { prior: session.state } : {}),
  });
  if (session) session.state = result.state;
  onStats?.(result.index);
  return result.claims;
}

/**
 * {@link unlinkedFor} for callers on a latency budget (the PreToolUse hook), backed by the doc index
 * (see docindex.ts) so it doesn't walk the tree or read every doc each time. `complete` is false when
 * the budget ran out first, in which case `claims` is what was found so far.
 */
export async function unlinkedForWithin(
  repoRoot: string,
  config: LockwireConfig,
  path: string,
  symbol: string | undefined,
  budgetMs: number,
  opts: { persist?: boolean; prior?: IndexState } = {},
): Promise<{
  claims: UnlinkedMarker[];
  complete: boolean;
  index: IndexStats;
  state: IndexState;
}> {
  const lockfile = await readLockfile(repoRoot);
  const index = await loadDocIndex(repoRoot, config, { budgetMs, ...opts });
  const direct = markerReader(repoRoot);
  // Docs the config doesn't select (an anchor can live in one) aren't indexed: read those directly.
  const readMarkers = async (doc: string): Promise<readonly MarkerView[] | null> =>
    index.markersOf(doc) ?? direct(doc);
  const relevant = index.docs.filter((d) =>
    index
      .markersOf(d)
      ?.some((m) => m.target.path === path && (!symbol || m.target.symbol === symbol)),
  );
  const all = await findUnlinkedMarkers(lockfile, relevant, readMarkers);
  return {
    claims: all.filter((u) => claimsAbout(u, path, symbol)),
    complete: index.complete,
    index: index.stats,
    state: index.state,
  };
}

/** Whether `path` is one of `scope`, or inside one of them that is a directory (`docs` or `docs/`). */
export function inPathScope(path: string, scope: readonly string[]): boolean {
  return scope.some((p) => {
    const dir = p.replace(/\/+$/, "");
    return (
      path === p ||
      path === dir ||
      (dir !== "" && path.startsWith(`${dir}/`)) ||
      dir === "" ||
      dir === "."
    );
  });
}

/** The docs a scoped run looks at: listed docs, plus the selected docs inside any listed directory. */
async function docsInScope(
  repoRoot: string,
  config: LockwireConfig,
  scope: readonly string[],
): Promise<string[]> {
  const out = new Set(scope.filter((p) => isScannedDoc(p, config)));
  const dirs = scope.filter((p) => {
    if (p.endsWith("/") || p === "" || p === ".") return true;
    const abs = resolveInsideRepo(repoRoot, p);
    try {
      return abs !== null && statSync(abs).isDirectory();
    } catch {
      return false;
    }
  });
  if (dirs.length > 0)
    for (const doc of await discoverDocs(repoRoot, config))
      if (inPathScope(doc, dirs)) out.add(doc);
  return [...out];
}

export async function check(
  repoRoot: string,
  config: LockwireConfig,
  onlyPaths?: readonly string[],
  opts: {
    write?: boolean;
    actor?: Actor;
    /**
     * How long the search for moved symbols may take, in ms, from when it is first needed (it reads
     * every source file once). 0 turns it off. Unlimited by default; hooks pass a budget.
     */
    moveSearchMs?: number;
  } = {},
): Promise<CheckResult> {
  // `write: false` is a dry run: same results, but nothing is persisted (CI and pre-commit gates
  // shouldn't dirty the working tree or append to the ledger).
  const write = opts.write !== false;
  // Who ran the check that noticed: the AI tool for a hook right after its edit, the person or CI job
  // for the CLI. `unknown` only when a caller doesn't say.
  const checkActor: Actor = opts.actor ?? { type: "unknown" };
  let commit: string | null | undefined; // resolved once per check, and only if something is recorded
  const emit = (record: Parameters<typeof appendEvent>[1]) => {
    if (!write) return Promise.resolve(null);
    commit ??= headCommit(repoRoot);
    return appendEvent(repoRoot, { ...record, commit });
  };
  const lockfile = await readLockfile(repoRoot);
  const now = new Date().toISOString();
  const results: AnchorCheckResult[] = [];
  let current = lockfile;
  let relocatedCount = 0;
  const markersIn = markerReader(repoRoot);
  const moveSearchMs = opts.moveSearchMs ?? Number.POSITIVE_INFINITY;
  const boundTargets = new Set(
    lockfile.anchors.flatMap((a) =>
      a.target.symbol && a.status !== "superseded" ? [`${a.target.path}#${a.target.symbol}`] : [],
    ),
  );
  let sources: SourceIndex | undefined;
  /** Where an anchor's code as stamped lives now, if it moved to another file. */
  const movedOf = async (a: Anchor): Promise<{ moved?: MoveHint }> => {
    if (!a.target.symbol || moveSearchMs <= 0) return {};
    sources ??= new SourceIndex(
      repoRoot,
      config,
      (path, content, version) => symbolsOfSource(path, content, config, version),
      Date.now() + moveSearchMs,
    );
    const hint = await sources.findMove(a, versionOf(a), boundTargets);
    return hint ? { moved: hint } : {};
  };

  for (const stored of lockfile.anchors) {
    let anchor = stored;
    const inScope =
      !onlyPaths ||
      inPathScope(anchor.target.path, onlyPaths) ||
      (anchor.doc !== null && inPathScope(anchor.doc, onlyPaths));
    // A newer lockwire stamped it: checking it the way this one reads would report drift that isn't there.
    const tooNew = unreadableReason(anchor);
    if (!inScope || tooNew) {
      results.push({
        anchor,
        status: anchor.status,
        driftedTiers: [],
        skipped: true,
        ...(tooNew ? { unreadable: tooNew } : {}),
        singleHashWouldFlag: false,
      });
      continue;
    }

    if (anchor.status === "waived" && anchor.waiver) {
      // Fail closed: an expiry that doesn't parse (hand-edited lock, older version) counts as expired.
      const expiresAt = Date.parse(anchor.waiver.expires);
      if (Number.isNaN(expiresAt) || expiresAt < Date.parse(now)) {
        await emit({
          ts: now,
          event: "waiver.expired",
          anchor: anchor.id,
          actor: checkActor,
          commit: null,
        });
        // A lapsed waiver just stops suppressing: re-evaluate the anchor from the code like any other,
        // so it's drifted only if something actually moved while it was waived.
        anchor = { ...anchor, status: "fresh", waiver: null };
        current = upsertAnchor(current, anchor);
      } else {
        results.push({ anchor, status: "waived", driftedTiers: [], singleHashWouldFlag: false });
        continue;
      }
    }

    if (anchor.status === "superseded") {
      results.push({ anchor, status: "superseded", driftedTiers: [], singleHashWouldFlag: false });
      continue;
    }

    // The other half of the binding: has the sentence itself been rewritten, or its marker removed?
    let claimChanged = false;
    let claimText: string | undefined;
    if (anchor.doc && anchor.claim) {
      const marker = (await markersIn(anchor.doc))?.find((m) => m.id === anchor.id);
      if (!marker) {
        const orphaned: Anchor = { ...anchor, status: "orphaned" };
        if (anchor.status !== "orphaned") {
          current = upsertAnchor(current, orphaned);
          await emit({
            ts: now,
            event: "anchor.orphaned",
            anchor: anchor.id,
            actor: checkActor,
            commit: null,
            note: "claim marker removed from doc",
          });
        }
        results.push({
          anchor: orphaned,
          status: "orphaned",
          driftedTiers: [],
          claimChanged: true,
          singleHashWouldFlag: true,
        });
        continue;
      }
      claimChanged = !claimUnchanged(anchor.claim, marker);
      claimText = marker.claimText;
      // A claim stamped before `normHash` existed can only be compared by raw text. Now that we've
      // just confirmed it's unchanged, record the whitespace-insensitive hash so a later re-wrap
      // (a formatter pass) can't flag it.
      if (!claimChanged && !anchor.claim.normHash) {
        anchor = { ...anchor, claim: { ...anchor.claim, normHash: marker.claimNormHash } };
        current = upsertAnchor(current, anchor);
      }
    }

    let resolved: TargetResolution | null;
    let unresolvedNote = "file not found";
    let unreadable = false;
    try {
      resolved = await resolveTarget(repoRoot, anchor.target, config, versionOf(anchor));
    } catch (err) {
      resolved = null;
      unreadable = true;
      unresolvedNote = err instanceof Error ? err.message : String(err);
    }

    if (!resolved) {
      const orphaned: Anchor = { ...anchor, status: "orphaned" };
      if (anchor.status !== "orphaned") {
        current = upsertAnchor(current, orphaned);
        await emit({
          ts: now,
          event: "anchor.orphaned",
          anchor: anchor.id,
          actor: checkActor,
          commit: null,
          note: unresolvedNote,
        });
      }
      results.push({
        anchor: orphaned,
        status: "orphaned",
        driftedTiers: [],
        ...(unreadable ? {} : await movedOf(anchor)),
        singleHashWouldFlag: true,
      });
      continue;
    }

    if (!resolved.found && anchor.target.symbol) {
      const relocatedTo = resolved.symbols
        ? findRelocationCandidate(
            resolved.symbols,
            anchor.fingerprints.sig,
            anchor.target.symbol.slice(anchor.target.symbol.lastIndexOf(".") + 1),
            new Set(
              lockfile.anchors
                .filter((a) => a.id !== anchor.id && a.target.path === anchor.target.path)
                .flatMap((a) => (a.target.symbol ? [a.target.symbol] : [])),
            ),
            anchor.fingerprints,
          )
        : null;
      const reResolved = relocatedTo
        ? await resolveTarget(
            repoRoot,
            { path: anchor.target.path, symbol: relocatedTo },
            config,
            versionOf(anchor),
          )
        : null;
      // A candidate that matched only on the calls it makes (the body differs) is a guess: if the
      // symbol's code as stamped lives in another file, that is where the claim went.
      const keptBody =
        reResolved && tierFingerprint(reResolved.fingerprints, "body") === anchor.fingerprints.body;
      const movedElsewhere = relocatedTo && !keptBody ? await movedOf(anchor) : {};
      if (relocatedTo && !movedElsewhere.moved?.to) {
        const target = { path: anchor.target.path, symbol: relocatedTo };
        // A rename must not launder other changes: `sig` is expected to differ (it carries the
        // name, and the candidate already matched on it), but any other bound tier that moved is
        // real drift. Re-stamp only `sig` in that case so the drift stays visible on later checks.
        const movedTiers = reResolved
          ? anchor.tiers.filter(
              (t) =>
                t !== "sig" &&
                tierFingerprint(reResolved.fingerprints, t) !==
                  tierFingerprint(anchor.fingerprints, t),
            )
          : [];
        const relocated: Anchor =
          movedTiers.length > 0 && reResolved
            ? {
                ...anchor,
                target,
                fingerprints: { ...anchor.fingerprints, sig: reResolved.fingerprints.sig },
                status: "drifted",
              }
            : {
                ...anchor,
                target,
                fingerprints: reResolved?.fingerprints ?? anchor.fingerprints,
                status: "fresh",
              };
        relocatedCount++;
        current = upsertAnchor(current, relocated);
        await emit({
          ts: now,
          event: "anchor.relocated",
          anchor: anchor.id,
          actor: checkActor,
          commit: null,
          note: `${anchor.target.symbol} -> ${relocatedTo}`,
        });
        for (const tier of movedTiers) {
          await emit({
            ts: now,
            event: "anchor.drifted",
            anchor: anchor.id,
            actor: checkActor,
            commit: null,
            tier,
            from: tierFingerprint(anchor.fingerprints, tier),
            to: reResolved ? tierFingerprint(reResolved.fingerprints, tier) : "",
          });
        }
        results.push({
          anchor: relocated,
          status: relocated.status,
          driftedTiers: movedTiers,
          singleHashWouldFlag: true,
        });
      } else {
        const orphaned: Anchor = { ...anchor, status: "orphaned" };
        if (anchor.status !== "orphaned") {
          current = upsertAnchor(current, orphaned);
          await emit({
            ts: now,
            event: "anchor.orphaned",
            anchor: anchor.id,
            actor: checkActor,
            commit: null,
            note: "symbol not found",
          });
        }
        const moved = await movedOf(anchor);
        const sameSignature =
          !moved.moved?.to && resolved.symbols
            ? findRelocationCandidate(
                resolved.symbols,
                anchor.fingerprints.sig,
                anchor.target.symbol.slice(anchor.target.symbol.lastIndexOf(".") + 1),
                new Set(
                  lockfile.anchors
                    .filter((a) => a.id !== anchor.id && a.target.path === anchor.target.path)
                    .flatMap((a) => (a.target.symbol ? [a.target.symbol] : [])),
                ),
              )
            : null;
        results.push({
          anchor: orphaned,
          status: "orphaned",
          driftedTiers: [],
          ...moved,
          ...(sameSignature
            ? { similar: { path: anchor.target.path, symbol: sameSignature } }
            : {}),
          singleHashWouldFlag: true,
        });
      }
      continue;
    }

    const definedAt = resolved.definedAt ? { definedAt: resolved.definedAt } : {};
    const nowFingerprints = resolved.fingerprints;
    const moved = (t: Tier) =>
      tierFingerprint(nowFingerprints, t) !== tierFingerprint(anchor.fingerprints, t);
    let driftedTiers = anchor.tiers.filter(moved);
    const anyTierChanged = ALL_TIERS.filter(moved);

    // A value anchor can be checked for truth: does the sentence still state the value? If it does
    // (the value moved within the precision the sentence shows), the claim holds and that isn't drift;
    // if it doesn't, the claim is wrong now, whatever the fingerprint says.
    let valueReport: AnchorCheckResult["value"];
    let valueHolds = false;
    if (anchor.tiers.includes("value") && resolved.value) {
      const verdict =
        claimText === undefined ? undefined : checkClaimAgainstValue(claimText, resolved.value.raw);
      const was = anchor.value === undefined ? {} : { was: anchor.value };
      if (verdict?.checkable && verdict.matches) {
        valueHolds = true;
        driftedTiers = driftedTiers.filter((t) => t !== "value");
      } else if (verdict?.checkable || driftedTiers.includes("value")) {
        valueReport = {
          ...was,
          now: resolved.value.display,
          claimed: verdict?.claimed ?? [],
          matches: !verdict?.checkable,
        };
      }
    }
    const valueMismatch = valueReport !== undefined && !valueReport.matches;
    const unchangedForThisClaim = anyTierChanged.every((t) => t === "value" && valueHolds);

    if (driftedTiers.length > 0 || claimChanged || valueMismatch) {
      const drifted: Anchor = { ...anchor, status: "drifted" };
      if (anchor.status !== "drifted") {
        current = upsertAnchor(current, drifted);
        for (const tier of driftedTiers) {
          await emit({
            ts: now,
            event: "anchor.drifted",
            anchor: anchor.id,
            actor: checkActor,
            commit: null,
            tier,
            from: tierFingerprint(anchor.fingerprints, tier),
            to: tierFingerprint(resolved.fingerprints, tier),
            ...(tier === "value" && valueReport
              ? { note: `${valueReport.was ?? "?"} -> ${valueReport.now}` }
              : {}),
          });
        }
        if (valueMismatch && !driftedTiers.includes("value") && !claimChanged) {
          await emit({
            ts: now,
            event: "anchor.drifted",
            anchor: anchor.id,
            actor: checkActor,
            commit: null,
            note: `claim states ${valueReport?.claimed.join(", ")} but the value is ${valueReport?.now}`,
          });
        }
        if (claimChanged) {
          await emit({
            ts: now,
            event: "anchor.drifted",
            anchor: anchor.id,
            actor: checkActor,
            commit: null,
            note: "claim text changed",
          });
        }
      }
      // The code here changed: maybe it was moved out, unchanged, and something else left in its place
      // (a wrapper kept for compatibility).
      const movedOut = anyTierChanged.includes("body") ? await movedOf(anchor) : {};
      results.push({
        anchor: drifted,
        status: "drifted",
        driftedTiers,
        ...(claimChanged ? { claimChanged } : {}),
        ...(valueReport ? { value: valueReport } : {}),
        ...movedOut,
        ...definedAt,
        singleHashWouldFlag: anyTierChanged.length > 0,
      });
    } else {
      // Stamped by an older fingerprint version and nothing has moved since: re-stamp it the current way
      // so later checks see what the current version sees (types in `sig`, every overload, ...). Nothing
      // about the claim changed, so this records no event. If the target doesn't resolve the current way
      // (a version-1 path a newer version spells differently), it keeps its old fingerprints.
      if (versionOf(anchor) !== FINGERPRINT_VERSION && anyTierChanged.length === 0) {
        const upgraded = await resolveTarget(repoRoot, anchor.target, config).catch(() => null);
        if (upgraded?.found) {
          anchor = {
            ...anchor,
            fingerprints: upgraded.fingerprints,
            fingerprintVersion: FINGERPRINT_VERSION,
          };
          current = upsertAnchor(current, anchor);
        }
      }
      if (anchor.status === "drifted" && unchangedForThisClaim) {
        const resolvedAnchor: Anchor = { ...anchor, status: "fresh" };
        current = upsertAnchor(current, resolvedAnchor);
        await emit({
          ts: now,
          event: "anchor.resolved",
          anchor: anchor.id,
          actor: checkActor,
          commit: null,
        });
        results.push({
          anchor: resolvedAnchor,
          status: "fresh",
          driftedTiers: [],
          ...definedAt,
          singleHashWouldFlag: false,
        });
      } else {
        results.push({
          anchor,
          status: anchor.status,
          driftedTiers: [],
          ...definedAt,
          singleHashWouldFlag: anyTierChanged.length > 0,
        });
      }
    }
  }

  // Don't conjure an empty lockwire.lock in a directory that never had one (e.g. an MCP server
  // rooted at a parent folder of the real repo).
  if (write && (lockfile.anchors.length > 0 || existsSync(lockfilePath(repoRoot))))
    await writeLockfile(repoRoot, current);

  // Claims from different places can't all have moved to the same one: identical code in two files
  // (a copy, a twin that was already there) would otherwise make each look like the other's move.
  // None gets a new home then; the places stay listed so a person can choose.
  const origins = new Map<string, Set<string>>();
  for (const r of results) {
    const to = r.moved?.to;
    if (!to || !r.anchor.target.symbol) continue;
    const key = `${to.path}#${to.symbol}`;
    const from = `${r.anchor.target.path}#${r.anchor.target.symbol}`;
    origins.set(key, (origins.get(key) ?? new Set()).add(from));
  }
  for (const r of results) {
    const to = r.moved?.to;
    if (r.moved && to && (origins.get(`${to.path}#${to.symbol}`)?.size ?? 0) > 1)
      r.moved = { candidates: r.moved.candidates };
  }

  // Anchors outside a scoped run weren't examined: they stay in `results` (callers like the hooks
  // look anchors up there) but must not count towards the summary or the exit code.
  const examined = results.filter((r) => !r.skipped);
  // The other thing a claim can be: not bound at all (see findUnlinkedMarkers). Scoped runs (hooks,
  // --changed) only look at docs in scope and never walk the tree.
  const docsToScan = onlyPaths
    ? await docsInScope(repoRoot, config, onlyPaths)
    : await discoverDocs(repoRoot, config);
  const unlinked = await findUnlinkedMarkers(lockfile, docsToScan, markersIn, repoRoot);

  const singleHashWouldFlag = examined.filter((r) => r.singleHashWouldFlag).length;
  // The noise comparison is about code fingerprints; a claim-only flag has no single-hash counterpart.
  const tieredFlagged = examined.filter(
    (r) =>
      (r.status === "drifted" || r.status === "orphaned") &&
      !(r.claimChanged && r.driftedTiers.length === 0),
  ).length;
  const reductionPercent =
    singleHashWouldFlag === 0
      ? 0
      : Math.round(((singleHashWouldFlag - tieredFlagged) / singleHashWouldFlag) * 1000) / 10;

  const summary: CheckSummary = {
    anchors: examined.length,
    fresh: examined.filter((r) => r.status === "fresh").length,
    drifted: examined.filter((r) => r.status === "drifted").length,
    relocated: relocatedCount,
    orphaned: examined.filter((r) => r.status === "orphaned").length,
    waived: examined.filter((r) => r.status === "waived").length,
    superseded: examined.filter((r) => r.status === "superseded").length,
    moved: examined.filter((r) => r.moved?.to).length,
    unlinked: unlinked.length,
    noise: { singleHashWouldFlag, tieredFlagged, reductionPercent },
  };

  return { summary, results, unlinked };
}

/**
 * Docs the config selects. A symlinked doc is skipped: it's another name for a file the walk reaches
 * anyway (`README.md -> packages/zod/README.md`), and linking both would bind every claim twice.
 */
export async function discoverDocs(repoRoot: string, config: LockwireConfig): Promise<string[]> {
  return walkFiles(repoRoot, config.exclude, { skipSymlinks: true }).filter((p) =>
    matchesAny(p, config.docs),
  );
}

export async function ack(
  repoRoot: string,
  anchorId: string,
  resolution: "updated" | "superseded" | "false-positive",
  note: string | undefined,
  actor: Actor,
  config: LockwireConfig,
): Promise<Anchor> {
  const lockfile = await readLockfile(repoRoot);
  const anchor = lockfile.anchors.find((a) => a.id === anchorId);
  if (!anchor) throw new Error(`no anchor ${anchorId}`);
  const tooNew = unreadableReason(anchor);
  if (tooNew && resolution !== "superseded")
    throw new Error(
      `${anchorId} was stamped by a newer lockwire (${tooNew}): update this lockwire to acknowledge it`,
    );

  let updated: Anchor = anchor;
  if (resolution === "superseded") {
    updated = { ...anchor, status: "superseded" };
  } else {
    let resolved: TargetResolution | null = null;
    try {
      resolved = await resolveTarget(repoRoot, anchor.target, config);
    } catch {
      // handled below, same as a target that isn't there
    }
    if (!resolved?.found)
      throw new Error(
        `can't mark ${anchorId} ${resolution}: ${anchor.target.path}${anchor.target.symbol ? `#${anchor.target.symbol}` : ""} no longer exists. Use --resolution superseded, or \`lockwire unlink ${anchorId}\`.`,
      );

    // Acknowledging also accepts the claim as it reads now, so an expected claim edit stops being flagged.
    let claim = anchor.claim;
    const docAbs = anchor.doc ? resolveInsideRepo(repoRoot, anchor.doc) : null;
    if (anchor.doc && anchor.claim && docAbs && existsSync(docAbs)) {
      const marker = scanMarkers(await readFile(docAbs, "utf8")).find((m) => m.id === anchor.id);
      if (marker)
        claim = {
          line: marker.claimLine,
          hash: marker.claimHash,
          normHash: marker.claimNormHash,
          excerpt: marker.claimExcerpt,
        };
    }
    updated = {
      ...anchor,
      status: "fresh",
      fingerprints: resolved.fingerprints,
      fingerprintVersion: FINGERPRINT_VERSION,
      claim,
      ...(resolved.value ? { value: resolved.value.display } : {}),
    };
  }

  await writeLockfile(repoRoot, upsertAnchor(lockfile, updated));
  await appendEvent(repoRoot, {
    ts: new Date().toISOString(),
    event: "anchor.acknowledged",
    anchor: anchorId,
    actor,
    commit: null,
    note: note ?? resolution,
  });
  return updated;
}

export interface RepointOutcome {
  id: string;
  doc: string | null;
  from: AnchorTarget;
  to: AnchorTarget;
  /**
   * `fresh` when the code at the new place is the code as stamped; `drifted` when a bound tier differs
   * there, in which case that tier keeps its stamped fingerprint so `check` goes on showing the drift.
   */
  status: Anchor["status"];
  driftedTiers: Tier[];
  /** The doc's marker was rewritten to name the new place. */
  markerUpdated: boolean;
  /** The claim sentence itself names the old file, so its wording needs the same edit. */
  claimNamesOldPath: boolean;
}

export interface RepointResult {
  repointed: RepointOutcome[];
  skipped: { id: string; target: string; reason: string }[];
}

const targetLabel = (t: { path: string; symbol?: string }) =>
  `${t.path}${t.symbol ? `#${t.symbol}` : ""}`;

/**
 * `lockwire repoint`: move claims whose code moved to another file over to its new home, rewriting
 * each doc marker to match. With no `to`, the new home is where `check` found the symbol's code as
 * stamped (only when there is exactly one such place); `ids` limits it to those anchors. With `to`
 * (and one id), it is that target, for a move lockwire couldn't place on its own.
 *
 * The path changes by definition, and so may `export` on the signature (a helper moved into a module
 * of its own is usually exported now). Any other bound tier that differs at the new place is drift and
 * stays drift, unless `reviewed` says a person checked the claim against the code there.
 */
export async function repoint(
  repoRoot: string,
  config: LockwireConfig,
  actor: Actor,
  opts: { ids?: readonly string[]; to?: AnchorTarget; reviewed?: boolean; dryRun?: boolean } = {},
): Promise<RepointResult> {
  if (opts.to && opts.ids?.length !== 1)
    throw new Error("--to names one new home: pass exactly one anchor id with it");
  const lockfile = await readLockfile(repoRoot);
  const result: RepointResult = { repointed: [], skipped: [] };
  const byId = new Map(lockfile.anchors.map((a) => [a.id, a]));
  for (const id of opts.ids ?? [])
    if (!byId.has(id)) result.skipped.push({ id, target: "-", reason: `no anchor ${id}` });

  const plan: { anchor: Anchor; to: AnchorTarget }[] = [];
  const wanted = opts.ids ? opts.ids.filter((id) => byId.has(id)) : null;
  const only = wanted?.[0] ? byId.get(wanted[0]) : undefined;
  if (opts.to && only) plan.push({ anchor: only, to: opts.to });
  else if (!opts.to && (!wanted || wanted.length > 0)) {
    const scope = wanted
      ? [
          ...new Set(
            wanted.flatMap((id) => {
              const a = byId.get(id);
              return a ? [a.target.path, ...(a.doc ? [a.doc] : [])] : [];
            }),
          ),
        ]
      : undefined;
    const checked = await check(repoRoot, config, scope, { write: false });
    for (const r of checked.results) {
      if (r.skipped || (wanted && !wanted.includes(r.anchor.id))) continue;
      const stored = byId.get(r.anchor.id);
      if (!stored) continue;
      if (r.moved?.to) {
        plan.push({ anchor: stored, to: r.moved.to });
        continue;
      }
      if (!wanted) continue;
      result.skipped.push({
        id: stored.id,
        target: targetLabel(stored.target),
        reason: r.moved?.candidates.length
          ? `its code is in ${r.moved.candidates.length} places (${r.moved.candidates.map(targetLabel).join(", ")}): pass --to <path#symbol> to choose`
          : r.status === "waived"
            ? "waived: check doesn't look for its code until the waiver expires; pass --to <path#symbol> to re-point it now"
            : r.status === "fresh"
              ? "nothing to re-point: it still resolves where it is"
              : stored.target.symbol
                ? "no other file has its code as stamped: if it moved and changed, pass --to <path#symbol>"
                : "lockwire only finds moved symbols: pass --to <path> for a file that moved",
      });
    }
  }

  let current = lockfile;
  const now = new Date().toISOString();
  const markerEdits = new Map<string, { id: string; to: AnchorTarget }[]>();
  const outcomes: RepointOutcome[] = [];
  for (const { anchor, to } of plan) {
    const skip = (reason: string) =>
      result.skipped.push({ id: anchor.id, target: targetLabel(anchor.target), reason });
    if (anchor.status === "superseded") {
      skip("superseded: its claim no longer applies, so there is nothing to re-point");
      continue;
    }
    const tooNew = unreadableReason(anchor);
    if (tooNew) {
      skip(`stamped by a newer lockwire (${tooNew}): update this lockwire to re-point it`);
      continue;
    }
    if (to.path === anchor.target.path && to.symbol === anchor.target.symbol) {
      skip(`already points at ${targetLabel(to)}`);
      continue;
    }
    if (Boolean(to.symbol) !== Boolean(anchor.target.symbol)) {
      skip(
        anchor.target.symbol
          ? `a claim about a symbol re-points to a symbol: use ${to.path}#<symbol>`
          : "a claim about a whole file re-points to a file, not a symbol",
      );
      continue;
    }
    const tierProblem = inapplicableTiersReason(to, anchor.tiers);
    if (tierProblem) {
      skip(tierProblem);
      continue;
    }
    let there: TargetResolution | null = null;
    try {
      there = await resolveTarget(repoRoot, to, config, versionOf(anchor));
    } catch (err) {
      skip(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!there?.found) {
      skip(`${targetLabel(to)} not found`);
      continue;
    }

    // `sig` carries the symbol's name and `export`: compare it as the old name would read, either way.
    const def = to.symbol
      ? there.symbols?.bySymbolPath.get(there.definedAt?.symbol ?? to.symbol)
      : undefined;
    const oldName = (anchor.target.symbol ?? "").slice(
      (anchor.target.symbol ?? "").lastIndexOf(".") + 1,
    );
    const sigMatches = def
      ? sigFingerprints(def.sigFor?.(oldName) ?? def.sigTokens).has(anchor.fingerprints.sig)
      : there.fingerprints.sig === anchor.fingerprints.sig;
    const driftedTiers = anchor.tiers.filter((t) =>
      t === "path"
        ? false
        : t === "sig"
          ? !sigMatches
          : tierFingerprint(there.fingerprints, t) !== tierFingerprint(anchor.fingerprints, t),
    );

    let fingerprints: Fingerprints = there.fingerprints;
    let fingerprintVersion = versionOf(anchor);
    let status: Anchor["status"] = anchor.status === "waived" ? "waived" : "fresh";
    if (opts.reviewed && driftedTiers.length > 0) {
      const restamp = await resolveTarget(repoRoot, to, config).catch(() => null);
      if (restamp?.found) {
        fingerprints = restamp.fingerprints;
        fingerprintVersion = FINGERPRINT_VERSION;
      }
    } else if (driftedTiers.length > 0) {
      fingerprints = { ...there.fingerprints };
      for (const t of driftedTiers) fingerprints[t] = tierFingerprint(anchor.fingerprints, t);
      if (status !== "waived") status = "drifted";
    }
    const updated: Anchor = {
      ...anchor,
      target: to,
      fingerprints,
      fingerprintVersion,
      status,
      ...(there.value ? { value: there.value.display } : {}),
    };
    current = upsertAnchor(current, updated);
    if (anchor.doc && anchor.claim) {
      const list = markerEdits.get(anchor.doc) ?? [];
      list.push({ id: anchor.id, to });
      markerEdits.set(anchor.doc, list);
    }
    outcomes.push({
      id: anchor.id,
      doc: anchor.doc,
      from: anchor.target,
      to,
      status,
      driftedTiers: opts.reviewed ? [] : driftedTiers,
      markerUpdated: false,
      claimNamesOldPath: false,
    });
  }

  // Each doc is read and written once, however many of its markers moved.
  for (const [doc, edits] of markerEdits) {
    const abs = resolveInsideRepo(repoRoot, doc);
    if (!abs || !existsSync(abs)) continue;
    const text = await readFile(abs, "utf8");
    const markers = scanMarkers(text);
    const parts = text.split(/(\r?\n)/);
    let changed = false;
    for (const edit of edits) {
      const marker = markers.find((m) => m.id === edit.id);
      const outcome = outcomes.find((o) => o.id === edit.id);
      if (!marker || !outcome) continue;
      const idx = (marker.line - 1) * 2;
      const line = parts[idx];
      if (line === undefined) continue;
      parts[idx] = retargetMarkerLine(line, edit.to);
      changed = true;
      outcome.markerUpdated = true;
      outcome.claimNamesOldPath = marker.claimText.includes(outcome.from.path);
    }
    if (changed && !opts.dryRun) await writeFileAtomic(abs, parts.join(""));
  }

  if (!opts.dryRun && outcomes.length > 0) {
    await writeLockfile(repoRoot, current);
    const commit = headCommit(repoRoot);
    for (const o of outcomes) {
      await appendEvent(repoRoot, {
        ts: now,
        event: "anchor.relocated",
        anchor: o.id,
        actor,
        commit,
        note: `${targetLabel(o.from)} -> ${targetLabel(o.to)} (moved; re-pointed${opts.reviewed ? ", reviewed" : ""})`,
      });
      const stored = byId.get(o.id);
      for (const tier of o.driftedTiers)
        await appendEvent(repoRoot, {
          ts: now,
          event: "anchor.drifted",
          anchor: o.id,
          actor,
          commit,
          tier,
          from: stored ? tierFingerprint(stored.fingerprints, tier) : "",
          note: `differs at ${targetLabel(o.to)}`,
        });
    }
  }
  result.repointed = outcomes;
  return result;
}

export async function waive(
  repoRoot: string,
  anchorId: string,
  reason: string,
  expires: string,
  actor: Actor,
): Promise<Anchor> {
  const expiresAt = Date.parse(expires);
  // Date.parse rolls an impossible day over (2027-02-31 is March 3rd); a waiver must say what it means.
  const [y, m, d] = (/^(\d{4})-(\d{2})-(\d{2})/.exec(expires) ?? []).slice(1).map(Number);
  const realDay =
    y !== undefined &&
    m !== undefined &&
    d !== undefined &&
    new Date(Date.UTC(y, m - 1, d)).toISOString().startsWith(expires.slice(0, 10));
  if (!realDay || Number.isNaN(expiresAt))
    throw new Error(
      `invalid --expires "${expires}": use an ISO date such as 2026-12-31 (waivers must expire)`,
    );
  if (expiresAt <= Date.now()) throw new Error(`--expires "${expires}" is already in the past`);
  const lockfile = await readLockfile(repoRoot);
  const anchor = lockfile.anchors.find((a) => a.id === anchorId);
  if (!anchor) throw new Error(`no anchor ${anchorId}`);
  const updated: Anchor = {
    ...anchor,
    status: "waived",
    waiver: { reason, expires: new Date(expiresAt).toISOString(), by: actor },
  };
  await writeLockfile(repoRoot, upsertAnchor(lockfile, updated));
  await appendEvent(repoRoot, {
    ts: new Date().toISOString(),
    event: "waiver.granted",
    anchor: anchorId,
    actor,
    commit: null,
    note: reason,
  });
  return updated;
}

export async function unlink(repoRoot: string, anchorId: string): Promise<void> {
  const lockfile = await readLockfile(repoRoot);
  await writeLockfile(repoRoot, removeAnchor(lockfile, anchorId));
}

export async function refs(repoRoot: string, path: string, symbol?: string): Promise<Anchor[]> {
  const lockfile = await readLockfile(repoRoot);
  return anchorsForPath(lockfile, path).filter((a) => !symbol || a.target.symbol === symbol);
}

export async function status(repoRoot: string, scope?: string): Promise<Anchor[]> {
  const lockfile = await readLockfile(repoRoot);
  if (!scope) return lockfile.anchors;
  const re = globToRegExp(scope);
  return lockfile.anchors.filter((a) => re.test(a.target.path) || (a.doc && re.test(a.doc)));
}

export async function history(repoRoot: string, ref: string) {
  const lockfile = await readLockfile(repoRoot);
  const records = await readLedger(repoRoot);

  const byId = lockfile.anchors.find((a) => a.id === ref);
  if (byId) return { anchors: [byId], events: historyFor(records, byId.id) };

  if (ref.includes("#") || !ref.endsWith(".md")) {
    const [path, symbol] = ref.split("#");
    const matches = lockfile.anchors.filter(
      (a) => a.target.path === path && (!symbol || a.target.symbol === symbol),
    );
    const events = matches.flatMap((a) => historyFor(records, a.id));
    return { anchors: matches, events: events.sort((a, b) => a.ts.localeCompare(b.ts)) };
  }

  const matches = lockfile.anchors.filter((a) => a.doc === ref);
  const events = matches.flatMap((a) => historyFor(records, a.id));
  return { anchors: matches, events: events.sort((a, b) => a.ts.localeCompare(b.ts)) };
}
