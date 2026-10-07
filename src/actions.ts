import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { headCommit } from "./changed.js";
import { type IndexStats, loadDocIndex } from "./docindex.js";
import { computeWholeFileTiers, extractFileSymbols, fileExportsFingerprint } from "./extract.js";
import { langForPath, parserFor } from "./grammar.js";
import { fingerprint, fingerprintSet } from "./hash.js";
import { appendEvent, historyFor, readLedger } from "./ledger.js";
import {
  anchorsForPath,
  lockfilePath,
  newAnchorId,
  readLockfile,
  removeAnchor,
  upsertAnchor,
  writeLockfile,
} from "./lockfile.js";
import {
  claimUnchanged,
  type DocMarker,
  retargetMarkerLine,
  scanMarkers,
  stampMarkerLine,
} from "./markers.js";
import {
  globToRegExp,
  isScannedDoc,
  matchesAny,
  toRepoRelative,
  walkFiles,
  walkFilesWithin,
} from "./repo.js";
import type {
  Actor,
  Anchor,
  FileSymbols,
  Fingerprints,
  Lockfile,
  LockwireConfig,
  Tier,
} from "./types.js";
import { ALL_TIERS } from "./types.js";

export interface TargetResolution {
  found: boolean;
  fingerprints: Fingerprints;
  symbols?: FileSymbols;
}

/** Recomputes all four tier fingerprints for a target, or reports it unresolved (file/symbol not found). */
export async function resolveTarget(
  repoRoot: string,
  target: { path: string; symbol?: string },
  config: LockwireConfig,
): Promise<TargetResolution | null> {
  const absPath = `${repoRoot}/${target.path}`;
  if (!existsSync(absPath)) return null;

  const lang = langForPath(target.path);
  if (!lang)
    throw new Error(
      `lockwire supports TypeScript, TSX, JavaScript, and Python in P0 — "${target.path}" is none of these`,
    );

  const content = await readFile(absPath, "utf8");
  const parser = await parserFor(lang);
  const tree = parser.parse(content);
  if (!tree) throw new Error(`failed to parse ${target.path}`);
  const root = tree.rootNode;
  const symbols = extractFileSymbols(root, lang, config.normalizeLocals);
  const pathFp = fingerprint(target.path);

  if (target.symbol) {
    const symbol = symbols.bySymbolPath.get(target.symbol);
    if (!symbol)
      return { found: false, fingerprints: { path: pathFp, sig: "", body: "", deps: "" }, symbols };
    return {
      found: true,
      fingerprints: {
        path: pathFp,
        sig: fingerprint(symbol.sigTokens),
        body: fingerprint(symbol.bodyNormalized),
        deps: fingerprintSet(symbol.deps),
      },
      symbols,
    };
  }

  const whole = computeWholeFileTiers(root, lang, config.normalizeLocals);
  return {
    found: true,
    fingerprints: {
      path: pathFp,
      sig: fileExportsFingerprint(symbols),
      body: fingerprint(whole.bodyNormalized),
      deps: fingerprintSet(whole.deps),
    },
    symbols,
  };
}

/**
 * Same-file rename detection: if a symbol vanished but exactly one other symbol in the file has the
 * same signature apart from its name, relink to it. `sig` fingerprints include the symbol's name,
 * so each candidate is re-rendered under the missing symbol's old name before comparing -- that
 * keeps stored fingerprints valid. Symbols already bound by another anchor are skipped, so an
 * unrelated neighbour with the same shape isn't mistaken for the rename target. Cross-file
 * relocation (the symbol moved to a different file) is not attempted in P0 — see docs/concepts.md limitations.
 */
