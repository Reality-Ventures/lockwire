/**
 * Value anchors: a claim bound to a value in a data file rather than to code.
 *
 *   <!-- lockwire results/metrics.json#ci.canon.cve.lo value -->
 *   The lower bound of the canonical CVE interval is 0.18.
 *
 *   <!-- lockwire paper/numbers.tex#ciCanonCVELo value -->
 *
 * The `value` tier fingerprints the value itself (not the file, so re-serialising a JSON file with
 * its keys in a different order changes nothing). And because a number in a sentence can be checked
 * against the number it came from, a value anchor is a real truth check: the claim is compared with
 * the current value, rounded to the precision the sentence shows.
 */
import { canonicalJson } from "./hash.js";

const DATA_EXTENSIONS: Record<string, "json" | "tex"> = {
  ".json": "json",
  ".tex": "tex",
  ".sty": "tex",
  ".ltx": "tex",
};

export type DataFormat = "json" | "tex";

export function dataFormatOf(path: string): DataFormat | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : DATA_EXTENSIONS[path.slice(dot).toLowerCase()];
}

export interface ResolvedValue {
  found: boolean;
  value?: unknown;
  /** The value as a person would write it, for messages: `0.18`, `"advisory"`. */
  display?: string;
}

/** `a.b[0].c`, `a.b.0.c`, or a JSON Pointer (`/a/b/0/c`, for keys that contain dots). */
function jsonPath(key: string): string[] {
  if (key.startsWith("/"))
    return key
      .slice(1)
      .split("/")
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return key
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((s) => s !== "");
}

/** LaTeX: `\newcommand{\name}{body}`, `\renewcommand`, `\providecommand`, `\def\name{body}`. */
function texMacros(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /\\(?:(?:re)?newcommand|providecommand)\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*(?:\[\d\])?\s*\{|\\def\s*\\([A-Za-z@]+)\s*\{/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    // read the balanced-brace body that starts right after the match
    let depth = 1;
    let i = re.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (c === "\\") i++;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    out.set(name, text.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/** Strip the LaTeX that typically wraps a generated number: `\num{0.18}`, `$0.18$`, `0.18\%`, `\SI{3}{ms}`. */
function texValue(body: string): unknown {
  let s = body.trim();
  for (;;) {
    const unwrapped = s
      .replace(/^\\(?:num|ensuremath|text|mathrm|textrm)\s*\{([\s\S]*)\}$/, "$1")
      .replace(/^\\SI\s*\{([^}]*)\}\s*\{[^}]*\}$/, "$1")
      .replace(/^\$([\s\S]*)\$$/, "$1")
      .trim();
    if (unwrapped === s) break;
    s = unwrapped;
  }
  const percent = /^(.*?)\s*\\%$/.exec(s);
  const core = (percent?.[1] ?? s).replace(/\{,\}/g, "").replace(/\\,/g, "");
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(core)) return Number(core);
  return s;
}

/** Looks up `key` in the data file's text. Throws only on a file that can't be parsed at all. */
export function resolveValue(text: string, format: DataFormat, key: string): ResolvedValue {
  if (format === "tex") {
    const macros = texMacros(text);
    const name = key.replace(/^\\/, "");
    if (!macros.has(name)) return { found: false };
    const value = texValue(macros.get(name) ?? "");
    return { found: true, value, display: displayValue(value) };
  }
  let node: unknown = JSON.parse(text);
  for (const seg of jsonPath(key)) {
    if (Array.isArray(node) && /^\d+$/.test(seg)) node = node[Number(seg)];
    else if (node && typeof node === "object" && Object.hasOwn(node, seg))
      node = (node as Record<string, unknown>)[seg];
    else return { found: false };
    if (node === undefined) return { found: false };
  }
  return { found: true, value: node, display: displayValue(node) };
}

/** A stable serialisation of the value for fingerprinting: key order never matters. */
export function valueFingerprintInput(value: unknown): string {
  return canonicalJson(value ?? null);
}

/** The whole data file as content, insensitive to JSON key order and to line endings. */
export function wholeFileContent(text: string, format: DataFormat): string {
  if (format === "json") return canonicalJson(JSON.parse(text));
  return text.replace(/\r\n?/g, "\n");
}

export function displayValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  const s = JSON.stringify(value);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

// ---------------------------------------------------------------------------------------------
// Numbers in a claim

export interface ClaimNumber {
  /** As written: `0.18`, `18%`, `1,024`. */
  text: string;
  value: number;
  /** Digits after the decimal point, i.e. the precision the sentence commits to. */
  decimals: number;
  percent: boolean;
}

/** Numbers a sentence states, skipping digits that are part of a word or identifier (`v2`, `x86`, `h264`). */
export function claimNumbers(text: string): ClaimNumber[] {
  const out: ClaimNumber[] = [];
  const re =
    /(?<![\w.])([-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[-−]?\.\d+)(?:[eE]([-+]?\d+))?(?![\w])(\s*(?:%|\\%|percent\b))?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const literal = (m[1] ?? "").replace("−", "-");
    const exp = m[2];
    const n = Number(literal.replace(/,/g, "")) * (exp ? 10 ** Number(exp) : 1);
    if (!Number.isFinite(n)) continue;
    const frac = /\.(\d+)$/.exec(literal);
    const decimals = Math.max(0, (frac?.[1]?.length ?? 0) - (exp ? Number(exp) : 0));
    out.push({ text: m[0].trim(), value: n, decimals, percent: Boolean(m[3]) });
  }
  return out;
}

/** Whether `stated` is `actual` at the precision the sentence shows (0.18 matches 0.1834, not 0.19). */
function sameAtPrecision(stated: number, decimals: number, actual: number): boolean {
  const half = 0.5 * 10 ** -decimals;
  return Math.abs(actual - stated) <= half + 1e-9 * Math.max(1, Math.abs(actual));
}

export interface ClaimCheck {
  /** False when the sentence states nothing that can be compared with this value. */
  checkable: boolean;
  matches: boolean;
  /** What the sentence states, for the message. */
  claimed: string[];
}

/**
 * Does the claim state this value? A number value matches if any number in the sentence equals it at
 * the sentence's own precision (a percentage also matches the value × 100). A string value matches
 * if the sentence contains it. Other values (objects, booleans, null) aren't checked against prose.
 */
export function checkClaimAgainstValue(claimText: string, value: unknown): ClaimCheck {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/.test(value)
        ? Number(value)
        : undefined;
  if (numeric !== undefined && Number.isFinite(numeric)) {
    const nums = claimNumbers(claimText);
    if (nums.length === 0) return { checkable: false, matches: true, claimed: [] };
    const matches = nums.some(
      (n) =>
        sameAtPrecision(n.value, n.decimals, numeric) ||
        (n.percent && sameAtPrecision(n.value, n.decimals, numeric * 100)),
    );
    return { checkable: true, matches, claimed: nums.map((n) => n.text) };
  }
  if (typeof value === "string" && value.trim() !== "") {
    return { checkable: true, matches: claimText.includes(value), claimed: [] };
  }
  return { checkable: false, matches: true, claimed: [] };
}
