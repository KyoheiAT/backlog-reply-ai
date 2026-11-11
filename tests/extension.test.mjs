import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

const backgroundSource = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const promptManagerSource = await readFile(new URL('../prompt-manager.js', import.meta.url), 'utf8');
const promptDefaultsSource = await readFile(new URL('../prompt-defaults.js', import.meta.url), 'utf8');
const formattingSource = await readFile(new URL('../backlog-formatting.js', import.meta.url), 'utf8');
const credentialsSource = await readFile(new URL('../backlog-credentials.js', import.meta.url), 'utf8');
const recoverySource = await readFile(new URL('../tab-recovery.js', import.meta.url), 'utf8');
const defaultsContext = vm.createContext({});
vm.runInContext(promptDefaultsSource, defaultsContext);
const defaultFixedPrompt = defaultsContext.BacklogPromptDefaults.fixedPrompt;
const defaultGeneratedPrompt = defaultsContext.BacklogPromptDefaults.generatedPrompt;
const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const manifest = JSON.parse((await readFile(new URL('../manifest.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const sender = {id: extensionId, frameId: 0, url: 'https://example.backlog.com/view/TEST-12'};
const generation = {type: 'GENERATE_REPLY', issueKey: 'TEST-12', provider: 'copilot', instruction: '修正済みです。確認をお願いします。'};
const response = (payload, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => payload});

function background({settings = {}, fetch: handleFetch, native: handleNative, connectError, tabError = false} = {}) {
  const data = {backlogKey: 'secret-backlog-key', backlogSpaceUrl: 'https://example.backlog.com', ...settings};
  const calls = [];
  const nativeMessages = [];
  const updates = [];
  const ports = [];
  const timers = new Map();
  let nextTimerId = 0;
  let accessLevel;
  let now = 1000;
  let currentTabUrl;
  const clock = {
    now: () => now,
    advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
      }
      now = end;
    }
  };
  const event = () => {
    const listeners = new Set();
    return {addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), emit: value => [...listeners].forEach(listener => listener(value)), count: () => listeners.size};
  };
  const runtime = {
    id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`, onMessage: {addListener() {}}, onStartup: event(),
    connectNative(host) {
      if (connectError) throw new Error(connectError);
      const port = {
        host, onMessage: event(), onDisconnect: event(), closed: false,
        disconnect() {this.closed = true;},
        emit(message) {this.onMessage.emit(message);},
        fail(detail) {
          this.closed = true;
          runtime.lastError = {message: detail};
          this.onDisconnect.emit();
          delete runtime.lastError;
        },
        postMessage(message) {
          if (this.closed) throw new Error('Attempting to use a disconnected port object');
          nativeMessages.push({port, message});
          Promise.resolve().then(() => handleNative
            ? handleNative(message, {port, clock})
            : message.type === 'health'
              ? {id: message.id, ok: true, providers: ['copilot', 'codex']}
              : {id: message.id, ok: true, text: '修正しました。\n\nご確認ください。'})
            .then(result => {if (result !== undefined && !port.closed) port.emit(result);});
        }
      };
      ports.push(port);
      return port;
    }
  };
  const context = vm.createContext({
    URL, Promise, Date: class extends Date {constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;}},
    AbortController, TextDecoder, TextEncoder,
    crypto: {subtle: {digest: async (_, bytes) => createHash('sha256').update(bytes).digest()}},
    importScripts(...files) {
      for (const file of files) {
        const scripts = {'prompt-defaults.js': promptDefaultsSource, 'prompt-manager.js': promptManagerSource, 'backlog-credentials.js': credentialsSource, 'backlog-formatting.js': formattingSource, 'tab-recovery.js': recoverySource};
        assert.ok(Object.hasOwn(scripts, file));
        vm.runInContext(scripts[file], context);
      }
    },
    AbortSignal: {timeout: milliseconds => ({milliseconds})},
    setTimeout(callback, milliseconds) {const id = ++nextTimerId; timers.set(id, {callback, at: now + milliseconds}); return id;},
    clearTimeout: id => timers.delete(id),
    chrome: {runtime, tabs: {get: async () => ({url: currentTabUrl}), sendMessage: async (tabId, message, options) => {
      updates.push({tabId, message, options});
      if (tabError) throw new Error('tab closed');
    }}, storage: {local: {
      setAccessLevel: async value => {accessLevel = value;},
      remove: async keys => keys.forEach(key => delete data[key]),
      get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in data).map(key => [key, data[key]])),
      set: async values => {Object.assign(data, structuredClone(values));}
    }}},
    fetch: async (url, options) => {
      calls.push({url, options});
      if (handleFetch) return handleFetch(url, options, clock);
      if (new URL(url).pathname === '/api/v2/space') return response({name: 'Example', textFormattingRule: 'markdown'});
      if (new URL(url).pathname === '/api/v2/projects/TEST') return response({projectKey: 'TEST', textFormattingRule: 'markdown'});
      if (url.includes('/comments?')) return response([
        {content: '新しいコメント', created: '2026-10-27', createdUser: {name: '担当者B'}},
        {content: '古いコメント', created: '2026-10-26', createdUser: {name: '担当者A'}}
      ]);
      if (url.includes('/api/v2/issues/')) return response({summary: '修正依頼', description: '元の説明', status: {name: '処理中'}});
      throw new Error('Unexpected non-Backlog HTTP request');
    }
  });
  vm.runInContext(backgroundSource, context);
  return {calls, nativeMessages, updates, ports, data, clock, timers, fireStartup: () => runtime.onStartup.emit(), handle: (message = generation, from = sender, tabUrl = from.url) => {
    currentTabUrl = tabUrl;
    return context.handleMessage(message, {...from, tab: from.tab || {id: 1}});
  }, accessLevel: () => accessLevel};
}

function healthReply(message) {return {id: message.id, ok: true, providers: ['copilot', 'codex']};}
function assertPortsClosed(app) {
  assert.ok(app.ports.every(port => port.closed));
  assert.ok(app.ports.every(port => port.onMessage.count() === 0 && port.onDisconnect.count() === 0));
  assert.equal(app.timers.size, 0);
}

function commentHistoryFixture({settings = {}, pages, myself = {id: 7, name: '本人'}, status = 200} = {}) {
  const own = (id, content, authorId = 7) => ({id, content, createdUser: {id: authorId, name: '同じ表示名'}, created: '2026-11-04T00:00:00Z'});
  return background({settings, fetch: url => {
    const target = new URL(url);
    if (target.pathname === '/api/v2/users/myself') return response(myself, status);
    if (target.pathname.endsWith('/comments')) return response(pages ? pages(target, own) : [
      own(40, '', 7), own(39, '相手からの最新の確認', 8), own(38, 'EXCLUDED_LATEST_OWN'),
      own(37, '同姓同名の別ユーザー', 8), own(36, '以前の本人のコメント')
    ]);
    if (target.pathname.includes('/projects/')) return response({projectKey: 'TEST', textFormattingRule: 'markdown'});
    if (target.pathname.endsWith('/space')) return response({textFormattingRule: 'markdown'});
    return response({summary: '確認依頼', description: '課題の本文'});
  }});
}

test('latest-own exclusion is strictly opt-in and does not fetch identity or alter history when off', async () => {
  for (const value of [undefined, false, 'true', 1]) {
    const app = commentHistoryFixture({settings: {excludeLatestOwnComment: value}});
    await app.handle({...generation, mode: 'agent'});
    const request = app.nativeMessages.find(({message}) => message.type === 'generate').message;
    assert.match(request.prompt, /EXCLUDED_LATEST_OWN/);
    assert.equal(request.backlog.excludedComment, undefined);
    assert.ok(!app.calls.some(call => new URL(call.url).pathname === '/api/v2/users/myself'));
    assert.equal(new URL(app.calls.find(call => call.url.includes('/comments?')).url).searchParams.get('count'), '50');
    assertPortsClosed(app);
  }
});

test('both providers and modes omit exactly the latest nonempty authenticated-user comment before model input', async () => {
  for (const provider of ['copilot', 'codex']) for (const mode of ['chat', 'agent']) {
    const app = commentHistoryFixture({settings: {provider, excludeLatestOwnComment: true,
      promptProfile: {displayName: '別の登録名', profileUrl: 'https://example.backlog.com/user/another'}}});
    const result = await app.handle({...generation, provider, mode, requestId: 'exclude'}, {...sender, tab: {id: 1}});
    const request = app.nativeMessages.find(({message}) => message.type === 'generate').message;
    const context = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n\n') + 2));
    assert.equal(result.commentsUsed, 4);
    assert.equal(context.comments.length, 4);
    assert.ok(!request.prompt.includes('EXCLUDED_LATEST_OWN'));
    for (const kept of ['相手からの最新の確認', '同姓同名の別ユーザー', '以前の本人のコメント']) assert.ok(request.prompt.includes(kept));
    assert.ok(!request.prompt.includes('secret-backlog-key'));
    if (mode === 'agent') assert.deepEqual(JSON.parse(JSON.stringify(request.backlog.excludedComment)), {issueKey: 'TEST-12', commentId: 38});
    else assert.equal(request.backlog, undefined);
    assert.equal(app.updates.filter(update => /1件をAIへの履歴から除外/.test(update.message.message)).length, 1);
    assertPortsClosed(app);
  }
});

test('exclusion searches beyond the model history window and handles an inclusive page boundary', async () => {
  const app = commentHistoryFixture({settings: {excludeLatestOwnComment: true, maxComments: 2}, pages: (target, own) => {
    assert.equal(target.searchParams.get('count'), '100');
    const maxId = target.searchParams.get('maxId');
    if (!maxId) return Array.from({length: 100}, (_, index) => own(300 - index, `other-${index}`, 8));
    assert.equal(maxId, '201');
    return [own(201, 'boundary', 8), own(200, 'EXCLUDED_LATEST_OWN'), own(199, 'older own')];
  }});
  const result = await app.handle({...generation, mode: 'agent'});
  const request = app.nativeMessages.find(({message}) => message.type === 'generate').message;
  assert.equal(request.backlog.excludedComment.commentId, 200);
  assert.equal(result.commentsUsed, 2);
  assert.match(request.prompt, /other-0/);
  assert.ok(!request.prompt.includes('EXCLUDED_LATEST_OWN') && !request.prompt.includes('older own'));
  assert.equal(app.calls.filter(call => call.url.includes('/comments?')).length, 2);
  assertPortsClosed(app);
});

test('an absent own comment is reported without dropping others or exposing user account data', async () => {
  const app = commentHistoryFixture({settings: {excludeLatestOwnComment: true},
    myself: {id: 7, mailAddress: 'private-address@example.invalid'},
    pages: (_, own) => [own(4, '', 7), own(3, '相手の本文', 8)]});
  const result = await app.handle({...generation, mode: 'agent', requestId: 'absent'}, {...sender, tab: {id: 1}});
  const request = app.nativeMessages.find(({message}) => message.type === 'generate').message;
  assert.equal(result.commentsUsed, 2);
  assert.equal(request.backlog.excludedComment, undefined);
  assert.ok(!request.prompt.includes('private-address'));
  assert.ok(app.updates.some(update => /除外する自分のコメントはありません/.test(update.message.message)));
  assertPortsClosed(app);
});

test('identity failures and malformed history stop the opt-in test before generation', async () => {
  for (const options of [{myself: {}}, {status: 403}, {pages: () => [{content: 'unknown ID', createdUser: {id: 7}}]}]) {
    const app = commentHistoryFixture({settings: {excludeLatestOwnComment: true}, ...options});
    await assert.rejects(app.handle(), /本人情報|HTTP 403|コメントを確認/);
    assert.ok(app.nativeMessages.every(({message}) => message.type !== 'generate'));
    assertPortsClosed(app);
  }
});

test('bounded history search fails visibly instead of silently using an unverified own comment', async () => {
  const app = commentHistoryFixture({settings: {excludeLatestOwnComment: true}, pages: (target, own) => {
    const top = Number(target.searchParams.get('maxId') || 5000);
    return Array.from({length: 100}, (_, index) => own(top - index, '別ユーザーの投稿', 8));
  }});
  await assert.rejects(app.handle(), /検索上限/);
  assert.equal(app.calls.filter(call => call.url.includes('/comments?')).length, 10);
  assert.ok(app.nativeMessages.every(({message}) => message.type !== 'generate'));
  assertPortsClosed(app);
});

test('saved legacy prompts are preserved but followed by an explicit editing and data contract in both modes', async () => {
  const generatedPrompt = '簡潔な新規返信だけ。{{課題情報}} と {{コメント履歴}} に従う。';
  const fixedPrompt = 'CUSTOM_STYLE_SENTINEL';
  for (const mode of ['chat', 'agent']) {
    const app = background({settings: {promptProfile: {generatedPrompt, fixedPrompt, locked: true}}});
    const instruction = '整えて：確認してください。金額は8,000円、予定は未定です。';
    await app.handle({...generation, mode, instruction});
    const request = app.nativeMessages.find(({message}) => message.type === 'generate').message;
    const contract = request.prompt.indexOf('【今回の入力の扱い・指示の優先順位】');
    assert.ok(contract > request.prompt.indexOf(generatedPrompt));
    assert.ok(contract > request.prompt.indexOf(fixedPrompt));
    assert.match(request.prompt, /instruction がユーザー/);
    assert.match(request.prompt, /生成プロンプトが文体・タスク判定・編集方針を定める主プロンプト/);
    assert.doesNotMatch(request.prompt, /文体・編集方針は「常に使う追加指示」を優先/);
    const context = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n\n') + 2));
    assert.equal(context.instruction, instruction);
    assert.equal(app.data.promptProfile.generatedPrompt, generatedPrompt);
    assert.equal(app.data.promptProfile.fixedPrompt, fixedPrompt);
    assert.equal(app.data.promptProfile.locked, true);
    assertPortsClosed(app);
  }
});

test('model listing is limited to settings and sends no ticket content or API key', async () => {
  const app = background({native: message => ({id: message.id, ok: true, models: [{id: 'model-one', name: 'Model One'}]})});
  const options = {id: extensionId, url: `chrome-extension://${extensionId}/options.html`};
  await assert.rejects(app.handle({type: 'LIST_MODELS', provider: 'copilot'}), /設定画面/);
  await assert.rejects(app.handle({type: 'LIST_MODELS', provider: 'other'}, options), /不正/);
  const result = await app.handle({type: 'LIST_MODELS', provider: 'codex'}, options);
  assert.equal(result.models[0].id, 'model-one');
  assert.equal(app.calls.length, 0);
  assert.equal(app.nativeMessages.length, 1);
  assert.deepEqual(Object.keys(app.nativeMessages[0].message).sort(), ['id', 'provider', 'type']);
  assert.equal(app.nativeMessages[0].message.provider, 'codex');
  assertPortsClosed(app);
});

