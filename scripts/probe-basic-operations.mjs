// Read-only real-server probe. No chat, movement controls, consumption or block writes.
import fs from 'node:fs';
import mineflayer from 'mineflayer';
import { MinecraftActions } from '../dist/src/index.js';

let protocolWarnings = 0;
const originalLog = console.log;
// The installed protocol parser logs skipped packets without emitting errors.
// Record that condition, and avoid printing raw packet contents to the console.
console.log = (...args) => {
  if (typeof args[0] === 'string' && /^(PartialReadError:|Chunk size is )/u.test(args[0])) {
    protocolWarnings++; originalLog('WARN: 协议解码跳过数据包，本次探针不能视为干净通过。'); return;
  }
  originalLog(...args);
};

const config = fs.existsSync('.companion.local.json') ? JSON.parse(fs.readFileSync('.companion.local.json', 'utf8').replace(/^\uFEFF/u, '')) : {};
const auth = process.env.MC_AUTH ?? config.auth ?? 'microsoft';
if (auth !== 'offline') {
  console.log('SKIP: 此只读探针仅用于已配置的离线测试服，不启动账号登录。');
  process.exit(0);
}
const bot = mineflayer.createBot({
  host: process.env.MC_HOST ?? config.host ?? '127.0.0.1',
  port: Number(process.env.MC_PORT ?? config.port ?? 25565),
  username: `SIMP2_${Date.now().toString(36).slice(-6)}`,
  auth: 'offline', version: process.env.MC_VERSION ?? config.version ?? '1.21.1', logErrors: false,
});
let actions;
const result = { kind: 'read_only_server_probe', spawned: false, version: null, targets: null,
  referencesChecked: 0, protocolWarnings: 0, errorCode: null };
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SPAWN_TIMEOUT')), 12_000);
    const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    bot.once('spawn', () => finish());
    bot.once('error', error => finish(new Error(error.code ?? 'CONNECTION_ERROR')));
    bot.once('kicked', () => finish(new Error('KICKED')));
    bot.once('end', () => finish(new Error('CONNECTION_ENDED')));
  });
  result.spawned = true; result.version = bot.version;
  actions = new MinecraftActions(bot);
  let chunksTimer;
  try {
    await Promise.race([bot.waitForChunksToLoad(), new Promise((_, reject) => {
      chunksTimer = setTimeout(() => reject(new Error('CHUNKS_TIMEOUT')), 5_000);
    })]);
  } finally { clearTimeout(chunksTimer); }
  const observation = actions.query({ type: 'observe_targets', placements: true, limit: 8 });
  if (observation.status !== 'succeeded') throw new Error('TARGET_QUERY_FAILED');
  result.targets = observation.data.targets.length;
  for (const target of observation.data.targets) {
    actions.observations.targets.resolve(target.ref, [target.kind]); result.referencesChecked++;
  }
  if (result.referencesChecked === 0) throw new Error('NO_REFERENCE_CANDIDATES');
  if (protocolWarnings) throw new Error('PROTOCOL_DECODE_WARNING');
  console.log('PASS: 真实客户端出生、目标查询及引用复查；没有执行写操作。');
} catch (error) {
  result.errorCode = /^[A-Z_]+$/.test(error.message) ? error.message : 'PROBE_FAILED';
  process.exitCode = 1;
  console.log(`未通过: ${result.errorCode}；完整操作任务未验证。`);
} finally {
  actions?.dispose(); bot.quit();
  result.protocolWarnings = protocolWarnings;
  fs.mkdirSync('logs', { recursive: true });
  fs.writeFileSync('logs/basic-operations-probe.json', JSON.stringify(result, null, 2) + '\n');
  // Some protocol connection failures retain their own timers after end().
  bot.end();
  console.log = originalLog;
  setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
}
