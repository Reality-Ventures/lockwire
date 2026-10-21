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
const DATA_EXTENSIONS = {
    ".json": "json",
    ".tex": "tex",
    ".sty": "tex",
    ".ltx": "tex",
};
export function dataFormatOf(path) {
    const dot = path.lastIndexOf(".");
    return dot < 0 ? undefined : DATA_EXTENSIONS[path.slice(dot).toLowerCase()];
}
/** `a.b[0].c`, `a.b.0.c`, or a JSON Pointer (`/a/b/0/c`, for keys that contain dots). */
function jsonPath(key) {
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
/** Drops `%` comments: a `%` ends the line's content unless it is escaped (`\%`, but not `\\%`). */
function stripTexComments(text) {
    return text
        .split(/\r?\n/)
        .map((line) => {
        for (let i = 0; i < line.length; i++) {
            if (line[i] !== "%")
                continue;
            let slashes = 0;
            for (let j = i - 1; j >= 0 && line[j] === "\\"; j--)
                slashes++;
            if (slashes % 2 === 0)
                return line.slice(0, i);
        }
        return line;
    })
        .join("\n");
}
/**
 * LaTeX: `\newcommand{\name}{body}`, `\renewcommand`, `\providecommand`, `\def\name{body}`. Commented-out
 * lines don't count; a later definition replaces an earlier one, except `\providecommand`, which (as in
 * LaTeX) never replaces one; a body left unterminated at the end of the file defines nothing.
 */
function texMacros(source) {
    const text = stripTexComments(source);
    const out = new Map();
    const re = /\\(newcommand|renewcommand|providecommand)\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*(?:\[\d\])?\s*\{|\\def\s*\\([A-Za-z@]+)\s*\{/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const name = m[2] ?? m[3];
        if (!name)
            continue;
        // read the balanced-brace body that starts right after the match
        let depth = 1;
        let i = re.lastIndex;
        for (; i < text.length && depth > 0; i++) {
            const c = text[i];
            if (c === "\\")
                i++;
            else if (c === "{")
                depth++;
            else if (c === "}")
                depth--;
        }
        if (depth > 0)
            break; // unterminated: never a truncated value
        if (!(m[1] === "providecommand" && out.has(name)))
            out.set(name, text.slice(re.lastIndex, i - 1));
        re.lastIndex = i;
    }
    return out;
}
/** Strip the LaTeX that typically wraps a generated number: `\num{0.18}`, `$0.18$`, `0.18\%`, `\SI{3}{ms}`, in any combination. */
function texValue(body) {
    let s = body.trim();
    for (;;) {
        const unwrapped = s
            .replace(/^\\(?:num|ensuremath|text|mathrm|textrm)\s*\{([\s\S]*)\}$/, "$1")
            .replace(/^\\SI\s*\{([^}]*)\}\s*\{[^}]*\}$/, "$1")
            .replace(/^\$([\s\S]*)\$$/, "$1")
            .replace(/^([\s\S]*?)\s*\\%$/, "$1")
            .trim();
        if (unwrapped === s)
            break;
        s = unwrapped;
    }
    const core = s.replace(/\{,\}/g, "").replace(/\\,/g, "");
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(core))
        return Number(core);
    return body.trim();
}
/** LaTeX markup in a string value, rendered as the plain text a sentence would contain. */
function texToPlain(s) {
    return s
        .replace(/\\(?:num|ensuremath|text|mathrm|textrm|textbf|emph)\s*\{([^{}]*)\}/g, "$1")
        .replace(/\\SI\s*\{([^}]*)\}\s*\{([^}]*)\}/g, "$1 $2")
        .replace(/\\%/g, "%")
        .replace(/\{,\}/g, ",")
        .replace(/\\[,;: ]/g, "")
        .replace(/---?/g, "–")
        .replace(/~/g, " ")
        .replace(/\$/g, "");
}
/** Looks up `key` in the data file's text. Throws only on a file that can't be parsed at all. */
export function resolveValue(text, format, key) {
    if (format === "tex") {
        const macros = texMacros(text);
        const name = key.replace(/^\\/, "");
        if (!macros.has(name))
            return { found: false };
        const value = texValue(macros.get(name) ?? "");
        return { found: true, value, display: displayValue(value) };
    }
    let node = JSON.parse(text);
    for (const seg of jsonPath(key)) {
        if (Array.isArray(node) && /^\d+$/.test(seg))
            node = node[Number(seg)];
        else if (node && typeof node === "object" && Object.hasOwn(node, seg))
            node = node[seg];
        else
            return { found: false };
        if (node === undefined)
            return { found: false };
    }
    return { found: true, value: node, display: displayValue(node) };
}
/** A stable serialisation of the value for fingerprinting: key order never matters. */
export function valueFingerprintInput(value) {
    return canonicalJson(value ?? null);
}
/** The whole data file as content, insensitive to JSON key order and to line endings. */
export function wholeFileContent(text, format) {
    if (format === "json")
        return canonicalJson(JSON.parse(text));
    return text.replace(/\r\n?/g, "\n");
}
export function displayValue(value) {
    if (typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null)
        return String(value);
    const s = JSON.stringify(value);
    return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}
