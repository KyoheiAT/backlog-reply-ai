(() => {
  if (window.top !== window) return;
  const ISSUE_PATH = /^\/view\/([A-Z0-9_]+-\d+)\/?$/i;
  const BACKLOG_HOST = /^[a-z0-9-]+\.(?:backlog\.com|backlog\.jp|backlogtool\.com)$/i;
  if (location.protocol !== 'https:' || location.port || !BACKLOG_HOST.test(location.hostname)) return;
  let lastPath = location.pathname;
  let navigationVersion = 0;
  let task = null;
  let panelCollapsed = true;
  let provider = 'copilot';
  let uiStatus = {path: lastPath, text: '', kind: ''};
  // Keep drafts only in this page's memory, including when Backlog remounts its editor.
  const drafts = new Map();
  const spaceOrigin = `https://${location.hostname}`;
  const providerLabel = value => value === 'codex' ? 'ChatGPT Business（Codex）' : 'GitHub Copilot';
  const editorSelectors = [
    'textarea[name="content"]', 'textarea[id*="comment"]', 'textarea[name*="comment"]',
    'textarea[placeholder*="コメント"]', 'textarea[placeholder*="comment"]',
    '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]'
  ];
  const issueKey = () => location.pathname.match(ISSUE_PATH)?.[1];
  // One monotonic clock for both the log and its total. OS clock adjustments
  // must not make a running step jump backwards or change a completed result.
  function taskElapsed(currentTask) {
    if (currentTask.finishedElapsedMs !== null) return currentTask.finishedElapsedMs;
    currentTask.elapsedMs = Math.max(currentTask.elapsedMs, performance.now() - currentTask.startedAt, 0);
    return currentTask.elapsedMs;
  }
  const tenths = milliseconds => Math.max(0, Math.floor(milliseconds / 100));
  const seconds = value => (value / 10).toFixed(1);
  function getDraft(path) {
    if (!drafts.has(path)) drafts.set(path, {instruction: '', mode: 'chat', references: '', includeCurrentProject: true, sources: [], sourcesOpen: false, progress: [], elapsedMs: 0, toolCalls: null, resultMode: 'chat'});
    return drafts.get(path);
  }
  function saveDraft(root, path) {
    const draft = getDraft(path);
    draft.instruction = root.querySelector('.bcr-instruction').value;
    draft.mode = root.querySelector('.bcr-mode').value === 'agent' ? 'agent' : 'chat';
    draft.references = root.querySelector('.bcr-references').value;
    draft.includeCurrentProject = root.querySelector('.bcr-include-project').checked;
    return draft;
  }
  function renderModeNote(root) {
    const agentMode = root.querySelector('.bcr-mode').value === 'agent';
    root.querySelector('.bcr-agent-options').hidden = !agentMode;
    root.querySelector('.bcr-mode-note').textContent = agentMode
      ? `${root.querySelector('.bcr-include-project').checked ? '現在のプロジェクトと指定範囲' : '現在の課題と明示的に指定した参照先だけ'}から、Backlog MCPで必要な情報を読み取り・検索します。課題の変更や投稿は行いません。`
      : '現在の課題と指定した課題・プロジェクトの情報をまとめて参照して、返信案を作成します。';
  }
  function safeSources(sources) {
    const seen = new Set();
    if (!Array.isArray(sources)) return [];
    return sources.slice(0, 60).flatMap(source => {
      if (!source || typeof source.url !== 'string') return [];
      try {
        const url = new URL(source.url);
        if (url.protocol !== 'https:' || url.origin !== spaceOrigin || url.username || url.password || url.search || url.hash
          || !/^\/(?:view\/[A-Z0-9_]+-\d+|projects\/[A-Z0-9_]+)\/?$/i.test(url.pathname) || seen.has(url.href)) return [];
        seen.add(url.href);
        return [{title: (typeof source.title === 'string' && source.title.trim() ? source.title.trim() : url.pathname).slice(0, 150), url: url.href}];
      } catch {return [];}
    }).slice(0, 50);
  }
  function renderSources(root) {
    const draft = getDraft(location.pathname);
    const container = root.querySelector('.bcr-sources');
    if (root.bcrRenderedSources === draft.sources) return;
    root.bcrRenderedSources = draft.sources;
    container.replaceChildren();
    container.hidden = draft.sources.length === 0;
    container.open = draft.sourcesOpen;
    if (container.hidden) return;
    const title = document.createElement('summary');
    title.className = 'bcr-sources-title';
    title.textContent = `参照した情報 ${draft.sources.length} 件${draft.resultMode === 'agent' && Number.isInteger(draft.toolCalls) ? `（調査 ${draft.toolCalls} 回）` : ''}`;
    const list = document.createElement('ul');
    for (const source of draft.sources) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.title;
      item.appendChild(link);
      list.appendChild(item);
    }
    container.appendChild(title);
    container.appendChild(list);
  }
  function renderElapsed(root = document.getElementById('bcr-root')) {
    if (!root) return;
    const draft = getDraft(location.pathname);
    const currentTask = task?.path === location.pathname ? task : null;
    const running = currentTask && currentTask.finishedElapsedMs === null;
    const milliseconds = currentTask ? taskElapsed(currentTask) : draft.elapsedMs;
    const elapsed = root.querySelector('.bcr-elapsed');
    const text = `${running ? '経過' : '所要'} ${seconds(tenths(milliseconds))} 秒`;
    if (elapsed.textContent !== text) elapsed.textContent = text;
    const rows = root.querySelector('.bcr-progress-list').children;
    for (let index = 0; index < draft.progress.length; index++) {
      const entry = draft.progress[index];
      const next = draft.progress[index + 1];
      const row = rows[index];
      if (!row) continue;
      const start = tenths(entry.elapsedMs);
      // Use the same displayed endpoints so all intervals add up to the total.
      const duration = Math.max(0, tenths(next ? next.elapsedMs : milliseconds) - start);
      const active = !entry.terminal && !next && running;
      const label = `+${seconds(start)}秒${entry.terminal ? '' : `（${active ? '継続' : '所要'} ${seconds(duration)}秒）`}：${entry.message}`;
      if (row.textContent !== label) row.textContent = label;
      row.className = active ? 'bcr-progress-current' : '';
    }
  }
  function renderProgress(root) {
    const draft = getDraft(location.pathname);
    root.querySelector('.bcr-progress').hidden = draft.progress.length === 0;
    if (root.bcrRenderedProgress !== draft.progress) {
      root.bcrRenderedProgress = draft.progress;
      const list = root.querySelector('.bcr-progress-list');
      const previousTop = list.scrollTop;
      const followLatest = list.scrollHeight - list.clientHeight - previousTop <= 24;
      list.replaceChildren();
      for (const entry of draft.progress) {
        const item = document.createElement('li');
        item.textContent = entry.message;
        list.appendChild(item);
      }
      renderElapsed(root);
      list.scrollTop = followLatest ? list.scrollHeight : previousTop;
    }
    renderElapsed(root);
  }
  function findEditor() {
    const matches = editorSelectors.flatMap(selector => [...document.querySelectorAll(selector)]);
    return matches.find(el => el.isConnected && !el.closest('#bcr-root') && el.getClientRects().length > 0) || null;
  }
  function setEditorValue(editor, value) {
    value = String(value).replace(/\r\n?/g, '\n');
    if (editor.matches('textarea,input')) {
      const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) throw new Error('入力欄を更新できません。');
      setter.call(editor, value);
      editor.dispatchEvent(new Event('input', {bubbles: true}));
      editor.dispatchEvent(new Event('change', {bubbles: true}));
    } else if (editor.isContentEditable) {
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      let handledPaste = false;
      try {
        // Rich-text editors keep their own paragraph model. Let their paste
        // handler import plain text instead of overwriting only their DOM.
        // This creates event data locally; it never reads/writes the OS clipboard.
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', value);
        handledPaste = !editor.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData, bubbles: true, cancelable: true, composed: true
        }));
      } catch (_) { /* Older or restricted editors can use the fallback below. */ }
      // preventDefault means the editor consumed the paste, possibly with an
      // asynchronous render. Do not replace its DOM while that update is pending.
      if (!handledPaste) {
        let inserted = false;
        try { inserted = document.execCommand('insertText', false, value); } catch (_) {}
        if (!inserted || editor.innerText.replace(/\r\n?/g, '\n').trim() !== value.trim()) {
          editor.replaceChildren();
          value.split('\n').forEach((line, index) => {
            if (index > 0) editor.appendChild(document.createElement('br'));
            if (line) editor.appendChild(document.createTextNode(line));
          });
          editor.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: value}));
        }
      }
    } else throw new Error('対応していない入力欄です。');
    editor.focus();
  }
  function renderState() {
    const root = document.getElementById('bcr-root');
    if (!root) return;
    root.querySelector('.bcr-provider').textContent = providerLabel(provider);
    for (const control of root.querySelectorAll('.bcr-generate, textarea, select, input')) control.disabled = !!task;
    renderModeNote(root);
    renderSources(root);
    renderProgress(root);
    const status = root.querySelector('.bcr-status');
    if (task && task.path !== location.pathname) {
      status.textContent = '別の課題で生成処理中です。完了までお待ちください。';
      status.className = 'bcr-status';
    } else if (uiStatus.path === location.pathname) {
      status.textContent = uiStatus.text;
      status.className = `bcr-status${uiStatus.kind ? ` bcr-${uiStatus.kind}` : ''}`;
    } else {
      status.textContent = ''; status.className = 'bcr-status';
    }
    // Keep the toggle usable while generating, without unmounting form fields.
    root.className = panelCollapsed ? 'bcr-collapsed' : '';
    root.querySelector('.bcr-body').hidden = panelCollapsed;
    root.querySelector('.bcr-heading').hidden = panelCollapsed;
    const toggle = root.querySelector('.bcr-toggle');
    const currentStatus = uiStatus.path === location.pathname;
    const compactStatus = task ? '生成中…' : currentStatus && uiStatus.kind === 'error' ? '要確認' : currentStatus && uiStatus.kind === 'ok' ? '完了' : '';
    toggle.textContent = panelCollapsed ? `AI返信${compactStatus ? ` · ${compactStatus}` : ''}` : '折りたたむ';
    toggle.setAttribute('aria-expanded', String(!panelCollapsed));
    toggle.setAttribute('aria-label', `AI返信アシスタントを${panelCollapsed ? '開く' : '折りたたむ'}${compactStatus ? `（${compactStatus}）` : ''}`);
    toggle.title = panelCollapsed && status.textContent ? status.textContent : panelCollapsed ? 'AI返信アシスタントを開く' : 'AI返信アシスタントを折りたたむ';
    const compactNotice = root.querySelector('.bcr-compact-status');
    if (compactNotice.textContent !== (panelCollapsed ? compactStatus : '')) compactNotice.textContent = panelCollapsed ? compactStatus : '';
  }
  function setStatus(path, text, kind = '', terminal = false) {
    uiStatus = {path, text, kind};
    if (task?.path === path && task.finishedElapsedMs === null) {
      const draft = getDraft(path);
      const message = String(text).slice(0, 300);
      const elapsedMs = draft.progress.length ? taskElapsed(task) : 0;
      if (terminal) {
        task.finishedElapsedMs = elapsedMs;
        draft.elapsedMs = elapsedMs;
      }
      // Keep the start of the timeline: dropping early intervals would make
      // the visible durations fail to account for the total elapsed time.
      if (terminal || draft.progress.at(-1)?.message !== message) draft.progress = [...draft.progress, {elapsedMs, message, terminal}];
    }
    renderState();
  }
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'GENERATION_PROGRESS' || !task
      || task.finishedElapsedMs !== null || task.responseReceived
      || message.requestId !== task.requestId || message.issueKey !== task.issueKey
      || location.pathname !== task.path || task.version !== navigationVersion
      || !Number.isInteger(message.sequence) || message.sequence <= task.progressSequence
      || typeof message.message !== 'string' || !message.message || message.message.length > 300) return;
    task.progressSequence = message.sequence;
    setStatus(task.path, message.message);
  });
  async function refreshSettings() {
    const result = await chrome.runtime.sendMessage({type: 'GET_SETTINGS'});
    if (!result?.ok) throw new Error(result?.error || '拡張機能の設定を読み込めませんでした。');
    provider = result.provider;
    renderState();
    return result;
  }
  function checkNavigation() {
    if (location.pathname !== lastPath) {
      const previousRoot = document.getElementById('bcr-root');
      if (previousRoot) saveDraft(previousRoot, lastPath);
      lastPath = location.pathname;
      navigationVersion++;
      document.getElementById('bcr-root')?.remove();
      if (task) uiStatus = {path: task.path, text: '生成中に課題が切り替わったため、生成文は挿入しません。', kind: 'error'};
    }
  }
  function mount() {
    checkNavigation();
    if (!issueKey()) {document.getElementById('bcr-root')?.remove(); return;}
    const editor = findEditor();
    if (!editor || document.getElementById('bcr-root')) return;
    const root = document.createElement('section');
    root.id = 'bcr-root';
    root.className = 'bcr-collapsed';
    root.innerHTML = `
      <div class="bcr-header">
        <div class="bcr-heading bcr-title" hidden>AI返信アシスタント <span class="bcr-provider"></span></div>
        <button class="bcr-toggle" type="button" aria-expanded="false" aria-controls="bcr-body" aria-label="AI返信アシスタントを開く">AI返信</button>
        <span class="bcr-compact-status bcr-visually-hidden" role="status" aria-live="polite"></span>
      </div>
      <div id="bcr-body" class="bcr-body" hidden>
      <p class="bcr-note">課題本文・コメント・指定した情報と入力した指示を、表示中のAIへ送信して返信案を作成します。</p>
      <fieldset class="bcr-fields">
        <legend class="bcr-visually-hidden">返信案の作成条件</legend>
        <label class="bcr-label" for="bcr-mode">作成モード</label>
        <select id="bcr-mode" class="bcr-mode" aria-describedby="bcr-mode-note">
          <option value="chat">通常の返信作成</option>
          <option value="agent">エージェント（Backlog MCPで調査）</option>
        </select>
        <p id="bcr-mode-note" class="bcr-note bcr-mode-note"></p>
        <div class="bcr-agent-options" hidden>
          <label class="bcr-checkbox" for="bcr-include-project"><input id="bcr-include-project" class="bcr-include-project" type="checkbox" checked aria-describedby="bcr-scope-note">同じプロジェクト内の他課題も調査する</label>
          <p id="bcr-scope-note" class="bcr-note">オフの場合は現在の課題と追加で指定した参照先だけが対象です。参照欄に指定したプロジェクトは、オフでも調査します。</p>
        </div>
        <label class="bcr-label" for="bcr-instruction">今回伝えたい内容</label>
        <textarea id="bcr-instruction" class="bcr-instruction" maxlength="10000" placeholder="例：修正が完了したので、関連課題の状況も踏まえて確認をお願いしたい"></textarea>
        <label class="bcr-label" for="bcr-references">追加で参照する課題・プロジェクト（任意）</label>
        <textarea id="bcr-references" class="bcr-references" aria-describedby="bcr-references-note" maxlength="2000" placeholder="例：PROJECT-123, OTHER_PROJECT&#10;課題URLやプロジェクトURLも指定できます"></textarea>
        <p id="bcr-references-note" class="bcr-note">同じBacklogスペース内の課題キー・プロジェクトキー、またはURLを空白・改行・カンマで区切って指定します。追加は課題5件・プロジェクト3件まで。</p>
      </fieldset>
      <div class="bcr-actions"><span class="bcr-status" role="status" aria-live="polite"></span><button class="bcr-generate" type="button">AIで返信文を生成</button></div>
      <section class="bcr-progress" aria-label="作業ログ" hidden>
        <div class="bcr-progress-heading">作業ログ <span class="bcr-elapsed"></span></div>
        <p class="bcr-progress-note">「+」は生成開始からの経過、所要は次のログまでの時間です。</p>
        <ol class="bcr-progress-list"></ol>
      </section>
      <details class="bcr-sources" aria-label="直近の生成で参照した情報" hidden></details>
      </div>`;
    editor.parentElement?.insertBefore(root, editor);
    const mountedPath = location.pathname;
    const draft = getDraft(mountedPath);
    root.querySelector('.bcr-instruction').value = draft.instruction;
    root.querySelector('.bcr-mode').value = draft.mode;
    root.querySelector('.bcr-references').value = draft.references;
    root.querySelector('.bcr-include-project').checked = draft.includeCurrentProject;
    for (const selector of ['.bcr-instruction', '.bcr-references']) root.querySelector(selector).addEventListener('input', () => {saveDraft(root, mountedPath);});
    root.querySelector('.bcr-mode').addEventListener('change', () => {saveDraft(root, mountedPath); renderModeNote(root);});
    root.querySelector('.bcr-include-project').addEventListener('change', () => {saveDraft(root, mountedPath); renderModeNote(root);});
    root.querySelector('.bcr-sources').addEventListener('toggle', event => {getDraft(mountedPath).sourcesOpen = event.currentTarget.open;});
    root.querySelector('.bcr-toggle').addEventListener('click', () => {
      panelCollapsed = !panelCollapsed;
      renderState();
    });
    renderState();
    refreshSettings().catch(error => {if (root.isConnected && !task) setStatus(mountedPath, error.message, 'error');});
    root.querySelector('.bcr-generate').addEventListener('click', async () => {
      if (task) return;
      const draft = saveDraft(root, mountedPath);
      const instruction = draft.instruction.trim();
      if (!instruction) {setStatus(location.pathname, '伝えたい内容を入力してください。', 'error'); return;}
      checkNavigation();
      if (mountedPath !== location.pathname) {setStatus(location.pathname, '課題が切り替わりました。表示中の課題で生成してください。', 'error'); return;}
      const currentTask = {path: location.pathname, issueKey: issueKey(), version: navigationVersion, mode: draft.mode, references: draft.references.trim(), includeCurrentProject: draft.includeCurrentProject,
        requestId: crypto.randomUUID(), progressSequence: 0, startedAt: performance.now(), elapsedMs: 0, finishedElapsedMs: null, responseReceived: false};
      draft.sources = [];
      draft.sourcesOpen = false;
      draft.progress = [];
      draft.elapsedMs = 0;
      draft.toolCalls = null;
      task = currentTask;
      setStatus(currentTask.path, '設定を確認しています…');
      try {
        const settings = await refreshSettings();
        checkNavigation();
        if (currentTask.version !== navigationVersion) throw new Error('課題が切り替わりました。もう一度生成してください。');
        setStatus(currentTask.path, currentTask.mode === 'agent'
          ? `${providerLabel(settings.provider)}に調査・生成処理を依頼しています…`
          : `${providerLabel(settings.provider)}に生成処理を依頼しています…`);
        const result = await chrome.runtime.sendMessage({type: 'GENERATE_REPLY', instruction, issueKey: currentTask.issueKey, provider: settings.provider, mode: currentTask.mode, references: currentTask.references, includeCurrentProject: currentTask.includeCurrentProject, requestId: currentTask.requestId});
        currentTask.responseReceived = true;
        if (!result?.ok) throw new Error(result?.error || '生成に失敗しました。');
        checkNavigation();
        if (currentTask.version !== navigationVersion || location.pathname !== currentTask.path || result.issueKey !== currentTask.issueKey) throw new Error('生成中に課題が切り替わったため、生成文は挿入しませんでした。');
        draft.sources = safeSources(result.sources);
        draft.resultMode = result.mode === 'agent' ? 'agent' : currentTask.mode;
        draft.toolCalls = Number.isInteger(result.toolCalls) && result.toolCalls >= 0 ? result.toolCalls : null;
        setStatus(currentTask.path, '生成文を受け取りました。コメント入力欄への反映を準備しています。');
        const target = findEditor();
        if (!target) throw new Error('コメント入力欄が見つかりません。');
        if ((target.value || target.textContent || '').trim()) {
          setStatus(currentTask.path, '既存コメントの置き換えを確認しています。確認ダイアログの操作を待っています。');
          if (!confirm('既存のコメント入力内容を生成文で置き換えますか？')) {
            setStatus(currentTask.path, '挿入をキャンセルしました。', '', true); return;
          }
          setStatus(currentTask.path, '生成文をコメント入力欄に反映しています。');
        }
        setEditorValue(target, result.text);
        setStatus(currentTask.path, `${providerLabel(result.provider)}の生成文を挿入しました（参照コメント ${result.commentsUsed} 件）。確認して手動で投稿してください。`, 'ok', true);
      } catch (error) {
        setStatus(currentTask.path, error.message || String(error), 'error', true);
      } finally {
        draft.elapsedMs = taskElapsed(currentTask);
        task = null;
        renderState(); // Also resets a panel remounted while the request was running.
      }
    });
  }
  const observer = new MutationObserver(() => {checkNavigation(); if (issueKey() && !document.getElementById('bcr-root')) mount();});
  observer.observe(document.documentElement, {childList: true, subtree: true});
  window.addEventListener('popstate', mount);
  mount();
  setInterval(mount, 1000);
  setInterval(() => {if (task) renderElapsed();}, 100);
})();
