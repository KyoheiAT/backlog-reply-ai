import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexEnvironment, resolveCodexCommand, runProcess, stopProcess } from './codex.mjs';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 500;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export function codexModelArguments() {
  // app-server currently has no --ignore-user-config option. No thread or turn
  // is started, and action-capable features are disabled explicitly as well.
  const args = ['--no-daemon', 'app-server', '--strict-config', '--listen', 'stdio://'];
  for (const setting of [
    'forced_login_method="chatgpt"', 'model_provider="openai"', 'sandbox_mode="read-only"',
    'web_search="disabled"', 'mcp_servers={}', 'agents.enabled=false',
    'project_doc_max_bytes=0', 'skills.include_instructions=false',
    'skills.bundled.enabled=false', 'features.skip_host_skill_discovery=true',
    'analytics.enabled=false',
  ]) args.push('-c', setting);
  for (const feature of [
    'shell_tool', 'shell_snapshot', 'hooks', 'apps', 'plugins', 'remote_plugin',
    'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'view_image',
    'memories', 'goals', 'skill_search', 'skill_mcp_dependency_install',
    'code_mode_host', 'workspace_dependencies',
  ]) args.push('--disable', feature);
  return args;
}

function cleanText(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

export function normalizeCodexModel(entry) {
  if (!entry || typeof entry !== 'object' || entry.hidden === true || typeof entry.model !== 'string' || !SAFE_MODEL.test(entry.model)) return null;
  // The official protocol specifies text/image as the backward-compatible
  // default when older catalogs omit inputModalities.
  if (entry.inputModalities !== undefined && (!Array.isArray(entry.inputModalities) || !entry.inputModalities.includes('text'))) return null;
  const result = { id: entry.model, name: cleanText(entry.displayName, 160) || entry.model };
  const description = cleanText(entry.description, 500);
  if (description) result.description = description;
  if (typeof entry.isDefault === 'boolean') result.isDefault = entry.isDefault;
  return result;
}

function catalogError(raw = '') {
  if (/unexpected argument|unknown (?:feature|field)|unrecognized|invalid.*config|requires experimental/i.test(raw)) {
    return new Error('Codex CLIがモデル一覧の取得に対応していません。公式CLIを最新版へ更新してください。');
  }
  if (/unauthorized|authentication|login|401|403/i.test(raw)) {
    return new Error('Codexのモデル一覧にアクセスできません。codex loginでChatGPTにログインしてください。');
  }
  return new Error('Codexのモデル一覧を取得できませんでした。CLIの更新とChatGPTログインを確認してください。');
}

function readCatalog({ invocation, cwd, env, signal, spawnImpl, platform }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    let child;
    try {
      child = spawnImpl(invocation.command, [...invocation.prefix, ...codexModelArguments()], {
        cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { reject(catalogError()); return; }
    const models = new Map();
    const cursors = new Set();
    let pendingId = 1;
    let phase = 'initialize';
    let pages = 0;
    let bytes = 0;
    let partial = '';
    let diagnostic = '';
    let finalError;
    let finalModels;
    let finishing = false;
    let settled = false;
    let killTimer;
    let forceTimer;

    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(result);
    };
    const kill = () => {
      if (settled) return;
      stopProcess(child, { platform, spawnImpl, env });
      forceTimer = setTimeout(() => settle(finalError || catalogError()), 5000);
      forceTimer.unref?.();
    };
    const finish = (error, result) => {
      if (finishing || settled) return;
      finishing = true;
      finalError = error;
      finalModels = result;
      if (error) kill();
      else {
        // A stdio app-server normally exits on EOF. Bound cleanup if an old
        // server remains alive; no shared daemon is used by this invocation.
        child.stdin.end();
        killTimer = setTimeout(kill, 500);
        killTimer.unref?.();
      }
    };
    const onAbort = () => {
      if (finishing) {
        finalError = signal.reason;
        kill();
      } else finish(signal.reason);
    };
    const send = message => {
      try { child.stdin.write(JSON.stringify(message) + '\n', 'utf8'); }
      catch { finish(catalogError()); }
    };
    const nextPage = cursor => {
      phase = 'models';
      pendingId++;
      pages++;
      const params = { limit: PAGE_SIZE, includeHidden: false };
      if (cursor !== undefined) params.cursor = cursor;
      send({ id: pendingId, method: 'model/list', params });
    };
    const readLine = line => {
      if (finishing || !line.trim()) return;
      let message;
      try { message = JSON.parse(line); }
      catch { finish(new Error('Codex CLIのモデル一覧応答が不正です。公式CLIを更新してください。')); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { finish(catalogError()); return; }
      // A catalog read never accepts server-initiated tool/auth/action requests.
      if (message.method && message.id !== undefined) { finish(new Error('モデル一覧以外の要求を受信したためCodex接続を停止しました。')); return; }
      if (message.id !== pendingId) return; // Ignore notifications and unrelated response IDs.
      if (message.error) { finish(catalogError(JSON.stringify(message.error))); return; }
      if (!message.result || typeof message.result !== 'object') { finish(catalogError()); return; }
      if (phase === 'initialize') {
        send({ method: 'initialized', params: {} });
        nextPage();
        return;
      }
      if (!Array.isArray(message.result.data)) { finish(catalogError()); return; }
      for (const raw of message.result.data) {
        const model = normalizeCodexModel(raw);
        if (!model) continue;
        if (models.has(model.id)) {
          if (model.isDefault === true) models.get(model.id).isDefault = true;
        } else if (models.size < MAX_MODELS) models.set(model.id, model);
      }
      const cursor = message.result.nextCursor;
      if (cursor !== null && cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4096 || cursors.has(cursor))) {
        finish(new Error('Codexのモデル一覧のページ情報が不正です。'));
        return;
      }
      if (cursor && pages < MAX_PAGES && models.size < MAX_MODELS) {
        cursors.add(cursor);
        nextPage(cursor);
      } else {
        const result = [...models.values()];
        if (!result.length) finish(new Error('Codexで文章生成に使えるモデルが見つかりませんでした。ログインと契約を確認してください。'));
        else finish(null, result);
      }
    };
    const withinLimit = chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= MAX_OUTPUT_BYTES) return true;
      finish(new Error('Codexのモデル一覧応答がサイズ上限を超えました。'));
      return false;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (!withinLimit(chunk) || finishing) return;
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) readLine(line);
    });
    child.stderr.on('data', chunk => { if (withinLimit(chunk)) diagnostic += chunk; });
    child.stdin.on('error', () => { if (!finishing) finish(catalogError()); });
    child.once('error', () => settle(catalogError()));
    child.once('close', () => {
      if (!finishing && partial.trim()) readLine(partial);
      if (finalError) settle(finalError);
      else if (finalModels) settle(null, finalModels);
      else settle(catalogError(diagnostic));
    });
    signal.addEventListener('abort', onAbort, { once: true });
    send({ id: pendingId, method: 'initialize', params: {
      clientInfo: { name: 'backlog_ai_reply', title: 'Backlog AI Reply', version: '1.3.0' },
    } });
    if (signal.aborted) onAbort();
  });
}

