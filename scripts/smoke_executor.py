"""Real-server integration test; requires the separate administrative fixture.

This client cannot issue console commands, give items, or teleport.
Evidence is saved to runtime/executor-smoke.json even on failure.
"""
import asyncio
import contextlib
import datetime as dt
import json
import math
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[1]


class Probe:
    def __init__(self):
        self.pending = {}
        self.events = asyncio.Queue()
        self.evidence = []
        self.seq = 0

    async def start(self):
        config = json.loads((ROOT / 'config.json').read_text())
        config['minecraft']['username'] = 'Test' + str(int(time.time()))[-6:]
        self.config = ROOT / 'runtime' / 'smoke-config.json'
        self.config.write_text(json.dumps(config))
        self.stderr = (ROOT / 'runtime' / 'executor-smoke.stderr.log').open('w')
        self.proc = await asyncio.create_subprocess_exec(
            'node', 'executor/server.js', '--config', str(self.config), cwd=ROOT,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=self.stderr)
        self.reader = asyncio.create_task(self.read())
        async with asyncio.timeout(45):
            while True:
                event = await self.events.get()
                if event.get('event') == 'ready':
                    break
        await asyncio.sleep(1)

    async def read(self):
        try:
            while line := await self.proc.stdout.readline():
                msg = json.loads(line)
                self.evidence.append({'direction': 'recv', 'data': msg})
                if 'id' in msg:
                    fut = self.pending.get(msg['id'])
                    if fut and not fut.done():
                        fut.set_result(msg)
                else:
                    await self.events.put(msg)
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError('Executor exited'))

    async def call(self, op, args=None, timeout=20, reject=False):
        self.seq += 1
        key = str(self.seq)
        fut = asyncio.get_running_loop().create_future()
        self.pending[key] = fut
        req = {'id': key, 'op': op, 'args': args or {}}
        self.evidence.append({'direction': 'send', 'data': req})
        self.proc.stdin.write((json.dumps(req) + '\n').encode())
        await self.proc.stdin.drain()
        try:
            result = await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(key, None)
        if reject:
            assert not result['ok'], result
        else:
            assert result['ok'], result
        return result.get('result', result.get('error'))

    async def action(self, kind, **args):
        result = await self.call('act', {'kind': kind, **args})
        key = result['action_id']
        async with asyncio.timeout(150):
            while True:
                state = await self.call('action_status', {'action_id': key})
                if state['status'] != 'running':
                    assert state['status'] == 'succeeded', state
                    return state
                await asyncio.sleep(0.2)

    async def close(self):
        if hasattr(self, 'proc'):
            with contextlib.suppress(Exception):
                await self.call('shutdown', timeout=3)
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.proc.wait(), 5)
            if self.proc.returncode is None:
                self.proc.kill()
                await self.proc.wait()
            await self.reader
            self.stderr.close()


def count(state, item):
    return sum(x['count'] for x in state['inventory'] if x['name'] == item)


