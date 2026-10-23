import { serviceTierFamily, shouldSendServiceTier, type Model, type ServiceTier } from "@oh-my-pi/pi-ai";
import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { formatModelStringWithRouting, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AgentRegistry, type AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { sessionFileBelongsToRoot } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { cfgTaskMaxEffort } from "@oh-my-pi/pi-coding-agent/task/settings";

export const ENTRY_TYPE = "astra-workflow";
export const ASTRA_PROVIDER = "openai-codex";
export const ASTRA_MODEL = "gpt-6-astra";
export type WorkflowMode = "mixed" | "astra";
type RaiseLevel = "xhigh" | "max";
type Thinking = Parameters<AgentSession["setModelTemporary"]>[1];
type Choice = { model: string; thinking?: Thinking };
// `null` is the persisted absence of a tier; an absent `owned` means no ownership.
type TierState = { original: ServiceTier | null; owned?: ServiceTier | null; explicit?: boolean };
type RaiseIntent = { id: string; sessionFile: string; requested?: RaiseLevel; ceiling?: Effort; target?: Effort; minimum?: Effort };
type RecordState = {
  id: string;
  sessionId: string;
  sessionFile?: string;
  original: Choice;
  owned?: Choice;
  explicit?: boolean;
  thinkingOwned?: { value?: Thinking };
  effortCeiling?: Effort;
  retry?: { previous?: string[] };
  tier?: TierState;
};
type Marker = {
  version: 1;
  rootSessionId: string;
  mode: WorkflowMode;
  generation: number;
  selections: RecordState[];
  raises?: RaiseIntent[];
};
type Binding = {
  ref: AgentRef;
  session: AgentSession;
  sessionId: string;
  record: RecordState;
  remove: () => void;
  applying?: Promise<void>;
  appliedGeneration?: number;
  servedGeneration?: number;
  manualSelection?: boolean;
  revivedChoice?: Choice;
  initialModelEntryId?: string;
  initialThinkingEntryId?: string;
  automaticModelSelection?: boolean;
  thinkingModel?: Model;
  retryPinned?: boolean;
  observedTier?: ServiceTier;
  writingTier?: boolean;
  revivedTier?: boolean;
  error?: string;
};

const controllers = new Set<WorkflowController>();
const levels: Record<string, true> = {
  off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true, auto: true, inherit: true,
};
function validChoice(value: unknown): value is Choice {
  if (!value || typeof value !== "object") return false;
  const choice = value as Choice;
  return typeof choice.model === "string" && choice.model.length > 0 &&
    (choice.thinking === undefined || Object.hasOwn(levels, choice.thinking));
}
function validEffort(value: unknown): value is Effort {
  return typeof value === "string" && THINKING_EFFORTS.includes(value as Effort);
}
function lowerEffort(a: Effort, b: Effort): Effort {
  return THINKING_EFFORTS.indexOf(a) <= THINKING_EFFORTS.indexOf(b) ? a : b;
}
function nativeEffortBound(session: AgentSession): Effort {
  const selectors = session.getAvailableEffortSelectors();
  const available = session.getAvailableThinkingLevels().findLast(level => selectors.includes(level));
  const setting = cfgTaskMaxEffort.get(session.settings);
  // The public selectors already include the immutable per-session ceiling.
  // Capture the available upper bound, never infer it from the selected effort.
  return available === undefined ? setting : lowerEffort(setting, available);
}
function boundedEffort(session: AgentSession, requested: Effort, ceiling: Effort): Effort | undefined {
  const selectors = session.getAvailableEffortSelectors();
  const maximum = THINKING_EFFORTS.indexOf(lowerEffort(requested, ceiling));
  return session.getAvailableThinkingLevels().findLast(level =>
    selectors.includes(level) && THINKING_EFFORTS.indexOf(level) <= maximum);
}
function raisedEffort(session: AgentSession, intent: RaiseIntent, ceiling: Effort): Effort | undefined {
  // The task ceiling bounds new effort, not restoration of an already selected level.
  // Both paths still pass through the session's immutable native selectors.
  let requested = intent.target ?? intent.requested ?? ceiling;
  let bound = ceiling;
  if (intent.minimum) {
    if (intent.target === undefined && THINKING_EFFORTS.indexOf(intent.minimum) > THINKING_EFFORTS.indexOf(requested)) {
      requested = intent.minimum;
    }
    if (THINKING_EFFORTS.indexOf(intent.minimum) > THINKING_EFFORTS.indexOf(bound)) bound = intent.minimum;
  }
  return boundedEffort(session, requested, bound);
}
function validTier(value: unknown): value is ServiceTier | null {
  return value === null || value === "auto" || value === "default" || value === "flex" ||
    value === "scale" || value === "priority" || value === "ultrafast";
}
function hasRestoration(record: RecordState): boolean {
  return !!(record.owned || record.explicit || record.thinkingOwned || record.tier?.owned !== undefined || record.tier?.explicit);
}
function markerFrom(session: AgentSession): Marker | undefined {
  const entries = session.sessionManager.getBranchView();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const value = entry.data as Marker;
    // A fork/new session is not implicitly authorized by its copied ancestor marker.
    if (value?.rootSessionId !== session.sessionManager.getSessionId()) return undefined;
    if (value.version !== 1 || (value.mode !== "mixed" && value.mode !== "astra") ||
      !Number.isSafeInteger(value.generation) || value.generation < 0 || !Array.isArray(value.selections) ||
      (value.raises !== undefined && (!Array.isArray(value.raises) || value.raises.some(target =>
        !target || typeof target.id !== "string" || typeof target.sessionFile !== "string" ||
        (target.requested !== undefined && target.requested !== "xhigh" && target.requested !== "max") ||
        (target.ceiling !== undefined && !validEffort(target.ceiling)) ||
        (target.minimum !== undefined && !validEffort(target.minimum)) ||
        (target.target !== undefined && !validEffort(target.target))))) ||
      value.selections.some(record => !record || typeof record.id !== "string" ||
        typeof record.sessionId !== "string" ||
        (record.sessionFile !== undefined && typeof record.sessionFile !== "string") ||
        !validChoice(record.original) || (record.owned !== undefined && !validChoice(record.owned)) ||
        (record.explicit !== undefined && typeof record.explicit !== "boolean") ||
        (record.effortCeiling !== undefined && !validEffort(record.effortCeiling)) ||
        (record.thinkingOwned !== undefined && (!record.thinkingOwned ||
          (record.thinkingOwned.value !== undefined && !Object.hasOwn(levels, record.thinkingOwned.value)))) ||
        (record.tier !== undefined && (!record.tier || !validTier(record.tier.original) ||
          (record.tier.owned !== undefined && !validTier(record.tier.owned)) ||
          (record.tier.explicit !== undefined && typeof record.tier.explicit !== "boolean"))) ||
        (record.retry !== undefined && (typeof record.retry !== "object" || record.retry === null ||
          (record.retry.previous !== undefined && (!Array.isArray(record.retry.previous) ||
            record.retry.previous.some(selector => typeof selector !== "string"))))))) {
      throw new Error("Invalid astra-workflow session marker; refusing to guess a routing mode.");
    }
    return structuredClone(value);
  }
  return undefined;
}
function choiceOf(session: AgentSession): Choice {
  if (!session.model) throw new Error("Cannot relay a session without a selected model.");
  return { model: formatModelStringWithRouting(session.model), thinking: session.configuredThinkingLevel() };
}
function sameChoice(a: Choice | undefined, b: Choice | undefined): boolean {
  return a?.model === b?.model && a?.thinking === b?.thinking;
}

