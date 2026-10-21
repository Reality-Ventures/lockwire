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
    ".csv": "csv",
    ".tsv": "tsv",
};
export function dataFormatOf(path) {
    const dot = path.lastIndexOf(".");
    return dot < 0 ? undefined : DATA_EXTENSIONS[path.slice(dot).toLowerCase()];
}
// ---------------------------------------------------------------------------------------------
// CSV and TSV
/** RFC 4180 rows: quoted fields, `""` escapes, embedded delimiters and newlines, CRLF or LF. */
export function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') {
                field += '"';
                i++;
            }
            else if (c === '"')
                quoted = false;
            else
                field += c;
        }
        else if (c === '"' && field === "")
            quoted = true;
        else if (c === delimiter) {
            row.push(field);
            field = "";
        }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n")
                i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        }
        else
            field += c;
    }
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}
const unescapePart = (s) => s.replace(/~1/g, "/").replace(/~2/g, "&").replace(/~3/g, "=").replace(/~0/g, "~");
/** A cell as a value: a number when it is one (thousands separators allowed), otherwise the text; empty is null. */
function cellValue(cell) {
    const t = cell.trim();
    if (t === "")
        return null;
    if (/^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?$|^[-+]?\.\d+$/.test(t))
        return Number(t.replace(/,/g, ""));
    return t;
}
/**
 * A cell of a table with a header row. `key` is `<column>=<value>/<column>` (the row whose column
 * equals value; join several with `&`), `@<n>/<column>` (the nth data row), `<row>/<column>` (the row
 * whose first column is `row`), or `<column>` alone for a one-row table. `~1`, `~2`, `~3` and `~0`
 * escape `/`, `&`, `=` and `~` in a part.
 */
function tableValue(text, delimiter, key) {
    const [header, ...rows] = parseDelimited(text, delimiter);
    if (!header)
        return { found: false, reason: "the table is empty" };
    const cut = key.lastIndexOf("/");
    const column = unescapePart(cut < 0 ? key : key.slice(cut + 1));
    const rowSel = cut < 0 ? null : key.slice(0, cut);
    const col = header.findIndex((h) => h.trim() === column);
    if (col < 0)
        return {
            found: false,
            reason: `no column "${column}" (the header is ${header.map((h) => h.trim()).join(", ")})`,
        };
    let matches;
    if (rowSel === null) {
        if (rows.length !== 1)
            return {
                found: false,
                reason: `the table has ${rows.length} rows: name one, as <row>/${column}`,
            };
        matches = rows;
    }
    else if (/^@\d+$/.test(rowSel)) {
        const n = Number(rowSel.slice(1));
        matches = n >= 1 && n <= rows.length ? [rows[n - 1]] : [];
    }
    else {
        // `col=value&col2=value2`: every condition must hold. A lone part that isn't `<header>=…` (or
        // matches nothing that way) is the first column's value — `h=4, targets 2013-2016` is a row key.
        const parts = rowSel.split("&");
        const conditions = parts.map((part) => {
            const eq = part.indexOf("=");
            const c = eq < 0 ? -1 : header.findIndex((h) => h.trim() === unescapePart(part.slice(0, eq)));
            return c >= 0 ? { col: c, wanted: unescapePart(part.slice(eq + 1)) } : null;
        });
        const byConditions = conditions.every((c) => c !== null)
            ? rows.filter((r) => conditions.every((c) => (r[c.col] ?? "").trim() === c.wanted))
            : [];
        matches =
            byConditions.length > 0 || parts.length > 1
                ? byConditions
                : rows.filter((r) => (r[0] ?? "").trim() === unescapePart(rowSel));
    }
    if (matches.length === 0)
        return { found: false, reason: `no row ${rowSel}` };
    if (matches.length > 1)
        return {
            found: false,
            reason: `${matches.length} rows match ${rowSel}: use a column that identifies one, as <column>=<value>/${column}`,
        };
    const cell = matches[0]?.[col];
    if (cell === undefined)
        return { found: false, reason: `row ${rowSel} has no ${column} cell` };
    const value = cellValue(cell);
    return { found: true, value, display: displayValue(value) };
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
    if (format === "csv" || format === "tsv")
        return tableValue(text, format === "csv" ? "," : "\t", key);
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
    /** Where each single number sits in the text, for the range pass below (null for list items). */
    const spans = [];
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
            spans.push(one ? { start: signed ? start - 1 : start, end, bare: !suffix && !pct } : null);
        }
    }
    // In a range the unit is usually written once, on the upper bound: "25.4–35.2%", "(0.08–17%)",
    // "1.2–3.4B", LaTeX "15--29\%". A bare lower bound takes the upper bound's percent and magnitude.
    // Right to left, so a chain like "10–20–30%" passes it all the way down.
    for (let i = out.length - 2; i >= 0; i--) {
        const a = spans[i];
        const b = spans[i + 1];
        const lo = out[i];
        const hi = out[i + 1];
        if (!a || !b || !lo || !hi || !a.bare)
            continue;
        if (!/^\s*(?:–|—|‒|−|-|--|to)\s*$/.test(text.slice(a.end, b.start)))
            continue;
        if (!hi.percent && hi.scale === 1)
            continue;
        out[i] = { ...lo, percent: hi.percent, scale: hi.scale, value: lo.value * hi.scale };
        a.bare = false;
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