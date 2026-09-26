import type { LedgerRecord } from "./types.js";
export declare function ledgerPath(repoRoot: string): string;
export declare function appendEvent(repoRoot: string, record: Omit<LedgerRecord, "v" | "id" | "hash">): Promise<LedgerRecord>;
export declare function readLedger(repoRoot: string): Promise<LedgerRecord[]>;
export interface VerifyResult {
    ok: boolean;
    total: number;
    badLines: number[];
    root: string;
}
export declare function verifyLedger(repoRoot: string): Promise<VerifyResult>;
export declare function historyFor(records: LedgerRecord[], anchorId: string): LedgerRecord[];
//# sourceMappingURL=ledger.d.ts.map