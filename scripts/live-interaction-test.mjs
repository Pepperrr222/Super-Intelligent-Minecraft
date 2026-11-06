import mineflayer from 'mineflayer';
import { CompanionRuntime } from '../dist/src/index.js';

const HOST = process.env.MC_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MC_PORT ?? 25565);
const VERSION = process.env.MC_VERSION ?? '1.21.1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const chat = [];
let failures = 0;

function record(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

function skip(label, detail = '') {
  console.log(`SKIP  ${label}${detail ? `  ${detail}` : ''}`);
}

function connect(username) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({
      host: HOST,
      port: PORT,
      username,
      auth: 'offline',
      version: VERSION,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        bot.quit();
        reject(new Error(`${username} 未在 15 秒内出生`));
      }
    }, 15_000);
    bot.once('spawn', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(bot);
    });
    bot.on('chat', (user, message) => {
      if (user !== username) chat.push({ user, message, at: Date.now() });
    });
    bot.on('error', error => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      } else {
        console.error(`${username} error: ${error.message}`);
      }
    });
    bot.on('kicked', reason => console.error(`${username} kicked: ${String(reason)}`));
    bot.on('end', reason => console.log(`${username} disconnected: ${String(reason)}`));
  });
}

async function expect(mark, test, label, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = chat.slice(mark).find(entry => test(entry.message));
    if (found) {
      record(true, label, `<- ${found.message}`);
      return found;
    }
    await sleep(100);
  }
  record(false, label, `(timeout; last messages: ${chat.slice(mark).map(e => e.message).join(' | ') || 'none'})`);
  return undefined;
}

async function command(probe, text, mark) {
  console.log(`\n> ${text}`);
  probe.chat(text);
  return mark;
}

const companion = await connect('SimTest');
const probe = await connect('SimProbe');
const runtime = new CompanionRuntime(companion, {
  owners: ['SimProbe'],
  autoRun: true,
  rateLimit: { windowMs: 10_000, max: 50 },
});

try {
  runtime.start();
  console.log(`connected; bot=${companion.username}; probe=${probe.username}; LLM=${runtime.llmInfo ? `${runtime.llmInfo.provider}/${runtime.llmInfo.model}` : 'none'}`);
  await sleep(1_500);

  let mark = chat.length;
  await command(probe, '你好', mark);
  await expect(mark, m => m.startsWith('@SimProbe') && m.includes('你好'), '中文问候走 brain 聊天');

  mark = chat.length;
  await command(probe, '背包里有什么', mark);
  await expect(mark, m => m.startsWith('@SimProbe') && m.includes('背包'), '背包查询走只读 observation');

  mark = chat.length;
  await command(probe, "what's in your backpack", mark);
  await expect(mark, m => m.startsWith('@SimProbe') && m.includes('背包'), '英文 backpack 查询走只读 observation');

  mark = chat.length;
  await command(probe, '你背包里有什么食物', mark);
  await expect(mark, m => m.startsWith('@SimProbe') && !m.includes('chest') && (m.includes('没有食物') || m.includes('bread') || m.includes('apple')), '食物查询只返回食物，不把 chest 当食物');

  mark = chat.length;
  await command(probe, '跟着我', mark);
  await expect(mark, m => m.includes('跟着你'), '中文 follow 技能');

  const before = companion.entity.position.clone();
  const probeBefore = probe.entity.position.clone();
  probe.setControlState('forward', true);
  probe.setControlState('jump', true);
  await sleep(1_500);
  probe.setControlState('jump', false);
  probe.setControlState('forward', false);
  await sleep(1_500);
  const moved = companion.entity.position.distanceTo(before);
  const probeMoved = probe.entity.position.distanceTo(probeBefore);
  if (probeMoved < 0.5) {
    skip('follow 实际移动（测试玩家未移动，Bot 可能已在 2 格内；仅验证路由/回执）', `probeMoved=${probeMoved.toFixed(2)} blocks`);
  } else {
    record(moved > 0.5, 'follow 让 Bot 实际移动', `moved=${moved.toFixed(2)} blocks, probeMoved=${probeMoved.toFixed(2)} blocks`);
  }

  mark = chat.length;
  await command(probe, '停', mark);
  await expect(mark, m => m.includes('已停'), 'stop 快路径');

  const p = probe.entity.position;
  const target = { x: Math.floor(p.x) + 3, y: Math.floor(p.y), z: Math.floor(p.z) };
  mark = chat.length;
  await command(probe, `走到坐标 ${target.x} ${target.y} ${target.z}`, mark);
  await expect(mark, m => m.includes('开始导航'), '坐标导航技能');
  await sleep(2_000);
  const distance = companion.entity.position.distanceTo(target);
  record(distance < 4, 'navigate 到达附近', `distance=${distance.toFixed(2)} blocks`);

  mark = chat.length;
  await command(probe, 'follow me', mark);
  await expect(mark, m => m.includes('跟着你'), '英文 follow 同义入口');

  mark = chat.length;
  await command(probe, '停', mark);
  await expect(mark, m => m.includes('已停'), '停止英文 follow');

  mark = chat.length;
  await command(probe, '建个房子', mark);
  await expect(mark, m => m.includes('收到，我先规划一下'), '复杂目标先回执');
  await expect(mark, m => m.includes('建造') || m.includes('复杂任务规划'), '无建造技能时澄清', 8_000);

  mark = chat.length;
  await command(probe, '停', mark);
  await expect(mark, m => m.includes('已停'), '最终停止');
} finally {
  runtime.stop();
  await sleep(300);
  probe.quit();
  companion.quit();
  await sleep(500);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
