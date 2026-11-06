import { resolve } from 'node:path';
import { DiagnosticBus } from '../src/diagnostics.js';
import { startDiagnosticServer } from '../src/diagnostic-server.js';
import { spawn } from 'node:child_process';

const bus = new DiagnosticBus({ file: resolve('logs/diagnostics.jsonl'), readOnly: true });
const server = await startDiagnosticServer(bus, { port: Number(process.env.SIM_DIAGNOSTICS_PORT ?? 4318) });
console.log(`SIM 诊断台：${server.url}`);
console.log('只读跟踪 logs/diagnostics.jsonl；没有连接游戏服务器。启动新版伙伴后会显示真实记录。');
if (process.platform === 'win32' && process.env.SIM_DIAGNOSTICS_OPEN_BROWSER === '1') {
  const browser = spawn('cmd.exe', ['/d', '/c', 'start', '', server.url], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => console.log('请在浏览器手动打开上方地址。')); browser.unref();
}
process.on('SIGINT', () => { void server.close().then(() => process.exit(0)); });
