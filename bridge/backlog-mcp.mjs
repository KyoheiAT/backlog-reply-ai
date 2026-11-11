import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const READ_TOOLS = ['get_project', 'get_issues', 'get_issue', 'get_issue_comments'];
const PROJECT_KEY = /^[A-Z0-9_]{1,100}$/;
const ISSUE_KEY = /^([A-Z0-9_]{1,100})-[1-9][0-9]{0,10}$/;
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_SESSION_OUTPUT = 16 * 1024 * 1024;
const ALLOWED_ARGUMENTS = {
  get_project: ['projectKey', 'projectId'],
  get_issue: ['issueKey', 'issueId'],
  get_issue_comments: ['issueKey', 'issueId', 'count', 'order', 'minId', 'maxId'],
  get_issues: ['projectId', 'keyword', 'count', 'offset', 'sort', 'order', 'statusId', 'assigneeId', 'issueTypeId', 'priorityId', 'createdSince', 'createdUntil', 'updatedSince', 'updatedUntil', 'dueDateSince', 'dueDateUntil'],
};
const failure = () => new Error('Backlog MCPの読み取りに失敗しました。APIキー、閲覧権限、接続状態を確認してください。');
const scopeError = () => new Error('指定された課題・プロジェクトの参照範囲外です。');
const aborted = () => Object.assign(new Error('Backlog MCPの読み取りを中止しました。'), { name: 'AbortError' });
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function validateBacklogScope({ origin, apiKey, issueKeys, projectKeys, maxToolCalls = 6, excludedComment }) {
  const hostPattern = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:backlog\.(?:com|jp)|backlogtool\.com))\/?$/i;
  const match = typeof origin === 'string' && origin.match(hostPattern);
  if (!match) throw new Error('BacklogのHTTPSスペースURLを指定してください（ポート・パス指定は不可）。');
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512 || /[\r\n\0]/.test(apiKey)) throw new Error('有効なBacklog APIキーが必要です。');
  if (!Array.isArray(issueKeys) || issueKeys.length < 1 || issueKeys.length > 6 || issueKeys.some(key => typeof key !== 'string' || !ISSUE_KEY.test(key))) {
    throw new Error('参照課題キーは現在の課題を含め1〜6件で指定してください。');
  }
  if (!Array.isArray(projectKeys) || projectKeys.length > 4 || projectKeys.some(key => typeof key !== 'string' || !PROJECT_KEY.test(key))) {
    throw new Error('参照プロジェクトキーは0〜4件で指定してください。');
  }
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 6) throw new Error('MCPの読み取り回数は1〜6回で指定してください。');
  if (excludedComment !== undefined && (!plainObject(excludedComment)
    || Object.keys(excludedComment).some(key => !['issueKey', 'commentId'].includes(key))
    || !issueKeys.includes(excludedComment.issueKey) || !positiveId(excludedComment.commentId))) {
    throw new Error('テスト用の除外コメントを確認してください。');
  }
  return { origin: `https://${match[1].toLowerCase()}`, domain: match[1].toLowerCase(), apiKey: apiKey.trim(),
    issueKeys: new Set(issueKeys), projectKeys: new Set(projectKeys), maxToolCalls,
    ...(excludedComment ? { excludedComment: { issueKey: excludedComment.issueKey, commentId: excludedComment.commentId } } : {}) };
}

export function backlogEnvironment(source, directory, scope) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (['SYSTEMROOT', 'WINDIR'].includes(key.toUpperCase()) && value !== undefined) result[key] = value;
  }
  // This is a child-only environment, not a change to the user's environment.
  // Empty cwd/home prevents .env and .backlog-mcp-serverrc discovery.
  return { ...result, HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    TMP: directory, TEMP: directory, TMPDIR: directory, NODE_ENV: 'production', LOG_LEVEL: 'silent',
    BACKLOG_DOMAIN: scope.domain, BACKLOG_API_KEY: scope.apiKey, ENABLE_TOOLSETS: scope.projectKeys.size ? 'project,issue' : 'issue',
    MCP_TRANSPORT: 'stdio', PREFIX: '', OPTIMIZE_RESPONSE: 'false', MAX_TOKENS: '500000' };
}

async function officialEntry() {
  const packagePath = require.resolve('backlog-mcp-server/package.json');
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
  if (metadata.name !== 'backlog-mcp-server' || metadata.version !== '0.23.3') {
    throw new Error('対応する公式backlog-mcp-server（0.23.3）をnpm installで導入してください。');
  }
  return path.join(path.dirname(packagePath), 'build', 'index.js');
}

