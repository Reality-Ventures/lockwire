/**
 * Codex PreToolUse/PostToolUse adapter. Codex can deny a tool call but cannot rewrite its input,
 * so `ask` mode degrades to advisory here — see LOCKWIRE-SPEC.md §6 for the verified caveat on
 * apply_patch hook emission (fixed in Codex 0.123.0) vs deny enforcement (still version-dependent,
 * openai/codex#27833). lockwire's advisory default only needs emission, which is solid.
 */
export declare function runCodexHook(adapter: "codex-pre" | "codex-post", repoRoot: string): Promise<void>;
//# sourceMappingURL=hook-codex.d.ts.map