import type { AnchorCheckResult, CheckResult } from "./actions.js";

/**
 * What moved, for a one-line report: `sig`, `claim`, and for a value anchor the value itself —
 * `value: 0.18 -> 0.19`, or `claim says 0.18, value is 0.19` when the sentence no longer holds.
 */
export function describeDrift(
  r: Pick<AnchorCheckResult, "driftedTiers" | "claimChanged" | "value" | "moved">,
): string {
  const parts: string[] = r.driftedTiers.filter((t) => t !== "value");
  if (r.claimChanged) parts.push("claim");
  const v = r.value;
  if (v && !v.matches)
    parts.push(
      `claim says ${v.claimed.length ? v.claimed.join(", ") : "otherwise"}, value is ${v.now}${v.was && v.was !== v.now ? ` (was ${v.was})` : ""}`,
    );
  else if (v || r.driftedTiers.includes("value"))
    parts.push(
      v?.was !== undefined ? `value: ${v.was} -> ${v?.now}` : `value${v ? `: now ${v.now}` : ""}`,
    );
  const moved = describeMove(r.moved);
  if (moved) parts.push(moved);
  return parts.join(", ");
}

const label = (t: { path: string; symbol?: string }) =>
  `${t.path}${t.symbol ? `#${t.symbol}` : ""}`;

/** `moved to src/new.ts#foo`, or where its code was found when lockwire can't tell which place is the claim's. */
export function describeMove(moved: AnchorCheckResult["moved"]): string {
  if (!moved) return "";
  if (moved.to) return `moved to ${label(moved.to)}`;
  const shown = moved.candidates.slice(0, 3).map(label).join(", ");
  const more = moved.candidates.length > 3 ? `, +${moved.candidates.length - 3} more` : "";
  return `its code is in ${moved.candidates.length} places: ${shown}${more}`;
}

const VERSION = "0.1.0";

export function formatText(result: CheckResult): string {
  const lines: string[] = [];
  const byDoc = new Map<string, typeof result.results>();
  for (const r of result.results.filter((x) => !x.skipped)) {
    const key = r.anchor.doc ?? "(lockfile-only)";
    const list = byDoc.get(key) ?? [];
    list.push(r);
    byDoc.set(key, list);
  }

  for (const [doc, anchors] of byDoc) {
    const noteworthy = anchors.filter(
      (a) => a.status !== "fresh" && a.status !== "waived" && a.status !== "superseded",
    );
    if (noteworthy.length === 0) {
      lines.push(`${doc}`, "  ok", "");
      continue;
    }
    lines.push(doc);
    for (const a of noteworthy) {
      const t = `${a.anchor.target.path}${a.anchor.target.symbol ? `#${a.anchor.target.symbol}` : ""}`;
      const label = a.status.toUpperCase().padEnd(9);
      const what = describeDrift(a);
      const tierNote = what ? ` (${what})` : "";
      lines.push(`  ${label} ${t}${tierNote}`);
    }
    lines.push("");
  }

  if (result.unlinked.length > 0) {
    lines.push("Unlinked markers (no anchor backs them, so these claims are not being checked):");
    for (const u of result.unlinked) lines.push(`  ${u.doc}:${u.line}  ${u.target}  ${u.reason}`);
    // `link` can fix a marker that just hasn't been linked; one whose target is missing needs editing.
    const linkable = result.unlinked.filter((u) => !u.reason.startsWith("not linked:"));
    const docs = [...new Set(linkable.map((u) => u.doc))];
    if (docs.length > 0)
      lines.push(`Run \`lockwire link ${docs.length === 1 ? docs[0] : "<doc>"}\` to link them.`);
    if (linkable.length < result.unlinked.length)
      lines.push("Fix the target of each marker whose file doesn't exist, then link.");
    lines.push("");
  }

  const moved = result.results.filter((r) => !r.skipped && r.moved);
  if (moved.length > 0) {
    const placed = moved.filter((r) => r.moved?.to).length;
    if (placed > 0)
      lines.push(
        `${placed} claim${placed === 1 ? "'s" : "s'"} code moved to another file unchanged: run \`lockwire repoint\` to re-point ${placed === 1 ? "it" : "them"} and update the markers.`,
      );
    if (placed < moved.length)
      lines.push(
        "Where the code is in several places, choose one: `lockwire repoint <id> --to <path#symbol>`.",
      );
    lines.push("");
  }

  const { summary } = result;
  lines.push(
    `${summary.anchors} anchor${summary.anchors === 1 ? "" : "s"} · ${summary.fresh} ok · ${summary.drifted} drifted · ${summary.orphaned} orphaned${summary.relocated > 0 ? ` · ${summary.relocated} relocated` : ""}${summary.unlinked > 0 ? ` · ${summary.unlinked} unlinked` : ""}`,
  );
  lines.push(
    `single-hash would flag ${summary.noise.singleHashWouldFlag} · lockwire flagged ${summary.noise.tieredFlagged} · noise −${summary.noise.reductionPercent}%`,
  );
  return lines.join("\n");
}

