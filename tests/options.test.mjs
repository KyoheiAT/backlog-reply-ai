import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../options.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../options.html', import.meta.url), 'utf8');
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const flush = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};

function optionsHarness(settings = {}, {deferFormatting = false} = {}) {
  const data = {backlogKey: 'backlog-key', backlogSpaceUrl: 'https://example.backlog.com', provider: 'copilot', maxComments: 50, ...settings};
  const saves = [];
  const requests = [];
  const formattingRequests = [];
  const elements = new Map();
  class Element {
    constructor(id = '') {this.id = id; this._value = ''; this.children = []; this.hidden = false; this.disabled = false; this.textContent = ''; this.className = ''; this.listeners = new Map();}
    get value() {
      if (this.id.endsWith('ModelSelect')) return this.children.some(child => child.value === this._value) ? this._value : (this.children[0]?.value || '');
      return this._value;
    }
    set value(value) {this._value = String(value);}
    set innerHTML(_) {throw new Error('Model labels must never use innerHTML');}
    appendChild(element) {this.children.push(element);}
    replaceChildren(...children) {this.children = children; this._value = '';}
    addEventListener(name, callback) {this.listeners.set(name, callback);}
    dispatch(name) {return this.listeners.get(name)?.({currentTarget: this, target: this, preventDefault() {}});}
  }
  const document = {
    getElementById(id) {if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id);},
    createElement: () => new Element()
  };
  const context = vm.createContext({document, URL, chrome: {
    runtime: {id: extensionId, sendMessage: message => {
      if (message.type === 'CHECK_BRIDGE') return Promise.resolve({ok: true});
      if (['GET_FORMATTING_STATUS', 'REFRESH_FORMATTING'].includes(message.type)) {
        return new Promise((resolve, reject) => {
          formattingRequests.push({message, resolve, reject});
          if (!deferFormatting) resolve({ok: true, formatting: {status: 'unconfigured', rule: '', checkedAt: ''}});
        });
      }
      if (message.type !== 'LIST_MODELS') throw new Error('The settings page must not generate text.');
      return new Promise((resolve, reject) => {requests.push({message, resolve, reject});});
    }},
    storage: {local: {
      remove: async keys => keys.forEach(key => delete data[key]),
      get: async keys => Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]])),
      set: async values => {const copy = JSON.parse(JSON.stringify(values)); saves.push(copy); Object.assign(data, copy);}
    }}
  }});
  vm.runInContext(source, context);
  return {
    data, saves, requests, formattingRequests, element: document.getElementById,
    pick(provider, value) {const select = document.getElementById(`${provider}ModelSelect`); select.value = value; return select.dispatch('change');},
    type(provider, value) {const input = document.getElementById(`${provider}Model`); input.value = value; return input.dispatch('input');},
    switch(provider) {const select = document.getElementById('provider'); select.value = provider; return select.dispatch('change');},
    refresh: provider => document.getElementById(`${provider}RefreshModels`).dispatch('click'),
    save: () => document.getElementById('settingsForm').dispatch('submit'),
    labels: provider => document.getElementById(`${provider}ModelSelect`).children.map(option => ({value: option.value, text: option.textContent}))
  };
}

function complete(request, models) {request.resolve({ok: true, models});}

test('markup provides separate pickers and optional direct-entry fields', () => {
  for (const provider of ['copilot', 'codex']) {
    assert.ok(markup.includes(`id="${provider}ModelSelect"`));
    assert.ok(markup.includes(`id="${provider}RefreshModels" type="button"`));
    assert.ok(markup.includes(`id="${provider}ManualFields" hidden`));
  }
  assert.ok(markup.includes('一覧の取得では文章を生成しません'));
});

test('initial display loads only selected provider, preserving auto/default while loading', async () => {
  const app = optionsHarness({provider: 'codex'});
  await flush();
  assert.equal(app.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(app.requests[0].message)), {type: 'LIST_MODELS', provider: 'codex'});
  assert.equal(app.element('codexModelSelect').value, '');
  assert.ok(app.labels('codex').some(option => option.value === '' && option.text === '自動選択（既定）'));
  assert.ok(app.element('codexModelsStatus').textContent.includes('取得しています'));
  assert.equal(app.element('codexRefreshModels').disabled, true);
  assert.equal(app.element('copilotFields').hidden, true);
  assert.equal(app.element('codexFields').hidden, false);
  await app.save();
  assert.equal(app.saves.length, 1);
  assert.equal(app.saves[0].codexModel, '');
});

