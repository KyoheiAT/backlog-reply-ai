import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const flush = async () => {for (let i = 0; i < 40; i++) await Promise.resolve();};

function harness({confirmOverwrite = false, confirmDelayMs = 0, editorType = 'textarea', onPaste, onSelectionChange, holdTimers = false,
  clipboardSupport = true, clipboardConstructionThrows = false, execResult = false, execTransform = value => value,
  getSettings = () => ({ok: true, provider: 'copilot'})} = {}) {
  let root = null;
  let mutationCallback;
  let progressListener;
  let now = 1000;
  let wallNow = 1000;
  let requestNumber = 0;
  const intervals = new Map();
  let nextInterval = 0;
  const documentListeners = new Map();
  const windowListeners = new Map();
  const layoutActions = {attached: 0, destroyed: 0, updated: 0};
  const messages = [];
  const generations = [];
  const pendingTimers = [];
  const confirmations = [];
  const editorEvents = [];
  const editorActions = {pastes: [], execs: [], domReplacements: 0};
  const selection = {
    ranges: [],
    get rangeCount() {return this.ranges.length;},
    get anchorNode() {return this.ranges[0]?.target || null;},
    get focusNode() {return this.ranges[0]?.target || null;},
    getRangeAt(index) {return this.ranges[index];},
    toString() {return this.ranges[0]?.toString() || '';},
    removeAllRanges() {this.ranges = [];},
    addRange(range) {
      this.ranges.push(range);
      // Native selectionchange is queued, not delivered during addRange.
      void Promise.resolve().then(() => onSelectionChange?.(this, editor));
    }
  };
  const location = {protocol: 'https:', port: '', hostname: 'example.backlog.com', origin: 'https://example.backlog.com', pathname: '/view/TEST-12'};
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false; this.open = false; this.isConnected = false; this.listeners = new Map();
      this.className = '';
      this.classList = {contains: name => this.className.split(' ').includes(name),
        toggle: (name, add) => {const names = new Set(this.className.split(' ').filter(Boolean)); if (add) names.add(name); else names.delete(name); this.className = [...names].join(' ');}};
    }
    appendChild(child) {this.children.push(child); child.parentElement = this; return child;}
    replaceChildren(...children) {this.children = children;}
    addEventListener(name, callback) {this.listeners.set(name, callback);}
    setAttribute(name, value) {(this.attributes ||= {})[name] = value;}
    getAttribute(name) {return this.attributes?.[name] ?? null;}
    trigger(name) {return this.listeners.get(name)?.({currentTarget: this});}
    set innerHTML(_) {throw new Error('Generated content must use textContent or DOM nodes.');}
    focus() {document.activeElement = this;}
    contains(node) {return node === this || this.children.some(child => child === node || child.contains?.(node));}
  }
  class Textarea extends Element {
    constructor() {super('textarea'); this._value = ''; this.isConnected = true;}
    get value() {return this._value;}
    set value(value) {this._value = value;}
    closest() {return null;}
    getClientRects() {return [{}];}
    matches() {return true;}
    dispatchEvent(event) {editorEvents.push(event.type);}
  }
  class Editable extends Element {
    constructor() {super('div'); this.isConnected = true; this.isContentEditable = true;}
    closest() {return null;}
    getClientRects() {return [{}];}
    matches() {return false;}
    get textContent() {return this.children.map(node => node.textContent).join('');}
    set textContent(value) {this.children = value ? [{nodeType: 3, textContent: value, children: []}] : [];}
    get innerText() {
      const parts = this.children.map(node => node.tagName === 'BR' ? '\n' : node.textContent);
      return parts.join(this.children.length && this.children.every(node => node.tagName === 'P') ? '\n\n' : '');
    }
    replaceChildren(...children) {editorActions.domReplacements++; super.replaceChildren(...children);}
    dispatchEvent(event) {
      editorEvents.push(event.type);
      if (event.type === 'paste') {
        editorActions.pastes.push(event);
        onPaste?.(event, this, selection);
      }
      return !event.defaultPrevented;
    }
  }
  class TestEvent {
    constructor(type, options = {}) {this.type = type; this.defaultPrevented = false; Object.assign(this, options);}
    preventDefault() {if (this.cancelable) this.defaultPrevented = true;}
  }
  class TestDataTransfer {
    constructor() {if (clipboardConstructionThrows) throw new Error('Clipboard construction unavailable'); this.data = new Map();}
    setData(type, value) {this.data.set(type, value);}
    getData(type) {return this.data.get(type) || '';}
    get types() {return [...this.data.keys()];}
  }
  class Panel extends Element {
    constructor() {
      super('section');
      const instruction = new Textarea();
      const references = new Textarea();
      const mode = new Element('select');
      const button = new Element('button');
      const toggle = new Element('button');
      this.controls = {
        '.bcr-provider': new Element('span'), '.bcr-status': new Element('span'), '.bcr-mode-note': new Element('p'),
        '.bcr-instruction': instruction, textarea: instruction, '.bcr-references': references, '.bcr-mode': mode,
        '.bcr-include-project': new Element('input'), '.bcr-agent-options': new Element('div'),
        '.bcr-sources': new Element('details'), '.bcr-generate': button, button: toggle,
        '.bcr-progress': new Element('section'), '.bcr-progress-list': new Element('ol'), '.bcr-elapsed': new Element('span'),
        '.bcr-toggle': toggle, '.bcr-body': new Element('div'), '.bcr-heading': new Element('div'), '.bcr-compact-status': new Element('span')
      };
    }
    set innerHTML(value) {this.staticMarkup = value;}
    querySelector(selector) {return this.controls[selector] || null;}
    querySelectorAll(selector) {return selector === '.bcr-generate, textarea, select, input' ? [this.controls['.bcr-generate'], this.controls['.bcr-instruction'], this.controls['.bcr-references'], this.controls['.bcr-mode'], this.controls['.bcr-include-project']] : [];}
    remove() {this.isConnected = false; if (root === this) root = null;}
  }
  const editor = editorType === 'contenteditable' ? new Editable() : new Textarea();
  editor.parentElement = {insertBefore(panel) {root = panel; panel.isConnected = true;}};
  let currentEditor = editor;
  const document = {
    visibilityState: 'visible', activeElement: null,
    addEventListener(name, callback, options) {documentListeners.set(name, {callback, once: options?.once});},
    removeEventListener(name) {documentListeners.delete(name);},
    dispatchEvent(event) {
      const entry = documentListeners.get(event.type);
      if (entry?.once) documentListeners.delete(event.type);
      entry?.callback(event);
      if (event.type === 'selectionchange') onSelectionChange?.(selection, editor);
    },
    documentElement: {}, getElementById: () => root,
    querySelectorAll: selector => selector === (editorType === 'contenteditable' ? '[contenteditable="true"][role="textbox"]' : 'textarea[name="content"]') ? [currentEditor] : [],
    createElement: tag => tag === 'section' ? new Panel() : new Element(tag),
    createTextNode: text => ({nodeType: 3, textContent: text, children: []}),
    createRange: () => ({
      selectNodeContents(target) {this.target = target; this.collapsed = false;},
      collapse() {this.collapsed = true;},
      toString() {return this.collapsed ? '' : this.target?.textContent || '';}
    }),
    execCommand(command, showUI, value) {
      editorActions.execs.push({command, showUI, value});
      if (execResult === 'throw') throw new Error('insertText is unavailable');
      if (execResult) editor.children = [this.createTextNode(execTransform(value))];
      return execResult;
    }
  };
  const window = {addEventListener(name, callback) {windowListeners.set(name, callback);}, removeEventListener(name) {windowListeners.delete(name);}, getSelection: () => selection};
  window.top = window;
  const context = vm.createContext({
    window, document, location, URL, HTMLTextAreaElement: Textarea, HTMLInputElement: Textarea,
    BacklogPanelLayout: {attach() {layoutActions.attached++; return {update() {layoutActions.updated++;}, destroy() {layoutActions.destroyed++;}};}},
    Date: {now: () => wallNow}, performance: {now: () => now}, crypto: {randomUUID: () => `test-request-${++requestNumber}`},
    Event: TestEvent, InputEvent: TestEvent,
    DataTransfer: clipboardSupport ? TestDataTransfer : undefined, ClipboardEvent: clipboardSupport ? TestEvent : undefined,
    confirm: message => {confirmations.push(message); now += confirmDelayMs; wallNow += confirmDelayMs; return confirmOverwrite;},
    MutationObserver: class {constructor(callback) {mutationCallback = callback;} observe() {} disconnect() {}},
    setInterval(callback) {const id = ++nextInterval; intervals.set(id, callback); return id;}, clearInterval(id) {intervals.delete(id);},
    setTimeout(callback, delay = 0) {
      if (holdTimers) pendingTimers.push({callback, delay});
      else void Promise.resolve().then(callback);
    },
    chrome: {runtime: {id: 'test-extension', onMessage: {addListener(callback) {progressListener = callback;}, removeListener(callback) {if (progressListener === callback) progressListener = null;}}, sendMessage: async message => {
      messages.push(message);
      if (message.type === 'GET_SETTINGS') return getSettings();
      if (message.type !== 'GENERATE_REPLY') throw new Error('Unexpected message');
      return new Promise(resolve => generations.push({message, resolve}));
    }}}
  });
  vm.runInContext(source, context);
  return {
    root: () => root, editor, editorEvents, editorActions, messages, generations, location, layoutActions, intervals, selection, document, pendingTimers, confirmations,
    async runTimer() {
      const timer = pendingTimers.shift();
      assert.ok(timer, 'expected an insertion timer to be pending');
      now += timer.delay; wallNow += timer.delay;
      timer.callback();
      await flush();
    },
    replaceEditor() {
      currentEditor = editorType === 'contenteditable' ? new Editable() : new Textarea();
      currentEditor.parentElement = editor.parentElement;
      return currentEditor;
    },
    focus: () => windowListeners.get('focus')?.(),
    visibility(state) {document.visibilityState = state; document.dispatchEvent(new TestEvent('visibilitychange'));},
    reinject() {vm.runInContext(source, context);},
    ping() {let response; progressListener({type: 'BACKLOG_AI_PING'}, {id: 'test-extension'}, result => {response = result;}); return response;},
    control: selector => root.querySelector(selector), mutate: () => mutationCallback(),
    commentForm() {
      const form = {contains: node => node === editor || node?.form === form};
      editor.closest = selector => selector === 'form' ? form : null;
      const button = {form, textContent: '登録', closest: () => button};
      return {
        submit: () => document.dispatchEvent(new TestEvent('submit', {target: form, submitter: button})),
        click: () => document.dispatchEvent(new TestEvent('click', {target: button})),
        otherSubmit: () => document.dispatchEvent(new TestEvent('submit', {target: form, submitter: {...button, textContent: 'プレビュー'}})),
        toolbarClick: () => document.dispatchEvent(new TestEvent('click', {target: {closest: () => ({form, textContent: '太字'})}})),
        input: () => document.dispatchEvent(new TestEvent('input', {target: editor, isTrusted: true}))
      };
    },
    type(selector, value) {const control = root.querySelector(selector); control.value = value; control.trigger(selector === '.bcr-mode' ? 'change' : 'input');},
    includeProject(checked) {const control = root.querySelector('.bcr-include-project'); control.checked = checked; control.trigger('change');},
    submit: () => root.querySelector('.bcr-generate').trigger('click'),
    toggle: () => root.querySelector('.bcr-toggle').trigger('click'),
    advance(milliseconds) {now += milliseconds; wallNow += milliseconds; intervals.forEach(callback => callback());},
    changeWallClock(milliseconds) {wallNow += milliseconds; intervals.forEach(callback => callback());},
    progress(update = {}, from = {id: 'test-extension'}) {
      const request = generations.at(-1).message;
      progressListener({type: 'GENERATION_PROGRESS', requestId: request.requestId, issueKey: request.issueKey,
        sequence: 1, message: '課題 TEST-13 を取得しています。', ...update}, from);
    },
    finish(overrides = {}, index = 0) {
      const request = generations[index];
      request.resolve({ok: true, issueKey: request.message.issueKey, provider: 'copilot', commentsUsed: 2, mode: request.message.mode, text: '修正しました。\r\n\r\nご確認ください。', sources: [], ...overrides});
    },
    navigate(path) {location.pathname = path; mutationCallback();}
  };
}

