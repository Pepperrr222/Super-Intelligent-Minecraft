import type { Bot } from 'mineflayer';
import { MinecraftActions } from './actions.js';
import { ActionController } from './controller.js';
import { TaskScheduler } from './scheduler.js';
import {
  InteractionService,
  RuleBasedIntentClassifier,
  type ActionResolverPort,
  type InteractionConfig,
} from './interaction.js';
import { MineflayerChatTransport } from './chat.js';
import { CompanionBrain, type CompanionBrainOptions } from './brain.js';
import { loadLlmFromSecrets, type LlmClient } from './llm.js';

export type CompanionRuntimeOptions = Partial<InteractionConfig> & {
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
 * player chat -> InteractionService -> CompanionBrain -> TaskScheduler
 *   -> ActionController -> MinecraftActions -> Mineflayer.
 */
export class CompanionRuntime {
  readonly actions: MinecraftActions;
  readonly controller: ActionController;
  readonly scheduler: TaskScheduler;
  readonly transport: MineflayerChatTransport;
  readonly brain: CompanionBrain;
  readonly interaction: InteractionService;
  readonly llmInfo?: CompanionLlmInfo;

  constructor(bot: Bot, options: CompanionRuntimeOptions = {}) {
    this.actions = new MinecraftActions(bot);
    this.controller = new ActionController(this.actions);
    this.scheduler = new TaskScheduler(this.controller);
    this.transport = new MineflayerChatTransport(bot);

    const loaded = options.llm || options.brain?.llm ? undefined : loadLlmFromSecrets();
    const llm = options.llm ?? options.brain?.llm ?? loaded?.client;
    this.llmInfo = loaded
      ? { provider: loaded.provider, model: loaded.model, baseUrl: loaded.baseUrl }
      : llm
        ? { provider: 'custom', model: 'custom', baseUrl: 'custom' }
        : undefined;

    this.brain = new CompanionBrain(
      { query: input => this.actions.query(input) },
      { ...options.brain, ...(llm ? { llm } : {}) },
    );
    this.interaction = new InteractionService(
      this.transport,
      new RuleBasedIntentClassifier(),
      this.brain,
      this.scheduler,
      this.controller,
      options.actionResolver,
      options,
    );
  }

  start(): () => void {
    return this.interaction.start();
  }

  stop(): void {
    this.interaction.stop();
    this.transport.dispose();
    this.actions.dispose();
  }
}