const MAGNITUDES = {
    k: 1e3,
    K: 1e3,
    M: 1e6,
    B: 1e9,
    bn: 1e9,
    T: 1e12,
    thousand: 1e3,
    million: 1e6,
    billion: 1e9,
    trillion: 1e12,
};
const ORDINAL = /^(?:st|nd|rd|th)$/i;
const MINUS = new Set(["-", "−"]);
/** What may come right before a minus sign that makes it a sign rather than a dash or a range. */
const BEFORE_SIGN = /[\s([{=:~≈]/;
/**
 * Numbers a sentence states. Skips digits that are part of a word or identifier (`v2`, `x86`, `h264`,
 * `0.18_lo`, `0x1F`), version strings (`1.2.3`) and ordinals (`2nd`). A unit glued to a number doesn't
 * hide it (`12.5ms` states 12.5), and a magnitude suffix scales it (`1.2B`, `3.5k`, `2 million`). A
 * hyphen between two numbers is a range, not a minus (`0.18-0.24`, LaTeX's `15--29`).
 */
export function claimNumbers(text) {
    const out = [];
    // The whole token at once (digits, commas between digits, any dotted parts), so a regex can never
    // backtrack into the integer part of `12.5ms`.
    const re = /(?<![\w.])(\d(?:\d|,(?=\d))*(?:\.\d+)*|\.\d+)(?:[eE]([-+]?\d+)(?![\w]))?/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const token = m[1] ?? "";
        const exp = m[2] === undefined ? 0 : Number(m[2]);
        const start = m.index;
        let end = re.lastIndex;
        // What follows: an identifier, an ordinal, a unit, a magnitude, a percent.
        const rest = text.slice(end);
        if (/^_/.test(rest))
            continue;
        let scale = 1;
        let suffix = /^[A-Za-zµμ]+/.exec(rest)?.[0] ?? "";
        if (suffix) {
            if (/^\d/.test(rest.slice(suffix.length)))
                continue; // 0x1F, 3d4: an identifier
            if (ORDINAL.test(suffix) && !token.includes("."))
                continue;
            scale = MAGNITUDES[suffix] ?? 1;
            end += suffix.length;
        }
        else {
            const word = /^\s+(thousand|million|billion|trillion)\b/i.exec(rest);
            if (word?.[1]) {
                scale = MAGNITUDES[word[1].toLowerCase()] ?? 1;
                end += word[0].length;
                suffix = word[0];
            }
        }
        const pct = suffix ? null : /^\s*(?:%|\\%|percent\b)/.exec(text.slice(end));
        if (pct)
            end += pct[0].length;
        const signed = MINUS.has(text[start - 1] ?? "") && (start === 1 || BEFORE_SIGN.test(text[start - 2] ?? ""));
        // A comma run that isn't a thousands pattern is a list (1,2,3): each item is its own number.
        const literals = /,/.test(token) && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token) ? token.split(",") : [token];
        for (const literal of literals) {
            const base = Number(literal.replace(/,/g, ""));
            if (!Number.isFinite(base))
                continue; // NaN for a version string like 1.2.3
            const frac = /\.(\d+)$/.exec(literal)?.[1]?.length ?? 0;
            const one = literals.length === 1;
            out.push({
                text: one ? text.slice(signed ? start - 1 : start, end).trim() : literal,
                value: (signed && one ? -1 : 1) * base * 10 ** exp * scale,
                decimals: frac - exp,
                scale,
                percent: Boolean(pct) && one,
            });
        }
    }
    return out;
}
/** Floating-point slack only: a few ulps, never enough to let an exact count be off by one. */
const slack = (...xs) => 8 * Number.EPSILON * Math.max(1, ...xs.map(Math.abs));
/** Whether `n` states `actual` at the precision it shows (0.18 matches 0.1834, not 0.19; 1.2B matches 1.24e9). */
function statesValue(n, actual) {
    const half = 0.5 * 10 ** -n.decimals * n.scale;
    return Math.abs(actual - n.value) <= half + slack(actual, n.value);
}
/** Two stated numbers agree at the coarser of their two precisions. */
function agree(claim, stated) {
    const step = Math.max(10 ** -claim.decimals * claim.scale, 10 ** -stated.decimals * stated.scale);
    const value = claim.percent && !stated.percent ? stated.value * 100 : stated.value;
    return Math.abs(claim.value - value) <= step / 2 + slack(claim.value, value);
}
/**
 * Does the claim state this value? A number value matches if any number in the sentence equals it at
 * the sentence's own precision (a percentage also matches the value × 100). A string value that
 * contains numbers (`21\%; 95\% CI 15--29\%`) matches if every one of them is stated in the sentence;
 * one with no numbers matches if the sentence contains it. Other values (objects, booleans, null)
 * aren't checked against prose.
 */
export function checkClaimAgainstValue(claimText, value) {
    const numeric = typeof value === "number"
        ? value
        : typeof value === "string" && /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/.test(value)
            ? Number(value)
            : undefined;
    if (numeric !== undefined && Number.isFinite(numeric)) {
        const nums = claimNumbers(claimText);
        if (nums.length === 0)
            return { checkable: false, matches: true, claimed: [] };
        const matches = nums.some((n) => statesValue(n, numeric) || (n.percent && statesValue(n, numeric * 100)));
        return { checkable: true, matches, claimed: nums.map((n) => n.text) };
    }
    if (typeof value === "string" && value.trim() !== "") {
        const inValue = claimNumbers(texToPlain(value));
        if (inValue.length > 0) {
            const nums = claimNumbers(claimText);
            if (nums.length === 0)
                return { checkable: false, matches: true, claimed: [] };
            const matches = inValue.every((v) => nums.some((n) => agree(n, v)));
            return { checkable: true, matches, claimed: nums.map((n) => n.text) };
        }
        return { checkable: true, matches: claimText.includes(value), claimed: [] };
    }
    return { checkable: false, matches: true, claimed: [] };
}
//# sourceMappingURL=values.js.map