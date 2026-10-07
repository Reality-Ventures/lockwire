const VERSION = "0.1.0";
export function formatText(result) {
    const lines = [];
    const byDoc = new Map();
    for (const r of result.results) {
        const key = r.anchor.doc ?? "(lockfile-only)";
        const list = byDoc.get(key) ?? [];
        list.push(r);
        byDoc.set(key, list);
    }
    for (const [doc, anchors] of byDoc) {
        const noteworthy = anchors.filter((a) => a.status !== "fresh" && a.status !== "waived" && a.status !== "superseded");
        if (noteworthy.length === 0) {
            lines.push(`${doc}`, "  ok", "");
            continue;
        }
        lines.push(doc);
        for (const a of noteworthy) {
            const t = `${a.anchor.target.path}${a.anchor.target.symbol ? `#${a.anchor.target.symbol}` : ""}`;
            const label = a.status.toUpperCase().padEnd(9);
            const what = [...a.driftedTiers, ...(a.claimChanged ? ["claim"] : [])];
            const tierNote = what.length ? ` (${what.join(",")})` : "";
            lines.push(`  ${label} ${t}${tierNote}`);
        }
        lines.push("");
    }
    const { summary } = result;
    lines.push(`${summary.anchors} anchor${summary.anchors === 1 ? "" : "s"} · ${summary.fresh} ok · ${summary.drifted} drifted · ${summary.orphaned} orphaned${summary.relocated > 0 ? ` · ${summary.relocated} relocated` : ""}`);
    lines.push(`single-hash would flag ${summary.noise.singleHashWouldFlag} · lockwire flagged ${summary.noise.tieredFlagged} · noise −${summary.noise.reductionPercent}%`);
    return lines.join("\n");
}
export function formatJson(result, repo) {
    const payload = {
        schema: "lockwire.check.v1",
        tool: { name: "lockwire", version: VERSION },
        repo,
        checkedAt: new Date().toISOString(),
        summary: result.summary,
        anchors: result.results.map((r) => ({
            id: r.anchor.id,
            doc: r.anchor.doc,
            line: r.anchor.claim?.line ?? null,
            target: `${r.anchor.target.path}${r.anchor.target.symbol ? `#${r.anchor.target.symbol}` : ""}`,
            status: r.status,
            driftedTiers: r.driftedTiers,
            claimChanged: r.claimChanged ?? false,
            excerpt: r.anchor.claim?.excerpt ?? null,
        })),
    };
    return JSON.stringify(payload, null, 2);
}
export function formatGithub(result) {
    const lines = [];
    for (const r of result.results) {
        if (r.status !== "drifted" && r.status !== "orphaned")
            continue;
        const target = `${r.anchor.target.path}${r.anchor.target.symbol ? `#${r.anchor.target.symbol}` : ""}`;
        const file = r.anchor.doc ?? r.anchor.target.path;
        const line = r.anchor.claim?.line ?? 1;
        const what = [...r.driftedTiers, ...(r.claimChanged ? ["claim"] : [])].join(",");
        const message = r.status === "orphaned"
            ? r.claimChanged
                ? `lockwire: the claim bound to "${target}" was removed from the doc — unlink it or restore the marker`
                : `lockwire: "${target}" no longer exists — this claim is orphaned`
            : r.claimChanged && r.driftedTiers.length === 0
                ? `lockwire: the claim text bound to "${target}" was edited — re-verify it against the code, then run lockwire link`
                : `lockwire: "${target}" drifted on ${what} — this claim may be stale`;
        lines.push(`::error file=${file},line=${line}::${message}`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=format.js.map