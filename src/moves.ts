/**
 * Cross-file moves: a bound symbol that is gone from its file (or whose code there changed) may have
 * moved, unchanged, to another one. This finds where its code as stamped lives now, so `check` can say
 * so and `lockwire repoint` can re-point the claim in one step instead of by hand.
 *
 * "The same code" means the symbol's normalized body hashes as stamped, so comments, formatting and
 * local names don't matter, but any change to what it does does. A symbol with no body to compare (an
 * interface, a type alias) must match on its signature instead. The search reads every source file once
 * per run, parses only the files that declare the symbol (or its class), and gives up at a deadline rather
 * than hold a hook up: an unfinished search names no new home, since the one it missed could be another.
 */
import { readFile } from "node:fs/promises";
import { fileAtCommit } from "./changed.js";
import { langForPath } from "./grammar.js";
import { fingerprint, fingerprintSet } from "./hash.js";
import { resolveInsideRepo, walkFilesWithin } from "./repo.js";
import type { Anchor, AnchorTarget, FileSymbols, Fingerprints, LockwireConfig } from "./types.js";
import { dataFormatOf } from "./values.js";

export interface MoveHint {
  /** The one place the code as stamped lives now, when there is exactly one. */
  to?: AnchorTarget;
  /** Every place it was found (more than one means lockwire can't tell which is the claim's). */
  candidates: AnchorTarget[];
}

/**
 * `body` fingerprints that say nothing about a symbol: none at all (a type, an overload signature) or an
 * empty block (`{}`). Two functions with the same parameters "match" on these without being related.
 */
const NO_BODY = new Set([fingerprint(""), fingerprint("{ }")]);
export const isTrivialBody = (bodyFingerprint: string) =>
  bodyFingerprint === "" || NO_BODY.has(bodyFingerprint);
/** The `deps` of a symbol that calls nothing: likewise no evidence. */
export const NO_DEPS = fingerprintSet([]);

/**
 * A signature's fingerprints with the `export` modifier as written, removed and added: moving a
 * private helper into a module of its own usually means exporting it, and that is part of the move,
 * not a change to the contract a claim describes.
 */
export function sigFingerprints(sig: string): Set<string> {
  const out = new Set([fingerprint(sig)]);
  const tail = / \[([^[\]]*)\]$/;
  const lines = sig.split("\n");
  if (!lines.every((l) => tail.test(l))) return out;
  const rewrite = (withExport: boolean) =>
    lines
      .map((l) =>
        l.replace(tail, (_, mods: string) => {
          const set = new Set(mods ? mods.split(",") : []);
          if (withExport) set.add("export");
          else set.delete("export");
          return ` [${[...set].sort().join(",")}]`;
        }),
      )
      .join("\n");
  out.add(fingerprint(rewrite(false)));
  out.add(fingerprint(rewrite(true)));
  return out;
}

interface IndexedSymbol {
  path: string;
  symbol: string;
  body: string;
  sigs: Set<string>;
}

export type SymbolsOf = (
  path: string,
  content: string,
  version: number,
) => Promise<FileSymbols | null>;

/** Files over this size (minified bundles, generated code) are neither indexed nor parsed. */
const MAX_FILE_CHARS = 2_000_000;

const PY_DECL = /\b(?:def|class)\s+([A-Za-z_]\w*)/g;
/**
 * The ways a TS/JS symbol is declared, for finding the files that might define one: a declaration
 * keyword, a method or field at the start of a line (modifiers allowed), and `x.name = …` for CommonJS
 * exports and prototype methods. It only narrows what is parsed, so it errs towards matching too much.
 */
