import { Language, Parser } from "web-tree-sitter";
export type LangId = "typescript" | "tsx" | "javascript" | "python";
export declare function langForPath(path: string): LangId | null;
export declare function loadLanguage(lang: LangId): Promise<Language>;
/** One parser per language, reused: a new one per file is wasm memory that's never given back. */
export declare function parserFor(lang: LangId): Promise<Parser>;
//# sourceMappingURL=grammar.d.ts.map