import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../prompt-options.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../options.html', import.meta.url), 'utf8');
const flush = async () => {for (let i = 0; i < 40; i++) await Promise.resolve();};
const profile = (values = {}) => ({displayName: '', profileUrl: '', generatedPrompt: '', fixedPrompt: '', locked: false,
  revision: 0, generatedAt: '', checkedAt: '', sources: [], status: {state: 'idle', message: '', at: ''}, ...values});
const defaultPrompt = '相手に配慮した丁寧な完成文だけを作成する。\n事実と推測を区別し、次の依頼を明確にする。';

function harness(initial = profile(), options = {}) {
  let stored = initial;
  let onChanged;
  let deferReads = false;
  let confirmResult = true;
  const confirms = [];
  const requests = [];
  const elements = new Map();
  class Element {
    constructor(tag = '', id = '') {this.tagName = tag.toUpperCase(); this.id = id; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.children = []; this.textContent = ''; this.listeners = new Map();}
    set innerHTML(_) {throw new Error('Profile content must not be rendered as HTML.');}
    replaceChildren(...children) {this.children = children;}
    appendChild(child) {this.children.push(child);}
    addEventListener(name, callback) {this.listeners.set(name, callback);}
    dispatch(type) {return this.listeners.get(type)?.({currentTarget: this, target: this, preventDefault() {}});}
  }
  const document = {
    getElementById(id) {
      assert.ok(markup.includes(`id="${id}"`), `missing markup for ${id}`);
      if (!elements.has(id)) elements.set(id, new Element('', id));
      return elements.get(id);
    },
    createElement(tag) {return new Element(tag);}
  };
  const result = value => ({ok: true, profile: value, effectivePrompt: `合成済み：${value.displayName}|${value.generatedPrompt}|${value.fixedPrompt}`,
    defaultFixedPrompt: Object.hasOwn(options, 'defaultFixedPrompt') ? options.defaultFixedPrompt : defaultPrompt});
  vm.runInNewContext(source, {document, URL, confirm: message => {confirms.push(message); return confirmResult;}, chrome: {
    runtime: {sendMessage(message) {
      const request = {message: JSON.parse(JSON.stringify(message)), resolved: false};
      requests.push(request);
      if (message.type === 'GET_PROMPT_PROFILE' && !deferReads) {request.resolved = true; return Promise.resolve(result(stored));}
      return new Promise((resolve, reject) => {request.resolve = resolve; request.reject = reject;});
    }},
    storage: {onChanged: {addListener(callback) {onChanged = callback;}}}
  }});
  return {
    requests, confirms, element: document.getElementById,
    type(id, value) {const input = document.getElementById(id); input.value = value; return input.dispatch('input');},
    lock(value) {const input = document.getElementById('promptLocked'); input.checked = value; return input.dispatch('change');},
    save: () => document.getElementById('promptForm').dispatch('submit'),
    regenerate: () => document.getElementById('promptRegenerate').dispatch('click'),
    resetFixed: () => document.getElementById('promptResetFixed').dispatch('click'),
    reload: () => document.getElementById('promptReload').dispatch('click'),
    confirm(value) {confirmResult = value;},
    defer(value = true) {deferReads = value;},
    next(type) {const request = requests.find(item => item.message.type === type && !item.resolved); assert.ok(request, `pending ${type}`); return request;},
    resolve(request, value, extra = {}) {request.resolved = true; stored = value; request.resolve({...result(value), ...extra});},
    fail(request, error) {request.resolved = true; request.resolve({ok: false, error});},
    change(value, area = 'local') {stored = value; onChanged({promptProfile: {newValue: value}}, area);}
  };
}

function descendants(element, tag) {
  return element.children.flatMap(child => [...(child.tagName === tag.toUpperCase() ? [child] : []), ...descendants(child, tag)]);
}

