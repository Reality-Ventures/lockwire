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
 */
import type { Node } from "web-tree-sitter";
import type { LangId } from "./grammar.js";
import type { FileSymbols } from "./types.js";
/** A node as its tokens: comments and layout dropped, a trailing comma before a closer dropped. */
export declare function canon(node: Node): string;
export declare function extractFileSymbolsV2(root: Node, lang: LangId, normalizeLocals: boolean): FileSymbols;
/** Whole-file `body` and `deps` for a file-only anchor, read the version-2 way. */
export declare function computeWholeFileTiersV2(root: Node, lang: LangId, normalizeLocals: boolean): {
    bodyNormalized: string;
    deps: string[];
};
//# sourceMappingURL=extract-v2.d.ts.map