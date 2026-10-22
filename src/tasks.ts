/**
 * The agent work queue. lockwire doesn't write documentation and has no model of its own; it tells
 * the agent the user already runs (Claude Code, Codex, anything that speaks MCP) exactly which claims
 * are wrong, gives it what it needs to fix each one, and checks the fix:
 *
 *   listTasks     what needs attention, as a list of tasks (a dry run of `check`, plus unlinked markers)
 *   taskContext   one task in full: the claim, the bound code or value as stamped and as it is now,
 *                 and how this claim was resolved before
 *   resolveTask   after the agent has edited the doc: re-stamp that one claim if it now holds, or say
 *                 why not — a number that still disagrees with its value is refused
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AnchorCheckResult, UnlinkedMarker } from "./actions.js";
import { ack, check, linkDoc, markerReader, resolveTargetInText, versionOf } from "./actions.js";
import { commitsTouching, fileAtCommit } from "./changed.js";
import { describeDrift } from "./format.js";
import { fingerprint } from "./hash.js";
import { appendEvent, historyFor, ledgerPath, readLedger } from "./ledger.js";
import { withRepoLock } from "./lock.js";
import {
  lockfilePath,
  readLockfile,
  upsertAnchor,
  writeFileAtomic,
  writeLockfile,
} from "./lockfile.js";
import type { DocMarker } from "./markers.js";
import { resolveInsideRepo } from "./repo.js";
import type { Actor, Anchor, LedgerRecord, LockwireConfig, Tier } from "./types.js";
import { tierFingerprint } from "./types.js";

export type TaskKind =
  /** The code a claim is bound to changed in a tier the claim depends on. */
  | "code-changed"
  /** A value anchor whose sentence no longer states the value. */
  | "value-wrong"
  /** A value anchor whose value moved and whose sentence states no number to check. */
  | "value-changed"
  /** The claim sentence was edited since it was stamped; the code didn't move. */
  | "claim-edited"
  /** The bound symbol, key or file is gone (or outside the repository). */
  | "target-missing"
  /** The marker was deleted from the doc. */
  | "marker-removed"
  /** A marker no anchor backs: the claim under it isn't being checked at all. */
  | "unlinked";

export interface Task {
  /**
   * An anchor id, or `unlinked:<doc>:<marker line>:<key>` for a marker with no anchor, where `key`
   * is a short hash of the marker's target and claim: a stale id can't land on a different marker.
   */
  id: string;
  kind: TaskKind;
  doc: string | null;
  /** The line of the claim sentence in `doc` (its marker is above it). */
  line: number | null;
  claim: string | null;
  target: string;
  /** One line: what is wrong. */
  summary: string;
  /** What to do, most likely first. */
  resolutions: string[];
}

const label = (t: { path: string; symbol?: string }) =>
  `${t.path}${t.symbol ? `#${t.symbol}` : ""}`;

function kindOf(r: AnchorCheckResult): TaskKind {
  if (r.status === "orphaned") return r.claimChanged ? "marker-removed" : "target-missing";
  if (r.value && !r.value.matches) return "value-wrong";
  if (r.driftedTiers.includes("value")) return "value-changed";
  if (r.driftedTiers.length > 0) return "code-changed";
  return "claim-edited";
}

const RESOLUTIONS: Record<TaskKind, string[]> = {
  "code-changed": [
    "Read lockwire_task_context to compare the code as stamped with the code now; update the claim sentence so it is true of the code now (or confirm it still is), then call lockwire_resolve.",
    "If the claim no longer applies at all, delete it and call lockwire_ack with resolution superseded.",
  ],
  "value-wrong": [
    "Change the number in the sentence to the current value, at the precision you mean, then call lockwire_resolve: it re-checks the number and refuses if it still disagrees.",
    "If the value itself is wrong (a bad rerun), fix the data, not the doc; the task clears when the value matches the sentence again.",
  ],
  "value-changed": [
    "The sentence states no number, so lockwire can't check it: confirm it is still true of the new value, then call lockwire_resolve.",
  ],
  "claim-edited": [
    "Someone reworded the claim. Confirm the new sentence is true of the code (lockwire_task_context shows it), then call lockwire_resolve.",
  ],
  "target-missing": [
    "If the symbol, key or file was renamed or moved, edit the marker to point at its new path#Symbol, then call lockwire_resolve.",
    "If the thing it described is gone, delete the claim and its marker and call lockwire_ack with resolution superseded.",
  ],
  "marker-removed": [
    "If the marker was removed by mistake, restore it (with its id) and call lockwire_resolve.",
    "If the claim was deliberately deleted, call lockwire_ack with resolution superseded.",
  ],
  unlinked: [
    "Check the sentence is true of its target (lockwire_task_context shows the target), fix it if not, then call lockwire_resolve to start checking it.",
  ],
};

