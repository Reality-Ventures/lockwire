// Fingerprint version 3: what code formatters (Black, Ruff, Prettier) rewrite without changing behaviour
// isn't drift. Found replaying FastAPI's release history against Python's own ast (a parenthesized
// `from … import (…)` that a formatter wrapped read as a changed body), then probed formatter by formatter.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, linkDoc, resolveTargetInText } from "../src/actions.js";
import { FINGERPRINT_VERSION } from "../src/extract.js";
import { readLockfile, writeLockfile } from "../src/lockfile.js";
import { DEFAULT_CONFIG } from "../src/types.js";

async function fps(path: string, src: string, symbol = "f", version = FINGERPRINT_VERSION) {
  const r = await resolveTargetInText({ path, symbol }, src, DEFAULT_CONFIG, version);
  expect(r.found, `${path}#${symbol} should resolve`).toBe(true);
  return r.fingerprints;
}

const same = async (path: string, a: string, b: string, symbol?: string) => {
  const [x, y] = [await fps(path, a, symbol), await fps(path, b, symbol)];
  return x.sig === y.sig && x.body === y.body;
};

const py = (body: string) => `def f(y):\n    ${body.replace(/\n/g, "\n    ")}\n`;
const ts = (body: string) => `function f(y: any) { ${body} }`;

describe("a formatter's rewrite reads the same", () => {
  it.each([
    ["FastAPI 0.120 → 0.140: a wrapped import", py("from m import a\nreturn a"), py("from m import (\n    a,\n)\nreturn a")],
    ["quotes", py("return 'a'"), py('return "a"')],
    ["escaped quotes", py("return 'it\\'s'"), py('return "it\'s"')],
    ["f-string quotes", py("return f'{y}!'"), py('return f"{y}!"')],
    ["triple quotes", py("z = '''a'''\nreturn z"), py('z = """a"""\nreturn z')],
    ["prefix case and a no-op u", py("return U'a' + B'b'"), py("return 'a' + b'b'")],
    ["number case", py("return 0XAB + 1E5"), py("return 0xAB + 1e5")],
    ["a parenthesized with", py("with open(y) as a, open(y) as b:\n    pass"), py("with (\n    open(y) as a,\n    open(y) as b,\n):\n    pass")],
    ["for-target parens", py("for (a, b) in y:\n    pass"), py("for a, b in y:\n    pass")],
    ["del parens", py("del (y[0], y[1])"), py("del y[0], y[1]")],
    ["a returned tuple's parens", py("return (y, 1)"), py("return y, 1")],
    ["a decorator's quotes", "@app.get('/a')\ndef f():\n    pass\n", '@app.get("/a")\ndef f():\n    pass\n'],
    ["a default's quotes", "def f(a='x'):\n    pass\n", 'def f(a="x"):\n    pass\n'],
    ["return-annotation parens", "def f() -> (int):\n    pass\n", "def f() -> int:\n    pass\n"],
  ])("Python: %s", async (_, a, b) => {
    expect(await same("a.py", a, b)).toBe(true);
  });

  it.each([
    ["quotes", ts("return 'a';"), ts('return "a";')],
    ["escaped quotes", ts("return 'it\\'s';"), ts('return "it\'s";')],
    ["arrow parens (Prettier 2.0's new default)", ts("return y.map(x => x + 1);"), ts("return y.map((x) => x + 1);")],
    ["number spelling", ts("return 0XAB + 1E5 + 1.50 + .5;"), ts("return 0xab + 1e5 + 1.5 + 0.5;")],
    ["quoted keys", ts("return { 'a': 1, b: 2 };"), ts("return { a: 1, b: 2 };")],
    ["a default's quotes", "function f(a = 'x') {}", 'function f(a = "x") {}'],
  ])("TS/JS: %s", async (_, a, b) => {
    expect(await same("a.ts", a, b)).toBe(true);
    expect(await same("a.js", a.replace(/: any/g, ""), b.replace(/: any/g, ""))).toBe(true);
  });

  it("an interface's quoted member names, unless they need the quotes", async () => {
    expect(await same("a.ts", "interface I { 'a': string }", "interface I { a: string }", "I")).toBe(true);
    const { parserFor } = await import("../src/grammar.js");
    const { extractFileSymbols } = await import("../src/extract.js");
    const src = "interface I { 'a b': string; 'c': number }\nfunction f(a: string = 'x'): number {}";
    const tree = (await parserFor("typescript")).parse(src);
    if (!tree) throw new Error("parse failed");
    const symbols = extractFileSymbols(tree.rootNode, "typescript", true).bySymbolPath;
    tree.delete();
    expect(symbols.get("I")?.sigTokens).toContain('{"a b":string;c:number}');
    // The `string` and `number` keywords aren't literals, however their nodes are named.
    expect(symbols.get("f")?.sigTokens).toBe('fn f(a:string="x")->number []');
  });
});

