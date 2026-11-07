/**
 * Claude Code SessionStart adapter: once per session, tell the agent when `lockwire.lock` holds claims
 * a newer lockwire stamped than the plugin that's running, so it can suggest updating. Silent
 * otherwise, inert outside a repo that uses lockwire, and fail-open like the other hooks.
 */
export declare function runClaudeSessionHook(fallbackRoot: string): Promise<void>;
/**
 * Claude Code PreToolUse/PostToolUse adapter. Fail-open by contract: any exception here must
 * result in exit 0 with no output, never a broken tool call. See LOCKWIRE-SPEC.md §6.
 */
export declare function runClaudeHook(adapter: "claude-pre" | "claude-post", fallbackRoot: string): Promise<void>;
//# sourceMappingURL=hook-claude.d.ts.map