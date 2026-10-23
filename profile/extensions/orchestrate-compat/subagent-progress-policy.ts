// Model-facing clauses are authored and maintained by the main agent.
// Match only the native subagent cooperation/completion suffix; do not replace ROLE/context text.
export const NATIVE_COOP_START = "\n§ Coop\nYou are operating on a piece of work assigned to you by the main agent.";
export const NATIVE_COMPLETION_END = "You MUST keep going until this ticket is closed. This matters.";

export const PROGRESS_REPLACEMENTS: readonly { from: string; to: string }[] = [
  {
    from: "- Your final result reaches Main automatically. Message Main only for questions, blockers, or decisions — never progress or completion reports.",
    to: "- Your final result reaches the task caller automatically; do not send it again as a separate message. Use the permitted message channel to inform your actual direct parent of substantive stage results, questions, blockers, or decisions. Follow the role and engineering-workflow reporting contract; do not send unchanged-status heartbeats or treat a stage update as terminal delivery. Messaging permission is not expanded.",
  },
  {
    from: "No TODO tracking, no progress updates. Execute; report results with `yield`.",
    to: "No TODO tracking. Send substantive stage updates through the permitted parent-message channel without pausing work. Execute; report terminal results with `yield` under the protocol below.",
  },
  {
    from: "While work remains, you MUST continue with another tool call — investigate, edit. Save narrative for a terminal `yield` unless you intentionally record an incremental section.",
    to: "While work remains, you MUST continue with the next applicable tool action. Parent messages carry stage coordination; they do not end the assignment or replace the required terminal `yield`. Incremental sections follow the protocol below and do not substitute for sending a required parent update.",
  },
  {
    from: "No TODO tracking, no progress updates. Execute; your final message is your result.",
    to: "No TODO tracking. Send substantive stage updates through the permitted parent-message channel without pausing work. Execute; your final message is your complete result, not a progress update.",
  },
];