export function findRelocationCandidate(
  symbols: FileSymbols,
  missingSigFp: string,
  oldName: string,
  taken: ReadonlySet<string> = new Set(),
): string | null {
  const candidates: string[] = [];
  for (const [path, symbol] of symbols.bySymbolPath) {
    if (taken.has(path)) continue;
    const sig = symbol.sigTokens
      .replace(`fn ${symbol.name}(`, `fn ${oldName}(`)
      .replace(`class ${symbol.name} [`, `class ${oldName} [`);
    if (fingerprint(sig) === missingSigFp) candidates.push(path);
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

export interface LinkResult {
  created: number;
  refreshed: number;
  skipped: { reason: string; target: string }[];
}

/** Scans a markdown doc for `<!-- lockwire ... -->` markers and creates/refreshes their anchors. */
export async function linkDoc(
  repoRoot: string,
  docPath: string,
  config: LockwireConfig,
  actor: Actor,
  opts: { reviewed?: boolean; commit?: string | null } = {},
): Promise<LinkResult> {
  const absDoc = `${repoRoot}/${docPath}`;
  const text = await readFile(absDoc, "utf8");
  const markers = scanMarkers(text);
  const lockfile = await readLockfile(repoRoot);
  const result: LinkResult = { created: 0, refreshed: 0, skipped: [] };
  // Keep each line's own terminator: stamping a marker must change that one line, not rewrite every
  // CRLF in the file to LF. `parts` alternates line, terminator, line, terminator, ...
  const parts = text.split(/(\r?\n)/);
  let docChanged = false;
  let current = lockfile;
  const idsSeenInDoc = new Set<string>();
  const commit = opts.commit ?? headCommit(repoRoot);

  for (const marker of markers) {
    const targetLabel = `${marker.target.path}${marker.target.symbol ? `#${marker.target.symbol}` : ""}`;
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
      const originalPath = `${repoRoot}/${existing.doc}`;
      const stillThere =
        existsSync(originalPath) &&
        scanMarkers(await readFile(originalPath, "utf8")).some((m) => m.id === existing?.id);
      if (stillThere) {
        copiedId = true;
        existing = undefined;
      }
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
    if ((!resolved || !resolved.found) && existing) {
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
    if (!resolved || !resolved.found) {
      result.skipped.push({ reason: "target not found", target: targetLabel });
      continue;
    }

    // Re-stamping a drifted (or orphaned-then-reappeared) anchor accepts code nobody has looked at, so
    // it needs a human's say-so -- unless the code still matches and only the claim sentence moved.
    const codeDrifted =
      existing !== undefined &&
      existing.tiers.some((t) => resolved.fingerprints[t] !== existing.fingerprints[t]);
    if (
      (existing?.status === "drifted" || existing?.status === "orphaned") &&
      codeDrifted &&
      !opts.reviewed
    ) {
      result.skipped.push({
        reason: "drifted anchor needs --reviewed to re-stamp",
        target: marker.target.path,
      });
      continue;
    }

    const tiers =
      marker.tiers ?? (target.symbol ? (["sig"] as Tier[]) : (["path", "body"] as Tier[]));
    const isNew = !marker.id || copiedId;
    const id = isNew || !marker.id ? newAnchorId() : marker.id;
    idsSeenInDoc.add(id);
    if (marker.id) idsSeenInDoc.add(marker.id);
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
      linked: { at: new Date().toISOString(), commit, by: actor },
      status: "fresh",
      waiver: null,
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
        note: retargeted
          ? `re-stamped via link; marker retargeted ${targetLabel} -> ${target.path}${target.symbol ? `#${target.symbol}` : ""}`
          : "re-stamped via link",
      });
    }
  }

  await writeLockfile(repoRoot, current);
  if (docChanged) await writeFile(absDoc, parts.join(""), "utf8");
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
  const resolved = await resolveTarget(repoRoot, target, config);
  if (!resolved || !resolved.found)
    throw new Error(`target not found: ${target.path}${target.symbol ? `#${target.symbol}` : ""}`);
  const lockfile = await readLockfile(repoRoot);
  const anchor: Anchor = {
    id: newAnchorId(),
    doc: docPath,
    claim: null,
    target,
    tiers,
    fingerprints: resolved.fingerprints,
    linked: { at: new Date().toISOString(), commit: null, by: actor },
    status: "fresh",
    waiver: null,
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
      const abs = `${repoRoot}/${doc}`;
      cache.set(doc, existsSync(abs) ? scanMarkers(await readFile(abs, "utf8")) : null);
    }
    return cache.get(doc) ?? null;
  };
}

