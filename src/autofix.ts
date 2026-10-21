/**
 * `lockwire autofix`: run the agent the user already pays for against lockwire's work queue, then
 * check what it did. lockwire supplies no model and never edits a sentence itself; it decides whether
 * there is anything to do (so an agent is only started when a claim is actually wrong), hands the
 * agent the fix-docs instructions and lockwire's own MCP server, and afterwards re-checks every claim
 * from scratch and refuses a run that changed anything other than documentation.
 *
 * Agents: Claude Code (`claude -p`), Codex (`codex exec`), or any command (`--agent-command`), which
 * gets the prompt and an MCP config through LOCKWIRE_PROMPT_FILE / LOCKWIRE_MCP_CONFIG.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { headCommit, indexEntries } from "./changed.js";
import { readConfig } from "./config.js";
import { canonicalJson } from "./hash.js";
import { ledgerPath, verifiedRecord } from "./ledger.js";
import { readLockfile } from "./lockfile.js";
import { scanMarkers } from "./markers.js";
import { isScannedDoc, resolveInsideRepo, walkFiles } from "./repo.js";
import { fixDocsPrompt, listTasks, type Task } from "./tasks.js";
import type { Anchor, LedgerRecord, Lockfile } from "./types.js";

export type AgentKind = "claude-code" | "codex";

export interface AutofixOptions {
  /** A built-in agent launcher. */
  agent?: AgentKind;
  /** Or any shell command; it gets LOCKWIRE_PROMPT_FILE, LOCKWIRE_MCP_CONFIG and LOCKWIRE_REPO. */
  agentCommand?: string;
  /** Limit the work to these paths (as `lockwire tasks <paths>`). */
  scope?: string[];
  /** Turn budget for the agent. */
  maxTurns?: number;
  /** Stop the agent after this long. */
  timeoutMs?: number;
  /** Print what would run, and run nothing. */
  dryRun?: boolean;
  /** How the agent should start lockwire's MCP server. Default: this lockwire (`node <cli.js> mcp`). */
  lockwireCommand?: { command: string; args: string[] };
  /** Show the agent's output (default true); tests turn it off. */
  showAgentOutput?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface AutofixResolution {
  event: LedgerRecord["event"];
  anchor: string;
  doc: string | null;
  target: string;
  claim: string | null;
  note: string | null;
  by: string;
}

export interface AutofixReport {
  /**
   * nothing-to-do: no task, no agent started. fixed: every task is gone. partial: some remain.
   * refused: the agent changed files that aren't documentation, or couldn't be run — don't ship it.
   */
  status: "nothing-to-do" | "fixed" | "partial" | "refused";
  before: Task[];
  after: Task[];
  /** How many of `before` are gone from `after` (new problems the run caused don't offset it). */
  fixed: number;
  /** Why a run was refused, besides out-of-bounds files: the agent committed, edited lockwire's state by hand, ... */
  problems: string[];
  resolutions: AutofixResolution[];
  /** Every file the run changed (repo-relative). */
  changedFiles: string[];
  /** Changed files that are neither docs nor lockwire's own (code, data, config): why a run is refused. */
  outOfBounds: string[];
  agent?: { command: string; exitCode: number | null; error?: string };
  /** A pull-request body: what was fixed, what's left, and anything refused. */
  markdown: string;
}

