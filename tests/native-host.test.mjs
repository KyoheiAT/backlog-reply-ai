import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { GUARD } from '../bridge/server.mjs';
import { createNativeHost, encodeNativeMessage, MAX_MESSAGE_BYTES, parseNativeArguments, validateCaller } from '../bridge/native-host.mjs';

const extensionId = 'a'.repeat(32);
const callerOrigin = `chrome-extension://${extensionId}/`;
const request = (id, extra = {}) => ({ id, type: 'generate', provider: 'copilot', prompt: 'ご確認をお願いします。', ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function rawFrame(body) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset < buffer.length) {
    assert.ok(buffer.length - offset >= 4, 'complete output header');
    const length = buffer.readUInt32LE(offset);
    assert.ok(length > 0 && length <= MAX_MESSAGE_BYTES, 'bounded output length');
    offset += 4;
    assert.ok(buffer.length - offset >= length, 'complete output payload');
    messages.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(offset, offset + length))));
    offset += length;
  }
  return messages;
}
async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error('condition was not met');
}
function setup(t, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const chunks = [];
  let diagnostics = '';
  output.on('data', chunk => chunks.push(chunk));
  errors.on('data', chunk => { diagnostics += chunk.toString('utf8'); });
  const host = createNativeHost({ extensionId, callerOrigin, input, output, errorOutput: errors,
    generate: async () => '返信案です。', cleanupTimeoutMs: 300, ...options });
  t.after(() => host.close());
  const messages = () => decodeFrames(Buffer.concat(chunks));
  return { ...host, input, output, messages, diagnostics: () => diagnostics,
    send: message => input.write(encodeNativeMessage(message)),
    async waitFor(count) { await until(() => messages().length >= count); return messages(); },
  };
}

test('caller origin must exactly match the fixed registered extension ID', () => {
  assert.doesNotThrow(() => validateCaller(extensionId, callerOrigin));
  for (const [id, origin] of [
    ['', callerOrigin], ['z'.repeat(32), callerOrigin], [extensionId, undefined],
    [extensionId, callerOrigin.slice(0, -1)], [extensionId, `${callerOrigin}page.html`],
    [extensionId, `chrome-extension://${'b'.repeat(32)}/`], [extensionId, 'https://example.com/'],
    [extensionId, `${callerOrigin}?origin=trusted`], [extensionId, callerOrigin.toUpperCase()],
  ]) assert.throws(() => validateCaller(id, origin), /登録されたChrome拡張/);
  const input = new PassThrough();
  assert.throws(() => createNativeHost({ extensionId, callerOrigin: 'invalid', input }), /登録されたChrome拡張/);
  assert.equal(input.listenerCount('data'), 0);
});

test('model catalog requests use only the selected lister and return safe bounded fields', async t => {
  const calls = [];
  const host = setup(t, {generate: async () => {throw new Error('must not generate');}, listModels: async input => {
    calls.push(input);
    return [{id: 'model-one', name: '日本語モデル', isDefault: true, secret: 'never-return'},
      {id: 'model-one', name: 'duplicate'}, {id: '../bad?token', name: 'bad'}, {id: 'model-two', description: 'x'.repeat(400)}];
  }});
  for (const provider of ['copilot', 'codex']) host.send({id: provider, type: 'models', provider});
  const replies = await host.waitFor(2);
  assert.deepEqual(calls.map(call => call.provider), ['copilot', 'codex']);
  assert.ok(calls.every(call => Object.keys(call).sort().join(',') === 'provider,signal'));
  for (const reply of replies) {
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.models[0], {id: 'model-one', name: '日本語モデル', isDefault: true});
    assert.equal(reply.models.length, 2);
    assert.equal(reply.models[1].description.length, 300);
  }
});

test('model listing timeout aborts the lister and never invokes generation', async t => {
  let signal;
  const host = setup(t, {modelTimeoutMs: 10, listModels: input => {
    signal = input.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  }});
  host.send({id: 'models', type: 'models', provider: 'copilot'});
  assert.match((await host.waitFor(1))[0].error, /モデル一覧.*タイムアウト/);
  assert.equal(signal.aborted, true);
});

