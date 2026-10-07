import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, linkDoc } from "../src/actions.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const SESSION_TS = `export async function createSession(userId: UserId, ttl = 3600): Promise<Session> {
  const token = mint(userId);
  return { token, ttl };
}
`;

const CLAUDE_MD = `# Auth

<!-- lockwire src/session.ts#createSession sig -->
\`createSession\` takes a \`UserId\` and returns a \`Session\`.
`;

async function tempRepo() {
  const repo = await mkdtemp(join(tmpdir(), "lockwire-e2e-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "session.ts"), SESSION_TS, "utf8");
  await writeFile(join(repo, "CLAUDE.md"), CLAUDE_MD, "utf8");
  return repo;
}

describe("end-to-end: the P0 falsification demo", () => {
  it("a body-only refactor does not drift a sig-bound claim, and the noise metric shows why", async () => {
    const repo = await tempRepo();
    const actor = { type: "human" as const };

    const linked = await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    expect(linked.created).toBe(1);

    // A pure body refactor: same signature, different implementation.
    await writeFile(
      join(repo, "src", "session.ts"),
      `export async function createSession(userId: UserId, ttl = 3600): Promise<Session> {
  const token = mint(userId);
  audit("session-created", userId);
  return { token, ttl };
}
`,
      "utf8",
    );

    const result = await check(repo, DEFAULT_CONFIG);
    expect(result.summary.drifted).toBe(0); // the sig-bound claim survives — this is the whole thesis
    expect(result.summary.noise.singleHashWouldFlag).toBe(1); // a single-hash tool would have flagged it
    expect(result.summary.noise.tieredFlagged).toBe(0);
    expect(result.summary.noise.reductionPercent).toBe(100);
  });

  it("a real signature change does drift the claim", async () => {
    const repo = await tempRepo();
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });

    await writeFile(
      join(repo, "src", "session.ts"),
      `export async function createSession(userId: UserId, ttl: number = 3600, opts?: { silent: boolean }): Promise<Session> {
  const token = mint(userId);
  return { token, ttl };
}
`,
      "utf8",
    );

    const result = await check(repo, DEFAULT_CONFIG);
    expect(result.summary.drifted).toBe(1);
    expect(result.results[0]!.driftedTiers).toEqual(["sig"]);
  });

  it("a second `check` with no further changes is stable (idempotent)", async () => {
    const repo = await tempRepo();
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });
    const first = await check(repo, DEFAULT_CONFIG);
    const second = await check(repo, DEFAULT_CONFIG);
    expect(first.summary).toEqual(second.summary);
  });
});

describe("same-file rename relocation", () => {
  const actor = { type: "human" as const };

  it("relinks a renamed function instead of orphaning it", async () => {
    const repo = await tempRepo();
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    await writeFile(join(repo, "src", "session.ts"), SESSION_TS.replace("createSession", "openSession"), "utf8");

    const { results } = await check(repo, DEFAULT_CONFIG);
    expect(results[0]?.status).toBe("fresh");
    expect(results[0]?.anchor.target.symbol).toBe("openSession");
  });

  it("does not relink to a look-alike symbol that another anchor already binds", async () => {
    const repo = await tempRepo();
    const twin = "export async function twin(userId: UserId, ttl = 3600): Promise<Session> {\n  return mint(userId);\n}\n";
    await writeFile(join(repo, "src", "session.ts"), SESSION_TS + twin, "utf8");
    await writeFile(
      join(repo, "CLAUDE.md"),
      `${CLAUDE_MD}\n<!-- lockwire src/session.ts#twin sig -->\n\`twin\` is the same shape.\n`,
      "utf8",
    );
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    await writeFile(join(repo, "src", "session.ts"), twin, "utf8"); // createSession deleted

    const { results } = await check(repo, DEFAULT_CONFIG);
    const gone = results.find((r) => r.anchor.target.symbol === "createSession");
    expect(gone?.status).toBe("orphaned");
  });

  it("does not relink when two symbols could be the rename target", async () => {
    const repo = await tempRepo();
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    const sameShape = (n: string) =>
      `export async function ${n}(userId: UserId, ttl = 3600): Promise<Session> {\n  return mint(userId);\n}\n`;
    await writeFile(join(repo, "src", "session.ts"), sameShape("a") + sameShape("b"), "utf8");

    const { results } = await check(repo, DEFAULT_CONFIG);
    expect(results[0]?.status).toBe("orphaned");
  });
});