test('references reject foreign spaces, invalid modes and excessive targets before connecting', async () => {
  const app = background();
  for (const reference of ['https://evil.example/view/OTHER-1', 'https://other.backlog.com/view/OTHER-1',
    'https://user:pass@example.backlog.com/view/OTHER-1', 'https://example.backlog.com/api/v2/issues',
    'OTHER-1 OTHER-2 OTHER-3 OTHER-4 OTHER-5 OTHER-6', 'ONE TWO THREE FOUR', '../secret']) {
    await assert.rejects(app.handle({...generation, references: reference}), /参照/);
  }
  await assert.rejects(app.handle({...generation, mode: 'invalid'}), /モード/);
  for (const value of ['false', 0, null]) await assert.rejects(app.handle({...generation, mode: 'agent', includeCurrentProject: value}), /設定が不正/);
  assert.equal(app.ports.length, 0);
  assert.equal(app.calls.length, 0);
});

test('chat references fetch deduplicated issue context and project summaries without sending the key locally', async () => {
  const app = background({fetch: url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/comments')) return response([{content: '経緯'}]);
    if (parsed.pathname === '/api/v2/projects/OTHER') return response({id: 22, projectKey: 'OTHER', name: '別のプロジェクト'});
    if (parsed.pathname === '/api/v2/issues') {
      assert.equal(parsed.searchParams.get('projectId[]'), '22');
      assert.equal(parsed.searchParams.get('count'), '10');
      return response([{issueKey: 'OTHER-9', summary: '関連する作業', status: {name: '完了'}}]);
    }
    return response({summary: parsed.pathname.endsWith('/OTHER-1') ? '別課題' : '現在課題'});
  }});
  const result = await app.handle({...generation, includeCurrentProject: false, references: 'OTHER-1, https://example.backlog.com/view/OTHER-1\nOTHER'});
  const message = app.nativeMessages.find(item => item.message.type === 'generate').message;
  assert.equal(message.mode, 'chat');
  assert.equal(message.backlog, undefined);
  assert.ok(!JSON.stringify(message).includes('secret-backlog-key'));
  assert.ok(message.prompt.includes('別課題') && message.prompt.includes('別のプロジェクト'));
  assert.equal(app.calls.filter(call => new URL(call.url).pathname === '/api/v2/issues/OTHER-1').length, 1);
  assert.equal(result.sources.length, 3);
  assertPortsClosed(app);
});

