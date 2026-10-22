// Regressions found by running lockwire on real public repositories (ky, hono, zod, httpx, click,
// requests, pydantic, express, jotai, simple-evals). Each test is the minimal repro of one finding.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check, discoverDocs, linkDoc } from "../src/actions.js";
import { readLedger } from "../src/ledger.js";
import { readLockfile } from "../src/lockfile.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const actor = { type: "human" as const };

async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-dogfood-"));
  await mkdir(join(dir, ".git"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text, "utf8");
  }
  return dir;
}

describe("the --reviewed gate", () => {
  it("refuses to re-stamp changed code even when no check has recorded the drift yet", async () => {
    const dir = await repo({
      "a.js": "export function f(a) {\n  return a;\n}\n",
      "A.md": "<!-- lockwire a.js#f -->\nf takes a.\n",
    });
    expect((await linkDoc(dir, "A.md", DEFAULT_CONFIG, actor)).created).toBe(1);
    await writeFile(join(dir, "a.js"), "export function f(a, b) {\n  return a;\n}\n", "utf8");

    const blocked = await linkDoc(dir, "A.md", DEFAULT_CONFIG, actor);
    expect(blocked.refreshed).toBe(0);
    expect(blocked.skipped[0]).toMatchObject({ target: "a.js#f" });
    expect(blocked.skipped[0]?.reason).toMatch(/--reviewed/);
    expect((await linkDoc(dir, "A.md", DEFAULT_CONFIG, actor, { reviewed: true })).refreshed).toBe(
      1,
    );
  });

  it("lets a value anchor re-link once its sentence states the new value", async () => {
    const dir = await repo({
      "m.json": '{"acc": 0.18}\n',
      "A.md": "<!-- lockwire m.json#acc -->\nAccuracy is 0.18.\n",
    });
    await linkDoc(dir, "A.md", DEFAULT_CONFIG, actor);
    await writeFile(join(dir, "m.json"), '{"acc": 0.24}\n', "utf8");
    await writeFile(
      join(dir, "A.md"),
      (await readFile(join(dir, "A.md"), "utf8")).replace("0.18", "0.24"),
    );
    expect((await linkDoc(dir, "A.md", DEFAULT_CONFIG, actor)).refreshed).toBe(1);
  });
});

describe("re-linking an unchanged doc", () => {
  it("writes nothing: no new timestamps, no ledger events", async () => {
    const dir = await repo({
      "a.ts": "export function f(x: number): number {\n  return x;\n}\n",
      "A.md": "<!-- lockwire a.ts#f -->\nf takes x.\n",
    });
    await linkDoc(dir, "A.md", DEFAULT_CONFIG, actor);
    const lockBefore = await readFile(join(dir, "lockwire.lock"), "utf8");
    const eventsBefore = (await readLedger(dir)).length;

    expect(await linkDoc(dir, "A.md", DEFAULT_CONFIG, actor)).toMatchObject({
      created: 0,
      refreshed: 0,
      unchanged: 1,
    });
    expect(await readFile(join(dir, "lockwire.lock"), "utf8")).toBe(lockBefore);
    expect((await readLedger(dir)).length).toBe(eventsBefore);
  });
});

describe("symlinked docs", () => {
  async function linkedRepo() {
    const dir = await repo({
      "a.ts": "export function f(x: number): number {\n  return x;\n}\n",
      "packages/pkg/README.md": "<!-- lockwire a.ts#f -->\nf takes x.\n",
    });
    await symlink("packages/pkg/README.md", join(dir, "README.md"));
    return dir;
  }

  it("discovery skips the link, so every claim is bound once", async () => {
    const dir = await linkedRepo();
    expect(await discoverDocs(dir, DEFAULT_CONFIG)).toEqual(["packages/pkg/README.md"]);
  });

  it("linking through the link binds the real doc and keeps the link a link", async () => {
    const dir = await linkedRepo();
    expect((await linkDoc(dir, "README.md", DEFAULT_CONFIG, actor)).created).toBe(1);
    expect(lstatSync(join(dir, "README.md")).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, "packages/pkg/README.md"), "utf8")).toMatch(/id=/);
    expect((await readLockfile(dir)).anchors.map((a) => a.doc)).toEqual(["packages/pkg/README.md"]);
    // ...and naming the real file afterwards finds the same anchor rather than a second one.
    expect(await linkDoc(dir, "packages/pkg/README.md", DEFAULT_CONFIG, actor)).toMatchObject({
      created: 0,
      unchanged: 1,
    });
  });
});

describe("unlinked markers that link can't fix", () => {
  it("say the target file is missing instead of 'not linked yet'", async () => {
    const dir = await repo({ "A.md": "<!-- lockwire gone.ts#f -->\nf is gone.\n" });
    const { unlinked } = await check(dir, DEFAULT_CONFIG);
    expect(unlinked[0]?.reason).toBe("not linked: gone.ts doesn't exist");
  });
});

describe.skipIf(!existsSync(CLI))("CLI messages and exit codes", () => {
  const cli = (cwd: string, args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

  it("`link` exits non-zero when it leaves a marker unlinked", async () => {
    const dir = await repo({ "A.md": "<!-- lockwire gone.ts#f -->\nf is gone.\n" });
    const out = cli(dir, ["link", "A.md"]);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("skipped gone.ts#f");
  });

  it("`check` refuses a path that doesn't exist instead of passing on nothing", async () => {
    const dir = await repo({ "a.ts": "export function f() {}\n" });
    const out = cli(dir, ["check", "nonexistent.ts"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("nonexistent.ts doesn't exist");
  });

  it("`history` says when nothing matches", async () => {
    const dir = await repo({ "a.ts": "export function f() {}\n" });
    const out = cli(dir, ["history", "bogus"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("no history for bogus");
  });

  it("names CLI commands, not MCP tools", async () => {
    const dir = await repo({ "a.ts": "export function f() {}\n" });
    const out = cli(dir, ["resolve", "nosuch"]);
    expect(out.stderr).toContain("`lockwire tasks`");
    expect(out.stderr).not.toContain("lockwire_tasks");
  });

  it("`waive` refuses a day that doesn't exist", async () => {
    const dir = await repo({
      "a.ts": "export function f() {}\n",
      "A.md": "<!-- lockwire a.ts#f -->\nf.\n",
    });
    cli(dir, ["link", "A.md"]);
    const id = (await readLockfile(dir)).anchors[0]?.id ?? "";
    const out = cli(dir, ["waive", id, "--reason", "r", "--expires", "2099-02-31"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("invalid --expires");
  });

  it("`ledger verify` reports bad lines 1-indexed", async () => {
    const dir = await repo({
      "a.ts": "export function f() {}\n",
      "A.md": "<!-- lockwire a.ts#f -->\nf.\n",
    });
    cli(dir, ["link", "A.md"]);
    const ledger = join(dir, ".lockwire", "ledger.jsonl");
    await writeFile(ledger, (await readFile(ledger, "utf8")).replace('"anchor.created"', '"x"'));
    expect(cli(dir, ["ledger", "verify"]).stdout).toContain("bad line(s): 1");
  });
});
