import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { computeWholeFileTiers, extractFileSymbols, fileExportsFingerprint } from "./extract.js";
import { langForPath, parserFor } from "./grammar.js";
import { fingerprint, fingerprintSet } from "./hash.js";
import { appendEvent, historyFor, readLedger } from "./ledger.js";
import { anchorsForPath, lockfilePath, newAnchorId, readLockfile, removeAnchor, upsertAnchor, writeLockfile, } from "./lockfile.js";
import { scanMarkers, stampMarkerLine } from "./markers.js";
import { globToRegExp, matchesAny, toRepoRelative, walkFiles } from "./repo.js";
import { ALL_TIERS } from "./types.js";
/** Recomputes all four tier fingerprints for a target, or reports it unresolved (file/symbol not found). */
export async function resolveTarget(repoRoot, target, config) {
    const absPath = `${repoRoot}/${target.path}`;
    if (!existsSync(absPath))
        return null;
    const lang = langForPath(target.path);
    if (!lang)
        throw new Error(`lockwire supports TypeScript, TSX, JavaScript, and Python in P0 — "${target.path}" is none of these`);
    const content = await readFile(absPath, "utf8");
    const parser = await parserFor(lang);
    const tree = parser.parse(content);
    if (!tree)
        throw new Error(`failed to parse ${target.path}`);
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
export function findRelocationCandidate(symbols, missingSigFp, oldName, taken = new Set()) {
    const candidates = [];
    for (const [path, symbol] of symbols.bySymbolPath) {
        if (taken.has(path))
            continue;
        const sig = symbol.sigTokens
            .replace(`fn ${symbol.name}(`, `fn ${oldName}(`)
            .replace(`class ${symbol.name} [`, `class ${oldName} [`);
        if (fingerprint(sig) === missingSigFp)
            candidates.push(path);
    }
    return candidates.length === 1 ? candidates[0] : null;
}
/** Scans a markdown doc for `<!-- lockwire ... -->` markers and creates/refreshes their anchors. */
export async function linkDoc(repoRoot, docPath, config, actor, opts = {}) {
    const absDoc = `${repoRoot}/${docPath}`;
    const text = await readFile(absDoc, "utf8");
    const markers = scanMarkers(text);
    const lockfile = await readLockfile(repoRoot);
    const result = { created: 0, refreshed: 0, skipped: [] };
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
        const tiers = marker.tiers ?? (marker.target.symbol ? ["sig"] : ["path", "body"]);
        const id = marker.id ?? newAnchorId();
        const anchor = {
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
        }
        else {
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
    if (docChanged)
        await writeFile(absDoc, lines.join("\n"), "utf8");
    return result;
}
/** `lockwire link <doc> <target>` — a lockfile-only anchor with no inline marker, for whole-doc-to-file bindings. */
export async function linkLockfileOnly(repoRoot, docPath, target, tiers, config, actor) {
    const resolved = await resolveTarget(repoRoot, target, config);
    if (!resolved || !resolved.found)
        throw new Error(`target not found: ${target.path}${target.symbol ? `#${target.symbol}` : ""}`);
    const lockfile = await readLockfile(repoRoot);
    const anchor = {
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
export async function check(repoRoot, config, onlyPaths) {
    const lockfile = await readLockfile(repoRoot);
    const now = new Date().toISOString();
    const results = [];
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
                const reverted = { ...anchor, status: "drifted", waiver: null };
                current = upsertAnchor(current, reverted);
                results.push({
                    anchor: reverted,
                    status: "drifted",
                    driftedTiers: anchor.tiers,
                    singleHashWouldFlag: true,
                });
            }
            else {
                results.push({ anchor, status: "waived", driftedTiers: [], singleHashWouldFlag: false });
            }
            continue;
        }
        if (anchor.status === "superseded") {
            results.push({ anchor, status: "superseded", driftedTiers: [], singleHashWouldFlag: false });
            continue;
        }
        let resolved;
        try {
            resolved = await resolveTarget(repoRoot, anchor.target, config);
        }
        catch {
            resolved = null;
        }
        if (!resolved) {
            const orphaned = { ...anchor, status: "orphaned" };
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
                ? findRelocationCandidate(resolved.symbols, anchor.fingerprints.sig, anchor.target.symbol.slice(anchor.target.symbol.lastIndexOf(".") + 1), new Set(lockfile.anchors
                    .filter((a) => a.id !== anchor.id && a.target.path === anchor.target.path)
                    .flatMap((a) => (a.target.symbol ? [a.target.symbol] : []))))
                : null;
            if (relocatedTo) {
                const reResolved = await resolveTarget(repoRoot, { path: anchor.target.path, symbol: relocatedTo }, config);
                const relocated = {
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
            }
            else {
                const orphaned = { ...anchor, status: "orphaned" };
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
        const driftedTiers = anchor.tiers.filter((t) => resolved.fingerprints[t] !== anchor.fingerprints[t]);
        const anyTierChanged = ALL_TIERS.filter((t) => resolved.fingerprints[t] !== anchor.fingerprints[t]);
        if (driftedTiers.length > 0) {
            const drifted = { ...anchor, status: "drifted" };
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
        }
        else {
            if (anchor.status === "drifted" && anyTierChanged.length === 0) {
                const resolvedAnchor = { ...anchor, status: "fresh" };
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
            }
            else {
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
    if (lockfile.anchors.length > 0 || existsSync(lockfilePath(repoRoot)))
        await writeLockfile(repoRoot, current);
    const singleHashWouldFlag = results.filter((r) => r.singleHashWouldFlag).length;
    const tieredFlagged = results.filter((r) => r.status === "drifted" || r.status === "orphaned").length;
    const reductionPercent = singleHashWouldFlag === 0
        ? 0
        : Math.round(((singleHashWouldFlag - tieredFlagged) / singleHashWouldFlag) * 1000) / 10;
    const summary = {
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
export async function discoverDocs(repoRoot, config) {
    return walkFiles(repoRoot, config.exclude).filter((p) => matchesAny(p, config.docs));
}
export async function ack(repoRoot, anchorId, resolution, note, actor, config) {
    const lockfile = await readLockfile(repoRoot);
    const anchor = lockfile.anchors.find((a) => a.id === anchorId);
    if (!anchor)
        throw new Error(`no anchor ${anchorId}`);
    let updated = anchor;
    if (resolution === "superseded") {
        updated = { ...anchor, status: "superseded" };
    }
    else {
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
export async function waive(repoRoot, anchorId, reason, expires, actor) {
    const lockfile = await readLockfile(repoRoot);
    const anchor = lockfile.anchors.find((a) => a.id === anchorId);
    if (!anchor)
        throw new Error(`no anchor ${anchorId}`);
    const updated = { ...anchor, status: "waived", waiver: { reason, expires, by: actor } };
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
export async function unlink(repoRoot, anchorId) {
    const lockfile = await readLockfile(repoRoot);
    await writeLockfile(repoRoot, removeAnchor(lockfile, anchorId));
}
export async function refs(repoRoot, path, symbol) {
    const lockfile = await readLockfile(repoRoot);
    return anchorsForPath(lockfile, path).filter((a) => !symbol || a.target.symbol === symbol);
}
export async function status(repoRoot, scope) {
    const lockfile = await readLockfile(repoRoot);
    if (!scope)
        return lockfile.anchors;
    const re = globToRegExp(scope);
    return lockfile.anchors.filter((a) => re.test(a.target.path) || (a.doc && re.test(a.doc)));
}
export async function history(repoRoot, ref) {
    const lockfile = await readLockfile(repoRoot);
    const records = await readLedger(repoRoot);
    const byId = lockfile.anchors.find((a) => a.id === ref);
    if (byId)
        return { anchors: [byId], events: historyFor(records, byId.id) };
    if (ref.includes("#") || !ref.endsWith(".md")) {
        const [path, symbol] = ref.split("#");
        const matches = lockfile.anchors.filter((a) => a.target.path === path && (!symbol || a.target.symbol === symbol));
        const events = matches.flatMap((a) => historyFor(records, a.id));
        return { anchors: matches, events: events.sort((a, b) => a.ts.localeCompare(b.ts)) };
    }
    const matches = lockfile.anchors.filter((a) => a.doc === ref);
    const events = matches.flatMap((a) => historyFor(records, a.id));
    return { anchors: matches, events: events.sort((a, b) => a.ts.localeCompare(b.ts)) };
}
//# sourceMappingURL=actions.js.map