describe("claim-side drift", () => {
  const actor = { type: "human" as const };
  const SENTENCE = "`createSession` takes a `UserId` and returns a `Session`.";
  const doc = (body: string) =>
    `# Auth\n\n<!-- lockwire src/session.ts#createSession sig id=ABC12345 -->\n${body}\n`;

  async function linked() {
    const repo = await tempRepo();
    await writeFile(join(repo, "CLAUDE.md"), doc(SENTENCE), "utf8");
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    return repo;
  }
  const only = async (repo: string, paths?: string[]) =>
    (await check(repo, DEFAULT_CONFIG, paths)).results[0]!;

  it("flags a rewritten claim even though the code is untouched, and a plain re-link clears it", async () => {
    const repo = await linked();
    expect((await only(repo)).status).toBe("fresh");

    await writeFile(join(repo, "CLAUDE.md"), doc("`createSession` takes a `TenantId`."), "utf8");
    const r = await only(repo);
    expect(r.status).toBe("drifted");
    expect(r.claimChanged).toBe(true);
    expect(r.driftedTiers).toEqual([]);

    const relinked = await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor); // no --reviewed
    expect(relinked.refreshed).toBe(1);
    expect((await only(repo)).status).toBe("fresh");
  });

  it("logs the claim drift once, not on every check", async () => {
    const repo = await linked();
    await writeFile(join(repo, "CLAUDE.md"), doc("Something else entirely."), "utf8");
    await check(repo, DEFAULT_CONFIG);
    await check(repo, DEFAULT_CONFIG);
    const ledger = await readFile(join(repo, ".lockwire", "ledger.jsonl"), "utf8");
    expect(ledger.match(/claim text changed/g)).toHaveLength(1);
  });

  it("ignores re-wrapping and whitespace changes", async () => {
    const repo = await linked();
    await writeFile(
      join(repo, "CLAUDE.md"),
      doc("`createSession`   takes a `UserId`\nand returns a   `Session`.  "),
      "utf8",
    );
    expect((await only(repo)).status).toBe("fresh");
  });

  it("does not flag existing anchors that predate normHash, unless the sentence really changed", async () => {
    const repo = await linked();
    const lockPath = join(repo, "lockwire.lock");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    delete lock.anchors[0].claim.normHash;
    await writeFile(lockPath, JSON.stringify(lock), "utf8");

    await writeFile(join(repo, "CLAUDE.md"), doc(SENTENCE.replace(" and ", "\nand ")), "utf8");
    expect((await only(repo)).status).toBe("fresh");

    await writeFile(join(repo, "CLAUDE.md"), doc("`createSession` is deprecated."), "utf8");
    expect((await only(repo)).claimChanged).toBe(true);
  });

  it("orphans an anchor whose marker was deleted, and relinking after restoring it recovers", async () => {
    const repo = await linked();
    await writeFile(join(repo, "CLAUDE.md"), "# Auth\n\nNo claims here any more.\n", "utf8");
    const r = await only(repo);
    expect(r.status).toBe("orphaned");
    expect(r.claimChanged).toBe(true);

    await rm(join(repo, "CLAUDE.md"));
    expect((await only(repo)).status).toBe("orphaned"); // missing doc, no crash

    await writeFile(join(repo, "CLAUDE.md"), doc(SENTENCE), "utf8");
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    expect((await only(repo)).status).toBe("fresh");
  });

  it("returns to fresh when the original sentence is restored", async () => {
    const repo = await linked();
    await writeFile(join(repo, "CLAUDE.md"), doc("Changed."), "utf8");
    expect((await only(repo)).status).toBe("drifted");
    await writeFile(join(repo, "CLAUDE.md"), doc(SENTENCE), "utf8");
    expect((await only(repo)).status).toBe("fresh");
  });

  it("still requires --reviewed to re-stamp when the code drifted too", async () => {
    const repo = await linked();
    await writeFile(join(repo, "CLAUDE.md"), doc("Changed."), "utf8");
    await writeFile(
      join(repo, "src", "session.ts"),
      SESSION_TS.replace("ttl = 3600", "ttl = 3600, extra = 1"),
      "utf8",
    );
    expect((await only(repo)).status).toBe("drifted");
    const blocked = await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    expect(blocked.skipped[0]?.reason).toMatch(/--reviewed/);
    const ok = await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor, { reviewed: true });
    expect(ok.refreshed).toBe(1);
  });

  it("checks an anchor when its doc is the touched path, so editing the doc is caught", async () => {
    const repo = await linked();
    await writeFile(join(repo, "CLAUDE.md"), doc("Changed."), "utf8");
    expect((await only(repo, ["unrelated.ts"])).claimChanged).toBeUndefined(); // out of scope: not examined
    expect((await only(repo, ["CLAUDE.md"])).claimChanged).toBe(true);
  });
});