test('the AI panel collapses only after a submitted comment editor clears', async () => {
  const app = harness();
  await flush();
  const form = app.commentForm();
  app.toggle();
  app.editor.value = '投稿するコメント';
  form.click();
  app.mutate();
  assert.equal(app.control('.bcr-body').hidden, false, 'a click alone does not prove success');
  form.toolbarClick();
  app.editor.value = '';
  app.mutate();
  assert.equal(app.control('.bcr-body').hidden, true, 'unrelated toolbar clicks do not cancel a pending post');
  assert.equal(app.control('.bcr-toggle').getAttribute('aria-expanded'), 'false');

  app.toggle();
  app.editor.value = '別のコメント';
  form.submit();
  app.editor.value = '';
  form.input();
  app.mutate();
  assert.equal(app.control('.bcr-body').hidden, false, 'manual edits do not count as a completed post');

  app.editor.value = 'プレビューするコメント';
  form.submit();
  form.otherSubmit();
  app.editor.value = '';
  app.mutate();
  assert.equal(app.control('.bcr-body').hidden, false, 'preview submission is not a comment post');

  app.editor.value = '失敗したコメント';
  form.submit();
  app.advance(31000);
  app.editor.value = '';
  app.mutate();
  assert.equal(app.control('.bcr-body').hidden, false, 'an old submit cannot collapse the panel later');
});

