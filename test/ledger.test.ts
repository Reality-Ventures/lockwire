import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, ledgerPath, readLedger, verifyLedger } from "../src/ledger.js";

let dirs: string[] = [];
async function tempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-ledger-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  dirs = [];
});

describe("ledger", () => {
  it("appends events and verifies their hashes round-trip", async () => {
    const repo = await tempRepo();
    await appendEvent(repo, { ts: "2026-09-25T10:00:00Z", event: "anchor.created", anchor: "abc12345", actor: { type: "ai", tool: { name: "claude-code" } }, commit: null });
    await appendEvent(repo, { ts: "2026-09-25T10:05:00Z", event: "anchor.drifted", anchor: "abc12345", actor: { type: "ai", tool: { name: "claude-code" } }, tier: "sig", from: "b3:aaa", to: "b3:bbb", commit: "e4f8a2c" });

    const records = await readLedger(repo);
    expect(records).toHaveLength(2);
    expect(records[1]!.event).toBe("anchor.drifted");

    const verified = await verifyLedger(repo);
    expect(verified.ok).toBe(true);
    expect(verified.total).toBe(2);
  });

  it("catches a tampered line", async () => {
    const repo = await tempRepo();
    await appendEvent(repo, { ts: "2026-09-25T10:00:00Z", event: "anchor.created", anchor: "abc12345", actor: { type: "human" }, commit: null });
    const raw = await readFile(ledgerPath(repo), "utf8");
    const tampered = raw.replace('"anchor.created"', '"anchor.orphaned"'); // change payload, keep the old hash
    await writeFile(ledgerPath(repo), tampered, "utf8");

    const verified = await verifyLedger(repo);
    expect(verified.ok).toBe(false);
    expect(verified.badLines).toEqual([0]);
  });

  it("the ledger root is order-independent, as required for git-notes union merge (§5.2)", async () => {
    // Two lines written in opposite order — exactly what `git notes merge -s cat_sort_uniq` can produce
    // when two branches each append an event. The root must match regardless, since ordering is no
    // longer part of the tamper-evidence claim (commit SHAs and timestamps supply ordering instead).
    const repoA = await tempRepo();
    const e1 = await appendEvent(repoA, { ts: "2026-01-01T00:00:00Z", event: "anchor.created", anchor: "a1", actor: { type: "human" }, commit: null });
    const e2 = await appendEvent(repoA, { ts: "2026-01-02T00:00:00Z", event: "anchor.created", anchor: "a2", actor: { type: "human" }, commit: null });
    const forwardRoot = (await verifyLedger(repoA)).root;

    const repoB = await tempRepo();
    await mkdir(join(repoB, ".lockwire"), { recursive: true });
    await writeFile(ledgerPath(repoB), `${JSON.stringify(e2)}\n${JSON.stringify(e1)}\n`, "utf8");
    const reversedRoot = (await verifyLedger(repoB)).root;

    expect(forwardRoot).toBe(reversedRoot);
  });
});
