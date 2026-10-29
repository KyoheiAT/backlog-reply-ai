import { Console } from 'node:console';
import { pathToFileURL } from 'node:url';
import { defaultGenerate, GUARD } from './server.mjs';

export const HOST_NAME = 'com.backlog_ai.reply';
export const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_PROMPT = 180_000;
const MAX_REPLY = 100_000;
const MAX_GENERATED_PROMPT = 12_000;
const MAX_REQUESTS = 10_000;
const GENERATION_TIMEOUT_MS = 180_000;
const MODEL_TIMEOUT_MS = 45_000;
const CANCELLED = '生成が中断またはタイムアウトしました。ログイン状態と利用上限を確認してください。';
const PROGRESS_STAGES = new Set(['agent_connecting', 'planning', 'reading', 'read_complete', 'read_failed',
  'drafting', 'reply_ready', 'duplicate', 'format_retry', 'generating']);
const PROGRESS_TOOLS = new Set(['get_project', 'get_issues', 'get_issue', 'get_issue_comments']);
const MAX_PROGRESS_EVENTS = 64;

export async function defaultListModels({ provider, signal }) {
  if (provider === 'copilot') {
    const { listCopilotModels } = await import('./providers/copilot.mjs');
    return listCopilotModels({ signal });
  }
  if (provider === 'codex') {
    const { listCodexModels } = await import('./providers/codex-models.mjs');
    return listCodexModels({ signal });
  }
  throw new Error('利用するAIが不正です。');
}

async function defaultGenerateAgent(input) {
  const { generateAgentReply } = await import('./agent.mjs');
  return generateAgentReply(input);
}

function validBacklog(value) {
  if (!value || typeof value !== 'object' || typeof value.apiKey !== 'string' || !value.apiKey.trim()
    || value.apiKey.length > 512 || /[\r\n\0]/.test(value.apiKey)) return false;
  try {
    const origin = new URL(value.origin);
    if (origin.origin !== value.origin || origin.protocol !== 'https:' || origin.port || origin.username || origin.password
      || !/^[a-z0-9-]+\.(?:backlog\.com|backlog\.jp|backlogtool\.com)$/i.test(origin.hostname)) return false;
  } catch {return false;}
  return Array.isArray(value.issueKeys) && value.issueKeys.length >= 1 && value.issueKeys.length <= 6
    && value.issueKeys.every(key => typeof key === 'string' && /^[A-Z0-9_]+-\d+$/.test(key) && key.length <= 120)
    && Array.isArray(value.projectKeys) && value.projectKeys.length <= 4
    && value.projectKeys.every(key => typeof key === 'string' && /^[A-Z0-9_]{1,100}$/.test(key));
}

function modelCatalog(value) {
  if (!Array.isArray(value)) throw new Error('モデル一覧の応答形式が不正です。');
  const models = [];
  const seen = new Set();
  for (const model of value.slice(0, 500)) {
    if (!model || typeof model.id !== 'string' || !/^[a-zA-Z0-9._:/-]{1,100}$/.test(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, name: typeof model.name === 'string' ? model.name.slice(0, 120) : model.id,
      ...(typeof model.description === 'string' ? { description: model.description.slice(0, 300) } : {}),
      ...(model.isDefault === true ? { isDefault: true } : {}) });
  }
  return models;
}

export function validateCaller(extensionId, callerOrigin) {
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)
    || callerOrigin !== `chrome-extension://${extensionId}/`) {
    throw new Error('登録されたChrome拡張からの呼び出しだけを許可しています。');
  }
}

export function parseNativeArguments(args) {
  if (!Array.isArray(args) || ![3, 4].includes(args.length) || args[0] !== '--extension-id'
    || (args.length === 4 && !/^--parent-window=\d+$/.test(args[3]))) {
    throw new Error('Native Messagingホストの起動引数が不正です。セットアップを再実行してください。');
  }
  const [, extensionId, callerOrigin] = args;
  validateCaller(extensionId, callerOrigin);
  return { extensionId, callerOrigin };
}

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (!body.length || body.length > MAX_MESSAGE_BYTES) throw new Error('応答がNative Messagingの上限を超えています。');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