test('replacing a submitted editor with a blank editor does not imply the post succeeded', async () => {
  const app = harness();
  await flush();
  const form = app.commentForm();
  app.toggle();
  app.editor.value = '投稿に失敗したコメント';
  form.submit();
  const replacement = app.replaceEditor();
  assert.equal(replacement.value, '');
  app.mutate();
  assert.equal(app.control('.bcr-body').hidden, false, 'a different empty editor is not proof of success');
  app.editor.value = '';
  app.mutate();
  assert.equal(app.control('.bcr-body').hidden, false, 'the abandoned submission cannot collapse the panel later');
});
function descendants(element, tag) {
  return element.children.flatMap(child => [...(child.tagName === tag.toUpperCase() ? [child] : []), ...descendants(child, tag)]);
}
function logs(app) {return app.control('.bcr-progress-list').children.map(entry => entry.textContent);}
function timeline(app) {
  return logs(app).map(text => {
    const match = /^\+([\d.]+)秒(?:（(所要|継続)\s+([\d.]+)秒）)?：/.exec(text);
    assert.ok(match, `log must distinguish its start offset and duration: ${text}`);
    return {start: Number(match[1]), state: match[2], duration: match[3] === undefined ? undefined : Number(match[3]), text};
  });
}

test('normal mode is the default and instruction is separate from references in the request', async () => {
  const app = harness();
  await flush();
  assert.equal(app.control('.bcr-body').hidden, true);
  assert.equal(app.control('.bcr-toggle').getAttribute('aria-expanded'), 'false');
  app.toggle();
  assert.equal(app.control('.bcr-body').hidden, false);
  assert.equal(app.control('.bcr-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(app.generations.length, 0, 'opening the panel never starts AI generation');
  assert.equal(app.control('.bcr-mode').value, 'chat');
  assert.equal(app.control('.bcr-agent-options').hidden, true);
  assert.equal(app.control('.bcr-include-project').checked, true);
  assert.ok(app.control('.bcr-mode-note').textContent.includes('まとめて参照'));
  assert.ok(app.root().staticMarkup.includes('課題5件・プロジェクト3件まで'));
  app.type('.bcr-instruction', '関連状況を踏まえて返信する');
  app.type('.bcr-references', 'PROJECT-123, OTHER_PROJECT\nhttps://example.backlog.com/view/OTHER-2');
  const pending = app.submit();
  await flush();
  const sent = app.generations[0].message;
  assert.equal(sent.instruction, '関連状況を踏まえて返信する');
  assert.equal(sent.references, 'PROJECT-123, OTHER_PROJECT\nhttps://example.backlog.com/view/OTHER-2');
  assert.equal(sent.mode, 'chat');
  app.finish(); await pending;
  assert.equal(app.editor.value, '修正しました。\n\nご確認ください。');
  assert.deepEqual(app.editorEvents, ['input', 'change']);
});

test('returning to a long-idle tab checks settings once and never generates automatically', async () => {
  const app = harness();
  await flush();
  const initial = app.messages.length;
  app.visibility('hidden');
  await flush();
  assert.equal(app.messages.length, initial);
  app.visibility('visible');
  app.focus();
  await flush();
  assert.equal(app.messages.length, initial + 1);
  assert.equal(app.generations.length, 0);
  app.advance(15000);
  app.focus();
  await flush();
  assert.equal(app.messages.length, initial + 2);
  assert.deepEqual({...app.ping()}, {ok: true, version: 1});
});

test('returning to a non-issue Backlog page never contacts the extension', async () => {
  const app = harness();
  await flush();
  app.navigate('/projects/TEST');
  await flush();
  const before = app.messages.length;
  app.visibility('visible');
  app.focus();
  await flush();
  assert.equal(app.messages.length, before);
});

test('generated links or images to hosts the user did not provide need confirmation before insertion', async () => {
  const cancelled = harness();
  await flush();
  cancelled.type('.bcr-instruction', '資料 https://docs.example.org/a.pdf を案内して');
  const pending = cancelled.submit();
  await flush();
  cancelled.finish({text: '資料は https://docs.example.org/a.pdf と [TEST-1](https://example.backlog.com/view/TEST-1) です。\n![](https://evil.example/p.png?d=secret)'});
  await pending;
  assert.equal(cancelled.confirmations.length, 1);
  assert.match(cancelled.confirmations[0], /evil\.example/);
  assert.doesNotMatch(cancelled.confirmations[0], /docs\.example\.org|example\.backlog\.com|secret/);
  assert.equal(cancelled.editor.value, '');
  assert.match(cancelled.control('.bcr-status').textContent, /外部URLを含むため.*キャンセル/);

  const accepted = harness({confirmOverwrite: true});
  await flush();
  accepted.type('.bcr-instruction', '資料を案内して');
  const running = accepted.submit();
  await flush();
  accepted.finish({text: '![](//cdn.evil.example/p.png)'});
  await running;
  assert.equal(accepted.confirmations.length, 1);
  assert.match(accepted.confirmations[0], /cdn\.evil\.example/);
  assert.equal(accepted.editor.value, '![](//cdn.evil.example/p.png)');
  assert.match(accepted.control('.bcr-status').textContent, /外部URLの宛先/);

  const trusted = harness();
  await flush();
  trusted.type('.bcr-instruction', '資料 https://docs.example.org/a.pdf を案内して');
  const plain = trusted.submit();
  await flush();
  trusted.finish({text: '資料はhttps://docs.example.org/b.pdfです。https://example.backlog.com/view/TEST-1 も参照。A//B'});
  await plain;
  assert.equal(trusted.confirmations.length, 0);
  assert.match(trusted.editor.value, /docs\.example\.org\/b\.pdf/);
  assert.doesNotMatch(trusted.control('.bcr-status').textContent, /外部URL/);
});

test('settings reconnect retries transient missing receivers without showing a stale error', async () => {
  let attempts = 0;
  const app = harness({getSettings: () => {
    if (++attempts < 3) throw new Error('Could not establish connection. Receiving end does not exist.');
    return {ok: true, provider: 'copilot'};
  }});
  await flush();
  assert.equal(attempts, 3);
  assert.equal(app.control('.bcr-status').textContent, '');
  assert.equal(app.generations.length, 0);
});

test('a failed reconnect is clear in Japanese and is cleared after the tab reconnects', async () => {
  let available = false;
  const app = harness({getSettings: () => {
    if (!available) throw new Error('Could not establish connection. Receiving end does not exist.');
    return {ok: true, provider: 'copilot'};
  }});
  await flush();
  assert.match(app.control('.bcr-status').textContent, /拡張機能との接続/);
  assert.doesNotMatch(app.control('.bcr-status').textContent, /Receiving end/);
  available = true;
  app.focus();
  await flush();
  assert.equal(app.control('.bcr-status').textContent, '');
});

test('recovery injection keeps unfinished fields, replaces listeners and never changes a comment draft', async () => {
  const app = harness();
  await flush();
  app.toggle();
  app.type('.bcr-instruction', '調査結果を伝える');
  app.type('.bcr-references', 'OTHER-1');
  app.type('.bcr-mode', 'agent');
  app.includeProject(false);
  app.editor.value = '投稿前の下書き';
  const previousRoot = app.root();
  app.reinject();
  await flush();
  assert.notEqual(app.root(), previousRoot);
  assert.equal(app.control('.bcr-instruction').value, '調査結果を伝える');
  assert.equal(app.control('.bcr-references').value, 'OTHER-1');
  assert.equal(app.control('.bcr-mode').value, 'agent');
  assert.equal(app.control('.bcr-include-project').checked, false);
  assert.equal(app.control('.bcr-body').hidden, false);
  assert.equal(app.editor.value, '投稿前の下書き');
  assert.equal(app.intervals.size, 2);
  assert.equal(app.layoutActions.destroyed, 1);
  assert.equal(app.generations.length, 0);
});

test('recovery never inserts a late result or automatically repeats a generation', async () => {
  const app = harness();
  await flush();
  app.type('.bcr-instruction', '返信を作成');
  const pending = app.submit();
  await flush();
  app.reinject();
  await flush();
  app.finish();
  await pending;
  assert.equal(app.editor.value, '');
  assert.equal(app.generations.length, 1);
  assert.equal(app.control('.bcr-instruction').value, '返信を作成');
});

async function startDraftInsertion(app, text) {
  await flush();
  app.type('.bcr-instruction', '確認した内容を返信する');
  const pending = app.submit();
  await flush();
  app.finish({text});
  await flush();
  return {pending};
}
async function insertDraft(app, text) {
  const {pending} = await startDraftInsertion(app, text);
  await pending;
}

test('controlled rich editors receive plain-text paste with paragraphs, quotes and line breaks', async () => {
  const text = '@担当者 様\n\nお世話になっております。\nご連絡が遅くなり申し訳ございません。\n\n> 進捗はいかがでしょうか。\n> 反映時期を教えてください。\n\n現在、確認しております。\nよろしくお願いいたします。';
  let model;
  const app = harness({editorType: 'contenteditable', onPaste(event, editor, selection) {
    assert.equal(event.bubbles, true);
    assert.equal(event.cancelable, true);
    assert.equal(event.composed, true);
    assert.equal(selection.ranges.length, 1);
    assert.equal(selection.ranges[0].target, editor);
    assert.deepEqual(event.clipboardData.types, ['text/plain']);
    assert.equal(event.clipboardData.getData('text/html'), '');
    event.preventDefault();
    model = event.clipboardData.getData('text/plain').split('\n\n').map(paragraph => paragraph.split('\n'));
    // A framework renders its own model; the extension must leave that model
    // and DOM alone instead of replacing its paragraphs with flat text nodes.
    editor.children = model.map(lines => ({tagName: 'P', textContent: lines.join('\n'), children: []}));
  }});
  await insertDraft(app, text.replace(/\n/g, '\r\n'));
  assert.equal(model.map(lines => lines.join('\n')).join('\n\n'), text);
  assert.equal(app.editor.innerText, text);
  assert.deepEqual(app.editorEvents, ['paste']);
  assert.equal(app.editorActions.execs.length, 0);
  assert.equal(app.editorActions.domReplacements, 0);
});

test('a consumed paste waits for asynchronous rendering before reporting successful insertion', async () => {
  const text = '@担当者 様\n\nご確認ありがとうございます。\n\n対応を進めます。';
  let renderPaste;
  const app = harness({editorType: 'contenteditable', holdTimers: true, onPaste(event, editor) {
    event.preventDefault();
    const plainText = event.clipboardData.getData('text/plain');
    renderPaste = () => {editor.children = plainText.split('\n\n').map(paragraph => ({tagName: 'P', textContent: paragraph, children: []}));};
  }});
  const {pending} = await startDraftInsertion(app, text);
  await app.runTimer(); // Selection synchronization, then paste.
  assert.equal(app.editor.innerText, '');
  assert.equal(app.editorActions.execs.length, 0);
  assert.equal(app.editorActions.domReplacements, 0);
  await app.runTimer();
  await app.runTimer();
  assert.equal(app.control('.bcr-generate').disabled, true);
  assert.doesNotMatch(app.control('.bcr-status').textContent, /挿入しました/);
  renderPaste();
  await app.runTimer();
  assert.equal(app.control('.bcr-generate').disabled, true, 'a single matching render does not finish the request');
  await app.runTimer();
  await pending;
  assert.equal(app.editor.innerText, text);
  assert.match(app.control('.bcr-status').textContent, /挿入しました/);
  assert.equal(app.control('.bcr-generate').disabled, false);
});

for (const caret of ['end', 'middle']) {
  test(`confirmed rich-text overwrite replaces the model after an asynchronous selection update from the ${caret}`, async () => {
    const original = '@相手 様\n\n既存の下書きです。\n\n元の結びです。';
    const generated = '@相手 様\n\n> 確認事項\n\n修正しました。\nご確認ください。';
    let model = original;
    let modelSelection = {start: caret === 'end' ? original.length : 8, end: caret === 'end' ? original.length : 8};
    const app = harness({editorType: 'contenteditable', confirmOverwrite: true,
      onSelectionChange(selection, editor) {
        if (selection.rangeCount === 1 && selection.ranges[0].target === editor && !selection.ranges[0].collapsed) {
          modelSelection = {start: 0, end: model.length};
        }
      },
      onPaste(event, editor) {
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain');
        model = model.slice(0, modelSelection.start) + text + model.slice(modelSelection.end);
        editor.textContent = model;
      }
    });
    app.editor.textContent = original;
    await insertDraft(app, generated);
    assert.equal(app.confirmations.length, 1);
    assert.equal(model, generated, 'the editor model must replace the old draft, not append or insert into it');
    assert.equal(app.editor.innerText, generated);
    assert.equal(app.editorActions.pastes.length, 1);
    assert.equal(app.editorActions.execs.length + app.editorActions.domReplacements, 0);
    assert.match(app.control('.bcr-status').textContent, /挿入しました/);
  });
}

test('declining a rich-text overwrite leaves the original model and selection untouched', async () => {
  const app = harness({editorType: 'contenteditable'});
  const original = '@相手 様\n\n投稿前の下書き';
  app.editor.textContent = original;
  await insertDraft(app, '新しい生成文');
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.editor.innerText, original);
  assert.equal(app.selection.rangeCount, 0);
  assert.equal(app.editorEvents.length, 0);
  assert.equal(app.editorActions.execs.length + app.editorActions.domReplacements, 0);
  assert.match(app.control('.bcr-status').textContent, /キャンセル/);
});

test('a consumed paste that still appends is an error, never a second paste or forced DOM replacement', async () => {
  const original = '既存の下書き\n\n末尾';
  const generated = '生成された本文\n\n結び';
  const app = harness({editorType: 'contenteditable', confirmOverwrite: true, onPaste(event, editor) {
    event.preventDefault();
    editor.textContent += event.clipboardData.getData('text/plain');
  }});
  app.editor.textContent = original;
  await insertDraft(app, generated);
  assert.equal(app.editor.innerText, original + generated);
  assert.equal(app.editorActions.pastes.length, 1);
  assert.equal(app.editorActions.execs.length + app.editorActions.domReplacements, 0);
  assert.match(app.control('.bcr-status').textContent, /置き換えを確認できません/);
  assert.equal(app.control('.bcr-status').classList.contains('bcr-error'), true);
  assert.doesNotMatch(app.control('.bcr-status').textContent, /挿入しました/);
  assert.equal(app.control('.bcr-generate').disabled, false);
});

test('a paste handler that cancels without inserting does not count as success or erase the old draft', async () => {
  const original = '既存の下書き';
  const app = harness({editorType: 'contenteditable', confirmOverwrite: true, onPaste(event) {event.preventDefault();}});
  app.editor.textContent = original;
  await insertDraft(app, '生成結果');
  assert.equal(app.editor.innerText, original);
  assert.equal(app.editorActions.pastes.length, 1);
  assert.equal(app.editorActions.execs.length + app.editorActions.domReplacements, 0);
  assert.match(app.control('.bcr-status').textContent, /置き換えを確認できません/);
  assert.doesNotMatch(app.control('.bcr-status').textContent, /挿入しました/);
});

test('a temporary matching DOM render is not success if the editor restores the original model', async () => {
  const original = '既存モデルの本文';
  const generated = '新しい本文\n\n回答';
  const app = harness({editorType: 'contenteditable', confirmOverwrite: true, holdTimers: true, onPaste(event, editor) {
    event.preventDefault();
    editor.textContent = event.clipboardData.getData('text/plain');
  }});
  app.editor.textContent = original;
  const {pending} = await startDraftInsertion(app, generated);
  await app.runTimer(); // Selection -> paste, temporarily shows the generated text.
  await app.runTimer(); // Only the first verification observes that temporary DOM.
  assert.equal(app.control('.bcr-generate').disabled, true);
  app.editor.textContent = original; // Framework reconciliation restores its model.
  for (let attempt = 0; attempt < 20 && app.pendingTimers.length; attempt++) await app.runTimer();
  await pending;
  assert.equal(app.editor.innerText, original);
  assert.equal(app.editorActions.pastes.length, 1);
  assert.equal(app.editorActions.execs.length + app.editorActions.domReplacements, 0);
  assert.match(app.control('.bcr-status').textContent, /置き換えを確認できません/);
  assert.doesNotMatch(app.control('.bcr-status').textContent, /挿入しました/);
});

for (const interruption of ['navigate', 'away-and-back', 'reinject', 'edit', 'remove', 'replace', 'focus', 'selection']) {
  test(`rich-text insertion is cancelled if ${interruption} happens while its selection synchronizes`, async () => {
    const app = harness({editorType: 'contenteditable', confirmOverwrite: true, holdTimers: true});
    const original = '既存の下書き\n\n保持する本文';
    app.editor.textContent = original;
    const {pending} = await startDraftInsertion(app, '生成結果');
    assert.equal(app.editorActions.pastes.length, 0);
    if (interruption === 'navigate') app.navigate('/view/OTHER-1');
    if (interruption === 'away-and-back') {app.navigate('/view/OTHER-1'); app.navigate('/view/TEST-12');}
    if (interruption === 'reinject') app.reinject();
    if (interruption === 'edit') app.editor.textContent += '\n手動で追記';
    if (interruption === 'remove') app.editor.isConnected = false;
    if (interruption === 'replace') app.replaceEditor();
    if (interruption === 'focus') app.control('.bcr-instruction').focus();
    if (interruption === 'selection') app.selection.ranges[0].collapse();
    await app.runTimer();
    await pending;
    assert.equal(app.editor.innerText, interruption === 'edit' ? `${original}\n手動で追記` : original);
    assert.equal(app.editorActions.pastes.length + app.editorActions.execs.length + app.editorActions.domReplacements, 0);
    assert.doesNotMatch(app.control('.bcr-status').textContent, /挿入しました/);
  });
}

test('navigation while verifying a handled paste cannot report a successful insertion on another issue', async () => {
  const app = harness({editorType: 'contenteditable', holdTimers: true, onPaste(event, editor) {
    event.preventDefault();
    editor.textContent = event.clipboardData.getData('text/plain');
  }});
  const {pending} = await startDraftInsertion(app, '生成された本文');
  await app.runTimer();
  assert.equal(app.editorActions.pastes.length, 1);
  app.navigate('/view/OTHER-1');
  await app.runTimer();
  await pending;
  assert.equal(app.editorActions.pastes.length, 1);
  assert.equal(app.editorActions.execs.length + app.editorActions.domReplacements, 0);
  assert.doesNotMatch(app.control('.bcr-status').textContent, /挿入しました/);
});

test('unhandled paste falls back to native insertText when it preserves all line breaks', async () => {
  const text = '宛名\n\n本文\n> 引用\n\n回答';
  const app = harness({editorType: 'contenteditable', execResult: true});
  await insertDraft(app, text);
  assert.equal(app.editor.innerText, text);
  assert.equal(app.editorActions.pastes.length, 1);
  assert.deepEqual(app.editorActions.execs, [{command: 'insertText', showUI: false, value: text}]);
  assert.equal(app.editorActions.domReplacements, 0);
});

test('unavailable paste constructors and failed insertText retain safe DOM fallback with exact line breaks', async () => {
  const text = '@担当者 様\n\n> 引用1\n> 引用2\n\n本文 <script>alert("x")</script>\n\n- 項目1\n- 項目2';
  for (const fallback of [{clipboardSupport: false, execResult: false},
    {clipboardConstructionThrows: true, execResult: 'throw'}, {execResult: false},
    {execResult: true, execTransform: value => value.replace(/\n/g, ' ')}]) {
    const app = harness({editorType: 'contenteditable', ...fallback});
    await insertDraft(app, text.replace(/\n/g, '\r\n'));
    assert.equal(app.editor.innerText, text);
    assert.equal(app.editorActions.domReplacements, 1);
    assert.equal(app.editorActions.execs.length, 1);
    assert.equal(app.editor.children.filter(node => node.tagName === 'BR').length, text.split('\n').length - 1);
    assert.ok(app.editor.children.every(node => node.nodeType === 3 || node.tagName === 'BR'));
    assert.equal(descendants(app.editor, 'script').length, 0);
    assert.equal(app.editorEvents.at(-1), 'input');
  }
});

test('HTML-like draft text is sent only as plain text and never interpreted as paste markup', async () => {
  const text = '<img src=x onerror=alert(1)>\n\n> <script>literal</script>';
  let pasted;
  const app = harness({editorType: 'contenteditable', onPaste(event, editor) {
    event.preventDefault();
    pasted = event.clipboardData;
    editor.textContent = pasted.getData('text/plain');
  }});
  await insertDraft(app, text);
  assert.deepEqual(pasted.types, ['text/plain']);
  assert.equal(pasted.getData('text/plain'), text);
  assert.equal(pasted.getData('text/html'), '');
  assert.equal(app.editorActions.execs.length + app.editorActions.domReplacements, 0);
  assert.equal(app.editor.innerText, text);
  assert.match(app.control('.bcr-status').textContent, /挿入しました/);
});

test('textarea insertion keeps existing paragraph, quote and literal escape text without clipboard events', async () => {
  const text = '@担当者 様\r\n\r\n> 確認事項\r> 続き\r\n\r\n回答です。 C:\\new-folder\\note.txt\r\n\r\nよろしくお願いいたします。';
  const app = harness({clipboardConstructionThrows: true});
  await insertDraft(app, text);
  assert.equal(app.editor.value, text.replace(/\r\n?/g, '\n'));
  assert.deepEqual(app.editorEvents, ['input', 'change']);
  assert.equal(app.editorActions.pastes.length + app.editorActions.execs.length + app.editorActions.domReplacements, 0);
});

test('confirmed textarea overwrite replaces its complete existing value and retains generated line breaks', async () => {
  const app = harness({confirmOverwrite: true});
  app.editor.value = '元の本文\n\n元の結び';
  const text = '@相手 様\r\n\r\n新しい本文\r\n> 引用\r\n\r\n回答';
  await insertDraft(app, text);
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.editor.value, text.replace(/\r\n/g, '\n'));
  assert.deepEqual(app.editorEvents, ['input', 'change']);
  assert.equal(app.editorActions.pastes.length + app.editorActions.execs.length + app.editorActions.domReplacements, 0);
  assert.match(app.control('.bcr-status').textContent, /挿入しました/);
});

