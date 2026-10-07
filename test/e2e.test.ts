import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, linkDoc, waive } from "../src/actions.js";
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

describe("regressions found by adversarial testing", () => {
  const actor = { type: "human" as const };
  const mdDoc = (marker: string, sentence = "`createSession` takes a `UserId`.") =>
    `# Auth\n\n${marker}\n${sentence}\n`;

  it("a rename combined with a change to a bound tier is reported as drift, not laundered as fresh", async () => {
    const repo = await tempRepo();
    await writeFile(
      join(repo, "CLAUDE.md"),
      mdDoc("<!-- lockwire src/session.ts#createSession sig,body -->"),
      "utf8",
    );
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);

    await writeFile(
      join(repo, "src", "session.ts"),
      SESSION_TS.replace("createSession", "openSession").replace("mint(userId)", "forge(userId)"),
      "utf8",
    );
    const first = (await check(repo, DEFAULT_CONFIG)).results[0]!;
    expect(first.anchor.target.symbol).toBe("openSession");
    expect(first.status).toBe("drifted");
    expect(first.driftedTiers).toEqual(["body"]);

    // ...and it stays visible on the next check instead of disappearing.
    expect((await check(repo, DEFAULT_CONFIG)).results[0]?.status).toBe("drifted");
  });

  it("a marker copied into a second doc gets its own anchor and doesn't take over the original", async () => {
    const repo = await tempRepo();
    const marker = "<!-- lockwire src/session.ts#createSession sig id=ORIG0001 -->";
    await writeFile(join(repo, "CLAUDE.md"), mdDoc(marker), "utf8");
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);

    await mkdir(join(repo, "docs"));
    await writeFile(join(repo, "docs", "copy.md"), mdDoc(marker), "utf8");
    const copied = await linkDoc(repo, "docs/copy.md", DEFAULT_CONFIG, actor);
    expect(copied.created).toBe(1);

    const { results } = await check(repo, DEFAULT_CONFIG);
    expect(results).toHaveLength(2);

    // The original sentence is still being watched.
    await writeFile(join(repo, "CLAUDE.md"), mdDoc(marker, "Something false now."), "utf8");
    const after = (await check(repo, DEFAULT_CONFIG)).results.find((r) => r.anchor.id === "ORIG0001");
    expect(after?.claimChanged).toBe(true);
  });

  it("moving a doc (original no longer has the marker) keeps the same anchor", async () => {
    const repo = await tempRepo();
    const marker = "<!-- lockwire src/session.ts#createSession sig id=ORIG0002 -->";
    await writeFile(join(repo, "CLAUDE.md"), mdDoc(marker), "utf8");
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);

    await rm(join(repo, "CLAUDE.md"));
    await writeFile(join(repo, "AGENTS.md"), mdDoc(marker), "utf8");
    const moved = await linkDoc(repo, "AGENTS.md", DEFAULT_CONFIG, actor);
    expect(moved.refreshed).toBe(1);
    const { results } = await check(repo, DEFAULT_CONFIG);
    expect(results).toHaveLength(1);
    expect(results[0]?.anchor.doc).toBe("AGENTS.md");
  });

  it("a waiver must have a parseable, future expiry, and an unparseable stored one counts as expired", async () => {
    const repo = await tempRepo();
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    const [anchor] = (await check(repo, DEFAULT_CONFIG)).results;
    const id = anchor!.anchor.id;

    await expect(waive(repo, id, "r", "never", actor)).rejects.toThrow(/invalid --expires/);
    await expect(waive(repo, id, "r", "2001-01-01", actor)).rejects.toThrow(/in the past/);

    const lockPath = join(repo, "lockwire.lock");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    Object.assign(lock.anchors[0], {
      status: "waived",
      waiver: { reason: "old", expires: "never", by: actor },
    });
    await writeFile(lockPath, JSON.stringify(lock), "utf8");
    expect((await check(repo, DEFAULT_CONFIG)).results[0]?.status).not.toBe("waived");

    await waive(repo, id, "ok", "2999-01-01", actor);
    expect((await check(repo, DEFAULT_CONFIG)).results[0]?.status).toBe("waived");
  });

  it("an unsupported-language target is skipped with a reason and the rest of the doc still links", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "main.go"), "package main\nfunc Main() {}\n", "utf8");
    await writeFile(
      join(repo, "CLAUDE.md"),
      `# D\n\n<!-- lockwire main.go#Main sig -->\ngo claim.\n\n${CLAUDE_MD.split("\n").slice(2).join("\n")}`,
      "utf8",
    );
    const linkedResult = await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    expect(linkedResult.created).toBe(1);
    expect(linkedResult.skipped).toHaveLength(1);
    expect(linkedResult.skipped[0]?.reason).toMatch(/supports TypeScript/);
  });
});
