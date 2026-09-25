import { appendFile, mkdir } from "node:fs/promises";
import { check, refs } from "./actions.js";
import { readConfig } from "./config.js";
import { toPosix, toRepoRelative } from "./repo.js";
import type { Anchor, LockwireConfig } from "./types.js";

export interface HookInput {
  tool_name?: string;
  tool_input?: { file_path?: string; old_string?: string; content?: string; command?: string };
  session_id?: string;
  cwd?: string;
}

export async function readStdinJson(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as HookInput;
}

/** Windows delivers `C:\project\src\index.ts`; hooks compare against posix, repo-relative anchor targets. */
export function normalizeTouchedPath(repoRoot: string, filePath: string): string {
  const posixAbs = toPosix(filePath);
  const posixRoot = toPosix(repoRoot);
  if (posixAbs.toLowerCase().startsWith(posixRoot.toLowerCase())) {
    return toRepoRelative(repoRoot, posixAbs);
  }
  return posixAbs.replace(/^[A-Za-z]:/, "").replace(/^\//, "");
}

export function buildAdvisoryText(anchors: Anchor[], config: LockwireConfig): string {
  const shown = anchors.slice(0, config.hook.maxClaimsInContext);
  const lines = shown.map((a) => {
    const target = `${a.target.path}${a.target.symbol ? `#${a.target.symbol}` : ""}`;
    const claimText = a.claim ? `"${a.claim.excerpt}"` : "(whole-file binding, no inline claim)";
    return `- ${a.doc ?? "(lockfile-only)"} asserts ${claimText} about ${target} [tiers: ${a.tiers.join(",")}]`;
  });
  const more = anchors.length > shown.length ? `\n…and ${anchors.length - shown.length} more.` : "";
  return [
    `lockwire: documentation makes claims about this code:`,
    ...lines,
    more,
    `If this edit changes what any of these claims assert, update the doc and run \`lockwire link <doc>\`.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function claimsForPath(repoRoot: string, touchedPath: string): Promise<Anchor[]> {
  return refs(repoRoot, touchedPath);
}

export async function reportDriftFor(
  repoRoot: string,
  touchedPath: string,
): Promise<{ text: string; anyDrift: boolean }> {
  const config = await readConfig(repoRoot);
  const result = await check(repoRoot, config, [touchedPath]);
  const relevant = result.results.filter(
    (r) =>
      r.anchor.target.path === touchedPath && (r.status === "drifted" || r.status === "orphaned"),
  );
  if (relevant.length === 0) return { text: "", anyDrift: false };
  const lines = relevant.map((r) => {
    const target = `${r.anchor.target.path}${r.anchor.target.symbol ? `#${r.anchor.target.symbol}` : ""}`;
    return `- ${r.anchor.doc ?? "(lockfile-only)"} on ${target} is now ${r.status}${r.driftedTiers.length ? ` (${r.driftedTiers.join(",")})` : ""}`;
  });
  return {
    text: [
      `lockwire: this edit drifted documentation claims:`,
      ...lines,
      `Update the doc and run \`lockwire link <doc>\`, or \`lockwire ack\`/\`lockwire waive\` if this is expected.`,
    ].join("\n"),
    anyDrift: true,
  };
}

export async function logHookError(repoRoot: string, adapter: string, err: unknown): Promise<void> {
  try {
    await mkdir(`${repoRoot}/.lockwire`, { recursive: true });
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    await appendFile(
      `${repoRoot}/.lockwire/hook.log`,
      `[${new Date().toISOString()}] ${adapter}: ${msg}\n`,
      "utf8",
    );
  } catch {
    // fail-open invariant: a broken hook must never break the session, not even to log
  }
}
