// Shared types for the lockwire core. See LOCKWIRE-SPEC.md — this file is the TS mirror of §2, §4, §5.
export const ALL_TIERS = ["path", "sig", "body", "deps"];
export const DEFAULT_CONFIG = {
    version: 1,
    docs: ["**/*.md"],
    exclude: ["node_modules/**", "dist/**", "**/CHANGELOG.md"],
    normalizeLocals: true,
    hook: { mode: "advisory", maxClaimsInContext: 8 },
    noiseBudget: { maxStalePercent: 25 },
};
//# sourceMappingURL=types.js.map