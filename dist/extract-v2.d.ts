/**
 * Fingerprint version 2 of symbol extraction (see `FINGERPRINT_VERSION` in extract.ts). Version 1
 * stays in extract.ts, unchanged, so anchors stamped with it keep comparing like for like until they
 * are re-stamped. What version 2 adds, all of it found by running lockwire on real repositories:
 *
 * - `sig` holds the contract as written, not just its shape: parameter types and defaults, `*` and `/`
 *   separators, generics, return types, accessibility and other modifiers, decorators, a class's base
 *   classes and type parameters, an interface's or type alias's whole body. All of it is read as tokens,
 *   so reformatting (line breaks, spaces, trailing commas, comments) never changes it.
 * - A name defined more than once (overloads, a getter and its setter, a def in each branch of an `if`)
 *   is one symbol made of every definition, not whichever came last.
 * - More declarations are addressable: generators, `declare`/overload signatures, class fields holding a
 *   function, functions wrapped in a call (`memo(...)`, `forwardRef(...)`), CommonJS assignments
 *   (`exports.f = function`, `View.prototype.render = function`), type aliases, enums, and symbols
 *   inside a namespace (`NA.helper`).
 * - `body` aliases locals from every binding form (callback and nested-function parameters,
 *   destructuring, `for … of`, `catch`, `except … as`, `with … as`, comprehensions, `:=`) and never
 *   aliases a property, attribute or keyword name that happens to match a local. A Python docstring
 *   isn't part of the body.
 * - `deps` names each call by its structure (`client.get().json`), so reformatting a call chain or
 *   renaming a local passed as an argument doesn't move it.
 *
 * Version 3 is version 2 except that what code formatters (Black, Ruff, Prettier) rewrite without
 * changing behaviour reads the same either way, in `sig` and `body` alike: a string's quotes, escaped
 * quotes and prefix case (`'it\'s'`, `"it's"`, `U'a'`); a number's spelling (`0XAB`, `1E5`, and in
 * TS/JS `1.50`, `.5`); Python's optional parentheses (`from m import (a)`, `with (a, b):`,
 * `for (x, y) in`, `return (a, b)`, `-> (int)`); an arrow's single parameter with or without
 * parentheses; and a quoted key that needn't be (`{ 'a': 1 }`). It also stops reading a class's or a
 * whole file's own top-level names (a model's fields, a module's constants) as locals: renaming one
 * is a change (see {@link collectLocals}). Version-2 anchors keep being read the version-2 way (see
 * {@link withVersion}) until a check finds them unchanged and re-stamps them.
 */
import type { Node } from "web-tree-sitter";
import type { LangId } from "./grammar.js";
import type { FileSymbols } from "./types.js";
/** A node as its tokens: comments and layout dropped, a trailing comma before a closer dropped. */
export declare function canon(node: Node, lang?: LangId): string;
export declare function extractFileSymbolsV2(root: Node, lang: LangId, normalizeLocals: boolean, version?: number): FileSymbols;
/** Whole-file `body` and `deps` for a file-only anchor, read the version-2 (or 3) way. */
export declare function computeWholeFileTiersV2(root: Node, lang: LangId, normalizeLocals: boolean, version?: number): {
    bodyNormalized: string;
    deps: string[];
};
//# sourceMappingURL=extract-v2.d.ts.map