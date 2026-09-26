import { Language, Parser } from "web-tree-sitter";
export type LangId = "typescript" | "tsx" | "javascript" | "python";
export declare function langForPath(path: string): LangId | null;
export declare function loadLanguage(lang: LangId): Promise<Language>;
export declare function parserFor(lang: LangId): Promise<Parser>;
//# sourceMappingURL=grammar.d.ts.map