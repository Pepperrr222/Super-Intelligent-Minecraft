import mineflayer from 'mineflayer';
import { CompanionRuntime } from '../src/index.js';

const owners = (process.env.MC_OWNERS ?? '')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean);

const bot = mineflayer.createBot({
  host: process.env.MC_HOST ?? '127.0.0.1',
  port: Number(process.env.MC_PORT ?? 25565),
  username: process.env.MC_USERNAME ?? 'SIMCompanion',
  auth: process.env.MC_AUTH === 'offline' ? 'offline' : 'microsoft',
  profilesFolder: '.auth',
  ...(process.env.MC_VERSION ? { version: process.env.MC_VERSION } : {}),
});

const runtime = new CompanionRuntime(bot, { owners });
let started = false;

bot.on('spawn', () => {
  if (started) return;
  started = true;
  runtime.start();
  console.log(`已出生；owner=${owners.length ? owners.join(',') : '开发模式（所有人）'}`);
  console.log(runtime.llmInfo
    ? `LLM=${runtime.llmInfo.provider}/${runtime.llmInfo.model}`
    : 'LLM=未配置，使用规则版');
  console.log('在游戏聊天里说“过来”“跟着我”“背包里有什么”或“停”。');
});
bot.on('error', error => console.error('连接错误：', error.message));
bot.on('kicked', reason => console.error('被服务器断开：', reason));
bot.on('end', () => {
  runtime.stop();
  started = false;
});
