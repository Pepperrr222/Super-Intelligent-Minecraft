import type { Bot } from 'mineflayer';
import { MinecraftActions } from './actions.js';
import { ActionController } from './controller.js';
import { TaskScheduler } from './scheduler.js';
import {
  InteractionService,
  IntentRouter,
  type ActionResolverPort,
  type InteractionConfig,
} from './interaction.js';
import { MineflayerChatTransport } from './chat.js';
import { CompanionBrain, type CompanionBrainOptions } from './brain.js';
import { loadLlmFromSecrets, type LlmClient } from './llm.js';
import { DiagnosticBus } from './diagnostics.js';
import { wireDiagnostics } from './diagnostic-wiring.js';
import { AgentLoop, type AgentLoopOptions } from './agent-loop.js';
import { SkillRegistry } from './skill-runtime.js';
import type { AgentBrain } from './agent-brain.js';
import { loadPromptApproval } from './prompt-approval.js';

export type CompanionRuntimeOptions = Partial<InteractionConfig> & {
  /** Change when resetting/replacing the world; agent store separately isolates server/account. */
  knowledgeScope?:string;
  /** V2 by default; legacy must be explicit, never a model-failure fallback. */
  agentMode?: 'legacy' | 'v2';
  agent?: AgentLoopOptions;
  diagnostics?: DiagnosticBus;
  actionResolver?: ActionResolverPort;
  brain?: CompanionBrainOptions;
  llm?: LlmClient;
};

export type CompanionLlmInfo = {
  provider: string;
  model: string;
  baseUrl: string;
};

/**
 * Composition root for one Bot:
 * player chat -> AgentLoop / AgentBrain (or explicit legacy) -> TaskScheduler
 *   -> ActionController -> MinecraftActions -> Mineflayer.
 */
export class CompanionRuntime {
  readonly diagnostics: DiagnosticBus;
  readonly actions: MinecraftActions;
  readonly controller: ActionController;
  readonly scheduler: TaskScheduler;
  readonly transport: MineflayerChatTransport;
  readonly brain: CompanionBrain;
  /** Active V2 model boundary; brain above remains the legacy compatibility API. */
  readonly agentBrain?: AgentBrain;
  readonly interaction: InteractionService | AgentLoop;
  readonly agentMode: 'legacy' | 'v2';
  readonly llmInfo?: CompanionLlmInfo;

  constructor(bot: Bot, options: CompanionRuntimeOptions = {}) {
    this.diagnostics = options.diagnostics ?? new DiagnosticBus();
    this.agentMode = options.agentMode ?? 'v2';
    this.actions = new MinecraftActions(bot, options.knowledgeScope ?? 'default-world');
    const registry = this.agentMode === 'v2' ? new SkillRegistry() : undefined;
    this.controller = new ActionController(this.actions, registry);
    this.scheduler = new TaskScheduler(this.controller, undefined, registry);
    this.transport = new MineflayerChatTransport(bot);

    const loaded = options.llm || options.brain?.llm || options.agent?.model || options.agent?.director ? undefined : loadLlmFromSecrets();
    const llm = options.llm ?? options.brain?.llm ?? options.agent?.model ?? options.agent?.director ?? loaded?.client;
    this.llmInfo = loaded
      ? { provider: loaded.provider, model: loaded.model, baseUrl: loaded.baseUrl }
      : llm
        ? { provider: 'custom', model: 'custom', baseUrl: 'custom' }
        : undefined;

    const fastLlm = this.agentMode === 'legacy'
      ? options.brain?.fastLlm ?? (loaded && process.env.LLM_FAST_MODEL ? loadLlmFromSecrets('LLM_FAST_MODEL')?.client : undefined) ?? llm
      : undefined;
    const plannerLlm = options.brain?.plannerLlm ?? (loaded && process.env.LLM_PLANNER_MODEL ? loadLlmFromSecrets('LLM_PLANNER_MODEL')?.client : undefined) ?? llm;
    this.brain = new CompanionBrain(
      { query: input => this.actions.query(input) },
      { ...options.brain, diagnostics: this.diagnostics, ...(llm ? { llm } : {}), ...(fastLlm ? { fastLlm } : {}), ...(plannerLlm ? { plannerLlm } : {}) },
    );
    this.interaction = this.agentMode === 'v2' ? new AgentLoop(this.transport, this.actions, this.controller, this.scheduler, {
      ...options.agent, owners: options.owners ?? options.agent?.owners, botName: bot.username,
      memory:options.agent?.memory ?? this.actions.observations.containers,
      validateOperations:options.agent?.validateOperations ?? (operations => {
        try {
          this.actions.observations.validateTargets(operations);
          return this.actions.observations.validateCrafts(operations);
        } catch (error) { return error instanceof Error ? error.message : String(error); }
      }),
      model: options.agent?.model ?? options.agent?.director ?? plannerLlm,
      requirePromptApproval: true,
      approvedPromptHash: options.agent?.approvedPromptHash ?? loadPromptApproval(),
      diagnostics: this.diagnostics, capabilities: options.brain?.capabilities ?? options.agent?.capabilities,
      subscribeWorld: options.agent?.subscribeWorld ?? (wake => {
        bot.on('blockUpdate', wake); bot.on('playerCollect', wake); bot.on('health', wake);
        bot.inventory?.on('updateSlot', wake);
        return () => { bot.removeListener('blockUpdate', wake); bot.removeListener('playerCollect', wake);
          bot.removeListener('health', wake); bot.inventory?.removeListener('updateSlot', wake); };
      }),
    }) : new InteractionService(
      this.transport,
      new IntentRouter(fastLlm, options.brain?.fastTimeoutMs),
      this.brain,
      this.scheduler,
      this.controller,
      options.actionResolver,
      options,
      // The decision loop needs a reasoning model; without one the legacy
      // intent router keeps its deterministic behaviour.
      (options.brain?.plannerLlm ?? llm) ? this.brain : undefined,
      this.diagnostics,
    );
    if (this.interaction instanceof AgentLoop) this.agentBrain = this.interaction.brain;
    wireDiagnostics(this, this.diagnostics);
  }

  start(): () => void {
    this.diagnostics.emit('runtime', 'ok', '伙伴运行时启动');
    return this.interaction.start();
  }

  stop(): void {
    this.diagnostics.emit('runtime', 'cancelled', '伙伴运行时停止');
    this.interaction.stop();
    this.transport.dispose();
    this.actions.dispose();
  }
}
