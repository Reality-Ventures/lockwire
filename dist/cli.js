#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ack, check, discoverDocs, history, linkDoc, linkLockfileOnly, refs, status, unlink, waive, } from "./actions.js";
import { cliActor } from "./actor.js";
import { autofix } from "./autofix.js";
import { changedFiles } from "./changed.js";
import { readConfig, writeConfig } from "./config.js";
import { ensureLockwireGitignore, indexPath, loadDocIndex } from "./docindex.js";
import { formatGithub, formatJson, formatText } from "./format.js";
import { runClaudeHook } from "./hook-claude.js";
import { runCodexHook } from "./hook-codex.js";
import { verifyLedger } from "./ledger.js";
import { withRepoLock } from "./lock.js";
import { writeLockfile } from "./lockfile.js";
import { scanMarkers } from "./markers.js";
import { findRepoRoot, isPathGitignored, resolveInsideRepo, toDisplayPath, toRepoPath, } from "./repo.js";
import { listTasks, resolveTask, taskContext } from "./tasks.js";
import { DEFAULT_CONFIG } from "./types.js";
import { dataFormatOf } from "./values.js";
/** Flags that never take a value, so `check --changed src/a.ts` leaves `src/a.ts` a path. */
const BOOLEAN_FLAGS = new Set([
    "changed",
    "staged",
    "no-write",
    "reviewed",
    "json",
    "fail-on-unlinked",
    "rebuild",
    "dry-run",
    "quiet",
]);
function parseFlags(args) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === undefined)
            continue;
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = args[i + 1];
            if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
                flags[key] = next;
                i++;
            }
            else {
                flags[key] = true;
            }
        }
        else {
            positional.push(a);
        }
    }
    return { positional, flags };
}
/** `path#symbol`, split at the first `#`: a symbol (a CSV row key) can contain one, a path can't. */
function splitTarget(target) {
    const hash = target.indexOf("#");
    return hash < 0
        ? [target, undefined]
        : [target.slice(0, hash), target.slice(hash + 1) || undefined];
}
function printLinkResult(doc, result) {
    console.log(`${doc}: ${result.created} created, ${result.refreshed} refreshed${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}`);
    for (const s of result.skipped)
        console.log(`  skipped ${s.target}: ${s.reason}`);
}
async function main() {
    const [, , cmd, ...rest] = process.argv;
    const { positional, flags } = parseFlags(rest);
    const repoRoot = findRepoRoot(process.cwd());
    const actor = cliActor();
    switch (cmd) {
        case "init": {
            await writeConfig(repoRoot, DEFAULT_CONFIG);
            if (!existsSync(`${repoRoot}/lockwire.lock`))
                await writeLockfile(repoRoot, { version: 1, anchors: [] });
            await mkdir(`${repoRoot}/.lockwire`, { recursive: true });
            await ensureLockwireGitignore(repoRoot);
            const gitattrPath = `${repoRoot}/.gitattributes`;
            const line = ".lockwire/ledger.jsonl merge=union\n";
            if (existsSync(gitattrPath)) {
                const { readFile } = await import("node:fs/promises");
                const current = await readFile(gitattrPath, "utf8");
                if (!current.includes("ledger.jsonl"))
                    await writeFile(gitattrPath, `${current}${line}`, "utf8");
            }
            else {
                await writeFile(gitattrPath, line, "utf8");
            }
            console.log("lockwire initialized: lockwire.lock, .lockwire/config.json, .gitattributes (ledger merge=union)");
            if (isPathGitignored(repoRoot, "lockwire.lock"))
                console.warn("warning: lockwire.lock matches a pattern in .gitignore -- it won't be committed, " +
                    "so anchors and history won't be shared with anyone else who clones this repo.");
            break;
        }
        case "link": {
            const config = await readConfig(repoRoot);
            const [docArg, target] = positional;
            if (!docArg) {
                // No doc named: link every doc the config selects (`docs` / `exclude`) that has markers.
                const totals = { docs: 0, created: 0, refreshed: 0, skipped: 0 };
                for (const doc of await discoverDocs(repoRoot, config)) {
                    const abs = resolveInsideRepo(repoRoot, doc);
                    if (!abs || scanMarkers(await readFile(abs, "utf8")).length === 0)
                        continue;
                    const result = await withRepoLock(repoRoot, () => linkDoc(repoRoot, doc, config, actor, { reviewed: Boolean(flags.reviewed) }));
                    printLinkResult(doc, result);
                    totals.docs++;
                    totals.created += result.created;
                    totals.refreshed += result.refreshed;
                    totals.skipped += result.skipped.length;
                }
                if (totals.docs === 0)
                    console.log(`no docs with lockwire markers found (docs: ${config.docs.join(", ")}; exclude: ${config.exclude.join(", ")})`);
                else if (totals.docs > 1)
                    console.log(`${totals.docs} docs: ${totals.created} created, ${totals.refreshed} refreshed${totals.skipped ? `, ${totals.skipped} skipped` : ""}`);
                break;
            }
            const doc = toRepoPath(repoRoot, docArg);
            if (doc.startsWith(".."))
                throw new Error(`${docArg} is outside the repository (${repoRoot})`);
            if (target) {
                const [rawPath, symbol] = splitTarget(target);
                const path = rawPath ? toRepoPath(repoRoot, rawPath) : rawPath;
                const tiers = typeof flags.tiers === "string"
                    ? flags.tiers.split(",")
                    : symbol
                        ? dataFormatOf(path ?? "")
                            ? ["value"]
                            : ["sig"]
                        : ["path", "body"];
                if (!path)
                    throw new Error("target must be path or path#Symbol");
                const anchor = await withRepoLock(repoRoot, () => linkLockfileOnly(repoRoot, doc, { path, ...(symbol ? { symbol } : {}) }, tiers, config, actor));
                console.log(`linked ${anchor.id} -> ${target}`);
            }
            else {
                const result = await withRepoLock(repoRoot, () => linkDoc(repoRoot, doc, config, actor, { reviewed: Boolean(flags.reviewed) }));
                printLinkResult(doc, result);
            }
            break;
        }
        case "check": {
            const config = await readConfig(repoRoot);
            const scopedByGit = Boolean(flags.changed || flags.staged);
            if (scopedByGit && positional.length > 0)
                throw new Error("pass either paths or --changed/--staged, not both");
            const changedOnly = scopedByGit
                ? changedFiles(repoRoot, {
                    ...(typeof flags.base === "string" ? { base: flags.base } : {}),
                    staged: Boolean(flags.staged),
                })
                : positional.length > 0
                    ? positional.map((p) => toRepoPath(repoRoot, p))
                    : undefined;
            const result = await withRepoLock(repoRoot, () => check(repoRoot, config, changedOnly, { write: !flags["no-write"], actor }));
            const fmt = typeof flags.format === "string" ? flags.format : "text";
            const out = fmt === "json"
                ? formatJson(result, null)
                : fmt === "github"
                    ? formatGithub(result, { failOnUnlinked: Boolean(flags["fail-on-unlinked"]) })
                    : formatText(result);
            console.log(out);
            if (fmt === "text" && !flags["no-write"] && result.summary.relocated > 0) {
                const docs = [
                    ...new Set(result.results
                        .filter((r) => r.anchor.doc && r.anchor.target.symbol)
                        .map((r) => r.anchor.doc)),
                ];
                console.log(`note: ${result.summary.relocated} anchor${result.summary.relocated === 1 ? "" : "s"} relocated to a renamed symbol; the doc marker still names the old one. Run \`lockwire link ${docs.length === 1 ? docs[0] : "<doc>"}\` to update it.`);
            }
            const failed = result.summary.drifted > 0 ||
                result.summary.orphaned > 0 ||
                (Boolean(flags["fail-on-unlinked"]) && result.summary.unlinked > 0);
            process.exitCode = failed ? 1 : 0;
            break;
        }
        case "status": {
            const anchors = await status(repoRoot, typeof flags.scope === "string" ? flags.scope : undefined);
            if (flags.json)
                console.log(JSON.stringify(anchors, null, 2));
            else
                for (const a of anchors)
                    console.log(`${a.id}  ${a.status.padEnd(10)} ${a.target.path}${a.target.symbol ? `#${a.target.symbol}` : ""}`);
            break;
        }
        case "refs": {
            const [target] = positional;
            if (!target)
                throw new Error("usage: lockwire refs <path>[#symbol]");
            const [rawPath, symbol] = splitTarget(target);
            const anchors = await refs(repoRoot, toRepoPath(repoRoot, rawPath ?? ""), symbol);
            for (const a of anchors)
                console.log(`${a.doc ?? "(lockfile-only)"}:${a.claim?.line ?? "-"}  ${a.id}`);
            break;
        }
        case "history": {
            const [ref] = positional;
            if (!ref)
                throw new Error("usage: lockwire history <anchor-id | path#symbol | doc.md>");
            const { events } = await history(repoRoot, ref);
            for (const e of events)
                console.log(`${e.ts}  ${e.event.padEnd(20)} ${e.tier ?? ""} ${e.note ?? ""}`.trimEnd());
            break;
        }
        case "ack": {
            const [id] = positional;
            const resolution = flags.resolution;
            if (!id || typeof resolution !== "string")
                throw new Error("usage: lockwire ack <id> --resolution updated|superseded|false-positive");
            if (!["updated", "superseded", "false-positive"].includes(resolution))
                throw new Error(`unknown resolution "${resolution}": use updated, superseded or false-positive`);
            const config = await readConfig(repoRoot);
            await withRepoLock(repoRoot, () => ack(repoRoot, id, resolution, typeof flags.note === "string" ? flags.note : undefined, actor, config));
            console.log(`acknowledged ${id}`);
            break;
        }
        case "waive": {
            const [id] = positional;
            if (!id || typeof flags.reason !== "string" || typeof flags.expires !== "string")
                throw new Error("usage: lockwire waive <id> --reason ... --expires YYYY-MM-DD");
            await withRepoLock(repoRoot, () => waive(repoRoot, id, String(flags.reason), String(flags.expires), actor));
            console.log(`waived ${id} until ${flags.expires}`);
            break;
        }
        case "unlink": {
            const [id] = positional;
            if (!id)
                throw new Error("usage: lockwire unlink <id>");
            await withRepoLock(repoRoot, () => unlink(repoRoot, id));
            console.log(`unlinked ${id}`);
            break;
        }
        case "ledger": {
            if (positional[0] === "verify") {
                const result = await verifyLedger(repoRoot);
                console.log(`${result.total} events · ${result.ok ? "all hashes verify" : `${result.badLines.length} bad line(s): ${result.badLines.join(",")}`}`);
                console.log(`root: ${result.root}`);
                process.exitCode = result.ok ? 0 : 1;
            }
            break;
        }
        case "hook": {
            const adapter = positional[0];
            if (adapter === "claude-pre" || adapter === "claude-post")
                await runClaudeHook(adapter, repoRoot);
            else if (adapter === "codex-pre" || adapter === "codex-post")
                await runCodexHook(adapter, repoRoot);
            else
                throw new Error("usage: lockwire hook claude-pre|claude-post|codex-pre|codex-post");
            break;
        }
        case "autofix": {
            // Run the user's own agent on the work queue, then check what it did (see autofix.ts).
            if (flags.changed && positional.length > 0)
                throw new Error("pass either paths or --changed, not both");
            const scope = flags.changed
                ? changedFiles(repoRoot, typeof flags.base === "string" ? { base: flags.base } : {})
                : positional.length > 0
                    ? positional.map((p) => toRepoPath(repoRoot, p))
                    : undefined;
            const agent = typeof flags.agent === "string" ? flags.agent : "claude-code";
            if (agent !== "claude-code" && agent !== "codex")
                throw new Error(`unknown --agent "${agent}": use claude-code, codex, or --agent-command "<command>"`);
            const maxTurns = typeof flags["max-turns"] === "string" ? Number(flags["max-turns"]) : undefined;
            if (maxTurns !== undefined && !(Number.isInteger(maxTurns) && maxTurns > 0))
                throw new Error(`--max-turns must be a positive whole number, not "${flags["max-turns"]}"`);
            const report = await autofix(repoRoot, {
                agent,
                ...(typeof flags["agent-command"] === "string"
                    ? { agentCommand: flags["agent-command"] }
                    : {}),
                ...(scope ? { scope } : {}),
                ...(maxTurns ? { maxTurns } : {}),
                dryRun: Boolean(flags["dry-run"]),
                showAgentOutput: !flags.quiet,
            });
            if (typeof flags.summary === "string")
                await writeFile(flags.summary, report.markdown, "utf8");
            if (flags.json)
                console.log(JSON.stringify(report, null, 2));
            else
                console.log(report.markdown.trimEnd());
            process.exitCode = report.status === "refused" ? 2 : report.status === "partial" ? 1 : 0;
            break;
        }
        case "tasks": {
            // The agent work queue: what needs attention, one line each (or JSON for an agent).
            const config = await readConfig(repoRoot);
            if (flags.changed && positional.length > 0)
                throw new Error("pass either paths or --changed, not both");
            const scope = flags.changed
                ? changedFiles(repoRoot, typeof flags.base === "string" ? { base: flags.base } : {})
                : positional.length > 0
                    ? positional.map((p) => toRepoPath(repoRoot, p))
                    : undefined;
            const tasks = await listTasks(repoRoot, config, scope);
            if (flags.json)
                console.log(JSON.stringify(tasks, null, 2));
            else if (tasks.length === 0)
                console.log("no documentation tasks");
            else {
                for (const t of tasks)
                    console.log(`${t.id}  ${t.kind.padEnd(14)} ${t.doc ?? "(lockfile-only)"}:${t.line ?? "-"}  ${t.summary}`);
                console.log(`${tasks.length} task${tasks.length === 1 ? "" : "s"} — \`lockwire task <id>\` for one in full`);
            }
            break;
        }
        case "task": {
            const [id] = positional;
            if (!id)
                throw new Error("usage: lockwire task <id> [--json]");
            const ctx = await taskContext(repoRoot, await readConfig(repoRoot), id);
            if (flags.json) {
                console.log(JSON.stringify(ctx, null, 2));
                break;
            }
            const { task } = ctx;
            console.log(`${task.id}  ${task.kind}  ${task.doc ?? "(lockfile-only)"}:${task.line ?? "-"}`);
            console.log(`  ${task.summary}`);
            if (ctx.claimText)
                console.log(`\nclaim:\n  ${ctx.claimText}`);
            const show = (title, snap) => {
                console.log(`\n${title}${snap.commit ? ` (${snap.commit.slice(0, 7)}${snap.exact === false ? ", approximate" : ""})` : ""}:`);
                if (snap.source !== null)
                    console.log(snap.source.replace(/^/gm, "  "));
                if (snap.note)
                    console.log(`  (${snap.note})`);
            };
            if (ctx.stamped)
                show("as stamped", ctx.stamped);
            show("now", ctx.now);
            console.log("\nto resolve:");
            for (const r of task.resolutions)
                console.log(`  - ${r}`);
            break;
        }
        case "resolve": {
            const [id] = positional;
            if (!id)
                throw new Error('usage: lockwire resolve <id> [--note "what you checked"]');
            const outcome = await resolveTask(repoRoot, await readConfig(repoRoot), id, actor, typeof flags.note === "string" ? flags.note : undefined);
            console.log(outcome.status === "refused"
                ? `refused ${id}: ${outcome.reason}`
                : `${outcome.status} ${id}${outcome.anchorId && outcome.anchorId !== id ? ` (now anchor ${outcome.anchorId})` : ""}`);
            if (outcome.remaining.length > 0)
                console.log(`${outcome.remaining.length} more on the same doc: ${outcome.remaining.map((t) => t.id).join(", ")}`);
            process.exitCode = outcome.status === "refused" ? 1 : 0;
            break;
        }
        case "index": {
            // Build or refresh the doc index the PreToolUse hook uses to find unlinked claims quickly.
            const config = await readConfig(repoRoot);
            const index = await loadDocIndex(repoRoot, config, { rebuild: Boolean(flags.rebuild) });
            const markers = index.docs.reduce((n, d) => n + (index.markersOf(d)?.length ?? 0), 0);
            const { stats } = index;
            console.log(`indexed ${index.docs.length} doc${index.docs.length === 1 ? "" : "s"} (${markers} marker${markers === 1 ? "" : "s"}) → ${toDisplayPath(repoRoot, indexPath(repoRoot))}`);
            console.log(stats.rebuilt
                ? `built from scratch: read ${stats.docsRead} docs`
                : `refreshed: re-read ${stats.docsRead} doc${stats.docsRead === 1 ? "" : "s"}, re-listed ${stats.dirsRescanned} director${stats.dirsRescanned === 1 ? "y" : "ies"}`);
            if (!stats.rebuilt && stats.docsRead === 0 && stats.dirsRescanned === 0)
                console.log("already up to date");
            break;
        }
        case "mcp": {
            const { startMcpServer } = await import("./mcp-server.js");
            await startMcpServer(repoRoot);
            break;
        }
        default:
            console.log("lockwire — bind documentation claims to code fingerprints\n");
            console.log("commands: init, link, check, tasks, task, resolve, autofix, status, refs, history, ack, waive, unlink, ledger verify, index, hook, mcp");
            process.exitCode = cmd ? 1 : 0;
    }
}
main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map