test('agent mode forwards scoped credentials only to the local host and filters result sources', async () => {
  const app = background({native: message => message.type === 'health' ? healthReply(message) : {
    id: message.id, ok: true, text: '調査結果です。', toolCalls: 2,
    sources: [{title: '取得課題', url: 'https://example.backlog.com/view/OTHER-1'},
      {title: 'evil', url: 'https://evil.example/'}, {title: 'secret', url: 'https://example.backlog.com/view/OTHER-2?apiKey=secret'}]
  }});
  const result = await app.handle({...generation, mode: 'agent', references: 'OTHER-1 THIRD'});
  const message = app.nativeMessages.find(item => item.message.type === 'generate').message;
  assert.equal(message.backlog.apiKey, 'secret-backlog-key');
  assert.equal(message.backlog.origin, 'https://example.backlog.com');
  assert.deepEqual([...message.backlog.issueKeys], ['TEST-12', 'OTHER-1']);
  assert.deepEqual([...message.backlog.projectKeys], ['TEST', 'THIRD']);
  assert.ok(!message.prompt.includes('secret-backlog-key'));
  assert.equal(app.calls.length, 4, 'two formatting reads plus current issue and comments; additional issue data stays in MCP');
  assert.equal(result.toolCalls, 2);
  assert.equal(result.sources.length, 2);
  assertPortsClosed(app);
});

test('agent project opt-out keeps only current and explicitly selected issues or projects', async () => {
  for (const [references, issues, projects] of [
    ['', ['TEST-12'], []],
    ['TEST-13 OTHER-1', ['TEST-12', 'TEST-13', 'OTHER-1'], []],
    ['OTHER', ['TEST-12'], ['OTHER']],
    ['TEST OTHER', ['TEST-12'], ['TEST', 'OTHER']],
  ]) {
    const app = background();
    await app.handle({...generation, mode: 'agent', references, includeCurrentProject: false});
    const message = app.nativeMessages.find(item => item.message.type === 'generate').message;
    assert.deepEqual([...message.backlog.issueKeys], issues);
    assert.deepEqual([...message.backlog.projectKeys], projects);
    assert.match(message.prompt, /"includeCurrentProject":false/);
    assert.equal(app.calls.length, 4);
    assertPortsClosed(app);
  }
});

test('agent scope accepts current and referenced project keys starting with a digit or underscore', async () => {
  for (const projectKey of ['1PROJ', '_PROJ']) {
    const app = background();
    const issueKey = `${projectKey}-12`;
    await app.handle({...generation, issueKey, mode: 'agent', references: '2OTHER https://example.backlog.com/projects/_OTHER'},
      {...sender, url: `https://example.backlog.com/view/${issueKey}`});
    const message = app.nativeMessages.find(item => item.message.type === 'generate').message;
    assert.deepEqual([...message.backlog.issueKeys], [issueKey]);
    assert.deepEqual([...message.backlog.projectKeys], [projectKey, '2OTHER', '_OTHER']);
    assertPortsClosed(app);
  }
});

test('native messaging permissions exclude localhost, unrelated websites and Anthropic', () => {
  assert.equal(manifest.version, '1.2.0');
  assert.deepEqual(manifest.permissions, ['storage', 'nativeMessaging', 'scripting']);
  assert.deepEqual(manifest.content_scripts[0].js, ['panel-layout.js', 'content.js']);
  assert.ok(!manifest.host_permissions.some(value => value === 'https://*/*' || value.includes('anthropic') || value.includes('127.0.0.1') || value.includes('localhost')));
});

