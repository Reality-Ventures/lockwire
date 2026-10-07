import { fingerprintSet } from "./hash.js";
const IDENTIFIER_TYPES = new Set([
    "identifier",
    "property_identifier",
    "shorthand_property_identifier",
    "type_identifier",
]);
const SKIP_ANONYMOUS = new Set([",", ";"]);
const DECLARATION_TYPES = {
    typescript: {
        fn: ["function_declaration"],
        cls: ["class_declaration", "interface_declaration"],
        method: ["method_definition"],
        wrapper: ["export_statement"],
    },
    tsx: {
        fn: ["function_declaration"],
        cls: ["class_declaration", "interface_declaration"],
        method: ["method_definition"],
        wrapper: ["export_statement"],
    },
    javascript: {
        fn: ["function_declaration"],
        cls: ["class_declaration"],
        method: ["method_definition"],
        wrapper: ["export_statement"],
    },
    python: {
        fn: ["function_definition"],
        cls: ["class_definition"],
        method: ["function_definition"],
        wrapper: ["decorated_definition"],
    },
};
/** Walks up to 2 ancestors looking for an export wrapper — covers `export function f() {}` and `export const f = ...`. */
function isExported(node, wrapperTypes) {
    let n = node;
    for (let i = 0; i < 2 && n; i++) {
        if (n.type === "export_statement")
            return true;
        n = n.parent;
    }
    return wrapperTypes.includes(node.type);
}
function collectImportedNames(root, lang) {
    const names = new Set();
    const types = lang === "python"
        ? ["import_statement", "import_from_statement"]
        : ["import_statement", "import_clause"];
    for (const imp of root.descendantsOfType(types)) {
        for (const id of imp.descendantsOfType(["identifier"]))
            names.add(id.text);
    }
    return names;
}
function collectLocalDeclared(subtree, paramNames, lang) {
    const locals = new Set(paramNames);
    if (lang === "python") {
        for (const assign of subtree.descendantsOfType(["assignment"])) {
            const left = assign.childForFieldName("left");
            if (left?.type === "identifier")
                locals.add(left.text);
        }
        for (const forStmt of subtree.descendantsOfType(["for_statement"])) {
            const left = forStmt.childForFieldName("left");
            if (left?.type === "identifier")
                locals.add(left.text);
        }
    }
    else {
        for (const decl of subtree.descendantsOfType(["variable_declarator"])) {
            const name = decl.childForFieldName("name");
            if (name?.type === "identifier")
                locals.add(name.text);
        }
    }
    return locals;
}
/** Recursive structural serializer: strips comments and pure separators, keeps operators/keywords/literals, aliases locals. */
function serializeBody(node, locals, normalizeLocals, aliasOf) {
    if (node.isExtra)
        return ""; // comments
    if (node.childCount === 0) {
        if (node.isNamed) {
            if (normalizeLocals && IDENTIFIER_TYPES.has(node.type) && locals.has(node.text)) {
                let idx = aliasOf.get(node.text);
                if (idx === undefined) {
                    idx = aliasOf.size + 1;
                    aliasOf.set(node.text, idx);
                }
                return `$${idx}`;
            }
            return `${node.type}:${node.text}`;
        }
        if (SKIP_ANONYMOUS.has(node.type))
            return "";
        return node.type;
    }
    const parts = [];
    for (const child of node.children) {
        if (!child)
            continue;
        const s = serializeBody(child, locals, normalizeLocals, aliasOf);
        if (s)
            parts.push(s);
    }
    return `(${node.type} ${parts.join(" ")})`;
}
function extractParamsTs(params) {
    if (!params)
        return [];
    const out = [];
    for (const p of params.namedChildren) {
        if (!p)
            continue;
        if (p.type === "required_parameter" || p.type === "optional_parameter") {
            const pattern = p.childForFieldName("pattern");
            out.push({
                name: pattern?.text ?? p.text,
                typed: p.childForFieldName("type") !== null,
                hasDefault: p.childForFieldName("value") !== null || p.type === "optional_parameter",
                variadic: false,
            });
        }
        else if (p.type === "identifier") {
            out.push({ name: p.text, typed: false, hasDefault: false, variadic: false });
        }
        else if (p.type === "assignment_pattern") {
            const left = p.childForFieldName("left");
            out.push({ name: left?.text ?? p.text, typed: false, hasDefault: true, variadic: false });
        }
        else if (p.type === "rest_pattern") {
            out.push({
                name: p.text.replace(/^\.\.\./, ""),
                typed: false,
                hasDefault: false,
                variadic: true,
            });
        }
    }
    return out;
}
function extractParamsPy(params) {
    if (!params)
        return [];
    const out = [];
    for (const p of params.namedChildren) {
        if (!p)
            continue;
        switch (p.type) {
            case "identifier":
                out.push({ name: p.text, typed: false, hasDefault: false, variadic: false });
                break;
            case "typed_parameter":
                out.push({
                    name: p.firstChild?.text ?? p.text,
                    typed: true,
                    hasDefault: false,
                    variadic: false,
                });
                break;
            case "default_parameter": {
                const name = p.childForFieldName("name");
                out.push({ name: name?.text ?? p.text, typed: false, hasDefault: true, variadic: false });
                break;
            }
            case "typed_default_parameter": {
                const name = p.childForFieldName("name");
                out.push({ name: name?.text ?? p.text, typed: true, hasDefault: true, variadic: false });
                break;
            }
            case "list_splat_pattern":
                out.push({
                    name: p.text.replace(/^\*/, ""),
                    typed: false,
                    hasDefault: false,
                    variadic: true,
                });
                break;
            case "dictionary_splat_pattern":
                out.push({
                    name: p.text.replace(/^\*\*/, ""),
                    typed: false,
                    hasDefault: false,
                    variadic: true,
                });
                break;
        }
    }
    return out;
}
/** Node types that open a new function scope: anything declared inside one is local, not a symbol. */
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
    "class",
    "interface_declaration",
    "class_definition",
]);
function hasAncestorIn(node, types) {
    for (let n = node.parent; n; n = n.parent)
        if (types.has(n.type))
            return true;
    return false;
}
/** The parameters of a function node, including the paren-less single-parameter arrow form (`x => x + 1`). */
function paramsOf(node, lang) {
    const container = node.childForFieldName("parameters");
    if (container)
        return lang === "python" ? extractParamsPy(container) : extractParamsTs(container);
    const single = lang === "python" ? null : node.childForFieldName("parameter");
    return single ? [{ name: single.text, typed: false, hasDefault: false, variadic: false }] : [];
}
function sigForFunction(node, name, lang, exported) {
    const params = paramsOf(node, lang);
    const paramSig = params
        .map((p) => `${p.variadic ? "..." : ""}${p.name}${p.typed ? ":T" : ""}${p.hasDefault ? "=" : ""}`)
        .join(",");
    const returnNode = node.childForFieldName("return_type");
    const returnSig = returnNode ? returnNode.text.replace(/^:\s*/, "") : "";
    const modifiers = [];
    if (exported)
        modifiers.push("export");
    if (node.text.startsWith("async") ||
        node.childForFieldName("body")?.parent?.text.startsWith("async"))
        modifiers.push("async");
    if (node.parent?.type === "decorated_definition") {
        for (const dec of node.parent.namedChildren) {
            if (dec?.type === "decorator")
                modifiers.push(`@${dec.text.replace(/^@/, "")}`);
        }
    }
    return `fn ${name}(${paramSig})${returnSig ? `->${returnSig}` : ""} [${modifiers.sort().join(",")}]`;
}
function findCallRoot(callee) {
    const text = callee.text.replace(/^(this|self)\./, "");
    return text;
}
function collectDeps(subtree, lang, importedNames) {
    const deps = new Set();
    const callTypes = lang === "python" ? ["call"] : ["call_expression"];
    for (const call of subtree.descendantsOfType(callTypes)) {
        const callee = lang === "python" ? call.childForFieldName("function") : call.childForFieldName("function");
        if (callee)
            deps.add(findCallRoot(callee));
    }
    for (const id of subtree.descendantsOfType(["identifier"])) {
        if (importedNames.has(id.text))
            deps.add(id.text);
    }
    return [...deps].sort();
}
/**
 * Walks a parsed file and resolves every top-level function/class, and every method inside
 * each class, into a dotted symbol path ("createSession", "AuthConfig.refresh") with its
 * four tier fingerprints precomputed as raw material (sig string, normalized body, deps set).
 */