/** The argv that starts a built-in agent on `prompt`. Exported so the exact flags are tested. */
export function agentArgv(
  agent: AgentKind,
  prompt: string,
  files: { mcpConfig: string },
  opts: { maxTurns?: number; bare?: boolean } = {},
): { command: string; args: string[] } {
  if (agent === "claude-code")
    return {
      command: "claude",
      args: [
        "-p",
        prompt,
        // In CI, --bare: don't run the repository's own .claude/settings.json hooks or .mcp.json
        // servers (repository-controlled code) with the API key in the environment. Not locally,
        // where it would also switch off a subscription login.
        ...(opts.bare ? ["--bare"] : []),
        "--mcp-config",
        files.mcpConfig,
        "--strict-mcp-config",
        // Read and edit files, and use lockwire's tools; no shell, so the agent can't run repo code.
        "--allowedTools",
        "mcp__lockwire__*",
        "Read",
        "Edit",
        "Write",
        "Glob",
        "Grep",
        "--permission-mode",
        "acceptEdits",
        "--max-turns",
        String(opts.maxTurns ?? 40),
        "--output-format",
        "json",
      ],
    };
  return {
    command: "codex",
    // MCP servers come from $CODEX_HOME/config.toml, which autofix writes (see codexHome).
    args: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", prompt],
  };
}

/** Claude Code's `--mcp-config` file: lockwire's MCP server, started the way this lockwire runs. */
export function mcpConfigJson(lockwire: { command: string; args: string[] }): string {
  return `${JSON.stringify({ mcpServers: { lockwire: { command: lockwire.command, args: lockwire.args } } }, null, 2)}\n`;
}

const tomlString = (s: string) => JSON.stringify(s); // a TOML basic string is a JSON string

/** Codex's config.toml: lockwire's MCP server, required, its tools approved without prompting. */
export function codexConfigToml(lockwire: { command: string; args: string[] }): string {
  return [
    "[mcp_servers.lockwire]",
    `command = ${tomlString(lockwire.command)}`,
    `args = [${lockwire.args.map(tomlString).join(", ")}]`,
    "required = true",
    'default_tools_approval_mode = "approve"',
    "",
  ].join("\n");
}

function defaultLockwireCommand(): { command: string; args: string[] } {
  const cli = join(fileURLToPath(new URL(".", import.meta.url)), "cli.js");
  return { command: process.execPath, args: [cli, "mcp"] };
}

/** A file's content hash, read in chunks (any size); a symlink hashes as its target path. */
function fileHash(abs: string): string | null {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
    if (!st.isFile()) return null; // a FIFO or device could block a read forever
  } catch {
    return null; // vanished mid-walk
  }
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch {
    return null;
  }
  try {
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 20);
    for (
      let n = readSync(fd, buf, 0, buf.length, null);
      n > 0;
      n = readSync(fd, buf, 0, buf.length, null)
    )
      hash.update(buf.subarray(0, n));
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Files under `dir` (repo-relative, posix), or none if it isn't a directory. */
function filesUnder(repoRoot: string, dir: string): string[] {
  try {
    if (!lstatSync(join(repoRoot, dir)).isDirectory()) return [];
  } catch {
    return [];
  }
  return walkFiles(join(repoRoot, dir)).map((rel) => `${dir}/${rel}`);
}

/** lockwire's own scratch files, which its tools rewrite on every call. */
const LOCKWIRE_SCRATCH = /^\.lockwire\/(cache\/|lock$|hook\.log$)/;

/**
 * Content hashes of everything a run could change that matters: the tree (minus .git and
 * node_modules), lockwire's state in .lockwire/ (its config and ledger, not its cache), and the git
 * settings that run code on the next git command (.git/config, hooks, info).
 */
function treeHashes(repoRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const paths = [
    ...walkFiles(repoRoot),
    ...filesUnder(repoRoot, ".lockwire").filter((p) => !LOCKWIRE_SCRATCH.test(p)),
    ".git/config",
    ...filesUnder(repoRoot, ".git/hooks"),
    ...filesUnder(repoRoot, ".git/info"),
  ];
  for (const rel of paths) {
    const h = fileHash(join(repoRoot, rel));
    if (h !== null) out.set(rel, h);
  }
  return out;
}

/** Paths whose entry differs; if one side is missing altogether (a repo appeared or vanished), all of them. */
function diffMaps(before: Map<string, string> | null, after: Map<string, string> | null): string[] {
  if (!before || !after) return [...(before ?? after ?? new Map<string, string>()).keys()];
  const changed = new Set<string>();
  for (const [p, h] of after) if (before.get(p) !== h) changed.add(p);
  for (const p of before.keys()) if (!after.has(p)) changed.add(p);
  return [...changed];
}