function terminate(child, { platform, spawnImpl, env }) {
  if (platform === 'win32' && child.pid) {
    const root = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
    if (root) {
      try {
        const killer = spawnImpl(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
        killer.once('close', code => { if (code !== 0) child.kill(); });
        return;
      } catch { /* Fall back only to the process owned by this client. */ }
    }
  }
  if (platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { }
  }
  child.kill('SIGKILL');
}

function openProtocol({ entry, directory, env, signal, spawnImpl, platform, toolTimeoutMs }) {
  const child = spawnImpl(process.execPath, [entry, '--transport', 'stdio'], {
    cwd: directory, env, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0;
  let pending;
  let partial = '';
  let totalBytes = 0;
  let errorBytes = 0;
  let closed = false;
  let closing;
  let stopTimer;
  let forceTimer;
  let finishClose;
  const ended = new Promise(resolve => { finishClose = resolve; });
  const rejectPending = error => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(error);
    pending = undefined;
  };
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      rejectPending(aborted());
      signal?.removeEventListener('abort', onAbort);
      if (!closed) {
        child.stdin.end();
        stopTimer = setTimeout(() => terminate(child, { platform, spawnImpl, env }), 300);
        forceTimer = setTimeout(finishClose, 2500);
      }
      await ended;
      clearTimeout(stopTimer);
      clearTimeout(forceTimer);
    })();
    return closing;
  };
  const fail = error => { rejectPending(error); void close(); };
  const onAbort = () => fail(aborted());
  const write = message => child.stdin.write(JSON.stringify(message) + '\n', 'utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    totalBytes += Buffer.byteLength(chunk);
    partial += chunk;
    if (totalBytes > MAX_SESSION_OUTPUT || Buffer.byteLength(partial) > MAX_FRAME) {
      fail(new Error('Backlog MCPの応答サイズが上限を超えました。')); return;
    }
    const lines = partial.split('\n');
    partial = lines.pop();
    for (const line of lines) {
      if (!line.trim() || closing) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(failure()); return; }
      if (!plainObject(message)) { fail(failure()); return; }
      if (message.method && message.id !== undefined) {
        // The server may not request filesystem roots, sampling, elicitation,
        // credentials, or any action from this strictly read-only client.
        try { write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client requests are not supported.' } }); }
        catch { fail(failure()); }
        continue;
      }
      if (!pending || message.id !== pending.id) continue;
      const current = pending;
      pending = undefined;
      clearTimeout(current.timer);
      if (message.error || !Object.hasOwn(message, 'result')) current.reject(failure());
      else current.resolve(message.result);
    }
  });
  // Never retain, print, or forward server diagnostics: API URLs may contain keys.
  child.stderr.on('data', chunk => {
    errorBytes += Buffer.byteLength(chunk);
    if (errorBytes > 65536) fail(failure());
  });
  child.stdin.on('error', () => fail(failure()));
  child.once('error', () => { closed = true; fail(failure()); finishClose(); });
  child.once('close', () => { closed = true; rejectPending(failure()); finishClose(); });
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    request(method, params = {}) {
      if (signal?.aborted) return Promise.reject(aborted());
      if (closing || closed || pending) return Promise.reject(failure());
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => fail(new Error('Backlog MCPの読み取りがタイムアウトしました。')), toolTimeoutMs);
        pending = { id, resolve, reject, timer };
        try { write({ jsonrpc: '2.0', id, method, params }); } catch { fail(failure()); }
      });
    },
    notify(method) { if (!closed && !closing) write({ jsonrpc: '2.0', method, params: {} }); },
    close,
    isClosed: () => closed,
  };
}

function toolData(result) {
  if (!plainObject(result) || result.isError || !Array.isArray(result.content)) throw failure();
  const texts = result.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text);
  if (texts.length !== 1) throw failure();
  try { return JSON.parse(texts[0]); } catch { throw new Error('Backlogの応答を安全に確認できませんでした。対象や件数を絞ってください。'); }
}

function short(value, length) { return typeof value === 'string' ? value.slice(0, length) : ''; }
function summarizeIssue(issue, list = false) {
  return { id: issue.id, issueKey: issue.issueKey, projectId: issue.projectId, summary: short(issue.summary, 500),
    description: short(issue.description, list ? 1000 : 6500), status: short(issue.status?.name, 100),
    assignee: short(issue.assignee?.name, 100), created: short(issue.created, 50), updated: short(issue.updated, 50), dueDate: short(issue.dueDate, 50) };
}