export function extractFileSymbols(root, lang, normalizeLocals) {
    const decl = DECLARATION_TYPES[lang];
    const importedNames = collectImportedNames(root, lang);
    const bySymbolPath = new Map();
    const fileExports = [];
    function unwrapDecorated(node) {
        return node.type === "decorated_definition"
            ? (node.childForFieldName("definition") ?? node)
            : node;
    }
    function addSymbol(symbolPath, kind, defNode, exported) {
        const name = symbolPath.includes(".")
            ? symbolPath.slice(symbolPath.lastIndexOf(".") + 1)
            : symbolPath;
        const sigTokens = kind === "class"
            ? `class ${name} [${exported ? "export" : ""}]`
            : sigForFunction(defNode, name, lang, exported);
        const bodyNode = defNode.childForFieldName("body") ?? defNode;
        const params = paramsOf(defNode, lang);
        const locals = collectLocalDeclared(bodyNode, params.map((p) => p.name), lang);
        const bodyNormalized = serializeBody(bodyNode, locals, normalizeLocals, new Map());
        const deps = collectDeps(bodyNode, lang, importedNames);
        const symbol = {
            kind,
            name,
            exported,
            sigTokens,
            bodyText: bodyNode.text,
            bodyNormalized,
            deps,
        };
        bySymbolPath.set(symbolPath, symbol);
        if (exported)
            fileExports.push(symbolPath);
    }
    // Symbols are module-level functions and classes, and the members of those classes. Anything
    // declared inside a function (a helper, a local class) is not addressable and must not shadow a
    // real top-level symbol of the same name.
    const isLocal = (node) => hasAncestorIn(node, FUNCTION_LIKE[lang]) || hasAncestorIn(node, CLASS_LIKE);
    // top-level functions (a decorated Python def is visited once, as its function_definition)
    for (const fnNode of root.descendantsOfType(decl.fn)) {
        if (isLocal(fnNode))
            continue;
        const nameNode = fnNode.childForFieldName("name");
        if (!nameNode)
            continue;
        addSymbol(nameNode.text, "function", fnNode, isExported(fnNode, decl.wrapper));
    }
    // top-level `const foo = () => {}` / `const foo = function () {}` — common for TSX components and JS handlers
    if (lang !== "python") {
        for (const declarator of root.descendantsOfType(["variable_declarator"])) {
            if (isLocal(declarator))
                continue;
            const value = declarator.childForFieldName("value");
            const nameNode = declarator.childForFieldName("name");
            if (!value || !nameNode || nameNode.type !== "identifier")
                continue;
            if (value.type !== "arrow_function" && value.type !== "function_expression")
                continue;
            const lexicalDecl = declarator.parent; // variable_declarator -> lexical_declaration
            addSymbol(nameNode.text, "function", value, isExported(lexicalDecl ?? declarator, decl.wrapper));
        }
    }
    // classes, their own methods, and classes nested directly in a class body (`Outer.Inner.method`)
    const methodTypes = lang === "python" ? ["function_definition"] : ["method_definition"];
    function visitClass(clsNode, prefix) {
        const nameNode = clsNode.childForFieldName("name");
        if (!nameNode)
            return;
        const path = prefix ? `${prefix}.${nameNode.text}` : nameNode.text;
        addSymbol(path, "class", clsNode, prefix ? false : isExported(clsNode, decl.wrapper));
        const body = clsNode.childForFieldName("body");
        if (!body)
            return;
        for (const child of body.namedChildren) {
            if (!child)
                continue;
            const member = unwrapDecorated(child);
            if (decl.cls.includes(member.type)) {
                visitClass(member, path);
                continue;
            }
            if (!methodTypes.includes(member.type))
                continue;
            const mName = member.childForFieldName("name");
            if (mName)
                addSymbol(`${path}.${mName.text}`, "method", member, false);
        }
    }
    for (const clsNode of root.descendantsOfType(decl.cls)) {
        if (!isLocal(clsNode))
            visitClass(clsNode, null);
    }
    return { bySymbolPath, fileExports };
}
export function fileExportsFingerprint(symbols) {
    return fingerprintSet(symbols.fileExports.map((path) => `${path}:${symbols.bySymbolPath.get(path)?.sigTokens ?? ""}`));
}
/** Whole-file tiers for a file-only anchor (no `#Symbol`): same normalization pipeline, applied to the root node. */
export function computeWholeFileTiers(root, lang, normalizeLocals) {
    const importedNames = collectImportedNames(root, lang);
    const locals = collectLocalDeclared(root, [], lang);
    return {
        bodyNormalized: serializeBody(root, locals, normalizeLocals, new Map()),
        deps: collectDeps(root, lang, importedNames),
    };
}
//# sourceMappingURL=extract.js.map