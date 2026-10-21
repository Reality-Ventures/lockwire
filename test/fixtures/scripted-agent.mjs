#!/usr/bin/env node
// A stand-in for Claude Code or Codex in tests: reads the MCP config `lockwire autofix` hands it,
// connects to lockwire's MCP server over stdio exactly as a real agent would, and works the queue.
//
// SCRIPTED_AGENT_MODE:
//   fix        fix every task the way a careful agent would (default)
//   noop       connect, look, change nothing
//   touch-code fix the docs, and also edit a source file (which autofix must refuse)
//   fail       exit 3 straight away
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.env.SCRIPTED_AGENT_MODE ?? "fix";
if (process.env.SCRIPTED_AGENT_MARKER) writeFileSync(process.env.SCRIPTED_AGENT_MARKER, "started");
if (mode === "fail") process.exit(3);

const repo = process.env.LOCKWIRE_REPO;
const prompt = readFileSync(process.env.LOCKWIRE_PROMPT_FILE, "utf8");
if (!prompt.includes("lockwire_tasks")) throw new Error("the prompt doesn't mention lockwire_tasks");
const server = JSON.parse(readFileSync(process.env.LOCKWIRE_MCP_CONFIG, "utf8")).mcpServers.lockwire;

const client = new Client({ name: "scripted-agent", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: server.command, args: server.args, cwd: repo, stderr: "ignore" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0]?.text ?? "null");
};

/** Edit the claim at `line` (1-based): `fn` returns the new line, or null to delete it and its marker. */
function editClaim(doc, line, fn) {
  const path = join(repo, doc);
  const lines = readFileSync(path, "utf8").split("\n");
  const next = fn(lines[line - 1] ?? "");
  if (next === null) lines.splice(line - 2, 2);
  else lines[line - 1] = next;
  writeFileSync(path, lines.join("\n"));
}

// Follow the prompt's scope, as a real agent would.
const scoped = /with paths (\[[^\]]*\])/.exec(prompt);
const scope = scoped ? { paths: JSON.parse(scoped[1]) } : {};

if (mode !== "noop") {
  for (let round = 0; round < 50; round++) {
    const tasks = await call("lockwire_tasks", scope);
    const t = tasks[0];
    if (!t) break;
    const ctx = await call("lockwire_task_context", { id: t.id });
    if (t.kind === "value-wrong") {
      // Put the current value into the sentence in place of the first number it states.
      editClaim(t.doc, t.line, (claim) => claim.replace(/-?\d+(\.\d+)?/, ctx.now.source));
    } else if (t.kind === "target-missing" || t.kind === "marker-removed") {
      if (t.kind === "target-missing") editClaim(t.doc, t.line, () => null);
      await call("lockwire_ack", { anchor: t.id, resolution: "superseded", note: "the thing it described is gone" });
      continue;
    }
    // code-changed, claim-edited, value-changed, unlinked: the scripted agent judges the sentence true.
    const out = await call("lockwire_resolve", { id: t.id, note: `scripted: ${t.kind}` });
    if (out.status === "refused") throw new Error(`refused: ${out.reason}`);
  }
  if (mode === "touch-code") writeFileSync(join(repo, "src", "a.ts"), `${readFileSync(join(repo, "src", "a.ts"), "utf8")}// agent was here\n`);
}
await client.close();
