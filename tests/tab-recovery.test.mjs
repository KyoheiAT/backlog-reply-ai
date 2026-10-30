import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../tab-recovery.js', import.meta.url), 'utf8');
const flush = async () => {for (let i = 0; i < 50; i++) await Promise.resolve();};
const event = () => {const listeners = []; return {addListener(fn) {listeners.push(fn);}, fire(...args) {listeners.forEach(fn => fn(...args));}};};
function fixture({ping = async () => {throw new Error('Receiving end does not exist');}, execute} = {}) {
  const calls = [];
  const tab = {id: 12, url: 'https://example.backlog.com/view/TEST-1', status: 'complete', discarded: false};
  const chrome = {tabs: {
    onActivated: event(), onUpdated: event(),
    get: async id => {calls.push({type: 'get', id}); return {...tab, id};},
    query: async args => {calls.push({type: 'query', args}); return [tab];},
    sendMessage: async (...args) => {calls.push({type: 'ping', args}); return ping(...args);}
  }, windows: {onFocusChanged: event()}, runtime: {onStartup: event(), onInstalled: event()}, scripting: {
    insertCSS: async args => {calls.push({type: 'css', args});},
    executeScript: async args => {calls.push({type: 'script', args}); return execute?.(args);}
  }};
  const context = vm.createContext({URL});
  vm.runInContext(source, context);
  return {calls, tab, chrome, api: context.BacklogTabRecovery, manager: context.BacklogTabRecovery.install(chrome)};
}
test('healthy tabs are pinged without reinjection or AI requests', async () => {
  const f = fixture({ping: async () => ({ok: true, version: 1})});
  await f.manager.recover(12);
  assert.deepEqual(f.calls.map(call => call.type), ['get', 'ping']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].args)), [12, {type: 'BACKLOG_AI_PING'}, {frameId: 0}]);
});
test('a missing receiver installs only the extension assets in the trusted top frame', async () => {
  const f = fixture();
  await f.manager.recover(12);
  const injection = f.calls.filter(call => ['css', 'script'].includes(call.type));
  assert.deepEqual(JSON.parse(JSON.stringify(injection)), [
    {type: 'css', args: {target: {tabId: 12, frameIds: [0]}, files: ['content.css']}},
    {type: 'script', args: {target: {tabId: 12, frameIds: [0]}, files: ['panel-layout.js', 'content.js']}}
  ]);
});
test('activation, window focus, completed reload, startup and extension update recover idle tabs', async () => {
  for (const trigger of [f => f.chrome.tabs.onActivated.fire({tabId: 12}), f => f.chrome.windows.onFocusChanged.fire(1),
    f => f.chrome.tabs.onUpdated.fire(12, {status: 'complete'}), f => f.chrome.runtime.onStartup.fire(), f => f.chrome.runtime.onInstalled.fire()]) {
    const f = fixture(); trigger(f); await flush();
    assert.equal(f.calls.filter(call => call.type === 'script').length, 1);
  }
});
test('concurrent activation signals install only one instance and failures remain retryable', async () => {
  let fail = true;
  const f = fixture({execute: async () => {if (fail) throw new Error('tab closed');}});
  await Promise.all([f.manager.recover(12), f.manager.recover(12)]);
  assert.equal(f.calls.filter(call => call.type === 'script').length, 1);
  fail = false;
  await f.manager.recover(12);
  assert.equal(f.calls.filter(call => call.type === 'script').length, 2);
});
test('foreign pages, issue subpaths, loading/discarded tabs and navigation during ping are skipped', async () => {
  for (const url of ['https://evil.test/view/TEST-1', 'https://example.backlog.com.evil.test/view/TEST-1',
    'https://user:password@example.backlog.com/view/TEST-1', 'https://example.backlog.com/view/TEST-1/edit',
    'https://example.backlog.com/projects/TEST', 'http://example.backlog.com/view/TEST-1']) {
    const f = fixture(); f.tab.url = url; await f.manager.recover(12);
    assert.equal(f.calls.length, 1);
  }
  for (const state of [{status: 'loading'}, {discarded: true}]) {
    const f = fixture(); Object.assign(f.tab, state); await f.manager.recover(12); assert.equal(f.calls.length, 1);
  }
  let f;
  f = fixture({ping: async () => {f.tab.url = 'https://evil.test/'; throw new Error('navigated');}});
  await f.manager.recover(12);
  assert.equal(f.calls.some(call => call.type === 'script'), false);
});
