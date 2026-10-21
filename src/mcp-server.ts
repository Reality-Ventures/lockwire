import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ack,
  check,
  history,
  type IndexSession,
  linkDoc,
  refs,
  status,
  unlinkedFor,
  waive,
} from "./actions.js";
import { changedFiles } from "./changed.js";
import { readConfig } from "./config.js";
import type { IndexStats } from "./docindex.js";
import { withRepoLock } from "./lock.js";
import { lockfilePath } from "./lockfile.js";
import { toRepoPath } from "./repo.js";
import { fixDocsPrompt, listTasks, resolveTask, taskContext } from "./tasks.js";

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
export function createServer(
  repoRoot: string,
  opts: { onIndexStats?: (stats: IndexStats) => void } = {},
): McpServer {
  const server = new McpServer({ name: "lockwire", version: "0.1.0" });
  // The server outlives many calls, so it keeps the doc index in memory: the first `claims_for`
  // builds (or loads) it, later ones only re-validate it. Nothing is written to disk.
  const indexSession: IndexSession = {};

  /** Who is acting: the MCP client's own name (claude-code, codex, cursor…) when it gave one. */
  const agentActor = () => {
    const client = server.server.getClientVersion();
    return {
      type: "ai" as const,
      tool: client?.name
        ? { name: client.name, ...(client.version ? { version: client.version } : {}) }
        : { name: "mcp" },
    };
  };

  // Every tool below only ever touches this repo's own working tree (lockfile, ledger, docs) --
  // no network calls, ever (see README FAQ "Does it call an LLM?") -- so openWorldHint is false
  // across the board. The other three hints vary per tool; see each one's own comment for why.

  server.registerTool(
    "lockwire_claims_for",
    {
      title: "Claims for code",
      description:
        "What does the documentation assert about this file or symbol? Call before editing. Returns `anchors` (claims lockwire is checking) and `unlinked` (claims written in a doc about this code that nobody has linked yet, so nothing is checking them — treat them as real claims too).",
      inputSchema: { path: z.string(), symbol: z.string().optional() },
      // Pure read (the lockfile and the docs; the doc index is held in memory, never written to disk) --
      // repeat calls are trivially idempotent.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, symbol }) => {
      const note = missingLockNote(repoRoot);
      if (note) return text(note);
      const repoPath = toRepoPath(repoRoot, path, repoRoot);
      return text({
        anchors: await refs(repoRoot, repoPath, symbol),
        unlinked: await unlinkedFor(
          repoRoot,
          await readConfig(repoRoot),
          repoPath,
          symbol,
          indexSession,
          opts.onIndexStats,
        ),
      });
    },
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
      const result = await withRepoLock(repoRoot, () =>
        check(repoRoot, config, undefined, {
          actor: agentActor(),
        }),
      );
      return text({
        anchors: result.results.filter((r) => r.anchor.doc === doc),
        unlinked: result.unlinked.filter((u) => u.doc === doc),
      });
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
        await withRepoLock(repoRoot, async () =>
          linkDoc(
            repoRoot,
            toRepoPath(repoRoot, doc, repoRoot),
            await readConfig(repoRoot),
            agentActor(),
            reviewed === undefined ? {} : { reviewed },
          ),
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
        await withRepoLock(repoRoot, async () =>
          ack(repoRoot, anchor, resolution, note, agentActor(), await readConfig(repoRoot)),
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
      text(
        await withRepoLock(repoRoot, () => waive(repoRoot, anchor, reason, expires, agentActor())),
      ),
  );

  // ---- The agent work queue: what's wrong, the context to fix it, and a checked resolve. ----------

  server.registerTool(
    "lockwire_tasks",
    {
      title: "Documentation tasks",
      description:
        "Every documentation claim that needs attention, as a task list: claims whose code or value changed, numbers that no longer match their source, claims whose target is gone, and markers nobody has linked. Each task says what is wrong and what to do. Start here when asked to fix or update documentation. `paths` limits it to claims about (or in) those files; `changed` to files this branch touched.",
      inputSchema: { paths: z.array(z.string()).optional(), changed: z.boolean().optional() },
      // A dry run of check: computes everything, writes nothing.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ paths, changed }) => {
      const note = missingLockNote(repoRoot);
      if (note) return text(note);
      const scope = changed
        ? changedFiles(repoRoot)
        : paths?.map((p) => toRepoPath(repoRoot, p, repoRoot));
      return text(await listTasks(repoRoot, await readConfig(repoRoot), scope));
    },
  );

  server.registerTool(
    "lockwire_task_context",
    {
      title: "Context for a task",
      description:
        "Everything needed to fix one task from lockwire_tasks: the whole claim sentence, the bound code (its declaration) or value as it was when the claim was stamped and as it is now, and the claim's history. `stamped.exact` says whether the stamped side is exactly what the claim was checked against.",
      inputSchema: { id: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => text(await taskContext(repoRoot, await readConfig(repoRoot), id)),
  );

  server.registerTool(
    "lockwire_resolve",
    {
      title: "Resolve a task",
      description:
        "After you have edited the doc so the claim is true, re-stamp that one claim (nothing else in the doc). It is checked first: a sentence whose number still disagrees with its value is refused, as is a marker whose target still doesn't exist. Pass a short `note` saying what you checked or changed; it goes into the claim's history. Returns resolved / already-fresh / refused (with the reason) and the tasks still open on the same doc.",
      inputSchema: { id: z.string(), note: z.string().optional() },
      // Writes the lockfile and ledger. Resolving an already-fresh claim is a no-op, so it is idempotent.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, note }) =>
      text(await resolveTask(repoRoot, await readConfig(repoRoot), id, agentActor(), note)),
  );

  server.registerPrompt(
    "fix-docs",
    {
      title: "Fix documentation drift",
      description:
        "Work through lockwire's task list: fix every documentation claim that no longer matches the code or data it describes, and check each fix.",
      argsSchema: { scope: z.string().optional() },
    },
    ({ scope }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: fixDocsPrompt(scope),
          },
        },
      ],
    }),
  );

  return server;
}

export async function startMcpServer(repoRoot: string): Promise<void> {
  const server = createServer(repoRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