// The header and payload may arrive in any number of chunks. Allocate only after
// validating the length; never repeatedly concatenate an untrusted partial frame.
function createDecoder(receive) {
  const header = Buffer.alloc(4);
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let headerBytes = 0;
  let body;
  let bodyBytes = 0;
  return {
    push(chunk) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Native Messagingにはバイナリ入力が必要です。');
      let offset = 0;
      while (offset < chunk.length) {
        if (!body) {
          const length = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + length);
          headerBytes += length;
          offset += length;
          if (headerBytes < 4) continue;
          const expected = header.readUInt32LE(0);
          if (expected === 0 || expected > MAX_MESSAGE_BYTES) throw new Error('受信メッセージの長さが不正です。');
          body = Buffer.allocUnsafe(expected);
        }
        const length = Math.min(body.length - bodyBytes, chunk.length - offset);
        chunk.copy(body, bodyBytes, offset, offset + length);
        bodyBytes += length;
        offset += length;
        if (bodyBytes !== body.length) continue;
        let message;
        try { message = JSON.parse(utf8.decode(body)); }
        catch { throw new Error('受信メッセージのJSONまたはUTF-8が不正です。'); }
        body = undefined;
        headerBytes = 0;
        bodyBytes = 0;
        if (receive(message) === false) return;
      }
    },
    finish() {
      if (headerBytes || body) throw new Error('受信メッセージが途中で切断されました。');
    },
  };
}

function validGeneration(message) {
  const generatingPrompt = message.type === 'generate_prompt';
  return ['copilot', 'codex'].includes(message.provider)
    && (generatingPrompt ? message.mode === undefined && message.backlog === undefined
      : (message.mode === undefined || ['chat', 'agent'].includes(message.mode))
        && (message.mode === 'agent' ? validBacklog(message.backlog) : message.backlog === undefined))
    && (message.progress === undefined || typeof message.progress === 'boolean')
    && typeof message.prompt === 'string' && message.prompt.trim().length > 0 && message.prompt.length <= MAX_PROMPT
    && (message.model === undefined || (typeof message.model === 'string'
      && message.model.length <= 100 && /^[a-zA-Z0-9._:/-]*$/.test(message.model)));
}

function safeProgress(event, apiKey) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  // Snapshot each field once so a getter cannot change it after validation.
  const {stage, tool, target, step, toolCalls, sourceCount} = event;
  if (!PROGRESS_STAGES.has(stage)) return null;
  const progress = {stage};
  if (PROGRESS_TOOLS.has(tool)) progress.tool = tool;
  const secrets = typeof apiKey === 'string' ? [apiKey, apiKey.trim()].filter(Boolean) : [];
  if (typeof target === 'string' && target.length <= 120 && /^[A-Z0-9_]+(?:-\d+)?$/.test(target)
    && !secrets.some(secret => target.includes(secret))) progress.target = target;
  for (const [field, value, min, max] of [['step', step, 1, 8], ['toolCalls', toolCalls, 0, 6], ['sourceCount', sourceCount, 0, 100]]) {
    if (Number.isInteger(value) && value >= min && value <= max) progress[field] = value;
  }
  return progress;
}

