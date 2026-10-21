import type { AnchorCheckResult, CheckResult } from "./actions.js";
/**
 * What moved, for a one-line report: `sig`, `claim`, and for a value anchor the value itself —
 * `value: 0.18 -> 0.19`, or `claim says 0.18, value is 0.19` when the sentence no longer holds.
 */
export declare function describeDrift(r: Pick<AnchorCheckResult, "driftedTiers" | "claimChanged" | "value">): string;
export declare function formatText(result: CheckResult): string;
export declare function formatJson(result: CheckResult, repo: string | null): string;
export declare function formatGithub(result: CheckResult, opts?: {
    failOnUnlinked?: boolean;
}): string;
//# sourceMappingURL=format.d.ts.map