test('prompt editor is an independent form with explicit labels, limits and a readonly saved preview', () => {
  const mainEnd = markup.indexOf('</form>');
  const promptStart = markup.indexOf('<form id="promptForm">');
  assert.ok(promptStart > mainEnd);
  assert.ok(markup.includes('<script src="options.js"></script>'));
  assert.ok(markup.includes('<script src="prompt-options.js"></script>'));
  assert.match(markup, /id="promptEffective"[^>]*readonly/);
  assert.match(markup, /id="promptGenerated"[^>]*maxlength="12000"/);
  assert.match(markup, /id="promptFixed"[^>]*maxlength="10000"/);
  assert.match(markup, /<button\b[^>]*id="promptResetFixed"[^>]*type="button"[^>]*disabled>デフォルトに戻す<\/button>/);
  assert.match(markup, /「デフォルトに戻す」はこの欄だけを標準に戻します/);
  for (const id of ['promptDisplayName', 'promptProfileUrl', 'promptGenerated', 'promptFixed', 'promptLocked']) assert.ok(markup.includes(`for="${id}"`));
});

test('reset replaces only the fixed prompt and remains an unsaved edit until the user saves', async () => {
  const initial = profile({displayName: '保存された本人', profileUrl: 'https://space.backlog.com/user/*person',
    generatedPrompt: '保存した生成指示', fixedPrompt: '保存した独自指示', locked: true, revision: 7});
  const app = harness(initial);
  assert.equal(app.element('promptResetFixed').disabled, true, 'initial loading cannot apply an unavailable default');
  await flush();
  app.type('promptDisplayName', '編集中の本人');
  app.type('promptGenerated', '編集中の生成指示');
  app.type('promptFixed', '破棄してよい固定指示の編集');
  const beforePreview = app.element('promptEffective').value;
  assert.equal(app.element('promptResetFixed').disabled, false, 'locking regeneration does not lock manual editing');
  app.resetFixed();
  assert.equal(app.element('promptFixed').value, defaultPrompt);
  assert.equal(app.element('promptDisplayName').value, '編集中の本人');
  assert.equal(app.element('promptProfileUrl').value, initial.profileUrl);
  assert.equal(app.element('promptGenerated').value, '編集中の生成指示');
  assert.equal(app.element('promptLocked').checked, true);
  assert.equal(app.element('promptEffective').value, beforePreview);
  assert.equal(app.element('promptDirty').hidden, false);
  assert.match(app.element('promptFeedback').textContent, /保存.*適用/);
  assert.deepEqual(app.requests.map(request => request.message.type), ['GET_PROMPT_PROFILE']);
  const pending = app.save(); const request = app.next('SAVE_PROMPT_PROFILE');
  assert.equal(request.message.profile.fixedPrompt, defaultPrompt);
  assert.equal(request.message.profile.revision, 7);
  assert.equal(request.message.profile.locked, true);
  assert.equal(Object.hasOwn(request.message.profile, 'defaultFixedPrompt'), false);
  app.resolve(request, profile({...request.message.profile, revision: 8})); await pending;
  assert.equal(app.element('promptDirty').hidden, true);
  assert.ok(app.element('promptEffective').value.endsWith(defaultPrompt));
});

test('missing or invalid defaults disable reset without preventing profile editing or saving', async () => {
  for (const value of [undefined, null, '', ' \n ', 'x'.repeat(10001), 'bad\u0000text']) {
    const app = harness(profile({fixedPrompt: '保持する独自指示'}), {defaultFixedPrompt: value}); await flush();
    assert.equal(app.element('promptResetFixed').disabled, true);
    app.resetFixed();
    assert.equal(app.element('promptFixed').value, '保持する独自指示');
    assert.equal(app.element('promptSave').disabled, false);
    assert.deepEqual(app.requests.map(request => request.message.type), ['GET_PROMPT_PROFILE']);
  }
});

