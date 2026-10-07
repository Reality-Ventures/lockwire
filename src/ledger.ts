import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { headCommit } from "./changed.js";
import { canonicalJson, fingerprint, fingerprintSet } from "./hash.js";
import { stripBom } from "./repo.js";
import type { LedgerRecord } from "./types.js";

export function ledgerPath(repoRoot: string): string {
  return `${repoRoot}/.lockwire/ledger.jsonl`;
}

function eventId(): string {
  // Not a real ULID library dependency for v0.1 — monotonic-enough for a local, single-writer append.
  // Sortable by time; uniqueness comes from the timestamp + a short random suffix.
  const time = Date.now().toString(36).padStart(9, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${time}${rand}`.toUpperCase();
}

export async function appendEvent(
  repoRoot: string,
  record: Omit<LedgerRecord, "v" | "id" | "hash">,
): Promise<LedgerRecord> {
  // Callers that don't know a commit pass null; record the HEAD the event happened on, when there is one.
  const commit = record.commit ?? headCommit(repoRoot);
  const withoutHash: Omit<LedgerRecord, "hash"> = { v: 1, id: eventId(), ...record, commit };
  const hash = fingerprint(canonicalJson(withoutHash));
  const full: LedgerRecord = { ...withoutHash, hash };
  const path = ledgerPath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

export async function readLedger(repoRoot: string): Promise<LedgerRecord[]> {
  const path = ledgerPath(repoRoot);
  if (!existsSync(path)) return [];
  const raw = stripBom(await readFile(path, "utf8"));
  const records: LedgerRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch {
      // malformed line: `ledger verify` reports this explicitly; readers skip it rather than crash
    }
  }
  return records;
}

export interface VerifyResult {
  ok: boolean;
  total: number;
  badLines: number[]; // 0-indexed
  root: string; // BLAKE3 over the sorted set of event hashes — order-independent by design (see §5.2)
}

export async function verifyLedger(repoRoot: string): Promise<VerifyResult> {
  const path = ledgerPath(repoRoot);
  if (!existsSync(path)) return { ok: true, total: 0, badLines: [], root: fingerprintSet([]) };
  const raw = stripBom(await readFile(path, "utf8"));
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const badLines: number[] = [];
  const hashes: string[] = [];

  lines.forEach((line, idx) => {
    try {
      const record = JSON.parse(line) as LedgerRecord;
      const { hash, ...rest } = record;
      const recomputed = fingerprint(canonicalJson(rest));
      if (recomputed !== hash) badLines.push(idx);
      else hashes.push(hash);
    } catch {
      badLines.push(idx);
    }
  });

  return { ok: badLines.length === 0, total: lines.length, badLines, root: fingerprintSet(hashes) };
}

export function historyFor(records: LedgerRecord[], anchorId: string): LedgerRecord[] {
  return records.filter((r) => r.anchor === anchorId).sort((a, b) => a.ts.localeCompare(b.ts));
}
