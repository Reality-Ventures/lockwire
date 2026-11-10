/**
 * Whether the extraction under way reads formatting the version-3 way. Set for the length of one
 * (synchronous) extraction by {@link withVersion}, so the helpers below needn't all carry it.
 */
let formatProof = false;
function withVersion(version, run) {
    const saved = formatProof;
    formatProof = version >= 3;
    try {
        return run();
    }
    finally {
        formatProof = saved;
    }
}
/** `\'` and `\"` as the quote alone; every other escape as written. */
const unescapeQuotes = (s) => s.replace(/\\([\s\S])/g, (pair, c) => (c === "'" || c === '"' ? c : pair));
/**
 * A string literal whichever quotes delimit it: its prefix (lower case, sorted, without Python 3's
 * no-op `u`) and its contents with escaped quotes unescaped. `inner` renders an f-string's
 * interpolations. Null for anything but a plain or f-string literal (a template literal keeps its
 * backticks: there's no other way to write one).
 */
function stringLiteral(node, lang, inner) {
    // Named: TS's `string` keyword is an unnamed node of the same type.
    if (node.type !== "string" || !node.isNamed)
        return null;
    if (lang !== "python")
        return JSON.stringify(unescapeQuotes(node.text.slice(1, -1)));
    let prefix = "";
    let quote = 1;
    let contents = "";
    const text = (t) => {
        contents += prefix.includes("r") ? t : unescapeQuotes(t);
    };
    for (const c of node.children) {
        if (!c || c.isExtra)
            continue;
        if (c.type === "string_start") {
            const delimiter = c.text.replace(/^[^'"]*/, "");
            quote = delimiter.length;
            prefix = [...c.text.slice(0, -quote).toLowerCase().replace("u", "")].sort().join("");
        }
        // An f-string's own braces are written doubled (`{{`), so an interpolation can't be mistaken for text.
        else if (c.type === "interpolation")
            contents += inner(c);
        // The grammar ends `r'\''` with a `string_end` of `\''`: what precedes the closing quote is text.
        else if (c.type === "string_end")
            text(c.text.slice(0, -quote));
        else
            text(c.text);
    }
    return `${prefix}${JSON.stringify(contents)}`;
}
/** A number literal however it's spelled: case, `_` separators and, in TS/JS, the value it denotes. */
function numberLiteral(text, lang) {
    const t = text.toLowerCase().replace(/_/g, "");
    // Python keeps the spelling (`1` and `1.0` are different types); so do BigInts and legacy octals.
    if (lang === "python" || t.endsWith("n") || /^0\d/.test(t))
        return t;
    const value = Number(t);
    return Number.isFinite(value) ? String(value) : t;
}
const NUMBER_TYPES = new Set(["number", "integer", "float"]);
/** The node types version 3 reads differently from version 2 (bar optional parentheses). */
const FORMATTED_TYPES = new Set(["string", ...NUMBER_TYPES, "formal_parameters"]);
/** Members whose name may be quoted or not, as long as it's an identifier either way. */
const NAMED_MEMBERS = new Set([
    "pair",
    "property_signature",
    "method_signature",
    "public_field_definition",
    "field_definition",
    "method_definition",
    "abstract_method_signature",
]);
/** A quoted member name that needn't be (`{ 'a': 1 }`): the bare name. */
function unquotedKey(node, lang) {
    if (lang === "python" || node.type !== "string" || !node.isNamed)
        return null;
    const parent = node.parent;
    if (!parent || !NAMED_MEMBERS.has(parent.type))
        return null;
    const field = ["key", "name", "property"]
        .map((f) => parent.childForFieldName(f))
        .find((c) => c?.id === node.id);
    if (!field)
        return null;
    const name = unescapeQuotes(node.text.slice(1, -1));
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
}
/** Python's optional parentheses: around an import list, a `with` clause, or a tuple. */
const OPTIONAL_PARENS = new Set(["import_from_statement", "with_clause", "tuple", "tuple_pattern"]);
/** A parenthesized tuple is the same tuple without the parentheses. */
const TUPLE_AS = new Map([
    ["tuple", "expression_list"],
    ["tuple_pattern", "pattern_list"],
]);
/** An arrow function's one plain parameter, when it's written in parentheses (`(x) => x`). */
function soleArrowParameter(node) {
    if (node.type !== "formal_parameters" || node.parent?.type !== "arrow_function")
        return null;
    const params = node.namedChildren.filter((c) => c !== null && !c.isExtra);
    if (params.length !== 1)
        return null;
    const p = params[0];
    if (p.type === "identifier")
        return p;
    const named = p.namedChildren.filter((c) => c !== null && !c.isExtra);
    return p.type === "required_parameter" && named.length === 1 && named[0]?.type === "identifier"
        ? named[0]
        : null;
}
/** A node as its tokens: comments and layout dropped, a trailing comma before a closer dropped. */
export function canon(node, lang) {
    const tokens = [];
    const walk = (n) => {
        if (n.isExtra)
            return; // comments
        if (formatProof && lang) {
            const key = unquotedKey(n, lang);
            const literal = key ?? stringLiteral(n, lang, (i) => canon(i, lang));
            if (literal !== null) {
                tokens.push(literal);
                return;
            }
            if (n.isNamed && NUMBER_TYPES.has(n.type)) {
                tokens.push(numberLiteral(n.text, lang));
                return;
            }
            if (n.type === "parenthesized_expression" && n.namedChildCount === 1) {
                const inner = n.namedChildren[0];
                if (inner && !inner.isExtra)
                    return walk(inner);
            }
            // (An arrow's parameters need nothing here: sigOf writes a bare one in parentheses.)
        }
        if (n.childCount === 0) {
            const t = n.text.trim();
            if (t)
                tokens.push(t);
            return;
        }
        const dropParens = formatProof && lang === "python" && OPTIONAL_PARENS.has(n.type);
        for (const c of n.children)
            if (c && !(dropParens && (c.type === "(" || c.type === ")")))
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
function decoratorsOf(def, member, lang) {
    const out = [];
    const parent = member.parent;
    if (parent?.type === "decorated_definition" || parent?.type === "export_statement")
        for (const c of parent.namedChildren)
            if (c?.type === "decorator")
                out.push(canon(c, lang));
    for (const c of def.namedChildren)
        if (c?.type === "decorator")
            out.push(canon(c, lang));
    // A TS class member's decorators are the class body's children right before it.
    if (parent?.type === "class_body")
        for (let s = member.previousSibling; s?.type === "decorator"; s = s.previousSibling)
            out.push(canon(s, lang));
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
            .map((c) => canon(c, lang))
            .join(" ");
        return `${n.type} ${name} ${body}${tail}`;
    }
    const typeParams = n.childForFieldName("type_parameters");
    const tp = typeParams ? canon(typeParams, lang) : "";
    if (def.kind === "class") {
        const heritage = lang === "python"
            ? n.childForFieldName("superclasses")
            : (n.namedChildren.find((c) => c?.type === "class_heritage") ?? null);
        return `class ${name}${tp}${heritage ? ` ${canon(heritage, lang)}` : ""}${tail}`;
    }
    const params = n.childForFieldName("parameters");
    const single = lang === "python" ? null : n.childForFieldName("parameter");
    const ps = params ? canon(params, lang) : single ? `(${canon(single, lang)})` : "()";
    const ret = n.childForFieldName("return_type");
    const rs = ret ? canon(ret, lang).replace(/^:\s*/, "") : "";
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
/**
 * The names `subtree` binds that are local to it, aliased in `body`. For a class or a whole file
 * (`ownNames`), from version 3 the names bound at its own top level, outside any function in it, aren't
 * locals: they are its fields, attributes, constants and exports, and renaming one changes what other
 * code can use (`montly_fee: float` → `monthly_fee: float` renames a model's field and its JSON key).
 */
function collectLocals(subtree, outerParams, lang, ownNames = false) {
    const locals = new Set();
    const own = new Set();
    const keepOwn = ownNames && formatProof;
    /** Records the names `pattern` binds at `site`: the scope's own when no function lies between. */
    const bind = (site, pattern) => {
        if (!site)
            return;
        const names = new Set();
        patternNames(pattern, names);
        let inFunction = false;
        if (keepOwn)
            for (let p = site.parent; p && p.id !== subtree.id; p = p.parent)
                if (FUNCTION_LIKE[lang].has(p.type)) {
                    inFunction = true;
                    break;
                }
        for (const name of names)
            (keepOwn && !inFunction ? own : locals).add(name);
    };
    paramNames(outerParams, lang, locals);
    if (lang === "python") {
        for (const fn of subtree.descendantsOfType(["function_definition", "lambda"]))
            paramNames(fn?.childForFieldName("parameters") ?? null, lang, locals);
        for (const n of subtree.descendantsOfType(["assignment", "augmented_assignment"]))
            bind(n, n?.childForFieldName("left") ?? null);
        for (const n of subtree.descendantsOfType(["for_statement"]))
            bind(n, n?.childForFieldName("left") ?? null);
        // A comprehension is a scope of its own, wherever it is.
        for (const n of subtree.descendantsOfType(["for_in_clause"]))
            patternNames(n?.childForFieldName("left") ?? null, locals);
        for (const n of subtree.descendantsOfType(["as_pattern_target"]))
            for (const c of n?.namedChildren ?? [])
                bind(n, c);
        for (const n of subtree.descendantsOfType(["named_expression"]))
            bind(n, n?.childForFieldName("name") ?? null);
    }
    else {
        for (const n of subtree.descendantsOfType(["variable_declarator"]))
            bind(n, n?.childForFieldName("name") ?? null);
        for (const n of subtree.descendantsOfType([...FUNCTION_LIKE[lang]])) {
            paramNames(n?.childForFieldName("parameters") ?? null, lang, locals);
            const single = n?.childForFieldName("parameter");
            if (single)
                patternNames(single, locals);
        }
        for (const n of subtree.descendantsOfType(["for_in_statement"]))
            bind(n, n?.childForFieldName("left") ?? null);
        for (const n of subtree.descendantsOfType(["catch_clause"]))
            bind(n, n?.childForFieldName("parameter") ?? null);
    }
    // A name that is also the scope's own is read as written everywhere, so the two never get confused.
    for (const name of own)
        locals.delete(name);
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
    // Read once: each read of a node's type is a call into the parser.
    const nodeType = node.type;
    // Grouping parentheses carry no meaning (the tree's shape already has the precedence), and
    // formatters add and remove them to wrap lines.
    if (nodeType === "parenthesized_expression" && node.namedChildCount === 1) {
        const inner = node.namedChildren[0];
        if (inner && !inner.isExtra)
            return serializeBody(inner, locals, normalizeLocals, lang, aliasOf);
    }
    if (formatProof && FORMATTED_TYPES.has(nodeType)) {
        const key = unquotedKey(node, lang);
        if (key !== null)
            return `property_identifier:${key}`;
        const literal = stringLiteral(node, lang, (i) => serializeBody(i, locals, normalizeLocals, lang, aliasOf));
        if (literal !== null)
            return `string:${literal}`;
        if (node.isNamed && NUMBER_TYPES.has(nodeType))
            return `${nodeType}:${numberLiteral(node.text, lang)}`;
        const sole = soleArrowParameter(node);
        if (sole)
            return serializeBody(sole, locals, normalizeLocals, lang, aliasOf);
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
            return `${nodeType}:${node.text}`;
        }
        if (nodeType === "," || nodeType === ";")
            return "";
        return nodeType;
    }
    const dropParens = formatProof && lang === "python" && OPTIONAL_PARENS.has(nodeType);
    const parts = [];
    for (const child of node.children) {
        if (!child || (dropParens && (child.type === "(" || child.type === ")")))
            continue;
        const s = serializeBody(child, locals, normalizeLocals, lang, aliasOf);
        if (s)
            parts.push(s);
    }
    const type = (formatProof && lang === "python" && TUPLE_AS.get(nodeType)) || nodeType;
    return `(${type} ${parts.join(" ")})`;
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
export function extractFileSymbolsV2(root, lang, normalizeLocals, version = 2) {
    return withVersion(version, () => extractSymbols(root, lang, normalizeLocals));
}
function extractSymbols(root, lang, normalizeLocals) {
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
            ? collectLocals(body ?? n, null, lang, true)
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
            decorators: decoratorsOf(cls, cls, lang),
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
                    decorators: decoratorsOf(member, member, lang),
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
                    decorators: decoratorsOf(member, member, lang),
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
                decorators: decoratorsOf(node, node, lang),
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
                    ...(type ? [`:${canon(type, lang).replace(/^:\s*/, "")}`] : []),
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
/** Whole-file `body` and `deps` for a file-only anchor, read the version-2 (or 3) way. */
export function computeWholeFileTiersV2(root, lang, normalizeLocals, version = 2) {
    return withVersion(version, () => {
        const importedNames = collectImportedNames(root, lang);
        const locals = collectLocals(root, null, lang, true);
        return {
            bodyNormalized: serializeBody(root, locals, normalizeLocals, lang, new Map()),
            deps: collectDeps([root], lang, importedNames, locals),
        };
    });
}
//# sourceMappingURL=extract-v2.js.map