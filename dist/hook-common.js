import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { check, refs, unlinkedForWithin } from "./actions.js";
import { readConfig } from "./config.js";
import { isLockwireRepo, toPosix, toRepoRelative, tryFindRepoRoot } from "./repo.js";
export async function readStdinJson() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw)
        return {};
    return JSON.parse(raw);
}
/**
 * Hooks run with the session's cwd, which may be a folder *above* the repo (e.g. a workspace holding
 * several projects). The edited file is the better signal: walk up from it, then from the hook's
 * reported cwd, and only then fall back to the root derived from the process cwd.
 */
export function absoluteHookPath(input, filePath) {
    return isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(filePath)
        ? filePath
        : resolve(input.cwd ?? process.cwd(), filePath);
}
export function resolveHookRoot(fallbackRoot, input, absPath) {
    return (tryFindRepoRoot(dirname(absPath)) ?? tryFindRepoRoot(input.cwd ?? process.cwd()) ?? fallbackRoot);
}
/** Windows delivers `C:\project\src\index.ts`; hooks compare against posix, repo-relative anchor targets. */
export function normalizeTouchedPath(repoRoot, filePath) {
    const posixAbs = toPosix(filePath);
    const posixRoot = toPosix(repoRoot);
    if (posixAbs.toLowerCase().startsWith(posixRoot.toLowerCase())) {
        return toRepoRelative(repoRoot, posixAbs);
    }
    return posixAbs.replace(/^[A-Za-z]:/, "").replace(/^\//, "");
}
export function buildAdvisoryText(anchors, config, unlinked = []) {
    const cap = config.hook.maxClaimsInContext;
    const sections = [];
    if (anchors.length > 0) {
        const shown = anchors.slice(0, cap);
        const lines = shown.map((a) => {
            const target = `${a.target.path}${a.target.symbol ? `#${a.target.symbol}` : ""}`;
            const claimText = a.claim ? `"${a.claim.excerpt}"` : "(whole-file binding, no inline claim)";
            return `- ${a.doc ?? "(lockfile-only)"} asserts ${claimText} about ${target} [tiers: ${a.tiers.join(",")}]`;
        });
        const more = anchors.length > shown.length ? `\n…and ${anchors.length - shown.length} more.` : "";
        sections.push([
            `lockwire: documentation makes claims about this code:`,
            ...lines,
            more,
            `If this edit changes what any of these claims assert, update the doc and run \`lockwire link <doc>\`.`,
        ]
            .filter(Boolean)
            .join("\n"));
    }
    if (unlinked.length > 0) {
        const shown = unlinked.slice(0, cap);
        const lines = shown.map((u) => `- ${u.doc}:${u.line} asserts "${u.excerpt}" about ${u.target} (${u.reason})`);
        const more = unlinked.length > shown.length ? `\n…and ${unlinked.length - shown.length} more.` : "";
        const docs = [...new Set(shown.map((u) => u.doc))];
        sections.push([
            `lockwire: these docs also make claims about this code that nobody has linked, so nothing is checking them:`,
            ...lines,
            more,
            `Treat them as real claims. Run \`lockwire link ${docs.length === 1 ? docs[0] : "<doc>"}\` so lockwire checks them.`,
        ]
            .filter(Boolean)
            .join("\n"));
    }
    return sections.join("\n\n");
}
/** How long the PreToolUse hook may spend looking for unlinked claims before giving up on them. */
export const UNLINKED_SCAN_BUDGET_MS = 750;
/**
 * Claims in the docs about the file about to be edited that no anchor backs. Never throws and never
 * blocks the edit: the anchored claims are the hook's job, this is a courtesy on top, so any failure
 * or a blown time budget just means it's left out (and noted in `.lockwire/hook.log`).
 */
export async function unlinkedClaimsFor(repoRoot, config, touchedPath, adapter, budgetMs = UNLINKED_SCAN_BUDGET_MS) {
    if (!config.hook.unlinkedClaims || !isLockwireRepo(repoRoot))
        return [];
    try {
        const { claims, complete } = await unlinkedForWithin(repoRoot, config, touchedPath, undefined, budgetMs);
        if (!complete)
            await logHookError(repoRoot, adapter, `unlinked-claims scan hit its ${budgetMs}ms budget before finishing; showing what was found. Run \`lockwire index\` once to build the doc index so later edits are fast, or set hook.unlinkedClaims to false in .lockwire/config.json to stop scanning.`);
        return claims;
    }
    catch (err) {
        await logHookError(repoRoot, adapter, err);
        return [];
    }
}
export async function claimsForPath(repoRoot, touchedPath) {
    return refs(repoRoot, touchedPath);
}
/** The agent that just made the edit, for ledger attribution: the PostToolUse hook runs right after it. */
export function hookActor(tool, input) {
    return {
        type: "ai",
        tool: { name: tool },
        ...(input.session_id ? { session: input.session_id } : {}),
    };
}
export async function reportDriftFor(repoRoot, touchedPath, actor) {
    const config = await readConfig(repoRoot);
    const result = await check(repoRoot, config, [touchedPath], actor ? { actor } : {});
    const relevant = result.results.filter((r) => (r.anchor.target.path === touchedPath || r.anchor.doc === touchedPath) &&
        (r.status === "drifted" || r.status === "orphaned"));
    const unlinked = result.unlinked.filter((u) => u.doc === touchedPath);
    if (relevant.length === 0 && unlinked.length === 0)
        return { text: "", anyDrift: false };
    const sections = [];
    if (relevant.length > 0) {
        const lines = relevant.map((r) => {
            const target = `${r.anchor.target.path}${r.anchor.target.symbol ? `#${r.anchor.target.symbol}` : ""}`;
            const what = [...r.driftedTiers, ...(r.claimChanged ? ["claim"] : [])];
            return `- ${r.anchor.doc ?? "(lockfile-only)"} on ${target} is now ${r.status}${what.length ? ` (${what.join(",")})` : ""}`;
        });
        sections.push([
            `lockwire: this edit drifted documentation claims:`,
            ...lines,
            `Update the doc and run \`lockwire link <doc>\`, or \`lockwire ack\`/\`lockwire waive\` if this is expected.`,
        ].join("\n"));
    }
    if (unlinked.length > 0) {
        sections.push([
            `lockwire: ${touchedPath} has markers that no anchor backs, so those claims are not being checked:`,
            ...unlinked.map((u) => `- line ${u.line}: ${u.target} (${u.reason})`),
            `Run \`lockwire link ${touchedPath}\` to link them.`,
        ].join("\n"));
    }
    return { text: sections.join("\n\n"), anyDrift: true };
}
export async function logHookError(repoRoot, adapter, err) {
    try {
        // A hook runs in every repo the user edits; an error in one that never opted into lockwire must
        // not leave a `.lockwire/` behind. (A repo with the directory already, or a lockfile, has opted in.)
        if (!isLockwireRepo(repoRoot) && !existsSync(`${repoRoot}/.lockwire`))
            return;
        await mkdir(`${repoRoot}/.lockwire`, { recursive: true });
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        await appendFile(`${repoRoot}/.lockwire/hook.log`, `[${new Date().toISOString()}] ${adapter}: ${msg}\n`, "utf8");
    }
    catch {
        // fail-open invariant: a broken hook must never break the session, not even to log
    }
}
//# sourceMappingURL=hook-common.js.map