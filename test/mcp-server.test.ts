import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { linkDoc, status } from "../src/actions.js";
import { createServer } from "../src/mcp-server.js";
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
  const repo = await mkdtemp(join(tmpdir(), "lockwire-mcp-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "session.ts"), SESSION_TS, "utf8");
  await writeFile(join(repo, "CLAUDE.md"), CLAUDE_MD, "utf8");
  return repo;
}

async function connectedClient(repoRoot: string) {
  const server = createServer(repoRoot);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text === undefined)
    throw new Error("expected a text content block");
  return first.text;
}

describe("MCP server tools", () => {
  let repo: string;
  let anchorId: string;

  beforeEach(async () => {
    repo = await tempRepo();
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });
    const [anchor] = await status(repo);
    anchorId = anchor!.id;
  });

  it("lists all 8 tools with all four annotation hints explicitly set", async () => {
    const client = await connectedClient(repo);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "lockwire_ack",
        "lockwire_claims_for",
        "lockwire_history",
        "lockwire_link",
        "lockwire_refs",
        "lockwire_status",
        "lockwire_verify",
        "lockwire_waive",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} is missing annotations`).toBeDefined();
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("lockwire_claims_for returns the anchor bound to the given path", async () => {
    const client = await connectedClient(repo);
    const result = await client.callTool({
      name: "lockwire_claims_for",
      arguments: { path: "src/session.ts" },
    });
    const { anchors, unlinked } = JSON.parse(firstText(result as never));
    expect(anchors).toHaveLength(1);
    expect(unlinked).toEqual([]);
  });

  describe("lockwire_claims_for also surfaces claims nobody has linked", () => {
    const call = async (args: Record<string, unknown>) => {
      const client = await connectedClient(repo);
      const result = await client.callTool({ name: "lockwire_claims_for", arguments: args });
      return JSON.parse(firstText(result as never)) as {
        anchors: { id: string }[];
        unlinked: { doc: string; line: number; target: string; reason: string; excerpt: string }[];
      };
    };
    const marker = (target: string, id = "") => `<!-- lockwire ${target} sig${id} -->`;
    const writeDoc = (rel: string, target: string, sentence: string, id = "") =>
      writeFile(join(repo, rel), `# D\n\n${marker(target, id)}\n${sentence}\n`, "utf8");

    it("an unlinked claim about the file comes back with the sentence, so the agent can read what's asserted", async () => {
      await writeDoc("NOTES.md", "src/session.ts#createSession", "Sessions are valid for 24 hours.");
      const { anchors, unlinked } = await call({ path: "src/session.ts" });
      expect(anchors).toHaveLength(1); // the linked claim from CLAUDE.md is still there
      expect(unlinked).toEqual([
        {
          doc: "NOTES.md",
          line: 3,
          target: "src/session.ts#createSession",
          reason: "not linked yet",
          excerpt: "Sessions are valid for 24 hours.",
        },
      ]);
    });

    it("asking about a file includes unlinked claims on any symbol in it; asking about a symbol is exact", async () => {
      await writeDoc("A.md", "src/session.ts#createSession", "About createSession.");
      await writeDoc("B.md", "src/session.ts#otherThing", "About something else.");
      await writeDoc("C.md", "src/session.ts", "About the whole file.");
      const file = await call({ path: "src/session.ts" });
      expect(file.unlinked.map((u) => u.doc)).toEqual(["A.md", "B.md", "C.md"]);
      const symbol = await call({ path: "src/session.ts", symbol: "createSession" });
      expect(symbol.unlinked.map((u) => u.doc)).toEqual(["A.md"]);
    });

    it("claims about other files, and look-alike paths, don't leak in", async () => {
      await writeDoc("A.md", "src/other.ts#f", "About another file.");
      await writeDoc("B.md", "src/session.tsx#g", "About a look-alike path.");
      await writeDoc("C.md", "src/session.ts.bak", "About a backup.");
      expect((await call({ path: "src/session.ts" })).unlinked).toEqual([]);
    });

    it("once the claim is linked it moves from `unlinked` to `anchors`", async () => {
      await writeDoc("NOTES.md", "src/session.ts#createSession", "Linked later.");
      expect((await call({ path: "src/session.ts" })).unlinked).toHaveLength(1);
      await linkDoc(repo, "NOTES.md", DEFAULT_CONFIG, { type: "human" });
      const after = await call({ path: "src/session.ts" });
      expect(after.unlinked).toEqual([]);
      expect(after.anchors).toHaveLength(2);
    });

    it("a copy-pasted marker shows up as unlinked, explaining whose id it borrowed", async () => {
      const stamped = (await readFile(join(repo, "CLAUDE.md"), "utf8")).split("\n").find((l) => l.includes("id="));
      await writeFile(join(repo, "COPY.md"), `# C\n\n${stamped}\nCopied claim.\n`, "utf8");
      const { unlinked } = await call({ path: "src/session.ts" });
      expect(unlinked).toHaveLength(1);
      expect(unlinked[0]?.reason).toBe(`id ${anchorId} belongs to the marker in CLAUDE.md`);
    });

    it("only docs the config selects, and not fenced examples, count", async () => {
      await writeDoc("CHANGELOG.md", "src/session.ts#createSession", "Excluded by default.");
      await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
      await writeDoc("node_modules/pkg/README.md", "src/session.ts#createSession", "Vendored.");
      await writeFile(
        join(repo, "README.md"),
        `# R\n\n\`\`\`markdown\n${marker("src/session.ts#createSession")}\nexample\n\`\`\`\n`,
        "utf8",
      );
      expect((await call({ path: "src/session.ts" })).unlinked).toEqual([]);
    });

    it("accepts the path the way agents send it: absolute or ./-prefixed", async () => {
      await writeDoc("NOTES.md", "src/session.ts#createSession", "Unlinked.");
      expect((await call({ path: join(repo, "src", "session.ts") })).unlinked).toHaveLength(1);
      expect((await call({ path: "./src/session.ts" })).unlinked).toHaveLength(1);
    });

    it("works when the lockfile has no anchors at all, and says so plainly when there's no lockfile", async () => {
      const empty = await mkdtemp(join(tmpdir(), "lockwire-mcp-claims-"));
      await mkdir(join(empty, "src"));
      await writeFile(join(empty, "src", "a.ts"), "export function a() {}\n", "utf8");
      await writeFile(join(empty, "lockwire.lock"), '{"version":1,"anchors":[]}', "utf8");
      await writeFile(join(empty, "N.md"), `# N\n\n${marker("src/a.ts#a")}\nUnlinked.\n`, "utf8");
      const client = await connectedClient(empty);
      const res = await client.callTool({ name: "lockwire_claims_for", arguments: { path: "src/a.ts" } });
      const out = JSON.parse(firstText(res as never));
      expect(out.anchors).toEqual([]);
      expect(out.unlinked).toHaveLength(1);

      const bare = await mkdtemp(join(tmpdir(), "lockwire-mcp-bare2-"));
      const bareRes = await (await connectedClient(bare)).callTool({
        name: "lockwire_claims_for",
        arguments: { path: "x.ts" },
      });
      expect(firstText(bareRes as never)).toContain("No lockwire.lock found");
    });

    it("writes nothing: it is a read, as its annotations say", async () => {
      await writeDoc("NOTES.md", "src/session.ts#createSession", "Unlinked.");
      const before = [
        await readFile(join(repo, "lockwire.lock"), "utf8"),
        await readFile(join(repo, "NOTES.md"), "utf8"),
        await readFile(join(repo, ".lockwire", "ledger.jsonl"), "utf8"),
      ];
      await call({ path: "src/session.ts" });
      await call({ path: "src/session.ts", symbol: "createSession" });
      expect([
        await readFile(join(repo, "lockwire.lock"), "utf8"),
        await readFile(join(repo, "NOTES.md"), "utf8"),
        await readFile(join(repo, ".lockwire", "ledger.jsonl"), "utf8"),
      ]).toEqual(before);
    });
  });

  it("lockwire_refs stays the plain anchor lookup, with no unlinked claims mixed in", async () => {
    await writeFile(
      join(repo, "NOTES.md"),
      "# N\n\n<!-- lockwire src/session.ts#createSession sig -->\nUnlinked.\n",
      "utf8",
    );
    const client = await connectedClient(repo);
    const result = await client.callTool({ name: "lockwire_refs", arguments: { path: "src/session.ts" } });
    const out = JSON.parse(firstText(result as never));
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
  });

  it("lockwire_refs returns the same reverse lookup as claims_for's anchors", async () => {
    const client = await connectedClient(repo);
    const result = await client.callTool({
      name: "lockwire_refs",
      arguments: { path: "src/session.ts", symbol: "createSession" },
    });
    const anchors = JSON.parse(firstText(result as never));
    expect(anchors).toHaveLength(1);
    expect(anchors[0].id).toBe(anchorId);
  });

  it("lockwire_status lists every anchor", async () => {
    const client = await connectedClient(repo);
    const result = await client.callTool({ name: "lockwire_status", arguments: {} });
    expect(JSON.parse(firstText(result as never))).toHaveLength(1);
  });

  it("lockwire_verify checks the doc and reports it fresh", async () => {
    const client = await connectedClient(repo);
    const result = await client.callTool({
      name: "lockwire_verify",
      arguments: { doc: "CLAUDE.md" },
    });
    const { anchors, unlinked } = JSON.parse(firstText(result as never));
    expect(anchors).toHaveLength(1);
    expect(anchors[0].status).toBe("fresh");
    expect(unlinked).toEqual([]);
  });

  it("lockwire_verify also reports markers in that doc that no anchor backs", async () => {
    await writeFile(
      join(repo, "NOTES.md"),
      "# N\n\n<!-- lockwire src/session.ts#createSession sig -->\nA claim nobody linked.\n",
      "utf8",
    );
    const client = await connectedClient(repo);
    const result = await client.callTool({ name: "lockwire_verify", arguments: { doc: "NOTES.md" } });
    const { anchors, unlinked } = JSON.parse(firstText(result as never));
    expect(anchors).toEqual([]);
    expect(unlinked).toEqual([
      {
        doc: "NOTES.md",
        line: 3,
        target: "src/session.ts#createSession",
        reason: "not linked yet",
        excerpt: "A claim nobody linked.",
      },
    ]);
  });

  it("lockwire_history returns the anchor.created event", async () => {
    const client = await connectedClient(repo);
    const result = await client.callTool({ name: "lockwire_history", arguments: { ref: anchorId } });
    const { events } = JSON.parse(firstText(result as never));
    expect(events.map((e: { event: string }) => e.event)).toContain("anchor.created");
  });

  it("lockwire_link re-stamps the doc and appends a ledger event", async () => {
    const client = await connectedClient(repo);
    const result = await client.callTool({
      name: "lockwire_link",
      arguments: { doc: "CLAUDE.md", reviewed: true },
    });
    const parsed = JSON.parse(firstText(result as never));
    expect(parsed.refreshed).toBe(1);
  });

  it("lockwire_ack marks the anchor resolved and logs it", async () => {
    const client = await connectedClient(repo);
    const result = await client.callTool({
      name: "lockwire_ack",
      arguments: { anchor: anchorId, resolution: "false-positive", note: "reviewed manually" },
    });
    const parsed = JSON.parse(firstText(result as never));
    expect(parsed.status).toBe("fresh");
  });

  it("lockwire_waive grants a time-boxed waiver", async () => {
    const client = await connectedClient(repo);
    const result = await client.callTool({
      name: "lockwire_waive",
      arguments: {
        anchor: anchorId,
        reason: "known false positive, ticket filed",
        expires: "2099-01-01T00:00:00.000Z",
      },
    });
    const parsed = JSON.parse(firstText(result as never));
    expect(parsed.status).toBe("waived");
  });

  it("explains a missing lockwire.lock instead of returning an empty list, and never creates one", async () => {
    const bare = await mkdtemp(join(tmpdir(), "lockwire-mcp-bare-"));
    const client = await connectedClient(bare);
    for (const [name, args] of [
      ["lockwire_status", {}],
      ["lockwire_refs", { path: "src/session.ts" }],
      ["lockwire_verify", { doc: "CLAUDE.md" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(firstText(result as never)).toContain("No lockwire.lock found");
    }
    expect(existsSync(join(bare, "lockwire.lock"))).toBe(false);
  });
});
