import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { computeWholeFileTiers, extractFileSymbols, fileExportsFingerprint } from "./extract.js";
import { langForPath, parserFor } from "./grammar.js";
import { fingerprint, fingerprintSet } from "./hash.js";
import { appendEvent, historyFor, readLedger } from "./ledger.js";
import {
  anchorsForPath,
  newAnchorId,
  readLockfile,
  removeAnchor,
  upsertAnchor,
  writeLockfile,
} from "./lockfile.js";
import { scanMarkers, stampMarkerLine } from "./markers.js";
import { globToRegExp, matchesAny, toRepoRelative, walkFiles } from "./repo.js";
import type { Actor, Anchor, FileSymbols, Fingerprints, LockwireConfig, Tier } from "./types.js";
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

/** Same-file rename detection: if a symbol vanished but exactly one other symbol in the file shares its `sig` fingerprint, relink to it. Cross-file relocation (the symbol moved to a different file) is not attempted in P0 — see docs/concepts.md limitations. */
export function findRelocationCandidate(symbols: FileSymbols, missingSigFp: string): string | null {
  const candidates: string[] = [];
  for (const [path, symbol] of symbols.bySymbolPath) {
    if (fingerprint(symbol.sigTokens) === missingSigFp) candidates.push(path);
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
  const lines = text.split(/\r?\n/);
  let docChanged = false;
  let current = lockfile;

  for (const marker of markers) {
    const existing = marker.id ? current.anchors.find((a) => a.id === marker.id) : undefined;
    if (existing?.status === "drifted" && !opts.reviewed) {
      result.skipped.push({
        reason: "drifted anchor needs --reviewed to re-stamp",
        target: marker.target.path,
      });
      continue;
    }

    const resolved = await resolveTarget(repoRoot, marker.target, config);
    if (!resolved || !resolved.found) {
      result.skipped.push({
        reason: "target not found",
        target: `${marker.target.path}${marker.target.symbol ? `#${marker.target.symbol}` : ""}`,
      });
      continue;
    }

    const tiers =
      marker.tiers ?? (marker.target.symbol ? (["sig"] as Tier[]) : (["path", "body"] as Tier[]));
    const id = marker.id ?? newAnchorId();
    const anchor: Anchor = {
      id,
      doc: docPath,
      claim: { line: marker.claimLine, hash: marker.claimHash, excerpt: marker.claimExcerpt },
      target: marker.target,
      tiers,
      fingerprints: resolved.fingerprints,
      linked: { at: new Date().toISOString(), commit: opts.commit ?? null, by: actor },
      status: "fresh",
      waiver: null,
    };
    current = upsertAnchor(current, anchor);

    if (!marker.id) {
      const lineIdx = marker.line - 1;
      const original = lines[lineIdx];
      if (original !== undefined) {
        lines[lineIdx] = stampMarkerLine(original, id);
        docChanged = true;
      }
      result.created++;
      await appendEvent(repoRoot, {
        ts: anchor.linked.at,
        event: "anchor.created",
        anchor: id,
        actor,
        commit: opts.commit ?? null,
      });
    } else {
      result.refreshed++;
      await appendEvent(repoRoot, {
        ts: anchor.linked.at,
        event: "anchor.resolved",
        anchor: id,
        actor,
        commit: opts.commit ?? null,
        note: "re-stamped via link",
      });
    }
  }

  await writeLockfile(repoRoot, current);
  if (docChanged) await writeFile(absDoc, lines.join("\n"), "utf8");
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
  noise: { singleHashWouldFlag: number; tieredFlagged: number; reductionPercent: number };
}

export interface CheckResult {
  summary: CheckSummary;
  results: AnchorCheckResult[];
}

export async function check(
  repoRoot: string,
  config: LockwireConfig,
  onlyPaths?: readonly string[],
): Promise<CheckResult> {
  const lockfile = await readLockfile(repoRoot);
  const now = new Date().toISOString();
  const results: AnchorCheckResult[] = [];
  let current = lockfile;

  for (const anchor of lockfile.anchors) {
    if (onlyPaths && !onlyPaths.includes(anchor.target.path)) {
      results.push({ anchor, status: anchor.status, driftedTiers: [], singleHashWouldFlag: false });
      continue;
    }

    if (anchor.status === "waived" && anchor.waiver) {
      if (anchor.waiver.expires < now) {
        await appendEvent(repoRoot, {
          ts: now,
          event: "waiver.expired",
          anchor: anchor.id,
          actor: { type: "unknown" },
          commit: null,
        });
        const reverted: Anchor = { ...anchor, status: "drifted", waiver: null };
        current = upsertAnchor(current, reverted);
        results.push({
          anchor: reverted,
          status: "drifted",
          driftedTiers: anchor.tiers,
          singleHashWouldFlag: true,
        });
      } else {
        results.push({ anchor, status: "waived", driftedTiers: [], singleHashWouldFlag: false });
      }
      continue;
    }

    if (anchor.status === "superseded") {
      results.push({ anchor, status: "superseded", driftedTiers: [], singleHashWouldFlag: false });
      continue;
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
        await appendEvent(repoRoot, {
          ts: now,
          event: "anchor.orphaned",
          anchor: anchor.id,
          actor: { type: "unknown" },
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
        ? findRelocationCandidate(resolved.symbols, anchor.fingerprints.sig)
        : null;
      if (relocatedTo) {
        const reResolved = await resolveTarget(
          repoRoot,
          { path: anchor.target.path, symbol: relocatedTo },
          config,
        );
        const relocated: Anchor = {
          ...anchor,
          target: { path: anchor.target.path, symbol: relocatedTo },
          fingerprints: reResolved?.fingerprints ?? anchor.fingerprints,
          status: "fresh",
        };
        current = upsertAnchor(current, relocated);
        await appendEvent(repoRoot, {
          ts: now,
          event: "anchor.relocated",
          anchor: anchor.id,
          actor: { type: "unknown" },
          commit: null,
          note: `${anchor.target.symbol} -> ${relocatedTo}`,
        });
        results.push({
          anchor: relocated,
          status: "fresh",
          driftedTiers: [],
          singleHashWouldFlag: true,
        });
      } else {
        const orphaned: Anchor = { ...anchor, status: "orphaned" };
        if (anchor.status !== "orphaned") {
          current = upsertAnchor(current, orphaned);
          await appendEvent(repoRoot, {
            ts: now,
            event: "anchor.orphaned",
            anchor: anchor.id,
            actor: { type: "unknown" },
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

    if (driftedTiers.length > 0) {
      const drifted: Anchor = { ...anchor, status: "drifted" };
      if (anchor.status !== "drifted") {
        current = upsertAnchor(current, drifted);
        for (const tier of driftedTiers) {
          await appendEvent(repoRoot, {
            ts: now,
            event: "anchor.drifted",
            anchor: anchor.id,
            actor: { type: "unknown" },
            commit: null,
            tier,
            from: anchor.fingerprints[tier],
            to: resolved.fingerprints[tier],
          });
        }
      }
      results.push({
        anchor: drifted,
        status: "drifted",
        driftedTiers,
        singleHashWouldFlag: anyTierChanged.length > 0,
      });
    } else {
      if (anchor.status === "drifted" && anyTierChanged.length === 0) {
        const resolvedAnchor: Anchor = { ...anchor, status: "fresh" };
        current = upsertAnchor(current, resolvedAnchor);
        await appendEvent(repoRoot, {
          ts: now,
          event: "anchor.resolved",
          anchor: anchor.id,
          actor: { type: "unknown" },
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

  await writeLockfile(repoRoot, current);

  const singleHashWouldFlag = results.filter((r) => r.singleHashWouldFlag).length;
  const tieredFlagged = results.filter(
    (r) => r.status === "drifted" || r.status === "orphaned",
  ).length;
  const reductionPercent =
    singleHashWouldFlag === 0
      ? 0
      : Math.round(((singleHashWouldFlag - tieredFlagged) / singleHashWouldFlag) * 1000) / 10;

  const summary: CheckSummary = {
    anchors: results.length,
    fresh: results.filter((r) => r.status === "fresh").length,
    drifted: results.filter((r) => r.status === "drifted").length,
    relocated: 0,
    orphaned: results.filter((r) => r.status === "orphaned").length,
    waived: results.filter((r) => r.status === "waived").length,
    superseded: results.filter((r) => r.status === "superseded").length,
    noise: { singleHashWouldFlag, tieredFlagged, reductionPercent },
  };

  return { summary, results };
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
    const resolved = await resolveTarget(repoRoot, anchor.target, config);
    updated = {
      ...anchor,
      status: "fresh",
      fingerprints: resolved?.fingerprints ?? anchor.fingerprints,
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

export async function waive(
  repoRoot: string,
  anchorId: string,
  reason: string,
  expires: string,
  actor: Actor,
): Promise<Anchor> {
  const lockfile = await readLockfile(repoRoot);
  const anchor = lockfile.anchors.find((a) => a.id === anchorId);
  if (!anchor) throw new Error(`no anchor ${anchorId}`);
  const updated: Anchor = { ...anchor, status: "waived", waiver: { reason, expires, by: actor } };
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