test('agent requests keep MCP credentials out of the reply-only provider and redact errors', async t => {
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'private-test-key', issueKeys: ['TEST-1'], projectKeys: ['TEST']};
  const calls = [];
  const host = setup(t, {generate: async () => {throw new Error('must use agent');}, generateAgent: async input => {
    calls.push(input);
    if (calls.length === 2) throw new Error(`failed: ${input.backlog.apiKey}`);
    return {text: '調査した返信です。', sources: [{title: 'TEST-2', url: `${backlog.origin}/view/TEST-2`}], toolCalls: 2};
  }});
  host.send(request('agent', {mode: 'agent', backlog}));
  const [reply] = await host.waitFor(1);
  assert.equal(reply.text, '調査した返信です。');
  assert.equal(reply.toolCalls, 2);
  assert.equal(calls[0].backlog.apiKey, backlog.apiKey);
  assert.ok(!calls[0].prompt.includes(backlog.apiKey));
  host.send(request('error', {mode: 'agent', backlog}));
  const error = (await host.waitFor(2))[1].error;
  assert.ok(!error.includes(backlog.apiKey));
  assert.match(error, /redacted/);
});

test('progress is opt-in and legacy agent results retain their original frame shape', async t => {
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'synthetic-key', issueKeys: ['TEST-1'], projectKeys: []};
  const calls = [];
  const host = setup(t, {generateAgent: async input => {
    calls.push(input);
    input.onProgress?.({stage: 'planning', step: 1});
    return {text: '完了', sources: [], toolCalls: 0};
  }});
  for (const [index, progress] of [undefined, false].entries()) {
    host.send(request(`legacy-${index}`, {mode: 'agent', backlog, ...(progress === undefined ? {} : {progress})}));
    const reply = (await host.waitFor(index + 1))[index];
    assert.deepEqual(reply, {id: `legacy-${index}`, ok: true, text: '完了', sources: [], toolCalls: 0});
  }
  assert.ok(calls.every(input => !Object.hasOwn(input, 'onProgress')));
});

test('opt-in agent progress uses nonterminal frames followed by the unchanged final result', async t => {
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'synthetic-key', issueKeys: ['TEST-1'], projectKeys: []};
  const stages = ['agent_connecting', 'planning', 'reading', 'read_complete', 'read_failed', 'drafting', 'reply_ready', 'duplicate', 'format_retry'];
  const host = setup(t, {generateAgent: async ({onProgress}) => {
    for (const stage of stages) onProgress({stage});
    return {text: '確認しました。', sources: [], toolCalls: 1};
  }});
  host.send(request('progress-agent', {mode: 'agent', backlog, progress: true}));
  const frames = await host.waitFor(stages.length + 1);
  assert.deepEqual(frames.slice(0, -1), stages.map(stage => ({id: 'progress-agent', type: 'progress', progress: {stage}})));
  assert.deepEqual(frames.at(-1), {id: 'progress-agent', ok: true, text: '確認しました。', sources: [], toolCalls: 1});
});

test('opt-in chat emits only generating before the final result and does not give the provider a callback', async t => {
  const calls = [];
  const host = setup(t, {generate: async input => {calls.push(input); return '返信';}});
  host.send(request('progress-chat', {progress: true}));
  assert.deepEqual(await host.waitFor(2), [
    {id: 'progress-chat', type: 'progress', progress: {stage: 'generating'}},
    {id: 'progress-chat', ok: true, text: '返信'},
  ]);
  assert.equal(Object.hasOwn(calls[0], 'onProgress'), false);
});