test('mode, instruction and references have visible labels and associated help text', async () => {
  const app = harness();
  await flush();
  const markup = app.root().staticMarkup;
  assert.match(markup, /<fieldset\b[^>]*>[\s\S]*<legend\b[^>]*>返信案の作成条件<\/legend>/);
  for (const id of ['bcr-mode', 'bcr-instruction', 'bcr-references']) {
    assert.match(markup, new RegExp(`<label\\b[^>]*for="${id}"[^>]*>[^<]+</label>`));
    assert.match(markup, new RegExp(`<(?:textarea|select)\\b[^>]*id="${id}"`));
  }
  for (const id of ['bcr-mode-note', 'bcr-references-note']) {
    assert.ok(markup.includes(`aria-describedby="${id}"`));
    assert.ok(markup.includes(`id="${id}"`));
  }
  assert.ok(markup.includes('role="status" aria-live="polite"'));
});

test('agent mode sends the selected scope and explains read-only investigation', async () => {
  const app = harness();
  await flush();
  app.type('.bcr-mode', 'agent');
  assert.equal(app.control('.bcr-agent-options').hidden, false);
  assert.equal(app.control('.bcr-include-project').checked, true);
  app.type('.bcr-instruction', '関連課題の対応状況を調べて返信する');
  app.type('.bcr-references', '  OTHER_PROJECT, PROJECT-123  ');
  assert.ok(app.control('.bcr-mode-note').textContent.includes('Backlog MCP'));
  assert.ok(app.control('.bcr-mode-note').textContent.includes('変更や投稿は行いません'));
  const pending = app.submit();
  await flush();
  assert.equal(app.generations[0].message.mode, 'agent');
  assert.equal(app.generations[0].message.includeCurrentProject, true);
  assert.equal(app.generations[0].message.references, 'OTHER_PROJECT, PROJECT-123');
  assert.ok(app.control('.bcr-status').textContent.includes('調査'));
  app.finish(); await pending;
});

