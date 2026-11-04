(() => {
  const element = id => document.getElementById(id);
  const fields = {
    displayName: element('promptDisplayName'), profileUrl: element('promptProfileUrl'),
    generatedPrompt: element('promptGenerated'), fixedPrompt: element('promptFixed'), locked: element('promptLocked')
  };
  let loaded = false;
  let baseline = null;
  let editingRevision = 0;
  let savedProfile = null;
  let defaultGeneratedPrompt = null;
  let defaultFixedPrompt = null;
  let editVersion = 0;
  let readVersion = 0;
  let actionVersion = 0;
  let saving = false;
  let regenerating = false;

  function readFields() {
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, key === 'locked' ? field.checked : field.value]));
  }
  function editable(profile) {
    return Object.fromEntries(Object.keys(fields).map(key => [key, key === 'locked' ? profile.locked === true : typeof profile[key] === 'string' ? profile[key] : '']));
  }
  function isDirty() {
    const current = readFields();
    return baseline ? Object.keys(fields).some(key => current[key] !== baseline[key]) : editVersion > 0;
  }
  function feedback(message, error = false, version = actionVersion) {
    if (version !== actionVersion) return;
    element('promptFeedback').textContent = message;
    element('promptFeedback').className = error === 'note' ? 'note' : error ? 'error' : 'success';
  }
  function renderControls() {
    element('promptSave').disabled = !loaded || saving;
    element('promptResetGenerated').disabled = !loaded || saving || defaultGeneratedPrompt === null;
    element('promptResetFixed').disabled = !loaded || saving || defaultFixedPrompt === null;
    element('promptReload').disabled = saving;
    element('promptRegenerate').disabled = !loaded || saving || regenerating || fields.locked.checked || savedProfile?.status?.state === 'running';
    const dirty = element('promptDirty');
    dirty.hidden = !isDirty();
    dirty.textContent = savedProfile && savedProfile.revision !== editingRevision
      ? '未保存の編集を保持しています。保存済み設定が更新されたため、このまま保存すると競合します。必要な内容を控え、「保存済みを読み直す」で更新してください。'
      : '未保存の変更があります。下のプレビューは保存済みの内容です。';
  }
  function dateLabel(value, empty) {
    if (typeof value !== 'string' || !value) return empty;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? empty : date.toLocaleString('ja-JP');
  }
  function renderSources(sources) {
    const container = element('promptSources');
    container.replaceChildren();
    const list = document.createElement('ul');
    const seen = new Set();
    for (const source of Array.isArray(sources) ? sources.slice(0, 20) : []) {
      try {
        const url = new URL(source.url);
        const officialArticle = (url.hostname === 'support-ja.backlog.com' && /^\/hc\/ja\/articles\/\d+(?:-[^/]+)?\/?$/.test(url.pathname))
          || (url.hostname === 'help-center.backlog.com' && /^\/faq-[a-f0-9]{24}\/?$/.test(url.pathname));
        if (url.protocol !== 'https:' || !officialArticle || url.port || url.username || url.password || url.search || url.hash || seen.has(url.href)) continue;
        seen.add(url.href);
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = typeof source.title === 'string' && source.title.trim() ? source.title.slice(0, 300) : 'Backlog公式ガイド';
        item.appendChild(link);
        list.appendChild(item);
      } catch { /* Only public official article URLs are linked. */ }
    }
    container.hidden = seen.size === 0;
    if (!seen.size) return;
    const title = document.createElement('p');
    title.textContent = '生成時に参照した公式ガイド';
    container.appendChild(title);
    container.appendChild(list);
  }
  function renderSaved(result) {
    savedProfile = result.profile;
    defaultGeneratedPrompt = typeof result.defaultGeneratedPrompt === 'string' && result.defaultGeneratedPrompt.trim()
      && result.defaultGeneratedPrompt.length <= 12000 && !result.defaultGeneratedPrompt.includes('\u0000') ? result.defaultGeneratedPrompt : null;
    defaultFixedPrompt = typeof result.defaultFixedPrompt === 'string'
      && result.defaultFixedPrompt.length <= 10000 && !result.defaultFixedPrompt.includes('\u0000') ? result.defaultFixedPrompt : null;
    const profile = savedProfile;
    const stateLabels = {idle: '未生成', running: '生成中', success: '生成完了', error: '生成できませんでした', skipped: '生成をスキップ'};
    const state = profile.status?.state;
    const status = element('promptGenerationStatus');
    status.textContent = `${stateLabels[state] || '保存済み設定'}${typeof profile.status?.message === 'string' && profile.status.message ? `：${profile.status.message}` : ''}`;
    status.className = state === 'error' ? 'error' : state === 'success' ? 'success' : 'note';
    element('promptMeta').textContent = `最終生成：${dateLabel(profile.generatedAt, '未生成')} ／ 最終確認：${dateLabel(profile.checkedAt, '未確認')} ／ 保存版：${profile.revision}`;
    element('promptEffective').value = typeof result.effectivePrompt === 'string' ? result.effectivePrompt : '';
    renderSources(profile.sources);
  }
  function validateResult(result) {
    if (!result?.ok) throw new Error(result?.error || 'プロンプト設定を取得できませんでした。');
    if (!result.profile || !Number.isInteger(result.profile.revision) || result.profile.revision < 0) throw new Error('プロンプト設定の応答形式が不正です。');
    return result;
  }
  function adoptResult(result, {replace = false, unchangedSince = editVersion, savedEdit = false} = {}) {
    validateResult(result);
    if (savedProfile && result.profile.revision < savedProfile.revision) return false;
    const dirty = isDirty();
    renderSaved(result);
    loaded = true;
    if (savedEdit || (!dirty && !replace) || (replace && editVersion === unchangedSince)) {
      baseline = editable(result.profile);
      editingRevision = result.profile.revision;
      if (!savedEdit || editVersion === unchangedSince) {
        for (const [key, value] of Object.entries(baseline)) {
          if (key === 'locked') fields[key].checked = value;
          else fields[key].value = value;
        }
      }
    }
    renderControls();
    return true;
  }
  async function refresh({replace = false} = {}) {
    const version = ++readVersion;
    const unchangedSince = editVersion;
    const result = validateResult(await chrome.runtime.sendMessage({type: 'GET_PROMPT_PROFILE'}));
    if (version !== readVersion) return;
    adoptResult(result, {replace, unchangedSince});
  }
  function payload() {
    const profile = {...readFields(), revision: editingRevision};
    profile.displayName = profile.displayName.trim();
    profile.profileUrl = profile.profileUrl.trim();
    if (profile.displayName.length > 100) throw new Error('表示名は100文字以内で入力してください。');
    if (profile.generatedPrompt.length > 12000) throw new Error('生成プロンプトは12,000文字以内で入力してください。');
    if (profile.fixedPrompt.length > 10000) throw new Error('常に追加する指示は10,000文字以内で入力してください。');
    if (profile.profileUrl) {
      let valid = false;
      try {
        const url = new URL(profile.profileUrl);
        valid = url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash
          && /^[a-z0-9-]+\.(?:backlog\.com|backlog\.jp|backlogtool\.com)$/i.test(url.hostname)
          && /^\/user\/[^/]+\/?$/.test(url.pathname);
      } catch { /* Report one actionable validation message below. */ }
      if (!valid) throw new Error('プロフィールURLは対応Backlogドメインの https://スペース名.backlog.com/user/… 形式で入力してください。');
    }
    return profile;
  }
  async function save(version) {
    if (!loaded || saving) throw new Error('設定の読み込み・保存が終わってから操作してください。');
    const profile = payload();
    const unchangedSince = editVersion;
    saving = true;
    renderControls();
    try {
      const result = validateResult(await chrome.runtime.sendMessage({type: 'SAVE_PROMPT_PROFILE', profile}));
      const accepted = adoptResult(result, {unchangedSince, savedEdit: true});
      if (!accepted) throw new Error('保存後に別の設定更新がありました。編集内容を控え、「保存済みを読み直す」で確認してください。');
      feedback(isDirty() ? '保存しました。その後の入力は未保存のまま保持しています。' : 'プロンプト設定を保存しました。', false, version);
    } catch (error) {
      // Refresh metadata without replacing the edits or rebasing an old revision.
      await refresh().catch(() => {});
      throw error;
    } finally {
      saving = false;
      renderControls();
    }
  }

  for (const field of Object.values(fields)) {
    field.addEventListener(field === fields.locked ? 'change' : 'input', () => {editVersion++; renderControls();});
  }
  element('promptResetGenerated').addEventListener('click', () => {
    if (element('promptResetGenerated').disabled) return;
    const version = ++actionVersion;
    fields.generatedPrompt.value = defaultGeneratedPrompt;
    editVersion++;
    renderControls();
    feedback('「生成プロンプト」をGPTの指示に基づく標準の編集方針に戻しました。「プロンプト設定を保存」で適用してください。', false, version);
  });
  element('promptResetFixed').addEventListener('click', () => {
    if (element('promptResetFixed').disabled) return;
    const version = ++actionVersion;
    fields.fixedPrompt.value = defaultFixedPrompt;
    editVersion++;
    renderControls();
    feedback('「常に追加する指示」を初期値に戻しました（標準は空欄です）。「プロンプト設定を保存」で適用してください。', false, version);
  });
  element('promptForm').addEventListener('submit', async event => {
    event.preventDefault();
    const version = ++actionVersion;
    try {await save(version);}
    catch (error) {feedback(`${error.message} 未保存の内容は保持しています。必要なら内容を控えて「保存済みを読み直す」を押してください。`, true, version);}
  });
  element('promptRegenerate').addEventListener('click', async () => {
    if (element('promptRegenerate').disabled) return;
    const version = ++actionVersion;
    regenerating = true;
    renderControls();
    try {
      if (isDirty()) await save(version);
      if (isDirty()) throw new Error('保存中に入力が変更されました。変更を保存してから、もう一度再生成してください。');
      if (fields.locked.checked) throw new Error('固定を解除して保存すると、再生成できます。');
      feedback('標準の編集方針を保ち、保存済みのAI・モデルで本人情報と公式ガイドの補足を生成しています…', false, version);
      const result = validateResult(await chrome.runtime.sendMessage({type: 'REGENERATE_PROMPT_PROFILE'}));
      const accepted = adoptResult(result);
      if (accepted && result.profile.status?.state === 'success') {
        feedback('生成結果を保存しました。内容を確認してください。', false, version);
      } else {
        const detail = !accepted ? 'その後に保存済み設定が更新されています。'
          : typeof result.profile.status?.message === 'string' && result.profile.status.message
            ? result.profile.status.message : '保存済みの状態を確認してください。';
        feedback(`生成結果は採用していません。${detail}`, result.profile.status?.state === 'error' ? true : 'note', version);
      }
    } catch (error) {
      await refresh().catch(() => {});
      feedback(error.message || '共通プロンプトを生成できませんでした。', true, version);
    } finally {
      regenerating = false;
      renderControls();
    }
  });
  element('promptReload').addEventListener('click', async () => {
    if (isDirty() && !confirm('未保存のプロンプト設定を破棄して、保存済みの内容を読み直しますか？')) return;
    const version = ++actionVersion;
    const unchangedSince = editVersion;
    try {
      await refresh({replace: true});
      feedback(editVersion === unchangedSince ? '保存済みの内容を読み直しました。' : '保存済みの状態を更新しました。読み込み中の編集は保持しています。', false, version);
    } catch (error) {feedback(error.message, true, version);}
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, 'promptProfile')) return;
    void refresh().catch(error => {feedback(`保存済みの状態を更新できませんでした: ${error.message}`, true);});
  });
  renderControls();
  void refresh().catch(error => {feedback(`プロンプト設定を読み込めませんでした: ${error.message}`, true);});
})();
