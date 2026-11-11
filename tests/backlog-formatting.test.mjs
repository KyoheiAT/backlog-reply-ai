import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto, createHash} from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../backlog-formatting.js', import.meta.url), 'utf8');
const credentialsSource = await readFile(new URL('../backlog-credentials.js', import.meta.url), 'utf8');
const origin = 'https://example.backlog.com';
const stamp = Date.parse('2026-10-29T00:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const ready = async predicate => {
  const end = Date.now() + 2000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(predicate(), 'operation became ready');
};

function fixture({settings = {}, read: readOverride, initialTime = stamp} = {}) {
  const data = {backlogKey: 'test-secret-key', backlogSpaceUrl: origin, ...clone(settings)};
  const reads = [], writes = [];
  let time = initialTime;
  const storage = {
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return clone(Object.fromEntries(names.filter(key => key in data).map(key => [key, data[key]])));
    },
    async set(values) {writes.push(clone(values)); Object.assign(data, clone(values));}
  };
  const context = vm.createContext({URL, Date, TextEncoder, crypto: webcrypto});
  vm.runInContext(credentialsSource, context);
  vm.runInContext(source, context);
  const manager = context.BacklogFormatting.create({storage, now: () => time,
    read: async (url, apiKey, deadline) => {
      reads.push({url, apiKey, deadline});
      if (readOverride) return readOverride(url, apiKey, deadline);
      return url.endsWith('/space') ? {name: 'Example Space', textFormattingRule: 'markdown'}
        : {projectKey: 'EXAMPLE', textFormattingRule: 'markdown'};
    }});
  return {manager, api: context.BacklogFormatting, data, reads, writes,
    advance(ms) {time += ms;}, reply(args = {}) {return manager.forReply({origin, issueKey: 'EXAMPLE-1', apiKey: data.backlogKey,
      deadline: time + 20000, ...args});}};
}

test('space URLs accept only HTTPS Backlog tenant origins and optionally strip profile paths', () => {
  const {api} = fixture();
  for (const domain of ['backlog.com', 'backlog.jp', 'backlogtool.com']) {
    assert.equal(api.spaceOrigin(`https://EXAMPLE.${domain}/`), `https://example.${domain}`);
    assert.equal(api.spaceOrigin(`https://example.${domain}/user/*member`, true), `https://example.${domain}`);
  }
  for (const value of [undefined, '', 'not a URL', 'http://example.backlog.com', 'file:///tmp/data',
    'https://backlog.com', 'https://example.backlog.com.evil.test', 'https://a.b.backlog.com',
    'https://evil.test@example.backlog.com', 'https://user:secret@example.backlog.com',
    'https://example.backlog.com:8443', 'https://example.backlog.com:443', 'https://example.backlog.com/view/EXAMPLE-1',
    'https://example.backlog.com/?apiKey=secret', 'https://example.backlog.com/#fragment']) {
    assert.equal(api.spaceOrigin(value), '', String(value));
  }
});

test('unconfigured or invalid settings never make authenticated requests', async () => {
  for (const settings of [{backlogKey: ''}, {backlogSpaceUrl: '', backlogLastSpaceUrl: ''},
    {backlogSpaceUrl: 'https://evil.test', promptProfile: {profileUrl: `${origin}/user/me`}},
    {backlogSpaceUrl: '', backlogLastSpaceUrl: origin, promptProfile: {profileUrl: `${origin}/user/me`}}]) {
    const f = fixture({settings});
    assert.equal((await f.manager.getState()).status, 'unconfigured');
    assert.equal((await f.manager.refresh()).status, 'unconfigured');
    assert.equal((await f.manager.refresh({origin})).status, 'unconfigured');
    assert.equal(f.reads.length + f.writes.length, 0);
  }
});

test('only the configured space receives the key; profile, remembered and other requested spaces never do', async () => {
  const f = fixture({settings: {promptProfile: {profileUrl: 'https://profile.backlog.jp/user/me'}, backlogLastSpaceUrl: 'https://recent.backlogtool.com'}});
  assert.equal(f.manager.remember, undefined);
  assert.equal((await f.manager.getState()).origin, origin);
  for (const other of ['https://other.backlog.com', 'https://support-ja.backlog.com', 'https://profile.backlog.jp', 'https://evil.test']) {
    const state = await f.manager.refresh({origin: other});
    assert.equal(state.status, 'unconfigured', other);
    assert.equal(state.origin, '', other);
    assert.match(state.message, /発行したスペース以外/, other);
  }
  assert.equal(f.reads.length + f.writes.length, 0);
  assert.equal((await f.manager.refresh({origin: 'https://EXAMPLE.backlog.com/'})).status, 'ready');
  assert.deepEqual(f.reads.map(read => read.url), [`${origin}/api/v2/space`]);
});

