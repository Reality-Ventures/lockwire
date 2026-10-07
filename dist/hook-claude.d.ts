/**
 * Claude Code PreToolUse/PostToolUse adapter. Fail-open by contract: any exception here must
 * result in exit 0 with no output, never a broken tool call. See LOCKWIRE-SPEC.md §6.
 */
export declare function runClaudeHook(adapter: "claude-pre" | "claude-post", fallbackRoot: string): Promise<void>;
//# sourceMappingURL=hook-claude.d.ts.map