async def main():
    probe = Probe()
    checks = []
    result = {'started_at': dt.datetime.now(dt.timezone.utc).isoformat(),
              'type': 'deterministic native actions, not an autonomous LLM benchmark',
              'fixture': 'scripts/fixture_commands.txt', 'checks': checks}
    try:
        await probe.start()
        before = await probe.call('observe')
        assert before['connected']
        checks.append('observe: connected with world/time/inventory')
        found = await probe.call('find_blocks', {'names': ['minecraft:oak_log'], 'radius': 24, 'limit': 8})
        assert len(found['blocks']) >= 2, found
        checks.append('find_blocks: actual loaded oak logs')
        await probe.call('say', {'message': '/give @s diamond'}, reject=True)
        checks.append('say: console command rejected')
        await probe.call('inspect_container', {'position': {'x': 0, 'y': -60, 'z': 10}}, reject=True)
        checks.append('inspect: air is rejected, never reported as empty chest')
        await probe.action('goto', position={'x': 1, 'y': -60, 'z': 2}, range=1)
        after = await probe.call('observe')
        assert math.dist(list(after['position'].values()), [1, -60, 2]) <= 2
        checks.append('goto: final coordinates verified')
        # Observe/action/status must stay available while a move is in progress.
        move = await probe.call('act', {'kind': 'goto', 'position': {'x': 100, 'y': -60, 'z': 100}, 'range': 1})
        await probe.call('observe', timeout=2)
        await probe.call('stop', timeout=3)
        for _ in range(30):
            state = await probe.call('action_status', {'action_id': move['action_id']})
            if state['status'] != 'running':
                break
            await asyncio.sleep(0.1)
        assert state['status'] == 'cancelled', state
        await asyncio.sleep(0.5)
        stopped = await probe.call('observe')
        await asyncio.sleep(0.7)
        stopped2 = await probe.call('observe')
        assert math.dist(list(stopped['position'].values()), list(stopped2['position'].values())) < 0.3
        checks.append('stop: immediate cancellation, no continued movement')
        await probe.action('collect', block='minecraft:oak_log', count=2)
        after = await probe.call('observe')
        assert count(after, 'minecraft:oak_log') - count(before, 'minecraft:oak_log') == 2, after
        checks.append('collect: two normal blocks mined and picked up')
        await probe.action('craft', item='minecraft:oak_planks', count=4)
        after = await probe.call('observe')
        assert count(after, 'minecraft:oak_planks') == 4, after
        checks.append('craft: real recipe produced four planks')
        pos = {'x': 4, 'y': -60, 'z': 0}
        await probe.action('deposit', position=pos, item='minecraft:oak_planks', count=4)
        assert count(await probe.call('observe'), 'minecraft:oak_planks') == 0
        box = await probe.call('inspect_container', {'position': pos})
        assert any(x['name'] == 'minecraft:oak_planks' and x['count'] == 4 for x in box['items']), box
        checks.append('deposit/inspect: chest has all four planks')
        await probe.action('withdraw', position=pos, item='minecraft:oak_planks', count=2)
        assert count(await probe.call('observe'), 'minecraft:oak_planks') == 2
        checks.append('withdraw: two planks transferred to inventory')
        await probe.action('craft', item='minecraft:oak_planks', count=4)
        await probe.action('craft', item='minecraft:stick', count=4)
        await probe.action('craft', item='minecraft:wooden_pickaxe', count=1)
        assert count(await probe.call('observe'), 'minecraft:wooden_pickaxe') == 1
        checks.append('crafting table: 3x3 recipe produced a wooden pickaxe')
        await probe.action('withdraw', position=pos, item='minecraft:raw_iron', count=1)
        await probe.action('withdraw', position=pos, item='minecraft:coal', count=1)
        await probe.action('smelt', position={'x': 6, 'y': -60, 'z': 0}, input='minecraft:raw_iron',
                           fuel='minecraft:coal', input_count=1, fuel_count=1, wait_seconds=25)
        after = await probe.call('observe')
        assert count(after, 'minecraft:iron_ingot') == 1, after
        checks.append('smelt: real furnace output iron ingot retrieved')
        # Requesting unavailable items must fail rather than report zero transfer success.
        bad = await probe.call('act', {'kind': 'withdraw', 'position': pos, 'item': 'minecraft:diamond', 'count': 1})
        for _ in range(150):
            state = await probe.call('action_status', {'action_id': bad['action_id']})
            if state['status'] != 'running':
                break
            await asyncio.sleep(0.1)
        assert state['status'] == 'failed', state
        checks.append('zero transfer: unavailable diamond fails')
        result['status'] = 'passed'
        print(json.dumps({'status': 'passed', 'checks': checks}, ensure_ascii=False, indent=2))
    except BaseException as exc:
        result.update(status='failed', error=f'{type(exc).__name__}: {exc}')
        raise
    finally:
        await probe.close()
        result['protocol'] = probe.evidence
        (ROOT / 'runtime' / 'executor-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