test('space refresh caches confirmed format and keeps authentication fingerprints private', async () => {
  const f = fixture();
  const state = await f.manager.refresh();
  assert.equal(state.status, 'ready');
  assert.equal(state.rule, 'markdown');
  assert.equal(state.checkedAt, new Date(stamp).toISOString());
  assert.deepEqual(f.reads, [{url: `${origin}/api/v2/space`, apiKey: 'test-secret-key', deadline: stamp + 10000}]);
  const cache = f.data.backlogFormattingCache;
  assert.equal(cache.length, 1);
  assert.equal(cache[0].fingerprint, createHash('sha256').update('test-secret-key').digest('hex'));
  const publicState = await f.manager.getState();
  assert.deepEqual(clone(publicState), clone(state));
  for (const response of [state, publicState]) {
    assert.equal('fingerprint' in response, false);
    assert.equal(JSON.stringify(response).includes('test-secret-key'), false);
    assert.equal(JSON.stringify(response).includes(cache[0].fingerprint), false);
  }
  assert.equal(JSON.stringify(cache).includes('test-secret-key'), false);
});

test('fresh cache avoids requests, expires after one day, and explicit refresh always refetches', async () => {
  const f = fixture();
  await f.manager.refresh();
  f.advance(24 * 60 * 60 * 1000 - 1);
  await f.manager.refresh({force: false});
  assert.equal(f.reads.length, 1);
  f.advance(1);
  await f.manager.refresh({force: false});
  assert.equal(f.reads.length, 2);
  await f.manager.refresh();
  assert.equal(f.reads.length, 3);
});

test('a future or invalid cache timestamp cannot suppress a refresh', async () => {
  const f = fixture();
  await f.manager.refresh();
  f.data.backlogFormattingCache[0].checkedAt = new Date(stamp + 1000).toISOString();
  await f.manager.refresh({force: false});
  f.data.backlogFormattingCache[0].checkedAt = 'invalid timestamp';
  await f.manager.refresh({force: false});
  assert.equal(f.reads.length, 3);
});

test('simultaneous refreshes coalesce into one authenticated request', async () => {
  const gate = deferred();
  const f = fixture({read: () => gate.promise});
  const calls = Array.from({length: 5}, () => f.manager.refresh());
  await ready(() => f.reads.length === 1);
  gate.resolve({name: 'Example', textFormattingRule: 'backlog'});
  const states = await Promise.all(calls);
  assert.equal(f.reads.length, 1);
  assert.equal(f.writes.length, 1);
  assert.ok(states.every(state => state.rule === 'backlog'));
});

test('failed refresh clears stale rule, sanitizes errors, and permits retry', async () => {
  let fail = false;
  const f = fixture({read: async () => {
    if (fail) throw new Error('server error contains test-secret-key');
    return {textFormattingRule: 'markdown'};
  }});
  await f.manager.refresh();
  fail = true;
  const failed = await f.manager.refresh();
  assert.equal(failed.status, 'error');
  assert.equal(failed.rule, '');
  assert.equal(JSON.stringify(failed).includes('test-secret-key'), false);
  assert.equal((await f.manager.getState()).rule, '');
  fail = false;
  assert.equal((await f.manager.refresh({force: false})).rule, 'markdown');
  assert.equal(f.reads.length, 3);
});

test('unexpected space formats cannot become a confirmed formatting rule', async () => {
  for (const response of [null, [], {}, {textFormattingRule: null}, {textFormattingRule: 'html'},
    {textFormattingRule: 'Markdown'}, {textFormattingRule: {toString: 'markdown'}}]) {
    const f = fixture({read: async () => response});
    const state = await f.manager.refresh();
    assert.equal(state.status, 'error');
    assert.equal(state.rule, '');
  }
});

test('changing or removing the API key invalidates the old cache', async () => {
  const f = fixture();
  await f.manager.refresh();
  f.data.backlogKey = 'new-secret-key';
  assert.equal((await f.manager.getState()).status, 'unconfigured');
  await f.manager.refresh({force: false});
  assert.equal(f.reads.length, 2);
  assert.equal(f.reads[1].apiKey, 'new-secret-key');
  assert.equal(f.data.backlogFormattingCache.length, 1);
  f.data.backlogKey = '';
  assert.equal((await f.manager.getState()).status, 'unconfigured');
  await f.manager.refresh();
  assert.equal(f.reads.length, 2);
});

