/**
 * The documentation is tested against the real thing. The README's `$ lockwire …` transcripts are
 * replayed through the built CLI and compared line by line; the JSON samples in docs/cli.md and
 * docs/agents.md must have the shape the code really emits; and every relative link and `#anchor`
 * in the docs must resolve. When code and docs drift apart, this fails and says which block.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const NO_AGENT_ENV = { CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "", CODEX_SANDBOX: "", CODEX_HOME: "", CI: "" };

interface Block {
  lang: string;
  body: string[];
  line: number; // 1-based line of the opening fence
}

/** Fenced code blocks of a markdown file, in order. Handles ``` and ~~~ and longer closing fences. */
function fencedBlocks(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*(\w*)/.exec(lines[i] ?? "");
    if (!open) continue;
    const fence = open[1] ?? "```";
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[j] ?? "")) {
      body.push(lines[j] ?? "");
      j++;
    }
    blocks.push({ lang: open[2] ?? "", body, line: i + 1 });
    i = j;
  }
  return blocks;
}

const ID_PLACEHOLDER = "k7q2m9xv"; // the id the docs use in their examples
const TS_RE = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;
const normalize = (text: string, realId: string | null) => {
  let out = text.replace(/\r/g, "").replace(TS_RE, "<TS>").split(ID_PLACEHOLDER).join("<ID>");
  if (realId) out = out.split(realId).join("<ID>");
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
};

function cli(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...NO_AGENT_ENV },
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status, out: r.stdout.replace(/\r/g, ""), err: r.stderr };
}

const SESSION_V1 = `export async function createSession(userId: UserId): Promise<Session> {
  const token = mint(userId);
  return { token };
}
`;
const SESSION_BODY_REFACTORED = SESSION_V1.replace("  const token", '  log("issuing", userId);\n  const token');
const SESSION_NEW_SIG = SESSION_BODY_REFACTORED.replace("userId: UserId", "userId: UserId, ttl: number");
const PROVIDER = "export class AuthConfig {\n  refresh(token: string): void {}\n}\n";

async function scratch(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-docs-"));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content, "utf8");
  }
  return dir;
}
const idOf = (dir: string) => {
  const m = /id=([0-9a-z]{8})/.exec(readFileSync(join(dir, "CLAUDE.md"), "utf8"));
  if (!m?.[1]) throw new Error("no stamped id in CLAUDE.md");
  return m[1];
};

const readme = fencedBlocks(read("README.md"));
const transcripts = readme.filter((b) => b.body[0]?.startsWith("$ lockwire"));
const has = existsSync(CLI);

// Locally these tests skip without a build. In CI a skipped doc-test is a silent hole, so insist.
it.runIf(!has && Boolean(process.env.CI))("dist/ is built (the doc tests replay the real CLI)", () => {
  expect(has, "run `npm run build` before `npm test` in CI").toBe(true);
});

