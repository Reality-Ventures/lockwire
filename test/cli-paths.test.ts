import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp-server.js";
import { toRepoPath } from "../src/repo.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const DOC = "# D\n\n<!-- lockwire src/a.ts#alpha sig,body -->\nalpha adds one.\n";

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-paths-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "docs"));
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, "src", "a.ts"), A_TS, "utf8");
  await writeFile(join(dir, "CLAUDE.md"), DOC, "utf8");
  await writeFile(join(dir, "docs", "guide.md"), DOC, "utf8");
  return dir;
}
const cli = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
const docsIn = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, "lockwire.lock"), "utf8")).anchors as { doc: string }[]).map(
    (a) => a.doc,
  );

describe("toRepoPath", () => {
  it("resolves against the given cwd and returns repo-relative posix paths", () => {
    const root = join(tmpdir(), "r");
    expect(toRepoPath(root, "./CLAUDE.md", root)).toBe("CLAUDE.md");
    expect(toRepoPath(root, "guide.md", join(root, "docs"))).toBe("docs/guide.md");
    expect(toRepoPath(root, "../CLAUDE.md", join(root, "docs"))).toBe("CLAUDE.md");
    expect(toRepoPath(root, join(root, "src", "a.ts"), "/elsewhere")).toBe("src/a.ts");
    expect(toRepoPath(root, "../outside.md", root).startsWith("..")).toBe(true);
  });
});

describe.skipIf(!existsSync(CLI))("CLI path arguments", () => {
  it("`link ./CLAUDE.md` records the doc as CLAUDE.md", async () => {
    const dir = await repo();
    expect(cli(["link", "./CLAUDE.md"], dir).status).toBe(0);
    expect(await docsIn(dir)).toEqual(["CLAUDE.md"]);
  });

  it("`link guide.md` from docs/ resolves against the cwd", async () => {
    const dir = await repo();
    const run = cli(["link", "guide.md"], join(dir, "docs"));
    expect(run.status).toBe(0);
    expect(await docsIn(dir)).toEqual(["docs/guide.md"]);
  });

  it("`link` refuses a doc outside the repository", async () => {
    const dir = await repo();
    const run = cli(["link", "../elsewhere.md"], dir);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/outside the repository/);
  });

  it("`check ./src/a.ts` scopes to that file and exits 1 on drift, from the root or a subdirectory", async () => {
    const dir = await repo();
    cli(["link", "CLAUDE.md"], dir);
    await writeFile(join(dir, "src", "a.ts"), A_TS.replace("x + 1", "x + 9"), "utf8");
    expect(cli(["check", "./src/a.ts", "--format", "json"], dir).status).toBe(1);
    expect(cli(["check", "../src/a.ts"], join(dir, "docs")).status).toBe(1);
  });

  it("`refs ./src/a.ts#alpha` finds the anchor", async () => {
    const dir = await repo();
    cli(["link", "CLAUDE.md"], dir);
    expect(cli(["refs", "./src/a.ts#alpha"], dir).stdout).toContain("CLAUDE.md:4");
  });

  it("`ack` rejects an unknown resolution", async () => {
    const dir = await repo();
    cli(["link", "CLAUDE.md"], dir);
    const run = cli(["ack", "whatever", "--resolution", "bogus"], dir);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/unknown resolution/);
  });
});

describe("MCP path arguments", () => {
  it("accepts absolute paths from an agent, and ./-prefixed ones, for refs and link", async () => {
    const dir = await repo();
    const server = createServer(dir);
    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(s)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
      };
      return r.content[0]?.text ?? "";
    };

    await call("lockwire_link", { doc: join(dir, "CLAUDE.md") }); // absolute
    expect(await docsIn(dir)).toEqual(["CLAUDE.md"]);
    expect(await call("lockwire_refs", { path: join(dir, "src", "a.ts") })).toContain("CLAUDE.md");
    expect(await call("lockwire_refs", { path: "./src/a.ts" })).toContain("CLAUDE.md");
    expect(await call("lockwire_verify", { doc: "./CLAUDE.md" })).toContain("alpha");
  });
});
