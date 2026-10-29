import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { access } from 'node:fs/promises';
import { createCodexModelLister, normalizeCodexModel } from '../bridge/providers/codex-models.mjs';

const model = (id, extra = {}) => ({ id: `internal-${id}`, model: id, displayName: `Name ${id}`, inputModalities: ['text'], ...extra });
const respond = (child, id, result) => child.stdout.write(JSON.stringify({ id, result }) + '\n');

function setup(onModels, { login = 'Logged in using ChatGPT', timeoutMs = 1000, onInitialize, onServer, closeOnEof = true } = {}) {
  const calls = [];
  const messages = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    const isServer = args.includes('app-server');
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const text = bytes.toString();
      if (isServer) {
        for (const line of text.trim().split('\n').filter(Boolean)) {
          const message = JSON.parse(line);
          messages.push(message);
          queueMicrotask(() => {
            if (message.method === 'initialize') {
              if (onInitialize) onInitialize(child, message); else respond(child, message.id, { userAgent: 'not returned to caller' });
            } else if (message.method === 'model/list') onModels(child, message);
          });
        }
      }
      done();
    } });
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (!isServer) { child.stderr.write(login); child.emit('close', 0); }
      else if (closeOnEof) child.emit('close', 0);
    }));
    calls.push({ command, args, options, child });
    if (isServer) queueMicrotask(() => onServer?.(child));
    return child;
  };
  const list = createCodexModelLister({
    spawnImpl, platform: 'linux', timeoutMs,
    env: { PATH: '/usr/bin', HOME: '/home/example', OPENAI_API_KEY: 'secret', CODEX_ACCESS_TOKEN: 'secret' },
    resolveCommand: async () => ({ command: '/official/codex', prefix: [] }),
  });
  return { list, calls, messages };
}

test('catalog handshake sends only initialize, initialized and correlated model/list requests', async () => {
  const { list, calls, messages } = setup((child, request) => {
    respond(child, 999, { data: [model('wrong-id-model')], nextCursor: null });
    child.stdout.write(JSON.stringify({ method: 'account/updated', params: { email: 'private@example.invalid' } }) + '\n');
    const json = JSON.stringify({ id: request.id, result: { data: [model('chosen-model', { isDefault: true })], nextCursor: null } });
    child.stdout.write(json.slice(0, 18));
    child.stdout.write(json.slice(18) + '\n');
  });
  assert.deepEqual(await list(), [{ id: 'chosen-model', name: 'Name chosen-model', isDefault: true }]);
  assert.deepEqual(messages.map(message => message.method), ['initialize', 'initialized', 'model/list']);
  assert.deepEqual(messages[2].params, { limit: 100, includeHidden: false });
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.windowsHide, true);
  assert.equal(calls[1].options.env.OPENAI_API_KEY, undefined);
  assert.equal(calls[1].options.env.CODEX_ACCESS_TOKEN, undefined);
  assert.ok(calls[1].args.includes('--no-daemon'));
  assert.ok(calls[1].args.includes('forced_login_method="chatgpt"'));
  assert.ok(!calls[1].args.includes('--startup-sign-out'));
  await assert.rejects(access(calls[1].options.cwd), { code: 'ENOENT' });
});

test('pagination passes opaque cursor, deduplicates by model and filters hidden/non-text/unsafe IDs', async () => {
  const { list, messages } = setup((child, request) => {
    if (!request.params.cursor) respond(child, request.id, {
      data: [model('same'), model('hidden', { hidden: true }), model('audio', { inputModalities: ['audio'] }), model('unsafe id')],
      nextCursor: 'opaque-page-2',
    });
    else respond(child, request.id, {
      data: [model('same', { isDefault: true }), model('older', { inputModalities: undefined, description: ' Summary\nwith controls\u0000 ' })],
      nextCursor: null,
    });
  });
  assert.deepEqual(await list(), [
    { id: 'same', name: 'Name same', isDefault: true },
    { id: 'older', name: 'Name older', description: 'Summary with controls' },
  ]);
  assert.equal(messages.filter(message => message.method === 'model/list')[1].params.cursor, 'opaque-page-2');
});

