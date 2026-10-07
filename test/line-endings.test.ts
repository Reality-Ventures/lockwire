import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, linkDoc } from "../src/actions.js";
import { readConfig } from "../src/config.js";
import { verifyLedger } from "../src/ledger.js";
import { readLockfile } from "../src/lockfile.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const BOM = "﻿";
const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const MARKER = "<!-- lockwire src/a.ts#alpha sig -->";

async function repoWithDoc(doc: string) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-eol-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), A_TS, "utf8");
  await writeFile(join(dir, "CLAUDE.md"), doc, "utf8");
  return dir;
}
const link = (dir: string) => linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });

describe("stamping preserves the document's line endings", () => {
  it("a CRLF doc stays CRLF and only the marker line changes", async () => {
    const dir = await repoWithDoc(`# Auth\r\n\r\n${MARKER}\r\nalpha adds one.\r\n\r\nOther prose.\r\n`);
    await link(dir);
    const after = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(after).not.toMatch(/[^\r]\n/);
    expect(after).toMatch(
      /^# Auth\r\n\r\n<!-- lockwire src\/a\.ts#alpha sig id=\w+ -->\r\nalpha adds one\.\r\n\r\nOther prose\.\r\n$/,
    );
    expect((await check(dir, DEFAULT_CONFIG)).results[0]?.status).toBe("fresh");
  });

  it("mixed endings are kept exactly as they were, line by line", async () => {
    const dir = await repoWithDoc(`# Auth\n\r\n${MARKER}\r\nalpha adds one.\nTrailing line.\r\n`);
    await link(dir);
    const after = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(after.replace(/id=\w+/, "id=X")).toBe(
      `# Auth\n\r\n<!-- lockwire src/a.ts#alpha sig id=X -->\r\nalpha adds one.\nTrailing line.\r\n`,
    );
  });

  it("a doc with no trailing newline doesn't gain one, LF docs are unchanged apart from the marker", async () => {
    const lf = await repoWithDoc(`# Auth\n\n${MARKER}\nalpha adds one.`);
    await link(lf);
    const after = await readFile(join(lf, "CLAUDE.md"), "utf8");
    expect(after).toMatch(/^# Auth\n\n<!-- lockwire src\/a\.ts#alpha sig id=\w+ -->\nalpha adds one\.$/);
  });

  it("re-linking an already-stamped CRLF doc leaves the file byte-for-byte alone", async () => {
    const dir = await repoWithDoc(`# Auth\r\n\r\n${MARKER}\r\nalpha adds one.\r\n`);
    await link(dir);
    const once = await readFile(join(dir, "CLAUDE.md"), "utf8");
    await link(dir);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(once);
  });

  it("an indented marker (inside a list item) keeps its indentation when stamped", async () => {
    const dir = await repoWithDoc(`- step one\n\n  ${MARKER}\n  alpha adds one.\n`);
    await link(dir);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toMatch(
      /^- step one\n\n {2}<!-- lockwire src\/a\.ts#alpha sig id=\w+ -->\n {2}alpha adds one\.\n$/,
    );
  });

  it("a BOM at the start of a doc survives stamping and doesn't hide a marker on line 1", async () => {
    const dir = await repoWithDoc(`${BOM}${MARKER}\nalpha adds one.\n`);
    const result = await link(dir);
    expect(result.created).toBe(1);
    expect((await readFile(join(dir, "CLAUDE.md"), "utf8")).startsWith(BOM)).toBe(true);
  });

});

describe("UTF-8 BOM in lockwire's own JSON files", () => {
  it("reads a lockfile that starts with a BOM, and still names a merge conflict inside one", async () => {
    const dir = await repoWithDoc("");
    await writeFile(join(dir, "lockwire.lock"), `${BOM}{"version":1,"anchors":[]}`, "utf8");
    expect((await readLockfile(dir)).anchors).toEqual([]);

    await writeFile(
      join(dir, "lockwire.lock"),
      `${BOM}{\n<<<<<<< HEAD\n"anchors": []\n=======\n"anchors": [{}]\n>>>>>>> x\n}\n`,
      "utf8",
    );
    await expect(readLockfile(dir)).rejects.toThrow(/unresolved merge conflicts/);
  });

  it("reads a config.json that starts with a BOM", async () => {
    const dir = await repoWithDoc("");
    await mkdir(join(dir, ".lockwire"));
    await writeFile(
      join(dir, ".lockwire", "config.json"),
      `${BOM}{"version":1,"hook":{"mode":"ask"}}`,
      "utf8",
    );
    expect((await readConfig(dir)).hook.mode).toBe("ask");
  });

  it("verifies a ledger whose first line starts with a BOM", async () => {
    const dir = await repoWithDoc(`${MARKER}\nalpha adds one.\n`);
    await link(dir); // writes a real, hashed ledger event
    const path = join(dir, ".lockwire", "ledger.jsonl");
    await writeFile(path, `${BOM}${await readFile(path, "utf8")}`, "utf8");
    const result = await verifyLedger(dir);
    expect(result.ok).toBe(true);
    expect(result.total).toBeGreaterThan(0);
  });

  it("the whole flow works from a BOM'd lockfile: check reads it and rewrites it without one", async () => {
    const dir = await repoWithDoc(`${MARKER}\nalpha adds one.\n`);
    await link(dir);
    const lockPath = join(dir, "lockwire.lock");
    await writeFile(lockPath, `${BOM}${await readFile(lockPath, "utf8")}`, "utf8");
    await writeFile(join(dir, "src", "a.ts"), A_TS.replace("(x: number)", "(x: number, y: number)"), "utf8");
    const res = (await check(dir, DEFAULT_CONFIG)).results[0];
    expect(res?.status).toBe("drifted");
    expect((await readFile(lockPath, "utf8")).startsWith(BOM)).toBe(false);
  });
});
