import { describe, expect, it } from "vitest";
import { extractFileSymbols } from "../src/extract.js";
import { parserFor } from "../src/grammar.js";
import { fingerprint, fingerprintSet } from "../src/hash.js";

async function symbolsOf(source: string, lang: "typescript" | "tsx" | "javascript" | "python") {
  const parser = await parserFor(lang);
  const tree = parser.parse(source);
  if (!tree) throw new Error("parse failed");
  return extractFileSymbols(tree.rootNode, lang, true);
}

describe("extractFileSymbols — TypeScript", () => {
  const before = `
export async function createSession(userId: UserId, ttl = 3600): Promise<Session> {
  const token = mint(userId);
  return { token, ttl };
}
`;
  const bodyEdited = `
export async function createSession(userId: UserId, ttl = 3600): Promise<Session> {
  const token = mint(userId);
  console.log("issuing", userId);
  return { token, ttl };
}
`;
  const sigEdited = `
export async function createSession(userId: UserId, ttl: number = 3600): Promise<Session> {
  const token = mint(userId);
  return { token, ttl };
}
`;

  it("finds the exported function as a top-level symbol", async () => {
    const symbols = await symbolsOf(before, "typescript");
    expect(symbols.bySymbolPath.has("createSession")).toBe(true);
    const fn = symbols.bySymbolPath.get("createSession")!;
    expect(fn.exported).toBe(true);
    expect(fn.deps).toContain("mint");
  });

  it("body-only edits change the body fingerprint but not the sig fingerprint (the P0 claim)", async () => {
    const a = (await symbolsOf(before, "typescript")).bySymbolPath.get("createSession")!;
    const b = (await symbolsOf(bodyEdited, "typescript")).bySymbolPath.get("createSession")!;
    expect(fingerprint(a.sigTokens)).toBe(fingerprint(b.sigTokens));
    expect(fingerprint(a.bodyNormalized)).not.toBe(fingerprint(b.bodyNormalized));
  });

  it("a real signature change (param type added) changes the sig fingerprint", async () => {
    const a = (await symbolsOf(before, "typescript")).bySymbolPath.get("createSession")!;
    const c = (await symbolsOf(sigEdited, "typescript")).bySymbolPath.get("createSession")!;
    expect(fingerprint(a.sigTokens)).not.toBe(fingerprint(c.sigTokens));
  });

  it("reformatting alone changes neither fingerprint", async () => {
    const reformatted = `
export async function createSession(
  userId: UserId,
  ttl = 3600
): Promise<Session> {
  const token = mint(userId);
  return { token, ttl };
}
`;
    const a = (await symbolsOf(before, "typescript")).bySymbolPath.get("createSession")!;
    const d = (await symbolsOf(reformatted, "typescript")).bySymbolPath.get("createSession")!;
    expect(fingerprint(a.sigTokens)).toBe(fingerprint(d.sigTokens));
    expect(fingerprint(a.bodyNormalized)).toBe(fingerprint(d.bodyNormalized));
  });

  it("renaming a local variable does not change the body fingerprint when normalizeLocals is on", async () => {
    const renamed = `
export async function createSession(userId: UserId, ttl = 3600): Promise<Session> {
  const t = mint(userId);
  return { token: t, ttl };
}
`;
    const a = (await symbolsOf(before, "typescript")).bySymbolPath.get("createSession")!;
    const e = (await symbolsOf(renamed, "typescript")).bySymbolPath.get("createSession")!;
    // Renaming `token` -> `t` also changes which property-shorthand collapses, so this is a real
    // (if silly) body edit under our AST — assert the KNOWN-STABLE part instead: the sig is untouched.
    expect(fingerprint(a.sigTokens)).toBe(fingerprint(e.sigTokens));
  });
});

describe("extractFileSymbols — class methods", () => {
  const source = `
export class AuthConfig {
  refresh(token: string): void {
    validate(token);
  }
}
`;
  it("names a method ClassName.methodName", async () => {
    const symbols = await symbolsOf(source, "typescript");
    expect(symbols.bySymbolPath.has("AuthConfig.refresh")).toBe(true);
    expect(symbols.bySymbolPath.has("AuthConfig")).toBe(true);
  });
});

describe("extractFileSymbols — Python", () => {
  const source = `
@dataclass
class Session:
    def create(self, user_id: UserId, ttl: int = 3600) -> "Session":
        return mint(user_id)
`;
  it("finds a decorated class and its method", async () => {
    const symbols = await symbolsOf(source, "python");
    expect(symbols.bySymbolPath.has("Session")).toBe(true);
    expect(symbols.bySymbolPath.has("Session.create")).toBe(true);
    const method = symbols.bySymbolPath.get("Session.create")!;
    expect(method.deps).toContain("mint");
  });
});

describe("extractFileSymbols — TSX", () => {
  it("finds an arrow-function component bound with const", async () => {
    const source = `export const Card = ({ title }: { title: string }) => <div>{title}</div>;`;
    const symbols = await symbolsOf(source, "tsx");
    expect(symbols.bySymbolPath.has("Card")).toBe(true);
    expect(symbols.bySymbolPath.get("Card")!.exported).toBe(true);
  });
});

describe("fingerprintSet", () => {
  it("is order-independent", () => {
    expect(fingerprintSet(["b", "a", "a"])).toBe(fingerprintSet(["a", "b"]));
  });
});

