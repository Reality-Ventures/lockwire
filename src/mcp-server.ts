import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ack, check, history, linkDoc, refs, status, waive } from "./actions.js";
import { readConfig } from "./config.js";
import { lockfilePath } from "./lockfile.js";
import { toRepoPath } from "./repo.js";

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

/** Without this, a server rooted at the wrong folder answers every query with an indistinguishable `[]`. */
function missingLockNote(repoRoot: string): string | undefined {
  if (existsSync(lockfilePath(repoRoot))) return undefined;
  return `No lockwire.lock found in ${repoRoot}. This MCP server is rooted at the folder the session started in; start the session from the repository root (or run \`lockwire init\` there).`;
}

/** Builds the configured server without connecting a transport -- split out from startMcpServer so tests can drive it over an in-memory transport instead of real stdio. */
export function createServer(repoRoot: string): McpServer {
  const server = new McpServer({ name: "lockwire", version: "0.1.0" });

  // Every tool below only ever touches this repo's own working tree (lockfile, ledger, docs) --
  // no network calls, ever (see README FAQ "Does it call an LLM?") -- so openWorldHint is false
  // across the board. The other three hints vary per tool; see each one's own comment for why.

  server.registerTool(
    "lockwire_claims_for",
    {
      title: "Claims for code",
      description:
        "What does the documentation assert about this file or symbol? Call before editing.",
      inputSchema: { path: z.string(), symbol: z.string().optional() },
      // Pure read (refs() only calls readLockfile) -- repeat calls are trivially idempotent.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, symbol }) =>
      text(
        missingLockNote(repoRoot) ??
          (await refs(repoRoot, toRepoPath(repoRoot, path, repoRoot), symbol)),
      ),
  );

  server.registerTool(
    "lockwire_refs",
    {
      title: "Reverse lookup",
      description: "Which documentation claims reference this file or symbol.",
      inputSchema: { path: z.string(), symbol: z.string().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, symbol }) =>
      text(
        missingLockNote(repoRoot) ??
          (await refs(repoRoot, toRepoPath(repoRoot, path, repoRoot), symbol)),
      ),
  );

  server.registerTool(
    "lockwire_status",
    {
      title: "Anchor status",
      description: "Current status of every anchor, optionally filtered by a glob scope.",
      inputSchema: { scope: z.string().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ scope }) => text(missingLockNote(repoRoot) ?? (await status(repoRoot, scope))),
  );

  server.registerTool(
    "lockwire_verify",
    {
      title: "Verify a doc",
      description: "Check one document's anchors before committing it.",
      inputSchema: { doc: z.string() },
      // Not read-only: check() writes the lockfile and appends ledger events on state
      // transitions. It IS idempotent -- every transition is guarded by the anchor's current
      // status (e.g. `if (anchor.status !== "drifted")`), so a repeat call with nothing else
      // changed logs nothing new.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ doc: docArg }) => {
      const note = missingLockNote(repoRoot);
      if (note) return text(note);
      const doc = toRepoPath(repoRoot, docArg, repoRoot);
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ref }) => text(missingLockNote(repoRoot) ?? (await history(repoRoot, ref))),
  );

  server.registerTool(
    "lockwire_link",
    {
      title: "Create or refresh an anchor",
      description: "Scan a doc for lockwire markers and stamp fresh fingerprints.",
      inputSchema: { doc: z.string(), reviewed: z.boolean().optional() },
      // linkDoc() unconditionally appends an anchor.created/anchor.resolved ledger event per
      // marker on every call, by design -- the ledger records every explicit link action taken,
      // not just net state changes -- so this is NOT idempotent.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ doc, reviewed }) =>
      text(
        await linkDoc(
          repoRoot,
          toRepoPath(repoRoot, doc, repoRoot),
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
      // ack() unconditionally appends an anchor.acknowledged event every call, same reasoning
      // as lockwire_link -- each ack is a distinct logged action, so repeat calls are not a
      // no-op even when the anchor's resulting state looks the same.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
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
      // waive() unconditionally appends a waiver.granted event every call -- same reasoning as
      // lockwire_link and lockwire_ack.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ anchor, reason, expires }) =>
      text(await waive(repoRoot, anchor, reason, expires, { type: "ai", tool: { name: "mcp" } })),
  );

  return server;
}

export async function startMcpServer(repoRoot: string): Promise<void> {
  const server = createServer(repoRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
