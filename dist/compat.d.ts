import type { Anchor, Lockfile } from "./types.js";
/**
 * What this build can read. Bump it when lockwire starts writing anchors an older build would misread
 * (a new tier, target kind or data format), and make {@link requiredLevel} return the new level for
 * the anchors that use it. A new fingerprint version needs no bump: anchors already record theirs.
 */
export declare const READER_LEVEL = 1;
/** The reader level an anchor needs. Every anchor this build writes needs level 1. */
export declare function requiredLevel(_anchor: Anchor): number;
/** An anchor as it should be written: `level` recorded only when it is above 1, and never lowered. */
export declare function withLevel(anchor: Anchor): Anchor;
/** Why this build can't read `anchor`, or null when it can. */
export declare function unreadableReason(anchor: Anchor): string | null;
/** How to update the lockwire that is running: the plugin when Claude Code started it, npm otherwise. */
export declare function updateCommand(): string;
/**
 * What to tell the person (or the agent working for them) when `lockwire.lock` holds anchors a newer
 * lockwire wrote, or null when this build reads them all.
 */
export declare function newerWriterNotice(lockfile: Lockfile, audience: "agent" | "cli"): string | null;
//# sourceMappingURL=compat.d.ts.map