(() => {
  if (window.top !== window) return;
  const ISSUE_PATH = /^\/view\/([A-Z0-9_]+-\d+)\/?$/i;
  const BACKLOG_HOST = /^[a-z0-9-]+\.(?:backlog\.com|backlog\.jp|backlogtool\.com)$/i;
  if (location.protocol !== 'https:' || location.port || !BACKLOG_HOST.test(location.hostname)) return;
  const previousRoot = document.getElementById('bcr-root');
  const restored = previousRoot ? {
    instruction: previousRoot.bcrPendingInstruction ?? previousRoot.querySelector('.bcr-instruction')?.value ?? '',
    references: previousRoot.querySelector('.bcr-references')?.value || '',
    mode: previousRoot.querySelector('.bcr-mode')?.value === 'agent' ? 'agent' : 'chat',
    includeCurrentProject: previousRoot.querySelector('.bcr-include-project')?.checked !== false,
    interactive: previousRoot.querySelector('.bcr-interactive')?.checked === true,
    collapsed: previousRoot.classList.contains('bcr-collapsed')
  } : null;
  // A recovery injection replaces only this extension's UI/listeners. Preserve
  // unfinished instructions and leave Backlog's comment draft untouched.
  document.dispatchEvent(new Event('backlog-ai-dispose'));
  previousRoot?.remove();
  let disposed = false;
  let panelLayout = null;
  let mountedEditor = null;
  let observer;
  const intervals = [];
  let settingsPending = null;
  let connectionFailed = false;
  let lastReconnectAt = -Infinity;
  let lastPath = location.pathname;
  let navigationVersion = 0;
  let task = null;
  let pendingComment = null;
  let panelCollapsed = restored ? restored.collapsed : true;
  let provider = 'copilot';
  let uiStatus = {path: lastPath, text: '', kind: ''};
  // Keep drafts only in this page's memory, including when Backlog remounts its editor.
  // Recovery reinjection replaces this script but can reuse the page-local draft
  // state attached to our own panel, including conversations for other issues.
  const drafts = previousRoot?.bcrDrafts instanceof Map ? previousRoot.bcrDrafts : new Map();
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
    if (!drafts.has(path)) drafts.set(path, {instruction: '', mode: 'chat', references: '', includeCurrentProject: true, interactive: false, messages: [], userInputs: [], conversationScope: null, candidate: '', candidateVisible: false, sentCandidate: '', candidateActivity: null, failedActivity: null, sources: [], sourcesOpen: false, progress: [], elapsedMs: 0, toolCalls: null, resultMode: 'chat'});
    return drafts.get(path);
  }
  if (restored) Object.assign(getDraft(lastPath), restored);
  function saveDraft(root, path) {
    const draft = getDraft(path);
    if (!(task?.path === path && task.phase === 'discuss')) draft.instruction = root.querySelector('.bcr-instruction').value;
    draft.mode = root.querySelector('.bcr-mode').value === 'agent' ? 'agent' : 'chat';
    draft.references = root.querySelector('.bcr-references').value;
    draft.includeCurrentProject = root.querySelector('.bcr-include-project').checked;
    draft.interactive = root.querySelector('.bcr-interactive').checked;
    return draft;
  }
  function renderModeNote(root) {
    const agentMode = root.querySelector('.bcr-mode').value === 'agent';
    root.querySelector('.bcr-agent-options').hidden = !agentMode;
    const interactive = agentMode && root.querySelector('.bcr-interactive').checked;
    root.querySelector('.bcr-dialogue').hidden = !interactive;
    root.querySelector('.bcr-dialogue-controls').hidden = !interactive;
    root.querySelector('.bcr-chat-hint').hidden = !interactive;
    root.querySelector('.bcr-scope-settings').hidden = !agentMode;
    root.classList.toggle('bcr-chat-mode', interactive);
    if (root.bcrWasInteractive !== interactive) {
      root.querySelector('.bcr-reference-settings').open = !interactive;
      root.bcrWasInteractive = interactive;
    }
    root.querySelector('.bcr-instruction-label').textContent = interactive ? 'メッセージ' : '今回伝えたい内容';
    root.querySelector('.bcr-instruction').placeholder = interactive ? '相談したいことや返信で伝えたいことを入力' : '例：修正が完了したので、関連課題の状況も踏まえて確認をお願いしたい';
    root.querySelector('.bcr-generate').textContent = interactive ? (task ? '応答中…' : '送信') : 'AIで返信文を生成';
    root.querySelector('.bcr-mode-note').textContent = agentMode
      ? `${root.querySelector('.bcr-include-project').checked ? '現在のプロジェクトと指定範囲' : '現在の課題と明示的に指定した参照先だけ'}から、Backlog MCPで必要な情報を読み取り・検索します。課題の変更や投稿は行いません。`
      : '現在の課題と指定した課題・プロジェクトの情報をまとめて参照して、返信案を作成します。';
  }
  function progressText(entry, next, milliseconds, running) {
    const start = tenths(entry.elapsedMs);
    const duration = Math.max(0, tenths(next ? next.elapsedMs : milliseconds) - start);
    const active = !entry.terminal && !next && running;
    return {active, label: `+${seconds(start)}秒${entry.terminal ? '' : `（${active ? '継続' : '所要'} ${seconds(duration)}秒）`}：${entry.message}`};
  }
  function updateActivityElapsed(details, milliseconds, running) {
    const activity = details.bcrActivity;
    const summary = details.children[0];
    summary.textContent = running ? `作業中…（経過 ${seconds(tenths(milliseconds))}秒）`
      : activity.failed ? `作業ログ（失敗・${seconds(tenths(milliseconds))}秒）` : `作業ログ（${seconds(tenths(milliseconds))}秒）`;
    const rows = details.children[1].children;
    for (let index = 0; index < activity.entries.length; index++) {
      const row = rows[index];
      if (!row) continue;
      const {label, active} = progressText(activity.entries[index], activity.entries[index + 1], milliseconds, running);
      if (row.textContent !== label) row.textContent = label;
      row.className = active ? 'bcr-progress-current' : '';
    }
  }
  function activityView(activity, running = false) {
    const details = document.createElement('details');
    details.className = 'bcr-chat-activity';
    details.bcrActivity = activity;
    details.open = running ? activity.open !== false : activity.open === true;
    const summary = document.createElement('summary');
    const list = document.createElement('ol');
    for (const entry of activity.entries) list.appendChild(document.createElement('li'));
    details.appendChild(summary);
    details.appendChild(list);
    updateActivityElapsed(details, running && task?.activity === activity ? taskElapsed(task) : activity.elapsedMs, running);
    details.addEventListener('toggle', () => {activity.open = details.open;});
    return details;
  }
  function renderDialogue(root) {
    const draft = getDraft(location.pathname);
    const list = root.querySelector('.bcr-dialogue-list');
    const pendingMessage = task?.path === location.pathname && task.phase === 'discuss' && !task.responseReceived ? task.instruction : '';
    const activeDiscuss = task?.path === location.pathname && task.phase === 'discuss' && task.finishedElapsedMs === null;
    const activityVersion = activeDiscuss ? draft.progress : draft.failedActivity;
    if (root.bcrRenderedMessages !== draft.messages || root.bcrRenderedPending !== pendingMessage || root.bcrRenderedChatActivity !== activityVersion) {
      root.bcrRenderedChatActivity = activityVersion;
      const followLatest = !list.children.length || (pendingMessage && root.bcrRenderedPending !== pendingMessage) || list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      root.bcrRenderedMessages = draft.messages;
      root.bcrRenderedPending = pendingMessage;
      for (const row of list.children) {
        const details = row.bcrActivityDetails;
        if (details?.bcrActivity) details.bcrActivity.open = details.open;
      }
      list.replaceChildren();
      for (const message of [...draft.messages, ...(pendingMessage ? [{role: 'user', text: pendingMessage}] : [])]) {
        const item = document.createElement('li');
        item.className = `bcr-message bcr-message-${message.role}`;
        const heading = document.createElement('strong');
        heading.textContent = message.role === 'user' ? 'あなた' : 'AI';
        const body = document.createElement('div');
        body.className = 'bcr-message-body';
        if (message.role === 'assistant' && globalThis.BacklogChatMarkdown) {
          globalThis.BacklogChatMarkdown.render(body, message.text);
        } else {
          body.textContent = message.text;
        }
        if (message.role === 'assistant' && message.activity) {
          item.bcrActivityDetails = activityView(message.activity);
          item.appendChild(item.bcrActivityDetails);
        }
        item.appendChild(heading);
        item.appendChild(body);
        list.appendChild(item);
      }
      if ((activeDiscuss && draft.progress.length) || draft.failedActivity?.phase === 'discuss') {
        const row = document.createElement('li');
        row.className = 'bcr-activity-row';
        if (activeDiscuss) {
          task.activity.entries = draft.progress;
          row.bcrActivityDetails = activityView(task.activity, true);
        } else row.bcrActivityDetails = activityView(draft.failedActivity);
        row.appendChild(row.bcrActivityDetails);
        list.appendChild(row);
      }
      if (followLatest) list.scrollTop = list.scrollHeight;
    }
    root.querySelector('.bcr-empty-dialogue').hidden = draft.messages.length > 0 || !!pendingMessage;
    const draftLog = root.querySelector('.bcr-draft-log');
    const activeDraft = task?.path === location.pathname && task.phase === 'draft' && task.finishedElapsedMs === null;
    const draftActivity = activeDraft ? task.activity : draft.failedActivity?.phase === 'draft' ? draft.failedActivity : draft.candidateActivity;
    const draftVersion = activeDraft ? draft.progress : draftActivity;
    if (root.bcrRenderedDraftActivity !== draftVersion) {
      root.bcrRenderedDraftActivity = draftVersion;
      const existing = draftLog.children[0];
      if (existing?.bcrActivity) existing.bcrActivity.open = existing.open;
      draftLog.replaceChildren();
      if (draftActivity) {
        if (activeDraft) draftActivity.entries = draft.progress;
        draftLog.appendChild(activityView(draftActivity, activeDraft));
      }
    }
    draftLog.hidden = !draftActivity;
    root.querySelector('.bcr-candidate-wrap').hidden = !draft.candidateVisible;
    const candidate = root.querySelector('.bcr-candidate');
    if (candidate.value !== draft.candidate) candidate.value = draft.candidate;
    root.querySelector('.bcr-create-draft').disabled = !!task || !draft.messages.length;
    root.querySelector('.bcr-insert-draft').disabled = !!task || !draft.candidate.trim();
    root.querySelector('.bcr-clear-dialogue').disabled = !!task || !draft.messages.length && !draft.candidate;
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
      // Use the same displayed endpoints so all intervals add up to the total.
      const {label, active} = progressText(entry, next, milliseconds, running);
      if (row.textContent !== label) row.textContent = label;
      row.className = active ? 'bcr-progress-current' : '';
    }
    if (running && currentTask.activity) {
      const container = currentTask.phase === 'discuss' ? root.querySelector('.bcr-dialogue-list') : root.querySelector('.bcr-draft-log');
      const details = currentTask.phase === 'discuss'
        ? [...container.children].map(row => row.bcrActivityDetails).find(view => view?.bcrActivity === currentTask.activity)
        : container.children[0];
      if (details?.bcrActivity === currentTask.activity) updateActivityElapsed(details, milliseconds, true);
    }
  }
  function renderProgress(root) {
    const draft = getDraft(location.pathname);
    root.querySelector('.bcr-progress').hidden = draft.progress.length === 0 || (draft.mode === 'agent' && draft.interactive);
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
  function editorText(editor) {
    return String(editor.matches('textarea,input') ? editor.value : editor.innerText).replace(/\r\n?/g, '\n');
  }
  // Backlog posts comments itself. Wait for its editor to clear after a submit
  // rather than collapsing on the click, which could fail validation or posting.
  function watchCommentSubmit(event) {
    const editor = findEditor();
    const form = editor?.closest('form');
    if (!form || !editorText(editor).trim()) return;
    if (event.type === 'submit' && event.target !== form) return;
    const button = event.type === 'submit' ? event.submitter : event.target?.closest?.('button, input[type="submit"]');
    if (!button || !form.contains(button)) return;
    const label = (button.textContent || button.value || button.getAttribute('aria-label') || '').trim();
    if (!/^(?:コメントを?)?(?:登録|投稿|追加)(?:する)?$/.test(label)) {
      // A toolbar click while posting must not cancel the pending operation.
      // A preview submission is a distinct form action, however, so its later
      // editor changes cannot be treated as confirmation of the earlier post.
      if (event.type === 'submit' && /プレビュー|preview/i.test(label)) pendingComment = null;
      return;
    }
    pendingComment = {path: location.pathname, editor, startedAt: performance.now()};
  }
  function checkCommentPosted() {
    if (!pendingComment) return;
    const pending = pendingComment;
    if (location.pathname !== pending.path || performance.now() - pending.startedAt > 30000) {
      pendingComment = null;
      return;
    }
    const editor = findEditor();
    // An editor replacement can be a failed post or an unrelated UI change.
    // Only a clear of the editor that was submitted is evidence of completion.
    if (!pending.editor.isConnected || (editor && editor !== pending.editor)) {
      pendingComment = null;
      return;
    }
    if (editor === pending.editor && !editorText(editor).trim()) {
      pendingComment = null;
      panelCollapsed = true;
      renderState();
    }
  }
  function cancelCommentWatchOnInput(event) {
    if (pendingComment && event.isTrusted && event.target === pendingComment.editor) pendingComment = null;
  }
  function comparableEditorText(value) {
    // Paragraph-based editors can add blank lines and non-breaking spaces to
    // innerText. Ignore those rendering differences, but still require every
    // line of the generated text (and no remaining draft) to be present.
    return value.replace(/\u00a0/g, ' ').replace(/\n+/g, '\n').trim();
  }
  // Issue text can try to make the model add links or image beacons. Hosts that
  // are neither in the user's own instruction nor this space need confirmation.
  function unexpectedHosts(text, instruction) {
    const hosts = value => [...String(value).matchAll(/(?:https?:|[(<"'=]\s*)\/\/([^\s\/?#<>"'()[\]{}|\\^`]+)/gi)].map(([, raw]) => {
      // Japanese text often follows a URL directly; keep only its ASCII authority.
      const authority = (raw.match(/^[\x21-\x7e]+/)?.[0] || raw).replace(/[^\p{L}\p{N}]+$/u, '');
      try {return new URL(`https://${authority}`).hostname;} catch {return '解析できないURL';}
    });
    const trusted = new Set([location.hostname.toLowerCase(), ...hosts(instruction)]);
    return [...new Set(hosts(text))].filter(host => !trusted.has(host));
  }
  async function setEditorValue(editor, value, assertCurrent) {
    value = String(value).replace(/\r\n?/g, '\n');
    assertCurrent();
    if (editor.matches('textarea,input')) {
      const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) throw new Error('入力欄を更新できません。');
      setter.call(editor, value);
      editor.dispatchEvent(new Event('input', {bubbles: true}));
      editor.dispatchEvent(new Event('change', {bubbles: true}));
    } else if (editor.isContentEditable) {
      editor.focus();
      const originalText = editorText(editor);
      const selection = window.getSelection();
      if (!selection) throw new Error('コメント入力欄の選択範囲を取得できません。');
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      const selectedText = selection.toString();
      // The DOM selection changes immediately, but controlled editors update
      // their model selection from a queued (sometimes debounced) selectionchange.
      // Pasting in the same task uses the old caret and appends to the draft.
      await new Promise(resolve => setTimeout(resolve, 150));
      assertCurrent();
      if (editorText(editor) !== originalText || document.activeElement !== editor ||
          selection.rangeCount !== 1 || !editor.contains(selection.anchorNode) ||
          !editor.contains(selection.focusNode) || selection.toString() !== selectedText) {
        throw new Error('反映の準備中にコメント入力欄や選択範囲が変更されたため、挿入を中止しました。もう一度生成してください。');
      }
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
      // preventDefault only means the editor accepted the event. Its model may
      // render asynchronously; verify the result below before reporting success.
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
      const expected = comparableEditorText(value);
      let matchingChecks = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        assertCurrent();
        matchingChecks = comparableEditorText(editorText(editor)) === expected ? matchingChecks + 1 : 0;
        if (matchingChecks === 2) return;
      }
      // Never retry a consumed paste or overwrite a controlled editor's DOM:
      // either can duplicate the reply or disagree with its internal model.
      throw new Error('生成文への置き換えを確認できませんでした。コメント入力欄に元の文が残っていないか確認してください。');
    } else throw new Error('対応していない入力欄です。');
    editor.focus();
  }
  function renderState() {
    if (disposed) return;
    const root = document.getElementById('bcr-root');
    if (!root) return;
    root.querySelector('.bcr-provider').textContent = providerLabel(provider);
    for (const control of root.querySelectorAll('.bcr-generate, textarea, select, input')) control.disabled = !!task;
    renderModeNote(root);
    renderDialogue(root);
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
    root.classList.toggle('bcr-collapsed', panelCollapsed);
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
    panelLayout?.update();
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
  async function insertReply(currentTask, result, instruction) {
    setStatus(currentTask.path, '生成文を受け取りました。コメント入力欄への反映を準備しています。');
    const hosts = unexpectedHosts(result.text, instruction);
    if (hosts.length) {
      setStatus(currentTask.path, '生成文に外部URLが含まれています。確認ダイアログの操作を待っています。');
      if (!confirm(`生成文に、今回の入力にも現在のBacklogスペースにもないURL（${hosts.slice(0, 3).join('、')}${hosts.length > 3 ? ' ほか' : ''}）が含まれています。課題やコメント内の指示で混入した可能性があります。\nリンクや画像の宛先を確認したうえで、コメント入力欄に反映しますか？`)) {
        setStatus(currentTask.path, '外部URLを含むため、生成文の挿入をキャンセルしました。', '', true); return;
      }
    }
    const target = findEditor();
    if (!target) throw new Error('コメント入力欄が見つかりません。');
    if ((target.value || target.textContent || '').trim()) {
      setStatus(currentTask.path, '既存コメントの置き換えを確認しています。確認ダイアログの操作を待っています。');
      if (!confirm('既存のコメント入力内容を生成文で置き換えますか？')) {
        setStatus(currentTask.path, '挿入をキャンセルしました。', '', true); return;
      }
      setStatus(currentTask.path, '生成文をコメント入力欄に反映しています。');
    }
    const assertCurrentEditor = () => {
      checkNavigation();
      if (disposed || currentTask.version !== navigationVersion || location.pathname !== currentTask.path) throw new Error('課題の表示が変わったため、生成文の挿入を中止しました。');
      if (!target.isConnected || findEditor() !== target) throw new Error('コメント入力欄が切り替わったため、生成文の挿入を中止しました。');
    };
    await setEditorValue(target, result.text, assertCurrentEditor);
    assertCurrentEditor();
    setStatus(currentTask.path, `${providerLabel(result.provider)}の生成文を挿入しました（参照コメント ${result.commentsUsed} 件）。${hosts.length ? '外部URLの宛先も含めて' : ''}確認して手動で投稿してください。`, 'ok', true);
  }
  const onMessage = (message, sender, sendResponse) => {
    if (disposed) return;
    if (message?.type === 'BACKLOG_AI_PING' && chrome.runtime.id && sender.id === chrome.runtime.id) {
      sendResponse({ok: true, version: 1});
      return;
    }
    if (sender.id !== chrome.runtime.id || message?.type !== 'GENERATION_PROGRESS' || !task
      || task.finishedElapsedMs !== null || task.responseReceived
      || message.requestId !== task.requestId || message.issueKey !== task.issueKey
      || location.pathname !== task.path || task.version !== navigationVersion
      || !Number.isInteger(message.sequence) || message.sequence <= task.progressSequence
      || typeof message.message !== 'string' || !message.message || message.message.length > 300) return;
    task.progressSequence = message.sequence;
    setStatus(task.path, message.message);
  };
  chrome.runtime.onMessage.addListener(onMessage);
  const isConnectionError = error => /Receiving end does not exist|Could not establish connection|Extension context invalidated|message port closed|message channel closed/i.test(error?.message || String(error));
  const connectionMessage = error => isConnectionError(error)
    ? '拡張機能との接続を確認できませんでした。タブを開き直しても続く場合は、このページを再読み込みしてください。'
    : error.message || String(error);
  async function refreshSettings() {
    if (settingsPending) return settingsPending;
    const operation = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await chrome.runtime.sendMessage({type: 'GET_SETTINGS'});
          if (!result?.ok) throw new Error(result?.error || '拡張機能の設定を読み込めませんでした。');
          if (disposed) return result;
          provider = result.provider;
          if (connectionFailed && !task) uiStatus = {path: location.pathname, text: '', kind: ''};
          connectionFailed = false;
          renderState();
          return result;
        } catch (error) {
          if (disposed) throw error;
          connectionFailed = isConnectionError(error);
          if (!connectionFailed || attempt >= 2 || /Extension context invalidated/i.test(error.message)) throw new Error(connectionMessage(error));
          // Only idempotent settings reads retry. Never repeat AI generation.
          await new Promise(resolve => setTimeout(resolve, attempt ? 500 : 150));
        }
      }
    })();
    settingsPending = operation;
    try {return await operation;} finally {if (settingsPending === operation) settingsPending = null;}
  }
  function reconnectOnReturn() {
    if (disposed || task || !issueKey() || document.visibilityState === 'hidden' || performance.now() - lastReconnectAt < 15000) return;
    lastReconnectAt = performance.now();
    void refreshSettings().catch(error => {if (!disposed && !task) setStatus(location.pathname, error.message, 'error');});
  }
  function removePanel() {
    panelLayout?.destroy();
    panelLayout = null;
    mountedEditor = null;
    document.getElementById('bcr-root')?.remove();
  }
  function checkNavigation() {
    if (location.pathname !== lastPath) {
      const previousRoot = document.getElementById('bcr-root');
      if (previousRoot) saveDraft(previousRoot, lastPath);
      lastPath = location.pathname;
      navigationVersion++;
      removePanel();
      if (task) uiStatus = {path: task.path, text: '生成中に課題が切り替わったため、生成文は挿入しません。', kind: 'error'};
    }
  }
  function mount() {
    if (disposed) return;
    checkNavigation();
    checkCommentPosted();
    if (!issueKey()) {removePanel(); return;}
    const editor = findEditor();
    if (!editor) {removePanel(); return;}
    const existingRoot = document.getElementById('bcr-root');
    if (existingRoot) {
      if (mountedEditor !== editor) {
        panelLayout?.destroy();
        editor.parentElement?.insertBefore(existingRoot, editor);
        panelLayout = BacklogPanelLayout.attach(existingRoot, editor);
        mountedEditor = editor;
      }
      panelLayout?.update();
      return;
    }
    panelLayout?.destroy();
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
          <label class="bcr-checkbox" for="bcr-interactive"><input id="bcr-interactive" class="bcr-interactive" type="checkbox">対話しながら返信を考える</label>
        </div>
        <details class="bcr-reference-settings" open>
          <summary>参照する情報の設定</summary>
          <div class="bcr-scope-settings" hidden>
            <label class="bcr-checkbox" for="bcr-include-project"><input id="bcr-include-project" class="bcr-include-project" type="checkbox" checked aria-describedby="bcr-scope-note">同じプロジェクト内の他課題も調査する</label>
            <p id="bcr-scope-note" class="bcr-note">オフの場合は現在の課題と追加で指定した参照先だけが対象です。参照欄に指定したプロジェクトは、オフでも調査します。</p>
          </div>
          <label class="bcr-label" for="bcr-references">追加で参照する課題・プロジェクト（任意）</label>
          <textarea id="bcr-references" class="bcr-references" aria-describedby="bcr-references-note" maxlength="2000" placeholder="例：PROJECT-123, OTHER_PROJECT&#10;課題URLやプロジェクトURLも指定できます"></textarea>
          <p id="bcr-references-note" class="bcr-note">同じBacklogスペース内の課題キー・プロジェクトキー、またはURLを空白・改行・カンマで区切って指定します。追加は課題5件・プロジェクト3件まで。</p>
        </details>
        <div class="bcr-dialogue" hidden>
          <p class="bcr-empty-dialogue bcr-note">調べてほしいことや伝えたいことを入力して、AIに相談しましょう。</p>
          <ol class="bcr-dialogue-list" aria-label="AIとの会話" aria-live="polite"></ol>
        </div>
        <label class="bcr-label bcr-instruction-label" for="bcr-instruction">今回伝えたい内容</label>
        <div class="bcr-composer">
          <textarea id="bcr-instruction" class="bcr-instruction" maxlength="10000" placeholder="例：修正が完了したので、関連課題の状況も踏まえて確認をお願いしたい"></textarea>
          <button class="bcr-generate" type="button">AIで返信文を生成</button>
        </div>
        <p class="bcr-chat-hint" hidden>Enterで送信、Shift + Enterで改行</p>
        <span class="bcr-status" role="status" aria-live="polite"></span>
        <div class="bcr-dialogue-controls" hidden>
          <div class="bcr-dialogue-actions"><button class="bcr-create-draft" type="button">会話から返信文案を作成</button><button class="bcr-clear-dialogue" type="button">会話を最初から</button></div>
          <div class="bcr-draft-log" hidden></div>
          <div class="bcr-candidate-wrap" hidden>
            <label class="bcr-label" for="bcr-candidate">返信文案（編集できます）</label>
            <textarea id="bcr-candidate" class="bcr-candidate" maxlength="10000"></textarea>
            <p class="bcr-note">続けて相談する場合は、この文案もAIに送信します。</p>
            <button class="bcr-insert-draft" type="button">この文案をコメント欄に反映</button>
          </div>
        </div>
      </fieldset>
      <section class="bcr-progress" aria-label="作業ログ" hidden>
        <div class="bcr-progress-heading">作業ログ <span class="bcr-elapsed"></span></div>
        <p class="bcr-progress-note">「+」は生成開始からの経過、所要は次のログまでの時間です。</p>
        <ol class="bcr-progress-list"></ol>
      </section>
      <details class="bcr-sources" aria-label="直近の生成で参照した情報" hidden></details>
      </div>`;
    editor.parentElement?.insertBefore(root, editor);
    root.bcrDrafts = drafts;
    panelLayout = BacklogPanelLayout.attach(root, editor);
    mountedEditor = editor;
    const mountedPath = location.pathname;
    const draft = getDraft(mountedPath);
    const pendingInstruction = task?.path === mountedPath && task.phase === 'discuss' ? draft.instruction : null;
    root.querySelector('.bcr-instruction').value = pendingInstruction === null ? draft.instruction : '';
    if (pendingInstruction !== null) root.bcrPendingInstruction = pendingInstruction;
    root.querySelector('.bcr-mode').value = draft.mode;
    root.querySelector('.bcr-references').value = draft.references;
    root.querySelector('.bcr-include-project').checked = draft.includeCurrentProject;
    root.querySelector('.bcr-interactive').checked = draft.interactive;
    for (const selector of ['.bcr-instruction', '.bcr-references']) root.querySelector(selector).addEventListener('input', () => {saveDraft(root, mountedPath);});
    root.querySelector('.bcr-mode').addEventListener('change', () => {saveDraft(root, mountedPath); renderState();});
    root.querySelector('.bcr-include-project').addEventListener('change', () => {saveDraft(root, mountedPath); renderModeNote(root);});
    root.querySelector('.bcr-interactive').addEventListener('change', () => {saveDraft(root, mountedPath); renderState();});
    root.querySelector('.bcr-candidate').addEventListener('input', event => {draft.candidate = event.currentTarget.value; root.querySelector('.bcr-insert-draft').disabled = !draft.candidate.trim();});
    root.querySelector('.bcr-clear-dialogue').addEventListener('click', () => {
      if (task || !confirm('この課題の会話と返信文案を消去しますか？')) return;
      draft.messages = []; draft.userInputs = []; draft.conversationScope = null; draft.candidate = ''; draft.candidateVisible = false; draft.sentCandidate = ''; draft.candidateActivity = null; draft.failedActivity = null; draft.sources = [];
      renderState();
    });
    root.querySelector('.bcr-sources').addEventListener('toggle', event => {getDraft(mountedPath).sourcesOpen = event.currentTarget.open;});
    root.querySelector('.bcr-toggle').addEventListener('click', () => {
      panelCollapsed = !panelCollapsed;
      renderState();
    });
    renderState();
    refreshSettings().catch(error => {if (root.isConnected && !task) setStatus(mountedPath, error.message, 'error');});
    async function runGeneration(phase = null) {
      if (task) return;
      const draft = saveDraft(root, mountedPath);
      const interactive = draft.mode === 'agent' && draft.interactive;
      if (!interactive) phase = null;
      if (interactive && !phase) phase = 'discuss';
      const instruction = phase === 'draft' ? 'これまでのやり取りを踏まえて、投稿する返信文案を作成してください。' : draft.instruction.trim();
      if (!instruction) {setStatus(location.pathname, interactive ? 'メッセージを入力してください。' : '伝えたい内容を入力してください。', 'error'); return;}
      if (phase === 'draft' && draft.instruction.trim()) {setStatus(location.pathname, '入力中のメッセージを送信してから文案を作成してください。', 'error'); return;}
      if (phase === 'draft' && !draft.messages.length) {setStatus(location.pathname, '先にメッセージを送信してください。', 'error'); return;}
      if (phase === 'discuss' && instruction.length > 4000) {setStatus(location.pathname, 'メッセージは4000文字以内で入力してください。', 'error'); return;}
      const scope = JSON.stringify({references: draft.references.trim(), includeCurrentProject: draft.includeCurrentProject});
      if (interactive && draft.conversationScope !== null && draft.conversationScope !== scope) {
        setStatus(location.pathname, '参照範囲が会話開始時から変更されています。元に戻すか、「会話を最初から」で会話を消去してから送信してください。', 'error'); return;
      }
      // A draft being regenerated is separate untrusted reference data, not an
      // extra conversation turn. This preserves the complete bounded history.
      const candidateText = phase === 'discuss' && draft.candidate && draft.candidate !== draft.sentCandidate ? `現在の返信文案：\n${draft.candidate}` : '';
      const referenceDraft = phase === 'draft' && draft.candidate.trim() ? draft.candidate : undefined;
      if (candidateText.length > 4000 || referenceDraft?.length > 4000) {setStatus(location.pathname, '会話に引き継ぐ返信文案が長すぎます。4000文字以内に短くしてからお試しください。', 'error'); return;}
      const messages = [...draft.messages, ...(candidateText ? [{role: 'assistant', text: candidateText}] : [])];
      const historyLength = messages.reduce((sum, message) => sum + message.text.length, 0);
      if (interactive && (messages.length > 20 || historyLength > 24000 || phase === 'discuss' && (messages.length + 2 > 20 || historyLength + instruction.length > 24000))) {
        setStatus(location.pathname, '会話が上限に達しました。必要な内容を控えて「会話を最初から」で新しく始めてください。', 'error'); return;
      }
      checkNavigation();
      if (mountedPath !== location.pathname) {setStatus(location.pathname, '課題が切り替わりました。表示中の課題で生成してください。', 'error'); return;}
      const currentTask = {path: location.pathname, issueKey: issueKey(), version: navigationVersion, mode: draft.mode, references: draft.references.trim(), includeCurrentProject: draft.includeCurrentProject,
        requestId: crypto.randomUUID(), progressSequence: 0, startedAt: performance.now(), elapsedMs: 0, finishedElapsedMs: null, responseReceived: false, phase, instruction};
      if (interactive) {currentTask.activity = {entries: [], elapsedMs: 0, open: true}; draft.failedActivity = null;}
      const priorSources = interactive ? draft.sources : [];
      if (!interactive) draft.sources = [];
      draft.sourcesOpen = false;
      draft.progress = [];
      draft.elapsedMs = 0;
      draft.toolCalls = null;
      task = currentTask;
      let discussionCommitted = false;
      if (phase === 'discuss') {
        root.bcrPendingInstruction = draft.instruction;
        root.querySelector('.bcr-instruction').value = '';
      }
      setStatus(currentTask.path, '設定を確認しています…');
      try {
        const settings = await refreshSettings();
        if (disposed) return;
        checkNavigation();
        if (currentTask.version !== navigationVersion) throw new Error('課題が切り替わりました。もう一度生成してください。');
        setStatus(currentTask.path, currentTask.mode === 'agent'
          ? `${providerLabel(settings.provider)}に調査・生成処理を依頼しています…`
          : `${providerLabel(settings.provider)}に生成処理を依頼しています…`);
        const result = await chrome.runtime.sendMessage({type: 'GENERATE_REPLY', instruction, issueKey: currentTask.issueKey, provider: settings.provider, mode: currentTask.mode, references: currentTask.references, includeCurrentProject: currentTask.includeCurrentProject, requestId: currentTask.requestId, ...(interactive ? {interaction: {phase, messages: messages.map(({role, text}) => ({role, text}))}} : {}), ...(referenceDraft ? {referenceDraft} : {})});
        if (disposed) return;
        currentTask.responseReceived = true;
        if (!result?.ok) throw new Error(result?.error || '生成に失敗しました。');
        checkNavigation();
        if (currentTask.version !== navigationVersion || location.pathname !== currentTask.path || result.issueKey !== currentTask.issueKey) throw new Error('生成中に課題が切り替わったため、生成文は挿入しませんでした。');
        draft.sources = safeSources([...priorSources, ...(Array.isArray(result.sources) ? result.sources : [])]);
        draft.resultMode = result.mode === 'agent' ? 'agent' : currentTask.mode;
        draft.toolCalls = Number.isInteger(result.toolCalls) && result.toolCalls >= 0 ? result.toolCalls : null;
        draft.commentsUsed = result.commentsUsed;
        if (interactive) {
          if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('AIからの応答が空でした。もう一度お試しください。');
          if (phase === 'discuss') {
            if (result.text.length > 4000 || historyLength + instruction.length + result.text.length > 24000) throw new Error('AIからの応答が会話の文字数上限を超えました。入力を短くしてもう一度お試しください。');
            setStatus(currentTask.path, '回答を受け取りました。続けて相談できます。', 'ok', true);
            const assistantMessage = {role: 'assistant', text: result.text, activity: {entries: [...draft.progress], elapsedMs: draft.elapsedMs, open: false}};
            draft.messages = [...messages, {role: 'user', text: instruction}, assistantMessage];
            draft.userInputs = [...draft.userInputs, instruction];
            draft.conversationScope = scope;
            if (candidateText) draft.sentCandidate = draft.candidate;
            draft.instruction = '';
            discussionCommitted = true;
            const currentRoot = document.getElementById('bcr-root');
            if (currentRoot && location.pathname === currentTask.path) currentRoot.querySelector('.bcr-instruction').value = '';

          } else {
            if (result.text.length > 10000) throw new Error('返信文案が長すぎます。会話で短くするよう伝えてから、もう一度作成してください。');
            draft.candidate = result.text;
            draft.candidateVisible = true;
            setStatus(currentTask.path, '返信文案を作成しました。内容を確認・編集してからコメント欄に反映してください。', 'ok', true);
            draft.candidateActivity = {entries: [...draft.progress], elapsedMs: draft.elapsedMs, open: false};
          }
          return;
        }
        await insertReply(currentTask, result, instruction);
      } catch (error) {
        if (isConnectionError(error)) connectionFailed = true;
        if (!disposed) {
          setStatus(currentTask.path, connectionMessage(error), 'error', true);
          if (interactive && (phase === 'discuss' || phase === 'draft')) {
            draft.failedActivity = {phase, entries: [...draft.progress], elapsedMs: draft.elapsedMs, open: true, failed: true};
          }
        }
      } finally {
        if (phase === 'discuss' && !disposed) {
          const currentRoot = document.getElementById('bcr-root');
          if (currentRoot && location.pathname === currentTask.path) {
            if (!discussionCommitted) currentRoot.querySelector('.bcr-instruction').value = draft.instruction;
            delete currentRoot.bcrPendingInstruction;
          }
        }
        draft.elapsedMs = taskElapsed(currentTask);
        task = null;
        renderState(); // Also resets a panel remounted while the request was running.
      }
    }
    root.querySelector('.bcr-generate').addEventListener('click', () => runGeneration());
    root.querySelector('.bcr-instruction').addEventListener('keydown', event => {
      if (draft.mode !== 'agent' || !draft.interactive || event.key !== 'Enter' || event.shiftKey
        || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (!task && !event.repeat) void runGeneration();
    });
    root.querySelector('.bcr-create-draft').addEventListener('click', () => runGeneration('draft'));
    root.querySelector('.bcr-insert-draft').addEventListener('click', async () => {
      if (task) return;
      checkNavigation();
      if (mountedPath !== location.pathname) {setStatus(location.pathname, '課題が切り替わりました。表示中の課題で操作してください。', 'error'); return;}
      const draft = getDraft(mountedPath);
      const text = draft.candidate;
      if (!text.trim()) {setStatus(mountedPath, '反映する返信文案を入力してください。', 'error'); return;}
      const currentTask = {path: mountedPath, issueKey: issueKey(), version: navigationVersion, requestId: crypto.randomUUID(), progressSequence: 0, startedAt: performance.now(), elapsedMs: 0, finishedElapsedMs: null, responseReceived: true};
      task = currentTask;
      try {
        // Context copied from an AI draft is not user-supplied URL evidence.
        await insertReply(currentTask, {text, provider, commentsUsed: draft.commentsUsed ?? 0}, draft.userInputs.join('\n'));
      } catch (error) {
        if (!disposed) setStatus(mountedPath, connectionMessage(error), 'error', true);
      } finally {
        task = null;
        renderState();
      }
    });
  }
  observer = new MutationObserver(() => {if (disposed) return; checkNavigation(); checkCommentPosted(); if (issueKey() && !document.getElementById('bcr-root')) mount();});
  observer.observe(document.documentElement, {childList: true, subtree: true});
  window.addEventListener('popstate', mount);
  window.addEventListener('focus', reconnectOnReturn);
  document.addEventListener('submit', watchCommentSubmit, true);
  document.addEventListener('click', watchCommentSubmit, true);
  document.addEventListener('input', cancelCommentWatchOnInput, true);
  document.addEventListener('visibilitychange', reconnectOnReturn);
  document.addEventListener('backlog-ai-dispose', function dispose() {
    disposed = true;
    observer.disconnect();
    intervals.forEach(clearInterval);
    window.removeEventListener('popstate', mount);
    window.removeEventListener('focus', reconnectOnReturn);
    document.removeEventListener('submit', watchCommentSubmit, true);
    document.removeEventListener('click', watchCommentSubmit, true);
    document.removeEventListener('input', cancelCommentWatchOnInput, true);
    document.removeEventListener('visibilitychange', reconnectOnReturn);
    try {chrome.runtime.onMessage.removeListener(onMessage);} catch { /* Context may already be invalidated. */ }
    removePanel();
  }, {once: true});
  mount();
  intervals.push(setInterval(mount, 1000));
  intervals.push(setInterval(() => {if (!disposed && task) renderElapsed();}, 100));
})();
