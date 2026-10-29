import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCopilotModelLister } from '../bridge/providers/copilot.mjs';

const model = (id, extra = {}) => ({ id, name: `Name ${id}`, ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error('condition was not met');
}
function fixture(overrides = {}, options = {}) {
  const calls = [];
  const state = { calls, clientOptions: [] };
  class CopilotClient {
    constructor(config) { state.clientOptions.push(config); calls.push('constructor'); }
    async start() { calls.push('start'); return overrides.start?.(); }
    async getAuthStatus() { calls.push('auth'); return overrides.auth ? overrides.auth() : { isAuthenticated: true, authType: 'user' }; }
    async listModels() { calls.push('models'); return overrides.models ? overrides.models() : [model('test-model')]; }
    async stop() { calls.push('stop'); return overrides.stop ? overrides.stop() : []; }
    async forceStop() { calls.push('forceStop'); return overrides.forceStop?.(); }
    createSession() { assert.fail('model listing must never create a session'); }
    resumeSession() { assert.fail('model listing must never resume a session'); }
    send() { assert.fail('model listing must never generate text'); }
  }
  const list = createCopilotModelLister({
    loadSdk: async () => ({ CopilotClient, RuntimeConnection: { forStdio: () => ({ kind: 'stdio' }) } }),
    cleanupTimeoutMs: 500,
    ...options,
  });
  return { list, state };
}

test('lists metadata using OAuth and stdio without a session, then cleans up', async () => {
  const { list, state } = fixture();
  assert.deepEqual(await list({}), [{ id: 'test-model', name: 'Name test-model' }]);
  assert.deepEqual(state.calls, ['constructor', 'start', 'auth', 'models', 'stop']);
  const [config] = state.clientOptions;
  assert.equal(config.useLoggedInUser, true);
  assert.equal(config.gitHubToken, undefined);
  assert.equal(config.logLevel, 'none');
  assert.equal(config.autoRestart, false);
  assert.deepEqual(config.connection, { kind: 'stdio' });
  assert.equal(config.env.COPILOT_PLUGIN_DIR_ONLY, 'true');
  await assert.rejects(access(config.workingDirectory), { code: 'ENOENT' });
});

test('filters disabled and explicitly unselectable models, deduplicates IDs, and invents no defaults', async () => {
  const { list } = fixture({ models: async () => [
    model('enabled', { name: '  Enabled model  ', policy: { state: 'enabled' }, metadata: { default: true } }),
    model('unconfigured', { policy: { state: 'unconfigured' } }),
    model('disabled', { policy: { state: 'disabled' } }),
    model('not-selectable', { selectable: false }),
    model('not-selectable-either', { isSelectable: false }),
    model('enabled', { name: 'duplicate' }),
    model('denial-wins'), model('denial-wins', { policy: { state: 'disabled' } }),
    model('metadata-is-not-policy', { metadata: { selectable: false, hidden: true } }),
    model('name-fallback', { name: null }), model('long-name', { name: 'N'.repeat(201) }),
    model('provider/model:1.2-3_4'),
    null, {}, model(''), model('with space'), model('unsafe;command'), model('あ'), model('x'.repeat(101)),
  ] });
  const result = await list();
  assert.deepEqual(result.map(item => item.id), ['enabled', 'unconfigured', 'metadata-is-not-policy', 'name-fallback', 'long-name', 'provider/model:1.2-3_4']);
  assert.equal(result[0].name, 'Enabled model');
  assert.equal(result[3].name, 'name-fallback');
  assert.equal(result[4].name.length, 200);
  assert.ok(result.every(item => Object.keys(item).join(',') === 'id,name'));
});

test('caps model lists at 500 and accepts an empty available list without static fallbacks', async () => {
  const { list } = fixture({ models: async () => Array.from({ length: 510 }, (_, i) => model(`model-${i}`)) });
  const result = await list();
  assert.equal(result.length, 500);
  assert.equal(result.at(-1).id, 'model-499');
  const empty = fixture({ models: async () => [model('denied', { policy: { state: 'disabled' } })] });
  assert.deepEqual(await empty.list(), []);
});

test('removes ambient API tokens and custom runtime overrides without changing process.env', async () => {
  const keys = ['GITHUB_COPILOT_API_TOKEN', 'COPILOT_API_URL', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COPILOT_ALLOW_ALL'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'test-only-value';
    const { list, state } = fixture();
    await list();
    for (const key of keys) {
      assert.equal(state.clientOptions[0].env[key], undefined, key);
      assert.equal(process.env[key], 'test-only-value', key);
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('rejects every non-user authentication mode before requesting model metadata', async () => {
  for (const auth of [null, {}, { isAuthenticated: false }, { isAuthenticated: true, authType: 'env' },
    { isAuthenticated: true, authType: 'token' }, { isAuthenticated: true, authType: 'api-key' }]) {
    const { list, state } = fixture({ auth: async () => auth });
    await assert.rejects(list(), /copilot login/);
    assert.equal(state.calls.includes('models'), false);
    assert.equal(state.calls.at(-1), 'stop');
    await assert.rejects(access(state.clientOptions[0].workingDirectory), { code: 'ENOENT' });
  }
});

test('does not initialize the SDK when already aborted and handles abort during SDK import', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error('cancel before start'));
  const list = createCopilotModelLister({ loadSdk: () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(list({ signal: controller.signal }), /cancel before start/);
  assert.equal(calls, 0);
  const next = new AbortController();
  const pending = list({ signal: next.signal });
  const result = assert.rejects(pending, /cancel import/);
  await until(() => calls === 1);
  next.abort(new Error('cancel import'));
  await result;
});

test('abort during model discovery force-stops the runtime and removes its directory', async () => {
  const controller = new AbortController();
  const { list, state } = fixture({ models: () => new Promise(() => {}) });
  const pending = list({ signal: controller.signal });
  const result = assert.rejects(pending, /cancel metadata/);
  await until(() => state.calls.includes('models'));
  controller.abort(new Error('cancel metadata'));
  await result;
  assert.ok(state.calls.includes('forceStop'));
  assert.ok(state.calls.includes('stop'));
  await assert.rejects(access(state.clientOptions[0].workingDirectory), { code: 'ENOENT' });
});

test('a late SDK start after cancellation is force-stopped again', async () => {
  const starting = deferred();
  const controller = new AbortController();
  const { list, state } = fixture({ start: () => starting.promise });
  const pending = list({ signal: controller.signal });
  const result = assert.rejects(pending, /cancel startup/);
  await until(() => state.calls.includes('start'));
  controller.abort(new Error('cancel startup'));
  await result;
  const stoppedBeforeLateStart = state.calls.filter(x => x === 'forceStop').length;
  starting.resolve();
  await until(() => state.calls.filter(x => x === 'forceStop').length > stoppedBeforeLateStart);
  assert.equal(state.calls.includes('auth'), false);
});

test('the complete discovery sequence has a timeout, including SDK load and authentication', async () => {
  const loader = createCopilotModelLister({ loadSdk: () => new Promise(() => {}), timeoutMs: 15, cleanupTimeoutMs: 10 });
  await assert.rejects(loader(), /タイムアウト/);
  for (const stage of ['auth', 'models']) {
    const { list, state } = fixture({ [stage]: () => new Promise(() => {}) }, { timeoutMs: 15 });
    await assert.rejects(list(), /タイムアウト/);
    assert.ok(state.calls.includes('forceStop'));
    await assert.rejects(access(state.clientOptions[0].workingDirectory), { code: 'ENOENT' });
  }
});

test('stop failures or hangs trigger forceStop and cleanup remains bounded', async () => {
  for (const stop of [async () => [new Error('could not stop')], async () => { throw new Error('stop failed'); }, () => new Promise(() => {})]) {
    const { list, state } = fixture({ stop });
    assert.equal((await list()).length, 1);
    assert.equal(state.calls.at(-1), 'forceStop');
    await assert.rejects(access(state.clientOptions[0].workingDirectory), { code: 'ENOENT' });
  }
});

test('SDK load, model errors, and malformed responses fail clearly and preserve cleanup', async () => {
  const missing = createCopilotModelLister({ loadSdk: async () => { throw new Error('missing SDK'); } });
  await assert.rejects(missing(), /SDKを読み込めません/);
  for (const models of [async () => { throw new Error('model request failed'); }, async () => ({ models: [] })]) {
    const { list, state } = fixture({ models });
    await assert.rejects(list(), /model request failed|一覧の形式/);
    assert.equal(state.calls.at(-1), 'stop');
    await assert.rejects(access(state.clientOptions[0].workingDirectory), { code: 'ENOENT' });
  }
});

test('each refresh uses a fresh client instead of an SDK cache from an older account', async () => {
  const { list, state } = fixture();
  await list();
  await list();
  assert.equal(state.calls.filter(x => x === 'models').length, 2);
  assert.notEqual(state.clientOptions[0].workingDirectory, state.clientOptions[1].workingDirectory);
});