/** How long an agent gets to exit after SIGTERM before everything it started is killed. */
const KILL_GRACE_MS = 2000;

function run(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean; timeoutMs: number; show: boolean },
): Promise<{ exitCode: number | null; error?: string }> {
  // On POSIX the agent leads its own process group, so a timeout (or the end of the run) stops
  // everything it started, not just the shell or launcher at the top: nothing it spawned can keep
  // writing to the tree after lockwire has judged it.
  const group = process.platform !== "win32";
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: opts.shell,
        detached: group,
        // The agent's output goes to stderr, so `lockwire autofix --json` keeps stdout for the report.
        stdio: ["ignore", opts.show ? 2 : "ignore", opts.show ? 2 : "ignore"],
      });
    } catch (err) {
      resolve({ exitCode: null, error: String(err) });
      return;
    }
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (group) process.kill(-child.pid, signal);
        else if (signal === "SIGKILL")
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill(signal);
      } catch {
        // already gone
      }
    };
    let timedOut = false;
    let hard: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!group) return kill("SIGKILL"); // Windows: taskkill the tree while its root is still there
      kill("SIGTERM");
      hard = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
    }, opts.timeoutMs);
    // A detached group doesn't get the terminal's Ctrl-C: pass it on, then die of it as usual.
    const signals: NodeJS.Signals[] = group ? ["SIGINT", "SIGTERM", "SIGHUP"] : [];
    const onSignal = (signal: NodeJS.Signals) => {
      kill("SIGKILL");
      for (const s of signals) process.off(s, onSignal);
      process.kill(process.pid, signal);
    };
    for (const s of signals) process.on(s, onSignal);
    let done = false;
    const finish = (result: { exitCode: number | null; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(hard);
      for (const s of signals) process.off(s, onSignal);
      if (group) kill("SIGKILL"); // whatever the agent left running in the background
      resolve(result);
    };
    child.on("error", (err) => finish({ exitCode: null, error: err.message }));
    child.on("exit", (code, signal) =>
      finish(
        timedOut
          ? {
              exitCode: null,
              error: `stopped after the ${Math.round(opts.timeoutMs / 1000)}s timeout`,
            }
          : signal
            ? { exitCode: null, error: `stopped by ${signal}` }
            : { exitCode: code },
      ),
    );
  });
}

const RESOLUTION_EVENTS = new Set<LedgerRecord["event"]>([
  "anchor.resolved",
  "anchor.created",
  "anchor.acknowledged",
]);

/** lockwire's own files: a run may change them, but only through lockwire (see {@link lockwireStateProblems}). */
const LOCKWIRE_OWN = new Set(["lockwire.lock", ".lockwire/ledger.jsonl"]);

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A task's identity across a run: an unlinked marker's id carries its line, which edits above it shift. */
const identity = (t: Task) =>
  t.id.startsWith("unlinked:") ? t.id.replace(/:\d+:([0-9a-f]{8})$/, ":$1") : t.id;

/** How many of the tasks before a run are gone after it. New problems don't offset fixed ones. */
export function fixedCount(before: readonly Task[], after: readonly Task[]): number {
  const open = new Set(after.map(identity));
  return before.filter((t) => !open.has(identity(t))).length;
}

/** An anchor as written, for comparison; a backfilled `claim.normHash` (lockwire check adds it) isn't a change. */
function comparable(a: Anchor, was: Anchor): string {
  if (a.claim && was.claim && !was.claim.normHash && a.claim.normHash) {
    const { normHash: _, ...claim } = a.claim;
    return canonicalJson({ ...a, claim });
  }
  return canonicalJson(a);
}

/**
 * The ledger records a run appended, and anything wrong with how lockwire's state changed. lockwire's
 * tools only append verified records to the ledger, and change an anchor only with a record for it;
 * an agent editing either file by hand (to make a claim look fixed) breaks one of those rules.
 */