function exposeTool(tool, scope) {
  if (!plainObject(tool.inputSchema) || !plainObject(tool.inputSchema.properties)) throw failure();
  const properties = {};
  for (const key of ALLOWED_ARGUMENTS[tool.name]) {
    if (tool.inputSchema.properties[key]) properties[key] = structuredClone(tool.inputSchema.properties[key]);
  }
  const keyName = tool.name === 'get_project' ? 'projectKey' : 'issueKey';
  if (tool.name !== 'get_issues' && !properties[keyName]) throw failure();
  if (tool.name === 'get_issues' && !properties.projectId) throw failure();
  if (properties.count) { properties.count.minimum = 1; properties.count.maximum = tool.name === 'get_issues' ? 10 : 20; }
  for (const key of ['count', 'offset', 'issueId', 'projectId', 'minId', 'maxId']) {
    if (properties[key] && properties[key].type !== 'array') properties[key].type = 'integer';
  }
  if (properties.sort) properties.sort.enum = ['updated', 'created', 'dueDate', 'priority', 'status', 'summary'];
  if (properties.projectKey) properties.projectKey.enum = [...scope.projectKeys];
  if (properties.issueKey && !scope.projectKeys.size) properties.issueKey.enum = [...scope.issueKeys];
  const inputSchema = { type: 'object', properties, additionalProperties: false };
  if (tool.name === 'get_project') inputSchema.oneOf = [{ required: ['projectKey'] }, { required: ['projectId'] }];
  if (['get_issue', 'get_issue_comments'].includes(tool.name)) inputSchema.oneOf = [{ required: ['issueKey'] }, { required: ['issueId'] }];
  const scopeDescription = scope.projectKeys.size
    ? 'get_issuesのprojectIdを省略すると選択プロジェクト全体に限定。'
    : '明示した課題キーのみ参照可能。同じプロジェクトの別課題も対象外。';
  return { name: tool.name, description: `${short(tool.description, 1000)}\n選択範囲のみ参照可能。数値IDは先の取得結果で確認済みのものだけ使用。${scopeDescription}`, inputSchema };
}

