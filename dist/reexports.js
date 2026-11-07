/**
 * Names a module makes available without defining them: `export { foo } from "./new"`, `export *`,
 * `import { foo } from "./new"; export { foo }`, and Python's module-level `from .new import foo`.
 * A file that keeps a moved symbol's old name this way for compatibility still answers for it, so an
 * anchor on `old.ts#foo` resolves to where `foo` is really defined (see `resolveTarget`).
 */
import { existsSync, statSync } from "node:fs";
import { posix } from "node:path";
import { langForPath } from "./grammar.js";
import { resolveInsideRepo } from "./repo.js";
export const NO_REEXPORTS = { named: [], star: [] };
const stringValue = (n) => {
    if (!n)
        return null;
    const frag = n.namedChildren.find((c) => c?.type === "string_fragment");
    return frag ? frag.text : n.text.replace(/^['"`]|['"`]$/g, "");
};
function tsReExports(root) {
    const out = { named: [], star: [] };
    // What each imported name is, for `import { foo } from "./x"; export { foo }`.
    const imports = new Map();
    for (const imp of root.namedChildren) {
        if (imp?.type !== "import_statement")
            continue;
        const from = stringValue(imp.childForFieldName("source"));
        const clause = imp.namedChildren.find((c) => c?.type === "import_clause");
        if (!from || !clause)
            continue;
        for (const c of clause.namedChildren) {
            if (!c)
                continue;
            if (c.type === "identifier")
                imports.set(c.text, { from, imported: "default" });
            else if (c.type === "namespace_import") {
                const id = c.namedChildren.find((x) => x?.type === "identifier");
                if (id)
                    imports.set(id.text, { from, imported: "*" });
            }
            else if (c.type === "named_imports")
                for (const s of c.namedChildren) {
                    if (s?.type !== "import_specifier")
                        continue;
                    const name = s.childForFieldName("name")?.text;
                    const alias = s.childForFieldName("alias")?.text;
                    if (name)
                        imports.set(alias ?? name, { from, imported: name });
                }
        }
    }
    for (const exp of root.namedChildren) {
        if (exp?.type !== "export_statement")
            continue;
        const from = stringValue(exp.childForFieldName("source"));
        const clause = exp.namedChildren.find((c) => c?.type === "export_clause");
        const ns = exp.namedChildren.find((c) => c?.type === "namespace_export");
        if (clause) {
            for (const s of clause.namedChildren) {
                if (s?.type !== "export_specifier")
                    continue;
                const local = s.childForFieldName("name")?.text;
                const name = s.childForFieldName("alias")?.text ?? local;
                if (!local || !name)
                    continue;
                if (from)
                    out.named.push({ name, from, imported: local });
                else {
                    const imp = imports.get(local);
                    if (imp)
                        out.named.push({ name, ...imp });
                }
            }
        }
        else if (ns && from) {
            const id = ns.namedChildren.find((c) => c?.type === "identifier");
            if (id)
                out.named.push({ name: id.text, from, imported: "*" });
        }
        else if (from && exp.children.some((c) => c?.type === "*"))
            out.star.push(from);
    }
    return out;
}
/** Module-level only: an import inside a function is that function's business, not the module's. */
function pyReExports(root) {
    const out = { named: [], star: [] };
    for (const imp of root.descendantsOfType("import_from_statement")) {
        if (!imp)
            continue;
        let local = false;
        for (let p = imp.parent; p; p = p.parent)
            if (["function_definition", "class_definition", "lambda"].includes(p.type))
                local = true;
        if (local)
            continue;
        const from = imp.childForFieldName("module_name")?.text;
        if (!from)
            continue;
        if (imp.namedChildren.some((c) => c?.type === "wildcard_import")) {
            out.star.push(from);
            continue;
        }
        for (const n of imp.childrenForFieldName("name")) {
            if (!n)
                continue;
            if (n.type === "aliased_import") {
                const name = n.childForFieldName("name")?.text;
                const alias = n.childForFieldName("alias")?.text;
                if (name && alias)
                    out.named.push({ name: alias, from, imported: name });
            }
            else
                out.named.push({ name: n.text, from, imported: n.text });
        }
    }
    return out;
}
export function extractReExports(root, lang) {
    return lang === "python" ? pyReExports(root) : tsReExports(root);
}
const isFile = (repoRoot, rel) => {
    const abs = resolveInsideRepo(repoRoot, rel);
    try {
        return abs !== null && existsSync(abs) && statSync(abs).isFile();
    }
    catch {
        return false;
    }
};
const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
/**
 * The repo-relative file `specifier` names when imported from `fromFile`, or null when it isn't a
 * file in this repository lockwire can read (a package, a path alias, a compiled extension module).
 * TS/JS: relative specifiers only, with the usual extension and `index` lookups, and `./x.js` for
 * `x.ts`. Python: relative imports from the file's package, and absolute ones from the repository
 * root or any directory above the file (`src/`), as a module or a package `__init__.py`.
 */
export function resolveModule(repoRoot, fromFile, specifier) {
    const lang = langForPath(fromFile);
    if (!lang)
        return null;
    const dir = posix.dirname(fromFile);
    const pick = (paths) => paths.find((p) => !p.startsWith("..") && langForPath(p) && isFile(repoRoot, p)) ?? null;
    if (lang !== "python") {
        if (!specifier.startsWith("./") && !specifier.startsWith("../"))
            return null;
        const base = posix.normalize(posix.join(dir, specifier));
        const stem = base.replace(/\.(m|c)?jsx?$/, "");
        return pick([
            base,
            ...(stem !== base ? [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`] : []),
            ...TS_EXTS.map((e) => `${base}${e}`),
            ...TS_EXTS.map((e) => `${base}/index${e}`),
        ]);
    }
    const dots = /^\.*/.exec(specifier)?.[0].length ?? 0;
    const parts = specifier.slice(dots).split(".").filter(Boolean);
    const asModule = (root) => {
        const p = posix.join(root, ...parts);
        return parts.length === 0
            ? [posix.join(root, "__init__.py")]
            : [`${p}.py`, `${p}.pyi`, posix.join(p, "__init__.py")];
    };
    if (dots > 0) {
        let root = dir;
        for (let i = 1; i < dots; i++)
            root = posix.dirname(root);
        return pick(asModule(root === "." ? "" : root));
    }
    const roots = [""];
    for (let d = dir; d !== "." && d !== "" && d !== "/"; d = posix.dirname(d))
        roots.splice(1, 0, d);
    return pick(roots.flatMap(asModule));
}
//# sourceMappingURL=reexports.js.map