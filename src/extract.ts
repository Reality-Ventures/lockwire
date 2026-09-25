import type { Node } from "web-tree-sitter";
import type { LangId } from "./grammar.js";
import { fingerprintSet } from "./hash.js";
import type { FileSymbols, ResolvedSymbol } from "./types.js";

const IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "type_identifier",
]);
const SKIP_ANONYMOUS = new Set([",", ";"]);

const DECLARATION_TYPES: Record<
  LangId,
  { fn: string[]; cls: string[]; method: string[]; wrapper: string[] }
> = {
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
function isExported(node: Node, wrapperTypes: string[]): boolean {
  let n: Node | null = node;
  for (let i = 0; i < 2 && n; i++) {
    if (n.type === "export_statement") return true;
    n = n.parent;
  }
  return wrapperTypes.includes(node.type);
}

function collectImportedNames(root: Node, lang: LangId): Set<string> {
  const names = new Set<string>();
  const types =
    lang === "python"
      ? ["import_statement", "import_from_statement"]
      : ["import_statement", "import_clause"];
  for (const imp of root.descendantsOfType(types)) {
    for (const id of imp.descendantsOfType(["identifier"])) names.add(id.text);
  }
  return names;
}

function collectLocalDeclared(subtree: Node, paramNames: string[], lang: LangId): Set<string> {
  const locals = new Set(paramNames);
  if (lang === "python") {
    for (const assign of subtree.descendantsOfType(["assignment"])) {
      const left = assign.childForFieldName("left");
      if (left?.type === "identifier") locals.add(left.text);
    }
    for (const forStmt of subtree.descendantsOfType(["for_statement"])) {
      const left = forStmt.childForFieldName("left");
      if (left?.type === "identifier") locals.add(left.text);
    }
  } else {
    for (const decl of subtree.descendantsOfType(["variable_declarator"])) {
      const name = decl.childForFieldName("name");
      if (name?.type === "identifier") locals.add(name.text);
    }
  }
  return locals;
}

/** Recursive structural serializer: strips comments and pure separators, keeps operators/keywords/literals, aliases locals. */
function serializeBody(
  node: Node,
  locals: Set<string>,
  normalizeLocals: boolean,
  aliasOf: Map<string, number>,
): string {
  if (node.isExtra) return ""; // comments
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
    if (SKIP_ANONYMOUS.has(node.type)) return "";
    return node.type;
  }
  const parts: string[] = [];
  for (const child of node.children) {
    if (!child) continue;
    const s = serializeBody(child, locals, normalizeLocals, aliasOf);
    if (s) parts.push(s);
  }
  return `(${node.type} ${parts.join(" ")})`;
}

interface ParamInfo {
  name: string;
  typed: boolean;
  hasDefault: boolean;
  variadic: boolean;
}