export function createBacklogMcpFactory({ spawnImpl = spawn, resolveEntry = officialEntry, env = process.env,
  platform = process.platform, toolTimeoutMs = 45_000 } = {}) {
  return async function create(options) {
    const scope = validateBacklogScope(options);
    const signal = options.signal;
    if (signal?.aborted) throw aborted();
    const entry = await resolveEntry();
    const tempRoot = path.resolve(tmpdir());
    const directory = await mkdtemp(path.join(tempRoot, 'backlog-mcp-'));
    let protocol;
    let closePromise;
    const close = () => closePromise ||= (async () => {
      await protocol?.close();
      if ((!protocol || protocol.isClosed()) && path.dirname(path.resolve(directory)) === tempRoot && path.basename(directory).startsWith('backlog-mcp-')) {
        await rm(directory, { recursive: true, force: true });
      }
    })();
    try {
      protocol = openProtocol({ entry, directory, env: backlogEnvironment(env, directory, scope), signal, spawnImpl, platform, toolTimeoutMs });
      const initialized = await protocol.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'backlog-ai-reply', version: '1.3.0' } });
      if (!plainObject(initialized) || !['2025-03-26', '2025-06-18', '2025-11-25', '2024-11-05'].includes(initialized.protocolVersion)) throw failure();
      protocol.notify('notifications/initialized');
      const catalog = [];
      let cursor;
      const seenCursors = new Set();
      for (let page = 0; page < 5; page++) {
        const result = await protocol.request('tools/list', cursor ? { cursor } : {});
        if (!Array.isArray(result?.tools) || result.tools.length > 300) throw failure();
        catalog.push(...result.tools.filter(tool => READ_TOOLS.includes(tool?.name)));
        cursor = result.nextCursor;
        if (cursor === undefined || cursor === null) break;
        if (typeof cursor !== 'string' || !cursor || cursor.length > 1000 || seenCursors.has(cursor) || page === 4) throw failure();
        seenCursors.add(cursor);
      }
      const enabledTools = scope.projectKeys.size ? READ_TOOLS : ['get_issue', 'get_issue_comments'];
      const selectedTools = enabledTools.map(name => {
        const found = catalog.filter(tool => tool.name === name);
        if (found.length !== 1) throw new Error('必要な読み取り専用Backlog MCPツールが見つかりません。');
        return exposeTool(found[0], scope);
      });
      const projectIds = new Map();
      const knownIssues = new Map();
      const bootstrapped = new Set();
      let calls = 0;
      let queue = Promise.resolve();
      const rawCall = async (name, args) => toolData(await protocol.request('tools/call', { name, arguments: args }));
      const acceptProject = (data, key) => {
        if (!plainObject(data) || data.projectKey !== key || !positiveId(data.id) || !scope.projectKeys.has(key)) throw scopeError();
        if (projectIds.has(key) && projectIds.get(key) !== data.id) throw scopeError();
        if ([...projectIds].some(([otherKey, id]) => otherKey !== key && id === data.id)) throw scopeError();
        projectIds.set(key, data.id);
        return data;
      };
      const ensureProject = async key => {
        if (projectIds.has(key)) return projectIds.get(key);
        if (!scope.projectKeys.has(key) || bootstrapped.has(key) || bootstrapped.size >= 4) throw scopeError();
        bootstrapped.add(key); // A failed bootstrap is not automatically retried.
        return acceptProject(await rawCall('get_project', { projectKey: key }), key).id;
      };
      const allowedKey = key => typeof key === 'string' && ISSUE_KEY.test(key) && (scope.issueKeys.has(key) || scope.projectKeys.has(key.match(ISSUE_KEY)[1]));
      const acceptIssue = (data, expectedKey, allowedProjectIds) => {
        if (!plainObject(data) || !positiveId(data.id) || !positiveId(data.projectId) || !allowedKey(data.issueKey)) throw scopeError();
        if (expectedKey && data.issueKey !== expectedKey) throw scopeError();
        const projectKey = data.issueKey.match(ISSUE_KEY)[1];
        if (!scope.issueKeys.has(data.issueKey) && projectIds.get(projectKey) !== data.projectId) throw scopeError();
        if (allowedProjectIds && (!allowedProjectIds.includes(data.projectId) || projectIds.get(projectKey) !== data.projectId)) throw scopeError();
        const prior = knownIssues.get(data.id);
        if (prior && (prior.issueKey !== data.issueKey || prior.projectId !== data.projectId)) throw scopeError();
        knownIssues.set(data.id, { issueKey: data.issueKey, projectId: data.projectId });
        return data;
      };
      const sourceForIssue = issue => ({ title: `${issue.issueKey}${issue.summary ? ` ${short(issue.summary, 150)}` : ''}`, url: `${scope.origin}/view/${issue.issueKey}` });
      const redact = value => value.split(scope.apiKey).join('[REDACTED]').split(encodeURIComponent(scope.apiKey)).join('[REDACTED]');
      const resultFor = (data, sources) => {
        let text = redact(JSON.stringify(data, null, 2));
        if (text.length > 12000) text = text.slice(0, 11950) + '\n[長いため一部省略しました]';
        return { text, sources: sources.map(source => ({ title: redact(source.title), url: source.url })) };
      };
      const checkedArguments = (name, args) => {
        if (!READ_TOOLS.includes(name)) throw new Error('このMCPツールは許可されていません。読み取り専用ツールだけを利用できます。');
        // Empty project scope means explicit issues only. Never send an empty
        // projectId list: Backlog could interpret it as an unrestricted search.
        if (!enabledTools.includes(name)) throw scopeError();
        if (!plainObject(args) || Object.keys(args).some(key => !ALLOWED_ARGUMENTS[name].includes(key)) || JSON.stringify(args).length > 5000) throw scopeError();
        return structuredClone(args);
      };
      const boundedInt = (value, fallback, maximum, minimum = 1) => {
        if (value === undefined) return fallback;
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw scopeError();
        return value;
      };
      const read = async (name, supplied) => {
        if (signal?.aborted || closePromise) throw aborted();
        const args = checkedArguments(name, supplied);
        if (name === 'get_project') {
          if ((args.projectKey === undefined) === (args.projectId === undefined)) throw scopeError();
          let key = args.projectKey;
          if (key !== undefined) { if (!scope.projectKeys.has(key)) throw scopeError(); }
          else {
            if (!positiveId(args.projectId)) throw scopeError();
            key = [...projectIds].find(([, id]) => id === args.projectId)?.[0];
            if (!key) throw scopeError();
          }
          const data = acceptProject(await rawCall(name, { projectKey: key }), key);
          return resultFor({ id: data.id, projectKey: key, name: short(data.name, 500), archived: data.archived === true },
            [{ title: `${key} ${short(data.name, 150)}`.trim(), url: `${scope.origin}/projects/${key}` }]);
        }
        if (name === 'get_issues') {
          args.count = boundedInt(args.count, 10, 10);
          args.offset = boundedInt(args.offset, 0, 1000, 0);
          if (args.keyword !== undefined && (typeof args.keyword !== 'string' || args.keyword.length > 200)) throw scopeError();
          for (const field of ['statusId', 'assigneeId', 'issueTypeId', 'priorityId']) {
            if (args[field] !== undefined && (!Array.isArray(args[field]) || args[field].length > 10 || !args[field].every(positiveId))) throw scopeError();
          }
          for (const field of ['createdSince', 'createdUntil', 'updatedSince', 'updatedUntil', 'dueDateSince', 'dueDateUntil']) {
            if (args[field] !== undefined && (typeof args[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args[field]))) throw scopeError();
          }
          if (args.sort !== undefined && !['updated', 'created', 'dueDate', 'priority', 'status', 'summary'].includes(args.sort)) throw scopeError();
          if (args.order !== undefined && !['asc', 'desc'].includes(args.order)) throw scopeError();
          if (args.projectId !== undefined && (!Array.isArray(args.projectId) || !args.projectId.length || args.projectId.length > 4 || !args.projectId.every(positiveId))) throw scopeError();
          for (const key of scope.projectKeys) await ensureProject(key);
          const allowedIds = [...projectIds.values()];
          if (args.projectId?.some(id => !allowedIds.includes(id))) throw scopeError();
          args.projectId = args.projectId ? [...new Set(args.projectId)] : allowedIds;
          args.order ||= 'desc';
          args.sort ||= 'updated';
          const data = await rawCall(name, args);
          if (!Array.isArray(data) || data.length > args.count) throw scopeError();
          const issues = data.map(issue => acceptIssue(issue, undefined, args.projectId));
          return resultFor(issues.map(issue => summarizeIssue(issue, true)), issues.map(sourceForIssue));
        }
        if ((args.issueKey === undefined) === (args.issueId === undefined)) throw scopeError();
        let key = args.issueKey;
        if (key !== undefined) {
          if (!allowedKey(key)) throw scopeError();
        } else {
          if (!positiveId(args.issueId) || !knownIssues.has(args.issueId)) throw scopeError();
          key = knownIssues.get(args.issueId).issueKey;
        }
        if (!scope.issueKeys.has(key)) await ensureProject(key.match(ISSUE_KEY)[1]);
        delete args.issueId;
        args.issueKey = key; // Use the previously verified key, never an arbitrary numeric path.
        if (name === 'get_issue') {
          const issue = acceptIssue(await rawCall(name, args), key);
          return resultFor(summarizeIssue(issue), [sourceForIssue(issue)]);
        }
        args.count = boundedInt(args.count, 20, 20);
        if (args.order !== undefined && !['asc', 'desc'].includes(args.order)) throw scopeError();
        args.order ||= 'desc';
        for (const field of ['minId', 'maxId']) if (args[field] !== undefined && !positiveId(args[field])) throw scopeError();
        const comments = await rawCall(name, args);
        if (!Array.isArray(comments) || comments.length > args.count) throw scopeError();
        const knownIssue = [...knownIssues.values()].find(issue => issue.issueKey === key);
        const knownId = [...knownIssues].find(([, issue]) => issue.issueKey === key)?.[0];
        const projectId = knownIssue?.projectId ?? projectIds.get(key.match(ISSUE_KEY)[1]);
        for (const comment of comments) {
          if (!plainObject(comment) || !positiveId(comment.id)) throw scopeError();
          if (comment.projectId !== undefined && (!positiveId(comment.projectId) || (projectId !== undefined && comment.projectId !== projectId))) throw scopeError();
          if (comment.issueId !== undefined && (!positiveId(comment.issueId) || (knownId !== undefined && comment.issueId !== knownId))) throw scopeError();
        }
        // Apply the test exclusion after validating the response and resolving
        // numeric issue IDs, but before any text is truncated or serialized.
        // Re-reading another page/order cannot put the held-out answer back.
        const visibleComments = scope.excludedComment?.issueKey === key
          ? comments.filter(comment => comment.id !== scope.excludedComment.commentId) : comments;
        return resultFor(visibleComments.map(comment => ({ id: comment.id, body: short(comment.content, 2500),
          author: short(comment.createdUser?.name, 100), created: short(comment.created, 50) })), [{ title: `${key} コメント`, url: `${scope.origin}/view/${key}` }]);
      };
      return {
        tools: selectedTools,
        callTool(name, args = {}) {
          calls++; // Scope denials and failed calls consume the same budget.
          if (calls > scope.maxToolCalls) return Promise.reject(new Error('Backlog MCPの読み取り回数上限に達しました。'));
          const operation = queue.then(() => read(name, args));
          queue = operation.catch(() => {});
          return operation;
        },
        close,
      };
    } catch (error) {
      await close();
      if (signal?.aborted) throw aborted();
      // Locally generated validation errors are safe; protocol errors never
      // include server-returned diagnostics, API URLs, or credentials.
      throw error;
    }
  };
}

export const createBacklogMcp = createBacklogMcpFactory();
