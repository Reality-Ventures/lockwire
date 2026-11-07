import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  type JsonRpcMessage,
  McpServer,
  StdioServerTransport,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../src/mcp-protocol.js";
import { s } from "../src/schema.js";

/** A server on in-memory pipes: write raw lines in, read parsed replies out. */
async function wired() {
  const server = new McpServer({ name: "t", version: "1" });
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echoes",
      inputSchema: { say: s.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ say }) => {
      if (say === "boom") throw new Error("it broke");
      return { content: [{ type: "text", text: say }] };
    },
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: JsonRpcMessage[] = [];
  let pending = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    pending += chunk;
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      replies.push(JSON.parse(pending.slice(0, nl)));
      pending = pending.slice(nl + 1);
    }
  });
  await server.connect(new StdioServerTransport(input, output));
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return {
    server,
    replies,
    async send(raw: string) {
      input.write(raw);
      await settle();
    },
  };
}

const rpc = (id: number, method: string, params: object = {}) =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

describe("the MCP protocol layer", () => {
  it("negotiates the protocol version and records who the client is", async () => {
    const w = await wired();
    await w.send(
      rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "codex", version: "9" },
      }),
    );
    await w.send(rpc(2, "initialize", { protocolVersion: "1999-01-01", capabilities: {} }));
    expect(w.replies[0]?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "t", version: "1" },
    });
    expect(w.replies[1]?.result).toMatchObject({ protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0] });
    expect(w.server.getClientVersion()).toEqual({ name: "codex", version: "9" });
  });

  it("answers bad JSON and unknown methods with JSON-RPC errors, and notifications with nothing", async () => {
    const w = await wired();
    await w.send("{not json\n");
    await w.send(rpc(3, "resources/list"));
    await w.send(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    expect(w.replies).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found: resources/list" } },
    ]);
  });

  it("reports a tool's failure, bad arguments and an unknown tool as tool errors", async () => {
    const w = await wired();
    await w.send(rpc(1, "tools/call", { name: "echo", arguments: { say: "hi" } }));
    await w.send(rpc(2, "tools/call", { name: "echo", arguments: { say: "boom" } }));
    await w.send(rpc(3, "tools/call", { name: "echo", arguments: { say: 5 } }));
    await w.send(rpc(4, "tools/call", { name: "nope" }));
    const byId = (id: number) => w.replies.find((r) => r.id === id)?.result;
    expect(byId(1)).toEqual({ content: [{ type: "text", text: "hi" }] });
    expect(byId(2)).toEqual({ content: [{ type: "text", text: "it broke" }], isError: true });
    expect(byId(3)).toMatchObject({ isError: true });
    expect(JSON.stringify(byId(3))).toContain("Invalid arguments for tool echo");
    expect(byId(4)).toEqual({ content: [{ type: "text", text: "Tool nope not found" }], isError: true });
  });

  it("reads a message split across chunks, CRLF line ends, and a batch", async () => {
    const w = await wired();
    const line = rpc(1, "ping");
    await w.send(line.slice(0, 10));
    await w.send(`${line.slice(10, -1)}\r\n`);
    await w.send(`${JSON.stringify([JSON.parse(rpc(2, "ping")), JSON.parse(rpc(3, "ping"))])}\n`);
    expect(w.replies.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    expect(w.replies.every((r) => JSON.stringify(r.result) === "{}")).toBe(true);
  });
});