test('prompt-test exclusion is opt-in and only a stored boolean true enables it', async () => {
  assert.match(markup, /<label[^>]*for="excludeLatestOwnComment"/);
  assert.match(markup, /<input id="excludeLatestOwnComment" type="checkbox" aria-describedby="excludeLatestOwnCommentNote">/);
  for (const value of [undefined, false, 'true', 1, null]) {
    const app = optionsHarness({excludeLatestOwnComment: value});
    await flush();
    assert.equal(app.element('excludeLatestOwnComment').checked, false);
    await app.save();
    assert.equal(app.saves.at(-1).excludeLatestOwnComment, false);
  }
  const enabled = optionsHarness({excludeLatestOwnComment: true});
  await flush();
  assert.equal(enabled.element('excludeLatestOwnComment').checked, true);
});

test('prompt-test checkbox persists explicit opt-in and can be disabled again', async () => {
  const app = optionsHarness();
  await flush();
  app.element('excludeLatestOwnComment').checked = true;
  await app.save();
  assert.equal(app.data.excludeLatestOwnComment, true);
  assert.equal(app.saves.at(-1).excludeLatestOwnComment, true);
  const reopened = optionsHarness(app.data);
  await flush();
  assert.equal(reopened.element('excludeLatestOwnComment').checked, true);
  reopened.element('excludeLatestOwnComment').checked = false;
  await reopened.save();
  assert.equal(reopened.data.excludeLatestOwnComment, false);
  assert.equal(reopened.saves.at(-1).excludeLatestOwnComment, false);
});

test('saved model IDs remain selected when absent from the current list and survive saving', async () => {
  const app = optionsHarness({copilotModel: 'previous-model', codexModel: 'saved-codex'});
  await flush();
  assert.equal(app.element('copilotModelSelect').value, 'previous-model');
  complete(app.requests[0], [{id: 'available-model', name: 'Available model', isDefault: true}]);
  await flush();
  assert.equal(app.element('copilotModelSelect').value, 'previous-model');
  assert.ok(app.labels('copilot').find(option => option.value === 'previous-model').text.includes('一覧未掲載'));
  assert.ok(app.element('copilotModelNote').textContent.includes('保持'));
  await app.save();
  assert.equal(app.saves[0].copilotModel, 'previous-model');
  assert.equal(app.saves[0].codexModel, 'saved-codex');
});

test('provider switches retain independent selections and fetch each provider only once automatically', async () => {
  const app = optionsHarness();
  await flush();
  complete(app.requests[0], [{id: 'copilot-a', name: 'Copilot A'}, {id: 'copilot-b', name: 'Copilot B'}]);
  await flush();
  app.pick('copilot', 'copilot-b');
  app.switch('codex');
  await flush();
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].message.provider, 'codex');
  complete(app.requests[1], [{id: 'codex-a', name: 'Codex A'}]);
  await flush();
  app.pick('codex', 'codex-a');
  app.switch('copilot'); app.switch('codex');
  await flush();
  assert.equal(app.requests.length, 2);
  assert.equal(app.element('copilotModelSelect').value, 'copilot-b');
  assert.equal(app.element('codexModelSelect').value, 'codex-a');
  await app.save();
  assert.equal(app.saves[0].copilotModel, 'copilot-b');
  assert.equal(app.saves[0].codexModel, 'codex-a');
});

test('list failure and empty results never block default or direct-entry saves', async () => {
  const app = optionsHarness();
  await flush();
  app.requests[0].resolve({ok: false, error: 'ログインしてください。'});
  await flush();
  assert.ok(app.element('copilotModelsStatus').textContent.includes('ログインしてください'));
  assert.equal(app.element('copilotRefreshModels').disabled, false);
  await app.save();
  assert.equal(app.saves.at(-1).copilotModel, '');
  app.pick('copilot', '@manual');
  app.type('copilot', 'vendor/model-1.2:latest');
  await app.save();
  assert.equal(app.saves.at(-1).copilotModel, 'vendor/model-1.2:latest');
  const refresh = app.refresh('copilot');
  complete(app.requests[1], []);
  await refresh;
  assert.ok(app.element('copilotModelsStatus').textContent.includes('候補がありません'));
  assert.equal(app.element('copilotModel').value, 'vendor/model-1.2:latest');
  assert.equal(app.element('copilotModelSelect').value, '@manual');
});

test('manual model validation accepts ASCII IDs and rejects spaces, shell characters and overly long IDs', async () => {
  const app = optionsHarness();
  await flush();
  app.pick('copilot', '@manual');
  for (const invalid of ['bad model', 'bad;command', '日本語', 'a'.repeat(101), '-option', '--dangerously-bypass-approvals-and-sandbox', '/path']) {
    app.type('copilot', invalid);
    await app.save();
    assert.equal(app.saves.length, 0);
    assert.ok(app.element('status').textContent.includes('100文字以内'));
  }
  app.type('copilot', ' valid_model-1.2:tag/path ');
  await app.save();
  assert.equal(app.saves[0].copilotModel, 'valid_model-1.2:tag/path');
  app.type('copilot', '');
  await app.save();
  assert.equal(app.saves[1].copilotModel, '');
});