test('agent project opt-out survives folding, mode changes and remounting and is sent as false', async () => {
  const app = harness();
  await flush();
  app.type('.bcr-mode', 'agent');
  app.includeProject(false);
  app.type('.bcr-instruction', 'この課題だけを確認して返信する');
  assert.match(app.control('.bcr-mode-note').textContent, /現在の課題と明示的に指定した参照先だけ/);
  app.toggle(); app.toggle();
  app.type('.bcr-mode', 'chat');
  assert.equal(app.control('.bcr-agent-options').hidden, true);
  app.type('.bcr-mode', 'agent');
  app.root().remove(); app.mutate(); await flush();
  assert.equal(app.control('.bcr-include-project').checked, false);
  const pending = app.submit();
  await flush();
  assert.equal(app.generations[0].message.includeCurrentProject, false);
  assert.equal(app.control('.bcr-include-project').disabled, true);
  app.finish(); await pending;
  assert.equal(app.control('.bcr-include-project').checked, false);
  assert.equal(app.control('.bcr-include-project').disabled, false);
});

test('generation locks inputs but keeps folding available, including after a panel remount', async () => {
  const app = harness();
  await flush();
  app.toggle();
  app.type('.bcr-instruction', '修正完了を伝える');
  app.type('.bcr-mode', 'agent');
  app.type('.bcr-references', 'PROJECT-123');
  const pending = app.submit();
  await flush();
  assert.ok(app.root().querySelectorAll('.bcr-generate, textarea, select, input').every(control => control.disabled));
  assert.equal(app.control('.bcr-toggle').disabled, false);
  app.toggle();
  assert.equal(app.control('.bcr-body').hidden, true);
  assert.match(app.control('.bcr-toggle').textContent, /生成中/);
  assert.equal(app.generations.length, 1);
  app.root().remove(); app.mutate(); await flush();
  assert.equal(app.control('.bcr-instruction').value, '修正完了を伝える');
  assert.equal(app.control('.bcr-mode').value, 'agent');
  assert.equal(app.control('.bcr-references').value, 'PROJECT-123');
  assert.equal(app.control('.bcr-body').hidden, true);
  assert.equal(app.control('.bcr-toggle').disabled, false);
  assert.ok(app.root().querySelectorAll('.bcr-generate, textarea, select, input').every(control => control.disabled));
  app.finish(); await pending;
  assert.match(app.control('.bcr-toggle').textContent, /完了/);
  app.toggle();
  assert.equal(app.control('.bcr-body').hidden, false);
  assert.equal(app.control('.bcr-instruction').value, '修正完了を伝える');
  assert.ok(app.root().querySelectorAll('.bcr-generate, textarea, select, input').every(control => !control.disabled));
});