test('progress copies only bounded metadata and drops free text, secrets and invalid targets', async t => {
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'SECRET', issueKeys: ['TEST-1'], projectKeys: []};
  const host = setup(t, {generateAgent: async ({onProgress}) => {
    onProgress({stage: 'reading', tool: 'get_issue', target: 'TEST-1', step: 1, toolCalls: 0, sourceCount: 100,
      text: 'private reference SECRET', reasoning: 'private thought', error: 'raw server error SECRET', apiKey: 'SECRET', extra: {secret: 'SECRET'}});
    onProgress({stage: 'planning', tool: 'add_issue', target: 'SECRET-1', step: 0, toolCalls: 7, sourceCount: 101});
    onProgress({stage: 'drafting', target: 'prefixSECRET', step: 8, toolCalls: 6, sourceCount: 0});
    for (const target of ['https://example.backlog.com/view/TEST-1', 'TEST-1\nSECRET', '日本語', 'A'.repeat(121), {}, null]) onProgress({stage: 'reading', target});
    for (const stage of ['arbitrary-text', 'SECRET', null, 1]) onProgress({stage, text: 'private'});
    onProgress({get stage() {throw new Error('SECRET');}});
    return {text: '完了', sources: [], toolCalls: 1};
  }});
  host.send(request('safe-progress', {mode: 'agent', backlog, progress: true}));
  const frames = await host.waitFor(10);
  assert.deepEqual(frames[0].progress, {stage: 'reading', tool: 'get_issue', target: 'TEST-1', step: 1, toolCalls: 0, sourceCount: 100});
  assert.deepEqual(frames[1].progress, {stage: 'planning'});
  assert.deepEqual(frames[2].progress, {stage: 'drafting', step: 8, toolCalls: 6, sourceCount: 0});
  assert.ok(frames.slice(3, 9).every(frame => JSON.stringify(frame.progress) === '{"stage":"reading"}'));
  assert.equal(frames.at(-1).ok, true);
  assert.ok(!JSON.stringify(frames).includes('SECRET'));
  assert.ok(!JSON.stringify(frames).includes('private'));
  assert.equal(host.diagnostics(), '');
});

test('progress is capped at 64 events and callbacks after completion are ignored', async t => {
  let callback;
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'synthetic-key', issueKeys: ['TEST-1'], projectKeys: []};
  const host = setup(t, {generateAgent: async ({onProgress}) => {
    callback = onProgress;
    for (let i = 0; i < 80; i++) onProgress({stage: 'planning', step: 1});
    return {text: '完了', sources: [], toolCalls: 0};
  }});
  host.send(request('bounded-progress', {mode: 'agent', backlog, progress: true}));
  const frames = await host.waitFor(65);
  assert.equal(frames.filter(frame => frame.type === 'progress').length, 64);
  assert.equal(frames.at(-1).ok, true);
  callback({stage: 'reading', target: 'TEST-1'});
  await delay(10);
  assert.equal(host.messages().length, 65);
});

test('progress metadata getters cannot change a checked value into private text', async t => {
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'SECRET', issueKeys: ['TEST-1'], projectKeys: []};
  const host = setup(t, {generateAgent: async ({onProgress}) => {
    const read = {};
    const event = {};
    for (const [name, value] of Object.entries({stage: 'reading', tool: 'get_issue', target: 'TEST-1', step: 1, toolCalls: 0, sourceCount: 1})) {
      Object.defineProperty(event, name, {get() {read[name] = (read[name] || 0) + 1; return read[name] === 1 ? value : 'SECRET';}});
    }
    onProgress(event);
    assert.ok(Object.values(read).every(count => count === 1));
    return {text: '完了', sources: [], toolCalls: 0};
  }});
  host.send(request('snapshot-progress', {mode: 'agent', backlog, progress: true}));
  const frames = await host.waitFor(2);
  assert.deepEqual(frames[0].progress, {stage: 'reading', tool: 'get_issue', target: 'TEST-1', step: 1, toolCalls: 0, sourceCount: 1});
  assert.equal(frames.at(-1).ok, true);
  assert.ok(!JSON.stringify(frames).includes('SECRET'));
});