test('late response for a different provider cannot change the visible provider or its selection', async () => {
  const app = optionsHarness({copilotModel: 'saved-copilot'});
  await flush();
  app.switch('codex');
  await flush();
  complete(app.requests[1], [{id: 'codex-model', name: 'Codex model'}]);
  await flush();
  app.pick('codex', 'codex-model');
  complete(app.requests[0], [{id: 'copilot-model', name: 'Copilot model'}]);
  await flush();
  assert.equal(app.element('provider').value, 'codex');
  assert.equal(app.element('codexFields').hidden, false);
  assert.equal(app.element('codexModelSelect').value, 'codex-model');
  assert.equal(app.element('copilotModelSelect').value, 'saved-copilot');
});

test('out-of-order refresh responses cannot overwrite newer results or in-progress manual edits', async () => {
  const app = optionsHarness();
  await flush();
  const refresh = app.refresh('copilot');
  app.pick('copilot', '@manual');
  app.type('copilot', 'my-model');
  complete(app.requests[1], [{id: 'new-model', name: 'New model'}]);
  await refresh;
  complete(app.requests[0], [{id: 'old-model', name: 'Old model'}]);
  await flush();
  assert.ok(app.labels('copilot').some(option => option.value === 'new-model'));
  assert.ok(!app.labels('copilot').some(option => option.value === 'old-model'));
  assert.equal(app.element('copilotModelSelect').value, '@manual');
  assert.equal(app.element('copilotModel').value, 'my-model');
  assert.equal(app.element('copilotRefreshModels').disabled, false);
  await app.save();
  assert.equal(app.saves[0].copilotModel, 'my-model');
});

test('model labels and descriptions are rendered as text; invalid and duplicate model IDs are ignored', async () => {
  const app = optionsHarness();
  await flush();
  complete(app.requests[0], [
    {id: 'safe-id', name: '<img src=x onerror=alert(1)>', description: '<script>alert(1)</script>'},
    {id: 'safe-id', name: 'duplicate'}, {id: '@manual', name: 'invalid'}, {id: '', name: 'empty'}, {id: 'bad id', name: 'bad'}
  ]);
  await flush();
  assert.equal(app.labels('copilot').filter(option => option.value === 'safe-id').length, 1);
  assert.ok(app.labels('copilot').find(option => option.value === 'safe-id').text.includes('<img src=x onerror=alert(1)>'));
  app.pick('copilot', 'safe-id');
  assert.equal(app.element('copilotModelDescription').textContent, '<script>alert(1)</script>');
  assert.equal(app.labels('copilot').filter(option => option.value === '@manual').length, 1);
  app.pick('copilot', '@manual');
  app.type('copilot', 'another-model');
  assert.equal(app.element('copilotModelDescription').textContent, '');
  assert.equal(app.element('copilotModelDescription').hidden, true);
});

test('refresh failure retains prior candidates and selected model', async () => {
  const app = optionsHarness();
  await flush();
  complete(app.requests[0], [{id: 'model-a', name: 'Model A'}]);
  await flush();
  app.pick('copilot', 'model-a');
  const refreshing = app.refresh('copilot');
  app.requests[1].reject(new Error('ホストが見つかりません。'));
  await refreshing;
  assert.equal(app.element('copilotModelSelect').value, 'model-a');
  assert.ok(app.labels('copilot').some(option => option.value === 'model-a'));
  await app.save();
  assert.equal(app.saves[0].copilotModel, 'model-a');
});

test('space status shows saved rule, origin and check time without generating or refreshing', async () => {
  const app = optionsHarness({backlogSpaceUrl: 'https://example.backlog.com'}, {deferFormatting: true});
  await flush();
  assert.equal(app.element('backlogSpaceUrl').value, 'https://example.backlog.com');
  assert.equal(app.formattingRequests[0].message.type, 'GET_FORMATTING_STATUS');
  assert.equal(app.element('refreshFormatting').disabled, true);
  app.formattingRequests[0].resolve({ok: true, formatting: {
    status: 'ready', rule: 'markdown', origin: 'https://example.backlog.com',
    spaceName: '<Example>', checkedAt: '2026-10-29T01:00:00Z'
  }});
  await flush();
  assert.match(app.element('formattingStatus').textContent, /Markdown記法/);
  assert.match(app.element('formattingStatus').textContent, /プロジェクトの設定を優先/);
  assert.match(app.element('formattingDetails').textContent, /<Example>.*https:\/\/example.backlog.com.*確認日時/);
  assert.equal(app.element('refreshFormatting').disabled, false);
});