test('reset is blocked during a save and becomes available again after completion', async () => {
  const app = harness(profile({fixedPrompt: '保存前'})); await flush();
  app.type('promptFixed', '保存処理中の内容');
  const pending = app.save(); const request = app.next('SAVE_PROMPT_PROFILE');
  assert.equal(app.element('promptResetFixed').disabled, true);
  app.resetFixed();
  assert.equal(app.element('promptFixed').value, '保存処理中の内容');
  app.resolve(request, profile({...request.message.profile, revision: 1})); await pending;
  assert.equal(app.element('promptResetFixed').disabled, false);
  app.resetFixed();
  assert.equal(app.element('promptFixed').value, defaultPrompt);
});

test('reset during regeneration can be saved and survives rejection of the older generated result', async () => {
  const initial = profile({displayName: '本人', fixedPrompt: '元の独自指示', generatedPrompt: '元の生成文'});
  const app = harness(initial); await flush();
  const pendingGeneration = app.regenerate(); const generation = app.next('REGENERATE_PROMPT_PROFILE');
  app.change({...initial, status: {state: 'running'}}); await flush();
  assert.equal(app.element('promptResetFixed').disabled, false);
  app.resetFixed();
  const pendingSave = app.save(); const save = app.next('SAVE_PROMPT_PROFILE');
  assert.equal(save.message.profile.fixedPrompt, defaultPrompt);
  const updated = profile({...save.message.profile, revision: 1, status: {state: 'running'}});
  app.resolve(save, updated); await pendingSave;
  app.resolve(generation, {...updated, status: {state: 'skipped', message: '設定変更により生成結果を破棄しました。'}}); await pendingGeneration;
  assert.equal(app.element('promptFixed').value, defaultPrompt);
  assert.equal(app.element('promptGenerated').value, '元の生成文');
  assert.equal(app.element('promptDirty').hidden, true);
  assert.match(app.element('promptFeedback').textContent, /設定を保存しました/);
});

test('reset never rebases edits onto a newer stored revision after a conflicting update', async () => {
  const app = harness(profile({fixedPrompt: '古い固定指示', revision: 2})); await flush();
  app.type('promptGenerated', '未保存の生成指示');
  app.change(profile({fixedPrompt: '他の画面で保存した固定指示', revision: 3})); await flush();
  app.resetFixed();
  assert.match(app.element('promptDirty').textContent, /競合/);
  const pending = app.save(); const request = app.next('SAVE_PROMPT_PROFILE');
  assert.equal(request.message.profile.revision, 2);
  assert.equal(request.message.profile.fixedPrompt, defaultPrompt);
  app.fail(request, '別の操作で設定が更新されました。'); await pending;
  assert.equal(app.element('promptFixed').value, defaultPrompt);
  assert.equal(app.element('promptGenerated').value, '未保存の生成指示');
  assert.match(app.element('promptEffective').value, /他の画面で保存/);
});

test('opening settings only loads stored profile and does not save example identity or generate', async () => {
  const app = harness(); await flush();
  assert.deepEqual(app.requests.map(request => request.message), [{type: 'GET_PROMPT_PROFILE'}]);
  assert.equal(app.element('promptDisplayName').value, '');
  assert.equal(app.element('promptProfileUrl').value, '');
  assert.equal(app.element('promptSave').disabled, false);
  assert.equal(app.element('promptDirty').hidden, true);
  assert.match(app.element('promptMeta').textContent, /未生成.*未確認/);
});

test('save sends only editable profile and revision, keeps generated text and fixed instructions separate', async () => {
  const app = harness(profile({revision: 7, generatedPrompt: '現在の文体'})); await flush();
  app.type('promptDisplayName', ' 本人名 ');
  app.type('promptProfileUrl', 'https://space.backlog.jp/user/*');
  app.type('promptFixed', '毎回追加する指示');
  const pending = app.save();
  const request = app.next('SAVE_PROMPT_PROFILE');
  assert.deepEqual(request.message, {type: 'SAVE_PROMPT_PROFILE', profile: {
    displayName: '本人名', profileUrl: 'https://space.backlog.jp/user/*', generatedPrompt: '現在の文体', fixedPrompt: '毎回追加する指示', locked: false, revision: 7
  }});
  app.resolve(request, profile({...request.message.profile, revision: 8})); await pending;
  assert.equal(app.element('promptDisplayName').value, '本人名');
  assert.equal(app.element('promptDirty').hidden, true);
  assert.match(app.element('promptEffective').value, /本人名.*現在の文体.*毎回追加する指示/);
});