test('draft fields are preserved per issue in page memory across navigation', async () => {
  const app = harness();
  await flush();
  app.toggle();
  app.type('.bcr-instruction', '最初の課題への指示');
  app.type('.bcr-mode', 'agent');
  app.includeProject(false);
  app.type('.bcr-references', 'RELATED-1');
  app.navigate('/view/OTHER-5'); await flush();
  assert.equal(app.control('.bcr-body').hidden, false);
  assert.equal(app.control('.bcr-instruction').value, '');
  assert.equal(app.control('.bcr-mode').value, 'chat');
  assert.equal(app.control('.bcr-include-project').checked, true);
  assert.equal(app.control('.bcr-references').value, '');
  app.type('.bcr-instruction', '別課題への指示');
  app.toggle();
  app.navigate('/view/TEST-12'); await flush();
  assert.equal(app.control('.bcr-body').hidden, true);
  assert.equal(app.control('.bcr-instruction').value, '最初の課題への指示');
  assert.equal(app.control('.bcr-mode').value, 'agent');
  assert.equal(app.control('.bcr-include-project').checked, false);
  assert.equal(app.control('.bcr-references').value, 'RELATED-1');
});

test('source links are same-origin HTTPS only, deduplicated and rendered without HTML injection', async () => {
  const app = harness();
  await flush();
  app.type('.bcr-instruction', '調査結果から返信する');
  app.type('.bcr-mode', 'agent');
  const pending = app.submit();
  await flush();
  app.finish({toolCalls: 3, sources: [
    {title: '<img src=x onerror=alert(1)>', url: 'https://example.backlog.com/view/RELATED-1'},
    {title: '重複', url: 'https://example.backlog.com/view/RELATED-1'},
    {title: 'プロジェクト', url: 'https://example.backlog.com/projects/OTHER_PROJECT'},
    {title: 'HTTP', url: 'http://example.backlog.com/view/RELATED-2'},
    {title: '外部', url: 'https://evil.example/view/RELATED-2'},
    {title: '別スペース', url: 'https://other.backlog.com/view/RELATED-2'},
    {title: '認証付き', url: 'https://username:password@example.backlog.com/view/RELATED-2'},
    {title: 'スクリプト', url: 'javascript:alert(1)'},
    {title: 'API', url: 'https://example.backlog.com/api/v2/issues/RELATED-2'},
    {title: '設定画面', url: 'https://example.backlog.com/settings'},
    {title: 'クエリ付き', url: 'https://example.backlog.com/view/RELATED-2?apiKey=secret'},
    {title: 'フラグメント付き', url: 'https://example.backlog.com/view/RELATED-2#comment-1'},
    {title: '不正課題キー', url: 'https://example.backlog.com/view/RELATED'},
    {title: '下位パス', url: 'https://example.backlog.com/projects/OTHER_PROJECT/settings'},
    {title: '相対', url: '/view/RELATED-2'}, {title: '壊れたURL', url: 'not a URL'}
  ]});
  await pending;
  const container = app.control('.bcr-sources');
  assert.equal(container.hidden, false);
  assert.equal(container.open, false);
  assert.equal(container.children[0].tagName, 'SUMMARY');
  assert.ok(container.children[0].textContent.includes('調査 3 回'));
  const links = descendants(container, 'a');
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(links[0].href, 'https://example.backlog.com/view/RELATED-1');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(descendants(container, 'img').length, 0);
  container.open = true; container.trigger('toggle');
  app.toggle(); app.toggle();
  assert.equal(container.open, true, 'panel folding does not reset an intentionally opened source list');
  app.root().remove(); app.mutate(); await flush();
  assert.equal(descendants(app.control('.bcr-sources'), 'a').length, 2);
  assert.equal(app.control('.bcr-sources').open, true);
  const next = app.submit(); await flush();
  app.finish({sources: [{title: '今回の取得元', url: 'https://example.backlog.com/view/RELATED-2'}]}, 1);
  await next;
  assert.equal(app.control('.bcr-sources').open, false, 'each new generation starts with its sources collapsed');
});

