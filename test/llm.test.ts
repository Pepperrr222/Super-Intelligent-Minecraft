import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleClient } from '../src/llm.js';

test('OpenAI-compatible client sends a chat request and returns content', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"kind":"reply","text":"ok"}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const client = new OpenAiCompatibleClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.test/v1/',
    model: 'test-model',
    fetcher,
  });

  const content = await client.complete({ system: 'system', user: 'hello' });

  assert.equal(content, '{"kind":"reply","text":"ok"}');
  assert.equal(seenUrl, 'https://api.example.test/v1/chat/completions');
  assert.equal((seenInit?.headers as Record<string, string>).authorization, 'Bearer test-key');
  const body = JSON.parse(String(seenInit?.body));
  assert.equal(body.model, 'test-model');
  assert.equal(body.messages[0].content, 'system');
  assert.equal(body.messages[1].content, 'hello');
});

test('OpenAI-compatible client reports HTTP failures without leaking the key', async () => {
  const fetcher = (async () => new Response('nope', { status: 401 })) as typeof fetch;
  const client = new OpenAiCompatibleClient({
    apiKey: 'test-secret-key',
    baseUrl: 'https://api.example.test',
    model: 'test-model',
    fetcher,
  });

  await assert.rejects(() => client.complete({ system: 's', user: 'u' }), (error: unknown) => {
    assert.match(String(error), /LLM_HTTP_401/);
    assert.doesNotMatch(String(error), /test-secret-key/);
    return true;
  });
});
