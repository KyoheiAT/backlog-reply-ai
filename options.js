const ids = [...BacklogCredentials.STORAGE_KEYS, 'provider', 'copilotModel', 'codexModel', 'maxComments', 'excludeLatestOwnComment'];
const providers = ['copilot', 'codex'];
const manualOption = '@manual';
const modelPattern = /^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99})?$/;
const status = document.getElementById('status');
const modelState = Object.fromEntries(providers.map(provider => [provider, {
  value: '', manual: false, manualValue: '', models: [], attempted: false, loading: false, error: '', requestVersion: 0
}]));
let settingsLoaded = false;
let settingsSaving = false;
let formattingRequestVersion = 0;
let backlogSpaces = [];
let selectedSpaceIndex = -1;
let selectedKeyId = '';
let credentialSequence = 0;
let savedSpaceOrigins = new Set();

function newCredential() {
  let id;
  do {id = `key-${Date.now().toString(36)}-${++credentialSequence}`;}
  while (backlogSpaces.some(space => space.keys.some(key => key.id === id)));
  return {id, label: '', apiKey: ''};
}

function credentialFeedback(error) {
  status.textContent = error ? error.message : '変更は「設定を保存」で適用します。';
  status.className = error ? 'error' : 'note';
}

function commitCredential() {
  const space = backlogSpaces[selectedSpaceIndex];
  if (!space) return;
  const origin = normalizeSpaceUrl(document.getElementById('backlogSpaceUrl').value);
  if (!origin) throw new Error('APIキーを発行したBacklogスペースURLを入力してください（例：https://your-space.backlog.com）。');
  if (backlogSpaces.some((entry, index) => index !== selectedSpaceIndex && entry.origin === origin)) {
    throw new Error('このスペースは登録済みです。スペース一覧から選び、「APIキーを追加」で登録してください。');
  }
  if (space.origin && space.origin !== origin) throw new Error('登録済みのスペースURLは変更できません。別のスペースは「スペースを追加」で登録してください。');
  const key = space.keys.find(entry => entry.id === selectedKeyId);
  const apiKey = document.getElementById('backlogKey').value.trim();
  if (!apiKey || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new Error('有効なBacklog APIキーを入力してください。');
  if (space.keys.some(entry => entry.id !== selectedKeyId && entry.apiKey === apiKey)) throw new Error('このAPIキーはすでに同じスペースに登録されています。');
  const label = document.getElementById('backlogKeyLabel').value.trim();
  if (label.length > 100) throw new Error('APIキーの名前は100文字以内で入力してください。');
  space.origin = origin;
  key.apiKey = apiKey;
  key.label = label || `APIキー ${space.keys.indexOf(key) + 1}`;
  space.activeKeyId = selectedKeyId;
}

function renderCredentials() {
  const select = document.getElementById('backlogSpaceSelect');
  select.replaceChildren();
  if (!backlogSpaces.length) addOption(select, '', 'スペースを追加してください');
  backlogSpaces.forEach((space, index) => addOption(select, String(index), space.origin || '新しいスペース（未入力）'));
  select.value = selectedSpaceIndex < 0 ? '' : String(selectedSpaceIndex);
  select.disabled = !backlogSpaces.length;
  const space = backlogSpaces[selectedSpaceIndex];
  document.getElementById('backlogCredentialFields').hidden = !space;
  document.getElementById('removeBacklogSpace').disabled = !space;
  for (const id of ['backlogSpaceUrl', 'backlogKey', 'backlogKeyLabel', 'backlogKeySelect', 'addBacklogKey', 'removeBacklogKey']) {
    document.getElementById(id).disabled = !space;
  }
  const keySelect = document.getElementById('backlogKeySelect');
  keySelect.replaceChildren();
  if (space) {
    selectedKeyId = space.activeKeyId;
    space.keys.forEach((key, index) => addOption(keySelect, key.id, key.label || `APIキー ${index + 1}`));
    keySelect.value = selectedKeyId;
  }
  const key = space?.keys.find(entry => entry.id === selectedKeyId);
  document.getElementById('backlogSpaceUrl').value = space?.origin || '';
  document.getElementById('backlogSpaceUrl').readOnly = !!space?.origin;
  document.getElementById('backlogKeyLabel').value = key?.label || '';
  document.getElementById('backlogKey').value = key?.apiKey || '';
}

function editCredentials(action, {commit = true} = {}) {
  if (!settingsLoaded || settingsSaving) return;
  try {
    if (commit) commitCredential();
    action();
    renderCredentials();
    credentialFeedback();
    void loadFormatting();
  } catch (error) {
    document.getElementById('backlogSpaceSelect').value = String(selectedSpaceIndex);
    document.getElementById('backlogKeySelect').value = selectedKeyId;
    credentialFeedback(error);
  }
}

function normalizeSpaceUrl(value) {
  const text = value.trim();
  if (!text) return '';
  if (!/^https:\/\/[a-z0-9-]+\.(?:backlog\.com|backlog\.jp|backlogtool\.com)\/?$/i.test(text)) {
    throw new Error('スペースURLは https://your-space.backlog.com の形式で入力してください。課題やプロフィールのパス、ポート番号は含めません。');
  }
  return new URL(text).origin;
}

async function loadFormatting(refresh = false) {
  const version = ++formattingRequestVersion;
  const output = document.getElementById('formattingStatus');
  const details = document.getElementById('formattingDetails');
  const button = document.getElementById('refreshFormatting');
  button.disabled = true;
  output.className = 'note';
  output.textContent = refresh ? '保存済みのスペースの記法を確認しています…' : '記法設定を読み込んでいます…';
  details.textContent = '';
  const origin = backlogSpaces[selectedSpaceIndex]?.origin;
  if (!origin || !savedSpaceOrigins.has(origin)) {
    output.textContent = 'スペースとAPIキーを保存すると、記法を確認できます。';
    return;
  }
  try {
    const result = await chrome.runtime.sendMessage({type: refresh ? 'REFRESH_FORMATTING' : 'GET_FORMATTING_STATUS', origin});
    if (version !== formattingRequestVersion) return;
    if (!result?.ok) throw new Error(result?.error || '記法設定を確認できませんでした。');
    const formatting = result.formatting;
    if (!formatting || !['ready', 'error', 'unconfigured'].includes(formatting.status)) throw new Error('記法設定の応答形式が不正です。');
    if (formatting.status === 'ready') {
      const label = {markdown: 'Markdown記法', backlog: 'Backlog記法'}[formatting.rule];
      if (!label) throw new Error('スペースの記法設定を判定できませんでした。');
      output.textContent = `スペースの記法：${label}。返信時は対象プロジェクトの設定を優先します。`;
      output.className = 'success';
    } else {
      output.textContent = formatting.message || (formatting.status === 'unconfigured' ? 'BacklogスペースURLが未設定です。APIキーを発行したスペースのURLを保存してください。' : '記法設定を確認できませんでした。');
      output.className = formatting.status === 'error' ? 'error' : 'note';
    }
    const checkedAt = new Date(formatting.checkedAt);
    details.textContent = [formatting.spaceName, formatting.origin,
      Number.isFinite(checkedAt.getTime()) ? `確認日時：${checkedAt.toLocaleString('ja-JP')}` : ''
    ].filter(value => typeof value === 'string' && value).join(' ／ ');
  } catch (error) {
    if (version !== formattingRequestVersion) return;
    output.textContent = `記法を確認できませんでした：${error.message || String(error)}`;
    output.className = 'error';
  } finally {
    if (version === formattingRequestVersion) button.disabled = false;
  }
}

function addOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function renderModelPicker(provider) {
  const state = modelState[provider];
  const select = document.getElementById(`${provider}ModelSelect`);
  select.replaceChildren();
  addOption(select, '', '自動選択（既定）');
  for (const model of state.models) {
    const label = model.name === model.id ? model.id : `${model.name} (${model.id})`;
    addOption(select, model.id, `${label}${model.isDefault ? ' — 既定候補' : ''}`);
  }
  const selectedModel = state.models.find(model => model.id === state.value);
  if (state.value && !selectedModel && !state.manual) addOption(select, state.value, `${state.value}（一覧未掲載・保持中）`);
  addOption(select, manualOption, 'モデルIDを直接指定');
  select.value = state.manual ? manualOption : state.value;
  const manualInput = document.getElementById(`${provider}Model`);
  document.getElementById(`${provider}ManualFields`).hidden = !state.manual;
  manualInput.disabled = !state.manual;
  // Keep the input's raw text, including an in-progress edit, across list refreshes.
  if (manualInput.value !== state.manualValue) manualInput.value = state.manualValue;
  const description = document.getElementById(`${provider}ModelDescription`);
  description.textContent = selectedModel?.description || '';
  description.hidden = !description.textContent;
  const note = document.getElementById(`${provider}ModelNote`);
  note.textContent = state.value && !selectedModel
    ? '指定中のモデルIDは現在の一覧にありません。設定は保持され、そのまま保存できます。'
    : '';
  note.hidden = !note.textContent;
  const modelStatus = document.getElementById(`${provider}ModelsStatus`);
  modelStatus.className = `${state.error ? 'error' : 'note'} model-status`;
  modelStatus.textContent = state.loading ? 'モデル一覧を取得しています…'
    : state.error ? `一覧を取得できませんでした: ${state.error}`
    : state.attempted ? (state.models.length ? `${state.models.length}件の候補を取得しました。` : 'モデル候補がありません。自動選択または直接指定を利用できます。')
    : '';
  document.getElementById(`${provider}RefreshModels`).disabled = state.loading;
}

async function loadModels(provider, force = false) {
  if (settingsSaving) return;
  const state = modelState[provider];
  if (!force && (state.attempted || state.loading)) return;
  const version = ++state.requestVersion;
  state.attempted = true;
  state.loading = true;
  state.error = '';
  renderModelPicker(provider);
  try {
    const result = await chrome.runtime.sendMessage({type: 'LIST_MODELS', provider});
    if (version !== state.requestVersion) return;
    if (!result?.ok) throw new Error(result?.error || 'ローカル接続とログイン状態を確認してください。');
    if (!Array.isArray(result.models)) throw new Error('モデル一覧の応答形式が不正です。');
    const seen = new Set();
    state.models = result.models.filter(model => {
      if (!model || typeof model.id !== 'string' || !model.id || !modelPattern.test(model.id) || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    }).map(model => ({
      id: model.id,
      name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id,
      description: typeof model.description === 'string' ? model.description : '',
      isDefault: model.isDefault === true
    }));
  } catch (error) {
    if (version !== state.requestVersion) return;
    state.error = error.message || String(error);
    // Previously loaded candidates and the user's current selection remain usable.
  } finally {
    if (version === state.requestVersion) {state.loading = false; renderModelPicker(provider);}
  }
}

function showProvider() {
  if (settingsSaving) return;
  const provider = document.getElementById('provider').value;
  document.getElementById('copilotFields').hidden = provider !== 'copilot';
  document.getElementById('codexFields').hidden = provider !== 'codex';
  if (settingsLoaded) void loadModels(provider);
}

async function initialize() {
  await chrome.storage.local.remove(['claudeKey', 'model']);
  const settings = await chrome.storage.local.get(ids);
  backlogSpaces = BacklogCredentials.list(settings);
  savedSpaceOrigins = new Set(backlogSpaces.map(space => space.origin));
  if (!backlogSpaces.length && !Array.isArray(settings.backlogSpaces)) {
    const key = newCredential();
    // Preserve a previously entered key even when the legacy URL needs fixing.
    key.apiKey = typeof settings.backlogKey === 'string' ? settings.backlogKey.trim() : '';
    backlogSpaces.push({origin: '', keys: [key], activeKeyId: key.id});
  }
  selectedSpaceIndex = backlogSpaces.length ? 0 : -1;
  renderCredentials();
  document.getElementById('provider').value = settings.provider === 'codex' ? 'codex' : 'copilot';
  for (const provider of providers) {
    const state = modelState[provider];
    state.value = typeof settings[`${provider}Model`] === 'string' ? settings[`${provider}Model`].trim() : '';
    state.manualValue = state.value;
    renderModelPicker(provider);
  }
  document.getElementById('maxComments').value = Math.min(100, Math.max(1, Math.floor(Number(settings.maxComments) || 50)));
  document.getElementById('excludeLatestOwnComment').checked = settings.excludeLatestOwnComment === true;
  document.getElementById('extensionId').textContent = chrome.runtime.id;
  document.getElementById('setupCommand').textContent = `npm run setup -- --extension-id ${chrome.runtime.id}`;
  settingsLoaded = true;
  showProvider();
  void loadFormatting();
}
initialize().catch(error => {status.textContent = `設定を読み込めませんでした: ${error.message}`; status.className = 'error';});

document.getElementById('backlogSpaceSelect').addEventListener('change', event => {
  const index = Number(event.currentTarget.value);
  editCredentials(() => {selectedSpaceIndex = index;});
});
document.getElementById('addBacklogSpace').addEventListener('click', () => editCredentials(() => {
  const key = newCredential();
  backlogSpaces.push({origin: '', keys: [key], activeKeyId: key.id});
  selectedSpaceIndex = backlogSpaces.length - 1;
}));
document.getElementById('removeBacklogSpace').addEventListener('click', () => editCredentials(() => {
  backlogSpaces.splice(selectedSpaceIndex, 1);
  selectedSpaceIndex = backlogSpaces.length ? Math.min(selectedSpaceIndex, backlogSpaces.length - 1) : -1;
}, {commit: false}));
document.getElementById('backlogKeySelect').addEventListener('change', event => {
  const id = event.currentTarget.value;
  editCredentials(() => {backlogSpaces[selectedSpaceIndex].activeKeyId = id;});
});
document.getElementById('addBacklogKey').addEventListener('click', () => editCredentials(() => {
  const space = backlogSpaces[selectedSpaceIndex];
  const key = newCredential();
  space.keys.push(key);
  space.activeKeyId = key.id;
}));
document.getElementById('removeBacklogKey').addEventListener('click', () => editCredentials(() => {
  const space = backlogSpaces[selectedSpaceIndex];
  space.keys = space.keys.filter(key => key.id !== selectedKeyId);
  if (!space.keys.length) space.keys.push(newCredential());
  space.activeKeyId = space.keys[0].id;
}, {commit: false}));

document.getElementById('provider').addEventListener('change', showProvider);
for (const provider of providers) {
  document.getElementById(`${provider}RefreshModels`).addEventListener('click', () => loadModels(provider, true));
  document.getElementById(`${provider}ModelSelect`).addEventListener('change', event => {
    if (settingsSaving) return;
    const state = modelState[provider];
    state.manual = event.currentTarget.value === manualOption;
    if (state.manual) state.manualValue = state.value;
    else {state.value = event.currentTarget.value; state.manualValue = state.value;}
    renderModelPicker(provider);
  });
  document.getElementById(`${provider}Model`).addEventListener('input', event => {
    if (settingsSaving) return;
    const state = modelState[provider];
    state.manualValue = event.currentTarget.value;
    state.value = state.manualValue.trim();
    // Do not rebuild the input while the user is typing.
    const selectedModel = state.models.find(model => model.id === state.value);
    const description = document.getElementById(`${provider}ModelDescription`);
    description.textContent = selectedModel?.description || '';
    description.hidden = !description.textContent;
    const note = document.getElementById(`${provider}ModelNote`);
    note.textContent = state.value && !selectedModel
      ? '指定中のモデルIDは現在の一覧にありません。設定は保持され、そのまま保存できます。' : '';
    note.hidden = !note.textContent;
  });
}

document.getElementById('settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (settingsSaving) return;
  try {
    if (!settingsLoaded) throw new Error('設定を読み込み中です。少し待ってから保存してください。');
    commitCredential();
    const settings = {
      backlogSpaces,
      provider: document.getElementById('provider').value,
      maxComments: Math.min(100, Math.max(1, Math.floor(Number(document.getElementById('maxComments').value) || 50))),
      excludeLatestOwnComment: document.getElementById('excludeLatestOwnComment').checked === true
    };
    for (const provider of providers) {
      const value = modelState[provider].value;
      if (!modelPattern.test(value)) throw new Error(`${provider === 'copilot' ? 'Copilot' : 'Codex'}のモデルIDは100文字以内の半角英数字と . _ : / - で指定してください（先頭は英数字）。`);
      settings[`${provider}Model`] = value;
    }
    settingsSaving = true;
    // A disabled fieldset blocks input even when asynchronous model/formatting
    // callbacks update their controls' individual disabled states during saving.
    document.getElementById('settingsFields').disabled = true;
    status.textContent = '保存しています…'; status.className = 'note';
    await chrome.storage.local.set(settings);
    await chrome.storage.local.remove(['claudeKey', 'model', 'backlogKey', 'backlogSpaceUrl']);
    savedSpaceOrigins = new Set(backlogSpaces.map(space => space.origin));
    renderCredentials();
    status.textContent = '保存しました。Backlogの課題画面で利用できます。'; status.className = 'success';
    void loadFormatting(true);
  } catch (error) {status.textContent = error.message; status.className = 'error';}
  finally {
    settingsSaving = false;
    document.getElementById('settingsFields').disabled = false;
  }
});

document.getElementById('refreshFormatting').addEventListener('click', () => {
  if (!settingsSaving) return loadFormatting(true);
});

document.getElementById('checkBridge').addEventListener('click', async event => {
  const button = event.currentTarget;
  const output = document.getElementById('connectionStatus');
  button.disabled = true; output.textContent = '接続を確認しています…'; output.className = '';
  try {
    const result = await chrome.runtime.sendMessage({type: 'CHECK_BRIDGE'});
    if (!result?.ok) throw new Error(result?.error || '接続を確認できませんでした。');
    output.textContent = '自動起動と接続を確認しました。接続は終了しました。Backlogで生成するときに再び自動起動します。'; output.className = 'success';
  } catch (error) {output.textContent = error.message; output.className = 'error';}
  finally {button.disabled = false;}
});
