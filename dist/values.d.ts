export type DataFormat = "json" | "tex";
export declare function dataFormatOf(path: string): DataFormat | undefined;
export interface ResolvedValue {
    found: boolean;
    value?: unknown;
    /** The value as a person would write it, for messages: `0.18`, `"advisory"`. */
    display?: string;
}
/** Looks up `key` in the data file's text. Throws only on a file that can't be parsed at all. */
export declare function resolveValue(text: string, format: DataFormat, key: string): ResolvedValue;
/** A stable serialisation of the value for fingerprinting: key order never matters. */
export declare function valueFingerprintInput(value: unknown): string;
/** The whole data file as content, insensitive to JSON key order and to line endings. */
export declare function wholeFileContent(text: string, format: DataFormat): string;
export declare function displayValue(value: unknown): string;
export interface ClaimNumber {
    /** As written: `0.18`, `18%`, `1,024`. */
    text: string;
    value: number;
    /** Digits after the decimal point, i.e. the precision the sentence commits to. */
    decimals: number;
    percent: boolean;
}
/** Numbers a sentence states, skipping digits that are part of a word or identifier (`v2`, `x86`, `h264`). */
export declare function claimNumbers(text: string): ClaimNumber[];
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
export declare function checkClaimAgainstValue(claimText: string, value: unknown): ClaimCheck;
//# sourceMappingURL=values.d.ts.map