import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MineflayerChatTransport } from '../src/chat.js';
import type { PlayerMessage } from '../src/interaction.js';

function fakeBot() {
  const sent: string[] = [];
  const bot = Object.assign(new EventEmitter(), {
    username: 'SIM',
    chat: (text: string) => sent.push(text),
  });
  return { bot, sent };
}

test('chat transport filters self messages and sends directly without the action lease', () => {
  const { bot, sent } = fakeBot();
  const transport = new MineflayerChatTransport(bot as never);
  const messages: PlayerMessage[] = [];
  const off = transport.onMessage(message => messages.push(message));

  bot.emit('chat', 'alice', 'hello');
  bot.emit('chat', 'SIM', 'self message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.player, 'alice');
  assert.equal(messages[0]?.text, 'hello');

  transport.send('alice', 'hi');
  assert.deepEqual(sent, ['@alice hi']);

  off();
  bot.emit('chat', 'alice', 'after unsubscribe');
  assert.equal(messages.length, 1);

  transport.dispose();
  bot.emit('chat', 'alice', 'after dispose');
  assert.equal(messages.length, 1);
});
