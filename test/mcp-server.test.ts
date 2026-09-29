import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
    expect(JSON.parse(firstText(result as never))).toHaveLength(1);
  });

  it("lockwire_refs returns the same reverse lookup as claims_for", async () => {
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
    const results = JSON.parse(firstText(result as never));
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fresh");
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
});