test('late progress after a completed request is ignored below the event cap', async t => {
  let callback;
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'synthetic-key', issueKeys: ['TEST-1'], projectKeys: []};
  const host = setup(t, {generateAgent: async ({onProgress}) => {
    callback = onProgress;
    onProgress({stage: 'planning', step: 1});
    return {text: '完了', sources: [], toolCalls: 0};
  }});
  host.send(request('late-progress', {mode: 'agent', backlog, progress: true}));
  await host.waitFor(2);
  callback({stage: 'reading', target: 'TEST-1'});
  await delay(10);
  assert.equal(host.messages().length, 2);
});

test('progress does not extend timeout and events after abort are ignored during cleanup', async t => {
  const cleanup = deferred();
  let callback;
  let signal;
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'synthetic-key', issueKeys: ['TEST-1'], projectKeys: []};
  const host = setup(t, {timeoutMs: 30, generateAgent: input => new Promise((resolve, reject) => {
    callback = input.onProgress;
    signal = input.signal;
    const ticker = setInterval(() => callback({stage: 'planning', step: 1}), 5);
    signal.addEventListener('abort', () => {
      clearInterval(ticker);
      callback({stage: 'reading', target: 'TEST-1'});
      void cleanup.promise.then(() => reject(new Error('aborted')));
    }, {once: true});
  })});
  host.send(request('timeout-progress', {mode: 'agent', backlog, progress: true}));
  await until(() => host.messages().some(frame => frame.ok === false));
  assert.equal(signal.aborted, true);
  const frames = host.messages();
  assert.ok(frames.some(frame => frame.type === 'progress'));
  assert.ok(frames.length < 64);
  assert.match(frames.at(-1).error, /タイムアウト/);
  assert.ok(!frames.some(frame => frame.progress?.stage === 'reading'));
  callback({stage: 'read_complete', toolCalls: 1});
  await delay(10);
  assert.equal(host.messages().length, frames.length);
  cleanup.resolve();
});

test('progress callbacks are ignored after host shutdown begins', async t => {
  let callback;
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'synthetic-key', issueKeys: ['TEST-1'], projectKeys: []};
  const host = setup(t, {generateAgent: ({onProgress, signal}) => new Promise((resolve, reject) => {
    callback = onProgress;
    onProgress({stage: 'planning', step: 1});
    signal.addEventListener('abort', () => {
      onProgress({stage: 'read_failed', target: 'TEST-1'});
      reject(new Error('aborted'));
    }, {once: true});
  })});
  host.send(request('close-progress', {mode: 'agent', backlog, progress: true}));
  await host.waitFor(1);
  await host.close();
  callback({stage: 'reply_ready', sourceCount: 1});
  assert.deepEqual(host.messages(), [{id: 'close-progress', type: 'progress', progress: {stage: 'planning', step: 1}}]);
});

test('agent scope accepts project keys starting with a digit or underscore consistently with Backlog MCP', async t => {
  const calls = [];
  const host = setup(t, {generateAgent: async input => {
    calls.push(input);
    return {text: '返信案です。', sources: [], toolCalls: 0};
  }});
  for (const [index, projectKey] of ['1PROJ', '_PROJ'].entries()) {
    const backlog = {origin: 'https://example.backlog.com', apiKey: 'synthetic-only', issueKeys: [`${projectKey}-1`], projectKeys: [projectKey]};
    host.send(request(`project-key-${index}`, {mode: 'agent', backlog}));
    assert.equal((await host.waitFor(index + 1))[index].ok, true);
    assert.deepEqual(calls[index].backlog.projectKeys, [projectKey]);
  }
});

test('agent scope accepts an empty project list without adding the current project', async t => {
  const calls = [];
  const host = setup(t, {generateAgent: async input => {
    calls.push(input);
    return {text: '指定された課題だけを確認しました。', sources: [], toolCalls: 1};
  }});
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'synthetic-only', issueKeys: ['TEST-1'], projectKeys: []};
  host.send(request('explicit-issue-only', {mode: 'agent', backlog}));
  assert.equal((await host.waitFor(1))[0].ok, true);
  assert.deepEqual(calls[0].backlog.issueKeys, ['TEST-1']);
  assert.deepEqual(calls[0].backlog.projectKeys, []);
});