test('live progress is correlated, rendered as text and kept independently from elapsed time', async () => {
  const app = harness(); await flush();
  app.type('.bcr-instruction', '調査して返信する');
  const pending = app.submit(); await flush();
  const before = app.control('.bcr-status').textContent;
  app.progress({requestId: 'another-request'});
  app.progress({issueKey: 'OTHER-1'});
  app.progress({}, {id: 'other-extension'});
  assert.equal(app.control('.bcr-status').textContent, before);
  app.progress({message: '<img src=x onerror=alert(1)>', sequence: 2});
  assert.equal(app.control('.bcr-status').textContent, '<img src=x onerror=alert(1)>');
  app.progress({message: '古い通知', sequence: 1});
  assert.equal(app.control('.bcr-status').textContent, '<img src=x onerror=alert(1)>');
  const log = app.control('.bcr-progress-list');
  assert.equal(descendants(log, 'img').length, 0);
  assert.match(log.children.at(-1).textContent, /<img/);
  const entries = log.children.length;
  app.advance(12000);
  assert.equal(app.control('.bcr-elapsed').textContent, '経過 12.0 秒');
  assert.match(log.children.at(-1).textContent, /^\+0\.0秒（継続 12\.0秒）：<img/);
  assert.equal(log.children.length, entries, 'timer updates do not invent progress events');
  app.root().remove(); app.mutate(); await flush();
  assert.equal(app.control('.bcr-progress-list').children.length, entries);
  app.finish(); await pending;
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 12.0 秒');
  const completed = app.control('.bcr-status').textContent;
  app.progress({sequence: 3, message: '遅れて届いた通知'});
  app.advance(10000);
  assert.equal(app.control('.bcr-status').textContent, completed);
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 12.0 秒');
});

test('subsecond stage offsets and live durations form one timeline ending at the total elapsed time', async () => {
  const app = harness(); await flush();
  app.type('.bcr-instruction', '時間を確認して返信する');
  const pending = app.submit(); await flush();
  app.advance(200);
  app.progress({sequence: 1, message: 'ローカル接続を起動しています。'});
  app.advance(300);
  app.progress({sequence: 2, message: 'AIの応答を待っています。'});
  app.advance(4500);
  let entries = timeline(app);
  const connection = entries.find(entry => entry.text.includes('ローカル接続'));
  assert.equal(connection.start, 0.2);
  assert.equal(connection.state, '所要');
  assert.equal(connection.duration, 0.3);
  assert.equal(entries.at(-1).start, 0.5);
  assert.equal(entries.at(-1).state, '継続');
  assert.equal(entries.at(-1).duration, 4.5);
  assert.equal(app.control('.bcr-elapsed').textContent, '経過 5.0 秒');
  const count = entries.length;
  app.toggle(); app.toggle();
  app.root().remove(); app.mutate(); await flush();
  assert.deepEqual(timeline(app), entries, 'folding and editor remounts retain the same timeline');
  app.finish(); await pending;
  entries = timeline(app);
  assert.ok(entries.length > count);
  assert.equal(entries.at(-1).start, 5);
  assert.equal(entries.at(-1).duration, undefined, 'completion is an instant, not another unfinished stage');
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 5.0 秒');
  assert.ok(entries.slice(0, -1).every(entry => entry.state === '所要'));
  for (let i = 0; i < entries.length - 1; i++) {
    assert.ok(Math.abs(entries[i].start + entries[i].duration - entries[i + 1].start) < 1e-9);
  }
  assert.ok(Math.abs(entries.reduce((total, entry) => total + (entry.duration || 0), 0) - 5) < 1e-9);
  const completed = logs(app);
  app.advance(30000);
  assert.deepEqual(logs(app), completed);
});

test('wall clock adjustments cannot change elapsed time or per-log durations', async () => {
  const app = harness(); await flush();
  app.type('.bcr-instruction', '返信する');
  const pending = app.submit(); await flush();
  app.advance(200);
  app.progress({sequence: 1, message: 'AIの応答を待っています。'});
  app.changeWallClock(-3600000);
  app.advance(800);
  assert.equal(app.control('.bcr-elapsed').textContent, '経過 1.0 秒');
  assert.equal(timeline(app).at(-1).duration, 0.8);
  app.changeWallClock(7200000);
  app.advance(1000);
  assert.equal(app.control('.bcr-elapsed').textContent, '経過 2.0 秒');
  assert.equal(timeline(app).at(-1).duration, 1.8);
  app.finish(); await pending;
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 2.0 秒');
  assert.equal(timeline(app).at(-1).start, 2);
});

