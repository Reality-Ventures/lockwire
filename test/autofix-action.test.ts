import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACTION = readFileSync(join(ROOT, "autofix", "action.yml"), "utf8");
const OPEN_PR = join(ROOT, "autofix", "open-pr.sh");
const posix = process.platform !== "win32";

describe("autofix/action.yml", () => {
  /** The `run: |` blocks, as text. */
  const runBlocks = () => {
    const out: string[] = [];
    const lines = ACTION.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)run: \|\s*$/.exec(lines[i] ?? "") ?? /^(\s*)run: (.+)$/.exec(lines[i] ?? "");
      if (!m) continue;
      if (m[2] !== undefined && !m[2].startsWith("|")) {
        out.push(m[2]);
        continue;
      }
      const indent = (m[1] ?? "").length;
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (l.trim() !== "" && l.search(/\S/) <= indent) break;
        body.push(l);
      }
      out.push(body.join("\n"));
    }
    return out;
  };

  it("never interpolates an expression into a shell script (inputs reach scripts only through env)", () => {
    const blocks = runBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const b of blocks) expect(b, b.slice(0, 80)).not.toMatch(/\$\{\{/);
  });

  it("every input it reads is declared, and every declared input is used", () => {
    const inputsSection = ACTION.slice(ACTION.indexOf("\ninputs:"), ACTION.indexOf("\noutputs:"));
    const declared = [...inputsSection.matchAll(/^ {2}([a-z][a-z0-9-]*):\n {4}description:/gm)].map((m) => m[1]);
    const used = new Set([...ACTION.matchAll(/inputs\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
    expect(declared.length).toBeGreaterThan(5);
    for (const u of used) expect(declared, `inputs.${u}`).toContain(u);
    for (const d of declared) expect(used.has(d), `input ${d} is never used`).toBe(true);
  });

  it("gives the agent's API keys only to the step that runs the agent", () => {
    const steps = ACTION.split(/\n {4}- /).slice(1);
    const withKeys = steps.filter((s) => /ANTHROPIC_API_KEY|CODEX_API_KEY/.test(s));
    expect(withKeys).toHaveLength(1);
    expect(withKeys[0]).toMatch(/id: autofix/);
  });
});

describe.skipIf(!posix)("autofix/open-pr.sh", () => {
  /** A repo with a bare origin, a docs change from "autofix", and a fake `gh` that records its calls. */
  async function setup(report: object, { trackLedger = true } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-openpr-"));
    const origin = join(dir, "origin.git");
    const work = join(dir, "work");
    const bin = join(dir, "bin");
    const git = (cwd: string, ...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", stdio: "pipe" });
    await mkdir(origin);
    git(origin, "init", "-q", "--bare", "-b", "main");
    await mkdir(work);
    git(work, "init", "-q", "-b", "main");
    await writeFile(join(work, "CLAUDE.md"), "# A\n\nold claim.\n", "utf8");
    await writeFile(join(work, "lockwire.lock"), '{"version":1,"anchors":[]}\n', "utf8");
    await mkdir(join(work, ".lockwire"));
    if (trackLedger) await writeFile(join(work, ".lockwire", "ledger.jsonl"), "", "utf8");
    await writeFile(join(work, "untracked-scratch.txt"), "not part of the fix", "utf8");
    git(work, "add", "CLAUDE.md", "lockwire.lock", ...(trackLedger ? [".lockwire/ledger.jsonl"] : []));
    git(work, "commit", "-qm", "base");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    // what autofix did:
    await writeFile(join(work, "CLAUDE.md"), "# A\n\nnew claim.\n", "utf8");
    await writeFile(join(work, "lockwire.lock"), '{"version":1,"anchors":[{"id":"x"}]}\n', "utf8");
    await writeFile(join(work, ".lockwire", "ledger.jsonl"), '{"event":"anchor.resolved"}\n', "utf8");
    await writeFile(join(dir, "report.json"), JSON.stringify(report), "utf8");
    await writeFile(join(dir, "summary.md"), "## lockwire autofix: 1 of 1 fixed\n", "utf8");
    // fake gh: records argv; `pr list` prints whatever $FAKE_GH_EXISTING holds; `pr create` prints a URL
    await mkdir(bin);
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(dir, "gh.log")}"\nif [ "$1 $2" = "pr list" ]; then echo "\${FAKE_GH_EXISTING:-}"; fi\nif [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/7"; fi\n`,
      "utf8",
    );
    chmodSync(join(bin, "gh"), 0o755);
    const run = (env: Record<string, string> = {}) =>
      spawnSync("bash", [OPEN_PR], {
        cwd: work,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          LW_REPORT: join(dir, "report.json"),
          LW_SUMMARY: join(dir, "summary.md"),
          LW_BRANCH: "lockwire/autofix",
          LW_BASE: "main",
          GITHUB_OUTPUT: join(dir, "outputs"),
          ...env,
        },
      });
    return { dir, work, origin, run, git, ghLog: () => (existsSync(join(dir, "gh.log")) ? readFileSync(join(dir, "gh.log"), "utf8") : "") };
  }
  const fixedReport = { status: "fixed", before: [{}], after: [], changedFiles: ["CLAUDE.md", "lockwire.lock"], outOfBounds: [] };

  it("pushes a branch with exactly the fixed files and lockwire's own, and opens a pull request", async () => {
    const s = await setup(fixedReport);
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    const files = s.git(s.origin, "show", "--name-only", "--format=", "lockwire/autofix").trim().split("\n").sort();
    expect(files).toEqual([".lockwire/ledger.jsonl", "CLAUDE.md", "lockwire.lock"]);
    expect(s.git(s.origin, "log", "-1", "--format=%s", "lockwire/autofix").trim()).toBe("docs: lockwire autofix (1 claim)");
    expect(s.ghLog()).toMatch(/^pr create --head lockwire\/autofix --base main --title docs: lockwire autofix \(1 claim\) --body-file /m);
    expect(await readFile(join(s.dir, "outputs"), "utf8")).toContain("pull-request=https://github.com/o/r/pull/7");
    expect(s.git(s.origin, "show", "lockwire/autofix:CLAUDE.md")).toContain("new claim.");
  });

  it("a re-run updates the open pull request instead of opening another", async () => {
    const s = await setup(fixedReport);
    const r = s.run({ FAKE_GH_EXISTING: "https://github.com/o/r/pull/7" });
    expect(r.status, r.stderr).toBe(0);
    expect(s.ghLog()).toMatch(/^pr edit https:\/\/github\.com\/o\/r\/pull\/7 /m);
    expect(s.ghLog()).not.toMatch(/pr create/);
  });

  it.each(["refused", "nothing-to-do"])("a %s run opens no pull request and pushes nothing", async (status) => {
    const s = await setup({ ...fixedReport, status });
    const r = s.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`lockwire autofix: ${status}, so no pull request`);
    expect(s.ghLog()).toBe("");
    expect(s.git(s.origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim()).toBe("main");
  });

  it("commits a ledger that isn't tracked yet (a first run creates it)", async () => {
    const s = await setup(fixedReport, { trackLedger: false });
    expect(s.run().status).toBe(0);
    const files = s.git(s.origin, "show", "--name-only", "--format=", "lockwire/autofix").trim().split("\n");
    expect(files).toContain(".lockwire/ledger.jsonl");
  });

  it("commits only the listed files, even with something else already staged, and runs no git hook", async () => {
    const s = await setup(fixedReport);
    await writeFile(join(s.work, "staged.ts"), "export const sneaky = 1;\n", "utf8");
    s.git(s.work, "add", "staged.ts");
    // pre-commit is skipped by --no-verify; post-commit isn't, so it pins core.hooksPath too
    for (const name of ["pre-commit", "post-commit"]) {
      const hook = join(s.work, ".git", "hooks", name);
      await writeFile(hook, `#!/bin/sh\ntouch "${join(s.dir, "hook-ran")}"\n`, "utf8");
      chmodSync(hook, 0o755);
    }
    const r = s.run();
    expect(r.status, r.stderr).toBe(0);
    const files = s.git(s.origin, "show", "--name-only", "--format=", "lockwire/autofix").trim().split("\n");
    expect(files).not.toContain("staged.ts");
    expect(existsSync(join(s.dir, "hook-ran"))).toBe(false);
  });

  it("titles the pull request with the report's count of claims fixed", async () => {
    const s = await setup({ ...fixedReport, before: [{}, {}], after: [{}, {}], fixed: 1 });
    expect(s.run().status).toBe(0);
    expect(s.git(s.origin, "log", "-1", "--format=%s", "lockwire/autofix").trim()).toBe("docs: lockwire autofix (1 claim)");
  });

  it("never commits a file the report flagged as out of bounds", async () => {
    const s = await setup({ ...fixedReport, status: "partial", changedFiles: ["CLAUDE.md", "src/a.ts"], outOfBounds: ["src/a.ts"] });
    await mkdir(join(s.work, "src"));
    await writeFile(join(s.work, "src", "a.ts"), "changed by the agent", "utf8");
    expect(s.run().status).toBe(0);
    const files = s.git(s.origin, "show", "--name-only", "--format=", "lockwire/autofix").trim().split("\n");
    expect(files).not.toContain("src/a.ts");
    expect(files).not.toContain("untracked-scratch.txt");
  });
});