function summaryOf(kind: TaskKind, r: AnchorCheckResult): string {
  const target = label(r.anchor.target);
  const what = describeDrift(r);
  switch (kind) {
    case "value-wrong":
      return `the claim says ${r.value?.claimed.join(", ") || "something else"} but ${target} is ${r.value?.now}`;
    case "value-changed":
      return `${target} changed (${what}) and the sentence states no number lockwire can check`;
    case "code-changed":
      return `${target} changed (${what})${r.claimChanged ? " and the claim was edited" : ""}`;
    case "claim-edited":
      return `the claim sentence was edited since it was checked against ${target}`;
    case "target-missing":
      return `${target} no longer exists`;
    case "marker-removed":
      return `the claim's marker was removed from ${r.anchor.doc}`;
    default:
      return what;
  }
}

// ---- ids -----------------------------------------------------------------------------------

/** Short content key of a marker: its target and its claim, whitespace-insensitive. */
const markerKey = (m: Pick<DocMarker, "target" | "claimNormHash">) =>
  fingerprint(`${label(m.target)}\u0000${m.claimNormHash}`).slice(3, 11);

interface UnlinkedRef {
  doc: string;
  line: number;
  key: string;
}

function parseUnlinkedId(id: string): UnlinkedRef | null {
  if (!id.startsWith("unlinked:")) return null;
  const rest = id.slice("unlinked:".length);
  const k = rest.lastIndexOf(":");
  const key = rest.slice(k + 1);
  const before = rest.slice(0, k);
  const l = before.lastIndexOf(":");
  const line = Number(before.slice(l + 1));
  const doc = before.slice(0, l);
  if (k < 0 || l < 0 || !/^[0-9a-f]{8}$/.test(key) || !Number.isInteger(line) || line < 1 || !doc)
    return null;
  return { doc, line, key };
}

function unlinkedTask(u: UnlinkedMarker, marker: DocMarker | undefined): Task {
  return {
    id: `unlinked:${u.doc}:${u.line}:${marker ? markerKey(marker) : "00000000"}`,
    kind: "unlinked",
    doc: u.doc,
    line: marker?.claimLine ?? u.line + 1,
    claim: u.excerpt,
    target: u.target,
    summary: `a claim about ${u.target} that nothing is checking (${u.reason})`,
    resolutions: RESOLUTIONS.unlinked,
  };
}

/**
 * Everything that needs attention, as tasks, in doc order. A dry run: nothing is written. `paths`
 * scopes it the way `check <paths>` does: anchors whose target or doc is one of them, or is inside a
 * listed directory.
 */
