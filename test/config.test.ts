import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const claim = (name: string) =>
  `# ${name}\n\n<!-- lockwire src/a.ts#alpha sig -->\n${name} says alpha adds one.\n`;

describe("no dead configuration", () => {
  const leaves = (o: Record<string, unknown>, prefix = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? leaves(v as Record<string, unknown>, `${prefix}${k}.`)
        : [`${prefix}${k}`],
    );
  const srcFiles = readdirSync(join(ROOT, "src")).filter(
    (f) => f.endsWith(".ts") && !["types.ts", "config.ts"].includes(f),
  );
  const consumers = srcFiles.map((f) => readFileSync(join(ROOT, "src", f), "utf8")).join("\n");

  it.each(
    leaves(DEFAULT_CONFIG as unknown as Record<string, unknown>).filter((k) => k !== "version"),
  )("config key `%s` is read somewhere other than where it is defined", (key) => {
    const leaf = key.split(".").pop() ?? key;
    expect(
      new RegExp(`\\.${leaf}\\b`).test(consumers),
      `${key} is written to every config.json by \`init\` but nothing in src/ reads it — wire it up or remove it`,
    ).toBe(true);
  });
});

describe.skipIf(!existsSync(CLI))("`lockwire link` with no argument links the docs the config selects", () => {
  const cli = (cwd: string, args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

  async function repo(config?: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-linkall-"));
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "docs"));
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), A_TS, "utf8");
    await writeFile(join(dir, "CLAUDE.md"), claim("CLAUDE"), "utf8");
    await writeFile(join(dir, "docs", "guide.md"), claim("guide"), "utf8");
    await writeFile(join(dir, "docs", "plain.md"), "# Plain\n\nNo markers here.\n", "utf8");
    await writeFile(join(dir, "CHANGELOG.md"), claim("CHANGELOG"), "utf8");
    await writeFile(join(dir, "node_modules", "pkg", "README.md"), claim("vendored"), "utf8");
    await writeFile(
      join(dir, "README.md"),
      "# R\n\nAn example:\n\n```markdown\n<!-- lockwire src/a.ts#alpha sig -->\nexample claim.\n```\n",
      "utf8",
    );
    cli(dir, ["init"]);
    if (config) {
      const path = join(dir, ".lockwire", "config.json");
      await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), ...config }), "utf8");
    }
    return dir;
  }
  const linkedDocs = async (dir: string) =>
    (JSON.parse(await readFile(join(dir, "lockwire.lock"), "utf8")).anchors as { doc: string }[])
      .map((a) => a.doc)
      .sort();

  it("with the defaults: docs with markers are linked; excluded, vendored, marker-less and example-only docs are not", async () => {
    const dir = await repo();
    const before = {
      plain: await readFile(join(dir, "docs", "plain.md"), "utf8"),
      changelog: await readFile(join(dir, "CHANGELOG.md"), "utf8"),
      readme: await readFile(join(dir, "README.md"), "utf8"),
      vendored: await readFile(join(dir, "node_modules", "pkg", "README.md"), "utf8"),
    };
    const run = cli(dir, ["link"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("CLAUDE.md: 1 created");
    expect(run.stdout).toContain("docs/guide.md: 1 created");
    expect(run.stdout).toContain("2 docs: 2 created, 0 refreshed");
    expect(await linkedDocs(dir)).toEqual(["CLAUDE.md", "docs/guide.md"]);
    expect(await readFile(join(dir, "docs", "plain.md"), "utf8")).toBe(before.plain);
    expect(await readFile(join(dir, "CHANGELOG.md"), "utf8")).toBe(before.changelog);
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe(before.readme);
    expect(await readFile(join(dir, "node_modules", "pkg", "README.md"), "utf8")).toBe(before.vendored);
  });

  it("`docs` narrows the scan", async () => {
    const dir = await repo({ docs: ["docs/**/*.md"] });
    cli(dir, ["link"]);
    expect(await linkedDocs(dir)).toEqual(["docs/guide.md"]);
  });

  it("`exclude` removes docs from it", async () => {
    const dir = await repo({ exclude: ["docs/**", "node_modules/**"] });
    cli(dir, ["link"]);
    expect(await linkedDocs(dir)).toEqual(["CHANGELOG.md", "CLAUDE.md"]);
  });

  it("naming a doc explicitly ignores `docs` and `exclude`", async () => {
    const dir = await repo();
    expect(cli(dir, ["link", "CHANGELOG.md"]).status).toBe(0);
    expect(await linkedDocs(dir)).toEqual(["CHANGELOG.md"]);
  });

  it("running it again refreshes and leaves the files byte-for-byte alone", async () => {
    const dir = await repo();
    cli(dir, ["link"]);
    const claude = await readFile(join(dir, "CLAUDE.md"), "utf8");
    const second = cli(dir, ["link"]);
    expect(second.stdout).toContain("2 docs: 0 created, 2 refreshed");
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(claude);
  });

  it("`--reviewed` is passed through, so one command re-stamps everything that drifted", async () => {
    const dir = await repo();
    cli(dir, ["link"]);
    await writeFile(join(dir, "src", "a.ts"), A_TS.replace("(x: number)", "(x: number, y: number)"), "utf8");
    cli(dir, ["check"]);
    const blocked = cli(dir, ["link"]);
    expect(blocked.stdout).toContain("2 skipped");
    expect(blocked.stdout).toContain("--reviewed");
    expect(cli(dir, ["link", "--reviewed"]).stdout).toContain("2 docs: 0 created, 2 refreshed");
    expect(cli(dir, ["check"]).status).toBe(0);
  });

  it("says so, rather than succeeding silently, when nothing matches", async () => {
    const dir = await repo({ docs: ["nothing/**/*.md"] });
    const run = cli(dir, ["link"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no docs with lockwire markers found");
    expect(run.stdout).toContain("nothing/**/*.md");
    expect(existsSync(join(dir, "lockwire.lock"))).toBe(true);
    expect(await linkedDocs(dir)).toEqual([]);
  });
});
