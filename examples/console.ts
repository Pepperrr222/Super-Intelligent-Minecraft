import mineflayer from 'mineflayer';
import { createInterface } from 'node:readline';
import { MinecraftActions } from '../src/index.js';

const bot = mineflayer.createBot({
  host: process.env.MC_HOST ?? '127.0.0.1',
  port: Number(process.env.MC_PORT ?? 25565),
  username: process.env.MC_USERNAME ?? 'SIMCompanion',
  auth: process.env.MC_AUTH === 'offline' ? 'offline' : 'microsoft',
  profilesFolder: '.auth',
  ...(process.env.MC_VERSION ? { version:process.env.MC_VERSION } : {})
});
const actions = new MinecraftActions(bot);
bot.on('spawn', () => console.log('已出生。输入 JSON 动作；observe 查看状态；stop 停止；quit 退出。'));
bot.on('error', e => console.error('连接错误：',e.message));
bot.on('kicked', reason => console.error('被服务器断开：',reason));
const input = createInterface({ input:process.stdin, output:process.stdout });
input.on('line', line => {
  if (line==='stop') { actions.stop(); return; }
  if (line==='observe') { console.log(JSON.stringify(actions.observe(),null,2)); return; }
  if (line==='quit') { input.close(); return; }
  try {
    const parsed = JSON.parse(line);
    if (parsed.query) console.log(JSON.stringify(actions.query(parsed.query)));
    else void actions.execute(parsed).then(r => console.log(JSON.stringify(r)));
  }
  catch (error) { console.error('请输入有效 JSON：',String(error)); }
});
input.on('close', () => { actions.dispose(); bot.quit(); });
bot.on('end', () => input.close());
