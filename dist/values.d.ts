export type DataFormat = "json" | "tex" | "csv" | "tsv";
export declare function dataFormatOf(path: string): DataFormat | undefined;
export interface ResolvedValue {
    found: boolean;
    value?: unknown;
    /** The value as a person would write it, for messages: `0.18`, `"advisory"`. */
    display?: string;
    /** Why it wasn't found, when there's more to say than "not there" (an ambiguous row, say). */
    reason?: string;
}
/** RFC 4180 rows: quoted fields, `""` escapes, embedded delimiters and newlines, CRLF or LF. */
export declare function parseDelimited(text: string, delimiter: string): string[][];
/** Looks up `key` in the data file's text. Throws only on a file that can't be parsed at all. */
export declare function resolveValue(text: string, format: DataFormat, key: string): ResolvedValue;
/** A stable serialisation of the value for fingerprinting: key order never matters. */
export declare function valueFingerprintInput(value: unknown): string;
/** The whole data file as content, insensitive to JSON key order and to line endings. */
export declare function wholeFileContent(text: string, format: DataFormat): string;
export declare function displayValue(value: unknown): string;
export interface ClaimNumber {
    /** As written, sign and unit included: `0.18`, `18%`, `1,024`, `12.5ms`, `1.2B`, `−0.5`. */
    text: string;
    /** The quantity stated: `1.2B` is 1.2e9. */
    value: number;
    /**
     * Digits after the decimal point of the literal, i.e. the precision the sentence commits to, in
     * units of `scale`. Negative for scientific notation (`1.5e3` commits to the hundreds).
     */
    decimals: number;
    /** The magnitude a suffix applies (`k` 1e3, `M` 1e6, `B`/`bn` 1e9, `T` 1e12, or the words). */
    scale: number;
    percent: boolean;
}
/**
 * Numbers a sentence states. Skips digits that are part of a word or identifier (`v2`, `x86`, `h264`,
 * `0.18_lo`, `0x1F`), version strings (`1.2.3`) and ordinals (`2nd`). A unit glued to a number doesn't
 * hide it (`12.5ms` states 12.5), and a magnitude suffix scales it (`1.2B`, `3.5k`, `2 million`). A
 * hyphen between two numbers is a range, not a minus (`0.18-0.24`, LaTeX's `15--29`).
 */
export declare function claimNumbers(claim: string): ClaimNumber[];
export interface ClaimCheck {
    /** False when the sentence states nothing that can be compared with this value. */
    checkable: boolean;
    matches: boolean;
    /** What the sentence states, for the message. */
    claimed: string[];
}
/**
 * Does the claim state this value? A number value matches if any number in the sentence equals it at
 * the sentence's own precision (a percentage also matches the value × 100). A string value that
 * contains numbers (`21\%; 95\% CI 15--29\%`) matches if every one of them is stated in the sentence;
 * one with no numbers matches if the sentence contains it. Other values (objects, booleans, null)
 * aren't checked against prose.
 */
export declare function checkClaimAgainstValue(claimText: string, value: unknown): ClaimCheck;
//# sourceMappingURL=values.d.ts.map