/** The part of a marker needed to classify it and show its claim; DocMarker and the doc index both have it. */
export type MarkerView = Pick<DocMarker, "id" | "target" | "line" | "claimExcerpt">;

/**
 * Markers in `docs` that no anchor in `lockfile` backs: no `id=` yet, an id that matches no anchor, an
 * id that belongs to the marker in another doc (a copy-paste), or one used twice in a doc. Until
 * `lockwire link` runs, such a claim isn't being checked at all.
 */
export async function findUnlinkedMarkers(
  lockfile: Lockfile,
  docs: readonly string[],
  readMarkers: (doc: string) => Promise<readonly MarkerView[] | null>,
): Promise<UnlinkedMarker[]> {
  const unlinked: UnlinkedMarker[] = [];
  for (const doc of [...docs].sort()) {
    const markers = await readMarkers(doc);
    if (!markers) continue;
    const seenIds = new Set<string>();
    for (const m of markers) {
      let reason: string | null = null;
      const anchor = m.id ? lockfile.anchors.find((a) => a.id === m.id) : undefined;
      if (!m.id) reason = "not linked yet";
      else if (!anchor) reason = `id ${m.id} matches no anchor`;
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
 * Claims written in the docs about this file (or symbol) that no anchor backs. Read-only: it uses an
 * existing doc index if there is one but never writes it (the MCP tool built on this is annotated
 * read-only).
 */
export async function unlinkedFor(
  repoRoot: string,
  config: LockwireConfig,
  path: string,
  symbol?: string,
): Promise<UnlinkedMarker[]> {
  return (
    await unlinkedForWithin(repoRoot, config, path, symbol, Number.POSITIVE_INFINITY, {
      persist: false,
    })
  ).claims;
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
  opts: { persist?: boolean } = {},
): Promise<{ claims: UnlinkedMarker[]; complete: boolean; index: IndexStats }> {
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
  };
}

export async function check(
  repoRoot: string,
  config: LockwireConfig,
  onlyPaths?: readonly string[],
  opts: { write?: boolean; actor?: Actor } = {},
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

  for (const stored of lockfile.anchors) {
    let anchor = stored;
    const inScope =
      !onlyPaths ||
      onlyPaths.includes(anchor.target.path) ||
      (anchor.doc !== null && onlyPaths.includes(anchor.doc));
    if (!inScope) {
      results.push({
        anchor,
        status: anchor.status,
        driftedTiers: [],
        skipped: true,
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
      // A claim stamped before `normHash` existed can only be compared by raw text. Now that we've
      // just confirmed it's unchanged, record the whitespace-insensitive hash so a later re-wrap
      // (a formatter pass) can't flag it.
      if (!claimChanged && !anchor.claim.normHash) {
        anchor = { ...anchor, claim: { ...anchor.claim, normHash: marker.claimNormHash } };
        current = upsertAnchor(current, anchor);
      }
    }

    let resolved: TargetResolution | null;
    try {
      resolved = await resolveTarget(repoRoot, anchor.target, config);
    } catch {
      resolved = null;
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
          note: "file not found",
        });
      }
      results.push({
        anchor: orphaned,
        status: "orphaned",
        driftedTiers: [],
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
          )
        : null;
      if (relocatedTo) {
        const reResolved = await resolveTarget(
          repoRoot,
          { path: anchor.target.path, symbol: relocatedTo },
          config,
        );
        const target = { path: anchor.target.path, symbol: relocatedTo };
        // A rename must not launder other changes: `sig` is expected to differ (it carries the
        // name, and the candidate already matched on it), but any other bound tier that moved is
        // real drift. Re-stamp only `sig` in that case so the drift stays visible on later checks.
        const movedTiers = reResolved
          ? anchor.tiers.filter(
              (t) => t !== "sig" && reResolved.fingerprints[t] !== anchor.fingerprints[t],
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
            from: anchor.fingerprints[tier],
            to: reResolved?.fingerprints[tier] ?? "",
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
        results.push({
          anchor: orphaned,
          status: "orphaned",
          driftedTiers: [],
          singleHashWouldFlag: true,
        });
      }
      continue;
    }

    const driftedTiers = anchor.tiers.filter(
      (t) => resolved!.fingerprints[t] !== anchor.fingerprints[t],
    );
    const anyTierChanged = ALL_TIERS.filter(
      (t) => resolved!.fingerprints[t] !== anchor.fingerprints[t],
    );

    if (driftedTiers.length > 0 || claimChanged) {
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
            from: anchor.fingerprints[tier],
            to: resolved.fingerprints[tier],
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
      results.push({
        anchor: drifted,
        status: "drifted",
        driftedTiers,
        ...(claimChanged ? { claimChanged } : {}),
        singleHashWouldFlag: anyTierChanged.length > 0,
      });
    } else {
      if (anchor.status === "drifted" && anyTierChanged.length === 0) {
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
          singleHashWouldFlag: false,
        });
      } else {
        results.push({
          anchor,
          status: anchor.status,
          driftedTiers: [],
          singleHashWouldFlag: anyTierChanged.length > 0,
        });
      }
    }
  }

  // Don't conjure an empty lockwire.lock in a directory that never had one (e.g. an MCP server
  // rooted at a parent folder of the real repo).
  if (write && (lockfile.anchors.length > 0 || existsSync(lockfilePath(repoRoot))))
    await writeLockfile(repoRoot, current);

  // Anchors outside a scoped run weren't examined: they stay in `results` (callers like the hooks
  // look anchors up there) but must not count towards the summary or the exit code.
  const examined = results.filter((r) => !r.skipped);
  // The other thing a claim can be: not bound at all (see findUnlinkedMarkers). Scoped runs (hooks,
  // --changed) only look at docs in scope and never walk the tree.
  const docsToScan = onlyPaths
    ? [...new Set(onlyPaths)].filter((p) => isScannedDoc(p, config))
    : await discoverDocs(repoRoot, config);
  const unlinked = await findUnlinkedMarkers(lockfile, docsToScan, markersIn);

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
    unlinked: unlinked.length,
    noise: { singleHashWouldFlag, tieredFlagged, reductionPercent },
  };

  return { summary, results, unlinked };
}

export async function discoverDocs(repoRoot: string, config: LockwireConfig): Promise<string[]> {
  return walkFiles(repoRoot, config.exclude).filter((p) => matchesAny(p, config.docs));
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
    if (anchor.doc && anchor.claim && existsSync(`${repoRoot}/${anchor.doc}`)) {
      const marker = scanMarkers(await readFile(`${repoRoot}/${anchor.doc}`, "utf8")).find(
        (m) => m.id === anchor.id,
      );
      if (marker)
        claim = {
          line: marker.claimLine,
          hash: marker.claimHash,
          normHash: marker.claimNormHash,
          excerpt: marker.claimExcerpt,
        };
    }
    updated = { ...anchor, status: "fresh", fingerprints: resolved.fingerprints, claim };
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

export async function waive(
  repoRoot: string,
  anchorId: string,
  reason: string,
  expires: string,
  actor: Actor,
): Promise<Anchor> {
  const expiresAt = Date.parse(expires);
  if (!/^\d{4}-\d{2}-\d{2}/.test(expires) || Number.isNaN(expiresAt))
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
