// Fingerprint version 2, case by case from running lockwire on real repositories. Each pair of
// sources is "before" and "after"; the test says which tiers must move and which must not.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, linkDoc, resolveTargetInText } from "../src/actions.js";
import { FINGERPRINT_VERSION } from "../src/extract.js";
import { readLockfile, writeLockfile } from "../src/lockfile.js";
import { DEFAULT_CONFIG, type Tier } from "../src/types.js";

async function fps(path: string, src: string, symbol?: string) {
  const r = await resolveTargetInText({ path, ...(symbol ? { symbol } : {}) }, src, DEFAULT_CONFIG);
  expect(r.found, `${path}#${symbol} should resolve`).toBe(true);
  return r.fingerprints;
}

/** The tiers that differ between two versions of a file, for one symbol. */
async function moved(path: string, symbol: string, before: string, after: string): Promise<Tier[]> {
  const a = await fps(path, before, symbol);
  const b = await fps(path, after, symbol);
  return (["sig", "body", "deps"] as const).filter((t) => a[t] !== b[t]);
}

describe("sig is the contract as written", () => {
  it("a TS parameter type change drifts sig (the README's own example)", async () => {
    expect(
      await moved(
        "a.ts",
        "createSession",
        "export function createSession(userId: UserId): Session { return s(userId); }",
        "export function createSession(userId: string): Session { return s(userId); }",
      ),
    ).toEqual(["sig"]);
  });

  it.each([
    ["generics", "export function f<T>(x: T) {}", "export function f<T extends object>(x: T) {}"],
    ["base class", "class K extends A {}", "class K extends B {}"],
    ["decorator", "class K { @Log() m() {} }", "class K { m() {} }"],
    ["accessibility", "class K { private m() {} }", "class K { public m() {} }"],
    ["static async", "class K { static async m() {} }", "class K { static m() {} }"],
    ["destructured props", "function B({ label }) {}", "function B({ label, disabled }) {}"],
    ["variable type", "const A: FC<P> = () => null;", "const A: FC<Q> = () => null;"],
    ["interface member", "interface I { a: string }", "interface I { a: number }"],
  ])("TS/JS: %s changes drift sig", async (_, before, after) => {
    const symbol = /class K/.test(before) && !/m\(\)/.test(before) ? "K" : /m\(/.test(before) ? "K.m" : (/(?:function|const|interface) (\w+)/.exec(before)?.[1] ?? "");
    const tiers = await moved(before.includes("FC") ? "a.tsx" : "a.ts", symbol, before, after);
    expect(tiers).toContain("sig");
  });

  it.each([
    ["annotation", "def f(a: int): pass", "def f(a: str): pass"],
    ["default", "def f(a=True): pass", "def f(a=False): pass"],
    ["keyword-only marker", "def f(a, *, b): pass", "def f(a, b): pass"],
    ["positional-only marker", "def f(a, /, b): pass", "def f(a, b): pass"],
    ["base class", "class K(Base): pass", "class K(Other): pass"],
    ["decorator argument", "@dataclass(frozen=True)\nclass K: pass", "@dataclass(frozen=False)\nclass K: pass"],
  ])("Python: %s changes drift sig", async (_, before, after) => {
    const symbol = before.includes("class K") ? "K" : "f";
    expect(await moved("a.py", symbol, before, after)).toContain("sig");
  });

  it.each([
    ["return type spacing", "def f() -> Dict[str, int]: pass", "def f() -> Dict[str,int]: pass"],
    ["black-wrapped return type", "def f() -> Dict[str, int]: pass", "def f() -> Dict[\n    str, int\n]: pass"],
    ["decorator spacing", "@lru_cache(maxsize=128)\ndef f(): pass", "@lru_cache(maxsize = 128)  # cached\ndef f(): pass"],
    ["trailing comma", "def f(a, b): pass", "def f(\n    a,\n    b,\n): pass"],
  ])("Python: reformatting (%s) moves nothing", async (_, before, after) => {
    expect(await moved("a.py", "f", before, after)).toEqual([]);
  });

  it.each([
    ["one-line destructuring", "export function P({\n  children,\n  store,\n}) { return children; }", "export function P({ children, store }) { return children; }"],
    ["multi-line return type", "export function f(): Promise<\n  number\n> { return g(); }", "export function f(): Promise<number> { return g(); }"],
  ])("TS: reformatting (%s) moves nothing", async (_, before, after) => {
    expect(await moved("a.ts", /function (\w+)/.exec(before)?.[1] ?? "", before, after)).toEqual([]);
  });
});

describe("a name defined more than once is every definition", () => {
  it("TS overloads: changing the first signature drifts sig", async () => {
    const impl = "export function f(a: any) { return a; }";
    expect(
      await moved(
        "a.ts",
        "f",
        `export function f(a: string): string;\n${impl}`,
        `export function f(a: string, b: number): string;\n${impl}`,
      ),
    ).toContain("sig");
  });

  it("a getter's return type is seen even though its setter comes last", async () => {
    const setter = "  @v.setter\n  def v(self, n): self._v = n\n";
    expect(
      await moved(
        "a.py",
        "K.v",
        `class K:\n  @property\n  def v(self) -> int: return 1\n${setter}`,
        `class K:\n  @property\n  def v(self) -> str: return 1\n${setter}`,
      ),
    ).toContain("sig");
  });

  it("Python @overload and a def in each branch of an if both count", async () => {
    const tail = "\ndef f(a): return a\n";
    expect(
      await moved("a.py", "f", `@overload\ndef f(a: int) -> int: ...${tail}`, `@overload\ndef f(a: str) -> int: ...${tail}`),
    ).toContain("sig");
    expect(
      await moved(
        "a.py",
        "g",
        "if WIN:\n  def g(): return 1\nelse:\n  def g(): return 2\n",
        "if WIN:\n  def g(): return 3\nelse:\n  def g(): return 2\n",
      ),
    ).toContain("body");
  });
});

describe("body aliases locals, and only locals", () => {
  it.each([
    ["callback parameter", "function f(xs) { return xs.map((item) => item.id); }", "function f(xs) { return xs.map((x) => x.id); }"],
    ["destructuring", "function f(o) { const { a: b } = o; return b; }", "function f(o) { const { a: c } = o; return c; }"],
    ["for...of", "function f(m) { for (const [k, v] of m) g(k, v); }", "function f(m) { for (const [a, b] of m) g(a, b); }"],
    ["catch", "function f() { try { g(); } catch (err) { h(err); } }", "function f() { try { g(); } catch (e) { h(e); } }"],
  ])("TS: renaming a %s binding moves nothing", async (_, before, after) => {
    expect(await moved("a.ts", "f", before, after)).toEqual([]);
  });

  it("TS: a property that shares a local's name isn't aliased", async () => {
    expect(
      await moved(
        "a.ts",
        "f",
        "function f(opts) { const timeout = opts.timeout; return timeout; }",
        "function f(opts) { const t = opts.timeout; return t; }",
      ),
    ).toEqual([]);
  });

  it.each([
    ["for a, b", "def f(x):\n  for k, v in x: g(k, v)", "def f(x):\n  for a, b in x: g(a, b)"],
    ["tuple assignment", "def f():\n  a, b = g()\n  return a", "def f():\n  c, d = g()\n  return c"],
    ["comprehension", "def f(z):\n  return [i for i in z]", "def f(z):\n  return [j for j in z]"],
    ["except as", "def f():\n  try: g()\n  except E as err: h(err)", "def f():\n  try: g()\n  except E as e: h(e)"],
    ["with as", "def f():\n  with g() as fh: h(fh)", "def f():\n  with g() as fp: h(fp)"],
    ["walrus", "def f():\n  if (n := g()): h(n)", "def f():\n  if (m := g()): h(m)"],
    ["docstring", 'def f():\n  """Old words."""\n  return 1', 'def f():\n  """New words."""\n  return 1'],
  ])("Python: changing a %s moves nothing", async (_, before, after) => {
    expect(await moved("a.py", "f", before, after)).toEqual([]);
  });

  it("Python: attribute and keyword names aren't locals", async () => {
    const before = "def f(req):\n  headers = req.headers\n  return dict(headers=headers)";
    expect(
      await moved("a.py", "f", before, "def f(req):\n  hs = req.headers\n  return dict(headers=hs)"),
    ).toEqual([]);
    expect(
      await moved("a.py", "f", before, "def f(req):\n  hs = req.hs\n  return dict(hs=hs)"),
    ).toContain("body");
  });
});

describe("deps names calls by structure", () => {
  it("reformatting a call chain or renaming a local argument moves nothing", async () => {
    expect(
      await moved("a.ts", "f", "function f(p) { return p.then((v) => g(v)).catch(() => 0); }", "function f(p) {\n  return p\n    .then((x) => g(x))\n    .catch(() => 0);\n}"),
    ).toEqual([]);
    expect(
      await moved("a.py", "f", "def f(client, url):\n  return client.get(url).json()", "def f(client, url):\n  return (\n    client.get(url)\n    .json()\n  )"),
    ).toEqual([]);
  });

  it("swapping the function called still moves deps", async () => {
    expect(await moved("a.ts", "f", "function f(x) { return g(x); }", "function f(x) { return h(x); }")).toContain("deps");
  });
});

describe("more declarations are addressable", () => {
  it.each([
    ["a.ts", "export function* gen() { yield 1; }", "gen"],
    ["a.ts", "class H { onError = (h: Handler) => { this.x = h; }; }", "H.onError"],
    ["a.tsx", "export const Button = memo(function Button(p: P) { return null; });", "Button"],
    ["a.tsx", "export const Input = forwardRef((p: P, ref) => null);", "Input"],
    ["a.js", "exports.send = function (body) { return body; };", "send"],
    ["a.js", "module.exports.json = function (obj) { return obj; };", "json"],
    ["a.js", "View.prototype.render = function render(opts, cb) { cb(); };", "View.render"],
    ["a.js", "app.use = function use(fn) { return this; };", "app.use"],
    ["a.ts", "export type Options = { retries: number };", "Options"],
    ["a.ts", "export enum Mode { A = 1, B = 2 }", "Mode"],
    ["a.ts", "namespace NA { export function helper() {} }\nnamespace NB { export function helper() {} }", "NA.helper"],
    ["a.d.ts", "export declare function d(x: number): void;", "d"],
    ["a.pyi", "def stub(a: int) -> str: ...", "stub"],
  ])("%s: %s → %s", async (path, src, symbol) => {
    await fps(path, src, symbol);
  });

  it("a type alias's whole body is its signature", async () => {
    expect(
      await moved("a.ts", "Options", "type Options = { retries: number };", "type Options = { retries: string };"),
    ).toContain("sig");
  });
});

describe("anchors stamped by fingerprint version 1", () => {
  async function v1Repo() {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-fpv-"));
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "a.ts"), "export function f(a: string): number { return g(a); }\n");
    await writeFile(join(dir, "A.md"), "<!-- lockwire a.ts#f -->\nf takes a string.\n");
    await linkDoc(dir, "A.md", DEFAULT_CONFIG, { type: "human" });
    // Rewrite the anchor as version 1 stamped it: v1 fingerprints, no version field.
    const lock = await readLockfile(dir);
    const v1 = await resolveTargetInText({ path: "a.ts", symbol: "f" }, await readFile(join(dir, "a.ts"), "utf8"), DEFAULT_CONFIG, 1);
    await writeLockfile(dir, {
      ...lock,
      anchors: lock.anchors.map(({ fingerprintVersion: _, ...a }) => ({ ...a, fingerprints: v1.fingerprints })),
    });
    return dir;
  }

  it("check: unchanged code is fresh, and the anchor is quietly re-stamped as the current version", async () => {
    const dir = await v1Repo();
    const result = await check(dir, DEFAULT_CONFIG);
    expect(result.summary).toMatchObject({ fresh: 1, drifted: 0 });
    expect((await readLockfile(dir)).anchors[0]?.fingerprintVersion).toBe(FINGERPRINT_VERSION);
    // ...and from then on a type change, which version 1 couldn't see, is drift.
    await writeFile(join(dir, "a.ts"), "export function f(a: number): number { return g(a); }\n");
    expect((await check(dir, DEFAULT_CONFIG)).summary.drifted).toBe(1);
  });

  it("check: what version 1 saw as drift is still drift", async () => {
    const dir = await v1Repo();
    await writeFile(join(dir, "a.ts"), "export function f(a: string, b: string): number { return g(a); }\n");
    expect((await check(dir, DEFAULT_CONFIG)).summary.drifted).toBe(1);
    expect((await readLockfile(dir)).anchors[0]?.fingerprintVersion).toBeUndefined();
  });

  it("link: an unchanged version-1 anchor re-stamps without --reviewed", async () => {
    const dir = await v1Repo();
    expect((await linkDoc(dir, "A.md", DEFAULT_CONFIG, { type: "human" })).refreshed).toBe(1);
    expect((await readLockfile(dir)).anchors[0]?.fingerprintVersion).toBe(FINGERPRINT_VERSION);
  });
});

describe("version 1 is frozen", () => {
  it("still computes exactly what anchors stamped with it hold", async () => {
    // Fingerprints from a lockfile stamped by lockwire 0.1.28 (version 1) for this source.
    const src = "export function helper(a: number): number {\n  return a + 1;\n}\n";
    const v1 = await resolveTargetInText({ path: "a.ts", symbol: "helper" }, src, DEFAULT_CONFIG, 1);
    const { parserFor } = await import("../src/grammar.js");
    const { extractFileSymbols } = await import("../src/extract.js");
    const tree = (await parserFor("typescript")).parse(src);
    if (!tree) throw new Error("parse failed");
    expect(extractFileSymbols(tree.rootNode, "typescript", true, 1).bySymbolPath.get("helper")?.sigTokens).toBe(
      "fn helper(a:T)->number [export]",
    );
    tree.delete();
    expect(v1.fingerprints.sig).not.toBe((await fps("a.ts", src, "helper")).sig);
  });
});