test('migration keeps Backlog settings and removes legacy Claude credentials without starting a host', async () => {
  const app = background({settings: {claudeKey: 'old-key', model: 'claude-model', maxComments: 70}});
  const result = await app.handle({type: 'GET_SETTINGS'});
  assert.equal(app.data.backlogKey, 'secret-backlog-key');
  assert.equal(app.data.claudeKey, undefined);
  assert.equal(app.data.model, undefined);
  assert.equal(result.maxComments, 70);
  assert.equal(result.provider, 'copilot');
  assert.equal(result.backlogKey, undefined);
  assert.equal(app.accessLevel().accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(app.calls.length, 0);
  assert.equal(app.ports.length, 0);
});

test('untrusted origins, frames, paths and extension callers cannot retrieve keys or start a host', async () => {
  const app = background();
  for (const url of [
    'https://evil.example/view/TEST-12', 'https://example.backlog.com.evil.example/view/TEST-12',
    'http://example.backlog.com/view/TEST-12', 'https://example.backlog.com:8443/view/TEST-12',
    'https://example.backlog.com/view/TEST-12/extra', 'https://example.backlog.com/view/TEST-12%2Fother'
  ]) await assert.rejects(app.handle(generation, {...sender, url}), /課題詳細画面/);
  await assert.rejects(app.handle(generation, {...sender, frameId: 1}), /課題詳細画面/);
  await assert.rejects(app.handle(generation, {...sender, tab: {}}), /課題詳細画面/);
  await assert.rejects(app.handle(generation, {...sender, id: 'different-extension'}), /呼び出し元/);
  assert.equal(app.calls.length, 0);
  assert.equal(app.ports.length, 0);
});

test('same-document navigation uses the current tab issue and rejects stale or cross-origin requests', async () => {
  const app = background();
  const currentUrl = 'https://example.backlog.com/view/TEST-13';
  const result = await app.handle({...generation, issueKey: 'TEST-13'}, sender, currentUrl);
  assert.equal(result.issueKey, 'TEST-13');
  assert.ok(app.calls.some(call => new URL(call.url).pathname === '/api/v2/issues/TEST-13'));
  const settings = await app.handle({type: 'GET_SETTINGS'}, {...sender, url: 'https://example.backlog.com/projects/TEST'}, currentUrl);
  assert.equal(settings.provider, 'copilot');
  const callCount = app.calls.length;
  await assert.rejects(app.handle(generation, sender, currentUrl), /課題が切り替わりました/);
  await assert.rejects(app.handle(generation, sender, 'https://other.backlog.com/view/TEST-12'), /課題詳細画面/);
  await assert.rejects(app.handle(generation, sender, 'https://example.backlog.com/projects/TEST'), /課題詳細画面/);
  assert.equal(app.calls.length, callCount);
});

test('settings health check opens one native port, never generates and always disconnects', async () => {
  const app = background();
  await assert.rejects(app.handle({type: 'CHECK_BRIDGE'}), /設定画面/);
  const result = await app.handle({type: 'CHECK_BRIDGE'}, {id: extensionId, url: `chrome-extension://${extensionId}/options.html`});
  assert.equal(app.ports.length, 1);
  assert.equal(app.ports[0].host, 'com.backlog_ai.reply');
  assert.deepEqual(result.providers, ['copilot', 'codex']);
  assert.deepEqual(app.nativeMessages.map(call => call.message.type), ['health']);
  assert.equal(app.calls.length, 0);
  assertPortsClosed(app);
});

for (const provider of ['copilot', 'codex']) {
  test(`${provider}: health and generation share one native port; Backlog key is never forwarded`, async () => {
    const app = background({settings: {provider, [`${provider}Model`]: 'test-model', maxComments: 999}});
    const result = await app.handle({...generation, provider});
    assert.equal(result.provider, provider);
    assert.equal(result.text, '修正しました。\n\nご確認ください。');
    assert.equal(result.commentsUsed, 2);
    assert.equal(app.calls.length, 4);
    assert.ok(app.calls.every(call => call.url.startsWith('https://example.backlog.com/') && new URL(call.url).searchParams.get('apiKey') === 'secret-backlog-key'));
    assert.equal(new URL(app.calls.find(call => call.url.includes('/comments?')).url).searchParams.get('count'), '100');
    assert.ok(app.calls.every(call => call.options.credentials === 'omit' && call.options.redirect === 'error'));
    assert.equal(app.ports.length, 1);
    assert.deepEqual(app.nativeMessages.map(call => call.message.type), ['health', 'generate']);
    assert.ok(app.nativeMessages.every(call => !JSON.stringify(call.message).includes('secret-backlog-key')));
    const body = app.nativeMessages[1].message;
    assert.equal(body.provider, provider);
    assert.equal(body.model, 'test-model');
    assert.notEqual(body.id, app.nativeMessages[0].message.id);
    assert.ok(body.prompt.indexOf('古いコメント') < body.prompt.indexOf('新しいコメント'));
    assert.ok(body.prompt.includes(generation.instruction));
    assertPortsClosed(app);
  });
}

test('invalid inputs do not start native processes and blank model uses provider default', async () => {
  const app = background();
  await assert.rejects(app.handle({...generation, instruction: ' '}), /伝えたい内容/);
  await assert.rejects(app.handle({...generation, issueKey: 'OTHER-9'}), /課題が切り替わりました/);
  await assert.rejects(app.handle({...generation, provider: 'codex'}), /AIが変更/);
  assert.equal(app.calls.length, 0);
  assert.equal(app.ports.length, 0);
  await app.handle();
  assert.equal(Object.hasOwn(app.nativeMessages.find(call => call.message.type === 'generate').message, 'model'), false);
});

for (const [nativeError, expected] of [
  ['Specified native messaging host not found.', /登録されていません/],
  ['Access to the specified native messaging host is forbidden.', /許可されていません/],
  ['Failed to start native messaging host.', /起動できません/],
  ['Native host has exited.', /切断されました/]
]) {
  test(`native disconnect is translated: ${nativeError}`, async () => {
    const app = background({native: (message, {port}) => {port.fail(nativeError);}});
    await assert.rejects(app.handle(), error => expected.test(error.message) && error.message.includes(`npm run setup -- --extension-id ${extensionId}`));
    assert.equal(app.calls.length, 0);
    assertPortsClosed(app);
  });
}

test('synchronous native launch failures also release the concurrency slot', async () => {
  const app = background({connectError: 'Specified native messaging host not found.'});
  for (let i = 0; i < 3; i++) await assert.rejects(app.handle(), /登録されていません/);
  assert.equal(app.ports.length, 0);
});

test('Backlog failures close the native port without forwarding a generation or key', async () => {
  const app = background({fetch: () => response({}, 403)});
  await assert.rejects(app.handle(), error => /Backlog API HTTP 403/.test(error.message) && !error.message.includes('secret-backlog-key'));
  assert.deepEqual(app.nativeMessages.map(call => call.message.type), ['health']);
  assertPortsClosed(app);
});

test('native generation errors and malformed responses release the native process', async () => {
  const errorApp = background({native: message => message.type === 'health' ? healthReply(message) : {id: message.id, ok: false, error: 'CLIにログインしてください。'}});
  await assert.rejects(errorApp.handle(), /CLIにログイン/);
  assertPortsClosed(errorApp);
  const malformedApp = background({native: message => ({id: message.id, text: 'missing ok'})});
  await assert.rejects(malformedApp.handle(), /応答形式が不正/);
  assertPortsClosed(malformedApp);
});

test('unrelated response ids cannot resolve a pending native request', async () => {
  const app = background({native: (message, {port}) => {
    port.emit({id: 'unrelated', ok: true, text: 'wrong response'});
    return message.type === 'health' ? healthReply(message) : {id: message.id, ok: true, text: 'correct response'};
  }});
  assert.equal((await app.handle()).text, 'correct response');
  assertPortsClosed(app);
});

test('progress frames stay non-terminal and only safe activity labels reach the requesting document', async () => {
  const app = background({native: (message, {port}) => {
    if (message.type === 'health') return healthReply(message);
    assert.equal(message.progress, true);
    const emit = progress => port.emit({id: message.id, type: 'progress', progress});
    port.emit({id: 'unrelated', type: 'progress', progress: {stage: 'generating'}});
    emit({stage: 'planning', step: 2, reasoning: 'private thought', message: 'secret-backlog-key'});
    emit({stage: 'reading', tool: 'get_issue', target: 'TEST-13'});
    emit({stage: 'read_complete', tool: 'get_issue', target: 'TEST-13', sourceCount: 1, text: 'private issue body'});
    emit({stage: 'thinking', message: 'not activity'});
    emit({stage: 'reading', target: '<script>secret-backlog-key</script>', tool: 'delete_issue'});
    return {id: message.id, ok: true, text: '最終返信'};
  }});
  const result = await app.handle({...generation, mode: 'agent', requestId: 'ui-request-1'}, {...sender, tab: {id: 7}, documentId: 'document-1'});
  assert.equal(result.text, '最終返信');
  assert.equal(app.updates.length, 8); // Four preparation/format events plus four accepted native events.
  for (const [index, update] of app.updates.entries()) {
    assert.equal(update.tabId, 7);
    assert.deepEqual({...update.options}, {documentId: 'document-1'});
    assert.equal(update.message.requestId, 'ui-request-1');
    assert.equal(update.message.issueKey, generation.issueKey);
    assert.equal(update.message.sequence, index + 1);
    assert.equal(update.message.type, 'GENERATION_PROGRESS');
  }
  assert.ok(app.updates.some(update => /TEST-13.*取得が完了/.test(update.message.message)));
  assert.ok(!/secret-backlog-key|private thought|private issue body|<script>|delete_issue/.test(JSON.stringify(app.updates)));
  assertPortsClosed(app);
});

test('progress delivery failures do not interrupt generation or cleanup', async () => {
  const app = background({tabError: true});
  const result = await app.handle({...generation, requestId: 'ui-request-2'}, {...sender, tab: {id: 8}});
  assert.ok(result.text);
  assert.deepEqual({...app.updates[0].options}, {frameId: 0});
  assertPortsClosed(app);
});

test('progress never extends the generation timeout and late frames are ignored', async () => {
  const app = background({native: message => message.type === 'health' ? healthReply(message) : undefined});
  const pending = app.handle({...generation, requestId: 'ui-request-3'}, {...sender, tab: {id: 9}});
  const rejection = assert.rejects(pending, /生成がタイムアウト/);
  await flush();
  const {port, message} = app.nativeMessages.find(call => call.message.type === 'generate');
  app.clock.advance(190000);
  port.emit({id: message.id, type: 'progress', progress: {stage: 'generating'}});
  app.clock.advance(5000);
  await rejection;
  const count = app.updates.length;
  port.emit({id: message.id, type: 'progress', progress: {stage: 'reply_ready'}});
  assert.equal(app.updates.length, count);
  assertPortsClosed(app);
});

test('health timeout closes the port before ticket data is fetched', async () => {
  const app = background({native: () => undefined});
  const pending = app.handle();
  const rejection = assert.rejects(pending, /起動がタイムアウト/);
  await flush();
  app.clock.advance(15000);
  await rejection;
  assert.equal(app.calls.length, 0);
  assertPortsClosed(app);
});

test('generation timeout closes the port and releases the concurrency slot', async () => {
  let hold = true;
  const app = background({native: message => message.type === 'health' ? healthReply(message) : hold ? undefined : {id: message.id, ok: true, text: '再試行成功'}});
  const pending = app.handle();
  const rejection = assert.rejects(pending, /生成がタイムアウト/);
  await flush();
  app.clock.advance(195000);
  await rejection;
  assertPortsClosed(app);
  hold = false;
  assert.equal((await app.handle()).text, '再試行成功');
  assertPortsClosed(app);
});

test('slow preparation leaves enough time for generation near the 180-second host limit', async () => {
  const app = background({
    fetch: (url, options, clock) => {
      if (new URL(url).pathname === '/api/v2/space') return response({textFormattingRule: 'markdown'});
      if (new URL(url).pathname === '/api/v2/projects/TEST') return response({projectKey: 'TEST', textFormattingRule: 'markdown'});
      clock.advance(14000); return response(url.includes('/comments?') ? [] : {summary: 'test'});
    },
    native: (message, {clock}) => {
      if (message.type === 'health') {clock.advance(14000); return healthReply(message);}
      clock.advance(179000);
      return {id: message.id, ok: true, text: '完了しました。'};
    }
  });
  assert.equal((await app.handle()).text, '完了しました。');
  assertPortsClosed(app);
});

test('extension-wide concurrency is limited to two generations and recovers after completion', async () => {
  let hold = true;
  const app = background({native: message => message.type === 'health' ? healthReply(message) : hold ? undefined : {id: message.id, ok: true, text: 'done'}});
  const first = app.handle();
  const second = app.handle();
  await flush();
  await assert.rejects(app.handle(), /同時に生成できるのは2件まで/);
  assert.equal(app.ports.length, 2);
  for (const {port, message} of app.nativeMessages.filter(call => call.message.type === 'generate')) port.emit({id: message.id, ok: true, text: 'done'});
  await Promise.all([first, second]);
  assertPortsClosed(app);
  hold = false;
  await app.handle();
  assert.equal(app.ports.length, 3);
  assertPortsClosed(app);
});

const flush = async () => {for (let i = 0; i < 200; i++) await Promise.resolve();};

const optionsSender = {id: extensionId, url: `chrome-extension://${extensionId}/options.html`};
const registeredProfile = {
  displayName: 'Example User', profileUrl: 'https://example.backlog.com/user/*example',
  generatedPrompt: '公式ガイドに基づく保存済み指示', fixedPrompt: '確認事項は最後にまとめる。', locked: false, revision: 2
};
function officialGuideResponse(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'example.backlog.com' && parsed.pathname === '/api/v2/space') return response({name: 'Example', textFormattingRule: 'markdown'});
  const match = /^\/api\/v2\/help_center\/ja\/articles\/(\d+)\.json$/.exec(parsed.pathname);
  if (parsed.hostname === 'support-ja.backlog.com' && match) {
    return new Response(JSON.stringify({article: {id: Number(match[1]), html_url: `https://support-ja.backlog.com/hc/ja/articles/${match[1]}`, body: '<p>公開操作ガイドのテスト用本文です。</p>'}}), {headers: {'content-type': 'application/json'}});
  }
  assert.equal(parsed.hostname, 'help-center.backlog.com');
  const title = parsed.pathname.endsWith('58b') ? 'テキスト整形ルール（Backlog記法）' : 'テキスト整形のルール（Markdown記法）';
  return new Response(`<html><title>${title} - よくあるご質問 | Backlog</title><article role="main"><p>公開記法ガイドのテスト用本文です。</p></article></html>`, {headers: {'content-type': 'text/html'}});
}

