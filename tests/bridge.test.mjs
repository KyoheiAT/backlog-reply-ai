import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from '../bridge/server.mjs';

const extensionId = 'a'.repeat(32);
const headers = { 'X-Backlog-Extension': extensionId, 'Content-Type': 'application/json' };
async function setup(t, options = {}) {
  const server = createBridge({ extensionId, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function submit(base, body = { provider: 'copilot', prompt: '確認をお願いします。' }) {
  return fetch(`${base}/jobs`, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function result(base, id) {
  for (let n = 0; n < 100; n++) {
    const body = await (await fetch(`${base}/jobs/${id}`, { headers })).json();
    if (body.status !== 'running') return body;
    await delay(5);
  }
  throw new Error('job did not finish');
}

test('requires a real extension ID and restricts requests, hosts and preflight origins', async t => {
  assert.throws(() => createBridge({ extensionId: '*' }), /拡張/);
  let calls = 0;
  const base = await setup(t, { generate: async () => { calls++; return 'x'; } });
  assert.equal((await fetch(`${base}/health`)).status, 403);
  assert.equal((await fetch(`${base}/health`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/health`, { headers: { ...headers, Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await fetch(`${base}/health`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
  const preflight = await fetch(`${base}/jobs`, { method: 'OPTIONS', headers: { Origin: `chrome-extension://${extensionId}` } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), `chrome-extension://${extensionId}`);
  assert.equal((await fetch(`${base}/health`, { headers })).status, 200);
  assert.equal(calls, 0);
});

test('polling routes only the selected provider and preserves Japanese blank lines', async t => {
  const inputs = [];
  const base = await setup(t, { generate: async input => { inputs.push(input); return 'ご確認ください。\n\nよろしくお願いいたします。'; } });
  for (const provider of ['copilot', 'codex']) {
    const response = await submit(base, { provider, model: 'test-model', prompt: '課題の参考情報' });
    assert.equal(response.status, 202);
    const { id } = await response.json();
    const completed = await result(base, id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.text, 'ご確認ください。\n\nよろしくお願いいたします。');
  }
  assert.deepEqual(inputs.map(x => x.provider), ['copilot', 'codex']);
  assert.ok(inputs.every(x => x.model === 'test-model' && x.prompt.endsWith('課題の参考情報')));
});

test('invalid and oversized input never starts an AI request', async t => {
  let calls = 0;
  const base = await setup(t, { generate: async () => { calls++; return 'x'; } });
  for (const body of [null, {}, { provider: 'other', prompt: 'x' }, { provider: 'codex', prompt: '' },
    { provider: 'codex', prompt: 'x', model: 'x;echo bad' }, { provider: 'copilot', prompt: 'x'.repeat(180001) }]) {
    assert.equal((await submit(base, body)).status, 400);
  }
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST', headers: { 'X-Backlog-Extension': extensionId }, body: 'text' })).status, 415);
  assert.equal((await submit(base, { provider: 'codex', prompt: 'x'.repeat(1024 * 1024) })).status, 413);
  assert.equal(calls, 0);
});

test('provider errors and blank output are failed jobs without a second provider call', async t => {
  let calls = 0;
  const base = await setup(t, { generate: async () => { calls++; if (calls === 1) throw new Error('ログインしてください。'); return ' '; } });
  const first = await (await submit(base)).json();
  assert.deepEqual(await result(base, first.id), { status: 'failed', error: 'ログインしてください。' });
  const second = await (await submit(base)).json();
  assert.match((await result(base, second.id)).error, /返信本文/);
  assert.equal(calls, 2);
});

test('generation timeout aborts the provider and returns a terminal state', async t => {
  let aborted = false;
  const base = await setup(t, { timeoutMs: 20, generate: ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  }) });
  const { id } = await (await submit(base)).json();
  assert.equal((await result(base, id)).status, 'failed');
  assert.equal(aborted, true);
});

test('bounded parallel generation and expiration', async t => {
  // Advance only the expiry clock so a busy test runner cannot expire a job
  // before its completed response is asserted.
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const pending = [];
  const base = await setup(t, { ttlMs: 20, generate: () => new Promise(resolve => pending.push(resolve)) });
  const one = await (await submit(base)).json();
  await submit(base);
  assert.equal((await submit(base)).status, 429);
  for (const resolve of pending) resolve('完了');
  assert.equal((await result(base, one.id)).status, 'completed');
  now += 40;
  assert.equal((await fetch(`${base}/jobs/${one.id}`, { headers })).status, 404);
});
