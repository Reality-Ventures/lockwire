import { execFileSync } from "node:child_process";
import { toPosix } from "./repo.js";

export interface ChangedOptions {
  /** Ref to diff against. Defaults to GITHUB_BASE_REF in Actions, then the repo's default branch. */
  base?: string;
  /** Only what's staged for the next commit (for a pre-commit hook). */
  staged?: boolean;
}

type Git = (args: string[]) => string;

function gitRunner(repoRoot: string): Git {
  return (args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
}

const lines = (out: string) =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(toPosix);

function tryGit(git: Git, args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/** The ref this branch should be compared against, or throws saying how to name one. */
export function resolveBase(
  git: Git,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  else {
    if (env.GITHUB_BASE_REF) candidates.push(`origin/${env.GITHUB_BASE_REF}`, env.GITHUB_BASE_REF);
    const head = tryGit(git, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (head) candidates.push(head.trim().replace(/^refs\/remotes\//, ""));
    candidates.push("origin/main", "origin/master", "main", "master");
  }
  for (const ref of candidates) {
    if (tryGit(git, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null) return ref;
  }
  throw new Error(
    explicit
      ? `--base ${explicit}: git can't find that ref. In CI, fetch it first (actions/checkout with fetch-depth: 0).`
      : "--changed couldn't find a base branch to compare against (tried origin/HEAD, origin/main, origin/master, main, master). Pass --base <ref>; in CI, fetch history first (actions/checkout with fetch-depth: 0).",
  );
}

/**
 * Repo-relative posix paths of files this branch changes. Both sides of a rename are listed (`--no-renames`),
 * so an anchor on a file that was moved away is still examined and reports as orphaned.
 */
export function changedFiles(repoRoot: string, opts: ChangedOptions = {}): string[] {
  const git = gitRunner(repoRoot);
  if (tryGit(git, ["rev-parse", "--is-inside-work-tree"]) === null)
    throw new Error("--changed/--staged need a git repository.");

  if (opts.staged)
    return lines(git(["diff", "--cached", "--name-only", "--no-renames", "--relative"]));

  const base = resolveBase(git, opts.base);
  const mergeBase = tryGit(git, ["merge-base", base, "HEAD"])?.trim();
  if (!mergeBase)
    throw new Error(
      `no common history between ${base} and HEAD. In CI, fetch full history (actions/checkout with fetch-depth: 0).`,
    );

  // Committed on the branch + uncommitted changes to tracked files, in one diff against the merge
  // base, plus files git hasn't seen yet.
  const tracked = lines(git(["diff", "--name-only", "--no-renames", "--relative", mergeBase]));
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

/**
 * Short SHA of HEAD in `repoRoot`, or null outside a git repo / before the first commit. Deliberately
 * not cached: a long-lived process (the MCP server) outlives many commits.
 */
export function headCommit(repoRoot: string): string | null {
  return tryGit(gitRunner(repoRoot), ["rev-parse", "--short", "HEAD"])?.trim() || null;
}

/**
 * The git index, path by path (`<mode> <object> <stage>`), or null outside a git repository. A run that
 * only stages a file still changes what the next `git commit` records, so autofix compares this too.
 */
export function indexEntries(repoRoot: string): Map<string, string> | null {
  const out = tryGit(gitRunner(repoRoot), ["ls-files", "--stage", "-z"]);
  if (out === null) return null;
  const entries = new Map<string, string>();
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab > 0) entries.set(toPosix(entry.slice(tab + 1)), entry.slice(0, tab));
  }
  return entries;
}

/**
 * A file's text at `commit`, read from git, or null if git, the commit or the file isn't there.
 * `commit` comes from the lockfile, which anyone can edit, so only a plain hex object name is passed
 * to git (anything else could be read as an option); `path` must already be contained in the repo.
 */
export function fileAtCommit(repoRoot: string, commit: string, path: string): string | null {
  if (!/^[0-9a-f]{4,64}$/i.test(commit)) return null;
  return tryGit(gitRunner(repoRoot), ["show", `${commit}:./${path}`]);
}

/**
 * Commits that changed `path`: those after `from` (exclusive) when given and known, oldest first —
 * the stamped version is usually committed soon after — otherwise all of them, newest first (the
 * stamped version is usually recent). Capped, since each one is read and parsed.
 */
export function commitsTouching(
  repoRoot: string,
  path: string,
  from: string | null,
  limit = 200,
): string[] {
  const git = gitRunner(repoRoot);
  const known =
    from !== null &&
    /^[0-9a-f]{4,64}$/i.test(from) &&
    tryGit(git, ["cat-file", "-e", `${from}^{commit}`]) !== null;
  const out = known
    ? tryGit(git, ["rev-list", "--reverse", `${from}..HEAD`, "--", `./${path}`])
    : tryGit(git, ["rev-list", "HEAD", "--", `./${path}`]);
  return out ? lines(out).slice(0, limit) : [];
}