function lockwireStateProblems(
  ledgerBefore: string,
  ledgerAfter: string,
  lockBefore: Lockfile,
  lockAfter: Lockfile,
): { added: LedgerRecord[]; problems: string[] } {
  const problems: string[] = [];
  const added: LedgerRecord[] = [];
  if (!ledgerAfter.startsWith(ledgerBefore)) {
    problems.push("The ledger was rewritten during the run: lockwire only ever appends to it.");
  } else {
    const lines = ledgerAfter.slice(ledgerBefore.length).split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = verifiedRecord(line.replace(/\r$/, ""));
      if (record) added.push(record);
      else
        problems.push(
          "A ledger record added during the run doesn't verify (its hash doesn't match): it was written by hand, not by lockwire.",
        );
    }
  }
  const recorded = new Set(added.map((r) => r.anchor));
  const created = new Set(added.filter((r) => r.event === "anchor.created").map((r) => r.anchor));
  const was = new Map(lockBefore.anchors.map((a) => [a.id, a]));
  for (const a of lockAfter.anchors) {
    const prev = was.get(a.id);
    if (prev && comparable(a, prev) === canonicalJson(prev)) continue;
    if (prev ? !recorded.has(a.id) : !created.has(a.id))
      problems.push(
        `lockwire.lock was edited by hand: anchor ${a.id} ${prev ? "changed" : "appeared"} with no ledger record of lockwire doing it.`,
      );
  }
  return { added, problems: [...new Set(problems)] };
}

/**
 * Tasks a run silenced rather than fixed: the anchor was retired (superseded or waived) or dropped,
 * but the claim is still in the doc, marker and all, or as the same sentence with its marker deleted.
 * A wrong claim that's merely no longer tracked is still wrong.
 */
async function retiredInPlace(
  repoRoot: string,
  before: readonly Task[],
  after: readonly Task[],
  lockAfter: Lockfile,
): Promise<Task[]> {
  const open = new Set(after.map(identity));
  const out: Task[] = [];
  for (const t of before) {
    if (t.id.startsWith("unlinked:") || open.has(identity(t)) || !t.doc) continue;
    const anchor = lockAfter.anchors.find((a) => a.id === t.id);
    if (anchor && anchor.status !== "superseded" && anchor.status !== "waived") continue;
    const abs = resolveInsideRepo(repoRoot, t.doc);
    if (!abs || !existsSync(abs)) continue;
    const text = await readFile(abs, "utf8");
    // A marker whose anchor is gone shows up as unlinked already; one whose anchor was retired doesn't.
    const markerThere = scanMarkers(text).some((m) => m.id === t.id);
    const sentence = (t.claim ?? "").replace(/…$/, "").replace(/\s+/g, " ").trim();
    const sentenceThere =
      t.kind !== "marker-removed" &&
      sentence.length >= 8 &&
      text.replace(/\s+/g, " ").includes(sentence);
    if ((markerThere && anchor) || (!markerThere && sentenceThere))
      out.push({
        ...t,
        summary: `retired (${anchor?.status ?? "removed from lockwire.lock"}) during the run, but the claim is still in ${t.doc}: fix or delete the sentence. Was: ${t.summary}`,
      });
  }
  return out;
}