// Injectable streams and generator allow protocol and cancellation tests without
// logging in, starting either SDK, or sending information to an AI service.
export function createNativeHost({
  extensionId, callerOrigin, input = process.stdin, output = process.stdout,
  errorOutput = process.stderr, generate = defaultGenerate, listModels = defaultListModels, generateAgent = defaultGenerateAgent,
  timeoutMs = GENERATION_TIMEOUT_MS, modelTimeoutMs = MODEL_TIMEOUT_MS, cleanupTimeoutMs = 30_000,
} = {}) {
  validateCaller(extensionId, callerOrigin);
  const seen = new Set();
  const active = new Map();
  let closing = false;
  let exitCode = 0;
  let queuedBytes = 0;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const log = message => {
    try { errorOutput.write(`${HOST_NAME}: ${message}\n`); } catch { /* Diagnostic pipe already closed. */ }
  };

  function close(reason, code = 0) {
    if (closing) return done;
    closing = true;
    exitCode = code;
    if (reason) log(reason);
    input.pause();
    input.removeListener('data', onData);
    for (const job of active.values()) job.controller.abort(new Error(CANCELLED));
    void (async () => {
      let cleanupTimer;
      const cleaned = await Promise.race([
        Promise.allSettled([...active.values()].map(job => job.operation)).then(() => true),
        new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), cleanupTimeoutMs); }),
      ]);
      clearTimeout(cleanupTimer);
      if (!cleaned) { exitCode = 1; log('生成プロセスの終了待機がタイムアウトしました。'); }
      // Give already-written health/error frames time to flush. Never keep a
      // disconnected browser's native process alive because its stdout is full.
      if (!output.destroyed && !output.writableFinished) {
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); output.removeListener('close', finish); resolve(); };
          const timer = setTimeout(finish, 1000);
          output.once('close', finish);
          try { output.end(finish); } catch { finish(); }
        });
      }
      input.removeListener('end', onEnd);
      input.removeListener('close', onInputClose);
      resolveDone(exitCode);
    })();
    return done;
  }

  function send(message) {
    if (closing) return;
    let frame;
    try { frame = encodeNativeMessage(message); }
    catch { void close('応答がNative Messagingの上限を超えています。', 1); return; }
    queuedBytes += frame.length;
    if (queuedBytes > MAX_MESSAGE_BYTES * 2) {
      void close('応答を送信できません。接続を終了します。', 1);
      return;
    }
    try {
      if (!output.write(frame, error => {
        queuedBytes -= frame.length;
        if (error) void close('Chromeへの応答送信に失敗しました。', 1);
      })) input.pause();
    } catch { void close('Chromeへの応答送信に失敗しました。', 1); }
  }

  function receive(message) {
    if (closing) return false;
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || typeof message.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(message.id)) {
      void close('リクエストIDが不正です。', 1);
      return false;
    }
    if (seen.has(message.id) || seen.size >= MAX_REQUESTS) {
      void close('リクエストIDが重複しているか、接続のリクエスト数が上限を超えています。', 1);
      return false;
    }
    seen.add(message.id);
    if (message.type === 'health') {
      send({ id: message.id, ok: true, providers: ['copilot', 'codex'] });
    } else if (message.type === 'models' && ['copilot', 'codex'].includes(message.provider)) {
      if (active.size >= 2) send({ id: message.id, ok: false, error: '処理が混み合っています。しばらく待ってから再実行してください。' });
      else startOperation(message, true);
    } else if (!['generate', 'generate_prompt'].includes(message.type) || !validGeneration(message)) {
      send({ id: message.id, ok: false, error: '操作、プロバイダー、モデル、または送信内容が不正です。長い課題はコメント件数を減らしてください。' });
    } else if (active.size >= 2) {
      send({ id: message.id, ok: false, error: '処理が混み合っています。しばらく待ってから再実行してください。' });
    } else {
      startOperation(message, false);
    }
    return !closing;
  }

  function startOperation(message, listing) {
    const controller = new AbortController();
    const generatingPrompt = message.type === 'generate_prompt';
    let progressEnded = false;
    let progressCount = 0;
    const onProgress = event => {
      if (listing || message.progress !== true || progressEnded || closing || controller.signal.aborted || progressCount >= MAX_PROGRESS_EVENTS) return;
      // Copy only public status metadata. A future generator must not expose
      // reasoning, reference bodies, credentials, or raw errors through this path.
      let progress;
      try { progress = safeProgress(event, message.backlog?.apiKey); } catch { return; }
      if (!progress) return;
      progressCount++;
      send({ id: message.id, type: 'progress', progress });
    };
    const cancelledMessage = listing ? 'モデル一覧の取得が中断またはタイムアウトしました。ログイン状態を確認して再取得してください。' : CANCELLED;
    let cancel;
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(new Error(cancelledMessage));
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new Error(cancelledMessage)), listing ? modelTimeoutMs : timeoutMs);
    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error(cancelledMessage);
      if (listing) return listModels({ provider: message.provider, signal: controller.signal });
      if (generatingPrompt) {
        onProgress({stage: 'generating'});
        return generate({provider: message.provider, model: message.model || undefined, purpose: 'prompt',
          prompt: message.prompt, signal: controller.signal});
      }
      if (message.mode === 'agent') return generateAgent({provider: message.provider, model: message.model || undefined,
        prompt: message.prompt, backlog: message.backlog, signal: controller.signal,
        ...(message.progress === true ? {onProgress} : {})});
      onProgress({stage: 'generating'});
      return generate({ provider: message.provider, model: message.model || undefined,
        prompt: GUARD + message.prompt, signal: controller.signal });
    });
    active.set(message.id, { controller, operation });
    // Keep the slot while a timed-out provider is cleaning up its child process.
    void operation.then(release, release);
    function release() {
      progressEnded = true;
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancel);
      active.delete(message.id);
    }
    void Promise.race([operation, cancelled]).then(text => {
      progressEnded = true;
      if (listing) { send({ id: message.id, ok: true, models: modelCatalog(text) }); return; }
      const agentResult = message.mode === 'agent' ? text : null;
      if (agentResult) text = agentResult.text;
      if (typeof text !== 'string' || !text.trim()) throw new Error(generatingPrompt ? 'AIからプロンプト本文が返りませんでした。' : 'AIから返信本文が返りませんでした。');
      if (generatingPrompt && text.length > MAX_GENERATED_PROMPT) throw new Error('生成されたプロンプトが12,000文字を超えました。条件を短くして再実行してください。');
      if (!generatingPrompt && text.length > MAX_REPLY) throw new Error('生成文が長すぎます。短い返信を指定して再実行してください。');
      send({ id: message.id, ok: true, text: text.trim(), ...(agentResult ? {
        sources: Array.isArray(agentResult.sources) ? agentResult.sources.slice(0, 60) : [],
        toolCalls: Number.isInteger(agentResult.toolCalls) ? agentResult.toolCalls : 0
      } : {}) });
    }).catch(error => {
      progressEnded = true;
      let detail = String(error?.message || '生成に失敗しました。');
      if (message.mode === 'agent' && message.backlog?.apiKey) detail = detail.split(message.backlog.apiKey).join('[redacted]');
      send({ id: message.id, ok: false, error: detail.slice(0, 600) });
    });
  }

  const decoder = createDecoder(receive);
  function onData(chunk) {
    try { decoder.push(chunk); }
    catch (error) { void close(error.message, 1); }
  }
  function onEnd() {
    try { decoder.finish(); void close(); }
    catch (error) { void close(error.message, 1); }
  }
  function onInputClose() { void close(); }
  input.on('data', onData);
  input.once('end', onEnd);
  input.once('close', onInputClose);
  input.on('error', () => { void close('Chromeからの入力を読み取れませんでした。', 1); });
  output.on('error', () => { void close('Chromeへの応答送信に失敗しました。', 1); });
  output.on('close', () => { void close(); });
  output.on('drain', () => { if (!closing) input.resume(); });
  return { done, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Reserve stdout exclusively for framed protocol messages, including logs
  // emitted through console by future provider dependencies.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node.js 22.12以降をインストールしてください。');
    const host = createNativeHost(parseNativeArguments(process.argv.slice(2)));
    process.once('SIGINT', () => { void host.close(); });
    process.once('SIGTERM', () => { void host.close(); });
    process.once('SIGHUP', () => { void host.close(); });
    // All providers have been cancelled and given time to clean up before exit.
    // Explicit exit also releases stdin after a termination signal on Windows.
    void host.done.then(code => process.exit(code));
  } catch (error) {
    console.error(`${HOST_NAME}: ${error.message}`);
    process.exitCode = 1;
  }
}
