import { readConfig } from "./config.js";
import {
  absoluteHookPath,
  buildAdvisoryText,
  claimsForPath,
  logHookError,
  normalizeTouchedPath,
  readStdinJson,
  reportDriftFor,
  resolveHookRoot,
} from "./hook-common.js";

/**
 * Claude Code PreToolUse/PostToolUse adapter. Fail-open by contract: any exception here must
 * result in exit 0 with no output, never a broken tool call. See LOCKWIRE-SPEC.md §6.
 */
export async function runClaudeHook(
  adapter: "claude-pre" | "claude-post",
  fallbackRoot: string,
): Promise<void> {
  let repoRoot = fallbackRoot;
  try {
    const input = await readStdinJson();
    if (!input.tool_name || !["Edit", "Write"].includes(input.tool_name)) return;
    const filePath = input.tool_input?.file_path;
    if (!filePath) return;

    const absPath = absoluteHookPath(input, filePath);
    repoRoot = resolveHookRoot(fallbackRoot, input, absPath);
    const touched = normalizeTouchedPath(repoRoot, absPath);
    const config = await readConfig(repoRoot);

    if (adapter === "claude-pre") {
      const anchors = await claimsForPath(repoRoot, touched);
      if (anchors.length === 0) return;
      const additionalContext = buildAdvisoryText(anchors, config);
      const output: Record<string, unknown> = {
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext },
      };
      const spec = output.hookSpecificOutput as Record<string, unknown>;
      if (config.hook.mode === "ask") {
        spec.permissionDecision = "ask";
        spec.permissionDecisionReason = "lockwire: documented claims cover this code";
      } else if (config.hook.mode === "deny") {
        spec.permissionDecision = "deny";
        spec.permissionDecisionReason =
          "lockwire: acknowledge the affected claims first (lockwire_claims_for / lockwire ack)";
      }
      process.stdout.write(JSON.stringify(output));
    } else {
      const { text, anyDrift } = await reportDriftFor(repoRoot, touched);
      if (!anyDrift) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
        }),
      );
    }
  } catch (err) {
    await logHookError(repoRoot, adapter, err);
  }
}