test('generate_prompt routes to the selected text provider with purpose prompt and no reply guard', async t => {
  const calls = [];
  const host = setup(t, {generateAgent: async () => {throw new Error('must not use agent');}, generate: async input => {
    calls.push(input);
    return ' 本人を投稿者として、課題の状況に合う日本語の返信案を作成してください。 ';
  }});
  const prompt = '公式ガイドの参考情報と架空の本人プロフィールです。';
  for (const [index, provider] of ['copilot', 'codex'].entries()) {
    host.send({id: `prompt-${provider}`, type: 'generate_prompt', provider, model: 'test-model', prompt});
    assert.deepEqual((await host.waitFor(index + 1))[index], {id: `prompt-${provider}`, ok: true,
      text: '本人を投稿者として、課題の状況に合う日本語の返信案を作成してください。'});
  }
  assert.deepEqual(calls.map(call => call.provider), ['copilot', 'codex']);
  for (const call of calls) {
    assert.equal(call.purpose, 'prompt');
    assert.equal(call.prompt, prompt);
    assert.equal(call.model, 'test-model');
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(call.backlog, undefined);
  }
});

test('generate_prompt rejects mode, credentials and invalid existing input fields before generation', async t => {
  let calls = 0;
  const host = setup(t, {generate: async () => {calls++; return 'unused';}, generateAgent: async () => {calls++;}});
  const invalid = [{mode: 'chat'}, {mode: 'agent'}, {mode: null}, {backlog: {}},
    {backlog: {apiKey: 'private'}}, {provider: 'claude'}, {prompt: ''}, {prompt: 'x'.repeat(180001)},
    {model: 'unsafe;command'}, {model: 'x'.repeat(101)}, {progress: 'true'}];
  for (const [index, patch] of invalid.entries()) host.send({id: `bad-prompt-${index}`, type: 'generate_prompt', provider: 'copilot', prompt: '参考資料', ...patch});
  assert.ok((await host.waitFor(invalid.length)).every(reply => reply.ok === false));
  assert.equal(calls, 0);
});

test('generate_prompt enforces 12000 output characters without lowering the normal reply limit', async t => {
  const calls = [];
  const host = setup(t, {generate: async input => {
    calls.push(input);
    if (input.prompt.length === 180000) return 'p'.repeat(12000);
    return 'r'.repeat(Number(input.prompt.replace(GUARD, '')));
  }});
  host.send({id: 'prompt-boundary', type: 'generate_prompt', provider: 'copilot', prompt: 'x'.repeat(180000)});
  const first = (await host.waitFor(1))[0];
  assert.equal(first.ok, true);
  assert.equal(first.text.length, 12000);
  assert.equal(calls[0].prompt.length, 180000);
  host.send({id: 'prompt-too-long', type: 'generate_prompt', provider: 'codex', prompt: '12001'});
  assert.match((await host.waitFor(2))[1].error, /12,000/);
  host.send(request('reply-boundary', {prompt: '100000'}));
  assert.equal((await host.waitFor(3))[2].text.length, 100000);
  host.send(request('reply-too-long', {prompt: '100001'}));
  assert.equal((await host.waitFor(4))[3].ok, false);
});

test('generate_prompt retains opt-in progress and fixed cancellation timeout', async t => {
  let signal;
  const host = setup(t, {timeoutMs: 20, generate: input => new Promise((resolve, reject) => {
    signal = input.signal;
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  })});
  host.send({id: 'prompt-timeout', type: 'generate_prompt', provider: 'copilot', prompt: '参考資料', progress: true});
  const frames = await host.waitFor(2);
  assert.deepEqual(frames[0], {id: 'prompt-timeout', type: 'progress', progress: {stage: 'generating'}});
  assert.equal(frames[1].ok, false);
  assert.match(frames[1].error, /タイムアウト/);
  assert.equal(signal.aborted, true);
});