function extractParamsTs(params: Node | null): ParamInfo[] {
  if (!params) return [];
  const out: ParamInfo[] = [];
  for (const p of params.namedChildren) {
    if (!p) continue;
    if (p.type === "required_parameter" || p.type === "optional_parameter") {
      const pattern = p.childForFieldName("pattern");
      out.push({
        name: pattern?.text ?? p.text,
        typed: p.childForFieldName("type") !== null,
        hasDefault: p.childForFieldName("value") !== null || p.type === "optional_parameter",
        variadic: false,
      });
    } else if (p.type === "identifier") {
      out.push({ name: p.text, typed: false, hasDefault: false, variadic: false });
    } else if (p.type === "assignment_pattern") {
      const left = p.childForFieldName("left");
      out.push({ name: left?.text ?? p.text, typed: false, hasDefault: true, variadic: false });
    } else if (p.type === "rest_pattern") {
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

function extractParamsPy(params: Node | null): ParamInfo[] {
  if (!params) return [];
  const out: ParamInfo[] = [];
  for (const p of params.namedChildren) {
    if (!p) continue;
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

function sigForFunction(node: Node, name: string, lang: LangId, exported: boolean): string {
  const isPy = lang === "python";
  const paramsNode = node.childForFieldName("parameters");
  const params = isPy ? extractParamsPy(paramsNode) : extractParamsTs(paramsNode);
  const paramSig = params
    .map(
      (p) => `${p.variadic ? "..." : ""}${p.name}${p.typed ? ":T" : ""}${p.hasDefault ? "=" : ""}`,
    )
    .join(",");
  const returnNode = node.childForFieldName("return_type");
  const returnSig = returnNode ? returnNode.text.replace(/^:\s*/, "") : "";
  const modifiers: string[] = [];
  if (exported) modifiers.push("export");
  if (
    node.text.startsWith("async") ||
    node.childForFieldName("body")?.parent?.text.startsWith("async")
  )
    modifiers.push("async");
  if (node.parent?.type === "decorated_definition") {
    for (const dec of node.parent.namedChildren) {
      if (dec?.type === "decorator") modifiers.push(`@${dec.text.replace(/^@/, "")}`);
    }
  }
  return `fn ${name}(${paramSig})${returnSig ? `->${returnSig}` : ""} [${modifiers.sort().join(",")}]`;
}

function findCallRoot(callee: Node): string {
  const text = callee.text.replace(/^(this|self)\./, "");
  return text;
}

function collectDeps(subtree: Node, lang: LangId, importedNames: Set<string>): string[] {
  const deps = new Set<string>();
  const callTypes = lang === "python" ? ["call"] : ["call_expression"];
  for (const call of subtree.descendantsOfType(callTypes)) {
    const callee =
      lang === "python" ? call.childForFieldName("function") : call.childForFieldName("function");
    if (callee) deps.add(findCallRoot(callee));
  }
  for (const id of subtree.descendantsOfType(["identifier"])) {
    if (importedNames.has(id.text)) deps.add(id.text);
  }
  return [...deps].sort();
}

/**
 * Walks a parsed file and resolves every top-level function/class, and every method inside
 * each class, into a dotted symbol path ("createSession", "AuthConfig.refresh") with its
 * four tier fingerprints precomputed as raw material (sig string, normalized body, deps set).
 */
export function extractFileSymbols(
  root: Node,
  lang: LangId,
  normalizeLocals: boolean,
): FileSymbols {
  const decl = DECLARATION_TYPES[lang];
  const importedNames = collectImportedNames(root, lang);
  const bySymbolPath = new Map<string, ResolvedSymbol>();
  const sigIndex = new Map<string, string[]>();
  const fileExports: string[] = [];

  function unwrapDecorated(node: Node): Node {
    return node.type === "decorated_definition"
      ? (node.childForFieldName("definition") ?? node)
      : node;
  }

  function addSymbol(symbolPath: string, kind: string, defNode: Node, exported: boolean) {
    const name = symbolPath.includes(".")
      ? symbolPath.slice(symbolPath.lastIndexOf(".") + 1)
      : symbolPath;
    const sigTokens =
      kind === "class"
        ? `class ${name} [${exported ? "export" : ""}]`
        : sigForFunction(defNode, name, lang, exported);
    const bodyNode = defNode.childForFieldName("body") ?? defNode;
    const params =
      lang === "python"
        ? extractParamsPy(defNode.childForFieldName("parameters"))
        : extractParamsTs(defNode.childForFieldName("parameters"));
    const locals = collectLocalDeclared(
      bodyNode,
      params.map((p) => p.name),
      lang,
    );
    const bodyNormalized = serializeBody(bodyNode, locals, normalizeLocals, new Map());
    const deps = collectDeps(bodyNode, lang, importedNames);
    const symbol: ResolvedSymbol = {
      kind,
      name,
      exported,
      sigTokens,
      bodyText: bodyNode.text,
      bodyNormalized,
      deps,
    };
    bySymbolPath.set(symbolPath, symbol);
    if (exported) fileExports.push(symbolPath);
    const list = sigIndex.get(sigTokens) ?? [];
    list.push(symbolPath);
    sigIndex.set(sigTokens, list);
  }

  // top-level functions
  for (const fnNode of root.descendantsOfType([...decl.fn, "decorated_definition"])) {
    const actual = unwrapDecorated(fnNode);
    if (!decl.fn.includes(actual.type)) continue;
    if (actual.parent && [...decl.cls].some((c) => hasAncestorOfType(actual, c))) continue; // handled as a method below
    const nameNode = actual.childForFieldName("name");
    if (!nameNode) continue;
    addSymbol(nameNode.text, "function", actual, isExported(fnNode, decl.wrapper));
  }

  // top-level `const foo = () => {}` / `const foo = function () {}` — common for TSX components and JS handlers
  if (lang !== "python") {
    for (const declarator of root.descendantsOfType(["variable_declarator"])) {
      if (
        hasAncestorOfType(declarator, "function_declaration") ||
        hasAncestorOfType(declarator, "class_declaration")
      )
        continue;
      const value = declarator.childForFieldName("value");
      const nameNode = declarator.childForFieldName("name");
      if (!value || !nameNode || nameNode.type !== "identifier") continue;
      if (value.type !== "arrow_function" && value.type !== "function_expression") continue;
      const lexicalDecl = declarator.parent; // variable_declarator -> lexical_declaration
      addSymbol(
        nameNode.text,
        "function",
        value,
        isExported(lexicalDecl ?? declarator, decl.wrapper),
      );
    }
  }

  // classes and their methods
  for (const clsNode of root.descendantsOfType(decl.cls)) {
    const nameNode = clsNode.childForFieldName("name");
    if (!nameNode) continue;
    const className = nameNode.text;
    addSymbol(className, "class", clsNode, isExported(clsNode, decl.wrapper));
    const body = clsNode.childForFieldName("body");
    if (!body) continue;
    const methodTypes =
      lang === "python" ? ["function_definition", "decorated_definition"] : ["method_definition"];
    for (const mNode of body.descendantsOfType(methodTypes)) {
      const actual = unwrapDecorated(mNode);
      const mName = actual.childForFieldName("name");
      if (!mName) continue;
      addSymbol(`${className}.${mName.text}`, "method", actual, false);
    }
  }

  return { bySymbolPath, sigIndex, fileExports };
}

function hasAncestorOfType(node: Node, type: string): boolean {
  let n = node.parent;
  while (n) {
    if (n.type === type) return true;
    n = n.parent;
  }
  return false;
}

export function fileExportsFingerprint(symbols: FileSymbols): string {
  return fingerprintSet(
    symbols.fileExports.map((path) => `${path}:${symbols.bySymbolPath.get(path)?.sigTokens ?? ""}`),
  );
}

/** Whole-file tiers for a file-only anchor (no `#Symbol`): same normalization pipeline, applied to the root node. */
export function computeWholeFileTiers(
  root: Node,
  lang: LangId,
  normalizeLocals: boolean,
): { bodyNormalized: string; deps: string[] } {
  const importedNames = collectImportedNames(root, lang);
  const locals = collectLocalDeclared(root, [], lang);
  return {
    bodyNormalized: serializeBody(root, locals, normalizeLocals, new Map()),
    deps: collectDeps(root, lang, importedNames),
  };
}
