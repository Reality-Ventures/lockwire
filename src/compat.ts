/**
 * Two lockwires on one repository: the Claude Code plugin and a CLI from npm are separate installs that
 * update separately, so one can be older than the other. An older one misreads what a newer one wrote
 * (a claim it can't parse reads as broken or unlinked, and re-stamping it would downgrade it). Release
 * versions are set when publishing, so a build doesn't know its own; what matters anyway is whether it
 * can read an anchor. Each anchor says what reading it takes, and a build that can't steps aside and
 * says to update — locally, without asking any server what the latest version is.
 */
import { FINGERPRINT_VERSION } from "./extract.js";
import type { Anchor, Lockfile } from "./types.js";
import { ALL_TIERS } from "./types.js";

/**
 * What this build can read. Bump it when lockwire starts writing anchors an older build would misread
 * (a new tier, target kind or data format), and make {@link requiredLevel} return the new level for
 * the anchors that use it. A new fingerprint version needs no bump: anchors already record theirs.
 */
export const READER_LEVEL = 1;

/** The reader level an anchor needs. Every anchor this build writes needs level 1. */
export function requiredLevel(_anchor: Anchor): number {
  return 1;
}

/** An anchor as it should be written: `level` recorded only when it is above 1, and never lowered. */
export function withLevel(anchor: Anchor): Anchor {
  const level = Math.max(anchor.level ?? 1, requiredLevel(anchor));
  if (level > 1) return { ...anchor, level };
  const { level: _, ...rest } = anchor;
  return rest;
}

/** Why this build can't read `anchor`, or null when it can. */
export function unreadableReason(anchor: Anchor): string | null {
  if ((anchor.level ?? 1) > READER_LEVEL)
    return `needs reader level ${anchor.level}; this lockwire reads up to ${READER_LEVEL}`;
  if ((anchor.fingerprintVersion ?? 1) > FINGERPRINT_VERSION)
    return `stamped with fingerprint version ${anchor.fingerprintVersion}; this lockwire knows up to ${FINGERPRINT_VERSION}`;
  const unknown = anchor.tiers.filter((t) => !ALL_TIERS.includes(t));
  if (unknown.length > 0)
    return `binds tier ${unknown.join(", ")}, which this lockwire doesn't know`;
  return null;
}

/** How to update the lockwire that is running: the plugin when Claude Code started it, npm otherwise. */
export function updateCommand(): string {
  return process.env.CLAUDE_PLUGIN_ROOT
    ? "`claude plugin update lockwire@lockwire`, then `/reload-plugins`"
    : "`npm install -g lockwire@latest` (or run `npx lockwire@latest`)";
}

/**
 * What to tell the person (or the agent working for them) when `lockwire.lock` holds anchors a newer
 * lockwire wrote, or null when this build reads them all.
 */
export function newerWriterNotice(lockfile: Lockfile, audience: "agent" | "cli"): string | null {
  const count = lockfile.anchors.filter((a) => unreadableReason(a) !== null).length;
  if (count === 0) return null;
  const what = `lockwire.lock has ${count} claim${count === 1 ? "" : "s"} stamped by a newer lockwire than this one, so ${count === 1 ? "it isn't" : "they aren't"} being checked here.`;
  return audience === "agent"
    ? `lockwire: ${what} Tell the user, and suggest they update lockwire: ${updateCommand()}.`
    : `warning: ${what} Update this lockwire: ${updateCommand()}.`;
}