test('a response using the old key cannot overwrite a new-key cache', async () => {
  const gate = deferred();
  const f = fixture({read: async (_url, key) => key === 'test-secret-key' ? gate.promise : {textFormattingRule: 'backlog'}});
  const oldRequest = f.manager.refresh();
  await ready(() => f.reads.length === 1);
  f.data.backlogKey = 'new-secret-key';
  assert.equal((await f.manager.refresh()).rule, 'backlog');
  gate.resolve({textFormattingRule: 'markdown'});
  await oldRequest;
  assert.equal((await f.manager.getState()).rule, 'backlog');
  assert.equal(f.data.backlogFormattingCache[0].fingerprint, createHash('sha256').update('new-secret-key').digest('hex'));
  assert.equal(f.writes.length, 1);
});

test('caches stay distinct per configured space and are bounded to eight entries', async () => {
  const f = fixture({read: async url => ({name: new URL(url).hostname,
    textFormattingRule: url.includes('space0.') ? 'backlog' : 'markdown'})});
  const use = space => {f.data.backlogSpaceUrl = space; return f.manager;};
  await use('https://space0.backlog.com').refresh();
  await use('https://space1.backlog.com').refresh();
  assert.equal(f.data.backlogFormattingCache.length, 2);
  assert.equal((await use('https://space0.backlog.com').refresh({force: false})).rule, 'backlog');
  assert.equal((await use('https://space1.backlog.com').refresh({force: false})).rule, 'markdown');
  assert.equal(f.reads.length, 2);
  for (let i = 2; i < 10; i++) await use(`https://space${i}.backlog.com`).refresh();
  assert.equal(f.data.backlogFormattingCache.length, 8);
  assert.equal(new Set(f.data.backlogFormattingCache.map(state => state.origin)).size, 8);
});

test('reply format follows the target project even when its space uses the opposite rule', async () => {
  for (const projectRule of ['markdown', 'backlog']) {
    const spaceRule = projectRule === 'markdown' ? 'backlog' : 'markdown';
    const f = fixture({read: async url => url.endsWith('/space') ? {textFormattingRule: spaceRule}
      : {projectKey: 'EXAMPLE', textFormattingRule: projectRule}});
    const reply = await f.reply();
    assert.equal(reply.rule, projectRule);
    assert.equal(reply.source, 'project');
    assert.equal(reply.spaceRule, spaceRule);
    assert.equal(reply.projectKey, 'EXAMPLE');
    assert.equal('fingerprint' in reply, false);
    assert.equal(f.reads.length, 2);
    assert.ok(f.reads.some(read => read.url === `${origin}/api/v2/projects/EXAMPLE`));
  }
});

test('each reply rechecks its own project while retaining a fresh space cache', async () => {
  let rule = 'markdown';
  const f = fixture({read: async url => url.endsWith('/space') ? {textFormattingRule: 'markdown'}
    : {projectKey: url.split('/').at(-1), textFormattingRule: rule}});
  assert.equal((await f.reply()).rule, 'markdown');
  rule = 'backlog';
  assert.equal((await f.reply()).rule, 'backlog');
  const second = await f.reply({issueKey: 'OTHER_PROJECT-4'});
  assert.equal(second.projectKey, 'OTHER_PROJECT');
  assert.equal(second.rule, 'backlog');
  assert.equal(f.reads.filter(read => read.url.endsWith('/space')).length, 1);
  assert.equal(f.reads.filter(read => read.url.includes('/projects/')).length, 3);
});

test('a valid project rule works even if its space request fails', async () => {
  const f = fixture({read: async url => {
    if (url.endsWith('/space')) throw new Error('network unavailable');
    return {projectKey: 'EXAMPLE', textFormattingRule: 'backlog'};
  }});
  const reply = await f.reply();
  assert.equal(reply.rule, 'backlog');
  assert.equal(reply.source, 'project');
  assert.equal(reply.spaceRule, '');
});

test('failed project requests never guess from a successfully fetched space default', async () => {
  for (const spaceFails of [false, true]) {
    const f = fixture({read: async url => {
      if (!spaceFails && url.endsWith('/space')) return {textFormattingRule: 'markdown'};
      throw new Error('test-secret-key');
    }});
    const reply = await f.reply();
    assert.equal(reply.rule, '');
    assert.equal(reply.source, 'unknown');
    assert.match(reply.message, /プレーンテキスト/);
    assert.equal(JSON.stringify(reply).includes('test-secret-key'), false);
    assert.match(f.api.instruction(reply), /プレーンテキスト/);
  }
});

