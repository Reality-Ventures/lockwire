/** A node as its tokens: comments and layout dropped, a trailing comma before a closer dropped. */
export function canon(node) {
    const tokens = [];
    const walk = (n) => {
        if (n.isExtra)
            return; // comments
        if (n.childCount === 0) {
            const t = n.text.trim();
            if (t)
                tokens.push(t);
            return;
        }
        for (const c of n.children)
            if (c)
                walk(c);
    };
    walk(node);
    const kept = tokens.filter((t, i) => !(t === "," && /^[)\]}>]$/.test(tokens[i + 1] ?? "")));
    // A space only where two words meet (`async def`, `x as y`), so it reads like the source: `f(a:number)`.
    let out = "";
    for (const t of kept)
        out += out && /[\w$]$/.test(out) && /^[\w$]/.test(t) ? ` ${t}` : t;
    return out;
}
const FUNCTION_VALUES = new Set([
    "arrow_function",
    "function_expression",
    "function",
    "generator_function",
]);
const FUNCTION_LIKE = {
    typescript: new Set([
        "function_declaration",
        "function_expression",
        "function",
        "generator_function_declaration",
        "generator_function",
        "arrow_function",
        "method_definition",
    ]),
    tsx: new Set([
        "function_declaration",
        "function_expression",
        "function",
        "generator_function_declaration",
        "generator_function",
        "arrow_function",
        "method_definition",
    ]),
    javascript: new Set([
        "function_declaration",
        "function_expression",
        "function",
        "generator_function_declaration",
        "generator_function",
        "arrow_function",
        "method_definition",
    ]),
    python: new Set(["function_definition", "lambda"]),
};
const CLASS_LIKE = new Set([
    "class_declaration",
    "abstract_class_declaration",
    "class",
    "interface_declaration",
    "class_definition",
]);
const NAMESPACE = new Set(["internal_module", "module"]);
function hasAncestorIn(node, types) {
    for (let n = node.parent; n; n = n.parent)
        if (types.has(n.type))
            return true;
    return false;
}
/** `NA.NB` for a declaration inside `namespace NA { namespace NB { … } }`. */
function namespacePrefix(node) {
    const names = [];
    for (let n = node.parent; n; n = n.parent)
        if (NAMESPACE.has(n.type)) {
            const name = n.childForFieldName("name");
            if (name)
                names.unshift(name.text);
        }
    return names.join(".");
}
/** `export …` directly, or through a declaration wrapper (`export const f = …`, `export declare function`). */
function isExported(node) {
    for (let n = node.parent, i = 0; n && i < 4; n = n.parent, i++) {
        if (n.type === "export_statement")
            return true;
        if (![
            "lexical_declaration",
            "variable_declaration",
            "variable_declarator",
            "ambient_declaration",
            "call_expression",
            "arguments",
        ].includes(n.type))
            return false;
    }
    return false;
}
/** Decorators written before a declaration: Python's `decorated_definition`, TS's on the class or export, or class-body siblings for a member. */
function decoratorsOf(def, member) {
    const out = [];
    const parent = member.parent;
    if (parent?.type === "decorated_definition" || parent?.type === "export_statement")
        for (const c of parent.namedChildren)
            if (c?.type === "decorator")
                out.push(canon(c));
    for (const c of def.namedChildren)
        if (c?.type === "decorator")
            out.push(canon(c));
    // A TS class member's decorators are the class body's children right before it.
    if (parent?.type === "class_body")
        for (let s = member.previousSibling; s?.type === "decorator"; s = s.previousSibling)
            out.push(canon(s));
    return out;
}
/** Keyword modifiers written before the name: `static`, `async`, `get`, `private`, `readonly`, `*`, `abstract`… */
function leadingModifiers(node) {
    if (!node)
        return [];
    const out = [];
    const name = node.childForFieldName("name");
    for (const c of node.children) {
        if (!c || (name && c.startIndex >= name.startIndex))
            break;
        if (c.type === "decorator" || c.isExtra)
            continue;
        // Only keywords: an unnamed function (an arrow) has no name to stop at, so stop at its parameters.
        if (c.isNamed && !["accessibility_modifier", "override_modifier"].includes(c.type))
            break;
        const t = canon(c);
        if ([
            "function",
            "def",
            "class",
            "interface",
            "type",
            "enum",
            "=",
            "const",
            "let",
            "var",
        ].includes(t))
            continue;
        if (t)
            out.push(t);
    }
    return out;
}
const NAME_SLOT = "\u0000name\u0000";
function sigOf(def, name, lang) {
    const n = def.node;
    const mods = [
        ...(def.exported ? ["export"] : []),
        ...def.extra,
        ...def.decorators.map((d) => (d.startsWith("@") ? d : `@${d}`)),
        ...leadingModifiers(n),
    ];
    const tail = ` [${mods.sort().join(",")}]`;
    if (def.kind === "type") {
        // An interface, type alias or enum is all contract: its whole declaration, name swapped in.
        const nameNode = n.childForFieldName("name");
        const body = [...n.children]
            .filter((c) => c !== null && c !== nameNode && !c.isExtra && c.type !== "decorator")
            .map(canon)
            .join(" ");
        return `${n.type} ${name} ${body}${tail}`;
    }
    const typeParams = n.childForFieldName("type_parameters");
    const tp = typeParams ? canon(typeParams) : "";
    if (def.kind === "class") {
        const heritage = lang === "python"
            ? n.childForFieldName("superclasses")
            : (n.namedChildren.find((c) => c?.type === "class_heritage") ?? null);
        return `class ${name}${tp}${heritage ? ` ${canon(heritage)}` : ""}${tail}`;
    }
    const params = n.childForFieldName("parameters");
    const single = lang === "python" ? null : n.childForFieldName("parameter");
    const ps = params ? canon(params) : single ? `(${canon(single)})` : "()";
    const ret = n.childForFieldName("return_type");
    const rs = ret ? canon(ret).replace(/^:\s*/, "") : "";
    return `fn ${name}${tp}${ps}${rs ? `->${rs}` : ""}${tail}`;
}
// -------------------------------------------------------------------------------------------------
// Locals, body and deps
/** Identifiers a binding pattern declares: `a`, `[k, v]`, `{ b: c, ...r }`, `(x, y)`; never a property key. */
function patternNames(pattern, out) {
    if (!pattern)
        return;
    if (pattern.type === "identifier") {
        out.add(pattern.text);
        return;
    }
    if (pattern.type === "shorthand_property_identifier_pattern")
        return; // `{a}` reads property a
    for (const c of pattern.namedChildren) {
        if (!c)
            continue;
        if (c.type === "pair_pattern")
            patternNames(c.childForFieldName("value"), out);
        else if (c.type === "property_identifier")
            continue;
        else
            patternNames(c, out);
    }
}
function paramNames(params, lang, out) {
    if (!params)
        return;
    if (params.type === "identifier") {
        out.add(params.text);
        return;
    }
    for (const p of params.namedChildren) {
        if (!p)
            continue;
        if (lang === "python") {
            const name = p.type === "identifier"
                ? p
                : (p.childForFieldName("name") ??
                    p.namedChildren.find((c) => c?.type === "identifier") ??
                    null);
            if (name?.type === "identifier")
                out.add(name.text);
        }
        else if (p.type === "required_parameter" || p.type === "optional_parameter") {
            patternNames(p.childForFieldName("pattern"), out);
        }
        else if (p.type === "assignment_pattern") {
            patternNames(p.childForFieldName("left"), out);
        }
        else {
            patternNames(p, out);
        }
    }
}
function collectLocals(subtree, outerParams, lang) {
    const locals = new Set();
    paramNames(outerParams, lang, locals);
    if (lang === "python") {
        for (const fn of subtree.descendantsOfType(["function_definition", "lambda"]))
            paramNames(fn?.childForFieldName("parameters") ?? null, lang, locals);
        for (const n of subtree.descendantsOfType(["assignment", "augmented_assignment"]))
            patternNames(n?.childForFieldName("left") ?? null, locals);
        for (const n of subtree.descendantsOfType(["for_statement", "for_in_clause"]))
            patternNames(n?.childForFieldName("left") ?? null, locals);
        for (const n of subtree.descendantsOfType(["as_pattern_target"]))
            for (const c of n?.namedChildren ?? [])
                patternNames(c, locals);
        for (const n of subtree.descendantsOfType(["named_expression"]))
            patternNames(n?.childForFieldName("name") ?? null, locals);
    }
    else {
        for (const n of subtree.descendantsOfType(["variable_declarator"]))
            patternNames(n?.childForFieldName("name") ?? null, locals);
        for (const n of subtree.descendantsOfType([...FUNCTION_LIKE[lang]])) {
            paramNames(n?.childForFieldName("parameters") ?? null, lang, locals);
            const single = n?.childForFieldName("parameter");
            if (single)
                patternNames(single, locals);
        }
        for (const n of subtree.descendantsOfType(["for_in_statement"]))
            patternNames(n?.childForFieldName("left") ?? null, locals);
        for (const n of subtree.descendantsOfType(["catch_clause"]))
            patternNames(n?.childForFieldName("parameter") ?? null, locals);
    }
    return locals;
}
/** An identifier that names a value, not a property, attribute or keyword argument. */
function isValueIdentifier(node, lang) {
    if (node.type !== "identifier")
        return false;
    const parent = node.parent;
    if (!parent)
        return true;
    if (lang === "python") {
        if (parent.type === "attribute" && parent.childForFieldName("attribute")?.id === node.id)
            return false;
        if (parent.type === "keyword_argument" && parent.childForFieldName("name")?.id === node.id)
            return false;
    }
    return true;
}
function serializeBody(node, locals, normalizeLocals, lang, aliasOf) {
    if (node.isExtra)
        return "";
    // Grouping parentheses carry no meaning (the tree's shape already has the precedence), and
    // formatters add and remove them to wrap lines.
    if (node.type === "parenthesized_expression" && node.namedChildCount === 1) {
        const inner = node.namedChildren[0];
        if (inner && !inner.isExtra)
            return serializeBody(inner, locals, normalizeLocals, lang, aliasOf);
    }
    if (node.childCount === 0) {
        if (node.isNamed) {
            if (normalizeLocals && locals.has(node.text) && isValueIdentifier(node, lang)) {
                let idx = aliasOf.get(node.text);
                if (idx === undefined) {
                    idx = aliasOf.size + 1;
                    aliasOf.set(node.text, idx);
                }
                return `$${idx}`;
            }
            return `${node.type}:${node.text}`;
        }
        if (node.type === "," || node.type === ";")
            return "";
        return node.type;
    }
    const parts = [];
    for (const child of node.children) {
        if (!child)
            continue;
        const s = serializeBody(child, locals, normalizeLocals, lang, aliasOf);
        if (s)
            parts.push(s);
    }
    return `(${node.type} ${parts.join(" ")})`;
}
/** A Python function's docstring is documentation, not behaviour. */
function withoutDocstring(body, lang) {
    const children = body.children.filter((c) => c !== null);
    if (lang !== "python")
        return children;
    const first = body.namedChildren.find((c) => c !== null && !c.isExtra);
    const isDoc = first?.type === "expression_statement" &&
        first.namedChildren.length === 1 &&
        first.namedChildren[0]?.type === "string";
    return isDoc ? children.filter((c) => c.id !== first.id) : children;
}
/** A call's callee by structure: `client.get(url).json` is `$.get().json` when `client` is a local. */
function calleeName(n, locals, lang) {
    switch (n.type) {
        case "identifier":
            if (lang === "python" && n.text === "self")
                return "self";
            return locals.has(n.text) ? "$" : n.text;
        case "this":
        case "super":
            return n.type;
        case "member_expression":
        case "attribute": {
            const object = n.childForFieldName("object");
            const prop = n.childForFieldName(n.type === "attribute" ? "attribute" : "property");
            const head = object ? calleeName(object, locals, lang) : "?";
            return `${["this", "self"].includes(head) ? "" : `${head}.`}${prop?.text ?? "?"}`;
        }
        case "call_expression":
        case "call": {
            const fn = n.childForFieldName("function");
            return `${fn ? calleeName(fn, locals, lang) : "?"}()`;
        }
        case "subscript_expression":
        case "subscript": {
            const object = n.childForFieldName(n.type === "subscript" ? "value" : "object");
            return `${object ? calleeName(object, locals, lang) : "?"}[]`;
        }
        case "parenthesized_expression": {
            const inner = n.namedChildren[0];
            return inner ? calleeName(inner, locals, lang) : "?";
        }
        case "non_null_expression": {
            const inner = n.namedChildren[0];
            return inner ? calleeName(inner, locals, lang) : "?";
        }
        default:
            return n.type;
    }
}
function collectDeps(roots, lang, importedNames, locals) {
    const deps = new Set();
    const callTypes = lang === "python" ? ["call"] : ["call_expression", "new_expression"];
    for (const root of roots) {
        const nodes = [
            ...(callTypes.includes(root.type) ? [root] : []),
            ...root.descendantsOfType(callTypes),
        ];
        for (const call of nodes) {
            const callee = call?.childForFieldName(call.type === "new_expression" ? "constructor" : "function");
            if (callee)
                deps.add(calleeName(callee, locals, lang));
        }
        for (const id of [
            ...(root.type === "identifier" ? [root] : []),
            ...root.descendantsOfType(["identifier"]),
        ])
            if (id && importedNames.has(id.text) && isValueIdentifier(id, lang))
                deps.add(id.text);
    }
    return [...deps].sort();
}
function collectImportedNames(root, lang) {
    const names = new Set();
    const types = lang === "python"
        ? ["import_statement", "import_from_statement"]
        : ["import_statement", "import_clause"];
    for (const imp of root.descendantsOfType(types)) {
        for (const id of imp?.descendantsOfType(["identifier"]) ?? [])
            if (id)
                names.add(id.text);
    }
    // CommonJS: `const x = require("…")` and `const { a, b } = require("…")`.
    if (lang !== "python")
        for (const d of root.descendantsOfType(["variable_declarator"])) {
            const value = d?.childForFieldName("value");
            if (value?.type === "call_expression" &&
                value.childForFieldName("function")?.text === "require")
                patternNames(d?.childForFieldName("name") ?? null, names);
        }
    return names;
}
// -------------------------------------------------------------------------------------------------
// Declarations
/** The function inside `memo(function X() {})`, `forwardRef((p, ref) => …)`, `memo(forwardRef(…))`. */
function wrappedFunction(value, depth = 0) {
    if (FUNCTION_VALUES.has(value.type))
        return { fn: value, wrappers: [] };
    if (depth >= 2 || value.type !== "call_expression")
        return null;
    const callee = value.childForFieldName("function");
    const args = value.childForFieldName("arguments");
    for (const a of args?.namedChildren ?? []) {
        if (!a)
            continue;
        const inner = wrappedFunction(a, depth + 1);
        if (inner)
            return { fn: inner.fn, wrappers: [canon(callee ?? value), ...inner.wrappers] };
    }
    return null;
}
/** `exports.f`, `module.exports.f`, `View.prototype.render` → `f`, `f`, `View.render`. */
function commonJsPath(left) {
    if (left.type !== "member_expression")
        return null;
    const parts = canon(left).split(".");
    if (parts.some((p) => !/^[A-Za-z_$][\w$]*$/.test(p)))
        return null;
    let exported = false;
    if (parts[0] === "module" && parts[1] === "exports") {
        parts.splice(0, 2);
        exported = true;
    }
    else if (parts[0] === "exports") {
        parts.splice(0, 1);
        exported = true;
    }
    const path = parts.filter((p) => p !== "prototype").join(".");
    return path ? { path, exported } : null;
}
export function extractFileSymbolsV2(root, lang, normalizeLocals) {
    const importedNames = collectImportedNames(root, lang);
    const bySymbolPath = new Map();
    const fileExports = [];
    const isLocal = (node) => hasAncestorIn(node, FUNCTION_LIKE[lang]) || hasAncestorIn(node, CLASS_LIKE);
    function add(def) {
        const name = def.path.slice(def.path.lastIndexOf(".") + 1);
        const n = def.node;
        const body = def.kind === "type" ? null : (n.childForFieldName("body") ?? null);
        // A function's statements (less a docstring); an arrow's expression body; a class's whole body.
        const isBlock = body?.type === "block" || body?.type === "statement_block";
        const roots = !body
            ? []
            : def.kind !== "class" && isBlock
                ? withoutDocstring(body, lang)
                : [body];
        const locals = def.kind === "class"
            ? collectLocals(body ?? n, null, lang)
            : collectLocals(body ?? n, n.childForFieldName("parameters") ?? n.childForFieldName("parameter"), lang);
        const aliasOf = new Map();
        const bodyNormalized = roots
            .map((r) => serializeBody(r, locals, normalizeLocals, lang, aliasOf))
            .filter(Boolean)
            .join(" ");
        const deps = collectDeps(roots, lang, importedNames, locals);
        // Rendered now, with a placeholder for the name: the tree is freed once extraction is done.
        const template = sigOf(def, NAME_SLOT, lang);
        const sigFor = (as) => template.split(NAME_SLOT).join(as);
        const existing = bySymbolPath.get(def.path);
        if (existing) {
            // Overloads, a getter and its setter, a def per branch: one symbol made of all of them.
            const before = existing.sigFor;
            bySymbolPath.set(def.path, {
                ...existing,
                sigTokens: `${existing.sigTokens}\n${sigFor(name)}`,
                sigFor: (as) => `${before ? before(as) : existing.sigTokens}\n${sigFor(as)}`,
                bodyText: `${existing.bodyText}\n${body?.text ?? ""}`,
                sourceText: `${existing.sourceText}\n${def.outer.text}`,
                bodyNormalized: `${existing.bodyNormalized}\n${bodyNormalized}`,
                deps: [...new Set([...existing.deps, ...deps])].sort(),
                exported: existing.exported || def.exported,
            });
            if (def.exported && !existing.exported)
                fileExports.push(def.path);
            return;
        }
        bySymbolPath.set(def.path, {
            kind: def.kind,
            name,
            exported: def.exported,
            sigTokens: sigFor(name),
            sigFor,
            bodyText: body?.text ?? "",
            sourceText: def.outer.text,
            bodyNormalized,
            deps,
        });
        if (def.exported)
            fileExports.push(def.path);
    }
    const qualify = (node, name) => {
        const ns = namespacePrefix(node);
        return ns ? `${ns}.${name}` : name;
    };
    /** The statement a declaration is written in, decorators and `export` included. */
    const outerOf = (node) => {
        let n = node;
        while (n.parent &&
            [
                "decorated_definition",
                "export_statement",
                "variable_declarator",
                "lexical_declaration",
                "variable_declaration",
                "ambient_declaration",
                "assignment_expression",
                "expression_statement",
                "call_expression",
                "arguments",
            ].includes(n.parent.type))
            n = n.parent;
        return n;
    };
    // Module-level functions, generators and function signatures (overloads, `declare function`).
    const fnTypes = lang === "python"
        ? ["function_definition"]
        : ["function_declaration", "generator_function_declaration", "function_signature"];
    // Classes and the like are visited in source order with functions, so merged symbols read top-down.
    const topTypes = [
        ...fnTypes,
        ...(lang === "python"
            ? ["class_definition"]
            : [
                "class_declaration",
                "abstract_class_declaration",
                "interface_declaration",
                "type_alias_declaration",
                "enum_declaration",
                "variable_declarator",
                "assignment_expression",
            ]),
    ];
    function visitClass(cls, prefix) {
        const nameNode = cls.childForFieldName("name");
        if (!nameNode)
            return;
        const path = prefix ? `${prefix}.${nameNode.text}` : qualify(cls, nameNode.text);
        const isType = cls.type === "interface_declaration";
        add({
            path,
            kind: isType ? "type" : "class",
            node: cls,
            outer: prefix ? cls : outerOf(cls),
            exported: prefix ? false : isExported(cls),
            extra: [],
            decorators: decoratorsOf(cls, cls),
        });
        if (isType)
            return;
        const body = cls.childForFieldName("body");
        for (const child of body?.namedChildren ?? []) {
            if (!child)
                continue;
            const member = child.type === "decorated_definition"
                ? (child.childForFieldName("definition") ?? child)
                : child;
            if (["class_definition", "class_declaration", "abstract_class_declaration"].includes(member.type)) {
                visitClass(member, path);
                continue;
            }
            const mName = member.childForFieldName("name");
            if (!mName)
                continue;
            if (member.type === "method_definition" ||
                member.type === "method_signature" ||
                member.type === "abstract_method_signature" ||
                (lang === "python" && member.type === "function_definition")) {
                add({
                    path: `${path}.${mName.text}`,
                    kind: "method",
                    node: member,
                    outer: member.parent?.type === "decorated_definition" ? member.parent : member,
                    exported: false,
                    extra: [],
                    decorators: decoratorsOf(member, member),
                });
            }
            else if (member.type === "public_field_definition" || member.type === "field_definition") {
                // `onError = (handler) => { … }`: a method written as a field.
                const value = member.childForFieldName("value");
                const fn = value ? wrappedFunction(value) : null;
                if (!fn)
                    continue;
                add({
                    path: `${path}.${mName.text}`,
                    kind: "method",
                    node: fn.fn,
                    outer: member,
                    exported: false,
                    extra: [...leadingModifiers(member), ...fn.wrappers.map((w) => `wrap:${w}`)],
                    decorators: decoratorsOf(member, member),
                });
            }
        }
    }
    for (const node of root.descendantsOfType(topTypes)) {
        if (!node || isLocal(node))
            continue;
        const nameNode = node.childForFieldName("name");
        if (fnTypes.includes(node.type)) {
            if (!nameNode)
                continue;
            add({
                path: qualify(node, nameNode.text),
                kind: "function",
                node,
                outer: outerOf(node),
                exported: lang === "python" ? false : isExported(node),
                extra: [],
                decorators: decoratorsOf(node, node),
            });
        }
        else if (CLASS_LIKE.has(node.type)) {
            visitClass(node, null);
        }
        else if (node.type === "type_alias_declaration" || node.type === "enum_declaration") {
            if (!nameNode)
                continue;
            add({
                path: qualify(node, nameNode.text),
                kind: "type",
                node,
                outer: outerOf(node),
                exported: isExported(node),
                extra: [],
                decorators: [],
            });
        }
        else if (node.type === "variable_declarator") {
            // `const f = () => {}`, `const f: Handler = function () {}`, `const X = memo(forwardRef(…))`.
            const value = node.childForFieldName("value");
            if (!value || nameNode?.type !== "identifier")
                continue;
            const fn = wrappedFunction(value);
            if (!fn)
                continue;
            const type = node.childForFieldName("type");
            add({
                path: qualify(node, nameNode.text),
                kind: "function",
                node: fn.fn,
                outer: outerOf(node),
                exported: isExported(node),
                extra: [
                    ...(type ? [`:${canon(type).replace(/^:\s*/, "")}`] : []),
                    ...fn.wrappers.map((w) => `wrap:${w}`),
                ],
                decorators: [],
            });
        }
        else if (node.type === "assignment_expression") {
            // CommonJS: `exports.f = function () {}`, `View.prototype.render = function () {}`.
            if (node.parent?.type !== "expression_statement")
                continue;
            const left = node.childForFieldName("left");
            const right = node.childForFieldName("right");
            const target = left ? commonJsPath(left) : null;
            const fn = right ? wrappedFunction(right) : null;
            if (!target || !fn)
                continue;
            add({
                path: qualify(node, target.path),
                kind: target.path.includes(".") ? "method" : "function",
                node: fn.fn,
                outer: outerOf(node),
                exported: target.exported,
                extra: fn.wrappers.map((w) => `wrap:${w}`),
                decorators: [],
            });
        }
    }
    return { bySymbolPath, fileExports };
}
/** Whole-file `body` and `deps` for a file-only anchor, read the version-2 way. */
export function computeWholeFileTiersV2(root, lang, normalizeLocals) {
    const importedNames = collectImportedNames(root, lang);
    const locals = collectLocals(root, null, lang);
    return {
        bodyNormalized: serializeBody(root, locals, normalizeLocals, lang, new Map()),
        deps: collectDeps([root], lang, importedNames, locals),
    };
}
//# sourceMappingURL=extract-v2.js.map