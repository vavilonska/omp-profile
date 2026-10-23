import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { NATIVE_COMPLETION_END, NATIVE_COOP_START, PROGRESS_REPLACEMENTS } from "./subagent-progress-policy";

export function transformSubagentProgress(
  systemPrompt: readonly string[],
  agent: Pick<ExtensionContext["agent"], "kind" | "name">,
): string[] | undefined {
  if (agent.kind !== "sub") return undefined;
  switch (agent.name) {
    case "task":
    case "work-lead":
    case "verifier":
    case "integrator":
    case "reviewer":
    case "scout":
    case "security-reviewer":
    case "sonic":
      break;
    default:
      return undefined;
  }

  for (let index = systemPrompt.length - 1; index >= 0; index--) {
    const block = systemPrompt[index];
    if (!block.endsWith(NATIVE_COMPLETION_END)) continue;
    const suffixStart = block.lastIndexOf(NATIVE_COOP_START);
    if (suffixStart === -1) continue;

    const suffix = block.slice(suffixStart);
    let transformed = suffix;
    for (const { from, to } of PROGRESS_REPLACEMENTS) {
      transformed = transformed.replaceAll(from, to);
    }
    if (transformed === suffix) return undefined;

    const blocks = systemPrompt.slice();
    blocks[index] = block.slice(0, suffixStart) + transformed;
    return blocks;
  }
  return undefined;
}
