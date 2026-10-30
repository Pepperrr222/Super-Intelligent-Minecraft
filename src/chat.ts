import type { Bot } from 'mineflayer';
import type { ChatTransport, PlayerMessage } from './interaction.js';

export type MineflayerChatOptions = {
  maxLength?: number;
  prefixPlayer?: boolean;
};

/**
 * Direct Mineflayer chat adapter. It must not go through ActionExecutor:
 * interaction replies should remain available while a long action holds the lease.
 */
export class MineflayerChatTransport implements ChatTransport {
  private readonly handlers = new Set<(message: PlayerMessage) => void>();
  private counter = 0;

  constructor(
    private readonly bot: Bot,
    private readonly options: MineflayerChatOptions = {},
  ) {
    bot.on('chat', this.onChat);
  }

  private readonly onChat = (username: string, message: string): void => {
    if (username === this.bot.username || !message.trim()) return;
    const event: PlayerMessage = {
      id: `chat-${Date.now()}-${++this.counter}`,
      player: username,
      text: message,
      receivedAt: Date.now(),
      channel: 'chat',
    };
    for (const handler of this.handlers) handler(event);
  };

  onMessage(handler: (message: PlayerMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(player: string, text: string): void {
    const maxLength = this.options.maxLength ?? 240;
    const clean = text.replace(/[\r\n\u0000-\u001f]/gu, ' ').trim();
    if (!clean) return;
    const outbound = this.options.prefixPlayer === false ? clean : `@${player} ${clean}`;
    try {
      this.bot.chat(outbound.slice(0, maxLength));
    } catch {
      // Chat delivery is best-effort; a failed message must not fail the task.
    }
  }

  dispose(): void {
    this.bot.removeListener('chat', this.onChat);
    this.handlers.clear();
  }
}
