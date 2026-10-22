import { posix } from "node:path";
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
  /** The whole claim, whitespace-collapsed: what a value anchor's number is checked against. */
  claimText: string;
  /** Why this marker can't be linked as written (an unknown tier, no claim after it), if it can't. */
  problem?: string;
}

/**
 * A marker line: `<!-- lockwire … -->`, or MDX's `{/* lockwire … *\/}` (an HTML comment isn't valid MDX).
 * It may sit after a list bullet or blockquote `>`s (`- <!-- lockwire … -->`): group 1 is that prefix.
 */
const MARKER_RE =
  /^(\s*(?:>\s*)*(?:(?:[-*+]|\d{1,9}[.)])\s+)?)(?:<!--\s*lockwire\s+(.+?)\s*-->|\{\/\*\s*lockwire\s+(.+?)\s*\*\/\})\s*$/;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const TIER_SET = new Set<string>(ALL_TIERS);

interface MarkerLine {
  prefix: string;
  body: string;
  mdx: boolean;
}

function parseMarkerLine(line: string): MarkerLine | null {
  const m = MARKER_RE.exec(line.replace(/^\uFEFF/, ""));
  if (!m) return null;
  return { prefix: m[1] ?? "", body: m[2] ?? m[3] ?? "", mdx: m[3] !== undefined };
}

const isMarkerLine = (line: string) => parseMarkerLine(line) !== null;

/** Leading spaces, a tab counting as four. */
const indentOf = (line: string) => {
  let n = 0;
  for (const c of line) {
    if (c === " ") n++;
    else if (c === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
};
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s/;

/** Scans a markdown document's text for `<!-- lockwire <target> [tiers] [id=<id>] -->` markers. */
export function scanMarkers(text: string): DocMarker[] {
  const lines = text.split(/\r?\n/);
  const markers: DocMarker[] = [];

  // Fenced code blocks hold examples (this repo's own docs show markers inside ```markdown), not
  // live bindings, so nothing between an opening and closing fence is scanned. Nor is an indented
  // code block: four spaces in after a blank line, outside a list.
  let fence: { char: string; len: number } | null = null;
  let indentedCode = false;
  let inList = false;
  let prevBlank = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const blank = line.trim() === "";
    if (!fence) {
      if (indentedCode && !blank && indentOf(line) < 4) indentedCode = false;
      if (!indentedCode && prevBlank && !blank && indentOf(line) >= 4 && !inList)
        indentedCode = true;
      if (!blank && indentOf(line) < 4 && !indentedCode)
        inList = LIST_ITEM.test(line) || (inList && !prevBlank) || (inList && indentOf(line) >= 2);
      prevBlank = blank;
      if (indentedCode) continue;
    }
    // Inside a list a fence may be indented to the item's content; elsewhere it's at most 3 spaces in.
    const fenceLine = FENCE_RE.exec(inList ? line.trimStart() : line);
    if (fenceLine) {
      const run = fenceLine[2] ?? "";
      const char = run[0] ?? "`";
      const rest = fenceLine[3] ?? "";
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
    const m = parseMarkerLine(line);
    if (!m) continue;
    const tokens = markerTokens(m.body).map((t) => t.value);
    const targetToken = tokens[0];
    if (!targetToken) continue;

    // Tiers may be written `sig,body`, `sig, body` or `sig body`; a word that isn't a tier is a typo
    // to report, never something to drop silently (which would bind the default tiers instead).
    let id: string | null = null;
    const tierWords: string[] = [];
    for (const tok of tokens.slice(1)) {
      if (tok.startsWith("id=")) id = tok.slice(3);
      else tierWords.push(...tok.split(",").filter(Boolean));
    }
    const unknown = tierWords.filter((t) => !TIER_SET.has(t));
    const tiers: Tier[] | null =
      tierWords.length > 0 && unknown.length === 0 ? ([...new Set(tierWords)] as Tier[]) : null;
    let problem =
      unknown.length > 0
        ? `unknown tier${unknown.length === 1 ? "" : "s"} ${unknown.map((t) => `"${t}"`).join(", ")} (the tiers are ${ALL_TIERS.join(", ")})`
        : undefined;

    const hash = targetToken.indexOf("#");
    const rawPath = hash < 0 ? targetToken : targetToken.slice(0, hash);
    const symbol = hash < 0 ? undefined : targetToken.slice(hash + 1);
    if (!rawPath) continue;
    // `./src/a.ts` and `src/./a.ts` are claims about src/a.ts: normalise the way the hooks compare.
    const path = posix.normalize(rawPath.replace(/\\/g, "/")).replace(/^(?:\.\/)+/, "");

    let { claimLine, text: claimText } = captureFollowingBlock(lines, i + 1);
    if (claimLine === -1) {
      // Nothing after it to bind: still a marker, so it's reported rather than silently ignored.
      problem ??= "no claim follows the marker";
      claimLine = i + 1;
      claimText = "";
    }

    markers.push({
      line: i + 1,
      target: { path, ...(symbol ? { symbol } : {}) },
      tiers,
      id,
      claimLine,
      claimHash: fingerprint(claimText),
      claimNormHash: fingerprint(flatten(claimText)),
      claimExcerpt: excerpt(claimText),
      claimText: flatten(claimText),
      ...(problem ? { problem } : {}),
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
    const l = lines[i] ?? "";
    if (l.trim() !== "" && !isMarkerLine(l)) break;
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
      if (l.trim() === "" || isMarkerLine(l)) break;
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
  const m = parseMarkerLine(line);
  if (!m) return line;
  const tokens = markerTokens(m.body)
    .filter((t, i) => i === 0 || !t.value.startsWith("id="))
    .map((t) => t.raw);
  tokens.push(`id=${id}`);
  return writeMarkerLine(line, m, tokens);
}

/** The marker line with new words, in the syntax it was written in, after what preceded it. */
function writeMarkerLine(line: string, m: MarkerLine, tokens: string[]): string {
  const bom = line.startsWith("\uFEFF") ? "\uFEFF" : "";
  return m.mdx
    ? `${bom}${m.prefix}{/* lockwire ${tokens.join(" ")} */}`
    : `${bom}${m.prefix}<!-- lockwire ${tokens.join(" ")} -->`;
}

/** Rewrites a marker line's target (`path#Symbol`), keeping its tiers, id and whatever precedes it. */
export function retargetMarkerLine(
  line: string,
  target: { path: string; symbol?: string },
): string {
  const m = parseMarkerLine(line);
  if (!m) return line;
  const tokens = markerTokens(m.body).map((t) => t.raw);
  tokens[0] = quoteTarget(`${target.path}${target.symbol ? `#${target.symbol}` : ""}`);
  return writeMarkerLine(line, m, tokens);
}

/**
 * A marker's words: split on whitespace, except that a double-quoted word keeps its spaces — a target
 * like `"results/main.csv#E1 collection S/est"`, whose CSV row key has spaces. `\"` is a literal quote.
 */
export function markerTokens(body: string): { value: string; raw: string }[] {
  const out: { value: string; raw: string }[] = [];
  const re = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[1] !== undefined) out.push({ value: m[1].replace(/\\(.)/g, "$1"), raw: m[0] });
    else out.push({ value: m[2] ?? "", raw: m[0] });
  }
  return out;
}

/** A target as a marker word: quoted when it has whitespace or quotes in it. */
export function quoteTarget(target: string): string {
  return /[\s"]/.test(target) ? `"${target.replace(/(["\\])/g, "\\$1")}"` : target;
}
