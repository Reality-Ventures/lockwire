/**
 * Cross-file moves: a bound symbol that is gone from its file (or whose code there changed) may have
 * moved, unchanged, to another one. This finds where its code as stamped lives now, so `check` can say
 * so and `lockwire repoint` can re-point the claim in one step instead of by hand.
 *
 * "The same code" means the symbol's normalized body hashes as stamped, so comments, formatting and
 * local names don't matter, but any change to what it does does. A symbol with no body to compare (an
 * interface, a type alias) must match on its signature instead. The search reads every source file once
 * per run, parses only the files that mention the symbol's name, and gives up at a deadline rather
 * than hold a hook up: an unfinished search names no new home, since the one it missed could be another.
 */
import { readFile } from "node:fs/promises";
import { langForPath } from "./grammar.js";
import { fingerprint } from "./hash.js";
import { resolveInsideRepo, walkFilesWithin } from "./repo.js";
import { dataFormatOf } from "./values.js";
const EMPTY_BODY = fingerprint("");
/**
 * A signature's fingerprints with the `export` modifier as written, removed and added: moving a
 * private helper into a module of its own usually means exporting it, and that is part of the move,
 * not a change to the contract a claim describes.
 */
export function sigFingerprints(sig) {
    const out = new Set([fingerprint(sig)]);
    const tail = / \[([^[\]]*)\]$/;
    const lines = sig.split("\n");
    if (!lines.every((l) => tail.test(l)))
        return out;
    const rewrite = (withExport) => lines
        .map((l) => l.replace(tail, (_, mods) => {
        const set = new Set(mods ? mods.split(",") : []);
        if (withExport)
            set.add("export");
        else
            set.delete("export");
        return ` [${[...set].sort().join(",")}]`;
    }))
        .join("\n");
    out.add(fingerprint(rewrite(false)));
    out.add(fingerprint(rewrite(true)));
    return out;
}
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
/**
 * The repository's source files for one run: read once into an index of the identifiers each one
 * contains (not their text, which in a big repository is more than is worth holding), and parsed on
 * demand, only where the name being looked for appears.
 */
export class SourceIndex {
    repoRoot;
    config;
    symbolsOf;
    deadline;
    byName = null;
    complete = true;
    parsed = new Map();
    constructor(repoRoot, config, symbolsOf, 
    /** A `Date.now()` timestamp to stop at. */
    deadline = Number.POSITIVE_INFINITY) {
        this.repoRoot = repoRoot;
        this.config = config;
        this.symbolsOf = symbolsOf;
        this.deadline = deadline;
    }
    async load() {
        if (this.byName)
            return this.byName;
        const byName = new Map();
        const walk = walkFilesWithin(this.repoRoot, this.config.exclude, this.deadline, {
            skipSymlinks: true,
        });
        this.complete = walk.complete;
        for (const rel of walk.files) {
            if (!langForPath(rel))
                continue;
            if (Date.now() > this.deadline) {
                this.complete = false;
                break;
            }
            const content = await this.read(rel);
            if (content === null)
                continue;
            for (const id of new Set(content.match(IDENTIFIER))) {
                const list = byName.get(id);
                if (list)
                    list.push(rel);
                else
                    byName.set(id, [rel]);
            }
        }
        this.byName = byName;
        return byName;
    }
    async read(rel) {
        const abs = resolveInsideRepo(this.repoRoot, rel);
        if (!abs)
            return null;
        try {
            return await readFile(abs, "utf8");
        }
        catch {
            return null; // unreadable: it can't be where the code went
        }
    }
    async symbolsIn(path, version) {
        const key = `${version}|${path}`;
        const hit = this.parsed.get(key);
        if (hit)
            return hit;
        let symbols = null;
        try {
            const content = await this.read(path);
            if (content !== null)
                symbols = await this.symbolsOf(path, content, version);
        }
        catch {
            // a file that doesn't parse has no symbols to offer
        }
        const list = [];
        for (const [symbol, s] of symbols?.bySymbolPath ?? [])
            list.push({
                path,
                symbol,
                name: s.name,
                body: fingerprint(s.bodyNormalized),
                sigs: sigFingerprints(s.sigTokens),
            });
        this.parsed.set(key, list);
        return list;
    }
    /**
     * Where `anchor`'s symbol, as stamped, lives now outside `anchor.target.path`, or null when nowhere
     * (or when the search ran out of time before it could be sure).
     */
    async findMove(anchor, version) {
        const { path, symbol } = anchor.target;
        if (!symbol || dataFormatOf(path) || !langForPath(path))
            return null;
        const name = symbol.slice(symbol.lastIndexOf(".") + 1);
        const stamped = anchor.fingerprints;
        const trivialBody = stamped.body === EMPTY_BODY || stamped.body === "";
        const python = langForPath(path) === "python";
        const files = (await this.load()).get(name) ?? [];
        // An unfinished search can't tell "in one place" from "in one of the places it got to".
        if (!this.complete)
            return null;
        const found = [];
        for (const file of files) {
            if (file === path)
                continue;
            // Code doesn't move between Python and the TS/JS family: the fingerprints can't agree anyway.
            if ((langForPath(file) === "python") !== python)
                continue;
            if (Date.now() > this.deadline)
                return null;
            for (const s of await this.symbolsIn(file, version)) {
                if (s.name !== name)
                    continue;
                const sigMatches = s.sigs.has(stamped.sig);
                if (trivialBody ? sigMatches : s.body === stamped.body)
                    found.push(s);
            }
        }
        if (found.length === 0)
            return null;
        const candidates = found.map((s) => ({ path: s.path, symbol: s.symbol }));
        // Several copies of the same code: prefer the one whose signature also matches, then the one
        // under the same dotted path (`Client.get`, not `Other.get`).
        let best = found;
        for (const narrow of [
            (s) => s.sigs.has(stamped.sig),
            (s) => s.symbol === symbol,
        ]) {
            if (best.length <= 1)
                break;
            const fewer = best.filter(narrow);
            if (fewer.length > 0)
                best = fewer;
        }
        const only = best.length === 1 ? best[0] : undefined;
        return { ...(only ? { to: { path: only.path, symbol: only.symbol } } : {}), candidates };
    }
}
//# sourceMappingURL=moves.js.map