import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { headCommit } from "./changed.js";
import { canonicalJson, fingerprint, fingerprintSet } from "./hash.js";
import { stripBom } from "./repo.js";
export function ledgerPath(repoRoot) {
    return `${repoRoot}/.lockwire/ledger.jsonl`;
}
function eventId() {
    // Not a real ULID library dependency for v0.1 — monotonic-enough for a local, single-writer append.
    // Sortable by time; uniqueness comes from the timestamp + a short random suffix.
    const time = Date.now().toString(36).padStart(9, "0");
    const rand = Math.random().toString(36).slice(2, 8);
    return `${time}${rand}`.toUpperCase();
}
export async function appendEvent(repoRoot, record) {
    // Callers that don't know a commit pass null; record the HEAD the event happened on, when there is one.
    const commit = record.commit ?? headCommit(repoRoot);
    const withoutHash = { v: 1, id: eventId(), ...record, commit };
    const hash = fingerprint(canonicalJson(withoutHash));
    const full = { ...withoutHash, hash };
    const path = ledgerPath(repoRoot);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(full)}\n`, "utf8");
    return full;
}
export async function readLedger(repoRoot) {
    const path = ledgerPath(repoRoot);
    if (!existsSync(path))
        return [];
    const raw = stripBom(await readFile(path, "utf8"));
    const records = [];
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        try {
            records.push(JSON.parse(line));
        }
        catch {
            // malformed line: `ledger verify` reports this explicitly; readers skip it rather than crash
        }
    }
    return records;
}
export async function verifyLedger(repoRoot) {
    const path = ledgerPath(repoRoot);
    if (!existsSync(path))
        return { ok: true, total: 0, badLines: [], root: fingerprintSet([]) };
    const raw = stripBom(await readFile(path, "utf8"));
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const badLines = [];
    const hashes = [];
    lines.forEach((line, idx) => {
        try {
            const record = JSON.parse(line);
            const { hash, ...rest } = record;
            const recomputed = fingerprint(canonicalJson(rest));
            if (recomputed !== hash)
                badLines.push(idx);
            else
                hashes.push(hash);
        }
        catch {
            badLines.push(idx);
        }
    });
    return { ok: badLines.length === 0, total: lines.length, badLines, root: fingerprintSet(hashes) };
}
export function historyFor(records, anchorId) {
    return records.filter((r) => r.anchor === anchorId).sort((a, b) => a.ts.localeCompare(b.ts));
}
//# sourceMappingURL=ledger.js.map