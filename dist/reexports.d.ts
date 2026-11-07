import type { Node } from "web-tree-sitter";
import { type LangId } from "./grammar.js";
export interface ReExport {
    /** The name this module exposes. */
    name: string;
    /** Where it comes from, as written: `./new`, `.core`, `pkg.core`. */
    from: string;
    /** Its name in that module; `*` when `name` is the whole module (`export * as ns`, `import * as ns`). */
    imported: string;
}
export interface ReExports {
    named: ReExport[];
    /** Modules re-exported whole: `export * from "./x"`, `from .x import *`. */
    star: string[];
}
export declare const NO_REEXPORTS: ReExports;
export declare function extractReExports(root: Node, lang: LangId): ReExports;
/**
 * The repo-relative file `specifier` names when imported from `fromFile`, or null when it isn't a
 * file in this repository lockwire can read (a package, a path alias, a compiled extension module).
 * TS/JS: relative specifiers only, with the usual extension and `index` lookups, and `./x.js` for
 * `x.ts`. Python: relative imports from the file's package, and absolute ones from the repository
 * root or any directory above the file (`src/`), as a module or a package `__init__.py`.
 */
export declare function resolveModule(repoRoot: string, fromFile: string, specifier: string): string | null;
//# sourceMappingURL=reexports.d.ts.map