type AttachListener = (ref: AgentRef) => void;
type AttachObserver = {
  descriptor?: PropertyDescriptor;
  installed: PropertyDescriptor;
  wrapper: AgentRegistry["attachSession"];
  listeners: Set<AttachListener>;
};
const attachObservers = new WeakMap<AgentRegistry, AttachObserver>();

/** The registry has no attach event. Observe its accepted CAS before create/revive returns. */
function observeSessionAttach(registry: AgentRegistry, listener: AttachListener): () => void {
  let observer = attachObservers.get(registry);
  if (!observer) {
    const previous = registry.attachSession;
    const descriptor = Object.getOwnPropertyDescriptor(registry, "attachSession");
    const listeners = new Set<AttachListener>();
    const wrapper: AgentRegistry["attachSession"] = function (this: AgentRegistry, ...args) {
      const attached = previous.apply(this, args);
      if (attached && this === registry) {
        const ref = registry.get(args[0]);
        // Do not turn a rejected/stale attachment into a new lifecycle event.
        if (ref?.session === args[1] && ref.status !== "aborted") {
          for (const notify of listeners) notify(ref);
        }
      }
      return attached;
    };
    const installed = { value: wrapper, configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false };
    Object.defineProperty(registry, "attachSession", installed);
    observer = { descriptor, installed, wrapper, listeners };
    attachObservers.set(registry, observer);
  }
  const registration: AttachListener = ref => listener(ref);
  observer.listeners.add(registration);
  const owned = observer;
  return () => {
    if (!owned.listeners.delete(registration)) return;
    if (owned.listeners.size !== 0) return;
    // Restore only the exact descriptor we installed, not a later extension's edit.
    const current = Object.getOwnPropertyDescriptor(registry, "attachSession");
    if (current?.value === owned.wrapper && current.configurable === owned.installed.configurable &&
      current.writable === owned.installed.writable && current.enumerable === owned.installed.enumerable) {
      if (owned.descriptor) Object.defineProperty(registry, "attachSession", owned.descriptor);
      else Reflect.deleteProperty(registry, "attachSession");
    }
    attachObservers.delete(registry);
  };
}

/** Uses native registry ownership and pre-preparation hooks; never owns task execution. */
export class WorkflowController {
  readonly root: AgentSession;
  readonly rootRef: AgentRef;
  readonly rootSessionId: string;
  readonly registry: AgentRegistry;
  mode: WorkflowMode;
  generation: number;
  #records = new Map<string, RecordState>();
  #raises = new Map<string, RaiseIntent>();
  #bindings = new Map<AgentSession, Binding>();
  #unsubscribe: () => void = () => {};
  #unsubscribeAttach: () => void = () => {};
  #disposed = false;
  #controls: Promise<void> = Promise.resolve();
  #transitions = new Set<Promise<void>>();

