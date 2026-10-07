import { readConfig } from "./config.js";
import { absoluteHookPath, buildAdvisoryText, claimsForPath, hookActor, logHookError, normalizeTouchedPath, readStdinJson, reportDriftFor, resolveHookRoot, unlinkedClaimsFor, } from "./hook-common.js";
/**
 * Codex PreToolUse/PostToolUse adapter. Codex can deny a tool call but cannot rewrite its input,
 * so `ask` mode degrades to advisory here — see LOCKWIRE-SPEC.md §6 for the verified caveat on
 * apply_patch hook emission (fixed in Codex 0.123.0) vs deny enforcement (still version-dependent,
 * openai/codex#27833). lockwire's advisory default only needs emission, which is solid.
 */
export async function runCodexHook(adapter, fallbackRoot) {
    let repoRoot = fallbackRoot;
    try {
        const input = await readStdinJson();
        // Codex file edits arrive as `apply_patch`; the patch body is on tool_input.command per the
        // 2026-04-23 fix. We only need the touched path, so a best-effort regex over the patch header
        // is enough — this hook never needs to understand the patch body itself.
        if (input.tool_name !== "apply_patch")
            return;
        const patch = input.tool_input?.command ?? "";
        const match = /\*\*\*\s*(?:Update|Add|Delete) File:\s*(.+)/.exec(patch);
        const filePath = match?.[1]?.trim();
        if (!filePath)
            return;
        const absPath = absoluteHookPath(input, filePath);
        repoRoot = resolveHookRoot(fallbackRoot, input, absPath);
        const touched = normalizeTouchedPath(repoRoot, absPath);
        const config = await readConfig(repoRoot);
        if (adapter === "codex-pre") {
            const anchors = await claimsForPath(repoRoot, touched);
            const unlinked = await unlinkedClaimsFor(repoRoot, config, touched, adapter);
            if (anchors.length === 0 && unlinked.length === 0)
                return;
            const additionalContext = buildAdvisoryText(anchors, config, unlinked);
            const output = {
                hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext },
            };
            // Only anchored claims can be acknowledged, so only they may block; unlinked ones inform.
            if (anchors.length > 0 && config.hook.mode === "deny") {
                output.hookSpecificOutput.permissionDecision = "deny";
                output.hookSpecificOutput.permissionDecisionReason =
                    "lockwire: acknowledge the affected claims first";
            }
            process.stdout.write(JSON.stringify(output));
        }
        else {
            const { text, anyDrift } = await reportDriftFor(repoRoot, touched, hookActor("codex", input));
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
//# sourceMappingURL=hook-codex.js.map