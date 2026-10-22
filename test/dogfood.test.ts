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
import { scanMarkers } from "../src/markers.js";
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

describe("relocation after a symbol disappears", () => {
  const relocate = async (before: string, after: string, path = "a.ts", symbol = "parseId") => {
    const dir = await repo({ [path]: before, "A.md": `<!-- lockwire ${path}#${symbol} -->\nIt parses.\n` });
    await linkDoc(dir, "A.md", DEFAULT_CONFIG, actor);
    await writeFile(join(dir, path), after, "utf8");
    return (await check(dir, DEFAULT_CONFIG)).summary;
  };

  it("a deleted function's look-alike neighbour doesn't inherit its claim", async () => {
    const hash = "export function hashName(s: string): number {\n  return s.length * 31;\n}\n";
    const parse = "export function parseId(s: string): number {\n  return Number(s);\n}\n";
    expect(await relocate(parse + hash, hash)).toMatchObject({ relocated: 0, orphaned: 1 });
    const py = "def checksum(text: bytes) -> int:\n    return sum(text)\n";
    expect(
      await relocate(
        `def parse_int(text: bytes) -> int:\n    return int(text)\n\n${py}`,
        py,
        "a.py",
        "parse_int",
      ),
    ).toMatchObject({ relocated: 0, orphaned: 1 });
  });

  it("a real rename (same implementation) is still followed", async () => {
    expect(
      await relocate(
        "export function parseId(s: string): number {\n  return Number(s);\n}\n",
        "export function parseIdentifier(s: string): number {\n  return Number(s);\n}\n",
      ),
    ).toMatchObject({ relocated: 1, orphaned: 0 });
  });
});

describe("markers as real docs write them", () => {
  const one = (doc: string) => scanMarkers(doc).map((x) => ({ target: x.target, tiers: x.tiers, problem: x.problem }));

  it("a tier typo is reported, not dropped in favour of the default", () => {
    expect(one("<!-- lockwire a.ts#f sig,bdy -->\nf.\n")[0]?.problem).toMatch(/unknown tier "bdy"/);
    expect(one("<!-- lockwire a.ts#f body,dep -->\nf.\n")[0]?.problem).toMatch(/"dep"/);
    expect(one("<!-- lockwire a.ts#f sig, body -->\nf.\n")[0]?.tiers).toEqual(["sig", "body"]);
    expect(one("<!-- lockwire a.ts#f sig body -->\nf.\n")[0]?.tiers).toEqual(["sig", "body"]);
  });

  it("markers after a list bullet or in a blockquote are found", () => {
    expect(one("- <!-- lockwire a.ts#f -->\n  f does a thing.\n")).toHaveLength(1);
    expect(one("1. <!-- lockwire a.ts#f -->\n   f does a thing.\n")).toHaveLength(1);
    expect(one("> <!-- lockwire a.ts#f -->\n> f does a thing.\n")).toHaveLength(1);
  });

  it("MDX markers are found and stamped in MDX syntax", async () => {
    const dir = await repo({ "a.ts": "export function f() {}\n", "A.mdx": "{/* lockwire a.ts#f */}\nf.\n" });
    expect((await discoverDocs(dir, DEFAULT_CONFIG))).toContain("A.mdx");
    expect((await linkDoc(dir, "A.mdx", DEFAULT_CONFIG, actor)).created).toBe(1);
    expect(await readFile(join(dir, "A.mdx"), "utf8")).toMatch(/^\{\/\* lockwire a\.ts#f id=\w+ \*\/\}\n/);
  });

  it("an indented code block is an example, and an indented ``` in it opens no fence", () => {
    const doc = "Example:\n\n    <!-- lockwire a.ts#f -->\n    ```\n\n<!-- lockwire a.ts#g -->\ng is live.\n";
    expect(one(doc).map((x) => x.target.symbol)).toEqual(["g"]);
  });

  it("a fence indented inside a list item still hides its example", () => {
    const doc = "- step:\n\n  ```md\n  <!-- lockwire a.ts#f -->\n  f.\n  ```\n";
    expect(one(doc)).toEqual([]);
  });

  it("a marker at the end of a doc with no claim after it is reported", async () => {
    const dir = await repo({ "a.ts": "export function f() {}\n", "A.md": "# A\n\n<!-- lockwire a.ts#f -->\n" });
    const linked = await linkDoc(dir, "A.md", DEFAULT_CONFIG, actor);
    expect(linked.skipped[0]?.reason).toBe("no claim follows the marker");
    expect((await check(dir, DEFAULT_CONFIG)).unlinked[0]?.reason).toBe(
      "not linked: no claim follows the marker",
    );
  });
});