  constructor(root: AgentSession, rootRef: AgentRef, registry = AgentRegistry.global()) {
    if (rootRef.kind !== "main" || rootRef.session !== root || registry.get(rootRef.id) !== rootRef) {
      throw new Error("astra-workflow requires the host registry's current root session reference.");
    }
    this.root = root;
    this.rootRef = rootRef;
    this.rootSessionId = root.sessionManager.getSessionId();
    this.registry = registry;
    const marker = markerFrom(root);
    this.mode = marker?.mode ?? "mixed";
    this.generation = marker?.generation ?? 0;
    for (const record of marker?.selections ?? []) {
      this.#records.set(record.sessionFile ?? record.sessionId, record);
    }
    for (const target of marker?.raises ?? []) {
      // Older applied intents already contain the actual, native-clamped result.
      const previous = this.#records.get(target.sessionFile)?.thinkingOwned?.value;
      if (target.requested === undefined && target.target === undefined && validEffort(previous)) target.target = previous;
      this.#raises.set(target.sessionFile, target);
    }
    controllers.add(this);
    this.#unsubscribe = registry.onChange(() => this.reconcile());
    this.#unsubscribeAttach = observeSessionAttach(registry, ref => {
      if (this.owns(ref)) this.reconcile(ref);
    });
    root.addDisposer(() => this.dispose());
    this.reconcile();
  }

  get current(): boolean {
    return !this.#disposed && !this.root.isDisposed && this.root.sessionManager.getSessionId() === this.rootSessionId &&
      this.registry.get(this.rootRef.id) === this.rootRef && this.rootRef.session === this.root;
  }

  owns(ref: AgentRef): boolean {
    if (!this.current || ref.kind === "advisor" || this.registry.get(ref.id) !== ref) return false;
    if (ref === this.rootRef) return true;
    // Transcript ownership also prevents old children under a reused Main id leaking into /new.
    const rootFile = this.root.sessionFile;
    if (!rootFile || !ref.sessionFile || !sessionFileBelongsToRoot(ref.sessionFile, rootFile)) return false;
    const visited = new Set<AgentRef>();
    for (let parent = ref; parent.parentId;) {
      if (visited.has(parent)) return false;
      visited.add(parent);
      const next = this.registry.get(parent.parentId);
      if (!next || next.kind === "advisor") return false;
      if (next === this.rootRef) return true;
      parent = next;
    }
    return false;
  }

  target(session = this.root): Model {
    const model = session.modelRegistry.find(ASTRA_PROVIDER, ASTRA_MODEL);
    if (!model || !session.modelRegistry.getAvailable().some(candidate =>
      candidate.provider === ASTRA_PROVIDER && candidate.id === ASTRA_MODEL)) {
      throw new Error(`Astra workflow target is unavailable: ${ASTRA_PROVIDER}/${ASTRA_MODEL}`);
    }
    if (cfgDisabledProviders.get(session.settings).includes(ASTRA_PROVIDER)) {
      throw new Error(`Astra workflow provider is disabled: ${ASTRA_PROVIDER}`);
    }
    if (!session.modelRegistry.hasConfiguredAuth(model)) {
      throw new Error(`No configured authentication for ${ASTRA_PROVIDER}/${ASTRA_MODEL}`);
    }
    return model;
  }

  #persist(): void {
    if (!this.current) return;
    const marker: Marker = {
      version: 1, rootSessionId: this.rootSessionId, mode: this.mode,
      generation: this.generation, selections: [...this.#records.values()],
      raises: [...this.#raises.values()],
    };
    this.root.sessionManager.appendCustomEntry(ENTRY_TYPE, structuredClone(marker));
  }

  /** Controls serialize only an already-entered model transition, not streams, tools or tasks. */
  setMode(mode: WorkflowMode): Promise<void> {
    const operation = this.#controls.then(async () => {
      await this.settleTransitions();
      if (!this.current) throw new Error("Workflow control belongs to an outgoing root session.");
      if (mode === "astra" && !this.root.sessionFile) {
        throw new Error("Astra workflow requires a persistent root session; --no-session/inMemory is unsupported.");
      }
      // Reject unavailable targets before committing intent so the controlling root can
      // report the tool error and remain able to select its normal workflow.
      if (mode === "astra") this.target();
      if (this.mode !== mode) {
        if (mode === "astra") {
          for (const binding of this.#bindings.values()) {
            if (this.#valid(binding) && !binding.record.owned && !binding.record.thinkingOwned &&
              !(binding.record.explicit && binding.revivedChoice && sameChoice(choiceOf(binding.session), binding.revivedChoice))) {
              binding.record.original = choiceOf(binding.session);
            }
            if (this.#valid(binding) && binding.record.tier && binding.record.tier.owned === undefined &&
              !binding.revivedTier) binding.record.tier.original = binding.session.serviceTierByFamily.openai ?? null;
          }
        }
        this.mode = mode;
        this.generation++;
        this.#persist();
      }
      this.reconcile();
    });
    this.#controls = operation.catch(() => {});
    return operation;
  }

  raise(agents: unknown, level: unknown = "xhigh", signal?: AbortSignal): Promise<void> {
    const operation = this.#controls.then(async () => {
      await this.settleTransitions();
      signal?.throwIfAborted();
      if (!this.current) throw new Error("Workflow control belongs to an outgoing root session.");
      if (level !== "xhigh" && level !== "max") throw new Error("Workflow raise level must be xhigh or max.");
      if (!Array.isArray(agents) || agents.length === 0 ||
        agents.some(id => typeof id !== "string" || id.length === 0) || new Set(agents).size !== agents.length) {
        throw new Error("Workflow raise requires a nonempty list of unique native agent IDs.");
      }
      const targets = agents.map(id => {
        const ref = this.registry.get(id);
        if (!ref || ref.kind !== "sub" || !this.owns(ref) || !ref.sessionFile ||
          ref.status === "aborted" || ref.session?.isDisposed) {
          throw new Error(`Workflow raise target is not a current engineering child: ${id}`);
        }
        const record = this.#records.get(ref.sessionFile);
        const previous = this.#raises.get(ref.sessionFile);
        if (previous?.id === ref.id && (
          previous.requested === level || previous.requested === "max" || previous.target === "max" ||
          (previous.requested === undefined && previous.target === undefined) ||
          (previous.target !== undefined && THINKING_EFFORTS.indexOf(previous.target) >= THINKING_EFFORTS.indexOf(level))
        )) return previous;
        let ceiling = cfgTaskMaxEffort.get(ref.session?.settings ?? this.root.settings);
        if (record?.effortCeiling !== undefined) ceiling = lowerEffort(ceiling, record.effortCeiling);
        if (ref.session) ceiling = lowerEffort(ceiling, nativeEffortBound(ref.session));
        const selected = ref.session ? ref.session.configuredThinkingLevel() :
          record?.thinkingOwned?.value ?? record?.original.thinking;
        return {
          id: ref.id, sessionFile: ref.sessionFile, requested: level, ceiling,
          minimum: validEffort(selected) ? selected : undefined,
        } satisfies RaiseIntent;
      });
      // Validation is complete before any intent is committed. Parked children stay parked.
      for (const target of targets) this.#raises.set(target.sessionFile, target);
      this.#persist();
      this.reconcile();
    });
    this.#controls = operation.catch(() => {});
    return operation;
  }

  async settleTransitions(): Promise<void> {
    // Session-before-switch handlers use this same native transition barrier.
    await Promise.allSettled([...this.#transitions]);
  }

  reconcile(attached?: AgentRef): void {
    if (!this.current) return;
    for (const [session, binding] of this.#bindings) {
      if (!this.#valid(binding)) {
        binding.remove();
        this.#restoreRetry(binding);
        this.#bindings.delete(session);
      }
    }
    for (const ref of this.registry.list()) {
      if (!this.owns(ref) || !ref.session || ref.status === "aborted" || ref.session.isDisposed) continue;
      if (this.#bindings.has(ref.session)) continue;
      const session = ref.session;
      const sessionId = session.sessionManager.getSessionId();
      const key = session.sessionFile ?? sessionId;
      let record = this.#records.get(key);
      if (!record || record.sessionId !== sessionId || record.id !== ref.id) {
        record = {
          id: ref.id, sessionId, sessionFile: session.sessionFile, original: choiceOf(session),
          effortCeiling: ref === this.rootRef ? undefined : nativeEffortBound(session),
        };
        this.#records.set(key, record);
        this.#persist();
      }
      if (ref !== this.rootRef && record.effortCeiling === undefined) {
        record.effortCeiling = nativeEffortBound(session);
        this.#persist();
      }
      const binding: Binding = {
        ref, session, sessionId, record, remove: () => {},
        revivedChoice: ref !== this.rootRef && (record.owned || record.explicit || record.thinkingOwned) ? choiceOf(session) : undefined,
        observedTier: session.serviceTierByFamily.openai,
        revivedTier: ref !== this.rootRef && !!(record.tier?.owned !== undefined || record.tier?.explicit),
      };
      this.#bindings.set(session, binding);
      if (ref === attached && ref !== this.rootRef) {
        // A successful native attach is still before the reviver exposes the session.
        // Restore saved thinking here so a later explicit same-as-spawn choice is visible.
        if (this.#raised(binding)) {
          if (this.#applyThinking(binding)) this.#persist();
          binding.revivedChoice = choiceOf(session);
        } else if (record.explicit) {
          session.setThinkingLevel(record.original.thinking);
          binding.revivedChoice = choiceOf(session);
        }
      }
      const branch = session.sessionManager.getBranchView();
      for (let i = branch.length - 1; i >= 0; i--) {
        if (branch[i].type === "model_change" && !binding.initialModelEntryId) binding.initialModelEntryId = branch[i].id;
        if (branch[i].type === "thinking_level_change" && !binding.initialThinkingEntryId) binding.initialThinkingEntryId = branch[i].id;
        if (binding.initialModelEntryId && binding.initialThinkingEntryId) break;
      }
      const removeHook = session.agent.addBeforeModelCallHook(signal => this.#prepare(binding, signal));
      const removeObserver = session.subscribe(event => {
        if (event.type === "model_changed" || event.type === "thinking_level_changed") this.#captureManual(binding);
        if (event.type === "message_end" && event.message.role === "assistant" &&
          event.message.provider === ASTRA_PROVIDER && event.message.model === ASTRA_MODEL &&
          binding.appliedGeneration === this.generation && this.#valid(binding)) {
          binding.servedGeneration = this.generation;
        }
      });
      const manager = session.sessionManager;
      const priorEntryObserver = manager.onEntryAppended;
      const entryObserver: NonNullable<typeof manager.onEntryAppended> = entry => {
        priorEntryObserver?.(entry);
        if (entry.type === "model_change" || entry.type === "thinking_level_change") this.#captureManual(binding);
        if (entry.type === "service_tier_change") this.#captureTier(binding);
      };
      manager.onEntryAppended = entryObserver;
      binding.remove = () => {
        removeHook();
        removeObserver();
        if (manager.onEntryAppended === entryObserver) manager.onEntryAppended = priorEntryObserver;
      };
      session.addDisposer(() => {
        this.#captureManual(binding, "dispose");
        binding.remove();
        this.#restoreRetry(binding);
        this.#bindings.delete(session);
      });
    }
  }

  #captureManual(binding: Binding, origin: "observe" | "prepare" | "dispose" = "observe"): boolean {
    const session = binding.session;
    const record = binding.record;
    if ((binding.applying && origin !== "prepare") || !session.model) return false;
    const inScope = origin === "dispose"
      ? this.current && this.owns(binding.ref) && binding.ref.session === session &&
        session.sessionManager.getSessionId() === binding.sessionId
      : this.#valid(binding);
    if (!inScope) return false;
    const entries = session.sessionManager.getBranchView();
    const modelEntry = entries.findLast(entry => entry.type === "model_change");
    const thinkingEntry = entries.findLast(entry => entry.type === "thinking_level_change");
    const modelChanged = modelEntry && modelEntry.id !== binding.initialModelEntryId;
    const thinkingChanged = thinkingEntry && thinkingEntry.id !== binding.initialThinkingEntryId;
    binding.initialModelEntryId = modelEntry?.id;
    binding.initialThinkingEntryId = thinkingEntry?.id;
    if (!modelChanged && !thinkingChanged) return false;
    const current = choiceOf(session);
    const automaticModel = modelEntry?.type === "model_change" &&
      (modelEntry.role === EPHEMERAL_MODEL_CHANGE_ROLE || modelEntry.resolvedModelIsFallback);
    // Native temporary-model selection journals its thinking synchronously after
    // model_change. Only that newly observed batch is automatic; an inherited
    // fallback entry on cold attach cannot suppress a later explicit selection.
    if (modelChanged) {
      binding.automaticModelSelection = !!automaticModel;
      if (automaticModel) {
        queueMicrotask(() => { binding.automaticModelSelection = false; });
        return false;
      }
    }
    if (binding.automaticModelSelection) return false;
    const manualModel = modelChanged && modelEntry?.type === "model_change" &&
      (modelEntry.model === current.model || modelEntry.model === `${session.model.provider}/${session.model.id}`);
    const expectedThinking = record.thinkingOwned ? record.thinkingOwned.value :
      binding.manualSelection ? record.original.thinking : (record.owned ?? record.original).thinking;
    // A later explicit thinking entry also revokes a pending raise when it
    // reselects the currently applied level (for example xhigh while max waits).
    const manualThinking = thinkingChanged && (current.thinking !== expectedThinking || this.#raised(binding));
    if (!manualModel && !manualThinking) return false;
    if (manualModel) {
      record.original = current;
      record.owned = undefined;
    } else {
      record.original.thinking = current.thinking;
    }
    if (manualThinking) {
      if (record.sessionFile) this.#raises.delete(record.sessionFile);
      record.thinkingOwned = undefined;
    }
    record.explicit = true;
    binding.manualSelection = true;
    binding.revivedChoice = undefined;
    binding.appliedGeneration = undefined;
    binding.servedGeneration = undefined;
    this.#persist();
    return true;
  }

  #rememberEntries(binding: Binding): void {
    const entries = binding.session.sessionManager.getBranchView();
    binding.initialModelEntryId = entries.findLast(entry => entry.type === "model_change")?.id;
    binding.initialThinkingEntryId = entries.findLast(entry => entry.type === "thinking_level_change")?.id;
  }

  #raised(binding: Binding): boolean {
    return binding.ref !== this.rootRef && !!binding.record.sessionFile &&
      this.#raises.get(binding.record.sessionFile)?.id === binding.ref.id;
  }

  #applyThinking(binding: Binding): boolean {
    if (!this.#raised(binding)) return false;
    const session = binding.session;
    const intent = this.#raises.get(binding.record.sessionFile!)!;
    intent.ceiling ??= binding.record.effortCeiling ?? nativeEffortBound(session);
    const firstApplication = intent.target === undefined;
    const target = raisedEffort(session, intent, intent.ceiling);
    // Sparse ladders may have no supported level at or below the approved request.
    // Never let the native model normalizer select a higher level in that case.
    if (target === undefined) return false;
    const previous = binding.record.thinkingOwned;
    if (!firstApplication && previous && previous.value === session.configuredThinkingLevel() &&
      binding.thinkingModel === session.model) return false;
    session.setThinkingLevel(target);
    const value = session.configuredThinkingLevel();
    binding.thinkingModel = session.model;
    // A raise is one decision. Native revival may drop the original session ceiling,
    // so replay the first actual result rather than resolving a new hi on every attach.
    if (firstApplication && validEffort(value)) intent.target = value;
    binding.record.thinkingOwned = { value };
    return firstApplication || !previous || previous.value !== value;
  }

  #captureTier(binding: Binding): void {
    if (!this.#valid(binding)) return;
    const current = binding.session.serviceTierByFamily.openai;
    const previous = binding.observedTier;
    binding.observedTier = current;
    if (binding.ref === this.rootRef || binding.writingTier || current === previous) return;
    const tier = binding.record.tier;
    if (!tier) return; // Before first takeover, the live value is still the original.
    tier.original = current ?? null;
    tier.owned = undefined;
    tier.explicit = true;
    binding.revivedTier = false;
    this.#persist();
  }

  #applyTier(binding: Binding): void {
    if (binding.ref === this.rootRef) return;
    const session = binding.session;
    const record = binding.record;
    const current = session.serviceTierByFamily.openai ?? null;
    if (this.mode === "astra") {
      // Read only after the awaited model switch: a root off/ultra edit made during
      // that await must win. No asynchronous work separates this read and write.
      const target = this.root.serviceTierByFamily.openai ?? null;
      record.tier ??= { original: current };
      if (record.tier.owned !== target) {
        record.tier.owned = target;
        // Commit the original even when empty before journaling the broadcast.
        this.#persist();
      }
      this.#writeTier(binding, target);
      binding.revivedTier = false;
    } else if (record.tier) {
      const tier = record.tier;
      if ((tier.owned !== undefined && current === tier.owned) || binding.revivedTier) {
        this.#writeTier(binding, tier.original);
      }
      const changed = tier.owned !== undefined;
      tier.owned = undefined;
      binding.revivedTier = false;
      if (changed) this.#persist();
    }
  }

  #writeTier(binding: Binding, tier: ServiceTier | null): void {
    if ((binding.session.serviceTierByFamily.openai ?? null) === tier) return;
    binding.writingTier = true;
    try {
      // The native family setter preserves Anthropic/Google and journals null
      // for an empty map. Never mutate settings or an inherited parent snapshot.
      binding.session.setServiceTierFamily("openai", tier ?? undefined);
    } finally {
      binding.observedTier = binding.session.serviceTierByFamily.openai;
      binding.writingTier = false;
    }
  }

  #valid(binding: Binding): boolean {
    return this.current && this.owns(binding.ref) && binding.ref.status !== "aborted" &&
      binding.ref.session === binding.session && binding.session.sessionManager.getSessionId() === binding.sessionId &&
      !binding.session.isDisposed;
  }

  #pinRetry(binding: Binding): void {
    if (binding.ref === this.rootRef || binding.retryPinned) return;
    const settings = binding.session.settings;
    const role = `subagent:${binding.ref.id}`;
    const own = settings.overlayLayers().overrides.retry as { fallbackChains?: Record<string, string[]> } | undefined;
    const previous = binding.record.retry ? binding.record.retry.previous : own?.fallbackChains?.[role];
    // Only the synthetic engineering-child pin is disabled. Title/tiny/advisor/completion
    // consumers share retry.modelFallback, so changing that boolean would change auxiliary routes.
    cfgRetryFallbackChains.override(settings, { ...own?.fallbackChains, [role]: [] });
    binding.retryPinned = true;
    binding.record.retry = { previous };
  }

  #restoreRetry(binding: Binding): void {
    const override = binding.record.retry;
    if (!override) return;
    binding.retryPinned = false;
    const settings = binding.session.settings;
    const role = `subagent:${binding.ref.id}`;
    const own = settings.overlayLayers().overrides.retry as { fallbackChains?: Record<string, string[]> } | undefined;
    // Compare only our key, never restore a whole settings snapshot over concurrent user edits.
    if (!Array.isArray(own?.fallbackChains?.[role]) || own.fallbackChains[role].length !== 0) return;
    const next = { ...own.fallbackChains };
    if (override.previous === undefined) delete next[role];
    else next[role] = override.previous;
    if (Object.keys(next).length === 0) cfgRetryFallbackChains.clearOverride(settings);
    else cfgRetryFallbackChains.override(settings, next);
  }

  #prepare(binding: Binding, signal?: AbortSignal): Promise<void> {
    if (binding.applying) return binding.applying;
    const operation = this.#apply(binding, signal);
    binding.applying = operation;
    return operation.finally(() => { if (binding.applying === operation) binding.applying = undefined; });
  }

  async #apply(binding: Binding, signal?: AbortSignal): Promise<void> {
    let control: Promise<void>;
    do {
      control = this.#controls;
      await control;
    } while (control !== this.#controls);
    if (!this.#valid(binding)) return;
    signal?.throwIfAborted();
    const generation = this.generation;
    const session = binding.session;
    const record = binding.record;
    try {
      if (this.mode === "astra") {
        const model = this.target(session);
        const current = choiceOf(session);
        // A revive's spawn-time model is not a manual edit. Existing-session changes
        // are restored only when their native journal proves an explicit selection.
        const originalChanged = this.#captureManual(binding, "prepare");
        const thinking: Thinking = record.original.thinking;
        const desired = { model: formatModelStringWithRouting(model), thinking };
        this.#pinRetry(binding);
        const alreadyOwned = binding.appliedGeneration === generation && sameChoice(current, record.owned);
        if (!alreadyOwned && (!sameChoice(current, desired) || binding.appliedGeneration === undefined)) {
          const transition = session.setModelTemporary(model, thinking, { ephemeral: true });
          this.#transitions.add(transition);
          try { await transition; } finally { this.#transitions.delete(transition); }
          if (thinking === undefined) session.setThinkingLevel(undefined);
        }
        if (!this.#valid(binding) || generation !== this.generation) {
          throw new Error("Workflow model transition lost its root/session generation before provider preparation.");
        }
        signal?.throwIfAborted();
        const thinkingChanged = this.#applyThinking(binding);
        this.#rememberEntries(binding);
        this.#applyTier(binding);
        const changed = thinkingChanged || originalChanged || binding.appliedGeneration !== generation || !sameChoice(record.owned, choiceOf(session));
        record.owned = choiceOf(session);
        binding.appliedGeneration = generation;
        binding.error = undefined;
        binding.manualSelection = false;
        if (changed) this.#persist();
      } else {
        this.#restoreRetry(binding);
        this.#captureManual(binding, "prepare");
        if (record.owned || record.explicit) {
          const current = choiceOf(session);
          const changed = record.owned || binding.revivedChoice || binding.appliedGeneration !== undefined || record.retry;
          const nativeRevive = binding.revivedChoice && sameChoice(current, binding.revivedChoice);
          if (((record.owned && current.model === record.owned.model) || nativeRevive) && !sameChoice(current, record.original)) {
            if (current.model === record.original.model) {
              session.setThinkingLevel(record.original.thinking);
            } else {
              const restored = resolveModelOverride([record.original.model], session.modelRegistry, session.settings).model;
              if (!restored) throw new Error(`Mixed workflow destination is unavailable: ${record.original.model}`);
              const transition = session.setModelTemporary(restored, record.original.thinking, { ephemeral: true });
              this.#transitions.add(transition);
              try { await transition; } finally { this.#transitions.delete(transition); }
              if (record.original.thinking === undefined) session.setThinkingLevel(undefined);
            }
            if (!this.#valid(binding) || generation !== this.generation) {
              throw new Error("Mixed workflow transition lost its root/session generation before provider preparation.");
            }
          }
          // Preserve later user choices; a native revive may need its saved explicit choice reapplied.
          record.owned = undefined;
          record.retry = undefined;
          binding.appliedGeneration = undefined;
          binding.servedGeneration = undefined;
          binding.error = undefined;
          binding.revivedChoice = undefined;
          if (changed) this.#persist();
        }
        if (record.retry) {
          record.retry = undefined;
          this.#persist();
        }
        if (!this.#valid(binding) || generation !== this.generation) {
          throw new Error("Mixed workflow tier restoration lost its root/session generation before provider preparation.");
        }
        signal?.throwIfAborted();
        const thinkingChanged = this.#applyThinking(binding);
        this.#rememberEntries(binding);
        if (thinkingChanged) this.#persist();
        this.#applyTier(binding);
        binding.error = undefined;
      }
    } catch (error) {
      binding.error = error instanceof Error ? error.message : String(error);
      if (this.#valid(binding)) {
        if (this.mode === "astra" && session.model?.provider === ASTRA_PROVIDER && session.model.id === ASTRA_MODEL) {
          record.owned = choiceOf(session);
        }
        this.#persist();
        session.emitNotice("error", `Astra workflow: ${binding.error}`, "astra-workflow");
      }
      // The native pre-preparation error path prevents sending to an unintended fallback model.
      throw error;
    }
  }

  status(): string {
    if (!this.current) throw new Error("Workflow status belongs to an outgoing root session.");
    this.reconcile();
    const rootTier = this.root.serviceTierByFamily.openai;
    const fast = rootTier === "priority" || rootTier === "ultrafast";
    const rows = [
      `Workflow: ${this.mode}; generation ${this.generation}; target ${ASTRA_PROVIDER}/${ASTRA_MODEL}; native thinking selections preserved`,
      `OpenAI tier target: ${rootTier ?? "off"}; Fast ${fast ? "enabled" : "disabled"}; broadcast ${this.mode === "astra" ? "active at child safe pre-call boundaries" : "inactive"}; root tier unchanged`,
    ];
    for (const ref of this.registry.list()) {
      if (!this.owns(ref)) continue;
      const binding = ref.session ? this.#bindings.get(ref.session) : undefined;
      const record = ref.sessionFile ? this.#records.get(ref.sessionFile) : binding?.record;
      let state: string;
      if (ref.status === "aborted") state = "cancelled; no automatic revival";
      else if (!ref.session) state = this.mode === "astra" || (record && hasRestoration(record)) ? "pending native revival" : "mixed; parked";
      else if (binding?.error) state = `failed: ${binding.error}`;
      else if (this.mode === "mixed") state = record?.owned ||
        (record?.explicit && binding?.revivedChoice && !sameChoice(choiceOf(ref.session), record.original))
        ? "pending mixed restoration on next safe boundary" : "mixed";
      else if (binding?.servedGeneration === this.generation) state = "Astra served this generation";
      else if (binding?.appliedGeneration === this.generation && sameChoice(choiceOf(ref.session), record?.owned)) state = "Astra applied before preparation; no completed Astra response yet";
      else state = ref.status === "idle" ? "idle; relay only if another request occurs" : "pending next safe pre-call boundary";
      const intent = ref.sessionFile ? this.#raises.get(ref.sessionFile) : undefined;
      const raised = ref !== this.rootRef && intent?.id === ref.id;
      let effortState = ref === this.rootRef ? "root thinking unchanged" :
        `thinking target ${record?.original.thinking ?? ref.session?.configuredThinkingLevel() ?? "default"}; native selection`;
      if (raised) {
        const target = intent?.target;
        const applied = target !== undefined && !!record?.thinkingOwned && binding?.thinkingModel === ref.session?.model &&
          record.thinkingOwned.value === ref.session?.configuredThinkingLevel();
        const ceiling = intent?.ceiling ?? record?.effortCeiling;
        const unavailable = !!ref.session && ceiling !== undefined &&
          raisedEffort(ref.session, intent!, ceiling) === undefined;
        effortState = `thinking requested ${intent?.requested ?? "hi (legacy authorization)"}; locked actual ${target ?? "pending native resolution"}; approved raise ceiling ${intent?.ceiling ?? record?.effortCeiling ?? "pending native bound"}; prior selection ${intent?.minimum ?? "none"}; ${ref.status === "aborted" ? "cancelled" :
          !ref.session ? "pending native revival" :
          unavailable ? "pending; current model/native ceiling has no controllable level at or below the request" :
          applied ? `applied actual ${record?.thinkingOwned?.value ?? "uncontrolled"} through native model/ceiling clamp` : "pending next safe pre-call boundary"}`;
      }
      const actual = ref.session?.model ? `${formatModelStringWithRouting(ref.session.model)}; configured thinking ${ref.session.configuredThinkingLevel() ?? "default"}; actual thinking ${ref.session.thinkingLevel ?? "none"}` : "no live model";
      let tierState: string;
      const currentTier = ref.session?.serviceTierByFamily.openai;
      if (ref === this.rootRef) tierState = `root OpenAI tier ${currentTier ?? "off"} (not overridden)`;
      else if (ref.status === "aborted") tierState = "tier not applied; cancelled";
      else if (!ref.session) tierState = this.mode === "astra" || record?.tier?.owned !== undefined || record?.tier?.explicit
        ? "tier pending native revival; no live tier" : "mixed tier; no live tier";
      else if (this.mode === "astra") {
        const applied = record?.tier?.owned !== undefined && record.tier.owned === (rootTier ?? null) &&
          currentTier === rootTier;
        tierState = `OpenAI tier ${currentTier ?? "off"}; target ${rootTier ?? "off"}; ${applied ? "tier applied" : "tier pending next safe pre-call boundary"}`;
      } else {
        const pending = record?.tier?.owned !== undefined ||
          (binding?.revivedTier && (currentTier ?? null) !== record?.tier?.original);
        tierState = `OpenAI tier ${currentTier ?? "off"}; ${pending ? "tier pending mixed restoration" : "mixed tier"}`;
      }
      if (ref.session?.model) {
        const supported = serviceTierFamily(ref.session.model) === "openai" && shouldSendServiceTier(currentTier, ref.session.model);
        tierState += `; current model OpenAI tier wire support: ${currentTier === undefined ? "not selected" : supported ? "yes (not proof of provider service)" : "no"}`;
      }
      rows.push(`${ref.id} [${ref.status}]: ${actual}; ${state}; ${effortState}; ${tierState}`);
    }
    return rows.join("\n");
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#unsubscribeAttach();
    for (const binding of this.#bindings.values()) {
      binding.remove();
      this.#restoreRetry(binding);
    }
    this.#bindings.clear();
    controllers.delete(this);
  }
}

export function controllerFor(ref: AgentRef): WorkflowController | undefined {
  for (const controller of controllers) if (controller.owns(ref)) return controller;
  return undefined;
}