test('mismatched and malformed project responses fall back to plain text', async () => {
  for (const project of [null, [], {}, {projectKey: 'OTHER', textFormattingRule: 'markdown'},
    {projectKey: 'EXAMPLE', textFormattingRule: null}, {projectKey: 'EXAMPLE', textFormattingRule: 'html'},
    {projectKey: 'EXAMPLE'}, {projectKey: 1, textFormattingRule: 'markdown'},
    {projectKey: {}, textFormattingRule: 'markdown'}]) {
    const f = fixture({read: async url => url.endsWith('/space') ? {textFormattingRule: 'markdown'} : project});
    const reply = await f.reply();
    assert.equal(reply.rule, '');
    assert.equal(reply.source, 'unknown');
  }
});

test('explicit inheritance requires a confirmed space rule', async () => {
  for (const rule of ['markdown', 'backlog', 'invalid']) {
    const f = fixture({read: async url => url.endsWith('/space') ? {textFormattingRule: rule}
      : {projectKey: 'EXAMPLE', textFormattingRule: 'space'}});
    const reply = await f.reply();
    assert.equal(reply.rule, rule === 'invalid' ? '' : rule);
    assert.equal(reply.source, rule === 'invalid' ? 'unknown' : 'space');
  }
});

test('reply requests reject untrusted origins and project paths before any request', async () => {
  for (const args of [{origin: 'https://evil.test'}, {origin: `${origin}/view/EXAMPLE-1`},
    {issueKey: '../../EXAMPLE-1'}, {issueKey: 'EXAMPLE?key=secret-1'}]) {
    const f = fixture();
    await assert.rejects(f.reply(args), /返信先のプロジェクト/);
    assert.equal(f.reads.length, 0);
  }
});

test('reply requests for another Backlog space or without a saved space never send the key', async () => {
  for (const [settings, args] of [[{}, {origin: 'https://other.backlog.com'}], [{}, {origin: 'https://support-ja.backlog.com'}],
    [{backlogSpaceUrl: '', backlogLastSpaceUrl: origin}, {}]]) {
    const f = fixture({settings});
    await assert.rejects(f.reply(args), /APIキーを発行したBacklogスペース以外/);
    assert.equal(f.reads.length + f.writes.length, 0);
  }
});

test('format instructions preserve application precedence and provide syntax for both formats', () => {
  const {api} = fixture();
  const markdown = api.instruction({rule: 'markdown'});
  const backlog = api.instruction({rule: 'backlog'});
  const unknown = api.instruction({rule: 'html'});
  assert.match(markdown, /Markdown記法を使います/);
  assert.ok(markdown.includes('**強調**') && markdown.includes('[表示名](URL)'));
  assert.match(backlog, /Backlog記法を使います/);
  assert.ok(backlog.includes("''強調''") && backlog.includes('[[表示名:URL]]') && backlog.includes('{quote}'));
  assert.match(unknown, /プレーンテキスト/);
  for (const text of [markdown, backlog, unknown]) {
    assert.match(text, /出力先の設定を優先/);
    assert.match(text, /宛名だけを独立した行/);
    assert.match(text, /引用と回答の間にも空行/);
    assert.match(text, /実際の改行文字/);
  }
});

test('explicit refresh still reads the server alongside a fresh cache lookup', async () => {
  let rule = 'markdown';
  const f = fixture({read: async () => ({textFormattingRule: rule})});
  await f.manager.refresh();
  rule = 'backlog';
  const [, forced] = await Promise.all([f.manager.refresh({force: false}), f.manager.refresh()]);
  assert.equal(forced.rule, 'backlog');
  assert.equal(f.reads.length, 2);
  assert.equal((await f.manager.getState()).rule, 'backlog');
});

function registeredSpaces() {
  return [
    {origin, activeKeyId: 'first', keys: [
      {id: 'first', label: '個人用', apiKey: 'space-one-first'},
      {id: 'second', label: '業務用', apiKey: 'space-one-second'}
    ]},
    {origin: 'https://other.backlog.jp', activeKeyId: 'other', keys: [
      {id: 'other', label: '別スペース', apiKey: 'space-two-key'}
    ]}
  ];
}