test('prompt settings are restricted to the options page and never reveal the Backlog credential', async () => {
  const app = background();
  for (const type of ['GET_PROMPT_PROFILE', 'SAVE_PROMPT_PROFILE', 'REGENERATE_PROMPT_PROFILE']) {
    await assert.rejects(app.handle({type}), /設定画面/);
    await assert.rejects(app.handle({type}, {...optionsSender, id: 'other-extension'}), /呼び出し元/);
  }
  const initial = await app.handle({type: 'GET_PROMPT_PROFILE'}, optionsSender);
  assert.equal(initial.profile.displayName, '');
  assert.equal(initial.profile.locked, false);
  assert.equal(initial.profile.revision, 0);
  assert.equal(initial.defaultFixedPrompt, defaultFixedPrompt);
  assert.equal(initial.defaultGeneratedPrompt, defaultGeneratedPrompt);
  assert.equal(initial.profile.generatedPrompt, defaultGeneratedPrompt);
  assert.equal(initial.profile.fixedPrompt, defaultFixedPrompt);
  assert.ok(!JSON.stringify(initial).includes('secret-backlog-key'));
  const saved = await app.handle({type: 'SAVE_PROMPT_PROFILE', profile: {...registeredProfile, locked: true, revision: 0}}, optionsSender);
  assert.equal(saved.profile.revision, 1);
  assert.equal(saved.profile.locked, true);
  assert.match(saved.effectivePrompt, /本人の情報（宛先ではありません）/);
  assert.ok(saved.effectivePrompt.includes(registeredProfile.profileUrl));
  assert.ok(saved.effectivePrompt.includes(registeredProfile.generatedPrompt));
  assert.ok(saved.effectivePrompt.includes(registeredProfile.fixedPrompt));
  assert.ok(saved.effectivePrompt.indexOf('【今回の入力の扱い・指示の優先順位】') > saved.effectivePrompt.indexOf(registeredProfile.fixedPrompt));
  await assert.rejects(app.handle({type: 'SAVE_PROMPT_PROFILE', profile: {...registeredProfile, revision: 0}}, optionsSender), /更新/);
  assert.equal(app.ports.length, 0);
  assert.equal(app.calls.length, 0);
});

