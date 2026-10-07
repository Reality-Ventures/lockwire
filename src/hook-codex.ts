import { readConfig } from "./config.js";
import {
  absoluteHookPath,
  buildAdvisoryText,
  claimsForPath,
  hookActor,
  logHookError,
  normalizeTouchedPath,
  readStdinJson,
  reportDriftFor,
  resolveHookRoot,
} from "./hook-common.js";

/**
 * Codex PreToolUse/PostToolUse adapter. Codex can deny a tool call but cannot rewrite its input,
 * so `ask` mode degrades to advisory here — see LOCKWIRE-SPEC.md §6 for the verified caveat on
 * apply_patch hook emission (fixed in Codex 0.123.0) vs deny enforcement (still version-dependent,
 * openai/codex#27833). lockwire's advisory default only needs emission, which is solid.
 */
export async function runCodexHook(
  adapter: "codex-pre" | "codex-post",
  fallbackRoot: string,
): Promise<void> {
  let repoRoot = fallbackRoot;
  try {
    const input = await readStdinJson();
    // Codex file edits arrive as `apply_patch`; the patch body is on tool_input.command per the
    // 2026-04-23 fix. We only need the touched path, so a best-effort regex over the patch header
    // is enough — this hook never needs to understand the patch body itself.
    if (input.tool_name !== "apply_patch") return;
    const patch = input.tool_input?.command ?? "";
    const match = /\*\*\*\s*(?:Update|Add|Delete) File:\s*(.+)/.exec(patch);
    const filePath = match?.[1]?.trim();
    if (!filePath) return;

    const absPath = absoluteHookPath(input, filePath);
    repoRoot = resolveHookRoot(fallbackRoot, input, absPath);
    const touched = normalizeTouchedPath(repoRoot, absPath);
    const config = await readConfig(repoRoot);

    if (adapter === "codex-pre") {
      const anchors = await claimsForPath(repoRoot, touched);
      if (anchors.length === 0) return;
      const additionalContext = buildAdvisoryText(anchors, config);
      const output: Record<string, unknown> = {
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext },
      };
      if (config.hook.mode === "deny") {
        (output.hookSpecificOutput as Record<string, unknown>).permissionDecision = "deny";
        (output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason =
          "lockwire: acknowledge the affected claims first";
      }
      process.stdout.write(JSON.stringify(output));
    } else {
      const { text, anyDrift } = await reportDriftFor(repoRoot, touched, hookActor("codex", input));
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