test('rounding many short stages does not lose time from the displayed total', async () => {
  const app = harness(); await flush();
  app.type('.bcr-instruction', '返信する');
  const pending = app.submit(); await flush();
  for (let sequence = 1; sequence <= 9; sequence++) {
    app.advance(49);
    app.progress({sequence, message: `短い処理 ${sequence}`});
  }
  app.advance(49);
  app.finish(); await pending;
  const entries = timeline(app);
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 0.4 秒');
  assert.equal(entries.at(-1).start, 0.4);
  assert.equal(entries.reduce((total, entry) => total + Math.round((entry.duration || 0) * 10), 0), 4);
});

test('repeated progress notifications do not restart the current stage timer', async () => {
  const app = harness(); await flush();
  app.type('.bcr-instruction', '返信する');
  const pending = app.submit(); await flush();
  app.advance(200);
  app.progress({sequence: 1, message: '同じ処理の進行状況です。'});
  const count = logs(app).length;
  app.advance(1000);
  app.progress({sequence: 2, message: '同じ処理の進行状況です。'});
  app.advance(1000);
  assert.equal(logs(app).length, count);
  assert.equal(timeline(app).at(-1).start, 0.2);
  assert.equal(timeline(app).at(-1).duration, 2);
  app.finish(); await pending;
});

test('a new generation starts a fresh timeline and cannot receive progress from the previous request', async () => {
  const app = harness(); await flush();
  app.type('.bcr-instruction', '返信する');
  const first = app.submit(); await flush();
  const oldRequestId = app.generations[0].message.requestId;
  app.advance(5000);
  app.finish(); await first;
  app.editor.value = '';
  app.advance(100000);
  const second = app.submit(); await flush();
  assert.equal(app.control('.bcr-elapsed').textContent, '経過 0.0 秒');
  assert.ok(timeline(app).every(entry => entry.start === 0));
  const count = logs(app).length;
  app.progress({requestId: oldRequestId, sequence: 10, message: '前回の遅い進行状況'});
  assert.equal(logs(app).length, count);
  app.advance(700);
  app.finish({}, 1); await second;
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 0.7 秒');
  assert.equal(timeline(app).at(-1).start, 0.7);
});

test('long investigations retain their initial timing instead of truncating the beginning of the total', async () => {
  const app = harness(); await flush();
  app.type('.bcr-instruction', '関連情報を調査する');
  const pending = app.submit(); await flush();
  for (let sequence = 1; sequence <= 60; sequence++) {
    app.advance(100);
    app.progress({sequence, message: `調査結果 ${sequence} 件目を確認しました。`});
  }
  app.finish(); await pending;
  const entries = timeline(app);
  assert.equal(entries.filter(entry => entry.text.includes('調査結果')).length, 60);
  assert.equal(entries[0].start, 0);
  assert.match(entries[0].text, /設定を確認/);
  assert.equal(entries.at(-1).start, 6);
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 6.0 秒');
});

test('progress arriving after navigation cannot be attributed to a different page or resumed old task', async () => {
  const app = harness(); await flush();
  app.type('.bcr-instruction', '返信する');
  const pending = app.submit(); await flush();
  app.advance(500);
  app.navigate('/view/OTHER-1');
  app.progress({sequence: 1, message: '誤表示してはいけない'});
  assert.equal(app.control('.bcr-progress-list').children.length, 0);
  app.advance(2500);
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 0.0 秒');
  app.navigate('/view/TEST-12');
  assert.equal(app.control('.bcr-elapsed').textContent, '経過 3.0 秒');
  const before = app.control('.bcr-progress-list').children.length;
  app.progress({sequence: 2, message: '誤表示してはいけない'});
  assert.equal(app.control('.bcr-progress-list').children.length, before);
  app.finish(); await pending;
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 3.0 秒');
  assert.equal(timeline(app).at(-1).start, 3);
});

test('cancelled overwrite preserves the existing draft and accounts for confirmation separately from generation', async () => {
  const app = harness({confirmDelayMs: 2300});
  await flush();
  app.editor.value = '既存の下書き';
  app.type('.bcr-instruction', '修正を伝える');
  const pending = app.submit();
  await flush();
  app.progress({sequence: 1, message: 'AIの応答を待っています。'});
  app.advance(1700);
  app.finish({sources: [{title: '関連課題', url: 'https://example.backlog.com/view/RELATED-1'}]});
  await pending;
  assert.equal(app.editor.value, '既存の下書き');
  assert.equal(app.editorEvents.length, 0);
  assert.equal(descendants(app.control('.bcr-sources'), 'a').length, 1);
  assert.ok(app.control('.bcr-status').textContent.includes('キャンセル'));
  const entries = timeline(app);
  assert.equal(entries.find(entry => entry.text.includes('AIの応答')).duration, 1.7);
  assert.ok(entries.some(entry => entry.start === 1.7 && entry.duration === 2.3 && entry.text.includes('確認')));
  assert.equal(entries.at(-1).start, 4);
  assert.equal(entries.at(-1).duration, undefined);
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 4.0 秒');
  const completed = logs(app);
  app.advance(5000);
  assert.deepEqual(logs(app), completed);
});

test('navigating away and back during generation prevents insertion and source attribution to a new screen', async () => {
  const app = harness();
  await flush();
  app.type('.bcr-instruction', '修正を伝える');
  app.type('.bcr-mode', 'agent');
  const pending = app.submit();
  await flush();
  app.navigate('/view/OTHER-99');
  assert.ok(app.control('.bcr-generate').disabled);
  app.navigate('/view/TEST-12');
  app.finish({sources: [{title: '関連課題', url: 'https://example.backlog.com/view/RELATED-1'}]});
  await pending;
  assert.equal(app.editor.value, '');
  assert.ok(app.control('.bcr-status').textContent.includes('挿入しませんでした'));
  assert.equal(app.control('.bcr-sources').hidden, true);
  assert.ok(!app.control('.bcr-generate').disabled);
});

test('failed generation preserves inputs and enables controls for correction', async () => {
  const app = harness();
  await flush();
  app.type('.bcr-instruction', '修正を伝える');
  app.type('.bcr-references', 'TOO_MANY_REFERENCES');
  const pending = app.submit();
  await flush();
  app.advance(2300);
  app.finish({ok: false, error: '追加課題は5件までです。'});
  await pending;
  assert.equal(app.control('.bcr-references').value, 'TOO_MANY_REFERENCES');
  assert.equal(app.control('.bcr-instruction').value, '修正を伝える');
  assert.ok(app.control('.bcr-status').textContent.includes('5件まで'));
  assert.ok(app.root().querySelectorAll('.bcr-generate, textarea, select, input').every(control => !control.disabled));
  assert.equal(app.editorEvents.length, 0);
  assert.equal(app.control('.bcr-elapsed').textContent, '所要 2.3 秒');
  assert.equal(timeline(app).at(-1).start, 2.3);
  assert.equal(timeline(app).at(-1).duration, undefined);
  const failed = logs(app);
  app.advance(5000);
  assert.deepEqual(logs(app), failed);
});