export async function autofix(repoRoot: string, opts: AutofixOptions = {}): Promise<AutofixReport> {
  const config = await readConfig(repoRoot);
  const before = await listTasks(repoRoot, config, opts.scope);
  const empty = { fixed: 0, problems: [], resolutions: [], changedFiles: [], outOfBounds: [] };
  if (before.length === 0)
    return {
      status: "nothing-to-do",
      before,
      after: [],
      ...empty,
      markdown: "lockwire: no documentation claims need attention.\n",
    };

  const lockwire = opts.lockwireCommand ?? defaultLockwireCommand();
  const prompt = `${fixDocsPrompt(opts.scope)}\n\nThere are ${before.length} task${before.length === 1 ? "" : "s"} right now.`;
  const work = mkdtempSync(join(tmpdir(), "lockwire-autofix-"));
  const files = { prompt: join(work, "prompt.md"), mcpConfig: join(work, "mcp.json") };
  writeFileSync(files.prompt, prompt, "utf8");
  writeFileSync(files.mcpConfig, mcpConfigJson(lockwire), "utf8");

  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    LOCKWIRE_PROMPT_FILE: files.prompt,
    LOCKWIRE_MCP_CONFIG: files.mcpConfig,
    LOCKWIRE_REPO: repoRoot,
  };
  let command: string;
  let args: string[];
  let shell = false;
  if (opts.agentCommand) {
    command = opts.agentCommand;
    args = [];
    shell = true;
  } else {
    const agent = opts.agent ?? "claude-code";
    ({ command, args } = agentArgv(agent, prompt, files, {
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      bare: Boolean(env.CI),
    }));
    if (agent === "codex") {
      // Codex reads MCP servers from $CODEX_HOME/config.toml: give it one with lockwire in it, and
      // the user's own login if they have one (CI passes CODEX_API_KEY instead).
      const home = join(work, "codex-home");
      mkdirSync(home);
      writeFileSync(join(home, "config.toml"), codexConfigToml(lockwire), "utf8");
      const auth = join(env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
      if (existsSync(auth)) copyFileSync(auth, join(home, "auth.json"));
      env.CODEX_HOME = home;
    }
  }
  const shown = shell
    ? command
    : [command, ...args.map((a) => (a === prompt ? "<fix-docs prompt>" : a))].join(" ");

  if (opts.dryRun) {
    rmSync(work, { recursive: true, force: true });
    return {
      status: "partial",
      before,
      after: before,
      ...empty,
      agent: { command: shown, exitCode: null },
      markdown: `Dry run: would run \`${shown}\` on ${before.length} task(s).\n`,
    };
  }

  // Everything the verdict is judged against is taken before the agent starts, never from state the
  // agent could have edited: which files are docs, the anchors, the ledger, the commit and the index.
  const lockBefore = await readLockfile(repoRoot);
  const knownDocs = new Set(lockBefore.anchors.flatMap((a) => (a.doc ? [a.doc] : [])));
  const ledgerBefore = readText(ledgerPath(repoRoot));
  const headBefore = headCommit(repoRoot);
  const indexBefore = indexEntries(repoRoot);
  const treeBefore = treeHashes(repoRoot);
  const outcome = await run(command, args, {
    cwd: repoRoot,
    env,
    shell,
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
    show: opts.showAgentOutput !== false,
  });
  rmSync(work, { recursive: true, force: true });

  // The verdict is lockwire's, from scratch, not the agent's account of itself.
  const problems: string[] = [];
  const changed = new Set(diffMaps(treeBefore, treeHashes(repoRoot)));
  for (const p of diffMaps(indexBefore, indexEntries(repoRoot))) changed.add(p); // staged, not on disk
  const changedFiles = [...changed].sort();
  const outOfBounds = changedFiles.filter(
    (f) => !LOCKWIRE_OWN.has(f) && !knownDocs.has(f) && !isScannedDoc(f, config),
  );
  const headAfter = headCommit(repoRoot);
  if (headAfter !== headBefore)
    problems.push(
      `The agent moved HEAD (${headBefore ?? "no commit"} to ${headAfter ?? "no commit"}): it committed or checked something out, and its commits would ride into the pull request.`,
    );

  let after: Task[] = before;
  let lockAfter: Lockfile = lockBefore;
  let added: LedgerRecord[] = [];
  try {
    lockAfter = await readLockfile(repoRoot);
    const state = lockwireStateProblems(
      ledgerBefore,
      readText(ledgerPath(repoRoot)),
      lockBefore,
      lockAfter,
    );
    added = state.added;
    problems.push(...state.problems);
    after = await listTasks(repoRoot, config, opts.scope);
    after = [...after, ...(await retiredInPlace(repoRoot, before, after, lockAfter))];
  } catch (err) {
    problems.push(`lockwire couldn't re-check the claims after the run: ${errorText(err)}`);
  }

  const resolutions: AutofixResolution[] = added
    .filter((e) => RESOLUTION_EVENTS.has(e.event))
    .map((e) => {
      const a = lockAfter.anchors.find((x) => x.id === e.anchor);
      return {
        event: e.event,
        anchor: e.anchor,
        doc: a?.doc ?? null,
        target: a ? `${a.target.path}${a.target.symbol ? `#${a.target.symbol}` : ""}` : "?",
        claim: a?.claim?.excerpt ?? null,
        note: e.note ?? null,
        by: e.actor.tool?.name ?? e.actor.type,
      };
    });

  const agentFailed = outcome.exitCode !== 0;
  const status: AutofixReport["status"] =
    outOfBounds.length > 0 ||
    problems.length > 0 ||
    (agentFailed && changedFiles.length === 0 && after.length === before.length)
      ? "refused"
      : after.length === 0
        ? "fixed"
        : "partial";
  const report: AutofixReport = {
    status,
    before,
    after,
    fixed: fixedCount(before, after),
    problems,
    resolutions,
    changedFiles,
    outOfBounds,
    agent: {
      command: shown,
      exitCode: outcome.exitCode,
      ...(outcome.error ? { error: outcome.error } : {}),
    },
    markdown: "",
  };
  report.markdown = summaryMarkdown(report);
  return report;
}

