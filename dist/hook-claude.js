import { readConfig } from "./config.js";
import { absoluteHookPath, buildAdvisoryText, claimsForPath, hookActor, logHookError, normalizeTouchedPath, readStdinJson, reportDriftFor, resolveHookRoot, unlinkedClaimsFor, } from "./hook-common.js";
/**
 * Claude Code PreToolUse/PostToolUse adapter. Fail-open by contract: any exception here must
 * result in exit 0 with no output, never a broken tool call. See LOCKWIRE-SPEC.md §6.
 */
export async function runClaudeHook(adapter, fallbackRoot) {
    let repoRoot = fallbackRoot;
    try {
        const input = await readStdinJson();
        if (!input.tool_name || !["Edit", "Write"].includes(input.tool_name))
            return;
        const filePath = input.tool_input?.file_path;
        if (!filePath)
            return;
        const absPath = absoluteHookPath(input, filePath);
        repoRoot = resolveHookRoot(fallbackRoot, input, absPath);
        const touched = normalizeTouchedPath(repoRoot, absPath);
        const config = await readConfig(repoRoot);
        if (adapter === "claude-pre") {
            const anchors = await claimsForPath(repoRoot, touched);
            const unlinked = await unlinkedClaimsFor(repoRoot, config, touched, adapter);
            if (anchors.length === 0 && unlinked.length === 0)
                return;
            const additionalContext = buildAdvisoryText(anchors, config, unlinked);
            const output = {
                hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext },
            };
            const spec = output.hookSpecificOutput;
            // Only anchored claims can be acknowledged, so only they may ask or block; unlinked ones inform.
            const mode = anchors.length > 0 ? config.hook.mode : "advisory";
            if (mode === "ask") {
                spec.permissionDecision = "ask";
                spec.permissionDecisionReason = "lockwire: documented claims cover this code";
            }
            else if (mode === "deny") {
                spec.permissionDecision = "deny";
                spec.permissionDecisionReason =
                    "lockwire: acknowledge the affected claims first (lockwire_claims_for / lockwire ack)";
            }
            process.stdout.write(JSON.stringify(output));
        }
        else {
            const { text, anyDrift } = await reportDriftFor(repoRoot, touched, hookActor("claude-code", input));
            if (!anyDrift)
                return;
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
            }));
        }
    }
    catch (err) {
        await logHookError(repoRoot, adapter, err);
    }
}
//# sourceMappingURL=hook-claude.js.map