test('prompt generation shares the existing two-operation concurrency limit', async t => {
  const pending = [];
  const host = setup(t, {generate: () => new Promise(resolve => pending.push(resolve))});
  host.send({id: 'prompt-one', type: 'generate_prompt', provider: 'copilot', prompt: '参考資料'});
  host.send(request('reply-two'));
  host.send({id: 'prompt-three', type: 'generate_prompt', provider: 'codex', prompt: '参考資料'});
  assert.match((await host.waitFor(1))[0].error, /混み合って/);
  assert.equal(pending.length, 2);
  for (const resolve of pending) resolve('完了');
  await host.waitFor(3);
});

test('agent mode rejects arbitrary hosts, missing scopes and credentials in chat mode', async t => {
  let calls = 0;
  const backlog = {origin: 'https://example.backlog.com', apiKey: 'key', issueKeys: ['TEST-1'], projectKeys: ['TEST']};
  const host = setup(t, {generateAgent: async () => {calls++;}, generate: async () => {calls++;}});
  const inputs = [
    {mode: 'other'}, {mode: 'agent'}, {mode: 'chat', backlog},
    ...['http://example.backlog.com', 'https://example.backlog.com.evil.test', 'https://example.backlog.com:9999', 'https://name:secret@example.backlog.com']
      .map(origin => ({mode: 'agent', backlog: {...backlog, origin}})),
    {mode: 'agent', backlog: {...backlog, projectKeys: undefined}}, {mode: 'agent', backlog: {...backlog, issueKeys: ['../any']}}
  ];
  inputs.forEach((input, i) => host.send(request(`bad-agent-${i}`, input)));
  assert.ok((await host.waitFor(inputs.length)).every(reply => reply.ok === false));
  assert.equal(calls, 0);
});

test('launcher arguments allow only the registered ID, origin and optional Windows handle', () => {
  const expected = { extensionId, callerOrigin };
  assert.deepEqual(parseNativeArguments(['--extension-id', extensionId, callerOrigin]), expected);
  assert.deepEqual(parseNativeArguments(['--extension-id', extensionId, callerOrigin, '--parent-window=0']), expected);
  for (const args of [[], ['--extension-id', extensionId],
    ['--extension-id', extensionId, callerOrigin, '--parent-window=-1'],
    ['--extension-id', extensionId, callerOrigin, '--parent-window=0', 'extra'],
    ['--extension-id', extensionId, 'chrome-extension://wrong/'],
    ['--check', extensionId, callerOrigin],
  ]) assert.throws(() => parseNativeArguments(args));
});

test('fragmented frames and multiple messages preserve Japanese UTF-8 and use the same generation guard', async t => {
  const inputs = [];
  const host = setup(t, { generate: async data => { inputs.push(data); return ' 確認いたしました。😀\n\nよろしくお願いいたします。 '; } });
  const frames = Buffer.concat([
    encodeNativeMessage({ id: 'health-1', type: 'health' }),
    encodeNativeMessage(request('copilot-1', { prompt: '課題本文😀', model: 'test-model' })),
    encodeNativeMessage(request('codex-1', { provider: 'codex', model: '' })),
  ]);
  for (let i = 0; i < 19; i++) host.input.write(frames.subarray(i, i + 1));
  host.input.write(frames.subarray(19, 121));
  for (let i = 121; i < frames.length; i++) host.input.write(frames.subarray(i, i + 1));
  const messages = await host.waitFor(3);
  assert.deepEqual(messages[0], { id: 'health-1', ok: true, providers: ['copilot', 'codex'] });
  assert.deepEqual(inputs.map(x => x.provider), ['copilot', 'codex']);
  assert.equal(inputs[0].prompt, GUARD + '課題本文😀');
  assert.equal(inputs[0].model, 'test-model');
  assert.equal(inputs[1].model, undefined);
  assert.ok(inputs.every(x => x.signal instanceof AbortSignal));
  assert.ok(messages.slice(1).every(x => x.text === '確認いたしました。😀\n\nよろしくお願いいたします。'));
  assert.equal(host.diagnostics(), '');
});