const cell = (s: string | null) => (s ?? "").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, " ");

/** A pull-request body for an autofix run. */
export function summaryMarkdown(r: AutofixReport): string {
  const lines: string[] = [];
  const fixed = fixedCount(r.before, r.after);
  lines.push(
    r.status === "refused"
      ? "## lockwire autofix: refused"
      : `## lockwire autofix: ${fixed} of ${r.before.length} documentation claim${r.before.length === 1 ? "" : "s"} fixed`,
    "",
  );
  if (r.outOfBounds.length > 0)
    lines.push(
      "The agent changed files that aren't documentation, so this run must not be merged as a docs fix:",
      "",
      ...r.outOfBounds.map((f) => `- \`${cell(f)}\``),
      "",
    );
  if ((r.problems ?? []).length > 0)
    lines.push(...(r.problems ?? []).map((p) => `- ${cell(p)}`), "");
  if (r.agent?.error || (r.agent && r.agent.exitCode !== 0))
    lines.push(
      `The agent (\`${cell(r.agent.command)}\`) ${r.agent.error ? `failed: ${cell(r.agent.error)}` : `exited with code ${r.agent.exitCode}`}.`,
      "",
    );
  if (r.resolutions.length > 0) {
    lines.push("| Claim | Bound to | What the agent did |", "| --- | --- | --- |");
    for (const x of r.resolutions)
      lines.push(
        `| ${cell(x.doc)}: ${cell(x.claim)} | \`${cell(x.target)}\` | ${cell(x.event === "anchor.acknowledged" ? `retired (${x.note ?? "superseded"})` : (x.note ?? "re-stamped"))} |`,
      );
    lines.push("");
  }
  if (r.after.length > 0) {
    lines.push(
      `Still open (${r.after.length}):`,
      "",
      ...r.after.map(
        (t) =>
          `- \`${cell(t.id)}\` ${t.kind} — ${cell(t.doc ?? "(lockfile-only)")}:${t.line ?? "-"}: ${cell(t.summary)}`,
      ),
      "",
    );
  }
  lines.push(
    "Every change above was re-checked by lockwire after the agent finished: a number that still disagreed with its data, or a marker pointing at nothing, would still be listed as open. `lockwire history <id>` shows each claim's full record.",
  );
  return `${lines.join("\n")}\n`;
}