test('both reply modes apply the saved identity, generated prompt and permanent instructions', async () => {
  for (const mode of ['chat', 'agent']) {
    const app = background({settings: {promptProfile: registeredProfile}});
    const saved = await app.handle({type: 'GET_PROMPT_PROFILE'}, optionsSender);
    await app.handle({...generation, mode});
    const request = app.nativeMessages.find(({message}) => message.type === 'generate').message;
    assert.ok(request.prompt.startsWith(`${saved.effectivePrompt}\n\n`));
    assert.ok(!request.prompt.includes('secret-backlog-key'));
    assert.match(request.prompt, /"spaceUrl":"https:\/\/example\.backlog\.com"/);
    assertPortsClosed(app);
  }
});

test('both providers and modes use the primary writing prompt exactly once with optional empty or custom additions', async () => {
  for (const provider of ['copilot', 'codex']) for (const mode of ['chat', 'agent']) {
    const app = background({settings: {provider, promptProfile: {fixedPrompt: '', revision: 0}}});
    const initial = await app.handle({type: 'GET_PROMPT_PROFILE'}, optionsSender);
    assert.equal(initial.profile.fixedPrompt, '');
    assert.equal(initial.profile.generatedPrompt, defaultGeneratedPrompt);
    assert.equal(initial.effectivePrompt.split(defaultGeneratedPrompt).length, 2);
    assert.ok(!initial.effectivePrompt.includes('常に使う追加指示（利用者独自'));
    await app.handle({...generation, provider, mode});
    const request = app.nativeMessages.find(({message}) => message.type === 'generate').message;
    assert.equal(request.prompt.split(defaultGeneratedPrompt).length, 2);
    assert.match(request.prompt, /宛名・@名前・敬称・CC行をそのまま保持/);
    assert.match(request.prompt, /完成した文面の全文だけが入力され/);
    assert.ok(!request.prompt.includes('secret-backlog-key'));
    const custom = await app.handle({type: 'SAVE_PROMPT_PROFILE', profile: {fixedPrompt: '個別の文体指示', revision: 0}}, optionsSender);
    assert.equal(custom.profile.fixedPrompt, '個別の文体指示');
    assert.equal(custom.effectivePrompt.split(defaultGeneratedPrompt).length, 2);
    assert.ok(custom.effectivePrompt.indexOf('個別の文体指示') > custom.effectivePrompt.indexOf(defaultGeneratedPrompt));
    assert.equal(custom.defaultFixedPrompt, '');
    await app.handle({type: 'SAVE_PROMPT_PROFILE', profile: {fixedPrompt: '', revision: 1}}, optionsSender);
    const empty = await app.handle({type: 'GET_PROMPT_PROFILE'}, optionsSender);
    assert.equal(empty.profile.fixedPrompt, '');
    assert.equal(empty.effectivePrompt.split(defaultGeneratedPrompt).length, 2);
    assert.ok(!empty.effectivePrompt.includes('個別の文体指示'));
    assertPortsClosed(app);
  }
});

test('manual prompt generation fetches only public guides and uses the saved AI and model without ticket credentials', async () => {
  const app = background({
    settings: {provider: 'codex', codexModel: 'saved-model', backlogKey: '', promptProfile: registeredProfile},
    fetch: officialGuideResponse,
    native: message => message.type === 'health' ? healthReply(message) : {id: message.id, ok: true, text: '新しく生成した共通指示'}
  });
  const result = await app.handle({type: 'REGENERATE_PROMPT_PROFILE', provider: 'copilot'}, optionsSender);
  assert.equal(app.calls.length, 5);
  assert.ok(app.calls.every(call => call.options.credentials === 'omit' && call.options.redirect === 'error'));
  assert.ok(app.calls.every(call => !call.url.includes('apiKey') && !call.url.includes('/user/')));
  const request = app.nativeMessages.find(({message}) => message.type === 'generate_prompt').message;
  assert.equal(request.provider, 'codex');
  assert.equal(request.model, 'saved-model');
  assert.equal(request.backlog, undefined);
  assert.equal(request.mode, undefined);
  assert.ok(request.prompt.includes(registeredProfile.displayName));
  assert.ok(request.prompt.includes(registeredProfile.profileUrl));
  assert.ok(!request.prompt.includes(registeredProfile.fixedPrompt), 'permanent instructions are not rewritten by the generator');
  assert.ok(request.prompt.includes(defaultGeneratedPrompt));
  assert.equal(result.profile.generatedPrompt, `${defaultGeneratedPrompt}\n\n【本人情報・Backlog公式ガイドの補足】\n新しく生成した共通指示`);
  assert.equal(result.effectivePrompt.split(defaultGeneratedPrompt).length, 2);
  assert.equal(result.profile.fixedPrompt, registeredProfile.fixedPrompt);
  assert.equal(result.profile.sources.length, 5);
  assert.equal(result.profile.status.state, 'success');
  assert.equal(result.profile.revision, 3);
  assertPortsClosed(app);
});

test('worker creation does not regenerate; Chrome startup triggers one coalesced generation', async () => {
  const app = background({settings: {promptProfile: registeredProfile}, fetch: officialGuideResponse});
  await app.handle({type: 'GET_PROMPT_PROFILE'}, optionsSender);
  await flush();
  assert.equal(app.calls.length, 0);
  assert.equal(app.ports.length, 0);
  app.fireStartup();
  app.fireStartup();
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(app.calls.length, 6);
  assert.equal(app.calls.filter(call => new URL(call.url).pathname === '/api/v2/space').length, 1);
  assert.equal(app.nativeMessages.filter(({message}) => message.type === 'generate_prompt').length, 1);
  assert.equal(app.data.promptProfile.status.state, 'success');
  assertPortsClosed(app);
});

