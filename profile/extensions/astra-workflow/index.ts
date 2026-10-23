import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Type } from "typebox";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { controllerFor, WorkflowController } from "./relay";
import { WORKFLOW_ACTION_DESCRIPTION, WORKFLOW_AGENTS_DESCRIPTION, WORKFLOW_LEVEL_DESCRIPTION, WORKFLOW_TOOL_DESCRIPTION } from "./tool-contract";

export default function astraWorkflow(pi: ExtensionAPI): void {
  let rootController: WorkflowController | undefined;
  const registry = AgentRegistry.global();

  function contextRef(ctx: ExtensionContext) {
    const ref = registry.get(ctx.agent.id);
    if (!ref?.session || ref.session.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
      throw new Error("astra-workflow cannot bind the current session to the native host registry.");
    }
    return ref;
  }

  function bind(ctx: ExtensionContext): void {
    const ref = contextRef(ctx);
    if (ctx.agent.kind === "main") {
      if (rootController?.current) return;
      rootController?.dispose();
      rootController = new WorkflowController(ref.session!, ref, registry);
      rootController.reconcile();
    } else {
      controllerFor(ref)?.reconcile();
    }
  }

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("status"), Type.Literal("astra"), Type.Literal("mixed"), Type.Literal("raise")], {
        description: WORKFLOW_ACTION_DESCRIPTION,
      }),
      agents: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1, uniqueItems: true, description: WORKFLOW_AGENTS_DESCRIPTION,
      })),
      level: Type.Optional(Type.Union([Type.Literal("xhigh"), Type.Literal("max")], {
        description: WORKFLOW_LEVEL_DESCRIPTION,
      })),
    }),
    approval: "write",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (ctx.agent.kind !== "main") throw new Error("Workflow controls are restricted to the root agent.");
      signal?.throwIfAborted();
      const action = params.action;
      if (action !== "status" && action !== "astra" && action !== "mixed" && action !== "raise") {
        throw new Error("Invalid workflow action.");
      }
      bind(ctx);
      const controller = rootController!;
      if (action === "raise") await controller.raise(params.agents, params.level, signal);
      else {
        if (params.agents !== undefined) throw new Error("Workflow agents are only accepted for raise.");
        if (params.level !== undefined) throw new Error("Workflow level is only accepted for raise.");
        if (action !== "status") await controller.setMode(action);
      }
      return {
        content: [{ type: "text", text: controller.status() }],
        details: { mode: controller.mode, generation: controller.generation },
      };
    },
  });
  pi.on("session_start", (_event, ctx) => bind(ctx));
  pi.on("session_switch", (_event, ctx) => bind(ctx));
  pi.on("session_before_switch", async (_event, ctx) => {
    const controller = ctx.agent.kind === "main" ? rootController : controllerFor(contextRef(ctx));
    await controller?.settleTransitions();
  });
  pi.on("session_before_branch", async (_event, ctx) => {
    const controller = ctx.agent.kind === "main" ? rootController : controllerFor(contextRef(ctx));
    await controller?.settleTransitions();
  });
  pi.on("before_subagent_spawn", (_event, ctx) => {
    const controller = controllerFor(contextRef(ctx));
    if (controller?.mode !== "astra") return;
    // Keep native model intent for mixed restoration. The root's attach observer installs
    // pre-call hooks even for prepared sessions that skip spawn hooks and child extensions.
    try {
      controller.target();
      controller.reconcile();
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  pi.on("session_shutdown", () => {
    rootController?.dispose();
    rootController = undefined;
  });
}
