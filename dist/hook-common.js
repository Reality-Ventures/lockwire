import { appendFile, mkdir } from "node:fs/promises";
import { check, refs } from "./actions.js";
import { readConfig } from "./config.js";
import { toPosix, toRepoRelative } from "./repo.js";
export async function readStdinJson() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw)
        return {};
    return JSON.parse(raw);
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
export function buildAdvisoryText(anchors, config) {
    const shown = anchors.slice(0, config.hook.maxClaimsInContext);
    const lines = shown.map((a) => {
        const target = `${a.target.path}${a.target.symbol ? `#${a.target.symbol}` : ""}`;
        const claimText = a.claim ? `"${a.claim.excerpt}"` : "(whole-file binding, no inline claim)";
        return `- ${a.doc ?? "(lockfile-only)"} asserts ${claimText} about ${target} [tiers: ${a.tiers.join(",")}]`;
    });
    const more = anchors.length > shown.length ? `\n…and ${anchors.length - shown.length} more.` : "";
    return [
        `lockwire: documentation makes claims about this code:`,
        ...lines,
        more,
        `If this edit changes what any of these claims assert, update the doc and run \`lockwire link <doc>\`.`,
    ]
        .filter(Boolean)
        .join("\n");
}
export async function claimsForPath(repoRoot, touchedPath) {
    return refs(repoRoot, touchedPath);
}
export async function reportDriftFor(repoRoot, touchedPath) {
    const config = await readConfig(repoRoot);
    const result = await check(repoRoot, config, [touchedPath]);
    const relevant = result.results.filter((r) => r.anchor.target.path === touchedPath && (r.status === "drifted" || r.status === "orphaned"));
    if (relevant.length === 0)
        return { text: "", anyDrift: false };
    const lines = relevant.map((r) => {
        const target = `${r.anchor.target.path}${r.anchor.target.symbol ? `#${r.anchor.target.symbol}` : ""}`;
        return `- ${r.anchor.doc ?? "(lockfile-only)"} on ${target} is now ${r.status}${r.driftedTiers.length ? ` (${r.driftedTiers.join(",")})` : ""}`;
    });
    return {
        text: [
            `lockwire: this edit drifted documentation claims:`,
            ...lines,
            `Update the doc and run \`lockwire link <doc>\`, or \`lockwire ack\`/\`lockwire waive\` if this is expected.`,
        ].join("\n"),
        anyDrift: true,
    };
}
export async function logHookError(repoRoot, adapter, err) {
    try {
        await mkdir(`${repoRoot}/.lockwire`, { recursive: true });
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        await appendFile(`${repoRoot}/.lockwire/hook.log`, `[${new Date().toISOString()}] ${adapter}: ${msg}\n`, "utf8");
    }
    catch {
        // fail-open invariant: a broken hook must never break the session, not even to log
    }
}
//# sourceMappingURL=hook-common.js.map