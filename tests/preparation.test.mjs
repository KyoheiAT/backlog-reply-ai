import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreparation} from '../bridge/preparation.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
};

test('preparation is shared while pending and consumed by only one generation', async () => {
  const pending = deferred();
  const calls = [];
  const first = {id: 1};
  const second = {id: 2};
  const preparation = createPreparation({create: signal => {
    calls.push(signal);
    return calls.length === 1 ? pending.promise : second;
  }, dispose: () => {throw new Error('taken resources belong to generation');}});
  const warm = preparation.prepare();
  const duplicate = preparation.prepare();
  const take = preparation.take();
  pending.resolve(first);
  await Promise.all([warm, duplicate]);
  assert.equal(await take, first);
  assert.equal(await preparation.take(), second);
  assert.equal(calls.length, 2);
  await preparation.clear();
});

test('unused preparation expires and releases its resource exactly once', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const released = [];
  const resource = {};
  const preparation = createPreparation({create: async () => resource, dispose: async value => {released.push(value);}, ttlMs: 60_000});
  await preparation.prepare();
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(released, [resource]);
  await preparation.clear();
  assert.equal(released.length, 1);
});

test('closing during preparation aborts startup and releases a late resource', async () => {
  const pending = deferred();
  let startupSignal;
  const released = [];
  const resource = {};
  const preparation = createPreparation({create: signal => {startupSignal = signal; return pending.promise;},
    dispose: async value => {released.push(value);}});
  const warm = preparation.prepare();
  await Promise.resolve();
  const closed = preparation.clear();
  assert.equal(startupSignal.aborted, true);
  pending.resolve(resource);
  await Promise.all([warm, closed]);
  assert.deepEqual(released, [resource]);
});

test('closing waits for cleanup already started by expiry or cancellation', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const reason of ['expiry', 'cancellation']) {
    const cleanup = deferred();
    const disposing = deferred();
    const controller = new AbortController();
    const preparation = createPreparation({create: async () => ({}), ttlMs: 60_000,
      dispose: async () => {disposing.resolve(); await cleanup.promise;}});
    const warm = preparation.prepare({signal: controller.signal});
    if (reason === 'expiry') {
      await warm;
      t.mock.timers.tick(60_000);
    } else {
      // Cancel while prepare still owns the entry and is awaiting its result.
      controller.abort();
      await assert.rejects(warm, {name: 'AbortError'});
    }
    await disposing.promise;
    let closed = false;
    const close = preparation.clear().then(() => {closed = true;});
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(closed, false, `${reason} cleanup must finish before host exit`);
    cleanup.resolve();
    await close;
    assert.equal(closed, true);
  }
});

test('failed speculation is evicted and the next request starts fresh', async () => {
  let starts = 0;
  const preparation = createPreparation({create: async () => {
    if (++starts === 1) throw new Error('startup failed');
    return 'fresh';
  }, dispose: async () => {}});
  await assert.rejects(preparation.prepare(), /startup failed/);
  assert.equal(await preparation.take(), 'fresh');
  assert.equal(starts, 2);
});

test('the generation takes cancellation ownership from a speculative request', async () => {
  const pending = deferred();
  const speculative = new AbortController();
  const generation = new AbortController();
  let startupSignal;
  let disposed = 0;
  const preparation = createPreparation({create: signal => {startupSignal = signal; return pending.promise;}, dispose: async () => {disposed++;}});
  const warm = preparation.prepare({signal: speculative.signal});
  const take = preparation.take({signal: generation.signal});
  await Promise.resolve();
  speculative.abort();
  assert.equal(startupSignal.aborted, false);
  generation.abort();
  assert.equal(startupSignal.aborted, true);
  pending.resolve({});
  await assert.rejects(warm, {name: 'AbortError'});
  await assert.rejects(take, {name: 'AbortError'});
  assert.equal(disposed, 1);
});