test('five-page and 500-model bounds prevent unbounded pagination', async () => {
  let page = 0;
  const { list, messages } = setup((child, request) => {
    const current = page++;
    respond(child, request.id, { data: Array.from({ length: 100 }, (_, i) => model(`model-${current}-${i}`)), nextCursor: `page-${page}` });
  });
  assert.equal((await list()).length, 500);
  assert.equal(messages.filter(message => message.method === 'model/list').length, 5);
});

test('repeated pagination cursor is rejected', async () => {
  const { list } = setup((child, request) => respond(child, request.id, { data: [model('same')], nextCursor: 'loop' }));
  await assert.rejects(list(), /ページ情報が不正/);
});

test('API login is rejected before app-server starts and leaves existing login untouched', async () => {
  const { list, calls } = setup(() => {}, { login: 'Logged in using an API key' });
  await assert.rejects(list(), /ChatGPTログインが必要/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--no-daemon', 'login', 'status']);
  await assert.rejects(access(calls[0].options.cwd), { code: 'ENOENT' });
});

test('catalog errors are sanitized and do not expose provider diagnostics', async () => {
  const { list } = setup((child, request) => child.stdout.write(JSON.stringify({ id: request.id, error: {
    message: 'private token secret-value and private@example.invalid',
  } }) + '\n'));
  await assert.rejects(list(), error => /取得できません/.test(error.message) && !/secret-value|private@/.test(error.message));
});

test('server-initiated action requests are not answered or executed', async () => {
  const { list, messages } = setup((child) => child.stdout.write(JSON.stringify({ id: 'server-request', method: 'item/commandExecution/requestApproval', params: {} }) + '\n'));
  await assert.rejects(list(), /一覧以外の要求/);
  assert.deepEqual(messages.map(message => message.method), ['initialize', 'initialized', 'model/list']);
});

test('malformed response and missing text-capable catalog do not produce static fallback models', async () => {
  const malformed = setup(child => child.stdout.write('this is not json\n'));
  await assert.rejects(malformed.list(), /応答が不正/);
  const empty = setup((child, request) => respond(child, request.id, { data: [model('audio', { inputModalities: ['audio'] })] }));
  await assert.rejects(empty.list(), /使えるモデルが見つかりません/);
});

test('output budget bounds malformed or excessive server output', async () => {
  const { list } = setup(child => child.stdout.write('x'.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(list(), /サイズ上限/);
});

test('abort kills owned app-server and removes temporary directory', async () => {
  const controller = new AbortController();
  const { list, calls } = setup(() => controller.abort());
  await assert.rejects(list({ signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(access(calls[1].options.cwd), { code: 'ENOENT' });
});

test('whole-operation timeout includes a stalled initialization', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const { list, calls } = setup(() => {}, { onInitialize: () => {}, timeoutMs: 20 });
    await assert.rejects(list(), /タイムアウト/);
    await assert.rejects(access(calls[1].options.cwd), { code: 'ENOENT' });
  } finally { clearInterval(keepAlive); }
});

test('pre-aborted requests do not start a process', async () => {
  const controller = new AbortController();
  controller.abort();
  const { list, calls } = setup(() => {});
  await assert.rejects(list({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('model output uses only safe catalog fields and at most 100 ASCII ID characters', () => {
  assert.equal(normalizeCodexModel(model('a'.repeat(101))), null);
  assert.equal(normalizeCodexModel(model('日本語-model')), null);
  assert.equal(normalizeCodexModel(model('-option')), null);
  assert.deepEqual(normalizeCodexModel(model('safe-model', { displayName: '\u202e\n', authToken: 'never-return' })), { id: 'safe-model', name: 'safe-model' });
});
