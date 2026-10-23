import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { MAGIC_KEYWORDS, type MagicKeyword } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import notice from "./orchestrate-notice.md" with { type: "text" };
import { transformSubagentProgress } from "./subagent-progress";

const content = notice.trim();
const renderNotice: MagicKeyword["notice"] = () => content;

export default function orchestrateCompatibility(pi: ExtensionAPI): void {
  const keyword = MAGIC_KEYWORDS.find(entry => entry.id === "orchestrate");
  if (!keyword) throw new Error("orchestrate-compat: native orchestrate keyword is unavailable.");
  // This is the shared host producer, not a copy of the template or a request-only view.
  // Keep native gating and message metadata. Repeated session initialization is idempotent.
  // The override is process-wide; disabling it requires a fresh process without this extension.
  (keyword as MagicKeyword).notice = renderNotice;

  pi.on("before_agent_start", (event, ctx) => {
    const systemPrompt = transformSubagentProgress(event.systemPrompt, ctx.agent);
    if (systemPrompt) return { systemPrompt };
  });
}