export function formatJson(result: CheckResult, repo: string | null): string {
  const payload = {
    schema: "lockwire.check.v1",
    tool: { name: "lockwire", version: VERSION },
    repo,
    checkedAt: new Date().toISOString(),
    summary: result.summary,
    anchors: result.results
      .filter((r) => !r.skipped)
      .map((r) => ({
        id: r.anchor.id,
        doc: r.anchor.doc,
        line: r.anchor.claim?.line ?? null,
        target: `${r.anchor.target.path}${r.anchor.target.symbol ? `#${r.anchor.target.symbol}` : ""}`,
        status: r.status,
        driftedTiers: r.driftedTiers,
        claimChanged: r.claimChanged ?? false,
        value: r.value ?? null,
        moved: r.moved ?? null,
        definedAt: r.definedAt ?? null,
        excerpt: r.anchor.claim?.excerpt ?? null,
      })),
    unlinked: result.unlinked,
  };
  return JSON.stringify(payload, null, 2);
}

export function formatGithub(result: CheckResult, opts: { failOnUnlinked?: boolean } = {}): string {
  const lines: string[] = [];
  for (const r of result.results.filter((x) => !x.skipped)) {
    if (r.status !== "drifted" && r.status !== "orphaned") continue;
    const target = `${r.anchor.target.path}${r.anchor.target.symbol ? `#${r.anchor.target.symbol}` : ""}`;
    const file = r.anchor.doc ?? r.anchor.target.path;
    const line = r.anchor.claim?.line ?? 1;
    const what = describeDrift(r);
    const message = r.moved?.to
      ? `lockwire: the code "${target}" names moved to "${label(r.moved.to)}" — run lockwire repoint ${r.anchor.id}`
      : r.status === "orphaned"
        ? r.claimChanged
          ? `lockwire: the claim bound to "${target}" was removed from the doc — unlink it or restore the marker`
          : `lockwire: "${target}" no longer exists — this claim is orphaned${r.moved ? ` (${describeMove(r.moved)})` : ""}`
        : r.value && !r.value.matches
          ? `lockwire: this claim is wrong now — it states ${r.value.claimed.join(", ") || "a different value"}, but "${target}" is ${r.value.now}`
          : r.claimChanged && r.driftedTiers.length === 0
            ? `lockwire: the claim text bound to "${target}" was edited — re-verify it against the code, then run lockwire link`
            : `lockwire: "${target}" drifted on ${what} — this claim may be stale`;
    lines.push(`::error file=${file},line=${line}::${message}`);
  }
  for (const u of result.unlinked) {
    const level = opts.failOnUnlinked ? "error" : "warning";
    lines.push(
      `::${level} file=${u.doc},line=${u.line}::lockwire: the claim bound to "${u.target}" isn't linked (${u.reason}), so nothing checks it — run lockwire link ${u.doc}`,
    );
  }
  return lines.join("\n");
}
