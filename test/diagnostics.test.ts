import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { DiagnosticBus, diagnosticData } from '../src/diagnostics.js';
import { startDiagnosticServer } from '../src/diagnostic-server.js';
import { CompanionRuntime } from '../src/runtime.js';
import { fixture, tick } from './fixtures.js';

test('diagnostic records redact credentials before memory and disk and survive viewer reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-diagnostics-'));
  try {
    const file = join(dir, 'events.jsonl'), bus = new DiagnosticBus({ file });
    bus.message('alice', '捡木头', () => bus.emit('model', 'ok', 'response', { apiKey: 'private-key', raw: '{"apiKey":"another-secret"}', text: 'sk-verysecret123456789', nbt: { hidden: true } }));
    for (const content of [JSON.stringify(bus.snapshot()), readFileSync(file, 'utf8')]) {
      assert.ok(!content.includes('private-key')); assert.ok(!content.includes('another-secret')); assert.ok(!content.includes('sk-verysecret'));
    }
    const viewer = new DiagnosticBus({ file, readOnly: true });
    assert.equal(viewer.snapshot().events.length, 2);
    bus.emit('runtime', 'info', 'appended');
    assert.equal(viewer.snapshot().events.length, 3);
    assert.ok(JSON.stringify(diagnosticData({ authorization: 'value' })).includes('已脱敏'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('async input and queued task contexts stay correlated without mixing concurrent players', async () => {
  const bus = new DiagnosticBus({ maxEvents: 20 });
  await Promise.all(['alice', 'bob'].map(player => bus.message(player, player, async () => {
    bus.bindTask(player); await tick(); bus.task(player, () => bus.emit('action', 'ok', player));
  })));
  const events = bus.snapshot().events;
  for (const player of ['alice', 'bob']) {
    const input = events.find(e => (e.data as any)?.player === player)!;
    assert.equal(events.find(e => e.label === player)?.traceId, input.traceId);
  }
  assert.notEqual(events.find(e => e.label === 'alice')?.traceId, events.find(e => e.label === 'bob')?.traceId);
});

test('span reports errors and cancellation without changing operation results; memory is bounded', async () => {
  const bus = new DiagnosticBus({ maxEvents: 3 });
  const result = { status: 'cancelled', error: { code: 'CANCELLED' } };
  assert.equal(await bus.span('action', 'operation', {}, async () => result), result);
  assert.equal(bus.snapshot().events.at(-1)?.state, 'cancelled');
  await assert.rejects(bus.span('model', 'call', {}, async () => { throw new Error('LLM_TIMEOUT'); }));
  assert.equal(bus.snapshot().events.length, 3);
  assert.equal(bus.snapshot().events.at(-1)?.state, 'error');
});

test('read-only HTTP viewer serves actual events, rejects mutation and cross-origin access', async () => {
  const bus = new DiagnosticBus(); bus.emit('runtime', 'ok', 'test');
  const server = await startDiagnosticServer(bus, { port: 0 });
  try {
    const html = await (await fetch(server.url)).text(); assert.ok(html.includes('运行诊断台')); assert.ok(html.includes('演示数据'));
    const data = await (await fetch(server.url + '/api/events')).json() as any;
    assert.equal(data.events[0].label, 'test');
    assert.equal((await fetch(server.url + '/api/events', { method: 'POST' })).status, 405);
    assert.equal((await fetch(server.url + '/api/events', { headers: { origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await fetch(server.url + '/api/events?after=bad')).status, 400);
  } finally { await server.close(); }
});

test('runtime trace exposes original request, wrong skill selection, execution and continuation denial', async () => {
  const { bot, actions } = fixture('1.21.1'); actions.dispose();
  bot.chat = () => {}; bot.whisper = () => {};
  bot.entities[7] = { id: 7, username: 'alice', position: new Vec3(2, 0, 0) };
  bot.pathfinder.goto = async () => { bot.entity.position = new Vec3(2, 0, 0); };
  const bus = new DiagnosticBus();
  const runtime = new CompanionRuntime(bot, { agentMode: 'legacy', owners: ['alice'], diagnostics: bus,
    llm: { complete: async () => JSON.stringify({ kind: 'skill', skill: 'come_to_player', params: {} }) } });
  try {
    await runtime.interaction.handle({ id: 'test', player: 'alice', text: '过来捡一下木头', receivedAt: Date.now() });
    for (let i = 0; i < 50 && !bus.snapshot().events.some(e => e.stage === 'dispatch' && e.state === 'blocked'); i++) await tick();
    const events = bus.snapshot().events;
    for (const stage of ['input', 'model', 'validation', 'scheduler', 'controller', 'action', 'feedback', 'reply', 'dispatch']) assert.ok(events.some(e => e.stage === stage), stage);
    const input = events.find(e => e.stage === 'input')!;
    assert.ok(events.filter(e => e.stage !== 'runtime').every(e => e.traceId === input.traceId));
    assert.equal((events.find(e => e.stage === 'validation' && (e.data as any)?.kind === 'skill')?.data as any)?.skill, 'come_to_player');
    assert.equal((events.find(e => e.stage === 'dispatch' && e.state === 'blocked')?.data as any)?.code, 'CONTINUATION_DENIED');
  } finally { runtime.stop(); }
});