test('registered spaces use their own active key and keep formatting caches separate', async () => {
  const f = fixture({settings: {backlogSpaces: registeredSpaces()}, read: async (url, apiKey) => ({
    name: new URL(url).hostname, textFormattingRule: apiKey === 'space-two-key' ? 'backlog' : 'markdown'
  })});
  assert.equal((await f.manager.refresh({origin})).rule, 'markdown');
  const secondOrigin = 'https://other.backlog.jp';
  assert.equal((await f.manager.refresh({origin: secondOrigin})).rule, 'backlog');
  assert.deepEqual(f.reads.map(({url, apiKey}) => ({url, apiKey})), [
    {url: `${origin}/api/v2/space`, apiKey: 'space-one-first'},
    {url: `${secondOrigin}/api/v2/space`, apiKey: 'space-two-key'}
  ]);
  assert.equal((await f.manager.getState({origin})).rule, 'markdown');
  assert.equal((await f.manager.getState({origin: secondOrigin})).rule, 'backlog');
  assert.equal(f.data.backlogFormattingCache.length, 2);
  assert.equal(JSON.stringify(f.data.backlogFormattingCache).includes('space-one-first'), false);
});

test('switching a registered active key invalidates its cache and ignores in-flight old results', async () => {
  const gate = deferred();
  const f = fixture({settings: {backlogSpaces: registeredSpaces()}, read: async (_url, apiKey) =>
    apiKey === 'space-one-first' ? gate.promise : {textFormattingRule: 'backlog'}});
  const oldRequest = f.manager.refresh({origin});
  await ready(() => f.reads.length === 1);
  f.data.backlogSpaces[0].activeKeyId = 'second';
  assert.equal((await f.manager.getState({origin})).status, 'unconfigured');
  assert.equal((await f.manager.refresh({origin, force: false})).rule, 'backlog');
  gate.resolve({textFormattingRule: 'markdown'});
  await oldRequest;
  assert.equal((await f.manager.getState({origin})).rule, 'backlog');
  assert.equal(f.data.backlogFormattingCache[0].fingerprint, createHash('sha256').update('space-one-second').digest('hex'));
  assert.equal(f.writes.length, 1);
});

test('removing a registered space while refreshing cannot persist the response', async () => {
  const gate = deferred();
  const f = fixture({settings: {backlogSpaces: registeredSpaces()}, read: () => gate.promise});
  const pending = f.manager.refresh({origin});
  await ready(() => f.reads.length === 1);
  f.data.backlogSpaces.splice(0, 1);
  gate.resolve({textFormattingRule: 'markdown'});
  await pending;
  assert.equal((await f.manager.getState({origin})).status, 'unconfigured');
  assert.equal(f.writes.length, 0);
});

test('unknown origins and keys registered only in another space are rejected before network reads', async () => {
  const f = fixture({settings: {backlogSpaces: registeredSpaces()}});
  const unknown = 'https://unregistered.backlog.com';
  assert.equal((await f.manager.refresh({origin: unknown})).status, 'unconfigured');
  assert.equal((await f.manager.getState({origin: unknown})).status, 'unconfigured');
  for (const args of [{origin, apiKey: 'space-two-key'},
    {origin: 'https://other.backlog.jp', apiKey: 'space-one-first'},
    {origin: unknown, apiKey: 'space-one-first'}]) {
    await assert.rejects(f.reply(args), /APIキーを発行したBacklogスペース以外/);
  }
  assert.equal(f.reads.length + f.writes.length, 0);
});

test('an empty registry disables legacy credentials for formatting requests', async () => {
  const f = fixture({settings: {backlogSpaces: []}});
  assert.equal((await f.manager.getState()).status, 'unconfigured');
  assert.equal((await f.manager.refresh({origin})).status, 'unconfigured');
  await assert.rejects(f.reply(), /APIキーを発行したBacklogスペース以外/);
  assert.equal(f.reads.length + f.writes.length, 0);
});

test('a reply may finish using a captured key still registered to its original space', async () => {
  const f = fixture({settings: {backlogSpaces: registeredSpaces()}});
  f.data.backlogSpaces[0].activeKeyId = 'second';
  assert.equal((await f.reply({apiKey: 'space-one-first'})).rule, 'markdown');
  assert.equal(f.reads.find(read => read.url.includes('/projects/')).apiKey, 'space-one-first');
  assert.equal(f.reads.find(read => read.url.endsWith('/space')).apiKey, 'space-one-second');
});
