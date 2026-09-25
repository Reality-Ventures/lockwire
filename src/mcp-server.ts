import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ack, check, history, linkDoc, refs, status, waive } from "./actions.js";
import { readConfig } from "./config.js";

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export async function startMcpServer(repoRoot: string): Promise<void> {
  const server = new McpServer({ name: "lockwire", version: "0.1.0" });

  server.registerTool(
    "lockwire_claims_for",
    {
      title: "Claims for code",
      description:
        "What does the documentation assert about this file or symbol? Call before editing.",
      inputSchema: { path: z.string(), symbol: z.string().optional() },
    },
    async ({ path, symbol }) => text(await refs(repoRoot, path, symbol)),
  );

  server.registerTool(
    "lockwire_refs",
    {
      title: "Reverse lookup",
      description: "Which documentation claims reference this file or symbol.",
      inputSchema: { path: z.string(), symbol: z.string().optional() },
    },
    async ({ path, symbol }) => text(await refs(repoRoot, path, symbol)),
  );

  server.registerTool(
    "lockwire_status",
    {
      title: "Anchor status",
      description: "Current status of every anchor, optionally filtered by a glob scope.",
      inputSchema: { scope: z.string().optional() },
    },
    async ({ scope }) => text(await status(repoRoot, scope)),
  );

  server.registerTool(
    "lockwire_verify",
    {
      title: "Verify a doc",
      description: "Check one document's anchors before committing it.",
      inputSchema: { doc: z.string() },
    },
    async ({ doc }) => {
      const config = await readConfig(repoRoot);
      const result = await check(repoRoot, config);
      return text(result.results.filter((r) => r.anchor.doc === doc));
    },
  );

  server.registerTool(
    "lockwire_history",
    {
      title: "Anchor history",
      description:
        "Ledger timeline for an anchor id, a path#symbol, or a doc path — how many times has this claim broken, and how was it resolved.",
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => text(await history(repoRoot, ref)),
  );

  server.registerTool(
    "lockwire_link",
    {
      title: "Create or refresh an anchor",
      description: "Scan a doc for lockwire markers and stamp fresh fingerprints.",
      inputSchema: { doc: z.string(), reviewed: z.boolean().optional() },
    },
    async ({ doc, reviewed }) =>
      text(
        await linkDoc(
          repoRoot,
          doc,
          await readConfig(repoRoot),
          { type: "ai", tool: { name: "mcp" } },
          reviewed === undefined ? {} : { reviewed },
        ),
      ),
  );

  server.registerTool(
    "lockwire_ack",
    {
      title: "Acknowledge drift",
      description: "Record that drift was handled and re-stamp the anchor's fingerprints.",
      inputSchema: {
        anchor: z.string(),
        resolution: z.enum(["updated", "superseded", "false-positive"]),
        note: z.string().optional(),
      },
    },
    async ({ anchor, resolution, note }) =>
      text(
        await ack(
          repoRoot,
          anchor,
          resolution,
          note,
          { type: "ai", tool: { name: "mcp" } },
          await readConfig(repoRoot),
        ),
      ),
  );

  server.registerTool(
    "lockwire_waive",
    {
      title: "Waive an anchor",
      description: "Time-boxed, logged, expiring waiver. No permanent suppression.",
      inputSchema: { anchor: z.string(), reason: z.string(), expires: z.string() },
    },
    async ({ anchor, reason, expires }) =>
      text(await waive(repoRoot, anchor, reason, expires, { type: "ai", tool: { name: "mcp" } })),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
