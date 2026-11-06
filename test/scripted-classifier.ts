import type { Intent, IntentClassifier, IntentEnvelope, PlayerMessage } from '../src/interaction.js';

/** Test-only deterministic classifier. Production intent recognition is model-based. */
export class ScriptedClassifier implements IntentClassifier {
  constructor(private readonly intents: Record<string, Intent>) {}
  async classify(input: { message: PlayerMessage }): Promise<IntentEnvelope> {
    const intent = this.intents[input.message.text];
    if (!intent) throw new Error(`no scripted intent for ${input.message.text}`);
    return { intent, confidence: 1, rawText: input.message.text };
  }
}