export async function listTasks(
  repoRoot: string,
  config: LockwireConfig,
  paths?: readonly string[],
): Promise<Task[]> {
  const result = await check(repoRoot, config, paths, { write: false });
  const readMarkers = markerReader(repoRoot);
  const tasks: Task[] = [];
  for (const r of result.results) {
    if (r.skipped || (r.status !== "drifted" && r.status !== "orphaned")) continue;
    const kind = kindOf(r);
    // Where the claim is *now*: lines move as a doc is edited, and an agent edits by line.
    const marker = r.anchor.doc
      ? (await readMarkers(r.anchor.doc))?.find((m) => m.id === r.anchor.id)
      : undefined;
    tasks.push({
      id: r.anchor.id,
      kind,
      doc: r.anchor.doc,
      line: marker?.claimLine ?? r.anchor.claim?.line ?? null,
      claim: marker?.claimExcerpt ?? r.anchor.claim?.excerpt ?? null,
      target: label(r.anchor.target),
      summary: summaryOf(kind, r),
      resolutions: RESOLUTIONS[kind],
    });
  }
  for (const u of result.unlinked) {
    const marker = (await readMarkers(u.doc))?.find((x) => x.line === u.line);
    tasks.push(unlinkedTask(u, marker));
  }
  return tasks.sort(
    (a, b) =>
      (a.doc ?? "\uffff").localeCompare(b.doc ?? "\uffff") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

/** The narrowest scope that still contains task `id`, so looking one task up doesn't re-check the repo. */
async function scopeFor(repoRoot: string, id: string): Promise<string[] | undefined> {
  const ref = parseUnlinkedId(id);
  if (ref) return [ref.doc];
  const anchor = (await readLockfile(repoRoot)).anchors.find((a) => a.id === id);
  if (!anchor) return undefined;
  return [...new Set([anchor.target.path, ...(anchor.doc ? [anchor.doc] : [])])];
}

/** The open task `id` names. An unlinked id is matched by its content key, so it survives line moves. */
async function findTask(
  repoRoot: string,
  config: LockwireConfig,
  id: string,
): Promise<{ task: Task | undefined; scope: string[] | undefined }> {
  const scope = await scopeFor(repoRoot, id);
  const tasks = await listTasks(repoRoot, config, scope);
  const ref = parseUnlinkedId(id);
  if (!ref) return { task: tasks.find((t) => t.id === id), scope };
  const same = tasks.filter((t) => {
    const r = t.kind === "unlinked" ? parseUnlinkedId(t.id) : null;
    return r?.doc === ref.doc && r.key === ref.key;
  });
  // Several identical markers: prefer the one on the line the id names.
  const task = same.find((t) => parseUnlinkedId(t.id)?.line === ref.line) ?? same[0];
  return { task, scope };
}

// ---- context ---------------------------------------------------------------------------------

/** A side of the comparison: the bound code (or value) at one point in time. */
export interface TargetSnapshot {
  /** The commit it was read from, for the stamped side. */
  commit?: string | null;
  /** The declaration as written (a symbol), the file (a whole-file anchor), or the value. */
  source: string | null;
  /** True when the code at that commit fingerprints exactly as stamped, so this is what the claim was checked against. */
  exact?: boolean;
  truncated?: boolean;
  /** Why `source` is null, or why it is only approximate. */
  note?: string;
}

export interface TaskContext {
  task: Task;
  /** The whole claim sentence (the task carries an excerpt). */
  claimText: string | null;
  tiers: Tier[];
  /** As stamped. Absent for an unlinked marker, which was never stamped. */
  stamped?: TargetSnapshot;
  now: TargetSnapshot;
  /** This claim's ledger history: how often it broke, and how it was resolved. */
  history: LedgerRecord[];
}

const MAX_SOURCE = 20_000;
const cap = (s: string): { source: string; truncated?: boolean } =>
  s.length > MAX_SOURCE
    ? { source: `${s.slice(0, MAX_SOURCE)}\n…`, truncated: true }
    : { source: s };

const parseTarget = (t: string) => {
  const i = t.indexOf("#");
  return i < 0 ? { path: t } : { path: t.slice(0, i), symbol: t.slice(i + 1) };
};

async function snapshotNow(
  repoRoot: string,
  config: LockwireConfig,
  target: { path: string; symbol?: string },
): Promise<TargetSnapshot> {
  const abs = resolveInsideRepo(repoRoot, target.path);
  if (!abs) return { source: null, note: "outside the repository" };
  if (!existsSync(abs)) return { source: null, note: `${target.path} does not exist` };
  try {
    const r = await resolveTargetInText(target, await readFile(abs, "utf8"), config);
    if (!r.found) return { source: null, note: `${label(target)} was not found in ${target.path}` };
    return cap(r.source ?? "");
  } catch (err) {
    return { source: null, note: err instanceof Error ? err.message : String(err) };
  }
}

async function snapshotStamped(
  repoRoot: string,
  config: LockwireConfig,
  anchor: Anchor,
): Promise<TargetSnapshot> {
  if (anchor.value !== undefined && anchor.tiers.includes("value"))
    return { source: anchor.value, commit: anchor.linked.commit, exact: true };
  if (!resolveInsideRepo(repoRoot, anchor.target.path))
    return { source: null, note: "outside the repository" };
  const recorded = anchor.linked.commit;

  /** The target at `commit`, and how many of the bound tiers fingerprint as stamped. */
  const at = async (commit: string) => {
    const text = fileAtCommit(repoRoot, commit, anchor.target.path);
    if (text === null) return null;
    try {
      const then = await resolveTargetInText(anchor.target, text, config, versionOf(anchor));
      if (!then.found) return null;
      const matching = anchor.tiers.filter(
        (t) => tierFingerprint(then.fingerprints, t) === tierFingerprint(anchor.fingerprints, t),
      ).length;
      return {
        commit,
        matching,
        exact: matching === anchor.tiers.length,
        source: then.source ?? "",
      };
    } catch {
      return null;
    }
  };

  // Claims are usually stamped before the change is committed, so the commit recorded at stamp time
  // can predate the code the claim was checked against: look from there on (oldest first) for the
  // first commit where the target fingerprints exactly as stamped. With no recorded commit, or one
  // that history no longer has (a rebase, a squash-merge), look through all of history, newest first.
  const candidates = [
    ...(recorded ? [recorded] : []),
    ...commitsTouching(repoRoot, anchor.target.path, recorded),
  ];
  type Snap = NonNullable<Awaited<ReturnType<typeof at>>>;
  let closest: Snap | null = null;
  for (const commit of [...new Set(candidates)]) {
    const snap = await at(commit);
    if (!snap) continue;
    if (snap.exact) return { commit: snap.commit, exact: true, ...cap(snap.source) };
    if (!closest || snap.matching > closest.matching) closest = snap;
  }
  if (closest)
    return {
      commit: closest.commit,
      exact: false,
      ...cap(closest.source),
      note: `no commit in the searched history has it exactly as stamped (stamped against uncommitted changes, or in history that was rewritten): this is the closest version found, matching ${closest.matching} of ${anchor.tiers.length} bound tiers`,
    };
  return {
    source: null,
    commit: recorded,
    note: recorded
      ? `${label(anchor.target)} could not be read at ${recorded} or in later history (not committed, or git unavailable)`
      : "no commit was recorded when this claim was stamped, and no commit has the target",
  };
}

export async function taskContext(
  repoRoot: string,
  config: LockwireConfig,
  id: string,
): Promise<TaskContext> {
  const { task } = await findTask(repoRoot, config, id);
  if (!task) throw new Error(`no open task ${id}: call lockwire_tasks for the current list`);
  const readMarkers = markerReader(repoRoot);

  if (task.kind === "unlinked") {
    const ref = parseUnlinkedId(task.id);
    const marker = task.doc
      ? (await readMarkers(task.doc))?.find((m) => m.line === ref?.line)
      : undefined;
    return {
      task,
      claimText: marker?.claimText ?? null,
      tiers: marker?.tiers ?? [],
      now: await snapshotNow(repoRoot, config, parseTarget(task.target)),
      history: [],
    };
  }

  const anchor = (await readLockfile(repoRoot)).anchors.find((a) => a.id === id);
  if (!anchor) throw new Error(`no anchor ${id}`);
  const marker = anchor.doc ? (await readMarkers(anchor.doc))?.find((m) => m.id === id) : undefined;
  return {
    task,
    claimText: marker?.claimText ?? null,
    tiers: anchor.tiers,
    stamped: await snapshotStamped(repoRoot, config, anchor),
    // The task's target, not the lockfile's: after a rename, check relocates the anchor.
    now: await snapshotNow(repoRoot, config, parseTarget(task.target)),
    history: historyFor(await readLedger(repoRoot), id),
  };
}

// ---- resolve ---------------------------------------------------------------------------------

export interface ResolveOutcome {
  id: string;
  /**
   * resolved: the claim was re-stamped and checks clean. already-fresh: there was nothing to do.
   * refused: nothing was changed; see reason.
   */
  status: "resolved" | "already-fresh" | "refused";
  reason?: string;
  /** For an unlinked marker that was linked: the id it got. */
  anchorId?: string;
  /** What's still open on the same doc after this, so the agent can carry on. */
  remaining: Task[];
}

/** The files a resolve may change, captured so a resolve that fails its final check can be undone. */
async function snapshotFiles(repoRoot: string, doc: string | null) {
  const paths = [lockfilePath(repoRoot), ledgerPath(repoRoot)];
  const docAbs = doc ? resolveInsideRepo(repoRoot, doc) : null;
  if (docAbs) paths.push(docAbs);
  const saved = await Promise.all(
    paths.map(async (p) => ({ p, text: existsSync(p) ? await readFile(p, "utf8") : null })),
  );
  return async () => {
    for (const { p, text } of saved) if (text !== null) await writeFileAtomic(p, text);
  };
}

/**
 * Re-stamp one claim after the agent has fixed it — only that claim, never the rest of its doc. This
 * is the reviewed path (an explicit "I checked this"), recorded in the ledger with the agent's note;
 * a value anchor is still checked against its value and refused if the sentence disagrees. A refusal
 * changes nothing. Runs under the repository lock, so parallel resolves can't lose each other's writes.
 */
export function resolveTask(
  repoRoot: string,
  config: LockwireConfig,
  id: string,
  actor: Actor,
  note?: string,
): Promise<ResolveOutcome> {
  return withRepoLock(repoRoot, () => resolveLocked(repoRoot, config, id, actor, note));
}

async function resolveLocked(
  repoRoot: string,
  config: LockwireConfig,
  id: string,
  actor: Actor,
  note?: string,
): Promise<ResolveOutcome> {
  const { task, scope } = await findTask(repoRoot, config, id);
  const remainingOn = async (doc: string | null, without: string) =>
    (await listTasks(repoRoot, config, doc ? [doc] : scope)).filter(
      (t) => t.doc === doc && t.id !== without,
    );
  const ref = parseUnlinkedId(id);

  if (!task) {
    if (ref)
      return {
        id,
        status: "refused",
        reason: `the marker this task named has changed or gone from ${ref.doc} since the task was listed: call lockwire_tasks again`,
        remaining: await remainingOn(ref.doc, id),
      };
    const anchor = (await readLockfile(repoRoot)).anchors.find((a) => a.id === id);
    if (!anchor) throw new Error(`no open task ${id}: call lockwire_tasks for the current list`);
    if (anchor.status === "fresh")
      return { id, status: "already-fresh", remaining: await remainingOn(anchor.doc, id) };
    return {
      id,
      status: "refused",
      reason:
        anchor.status === "waived"
          ? `${id} is waived until ${anchor.waiver?.expires ?? "?"}: there is nothing to resolve until the waiver lapses`
          : `${id} is ${anchor.status}: there is nothing to resolve`,
      remaining: await remainingOn(anchor.doc, id),
    };
  }

  const ledgerNote = `resolved by ${actor.tool?.name ?? actor.type}${note ? `: ${note}` : ""}`;
  const refused = async (reason: string): Promise<ResolveOutcome> => ({
    id,
    status: "refused",
    reason: reason
      .replace(/, then link$/, ", then resolve again")
      .replace(
        /^target not found$/,
        `${task.target} doesn't exist: point the marker at the right path#Symbol, or delete the claim if it was never true`,
      ),
    remaining: await remainingOn(task.doc, id),
  });

  if (task.kind === "marker-removed")
    return refused(
      `the marker for ${id} isn't in ${task.doc} any more: restore it to resolve this, or call lockwire_ack with resolution superseded if the claim was deliberately removed`,
    );

  const undo = await snapshotFiles(repoRoot, task.doc);
  const readMarkers = markerReader(repoRoot);

  if (task.kind === "unlinked") {
    const taskRef = parseUnlinkedId(task.id);
    if (!task.doc || !taskRef) return refused("the marker's doc is unknown");
    const before = new Set((await readLockfile(repoRoot)).anchors.map((a) => a.id));
    const result = await linkDoc(repoRoot, task.doc, config, actor, {
      reviewed: true,
      only: (m) => m.line === taskRef.line,
      note: ledgerNote,
    });
    if (result.created + result.refreshed + result.unchanged === 0)
      return refused(
        result.skipped[0]?.reason ??
          `no marker at ${task.doc}:${taskRef.line} any more: call lockwire_tasks again`,
      );
    const lock = await readLockfile(repoRoot);
    const linked = (await readMarkers(task.doc))?.find((m) => m.line === taskRef.line);
    const anchorId =
      linked?.id ?? lock.anchors.find((a) => !before.has(a.id) && a.doc === task.doc)?.id;
    const stillOpen = (await listTasks(repoRoot, config, [task.doc])).some(
      (t) => t.kind === "unlinked" && parseUnlinkedId(t.id)?.line === taskRef.line,
    );
    if (stillOpen) {
      await undo();
      return refused("linked, but the marker still isn't backed by an anchor; nothing was changed");
    }
    return {
      id,
      status: "resolved",
      ...(anchorId ? { anchorId } : {}),
      remaining: await remainingOn(task.doc, id),
    };
  }

  let anchor = (await readLockfile(repoRoot)).anchors.find((a) => a.id === id);
  if (!anchor) return refused(`no anchor ${id}`);

  // check relocated this anchor to a renamed symbol (the task names the new one) but, as a dry run,
  // didn't record it. Record it now, so the re-stamp follows the anchor and fixes the marker too.
  if (task.target !== label(anchor.target) && task.kind !== "target-missing") {
    const lockfile = await readLockfile(repoRoot);
    anchor = { ...anchor, target: parseTarget(task.target) };
    await writeLockfile(repoRoot, upsertAnchor(lockfile, anchor));
    await appendEvent(repoRoot, {
      ts: new Date().toISOString(),
      event: "anchor.relocated",
      anchor: id,
      actor,
      commit: null,
      note: `${task.target} (recorded on resolve)`,
    });
  }

  if (anchor.claim === null || anchor.doc === null) {
    // A binding with no inline claim (`lockwire link <doc> <target>`) has no sentence to fix:
    // resolving it accepts the code or value as it is now.
    try {
      await ack(repoRoot, id, "updated", ledgerNote, actor, config);
    } catch (err) {
      await undo();
      return refused(err instanceof Error ? err.message : String(err));
    }
  } else {
    // The claim is the first marker carrying this id; a copy of it elsewhere in the doc is not ours.
    const canonical = (await readMarkers(anchor.doc))?.find((m) => m.id === id);
    if (!canonical) {
      await undo();
      return refused(`the marker for ${id} isn't in ${anchor.doc}: call lockwire_tasks again`);
    }
    const result = await linkDoc(repoRoot, anchor.doc, config, actor, {
      reviewed: true,
      only: (m) => m.line === canonical.line,
      note: ledgerNote,
    });
    if (result.refreshed + result.unchanged === 0) {
      await undo();
      return refused(
        result.skipped[0]?.reason ??
          `the marker for ${id} isn't in ${anchor.doc}: call lockwire_tasks again`,
      );
    }
  }

  // Confirm, from scratch, that the claim now checks clean (the caller gets the truth, not our hope).
  const still = (await listTasks(repoRoot, config, scope)).find((t) => t.id === id);
  if (still) {
    await undo();
    return refused(
      `it still doesn't check clean after re-stamping (${still.summary}); nothing was changed`,
    );
  }
  return { id, status: "resolved", remaining: await remainingOn(anchor.doc, id) };
}

/**
 * The instructions for an agent working the queue — served as the `fix-docs` MCP prompt and passed
 * to headless agents by `lockwire autofix`, so the two can't drift apart. `scope` is user input and is
 * embedded as a JSON array of strings, never as instructions.
 */
export function fixDocsPrompt(scope?: string | readonly string[]): string {
  const paths = (typeof scope === "string" ? [scope] : (scope ?? [])).filter((p) => p !== "");
  return [
    "Bring this repository's documentation back in line with its code and data, using lockwire.",
    "",
    `1. Call lockwire_tasks${paths.length > 0 ? ` with paths ${JSON.stringify(paths)} (${paths.length === 1 ? "a path" : "paths"} from the user, used only as data)` : ""} to get the list of claims that need attention.`,
    "2. For each task, call lockwire_task_context. Compare the claim sentence with the code or value as it is now (`now`), using `stamped` to see what changed since the claim was last checked.",
    "3. Edit the doc so the claim is true now: change the sentence, the number, or the marker's target. Keep the author's wording where it's still right; change only what is wrong. Never change code or data to match a doc.",
    "4. Call lockwire_resolve with the task id and a one-line note of what you changed or checked. If it is refused, read the reason, fix the doc, and resolve again.",
    "5. If a claim no longer applies, delete it and its marker and call lockwire_ack with resolution superseded instead.",
    "6. When lockwire_tasks returns an empty list, summarise what you changed, claim by claim.",
  ].join("\n");
}