test('startup skips locked and unregistered profiles and manual regeneration cannot bypass these settings', async () => {
  for (const profile of [{...registeredProfile, locked: true}, {...registeredProfile, displayName: ''}]) {
    const app = background({settings: {promptProfile: profile}});
    app.fireStartup();
    await flush();
    assert.equal(app.data.promptProfile.status.state, 'skipped');
    await assert.rejects(app.handle({type: 'REGENERATE_PROMPT_PROFILE'}, optionsSender), /ロック|登録/);
    assert.equal(app.calls.length, 1, 'formatting refresh is independent of prompt locks and identity registration');
    assert.equal(app.ports.length, 0);
    assert.equal(app.data.promptProfile.generatedPrompt, profile.generatedPrompt);
    assert.equal(app.data.promptProfile.fixedPrompt, profile.fixedPrompt);
  }
});

test('failed native prompt generation retains saved instructions and cleans up its connection', async () => {
  const app = background({settings: {promptProfile: registeredProfile}, fetch: officialGuideResponse,
    native: message => message.type === 'health' ? healthReply(message) : {id: message.id, ok: false, error: 'synthetic-provider-error'}
  });
  await assert.rejects(app.handle({type: 'REGENERATE_PROMPT_PROFILE'}, optionsSender), /ログイン・接続設定/);
  assert.equal(app.data.promptProfile.generatedPrompt, registeredProfile.generatedPrompt);
  assert.equal(app.data.promptProfile.fixedPrompt, registeredProfile.fixedPrompt);
  assert.equal(app.data.promptProfile.revision, registeredProfile.revision);
  assert.equal(app.data.promptProfile.status.state, 'error');
  assertPortsClosed(app);
});

test('formatting settings use only the saved space and never start AI or expose credentials', async () => {
  const app = background({settings: {backlogSpaceUrl: 'https://example.backlog.com'}});
  for (const type of ['GET_FORMATTING_STATUS', 'REFRESH_FORMATTING']) {
    await assert.rejects(app.handle({type}), /設定画面/);
  }
  const before = await app.handle({type: 'GET_FORMATTING_STATUS'}, optionsSender);
  assert.equal(before.formatting.status, 'unconfigured');
  assert.equal(app.calls.length, 0);
  const result = await app.handle({type: 'REFRESH_FORMATTING'}, optionsSender);
  assert.equal(result.formatting.rule, 'markdown');
  assert.equal(result.formatting.origin, 'https://example.backlog.com');
  assert.equal(app.calls.length, 1);
  assert.equal(app.ports.length, 0);
  assert.ok(!/secret-backlog-key|fingerprint/.test(JSON.stringify(result)));
  assert.deepEqual((await app.handle({type: 'GET_FORMATTING_STATUS'}, optionsSender)).formatting, result.formatting);
});

test('an issue visit in the saved space warms its setting without delaying controls or starting AI', async () => {
  const app = background({settings: {backlogLastSpaceUrl: 'https://recent.backlog.com'}});
  const settings = await app.handle({type: 'GET_SETTINGS'});
  assert.equal(settings.backlogKey, undefined);
  await flush();
  assert.equal(app.data.backlogLastSpaceUrl, undefined);
  assert.equal(app.calls.length, 1);
  assert.equal(app.ports.length, 0);
  await app.handle();
  assert.equal(app.calls.filter(call => new URL(call.url).pathname === '/api/v2/space').length, 1);
  assert.equal(app.calls.filter(call => new URL(call.url).pathname === '/api/v2/projects/TEST').length, 1);
  assertPortsClosed(app);
});

test('registered spaces use their selected keys for every REST request and agent authentication', async () => {
  const backlogSpaces = [
    {origin: 'https://example.backlog.com', keys: [
      {id: 'personal', label: '個人', apiKey: 'example-unused-secret'},
      {id: 'work', label: '業務', apiKey: 'example-active-secret'}], activeKeyId: 'work'},
    {origin: 'https://other.backlog.jp', keys: [
      {id: 'work', label: '別スペース', apiKey: 'other-active-secret'}], activeKeyId: 'work'}
  ];
  for (const space of backlogSpaces) for (const mode of ['chat', 'agent']) {
    const app = background({settings: {backlogSpaces}});
    const from = {...sender, url: `${space.origin}/view/TEST-12`};
    const settings = await app.handle({type: 'GET_SETTINGS'}, from);
    assert.deepEqual(JSON.parse(JSON.stringify(settings)), {provider: 'copilot', maxComments: 50});
    await app.handle({...generation, mode, references: 'OTHER-2'}, from);
    const active = space.keys.find(key => key.id === space.activeKeyId);
    assert.ok(app.calls.length >= 4);
    assert.ok(app.calls.every(({url}) => new URL(url).origin === space.origin
      && new URL(url).searchParams.get('apiKey') === active.apiKey));
    const request = app.nativeMessages.find(({message}) => message.type === 'generate').message;
    assert.equal(request.backlog?.apiKey, mode === 'agent' ? active.apiKey : undefined);
    assert.equal(request.backlog?.origin, mode === 'agent' ? space.origin : undefined);
    for (const secret of ['secret-backlog-key', ...backlogSpaces.flatMap(space => space.keys.map(key => key.apiKey))]) {
      assert.ok(!request.prompt.includes(secret));
      assert.ok(!JSON.stringify(settings).includes(secret));
    }
    assertPortsClosed(app);
  }
});

test('switching a selected key takes effect on the next generation for that space', async () => {
  const origin = 'https://example.backlog.com';
  const app = background({settings: {backlogSpaces: [{origin, keys: [
    {id: 'first', label: '最初', apiKey: 'first-space-secret'},
    {id: 'next', label: '次', apiKey: 'next-space-secret'}], activeKeyId: 'first'}]}});
  await app.handle({...generation, mode: 'agent'});
  assert.ok(app.calls.every(({url}) => new URL(url).searchParams.get('apiKey') === 'first-space-secret'));
  const previousCalls = app.calls.length;
  app.data.backlogSpaces[0].activeKeyId = 'next';
  await app.handle({...generation, mode: 'agent'});
  assert.ok(app.calls.slice(previousCalls).every(({url}) => new URL(url).searchParams.get('apiKey') === 'next-space-secret'));
  const requests = app.nativeMessages.filter(({message}) => message.type === 'generate').map(({message}) => message);
  assert.deepEqual(requests.map(request => request.backlog.apiKey), ['first-space-secret', 'next-space-secret']);
  assertPortsClosed(app);
});

test('an empty registry suppresses legacy credentials and unregistered spaces never receive a key', async () => {
  for (const backlogSpaces of [[], [{origin: 'https://other.backlog.jp', keys: [
    {id: 'other', label: '別スペース', apiKey: 'other-secret'}], activeKeyId: 'other'}]]) {
    const app = background({settings: {backlogSpaces}});
    await app.handle({type: 'GET_SETTINGS'});
    await assert.rejects(app.handle(), /APIキーを送信せずに中止/);
    await flush();
    assert.equal(app.calls.length, 0);
    assert.equal(app.ports.length, 0);
  }
});