test('invalid identity URL and oversized instructions stay editable and are not sent', async () => {
  const app = harness(); await flush();
  for (const url of ['http://space.backlog.com/user/me', 'https://evil.example/user/me', 'https://space.backlog.com/user/me?apiKey=secret', 'https://space.backlog.com/view/TEST-1']) {
    app.type('promptProfileUrl', url); await app.save();
    assert.match(app.element('promptFeedback').textContent, /プロフィールURL/);
  }
  app.type('promptProfileUrl', ''); app.type('promptFixed', 'a'.repeat(10001)); await app.save();
  assert.match(app.element('promptFeedback').textContent, /10,000/);
  assert.equal(app.requests.filter(request => request.message.type === 'SAVE_PROMPT_PROFILE').length, 0);
  assert.equal(app.element('promptFixed').value.length, 10001);
});

test('regeneration saves edits first and keeps editing and saving enabled while AI runs', async () => {
  const app = harness(profile({displayName: '本人'})); await flush();
  app.type('promptFixed', '維持する指示');
  const pending = app.regenerate();
  assert.equal(app.requests.some(request => request.message.type === 'REGENERATE_PROMPT_PROFILE'), false);
  const save = app.next('SAVE_PROMPT_PROFILE');
  app.resolve(save, profile({...save.message.profile, revision: 1})); await flush();
  const generation = app.next('REGENERATE_PROMPT_PROFILE');
  assert.equal(app.element('promptRegenerate').disabled, true);
  assert.equal(app.element('promptSave').disabled, false);
  assert.equal(app.element('promptFixed').disabled, false);
  assert.equal(app.element('promptLocked').disabled, false);
  app.resolve(generation, profile({...save.message.profile, revision: 2, generatedPrompt: '新しい共通指示', status: {state: 'success'}})); await pending;
  assert.equal(app.element('promptGenerated').value, '新しい共通指示');
  assert.equal(app.element('promptFixed').value, '維持する指示');
  assert.equal(app.element('promptRegenerate').disabled, false);
  assert.match(app.element('promptFeedback').textContent, /生成結果を保存しました/);
});

test('successful responses with skipped status report discarded generation instead of saved output', async () => {
  const app = harness(profile({displayName: '本人', generatedPrompt: '以前のプロンプト'})); await flush();
  const pending = app.regenerate(); const request = app.next('REGENERATE_PROMPT_PROFILE');
  app.resolve(request, profile({displayName: '更新された本人', generatedPrompt: '以前のプロンプト', revision: 1,
    status: {state: 'skipped', message: '生成中に設定が更新されたため、古い生成結果を破棄しました。'}}));
  await pending;
  assert.equal(app.element('promptGenerated').value, '以前のプロンプト');
  assert.match(app.element('promptFeedback').textContent, /生成結果は採用していません/);
  assert.match(app.element('promptFeedback').textContent, /古い生成結果を破棄/);
  assert.doesNotMatch(app.element('promptFeedback').textContent, /生成結果を保存しました/);
  assert.equal(app.element('promptFeedback').className, 'note');
  assert.match(app.element('promptGenerationStatus').textContent, /生成をスキップ/);
});

test('saving a lock during generation preserves it when the old generation is rejected', async () => {
  const app = harness(profile({displayName: '本人', generatedPrompt: '以前の指示'})); await flush();
  const generationPending = app.regenerate(); const generation = app.next('REGENERATE_PROMPT_PROFILE');
  app.lock(true); app.type('promptFixed', '新しい固定指示');
  const savePending = app.save(); const save = app.next('SAVE_PROMPT_PROFILE');
  app.resolve(save, profile({...save.message.profile, revision: 1})); await savePending;
  app.fail(generation, '生成中に設定が更新されたため結果を破棄しました。'); await generationPending;
  assert.equal(app.element('promptLocked').checked, true);
  assert.equal(app.element('promptGenerated').value, '以前の指示');
  assert.equal(app.element('promptFixed').value, '新しい固定指示');
  assert.equal(app.element('promptRegenerate').disabled, true);
  assert.equal(app.element('promptFeedback').textContent, 'プロンプト設定を保存しました。');
});