describe.skipIf(!has)("README transcripts match the real CLI", () => {
  /**
   * Every `$ lockwire …` block in README.md, in order, with the state of the world it was recorded
   * in. Adding a transcript to the README without adding it here fails the count check below.
   */
  type Step = { command: string; before?: (dir: string) => Promise<void> | void; after?: (dir: string) => void };
  const claimMd = () => {
    const b = readme.find((x) => x.lang === "markdown" && x.body.join("\n").includes("lockwire src/auth/session.ts#createSession sig -->") && !x.body.join("\n").includes("id="));
    if (!b) throw new Error("README no longer has the 'add a marker above a claim' markdown block");
    return `# Auth\n\n${b.body.join("\n")}\n`;
  };

  const topSample: Step[] = [
    {
      command: "check",
      before: (dir) => {
        cli(dir, ["link", "CLAUDE.md"]);
        return writeFile(join(dir, "src/auth/session.ts"), SESSION_V1.replace("userId: UserId", "userId: UserId, ttl: number"), "utf8");
      },
    },
    { command: "history <ID>", before: (dir) => void cli(dir, ["link", "CLAUDE.md", "--reviewed"]) },
  ];
  const quickstart: Step[] = [
    { command: "init" },
    { command: "link CLAUDE.md" },
    { command: "check", before: (dir) => writeFile(join(dir, "src/auth/session.ts"), SESSION_BODY_REFACTORED, "utf8") },
    { command: "check", before: (dir) => writeFile(join(dir, "src/auth/session.ts"), SESSION_NEW_SIG, "utf8") },
    { command: "link CLAUDE.md --reviewed" },
    { command: "history <ID>" },
  ];

  it("has exactly the transcripts this test knows how to replay", () => {
    expect(
      transcripts.map((b) => `${b.line}: ${b.body[0]}`),
      "README.md gained, lost or changed a `$ lockwire` transcript: update the steps in test/docs.test.ts",
    ).toHaveLength(topSample.length + quickstart.length);
    const commands = transcripts.map((b) => (b.body[0] ?? "").replace(/^\$ lockwire /, "").replace(ID_PLACEHOLDER, "<ID>"));
    expect(commands).toEqual([...topSample, ...quickstart].map((s) => s.command));
  });

  async function replay(dir: string, steps: Step[], blocks: Block[]) {
    for (const [i, step] of steps.entries()) {
      const block = blocks[i];
      if (!block) throw new Error(`no README block for step ${step.command}`);
      await step.before?.(dir);
      const id = existsSync(join(dir, "CLAUDE.md")) && /id=/.test(readFileSync(join(dir, "CLAUDE.md"), "utf8")) ? idOf(dir) : null;
      const args = step.command.replace("<ID>", id ?? "unknown").split(" ");
      const result = cli(dir, args);
      const expected = normalize(block.body.slice(1).join("\n"), id);
      const actual = normalize(result.out, id);
      expect(actual, `README.md:${block.line} \`$ lockwire ${step.command}\` no longer matches what the CLI prints`).toBe(expected);
    }
  }

  it("the opening sample: a two-anchor check, then history after a re-stamp", async () => {
    const dir = await scratch({
      "src/auth/session.ts": SESSION_V1,
      "src/auth/provider.ts": PROVIDER,
      "CLAUDE.md":
        "# Auth\n\n<!-- lockwire src/auth/session.ts#createSession sig -->\n`createSession` takes a `UserId`.\n\n<!-- lockwire src/auth/provider.ts#AuthConfig sig -->\n`AuthConfig` holds provider settings.\n",
    });
    await replay(dir, topSample, transcripts.slice(0, topSample.length));
  });

  it("the quickstart, end to end, from the marker the README tells you to add", async () => {
    const dir = await scratch({ "src/auth/session.ts": SESSION_V1, "CLAUDE.md": claimMd() });
    const blocks = transcripts.slice(topSample.length);
    await replay(dir, quickstart.slice(0, 2), blocks.slice(0, 2));

    // "The marker is now stamped with an id": the README's next markdown block is that line.
    const stamped = readme.find((b) => b.lang === "markdown" && b.body.join("\n").includes("id="));
    expect(stamped, "README lost its 'stamped with an id' block").toBeDefined();
    const docLine = readFileSync(join(dir, "CLAUDE.md"), "utf8").split("\n").find((l) => l.includes("id="));
    expect(normalize(docLine ?? "", idOf(dir))).toBe(normalize(stamped?.body.join("\n") ?? "", null));

    await replay(dir, quickstart.slice(2), blocks.slice(2));
  });

  it("every `lockwire <command>` the README mentions exists", () => {
    const help = cli(ROOT, ["--help"]).out;
    const known = new Set(
      (/commands: (.*)/.exec(help)?.[1] ?? "").split(",").map((c) => c.trim().split(" ")[0]),
    );
    expect(known.size).toBeGreaterThan(5);
    // Only lines that are commands: `lockwire x`, `$ lockwire x`, `npx lockwire x` at the start of a
    // line. Output lines like "… · lockwire flagged 1" are prose.
    const mentioned = new Set<string>();
    for (const b of readme) {
      // A transcript's command is its first line; everything after it is output. Plain bash blocks are all commands.
      const commandLines = b.body[0]?.startsWith("$ lockwire")
        ? [b.body[0]]
        : b.lang === "bash" || b.lang === "sh"
          ? b.body
          : [];
      for (const l of commandLines) {
        const m = /^\s*(?:\$ )?(?:npx (?:--?[a-z-]+ )*)?lockwire ([a-z][a-z-]*)/.exec(l);
        if (m?.[1]) mentioned.add(m[1]);
      }
    }
    expect(mentioned.size).toBeGreaterThan(3);
    for (const c of mentioned)
      expect(known.has(c), `README mentions \`lockwire ${c}\`, which isn't a command`).toBe(true);
  });
});