test('formatting status selects a registered space without exposing its credentials', async () => {
  const origin = 'https://other.backlog.jp';
  const app = background({settings: {backlogSpaces: [
    {origin: 'https://example.backlog.com', keys: [{id: 'one', label: 'one', apiKey: 'one-secret'}], activeKeyId: 'one'},
    {origin, keys: [{id: 'two', label: 'two', apiKey: 'two-secret'}], activeKeyId: 'two'}]}});
  const result = await app.handle({type: 'REFRESH_FORMATTING', origin}, optionsSender);
  assert.equal(result.formatting.origin, origin);
  assert.equal(result.formatting.rule, 'markdown');
  assert.equal(new URL(app.calls[0].url).searchParams.get('apiKey'), 'two-secret');
  const state = await app.handle({type: 'GET_FORMATTING_STATUS', origin}, optionsSender);
  assert.deepEqual(state.formatting, result.formatting);
  for (const type of ['REFRESH_FORMATTING', 'GET_FORMATTING_STATUS']) {
    const foreign = await app.handle({type, origin: 'https://unregistered.backlog.com'}, optionsSender);
    assert.equal(foreign.formatting.status, 'unconfigured');
    assert.ok(!/one-secret|two-secret|fingerprint/.test(JSON.stringify(foreign)));
  }
  assert.equal(app.calls.length, 1);
  assert.equal(app.ports.length, 0);
  assert.ok(!/one-secret|two-secret|fingerprint/.test(JSON.stringify(result)));
});

test('Chrome startup refreshes each registered space with its own active credential', async () => {
  const backlogSpaces = [
    {origin: 'https://example.backlog.com', keys: [{id: 'one', label: 'one', apiKey: 'one-secret'}], activeKeyId: 'one'},
    {origin: 'https://other.backlog.jp', keys: [{id: 'two', label: 'two', apiKey: 'two-secret'}], activeKeyId: 'two'}
  ];
  const app = background({settings: {backlogSpaces, promptProfile: {locked: true}}});
  app.fireStartup();
  await flush();
  assert.equal(app.calls.length, 2);
  for (const space of backlogSpaces) {
    const call = app.calls.find(({url}) => new URL(url).origin === space.origin);
    assert.equal(new URL(call.url).pathname, '/api/v2/space');
    assert.equal(new URL(call.url).searchParams.get('apiKey'), space.keys[0].apiKey);
  }
  assert.equal(app.ports.length, 0);
});

test('the Backlog key is sent only to its saved space, never to other Backlog subdomains', async () => {
  for (const url of ['https://other.backlog.com/view/TEST-12', 'https://support-ja.backlog.com/view/TEST-12',
    'https://example.backlog.jp/view/TEST-12']) {
    const app = background();
    const from = {...sender, url};
    assert.equal((await app.handle({type: 'GET_SETTINGS'}, from)).provider, 'copilot');
    await assert.rejects(app.handle(generation, from), /APIキーを送信せずに中止/);
    await flush();
    assert.equal(app.calls.length, 0, url);
    assert.equal(app.ports.length, 0, url);
  }
  const unset = background({settings: {backlogSpaceUrl: '', backlogLastSpaceUrl: 'https://example.backlog.com',
    promptProfile: {profileUrl: 'https://example.backlog.com/user/me', locked: true}}});
  await unset.handle({type: 'GET_SETTINGS'});
  await assert.rejects(unset.handle(), /BacklogスペースURLを保存/);
  unset.fireStartup();
  await flush();
  assert.equal(unset.calls.length, 0);
  assert.equal(unset.ports.length, 0);
});

test('Chrome startup refreshes cached space settings even with locked prompts and no registered author', async () => {
  let rule = 'markdown';
  const app = background({settings: {backlogSpaceUrl: 'https://example.backlog.com', promptProfile: {locked: true}},
    fetch: url => {
      assert.equal(new URL(url).pathname, '/api/v2/space');
      return response({name: 'Example', textFormattingRule: rule});
    }});
  await app.handle({type: 'REFRESH_FORMATTING'}, optionsSender);
  rule = 'backlog';
  app.fireStartup();
  await flush();
  const result = await app.handle({type: 'GET_FORMATTING_STATUS'}, optionsSender);
  assert.equal(result.formatting.rule, 'backlog');
  assert.equal(app.calls.length, 2);
  assert.equal(app.ports.length, 0);
});

test('both providers and modes use the output project format over space defaults and old prompt instructions', async () => {
  for (const provider of ['copilot', 'codex']) for (const mode of ['chat', 'agent']) for (const rule of ['markdown', 'backlog']) {
    const other = rule === 'markdown' ? 'backlog' : 'markdown';
    const app = background({settings: {provider, promptProfile: {...registeredProfile, locked: true, fixedPrompt: `古い指示：${other}を使用`}},
      fetch: url => {
        const path = new URL(url).pathname;
        if (path === '/api/v2/space') return response({textFormattingRule: other});
        if (path === '/api/v2/projects/TEST') return response({projectKey: 'TEST', textFormattingRule: rule});
        if (path.endsWith('/comments')) return response([{content: '以前の記法を含む参考コメント'}]);
        return response({summary: '返信先'});
      }});
    await app.handle({...generation, provider, mode, requestId: 'format-1'}, {...sender, tab: {id: 1}});
    const request = app.nativeMessages.find(({message}) => message.type === 'generate').message;
    const formatOffset = request.prompt.indexOf('返信の出力記法（アプリがBacklog APIで確認した設定');
    assert.ok(formatOffset > request.prompt.indexOf(`古い指示：${other}を使用`));
    assert.match(request.prompt.slice(formatOffset), /宛名だけを独立した行/);
    assert.match(request.prompt.slice(formatOffset), /引用と回答の間にも空行/);
    assert.match(request.prompt.slice(formatOffset), new RegExp(rule === 'markdown' ? 'Markdown記法を使います' : 'Backlog記法を使います'));
    const context = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n\n') + 2));
    assert.equal(context.outputFormatting.rule, rule);
    assert.equal(context.outputFormatting.source, 'project');
    assert.ok(app.updates.some(update => update.message.message.includes(rule === 'markdown' ? 'Markdown記法' : 'Backlog記法')));
    assertPortsClosed(app);
  }
});

test('failed project format lookup generates plain text instead of guessing from the cached space', async () => {
  const app = background({fetch: url => {
    const path = new URL(url).pathname;
    if (path === '/api/v2/space') return response({textFormattingRule: 'markdown'});
    if (path === '/api/v2/projects/TEST') return response({}, 403);
    return response(path.endsWith('/comments') ? [] : {summary: '返信先'});
  }});
  await app.handle({...generation, requestId: 'plain-1'}, {...sender, tab: {id: 1}});
  const request = app.nativeMessages.find(({message}) => message.type === 'generate').message;
  assert.match(request.prompt, /出力先の記法は確認できていません/);
  assert.match(request.prompt, /"outputFormatting":\{"rule":"plain","source":"unknown"/);
  assert.ok(app.updates.some(update => update.message.message.includes('プレーンテキスト')));
  assertPortsClosed(app);
});