const JS_DECL = [
  /\b(?:function\*?|class|interface|type|enum|namespace|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /^[ \t]*(?:(?:public|private|protected|static|async|readonly|abstract|override|declare|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*[(<=:?!]/gm,
  /\.([A-Za-z_$][\w$]*)\s*=[^=]/g,
];

/** The names a source file declares (see {@link JS_DECL}), for the index. */
function declaredNames(path: string, content: string): Set<string> {
  const names = new Set<string>();
  for (const re of langForPath(path) === "python" ? [PY_DECL] : JS_DECL) {
    re.lastIndex = 0;
    for (let m = re.exec(content); m; m = re.exec(content)) if (m[1]) names.add(m[1]);
  }
  return names;
}

/**
 * The repository's source files for one run: read once into an index of the names each one declares
 * (not their text, which in a big repository is more than is worth holding), and parsed on demand,
 * only the files that declare the name being looked for. A name every file uses (`get`) is declared
 * in far fewer.
 */
export class SourceIndex {
  private byName: Map<string, string[]> | null = null;
  private complete = true;
  private readonly parsed = new Map<string, IndexedSymbol[]>();

  constructor(
    private readonly repoRoot: string,
    private readonly config: LockwireConfig,
    private readonly symbolsOf: SymbolsOf,
    /** A `Date.now()` timestamp to stop at. */
    private readonly deadline: number = Number.POSITIVE_INFINITY,
  ) {}

  private async load(): Promise<Map<string, string[]>> {
    if (this.byName) return this.byName;
    const byName = new Map<string, string[]>();
    const walk = walkFilesWithin(this.repoRoot, this.config.exclude, this.deadline, {
      skipSymlinks: true,
    });
    this.complete = walk.complete;
    for (const rel of walk.files) {
      if (!langForPath(rel)) continue;
      if (Date.now() > this.deadline) {
        this.complete = false;
        break;
      }
      const content = await this.read(rel);
      if (content === null || content.length > MAX_FILE_CHARS) continue;
      for (const id of declaredNames(rel, content)) {
        const list = byName.get(id);
        if (list) list.push(rel);
        else byName.set(id, [rel]);
      }
    }
    this.byName = byName;
    return byName;
  }

  private async read(rel: string): Promise<string | null> {
    const abs = resolveInsideRepo(this.repoRoot, rel);
    if (!abs) return null;
    try {
      return await readFile(abs, "utf8");
    } catch {
      return null; // unreadable: it can't be where the code went
    }
  }

  private async symbolsIn(path: string, version: number) {
    const key = `${version}|${path}`;
    const hit = this.parsed.get(key);
    if (hit) return hit;
    let symbols: FileSymbols | null = null;
    try {
      const content = await this.read(path);
      if (content !== null) symbols = await this.symbolsOf(path, content, version);
    } catch {
      // a file that doesn't parse has no symbols to offer
    }
    const list: IndexedSymbol[] = [];
    for (const [symbol, s] of symbols?.bySymbolPath ?? [])
      list.push({
        path,
        symbol,
        body: fingerprint(s.bodyNormalized),
        sigs: sigFingerprints(s.sigTokens),
      });
    this.parsed.set(key, list);
    return list;
  }

  /** Whether `s`'s file already held this code, under the same name, at `commit`. */
  private async existedAt(
    commit: string,
    s: IndexedSymbol,
    stamped: Pick<Fingerprints, "body" | "sig">,
    trivialBody: boolean,
    version: number,
  ): Promise<boolean> {
    const text = fileAtCommit(this.repoRoot, commit, s.path);
    if (text === null) return false;
    try {
      const before = (await this.symbolsOf(s.path, text, version))?.bySymbolPath.get(s.symbol);
      if (!before) return false;
      return trivialBody
        ? sigFingerprints(before.sigTokens).has(stamped.sig)
        : fingerprint(before.bodyNormalized) === stamped.body;
    } catch {
      return false;
    }
  }

  /**
   * Where `anchor`'s symbol, as stamped, lives now outside `anchor.target.path`, or null when nowhere
   * (or when the search ran out of time before it could be sure).
   */
  async findMove(
    anchor: Anchor,
    version: number,
    /** `path#symbol`s other claims are bound to: that code is theirs, not where this claim's went. */
    taken: ReadonlySet<string> = new Set(),
  ): Promise<MoveHint | null> {
    const { path, symbol } = anchor.target;
    if (!symbol || dataFormatOf(path) || !langForPath(path)) return null;
    // A method is found through its class, under the same dotted path (`Client.get` in another file):
    // a class that moved takes its methods along, while a method of the same name and body in some
    // other class (`__init__` in hundreds of them) isn't where this one went.
    const head = symbol.slice(0, symbol.indexOf(".") < 0 ? undefined : symbol.indexOf("."));
    const stamped: Pick<Fingerprints, "body" | "sig"> = anchor.fingerprints;
    const trivialBody = isTrivialBody(stamped.body);
    const python = langForPath(path) === "python";

    const files = (await this.load()).get(head) ?? [];
    // An unfinished search can't tell "in one place" from "in one of the places it got to".
    if (!this.complete) return null;
    const found: IndexedSymbol[] = [];
    for (const file of files) {
      if (file === path) continue;
      // Code doesn't move between Python and the TS/JS family: the fingerprints can't agree anyway.
      if ((langForPath(file) === "python") !== python) continue;
      if (Date.now() > this.deadline) return null;
      for (const s of await this.symbolsIn(file, version)) {
        if (s.symbol !== symbol || taken.has(`${s.path}#${s.symbol}`)) continue;
        const sigMatches = s.sigs.has(stamped.sig);
        if (trivialBody ? sigMatches : s.body === stamped.body) found.push(s);
      }
    }
    // Code that was already in that file when the claim was stamped is a twin that was always there, not
    // where this claim's code went (two copies of a helper, one of them deleted).
    const stampedAt = anchor.linked.commit;
    if (stampedAt && found.length > 0) {
      const fresh: IndexedSymbol[] = [];
      for (const s of found)
        if (!(await this.existedAt(stampedAt, s, stamped, trivialBody, version))) fresh.push(s);
      found.splice(0, found.length, ...fresh);
    }
    if (found.length === 0) return null;

    const candidates = found.map((s) => ({ path: s.path, symbol: s.symbol }));
    // Several copies of the same code: prefer the one whose signature also matches.
    let best = found;
    for (const narrow of [(s: IndexedSymbol) => s.sigs.has(stamped.sig)]) {
      if (best.length <= 1) break;
      const fewer = best.filter(narrow);
      if (fewer.length > 0) best = fewer;
    }
    const only = best.length === 1 ? best[0] : undefined;
    return { ...(only ? { to: { path: only.path, symbol: only.symbol } } : {}), candidates };
  }
}