test('maximum input/output sizes are UTF-8 byte lengths and exact boundary is accepted', async t => {
  const host = setup(t);
  const base = { id: 'boundary', type: 'health', padding: '' };
  const overhead = Buffer.byteLength(JSON.stringify(base));
  const frame = encodeNativeMessage({ ...base, padding: 'x'.repeat(MAX_MESSAGE_BYTES - overhead) });
  assert.equal(frame.readUInt32LE(0), MAX_MESSAGE_BYTES);
  host.input.write(frame);
  assert.equal((await host.waitFor(1))[0].ok, true);
  assert.throws(() => encodeNativeMessage({ ...base, padding: 'x'.repeat(MAX_MESSAGE_BYTES - overhead + 1) }), /上限/);
  assert.throws(() => encodeNativeMessage({ text: 'あ'.repeat(MAX_MESSAGE_BYTES / 2) }), /上限/);
});

test('bad lengths, JSON, UTF-8 and truncated EOF close the host without starting a generator', async t => {
  const zero = Buffer.alloc(4);
  const tooLarge = Buffer.alloc(4);
  tooLarge.writeUInt32LE(MAX_MESSAGE_BYTES + 1);
  const invalidUtf8 = Buffer.concat([Buffer.from('{"id":"bad","type":"health","x":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]);
  for (const [name, bytes] of [
    ['zero', zero], ['too large', tooLarge], ['bad JSON', rawFrame(Buffer.from('{'))],
    ['invalid UTF-8', rawFrame(invalidUtf8)], ['partial header', Buffer.from([30, 0])],
    ['partial body', encodeNativeMessage({ id: 'incomplete', type: 'health' }).subarray(0, 12)],
  ]) {
    await t.test(name, async sub => {
      let calls = 0;
      const host = setup(sub, { generate: async () => { calls++; return 'unused'; } });
      host.input.end(bytes);
      assert.equal(await host.done, 1);
      assert.equal(calls, 0);
      assert.deepEqual(host.messages(), []);
      assert.ok(host.diagnostics());
    });
  }
});

test('invalid envelope IDs fail closed; semantic errors respond without calling an AI', async t => {
  for (const payload of [null, [], {}, { id: 1, type: 'health' }, { id: 'x'.repeat(129), type: 'health' }, { id: 'bad\nID', type: 'health' }]) {
    const host = setup(t);
    host.input.write(rawFrame(Buffer.from(JSON.stringify(payload))));
    assert.equal(await host.done, 1);
    assert.deepEqual(host.messages(), []);
  }
  let calls = 0;
  const host = setup(t, { generate: async () => { calls++; return 'unused'; } });
  const invalid = [
    { type: 'execute' }, { provider: 'claude' }, { prompt: '' }, { prompt: ' \n ' },
    { prompt: null }, { prompt: 'a'.repeat(180001) }, { model: 42 },
    { model: 'm;echo bad' }, { model: 'x'.repeat(101) },
    { progress: 'true' }, { progress: 1 }, { progress: null }, { progress: {} },
  ];
  invalid.forEach((extra, i) => host.send(request(`invalid-${i}`, extra)));
  const responses = await host.waitFor(invalid.length);
  assert.ok(responses.every(message => message.ok === false && typeof message.error === 'string'));
  assert.equal(calls, 0);
});

test('blank, oversized and failed generations return bounded errors', async t => {
  const results = [' ', null, 'x'.repeat(100001), new Error('e'.repeat(10000))];
  const host = setup(t, { generate: async () => {
    const value = results.shift();
    if (value instanceof Error) throw value;
    return value;
  } });
  for (let i = 0; i < 4; i++) {
    host.send(request(`output-${i}`));
    const response = (await host.waitFor(i + 1))[i];
    assert.equal(response.ok, false);
    assert.ok(response.error.length <= 600);
  }
});

test('duplicate IDs after completion are rejected and cannot run an AI twice', async t => {
  let calls = 0;
  const host = setup(t, { generate: async () => { calls++; return '完了'; } });
  host.send(request('once'));
  await host.waitFor(1);
  host.send(request('once'));
  assert.equal(await host.done, 1);
  assert.equal(calls, 1);
  assert.equal(host.messages().length, 1);
});

test('two concurrent generations are allowed while health remains responsive', async t => {
  const pending = [];
  const host = setup(t, { generate: () => new Promise(resolve => pending.push(resolve)) });
  host.send(request('one'));
  host.send(request('two'));
  host.send(request('three'));
  host.send({ id: 'health-during-generation', type: 'health' });
  const responses = await host.waitFor(2);
  assert.equal(responses.find(x => x.id === 'three').ok, false);
  assert.equal(responses.find(x => x.id === 'health-during-generation').ok, true);
  assert.equal(pending.length, 2);
  for (const resolve of pending) resolve('完了');
  await host.waitFor(4);
});

test('timeout aborts and retains the concurrency slot until provider cleanup finishes', async t => {
  const cleanup = deferred();
  let aborted = 0;
  const host = setup(t, { timeoutMs: 20, generate: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted++;
      void cleanup.promise.then(() => reject(new Error('cancelled')));
    }, { once: true });
  }) });
  host.send(request('timeout-one'));
  host.send(request('timeout-two'));
  const responses = await host.waitFor(2);
  assert.equal(aborted, 2);
  assert.ok(responses.every(message => !message.ok && /タイムアウト/.test(message.error)));
  host.send(request('still-cleaning'));
  assert.match((await host.waitFor(3))[2].error, /混み合って/);
  cleanup.resolve();
});

