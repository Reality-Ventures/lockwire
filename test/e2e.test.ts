import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
