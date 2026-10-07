#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { ack, check, discoverDocs, history, linkDoc, linkLockfileOnly, refs, status, unlink, waive, } from "./actions.js";
import { cliActor } from "./actor.js";
import { changedFiles } from "./changed.js";
import { readConfig, writeConfig } from "./config.js";
import { formatGithub, formatJson, formatText } from "./format.js";
import { runClaudeHook } from "./hook-claude.js";
import { runCodexHook } from "./hook-codex.js";
import { readLedger, verifyLedger } from "./ledger.js";
import { readLockfile, writeLockfile } from "./lockfile.js";
import { findRepoRoot, isPathGitignored, toRepoPath } from "./repo.js";
import { DEFAULT_CONFIG } from "./types.js";
/** Flags that never take a value, so `check --changed src/a.ts` leaves `src/a.ts` a path. */
const BOOLEAN_FLAGS = new Set(["changed", "staged", "no-write", "reviewed", "json"]);
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
            if (!docArg)
                throw new Error("usage: lockwire link <doc.md> [target] [--tiers a,b]");
            const doc = toRepoPath(repoRoot, docArg);
            if (doc.startsWith(".."))
                throw new Error(`${docArg} is outside the repository (${repoRoot})`);
            if (target) {
                const [rawPath, symbol] = target.split("#");
                const path = rawPath ? toRepoPath(repoRoot, rawPath) : rawPath;
                const tiers = typeof flags.tiers === "string"
                    ? flags.tiers.split(",")
                    : symbol
                        ? ["sig"]
                        : ["path", "body"];
                if (!path)
                    throw new Error("target must be path or path#Symbol");
                const anchor = await linkLockfileOnly(repoRoot, doc, { path, ...(symbol ? { symbol } : {}) }, tiers, config, actor);
                console.log(`linked ${anchor.id} -> ${target}`);
            }
            else {
                const result = await linkDoc(repoRoot, doc, config, actor, {
                    reviewed: Boolean(flags.reviewed),
                });
                console.log(`${doc}: ${result.created} created, ${result.refreshed} refreshed${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}`);
                for (const s of result.skipped)
                    console.log(`  skipped ${s.target}: ${s.reason}`);
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
            const result = await check(repoRoot, config, changedOnly, {
                write: !flags["no-write"],
                actor,
            });
            const fmt = typeof flags.format === "string" ? flags.format : "text";
            const out = fmt === "json"
                ? formatJson(result, null)
                : fmt === "github"
                    ? formatGithub(result)
                    : formatText(result);
            console.log(out);
            process.exitCode = result.summary.drifted > 0 || result.summary.orphaned > 0 ? 1 : 0;
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
            const [rawPath, symbol] = target.split("#");
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
            await ack(repoRoot, id, resolution, typeof flags.note === "string" ? flags.note : undefined, actor, config);
            console.log(`acknowledged ${id}`);
            break;
        }
        case "waive": {
            const [id] = positional;
            if (!id || typeof flags.reason !== "string" || typeof flags.expires !== "string")
                throw new Error("usage: lockwire waive <id> --reason ... --expires YYYY-MM-DD");
            await waive(repoRoot, id, flags.reason, flags.expires, actor);
            console.log(`waived ${id} until ${flags.expires}`);
            break;
        }
        case "unlink": {
            const [id] = positional;
            if (!id)
                throw new Error("usage: lockwire unlink <id>");
            await unlink(repoRoot, id);
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
        case "mcp": {
            const { startMcpServer } = await import("./mcp-server.js");
            await startMcpServer(repoRoot);
            break;
        }
        default:
            console.log("lockwire — bind documentation claims to code fingerprints\n");
            console.log("commands: init, link, check, status, refs, history, ack, waive, unlink, ledger verify, hook, mcp");
            process.exitCode = cmd ? 1 : 0;
    }
}
main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map