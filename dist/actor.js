/** Best-effort actor detection for CLI invocations (hooks build their own Actor from stdin JSON instead). */
export function cliActor() {
    if (process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDECODE) {
        return { type: "ai", tool: { name: "claude-code" } };
    }
    if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) {
        return { type: "ai", tool: { name: "codex" } };
    }
    if (process.env.CI) {
        return { type: "unknown", tool: { name: "ci" } };
    }
    return { type: "human" };
}
//# sourceMappingURL=actor.js.map