test('EOF and explicit shutdown abort all work and wait for provider cleanup', async t => {
  for (const reason of ['EOF', 'signal']) await t.test(reason, async sub => {
    const cleanup = deferred();
    let started = 0;
    let aborted = 0;
    let cleaned = 0;
    const host = setup(sub, { generate: async ({ signal }) => {
      started++;
      try {
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true }));
      } finally { await cleanup.promise; cleaned++; }
    } });
    host.send(request('cancel-one'));
    host.send(request('cancel-two'));
    await until(() => started === 2);
    let finished = false;
    void host.done.then(() => { finished = true; });
    if (reason === 'EOF') host.input.end(); else void host.close();
    await until(() => aborted === 2);
    await delay(10);
    assert.equal(finished, false);
    cleanup.resolve();
    assert.equal(await host.done, 0);
    assert.equal(cleaned, 2);
    assert.deepEqual(host.messages(), []);
  });
});

test('a broken protocol aborts an active provider without echoing malformed data', async t => {
  let started = false;
  let aborted = false;
  const host = setup(t, { generate: ({ signal }) => new Promise((resolve, reject) => {
    started = true;
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }) });
  host.send(request('active'));
  await until(() => started);
  host.input.write(rawFrame(Buffer.from('secret-not-json')));
  assert.equal(await host.done, 1);
  assert.equal(aborted, true);
  assert.equal(host.diagnostics().includes('secret-not-json'), false);
});

test('real host process exchanges health frames and rejects unauthorized caller origins', async t => {
  const entry = fileURLToPath(new URL('../bridge/native-host.mjs', import.meta.url));
  async function run(origin, data) {
    const child = spawn(process.execPath, [entry, '--extension-id', extensionId, origin, '--parent-window=0'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    const closed = once(child, 'close');
    child.stdin.end(data);
    const [code] = await closed;
    return { code, stdout: Buffer.concat(chunks), stderr };
  }
  const good = await run(callerOrigin, encodeNativeMessage({ id: 'process-health', type: 'health' }));
  assert.equal(good.code, 0, good.stderr);
  assert.equal(good.stderr, '');
  assert.deepEqual(decodeFrames(good.stdout), [{ id: 'process-health', ok: true, providers: ['copilot', 'codex'] }]);
  const denied = await run(`chrome-extension://${'b'.repeat(32)}/`, Buffer.alloc(0));
  assert.equal(denied.code, 1);
  assert.equal(denied.stdout.length, 0);
  assert.match(denied.stderr, /登録されたChrome拡張/);
});