test('space URL is required and normalizes an explicit supported origin', async () => {
  const app = optionsHarness();
  await flush();
  for (const [input, expected] of [
    [' https://Example.backlog.com/ ', 'https://example.backlog.com'],
    ['https://example.backlog.jp', 'https://example.backlog.jp'],
    ['https://example.backlogtool.com', 'https://example.backlogtool.com']
  ]) {
    app.element('backlogSpaceUrl').value = input;
    await app.save();
    assert.equal(app.saves.at(-1).backlogSpaceUrl, expected);
    assert.equal(app.formattingRequests.at(-1).message.type, 'REFRESH_FORMATTING');
  }
  const saved = app.saves.length;
  const refreshes = app.formattingRequests.length;
  app.element('backlogSpaceUrl').value = '  ';
  await app.save();
  assert.equal(app.saves.length, saved);
  assert.equal(app.formattingRequests.length, refreshes);
  assert.match(app.element('status').textContent, /APIキーを発行したBacklogスペースURL/);
  assert.ok(markup.includes('aria-describedby="formattingNote" required>'));
});

test('invalid or ambiguous space URLs are rejected without saving or requesting a refresh', async () => {
  const app = optionsHarness();
  await flush();
  for (const input of [
    'http://example.backlog.com', 'https://example.backlog.com.evil.test',
    'https://user@example.backlog.com', 'https://example.backlog.com:443',
    'https://example.backlog.com/view/TEST-1', 'https://example.backlog.com?token=secret',
    'https://example.backlog.com/#fragment', 'https://example.backlog.com\\path'
  ]) {
    app.element('backlogSpaceUrl').value = input;
    await app.save();
    assert.equal(app.saves.length, 0, input);
    assert.equal(app.formattingRequests.length, 1, input);
    assert.match(app.element('status').textContent, /スペースURL/);
  }
});

test('saving settings succeeds independently of a failed formatting refresh', async () => {
  const app = optionsHarness({}, {deferFormatting: true});
  await flush();
  app.element('backlogSpaceUrl').value = 'https://example.backlog.com';
  await app.save();
  assert.equal(app.saves.length, 1);
  assert.equal(app.formattingRequests[1].message.type, 'REFRESH_FORMATTING');
  app.formattingRequests[1].resolve({ok: true, formatting: {
    status: 'error', rule: '', message: 'Backlog APIキーを確認してください。', checkedAt: ''
  }});
  await flush();
  assert.equal(app.element('status').className, 'success');
  assert.match(app.element('status').textContent, /保存しました/);
  assert.equal(app.element('formattingStatus').className, 'error');
  assert.match(app.element('formattingStatus').textContent, /Backlog APIキー/);
  app.formattingRequests[0].resolve({ok: true, formatting: {status: 'ready', rule: 'markdown'}});
  await flush();
  assert.equal(app.element('formattingStatus').className, 'error');
});

test('manual formatting refresh uses saved settings only and handles rejected responses', async () => {
  const app = optionsHarness({}, {deferFormatting: true});
  await flush();
  app.formattingRequests[0].resolve({ok: true, formatting: {status: 'unconfigured', rule: '', checkedAt: ''}});
  await flush();
  app.element('backlogKey').value = 'unsaved-key';
  app.element('backlogSpaceUrl').value = 'https://unsaved.backlog.com';
  const refresh = app.element('refreshFormatting').dispatch('click');
  assert.deepEqual(JSON.parse(JSON.stringify(app.formattingRequests[1].message)), {type: 'REFRESH_FORMATTING'});
  assert.equal(app.saves.length, 0);
  app.formattingRequests[1].reject(new Error('通信に失敗しました。'));
  await refresh;
  assert.match(app.element('formattingStatus').textContent, /通信に失敗/);
  assert.equal(app.element('refreshFormatting').disabled, false);
});

test('Backlog syntax is labeled distinctly and invalid ready data is not accepted', async () => {
  const app = optionsHarness({}, {deferFormatting: true});
  await flush();
  app.formattingRequests[0].resolve({ok: true, formatting: {status: 'ready', rule: 'backlog', checkedAt: ''}});
  await flush();
  assert.match(app.element('formattingStatus').textContent, /Backlog記法/);
  const refresh = app.element('refreshFormatting').dispatch('click');
  app.formattingRequests[1].resolve({ok: true, formatting: {status: 'ready', rule: 'unknown'}});
  await refresh;
  assert.equal(app.element('formattingStatus').className, 'error');
  assert.doesNotMatch(app.element('formattingStatus').textContent, /Markdown記法/);
});
