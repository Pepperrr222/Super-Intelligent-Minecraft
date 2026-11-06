import mineflayer from 'mineflayer';
import { CompanionRuntime } from '../src/index.js';
import { DiagnosticBus } from '../src/diagnostics.js';
import { startDiagnosticServer } from '../src/diagnostic-server.js';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { FileAgentStore } from '../src/agent-store.js';
import { brainPromptManifest } from '../src/agent-brain.js';
import { loadPromptApproval } from '../src/prompt-approval.js';

const diagnostics = new DiagnosticBus({ file: resolve('logs/diagnostics.jsonl') });
// The viewer remains usable after a connection failure; a separate viewer can
// follow this file if the port is already occupied.
try {
  const panel = await startDiagnosticServer(diagnostics, { port: Number(process.env.SIM_DIAGNOSTICS_PORT ?? 4318) });
  console.log(`运行诊断界面：${panel.url}`);
} catch (error) {
  diagnostics.emit('runtime', 'error', '诊断界面启动失败（伙伴继续运行，可使用独立诊断台）', error);
  console.log('诊断界面端口不可用；诊断记录仍写入 logs/diagnostics.jsonl。');
}

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

const mode = process.env.SIM_AGENT_MODE ?? 'v2';
if (mode !== 'legacy' && mode !== 'v2') throw new Error('SIM_AGENT_MODE 必须为 legacy 或 v2');
if (mode === 'v2' && loadPromptApproval() !== brainPromptManifest().hash) {
  console.log('V2 提示词待审阅：docs/brain-prompts-review.md。尚未启用模型请求，停止/暂停仍可用。');
}
const identity = createHash('sha256').update(JSON.stringify([process.env.MC_HOST ?? '127.0.0.1', process.env.MC_PORT ?? '25565',
  process.env.MC_USERNAME ?? 'SIMCompanion', process.env.MC_AUTH ?? 'microsoft'])).digest('hex').slice(0, 24);
const runtime = new CompanionRuntime(bot, { owners, diagnostics, agentMode: mode,
  knowledgeScope:`${identity}:${process.env.MC_WORLD_ID ?? 'default-world'}`,
  ...(mode === 'v2' ? { agent: { store: new FileAgentStore(resolve('runtime', `agent-${identity}.jsonl`)) } } : {}) });
let started = false;

bot.on('spawn', () => {
  if (started) return;
  started = true;
  runtime.start();
  console.log(`决策模式=${runtime.agentMode}${mode === 'v2' ? '（实验模式：持续目标与基本动作；尚未实机验收）' : ''}`);
  console.log(`已出生；owner=${owners.length ? owners.join(',') : '开发模式（所有人）'}`);
  console.log(runtime.llmInfo
    ? `LLM=${runtime.llmInfo.provider}/${runtime.llmInfo.model}`
    : 'LLM=未配置，仅安全控制可用');
  console.log('在游戏聊天里说“过来”“跟着我”“背包里有什么”或“停”。');
});
bot.on('error', error => { diagnostics.emit('runtime', 'error', '游戏连接异常', error); console.error('连接错误：', error.message); });
bot.on('kicked', reason => { diagnostics.emit('runtime', 'error', '服务器断开连接', reason); console.error('被服务器断开：', reason); });
bot.on('end', () => {
  runtime.stop();
  started = false;
});
