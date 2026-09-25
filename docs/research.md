# Research

The evidence this design is built on, and what each source actually changed about it. Full citations, not just links, because half the value of a claims-verification tool is not making unverifiable claims about itself.

## Wrong documentation is worse than missing documentation

Macke, W. & Doyle, M. (2024). *Testing the Effect of Code Documentation on Large Language Model Code Understanding.* NAACL 2024 Findings. [arXiv:2404.03114](https://arxiv.org/abs/2404.03114)

Providing an LLM with incorrect documentation "can greatly hinder" its ability to understand code, while incomplete or missing documentation "does not seem to significantly affect" it. This is the core argument for lockwire existing at all: the risk isn't an empty `CLAUDE.md`, it's a confidently wrong one. A stale claim an agent trusts is actively worse than no claim.

## Context files are configuration that evolves, not documentation that's written once

*Agent READMEs: An Empirical Study of Context Files for Agentic Coding.* (2026). [arXiv:2511.12884](https://arxiv.org/abs/2511.12884)

2,303 context files across 1,925 repositories (922 `CLAUDE.md`, 694 `AGENTS.md`, 687 `copilot-instructions.md`). Files evolve through frequent small additions — `CLAUDE.md` averages 57 words added per commit, with a median of under 15 words deleted, and a median gap of 24.1 hours between edits. Conclusion: these files behave like evolving configuration, not static prose. This is why lockwire binds a claim to a fingerprint instead of a version number or a "last reviewed" date — a file this actively edited needs continuous, automatic re-checking, not a periodic audit.

## Longer or more-present context files don't reliably help — and that's not the problem lockwire solves

*Do Context Files Help Coding Agents? A Two-Agent Ablation Study on Real Repositories.* (2026). [arXiv:2607.27250](https://arxiv.org/abs/2607.27250)

Gloaguen et al. *Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?* ETH Zurich SRI Lab (2026).

288 runs across Claude Code and Codex, 17 real tasks: no statistically significant correctness improvement from having a context file present versus absent. Separately, LLM-generated context files reduced task success by roughly 3% and raised inference cost over 20%. Read correctly, this doesn't argue against context files — it argues that *volume* isn't the lever. lockwire doesn't try to make context files longer or more present; it tries to make the parts that are there stop being wrong.

## File structure doesn't move the needle either — truth does

*Instruction Adherence in Coding Agent Configuration Files: A Factorial Study of Four File-Structure Variables.* (2026). [arXiv:2605.10039](https://arxiv.org/abs/2605.10039)

Tested file size, instruction position, file architecture, and contradictions between adjacent files. None produced a statistically detectable effect on adherence after correction. The strongest measurable effect in the whole study was unrelated to structure: each additional function generated in a session reduced compliance odds by about 5.6%. Combined with the previous finding, this rules out "reorganize your `CLAUDE.md`" and "make it shorter" as the fix, and points back at correctness as the actual lever — which is what lockwire targets.

## Agent-authored doc changes get less scrutiny than human ones

*Who Writes the Docs in SE 3.0? Agent vs. Human Documentation Pull Requests.* (2026). [arXiv:2601.20171](https://arxiv.org/abs/2601.20171)

1,997 documentation PRs: agents submit substantially more doc PRs than humans in the studied repositories, and agent-authored documentation edits are "typically integrated with little follow-up modification from humans" — i.e., less review, not more, despite being a plausible-sounding, confidently-worded new source of potential error. This is the provenance argument for the ledger: every lockwire event records whether the actor was human, AI, mixed, or unknown (via [Agent Trace](https://agent-trace.dev/)), so "who wrote this claim, and did anyone check it" is answerable later even when it wasn't scrutinized at the time.

## Outdated code references are common and quietly persistent

Tan, W. S., Wagner, M., & Treude, C. (2024). *Detecting Outdated Code Element References in Software Repository Documentation.* Empirical Software Engineering. [arXiv:2212.01479](https://arxiv.org/abs/2212.01479)

Across more than 3,000 GitHub projects, over a quarter of the 1,000 most popular contained at least one outdated code element reference at some point. Consistent with the pattern lockwire is built around: staleness accumulates silently and nobody notices until it's pointed out.

## Documentation goes stale silently, and "up-to-dateness" is the single largest category of the problem

Aghajani, E. et al. (2019). *Software Documentation Issues Unveiled.* ICSE 2019.

878 documentation-related artifacts mined and taxonomized into 162 issue types. Up-to-dateness problems account for 39% of documentation content issues — the largest single category — and the paper states plainly that documentation "goes outdated silently," with no crash, no error, and developers frequently unaware their own code change made a doc wrong. This is close to lockwire's exact framing, five years before agents made the rate of change acute.

## A concrete field example, not a lab study

[githubnext/gh-aw-cao#13637](https://github.com/githubnext/gh-aw-cao/issues/13637) (September 2026) — a periodic LLM-audit workflow found that a real repository's `AGENTS.md` had gone unchanged for 189 days across 1,607 commits, and among other drifted claims, stated "no test files exist" while the repository held 423 `*.test.ts` files. This is the acute version of Aghajani's "silently" finding: not a subtle contract change, a flatly false, confidently stated claim that a periodic manual-style audit caught by accident, 189 days in.

## Standards adopted rather than invented

**[Agent Trace](https://agent-trace.dev/)** (Cursor, v0.1.0 RFC, January 2026; backed by Cloudflare, Vercel, Google Jules, Amp, OpenCode, git-ai) — an open specification for attributing a code change to human, AI, mixed, or unknown, with a `provider/model-name` identifier convention. lockwire's ledger `actor` field is exactly this shape rather than a bespoke one, because attribution is a hard, separately-solved problem and reusing a spec multiple tools are converging on beats inventing a sixth incompatible format.

## What this ruled out

- **A new domain-specific language for claims.** Every one of the file-structure and context-volume studies above points the same direction: adoption friction and file structure aren't where the leverage is. A new language is pure adoption friction with no offsetting correctness gain. lockwire's marker syntax is an HTML comment inside markdown anyone already writes — zero migration, nothing new to learn beyond one line.
- **LLM-only detection as the default.** Non-determinism, per-check cost, and the inability to run inside a 10-second write-time hook rule it out as the *primary* mechanism, even though — per ClaudeDrift's own findings — it's the only mechanism that catches semantic drift. lockwire's position is that the deterministic core should handle the mechanical, common case, and a reasoning layer is a natural, optional addition on top, not a replacement.