test('unsaved edits made during generation survive its completion while saved preview updates', async () => {
  const app = harness(profile({displayName: '本人', revision: 4, generatedPrompt: '以前の指示'})); await flush();
  const pending = app.regenerate(); const request = app.next('REGENERATE_PROMPT_PROFILE');
  app.type('promptGenerated', '生成待ちの間に編集');
  app.type('promptFixed', '未保存の追加指示');
  app.resolve(request, profile({displayName: '本人', revision: 5, generatedPrompt: '新しい生成結果', status: {state: 'success'}})); await pending;
  assert.equal(app.element('promptGenerated').value, '生成待ちの間に編集');
  assert.equal(app.element('promptFixed').value, '未保存の追加指示');
  assert.match(app.element('promptEffective').value, /新しい生成結果/);
  assert.match(app.element('promptDirty').textContent, /競合/);
});

test('save-and-regenerate stops before generation if more edits arrive during its save', async () => {
  const app = harness(profile({displayName: '本人'})); await flush();
  app.type('promptFixed', '最初の変更');
  const pending = app.regenerate(); const request = app.next('SAVE_PROMPT_PROFILE');
  app.type('promptFixed', '保存待ち中の追加変更');
  app.resolve(request, profile({...request.message.profile, revision: 1})); await pending;
  assert.equal(app.requests.some(entry => entry.message.type === 'REGENERATE_PROMPT_PROFILE'), false);
  assert.equal(app.element('promptFixed').value, '保存待ち中の追加変更');
  assert.match(app.element('promptFeedback').textContent, /保存中に入力が変更/);
});

test('storage updates refresh saved preview and metadata without overwriting dirty fields or rebasing revision', async () => {
  const app = harness(profile({displayName: '本人', revision: 2, generatedPrompt: '古い保存値'})); await flush();
  app.type('promptGenerated', '編集中の文章');
  app.change(profile({displayName: '本人', revision: 3, generatedPrompt: '自動生成の新保存値', status: {state: 'success', message: '完了'}})); await flush();
  assert.equal(app.element('promptGenerated').value, '編集中の文章');
  assert.match(app.element('promptEffective').value, /自動生成の新保存値/);
  assert.match(app.element('promptDirty').textContent, /競合/);
  const pending = app.save(); const request = app.next('SAVE_PROMPT_PROFILE');
  assert.equal(request.message.profile.revision, 2);
  app.fail(request, '別の画面で設定が更新されました。'); await pending;
  assert.equal(app.element('promptGenerated').value, '編集中の文章');
  assert.match(app.element('promptFeedback').textContent, /読み直す/);
});

test('reload asks before discarding edits and cancelled reload leaves them intact', async () => {
  const app = harness(profile({displayName: '保存名'})); await flush();
  app.type('promptDisplayName', '未保存の名前'); app.confirm(false);
  const count = app.requests.length; await app.reload();
  assert.equal(app.confirms.length, 1);
  assert.equal(app.requests.length, count);
  assert.equal(app.element('promptDisplayName').value, '未保存の名前');
  app.confirm(true); await app.reload();
  assert.equal(app.element('promptDisplayName').value, '保存名');
  assert.equal(app.element('promptDirty').hidden, true);
});

test('typing while save is pending preserves newer edits and adopts the successfully saved revision', async () => {
  const app = harness(profile({displayName: '本人'})); await flush();
  app.type('promptFixed', '送信した指示');
  const pending = app.save(); const request = app.next('SAVE_PROMPT_PROFILE');
  app.type('promptFixed', '保存待ちの間に追記');
  app.resolve(request, profile({...request.message.profile, revision: 1})); await pending;
  assert.equal(app.element('promptFixed').value, '保存待ちの間に追記');
  assert.match(app.element('promptEffective').value, /送信した指示/);
  const next = app.save(); const nextRequest = app.next('SAVE_PROMPT_PROFILE');
  assert.equal(nextRequest.message.profile.revision, 1);
  app.resolve(nextRequest, profile({...nextRequest.message.profile, revision: 2})); await next;
});

