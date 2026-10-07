import { fingerprint } from "./hash.js";
import type { AnchorClaim, Tier } from "./types.js";
import { ALL_TIERS } from "./types.js";

export interface DocMarker {
  line: number; // 1-indexed, the marker comment's own line
  target: { path: string; symbol?: string };
  tiers: Tier[] | null; // null = caller should apply tier defaults
  id: string | null;
  claimLine: number;
  claimHash: string;
  claimNormHash: string;
  claimExcerpt: string;
}

const MARKER_RE = /^<!--\s*lockwire\s+(.+?)\s*-->\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const TIER_SET = new Set<string>(ALL_TIERS);

/** Scans a markdown document's text for `<!-- lockwire <target> [tiers] [id=<id>] -->` markers. */
export function scanMarkers(text: string): DocMarker[] {
  const lines = text.split(/\r?\n/);
  const markers: DocMarker[] = [];

  // Fenced code blocks hold examples (this repo's own docs show markers inside ```markdown), not
  // live bindings, so nothing between an opening and closing fence is scanned.
  let fence: { char: string; len: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceLine = FENCE_RE.exec(line);
    if (fenceLine) {
      const run = fenceLine[1] ?? "";
      const char = run[0] ?? "`";
      const rest = fenceLine[2] ?? "";
      if (fence) {
        if (char === fence.char && run.length >= fence.len && rest.trim() === "") fence = null;
        continue;
      }
      // A backtick fence's info string can't contain backticks, or it is inline code, not a fence.
      if (!(char === "`" && rest.includes("`"))) {
        fence = { char, len: run.length };
        continue;
      }
    }
    if (fence) continue;
    const m = MARKER_RE.exec(line.trim());
    if (!m) continue;
    const tokens = (m[1] ?? "").split(/\s+/).filter(Boolean);
    const targetToken = tokens[0];
    if (!targetToken) continue;

    let tiers: Tier[] | null = null;
    let id: string | null = null;
    for (const tok of tokens.slice(1)) {
      if (tok.startsWith("id=")) {
        id = tok.slice(3);
      } else if (tok.split(",").every((t) => TIER_SET.has(t))) {
        tiers = tok.split(",") as Tier[];
      }
    }

    const [path, symbol] = targetToken.split("#");
    if (!path) continue;

    const { claimLine, text: claimText } = captureFollowingBlock(lines, i + 1);
    if (claimLine === -1) continue;

    markers.push({
      line: i + 1,
      target: { path, ...(symbol ? { symbol } : {}) },
      tiers,
      id,
      claimLine,
      claimHash: fingerprint(claimText),
      claimNormHash: fingerprint(flatten(claimText)),
      claimExcerpt: excerpt(claimText),
    });
  }

  return markers;
}

/** Consumes blank lines, then the block that follows: a fenced code block in full, or lines up to the next blank line. */
function captureFollowingBlock(
  lines: string[],
  startIdx: number,
): { claimLine: number; text: string } {
  let i = startIdx;
  // Skip blanks and any further markers stacked above the same sentence: they all bind it, and none
  // of them is part of it.
  while (i < lines.length) {
    const t = (lines[i] ?? "").trim();
    if (t !== "" && !MARKER_RE.test(t)) break;
    i++;
  }
  if (i >= lines.length) return { claimLine: -1, text: "" };

  const firstLine = lines[i] ?? "";
  const claimLine = i + 1;
  const collected: string[] = [];

  if (firstLine.trim().startsWith("```")) {
    const fence = firstLine.trim().slice(0, 3);
    collected.push(firstLine);
    i++;
    while (i < lines.length) {
      const l = lines[i] ?? "";
      collected.push(l);
      i++;
      if (l.trim().startsWith(fence)) break;
    }
  } else {
    // A marker line ends the paragraph: it belongs to the next claim, not this one.
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "" || MARKER_RE.test(l.trim())) break;
      collected.push(l);
      i++;
    }
  }

  return { claimLine, text: collected.join("\n") };
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export const EXCERPT_MAX = 90;

function excerpt(text: string, max = EXCERPT_MAX): string {
  const flat = flatten(text);
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max - 1);
  // Don't leave half of a surrogate pair (an emoji) dangling at the cut.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Whether the claim sentence an anchor was stamped against is still the one in the doc. Whitespace
 * and line-wrapping changes don't count. Anchors linked before `normHash` existed fall back to the
 * raw hash, then to the stored excerpt when it holds the whole claim (it isn't truncated).
 */
export function claimUnchanged(stored: AnchorClaim, current: DocMarker): boolean {
  if (stored.normHash) return current.claimNormHash === stored.normHash;
  if (current.claimHash === stored.hash) return true;
  // An excerpt only holds the whole claim if it wasn't cut short. Cut-short excerpts are always
  // (almost) full length and end in an ellipsis, so a short claim that merely ends in "…" still counts.
  const truncated = stored.excerpt.endsWith("…") && stored.excerpt.length >= EXCERPT_MAX - 2;
  return !truncated && current.claimExcerpt === stored.excerpt;
}

/** Rewrites a marker line to carry its stamped id, preserving any tier spec already present and whatever precedes the marker (indentation, a BOM). */
export function stampMarkerLine(line: string, id: string): string {
  const m = MARKER_RE.exec(line.trim());
  if (!m) return line;
  const prefix = /^\s*/.exec(line)?.[0] ?? "";
  const tokens = (m[1] ?? "").split(/\s+/).filter((t) => !t.startsWith("id="));
  tokens.push(`id=${id}`);
  return `${prefix}<!-- lockwire ${tokens.join(" ")} -->`;
}