describe("a real change is still a change", () => {
  it.each([
    ["a string's contents", py("return 'a'"), py("return 'b'")],
    ["str and bytes", py("return 'a'"), py("return b'a'")],
    ["raw and escaped", py("return r'\\n'"), py("return '\\n'")],
    ["a raw string's backslash", py("return r'\\''"), py("return r\"'\"")],
    ["a raw string the grammar ends in its closing token", py("return r'\\''"), py("return r''")],
    ["an f-string and a plain one", py("return f'{y}'"), py("return '{y}'")],
    ["what an f-string interpolates", py("return f'{y}'"), py("return f'{z}'")],
    ["a backslash and a quote", py("return '\\\\'"), py("return '\\''")],
    ["int and float", py("return 1"), py("return 1.0")],
    ["a tuple and a list", py("return (y, 1)"), py("return [y, 1]")],
    ["a tuple argument and two arguments", py("return g((y, 1))"), py("return g(y, 1)")],
    ["a nested tuple", py("return (y, 1), 2"), py("return y, 1, 2")],
    ["what is imported", py("from m import (a, b)\nreturn a"), py("from m import a\nreturn a")],
    ["a dict's string key and a name", py("return {'a': y}"), py("return {a: y}")],
    ["a decorator's argument", "@app.get('/a')\ndef f():\n    pass\n", "@app.get('/b')\ndef f():\n    pass\n"],
    ["a default's escape", "def f(a='x\\ny'):\n    pass\n", "def f(a='x\\nz'):\n    pass\n"],
  ])("Python: %s", async (_, a, b) => {
    expect(await same("a.py", a, b)).toBe(false);
  });

  it.each([
    ["a string's contents", ts("return 'a';"), ts("return 'b';")],
    ["a number", ts("return 0.5;"), ts("return 0.25;")],
    ["a BigInt and a number", ts("return 1n;"), ts("return 1;")],
    ["one parameter and two", ts("return y.map((x) => x);"), ts("return y.map((x, i) => x);")],
    ["a typed parameter", ts("return y.map((x: number) => x);"), ts("return y.map(x => x);")],
    ["a defaulted parameter", ts("return y.map((x = 1) => x);"), ts("return y.map(x => x);")],
    ["a destructured parameter", ts("return y.map(([x]) => x);"), ts("return y.map(x => x);")],
    ["a key that needs its quotes", ts("return { 'a-b': 1 };"), ts("return { a: 1 };")],
    ["a computed key", ts("return { 'a': 1 };"), ts("return { [a]: 1 };")],
    ["an escape", ts("return 'a\\nb';"), ts("return 'a\\tb';")],
  ])("TS: %s", async (_, a, b) => {
    expect(await same("a.ts", a, b)).toBe(false);
  });
});

describe("a class's or a file's own names aren't locals", () => {
  // FastAPI 0.100 → 0.120 fixed a typo in a model's field (`montly_fee` → `monthly_fee`): that renames
  // the field, its JSON key and the constructor's keyword, but read as no change.
  const whole = async (path: string, a: string, b: string) => {
    const x = await resolveTargetInText({ path }, a, DEFAULT_CONFIG);
    const y = await resolveTargetInText({ path }, b, DEFAULT_CONFIG);
    return x.fingerprints.body === y.fingerprints.body;
  };

  it.each([
    ["a model's field", "class C(BaseModel):\n    montly_fee: float\n", "class C(BaseModel):\n    monthly_fee: float\n"],
    ["a class attribute", "class C:\n    retries = 3\n", "class C:\n    attempts = 3\n"],
    ["a nested class's attribute", "class C:\n    class Meta:\n        table = 'a'\n", "class C:\n    class Meta:\n        name = 'a'\n"],
  ])("renaming %s changes the class", async (_, a, b) => {
    expect(await same("a.py", a, b, "C")).toBe(false);
  });

  it.each([
    ["a method's local", "class C:\n    def a(self):\n        n = 1\n        return n\n", "class C:\n    def a(self):\n        m = 1\n        return m\n"],
    ["a comprehension's variable", "class C:\n    xs = [i for i in range(3)]\n", "class C:\n    xs = [j for j in range(3)]\n"],
  ])("renaming %s doesn't", async (_, a, b) => {
    expect(await same("a.py", a, b, "C")).toBe(true);
  });

  it("renaming a module's constant changes the file; renaming a function's local doesn't", async () => {
    expect(await whole("a.py", "TIMEOUT = 5\ndef f():\n    return TIMEOUT\n", "LIMIT = 5\ndef f():\n    return LIMIT\n")).toBe(false);
    expect(await whole("a.ts", "export const TIMEOUT = 5;\n", "export const LIMIT = 5;\n")).toBe(false);
    expect(await whole("a.py", "def f():\n    n = 1\n    return n\n", "def f():\n    m = 1\n    return m\n")).toBe(true);
    expect(await whole("a.ts", "export function f() { const n = 1; return n; }\n", "export function f() { const m = 1; return m; }\n")).toBe(true);
  });
});

