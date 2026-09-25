import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";

export type LangId = "typescript" | "tsx" | "javascript" | "python";

const GRAMMAR_FILE: Record<LangId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
};

// dist/grammar.js -> ../grammars (flat src/ -> flat dist/, see package.json "files")
const GRAMMARS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "grammars");

export function langForPath(path: string): LangId | null {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "typescript";
  if (path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  if (path.endsWith(".py")) return "python";
  return null;
}

let initialized = false;
const cache = new Map<LangId, Language>();

export async function loadLanguage(lang: LangId): Promise<Language> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  const cached = cache.get(lang);
  if (cached) return cached;
  const loaded = await Language.load(join(GRAMMARS_DIR, GRAMMAR_FILE[lang]));
  cache.set(lang, loaded);
  return loaded;
}

export async function parserFor(lang: LangId): Promise<Parser> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