test('stale reads and edits made during explicit reload cannot replace newer state', async () => {
  const app = harness(profile({displayName: '本人', revision: 1})); await flush();
  app.defer();
  app.change(profile({revision: 2})); const oldRead = app.next('GET_PROMPT_PROFILE');
  app.change(profile({revision: 3}));
  const freshRead = app.requests.filter(request => request.message.type === 'GET_PROMPT_PROFILE' && !request.resolved).at(-1);
  app.resolve(freshRead, profile({displayName: '新しい保存名', revision: 3})); await flush();
  app.resolve(oldRead, profile({displayName: '古い応答', revision: 2})); await flush();
  assert.equal(app.element('promptDisplayName').value, '新しい保存名');
  const reload = app.reload(); const read = app.next('GET_PROMPT_PROFILE');
  app.type('promptDisplayName', '読み込み中に入力');
  app.resolve(read, profile({displayName: '新しい保存名', revision: 3})); await reload;
  assert.equal(app.element('promptDisplayName').value, '読み込み中に入力');
});

test('generation failure retains stored text; busy state and fixed setting only prevent regeneration', async () => {
  const original = profile({displayName: '本人', generatedPrompt: '前のプロンプト', fixedPrompt: '維持する指示'});
  const app = harness(original); await flush();
  const pending = app.regenerate(); const request = app.next('REGENERATE_PROMPT_PROFILE');
  app.change({...original, status: {state: 'running', message: '実行中'}}); await flush();
  assert.equal(app.element('promptRegenerate').disabled, true);
  assert.equal(app.element('promptSave').disabled, false);
  app.change({...original, status: {state: 'error', message: '接続できません'}}); await flush();
  app.fail(request, '接続できません'); await pending;
  assert.equal(app.element('promptGenerated').value, '前のプロンプト');
  assert.equal(app.element('promptFixed').value, '維持する指示');
  assert.match(app.element('promptGenerationStatus').textContent, /接続できません/);
  assert.equal(app.element('promptRegenerate').disabled, false);
  app.lock(true); assert.equal(app.element('promptRegenerate').disabled, true);
  app.lock(false); assert.equal(app.element('promptRegenerate').disabled, false);
});

test('official source links and status use safe text, rejecting untrusted hosts and URL forms', async () => {
  const official = 'https://support-ja.backlog.com/hc/ja/articles/360035642154';
  const newOfficial = 'https://help-center.backlog.com/faq-6a1d4d7f3abb3ada78c5658b';
  const app = harness(profile({status: {state: 'success', message: '<img onerror=alert(1)>'}, sources: [
    {title: '<img src=x>', url: official}, {title: '重複', url: official}, {title: 'Backlog記法', url: newOfficial},
    {title: '外部', url: 'https://evil.example/hc/ja/articles/123'},
    {title: '別host', url: 'https://space.backlog.com/hc/ja/articles/123'},
    {title: 'HTTP', url: 'http://support-ja.backlog.com/hc/ja/articles/123'},
    {title: 'query', url: `${official}?secret=1`}, {title: 'hash', url: `${official}#a`},
    {title: 'credential', url: 'https://user:password@support-ja.backlog.com/hc/ja/articles/123'},
    {title: 'トップ', url: 'https://support-ja.backlog.com/'}, {title: 'script', url: 'javascript:alert(1)'}
  ]})); await flush();
  const links = descendants(app.element('promptSources'), 'a');
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, '<img src=x>');
  assert.equal(links[0].href, official);
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(links[1].href, newOfficial);
  assert.equal(descendants(app.element('promptSources'), 'img').length, 0);
  assert.match(app.element('promptGenerationStatus').textContent, /<img onerror/);
});