describe.skipIf(!has)("JSON samples have the shape the code emits", () => {
  /** Key structure of a JSON value: object keys recursively, arrays by their first element. */
  const shape = (v: unknown): unknown =>
    Array.isArray(v) ? [shape(v[0])] : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;

  it("docs/cli.md's `check --format json` sample lists every field the CLI outputs, and no others", async () => {
    const block = fencedBlocks(read("docs/cli.md")).find((b) => b.lang === "json" && b.body.join("\n").includes("lockwire.check.v1"));
    expect(block, "docs/cli.md lost its check JSON sample").toBeDefined();
    const dir = await scratch({
      "src/auth/session.ts": SESSION_V1,
      "CLAUDE.md": "# A\n\n<!-- lockwire src/auth/session.ts#createSession sig -->\n`createSession` takes a `UserId`.\n",
      // a marker nobody has linked, so the sample's `unlinked` entries have something to match
      "NOTES.md": "# N\n\n<!-- lockwire src/auth/session.ts#createSession sig -->\nAn unlinked claim.\n",
    });
    cli(dir, ["link", "CLAUDE.md"]);
    await writeFile(join(dir, "src/auth/session.ts"), SESSION_NEW_SIG, "utf8");
    const real = JSON.parse(cli(dir, ["check", "--format", "json", "--no-write"]).out);
    expect(
      shape(JSON.parse(block?.body.join("\n") ?? "{}")),
      `docs/cli.md:${block?.line} JSON sample and the real \`check --format json\` output have different fields`,
    ).toEqual(shape(real));
  });

  it("docs/agents.md's hook payloads are exactly what the hooks print for the README's example", async () => {
    const blocks = fencedBlocks(read("docs/agents.md")).filter((b) => b.body.join("\n").includes("hookSpecificOutput"));
    expect(blocks).toHaveLength(2);
    const claim = readme.find((x) => x.lang === "markdown" && x.body.join("\n").includes("sig -->") && !x.body.join("\n").includes("id="));
    const dir = await scratch({ "src/auth/session.ts": SESSION_V1, "CLAUDE.md": `# Auth\n\n${claim?.body.join("\n")}\n` });
    cli(dir, ["link", "CLAUDE.md"]);
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(dir, "src/auth/session.ts") }, cwd: dir });

    const pre = cli(dir, ["hook", "claude-pre"], payload).out;
    expect(
      JSON.parse(pre),
      `docs/agents.md:${blocks[0]?.line} PreToolUse sample differs from the real hook output`,
    ).toEqual(JSON.parse(blocks[0]?.body.join("\n") ?? "{}"));

    await writeFile(join(dir, "src/auth/session.ts"), SESSION_NEW_SIG, "utf8");
    const post = cli(dir, ["hook", "claude-post"], payload).out;
    expect(
      JSON.parse(post),
      `docs/agents.md:${blocks[1]?.line} PostToolUse sample differs from the real hook output`,
    ).toEqual(JSON.parse(blocks[1]?.body.join("\n") ?? "{}"));
  });
});

describe("links in the documentation resolve", () => {
  const docs = ["README.md", "SKILL.md", "CONTRIBUTING.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];

  /** GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens. */
  const slug = (h: string) =>
    h
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s/g, "-");
  const anchorsOf = (rel: string) => {
    const out = new Set<string>();
    for (const l of read(rel).split("\n")) {
      const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
      if (m?.[1]) out.add(slug(m[1].replace(/[`*_]/g, "")));
    }
    return out;
  };
  /** Markdown links outside code, with their 1-based line. */
  function links(rel: string) {
    const found: { target: string; line: number }[] = [];
    let fence = false;
    for (const [i, line] of read(rel).split("\n").entries()) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence) continue;
      for (const m of line.replace(/`[^`]*`/g, "").matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push({ target: m[1] ?? "", line: i + 1 });
    }
    return found;
  }

  it.each(docs)("%s: every relative link and #anchor points at something real", (rel) => {
    const broken: string[] = [];
    for (const { target, line } of links(rel)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [pathPart = "", frag] = target.split("#");
      const file = pathPart === "" ? rel : join(dirname(rel), pathPart.split("?")[0] ?? "");
      const abs = resolve(ROOT, file);
      if (!existsSync(abs)) {
        broken.push(`${rel}:${line} -> ${target} (no such file)`);
        continue;
      }
      if (frag && file.endsWith(".md") && !anchorsOf(file.replace(/\\/g, "/")).has(frag.toLowerCase()))
        broken.push(`${rel}:${line} -> ${target} (no heading "${frag}")`);
    }
    expect(broken).toEqual([]);
  });
});

describe("the documented configuration is the real configuration", () => {
  /** Dotted leaf keys of a config object, e.g. `hook.mode`. */
  const leaves = (o: Record<string, unknown>, prefix = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? leaves(v as Record<string, unknown>, `${prefix}${k}.`)
        : [`${prefix}${k}`],
    );

  it("docs/cli.md's configuration table lists exactly the keys `init` writes, bar the schema version", () => {
    const cli = read("docs/cli.md");
    const start = cli.indexOf("## Configuration");
    expect(start, "docs/cli.md lost its Configuration section").toBeGreaterThan(-1);
    const section = cli.slice(start, cli.indexOf("\n## ", start + 5));
    const documented = [...section.matchAll(/^\|\s*`([\w.]+)`\s*\|/gm)].map((m) => m[1]).sort();
    const real = leaves(DEFAULT_CONFIG as unknown as Record<string, unknown>)
      .filter((k) => k !== "version")
      .sort();
    expect(documented).toEqual(real);
  });
});
