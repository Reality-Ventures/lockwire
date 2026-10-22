// Shared types for the lockwire core. See LOCKWIRE-SPEC.md — this file is the TS mirror of §2, §4, §5.
export const ALL_TIERS = ["path", "sig", "body", "deps", "value"];
/** A tier's fingerprint, with a missing one (an older lockfile, a code anchor's `value`) read as empty. */
export function tierFingerprint(f, tier) {
    return f[tier] ?? "";
}
export const DEFAULT_CONFIG = {
    version: 1,
    docs: ["**/*.md", "**/*.mdx"],
    exclude: ["node_modules/**", "dist/**", "**/CHANGELOG.md"],
    normalizeLocals: true,
    hook: { mode: "advisory", maxClaimsInContext: 8, unlinkedClaims: true },
};
//# sourceMappingURL=types.js.map