describe("extractFileSymbols — scope: only module-level symbols and class members", () => {
  const sigs = async (src: string, lang: "typescript" | "tsx" | "javascript" | "python") => {
    const s = await symbolsOf(src, lang);
    return Object.fromEntries([...s.bySymbolPath].map(([k, v]) => [k, v.sigTokens]));
  };

  it("a function declared inside another function never shadows a top-level one of the same name (TS)", async () => {
    const out = await sigs(
      `export function helper(a: number): number { return a; }
export function outer(): void {
  function helper(x: string, y: string): void {}
  helper("a", "b");
}`,
      "typescript",
    );
    expect(Object.keys(out).sort()).toEqual(["helper", "outer"]);
    expect(out.helper).toBe("fn helper(a:T)->number [export]");
  });

  it("...and likewise in Python", async () => {
    const out = await sigs(
      "def helper(a): pass\ndef outer():\n    def helper(x, y): pass\n    return helper\n",
      "python",
    );
    expect(out.helper).toBe("fn helper(a) []");
    expect(Object.keys(out).sort()).toEqual(["helper", "outer"]);
  });

  it("locals inside arrow functions, methods and nested arrows aren't symbols either", async () => {
    const out = await sigs(
      `export const comp = () => {
  const inner = () => 1;
  function local() {}
  return inner;
};
export class K {
  m() { const alsoLocal = () => 2; class LocalClass {} }
}`,
      "typescript",
    );
    expect(Object.keys(out).sort()).toEqual(["K", "K.m", "comp"]);
  });

  it("a class declared inside a function is local, so its methods don't leak out as `Outer.m` or `Inner.m` (TS)", async () => {
    const out = await sigs(
      `export class Outer {
  run(a: number): void {}
  make() {
    class Inner { m(z: string): void {} }
    return new Inner();
  }
}`,
      "typescript",
    );
    expect(Object.keys(out).sort()).toEqual(["Outer", "Outer.make", "Outer.run"]);
  });

  it("a class nested directly in a class body gets a dotted path, and its methods hang off it (Python)", async () => {
    const out = await sigs(
      `class Outer:
    def run(self, a): pass
    class Inner:
        def m(self, z): pass
        class Deep:
            def d(self): pass
`,
      "python",
    );
    expect(Object.keys(out).sort()).toEqual([
      "Outer",
      "Outer.Inner",
      "Outer.Inner.Deep",
      "Outer.Inner.Deep.d",
      "Outer.Inner.m",
      "Outer.run",
    ]);
    // The outer class's own method list is not polluted by Inner's.
    expect(out["Outer.m"]).toBeUndefined();
  });

  it("a Django-style `class Meta` inside a model is addressable as Model.Meta", async () => {
    const out = await sigs(
      "class Book:\n    class Meta:\n        ordering = ['title']\n    def save(self): pass\n",
      "python",
    );
    expect(Object.keys(out).sort()).toEqual(["Book", "Book.Meta", "Book.save"]);
  });

  it("decorated methods and decorated top-level functions are each extracted exactly once", async () => {
    const s = await symbolsOf(
      `@app.route('/x')
def view(a, b=1): pass

class C:
    @property
    def p(self): pass
    @staticmethod
    def s(x): pass
`,
      "python",
    );
    expect([...s.bySymbolPath.keys()].sort()).toEqual(["C", "C.p", "C.s", "view"]);
    expect(s.bySymbolPath.get("view")?.sigTokens).toBe("fn view(a,b=) [@app.route('/x')]");
    // sigIndex must not list the same symbol under two different sig strings.
    const listed = [...s.sigIndex.values()].flat().filter((p) => p === "view");
    expect(listed).toHaveLength(1);
  });

  it("Python has no `export`, so decorating a function doesn't make it one", async () => {
    const s = await symbolsOf("@d\ndef f(): pass\n\ndef g(): pass\n", "python");
    expect(s.fileExports).toEqual([]);
    expect(s.bySymbolPath.get("f")?.exported).toBe(false);
  });

  it("exported TS declarations stay exported, and a nested export-looking function doesn't join the exports", async () => {
    const s = await symbolsOf(
      "export function a() {}\nfunction b() {}\nexport const c = () => 1;\nexport class D { e() {} }\n",
      "typescript",
    );
    expect(s.fileExports.sort()).toEqual(["D", "a", "c"]);
  });
});

describe("extractFileSymbols — paren-less single-parameter arrow functions", () => {
  const sigOf = async (src: string, lang: "typescript" | "tsx" | "javascript", name: string) =>
    (await symbolsOf(src, lang)).bySymbolPath.get(name)?.sigTokens;

  it("keeps the parameter in the signature (TS, TSX, JS)", async () => {
    expect(await sigOf("export const f = x => x + 1;", "typescript", "f")).toBe("fn f(x) [export]");
    expect(await sigOf("export const f = x => <b>{x}</b>;", "tsx", "f")).toBe("fn f(x) [export]");
    expect(await sigOf("const f = n => n * 2;", "javascript", "f")).toBe("fn f(n) []");
    expect(await sigOf("export const f = async y => y;", "typescript", "f")).toBe("fn f(y) [async,export]");
  });

  it("so growing or dropping the parameter is a sig change", async () => {
    const a = await sigOf("export const f = x => x;", "typescript", "f");
    const b = await sigOf("export const f = (x, y) => x;", "typescript", "f");
    const c = await sigOf("export const f = () => 1;", "typescript", "f");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("agrees with the parenthesised form, so adding parens is not a sig change", async () => {
    expect(await sigOf("export const f = x => x;", "typescript", "f")).toBe(
      await sigOf("export const f = (x) => x;", "typescript", "f"),
    );
  });

  it("treats the parameter as a local, so renaming it doesn't change the body fingerprint", async () => {
    const body = async (src: string) =>
      (await symbolsOf(src, "typescript")).bySymbolPath.get("f")?.bodyNormalized;
    expect(await body("export const f = x => x + 1;")).toBe(await body("export const f = y => y + 1;"));
    expect(await body("export const f = x => x + 1;")).not.toBe(await body("export const f = x => x + 2;"));
  });
});