export function createCodexModelLister({
  spawnImpl = spawn, env = process.env, platform = process.platform,
  resolveCommand = resolveCodexCommand, timeoutMs = 45_000,
} = {}) {
  return async function list({ signal } = {}) {
    const controller = new AbortController();
    const aborted = () => controller.abort(Object.assign(new Error('Codexのモデル一覧取得を中止しました。'), { name: 'AbortError' }));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    const timer = setTimeout(() => controller.abort(new Error('Codexのモデル一覧取得がタイムアウトしました。')), timeoutMs);
    timer.unref?.();
    const tempRoot = path.resolve(tmpdir());
    let cwd;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const invocation = await resolveCommand({ env, platform });
      const childEnv = codexEnvironment(env);
      cwd = await mkdtemp(path.join(tempRoot, 'backlog-codex-models-'));
      const status = await runProcess({ invocation, args: ['--no-daemon', 'login', 'status'], cwd,
        env: childEnv, signal: controller.signal, timeoutMs: Math.min(timeoutMs, 15_000), spawnImpl, platform });
      if (!/logged in using chatgpt/i.test(`${status.stdout}\n${status.stderr}`)) {
        throw new Error('モデル一覧の取得にはChatGPTログインが必要です。codex loginで「Sign in with ChatGPT」を選択してください。');
      }
      return await readCatalog({ invocation, cwd, env: childEnv, signal: controller.signal, spawnImpl, platform });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (cwd && path.dirname(path.resolve(cwd)) === tempRoot && path.basename(cwd).startsWith('backlog-codex-models-')) {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  };
}

export const listCodexModels = createCodexModelLister();