describe("version 2 is frozen", () => {
  it("still computes exactly what anchors stamped with it hold", async () => {
    // Computed by lockwire 0.1.34, the last release to stamp version 2, for these sources.
    const src = {
      "a.py":
        "@app.get('/items', status_code=0X1F)\ndef f(a='x', *, b=(1, 2)) -> (int):\n    from m import (\n        c,\n    )\n    with (open(a) as h,):\n        pass\n    for (k, v) in c.items():\n        print(f'{k!r}: \\'{v}\\'')\n    return (a, b)\n",
      "a.ts":
        "export function f(xs: string[], o = { 'k': 1E3 }) {\n  return xs.map((x) => x + 'y' + \"z\" + 0XAB);\n}\n",
    };
    expect(await fps("a.py", src["a.py"], "f", 2)).toMatchObject({
      sig: "b3:dae55175fc1534e6436d34e883918bb0",
      body: "b3:b145cf44b2ee5893ce672f75a29145d7",
      deps: "b3:298897980324c9eeb4b87b81610a6319",
    });
    expect(await fps("a.ts", src["a.ts"], "f", 2)).toMatchObject({
      sig: "b3:0cfc4c0f38f7cda3e3a893be34ff5886",
      body: "b3:c9e539ee54dbd1a505de88d717785225",
      deps: "b3:a716745e31c43a5cd306c39783aaa4be",
    });
  });
  it("still reads a class's attributes and a file's constants as locals, as it always did", async () => {
    const py =
      "class C(BaseModel):\n    montly_fee: float = 1.0\n    xs = [i for i in range(3)]\n    def a(self, n):\n        m = n\n        return m\n";
    const ts = "export const TIMEOUT = 5;\nexport function f() { const n = TIMEOUT; return n; }\n";
    expect((await fps("a.py", py, "C", 2)).body).toBe("b3:c43ac0a3b44280b0bb4215f3c9587934");
    const file = await resolveTargetInText({ path: "a.ts" }, ts, DEFAULT_CONFIG, 2);
    expect(file.fingerprints.body).toBe("b3:fc1f784a2460ca43b849779a92812d86");
  });
});

describe("anchors stamped by fingerprint version 2", () => {
  async function v2Repo() {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-fpv3-"));
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "a.py"), "def f(y):\n    return g(y, 'a')\n");
    await writeFile(join(dir, "A.md"), "<!-- lockwire a.py#f sig,body -->\nf passes 'a' to g.\n");
    await linkDoc(dir, "A.md", DEFAULT_CONFIG, { type: "human" });
    const lock = await readLockfile(dir);
    const v2 = await fps("a.py", await readFile(join(dir, "a.py"), "utf8"), "f", 2);
    await writeLockfile(dir, {
      ...lock,
      anchors: lock.anchors.map((a) => ({ ...a, fingerprints: v2, fingerprintVersion: 2 })),
    });
    return dir;
  }

  it("are re-stamped the version-3 way when a check finds them unchanged, and then survive a formatter", async () => {
    const dir = await v2Repo();
    expect((await check(dir, DEFAULT_CONFIG)).summary).toMatchObject({ fresh: 1, drifted: 0 });
    expect((await readLockfile(dir)).anchors[0]?.fingerprintVersion).toBe(3);
    await writeFile(join(dir, "a.py"), 'def f(y):\n    return g(\n        y,\n        "a",\n    )\n');
    expect((await check(dir, DEFAULT_CONFIG)).summary).toMatchObject({ fresh: 1, drifted: 0 });
    await writeFile(join(dir, "a.py"), 'def f(y):\n    return g(y, "b")\n');
    expect((await check(dir, DEFAULT_CONFIG)).summary.drifted).toBe(1);
  });

  it("what version 2 saw as drift is still drift", async () => {
    const dir = await v2Repo();
    await writeFile(join(dir, "a.py"), "def f(y):\n    return g(y, 'b')\n");
    expect((await check(dir, DEFAULT_CONFIG)).summary.drifted).toBe(1);
    expect((await readLockfile(dir)).anchors[0]?.fingerprintVersion).toBe(2);
  });
});
