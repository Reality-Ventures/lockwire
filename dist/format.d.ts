import type { CheckResult } from "./actions.js";
export declare function formatText(result: CheckResult): string;
export declare function formatJson(result: CheckResult, repo: string | null): string;
export declare function formatGithub(result: CheckResult, opts?: {
    failOnUnlinked?: boolean;
}): string;
//# sourceMappingURL=format.d.ts.map