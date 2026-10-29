import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { access } from 'node:fs/promises';
import { createBacklogMcpFactory, validateBacklogScope } from '../bridge/backlog-mcp.mjs';

const options = { origin: 'https://example.backlog.com', apiKey: 'synthetic-secret-value', issueKeys: ['DEMO-1'], projectKeys: ['DEMO'] };
const project = (key = 'DEMO', id = 10) => ({ id, projectKey: key, name: `Project ${key}` });
const issue = (key = 'DEMO-1', id = 101, projectId = 10, extra = {}) => ({ id, projectId, issueKey: key, summary: 'Test issue', description: 'Details', ...extra });
const schema = fields => ({ type: 'object', properties: Object.fromEntries(fields.map(field => [field,
  field === 'projectId' || field.endsWith('Id') ? { type: 'number' } : { type: 'string' }])) });
const catalog = [
  { name: 'get_project', description: 'Project', inputSchema: schema(['projectKey', 'projectId', 'organization']) },
  { name: 'get_issue', description: 'Issue', inputSchema: schema(['issueKey', 'issueId', 'organization']) },
  { name: 'get_issue_comments', description: 'Comments', inputSchema: schema(['issueKey', 'issueId', 'count', 'order', 'minId', 'maxId']) },
  { name: 'get_issues', description: 'Issues', inputSchema: { ...schema(['keyword', 'count', 'offset', 'sort', 'order']), properties: {
    ...schema(['keyword', 'count', 'offset', 'sort', 'order', 'createdSince', 'createdUntil', 'updatedSince', 'updatedUntil', 'dueDateSince', 'dueDateUntil']).properties,
    ...Object.fromEntries(['projectId', 'statusId', 'assigneeId', 'issueTypeId', 'priorityId'].map(field => [field, { type: 'array', items: { type: 'number' } }])),
  } } },
  { name: 'add_issue', description: 'Forbidden write', inputSchema: schema(['summary']) },
  { name: 'get_wikis', description: 'Unselected read', inputSchema: schema(['projectId']) },
];
const response = (child, id, result) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const dataResponse = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

function setup({ onTool, onMessage, onList, closeOnEof = true, toolTimeoutMs = 1000, env = {}, platform = 'linux', failSpawn = false } = {}) {
  const spawns = [];
  const messages = [];
  const toolCalls = [];
  let kills = 0;
  const spawnImpl = (command, args, settings) => {
    if (command.endsWith('taskkill.exe')) {
      const killer = new EventEmitter();
      spawns.push({ command, args, settings, child: killer });
      queueMicrotask(() => { spawns[0].child.emit('close', null); killer.emit('close', 0); });
      return killer;
    }
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { kills++; queueMicrotask(() => child.emit('close', null)); return true; };
    if (platform === 'win32') child.pid = 198765;
    child.stdin = new Writable({ write(bytes, encoding, done) {
      for (const line of bytes.toString().trim().split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        messages.push(message);
        queueMicrotask(async () => {
          if (onMessage?.(child, message) === true) return;
          if (message.method === 'initialize') response(child, message.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
          else if (message.method === 'tools/list') {
            if (onList) onList(child, message); else response(child, message.id, { tools: catalog });
          } else if (message.method === 'tools/call') {
            toolCalls.push(message.params);
            const data = onTool ? await onTool(message.params.name, message.params.arguments, child, message) : project();
            if (data !== undefined) response(child, message.id, dataResponse(data));
          }
        });
      }
      done();
    } });
    child.stdin.on('finish', () => { if (closeOnEof) queueMicrotask(() => child.emit('close', 0)); });
    spawns.push({ command, args, settings, child });
    if (failSpawn) queueMicrotask(() => child.emit('error', new Error(options.apiKey)));
    return child;
  };
  const create = createBacklogMcpFactory({ spawnImpl, env, platform, toolTimeoutMs, resolveEntry: async () => '/official/backlog-mcp-server/build/index.js' });
  return { create, spawns, messages, toolCalls, get kills() { return kills; } };
}

async function open(t, fixture, overrides = {}) {
  const mcp = await fixture.create({ ...options, ...overrides });
  t.after(() => mcp.close());
  return mcp;
}

test('scope accepts only HTTPS tenant origins and bounded explicit keys', () => {
  assert.equal(validateBacklogScope({ ...options, origin: 'https://Example.backlog.jp/' }).origin, 'https://example.backlog.jp');
  assert.equal(validateBacklogScope({ ...options, origin: 'https://tenant.backlogtool.com' }).domain, 'tenant.backlogtool.com');
  assert.equal(validateBacklogScope({ ...options, projectKeys: [] }).projectKeys.size, 0);
  for (const origin of ['http://example.backlog.com', 'https://evil.example.backlog.com', 'https://example.backlog.com.evil.test',
    'https://example.backlog.com:443', 'https://user@example.backlog.com', 'https://example.backlog.com/api', 'https://example.backlog.com?x=1']) {
    assert.throws(() => validateBacklogScope({ ...options, origin }));
  }
  for (const patch of [{ issueKeys: [] }, { projectKeys: undefined }, { issueKeys: ['../other'] }, { projectKeys: ['DEMO/path'] },
    { issueKeys: Array(7).fill('DEMO-1') }, { projectKeys: Array(5).fill('DEMO') }, { maxToolCalls: 7 }, { apiKey: 'key\r\nvalue' }]) {
    assert.throws(() => validateBacklogScope({ ...options, ...patch }));
  }
});

test('initialization exposes only four published read schemas and never contacts Backlog', async t => {
  const fixture = setup({ env: { SystemRoot: 'C:\\Windows', PATH: 'unsafe', NODE_OPTIONS: '--import=unsafe', OPENAI_API_KEY: 'other-secret',
    BACKLOG_ORG_OTHER_DOMAIN: 'other.backlog.com', BACKLOG_ORG_OTHER_API_KEY: 'other-secret', HTTPS_PROXY: 'https://other.invalid', HOME: 'real-user' } });
  const mcp = await open(t, fixture);
  assert.deepEqual(fixture.messages.map(message => message.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.deepEqual(mcp.tools.map(tool => tool.name), ['get_project', 'get_issues', 'get_issue', 'get_issue_comments']);
  assert.equal(fixture.toolCalls.length, 0);
  const child = fixture.spawns[0];
  assert.equal(child.command, process.execPath);
  assert.deepEqual(child.args, ['/official/backlog-mcp-server/build/index.js', '--transport', 'stdio']);
  assert.equal(child.settings.shell, false);
  assert.equal(child.settings.windowsHide, true);
  assert.equal(child.settings.env.BACKLOG_API_KEY, options.apiKey);
  assert.equal(child.settings.env.BACKLOG_DOMAIN, 'example.backlog.com');
  assert.equal(child.settings.env.ENABLE_TOOLSETS, 'project,issue');
  assert.equal(child.settings.env.HOME, child.settings.cwd);
  assert.equal(child.settings.env.USERPROFILE, child.settings.cwd);
  for (const key of ['NODE_OPTIONS', 'PATH', 'OPENAI_API_KEY', 'BACKLOG_ORG_OTHER_DOMAIN', 'BACKLOG_ORG_OTHER_API_KEY', 'HTTPS_PROXY']) assert.equal(child.settings.env[key], undefined);
  assert.ok(!JSON.stringify(fixture.messages).includes(options.apiKey));
  assert.equal(mcp.tools[0].inputSchema.properties.organization, undefined);
  assert.deepEqual(mcp.tools[0].inputSchema.properties.projectKey.enum, ['DEMO']);
  assert.equal(mcp.tools[1].inputSchema.properties.count.maximum, 10);
  await mcp.close();
  await assert.rejects(access(child.settings.cwd), { code: 'ENOENT' });
});

test('selected projects resolve once and every list call carries only their IDs and count <= 10', async t => {
  const fixture = setup({ onTool: (name, args) => name === 'get_project' ? project(args.projectKey, args.projectKey === 'DEMO' ? 10 : 20) : [issue()] });
  const mcp = await open(t, fixture, { projectKeys: ['DEMO', 'SECOND'] });
  const result = await mcp.callTool('get_issues', { keyword: 'test' });
  assert.deepEqual(fixture.toolCalls.map(call => call.name), ['get_project', 'get_project', 'get_issues']);
  assert.deepEqual(fixture.toolCalls[2].arguments, { keyword: 'test', projectId: [10, 20], count: 10, offset: 0, order: 'desc', sort: 'updated' });
  assert.deepEqual(result.sources, [{ title: 'DEMO-1 Test issue', url: 'https://example.backlog.com/view/DEMO-1' }]);
  await mcp.callTool('get_issues', { projectId: [10], count: 1 });
  assert.equal(fixture.toolCalls.filter(call => call.name === 'get_project').length, 2);
  await assert.rejects(mcp.callTool('get_issues', { projectId: [999] }), /参照範囲外/);
  await assert.rejects(mcp.callTool('get_issues', { count: 11 }), /参照範囲外/);
  assert.equal(fixture.toolCalls.filter(call => call.name === 'get_issues').length, 2);
});

test('empty project scope exposes only explicitly selected issues and their comments', async t => {
  const fixture = setup({
    onList: (child, request) => response(child, request.id, { tools: catalog.filter(tool => ['get_issue', 'get_issue_comments'].includes(tool.name)) }),
    onTool: name => name === 'get_issue' ? issue() : [{ id: 1, issueId: 101, projectId: 10, content: 'Scoped comment' }],
  });
  const mcp = await open(t, fixture, { projectKeys: [] });
  assert.deepEqual(mcp.tools.map(tool => tool.name), ['get_issue', 'get_issue_comments']);
  assert.equal(fixture.spawns[0].settings.env.ENABLE_TOOLSETS, 'issue');
  for (const tool of mcp.tools) assert.deepEqual(tool.inputSchema.properties.issueKey.enum, ['DEMO-1']);
  const result = await mcp.callTool('get_issue', { issueKey: 'DEMO-1' });
  assert.ok(result.text.includes('DEMO-1'));
  await mcp.callTool('get_issue_comments', { issueKey: 'DEMO-1' });
  await mcp.callTool('get_issue_comments', { issueId: 101 });
  assert.deepEqual(fixture.toolCalls.map(call => call.name), ['get_issue', 'get_issue_comments', 'get_issue_comments']);
  assert.ok(fixture.toolCalls.every(call => call.arguments.issueKey === 'DEMO-1'));
});

test('empty project scope rejects search and project lookup before any API call', async t => {
  const fixture = setup();
  const mcp = await open(t, fixture, { projectKeys: [] });
  for (const [name, args] of [
    ['get_issues', {}], ['get_issues', { projectId: [] }], ['get_issues', { projectId: [10] }],
    ['get_project', { projectKey: 'DEMO' }], ['get_project', { projectId: 10 }],
  ]) await assert.rejects(mcp.callTool(name, args), /参照範囲外/);
  assert.equal(fixture.toolCalls.length, 0);
});

test('empty project scope rejects other issues even within the same project', async t => {
  const fixture = setup({ onTool: () => issue() });
  const mcp = await open(t, fixture, { projectKeys: [] });
  for (const [name, args] of [
    ['get_issue', { issueKey: 'DEMO-2' }], ['get_issue_comments', { issueKey: 'DEMO-2' }],
    ['get_issue', { issueKey: 'OTHER-1' }], ['get_issue', { issueId: 101 }],
  ]) await assert.rejects(mcp.callTool(name, args), /参照範囲外/);
  assert.equal(fixture.toolCalls.length, 0);
  await mcp.callTool('get_issue', { issueKey: 'DEMO-1' });
  await mcp.callTool('get_issue', { issueId: 101 });
  assert.deepEqual(fixture.toolCalls.map(call => call.arguments), [{ issueKey: 'DEMO-1' }, { issueKey: 'DEMO-1' }]);
});

test('empty project scope can include explicitly selected issues from different projects', async t => {
  const fixture = setup({ onTool: (name, args) => args.issueKey === 'DEMO-1' ? issue() : issue('OTHER-4', 404, 40) });
  const mcp = await open(t, fixture, { issueKeys: ['DEMO-1', 'OTHER-4'], projectKeys: [] });
  await mcp.callTool('get_issue', { issueKey: 'DEMO-1' });
  const result = await mcp.callTool('get_issue', { issueKey: 'OTHER-4' });
  assert.deepEqual(result.sources, [{ title: 'OTHER-4 Test issue', url: 'https://example.backlog.com/view/OTHER-4' }]);
  assert.deepEqual(fixture.toolCalls.map(call => call.name), ['get_issue', 'get_issue']);
});

test('foreign tools, keys, unknown args and failed calls all consume the six-call budget', async t => {
  const fixture = setup();
  const mcp = await open(t, fixture);
  const denied = [ ['add_issue', { summary: 'write' }], ['get_wikis', {}], ['get_project', { projectKey: 'FOREIGN' }],
    ['get_issue', { issueKey: 'FOREIGN-1' }], ['get_issue_comments', { issueId: 999 }], ['get_issues', { organization: 'other' }] ];
  for (const [name, args] of denied) await assert.rejects(mcp.callTool(name, args));
  await assert.rejects(mcp.callTool('get_project', { projectKey: 'DEMO' }), /回数上限/);
  assert.equal(fixture.toolCalls.length, 0);
});

test('project numeric ID is allowed only after a matching selected project result', async t => {
  const fixture = setup({ onTool: () => project() });
  const mcp = await open(t, fixture);
  await assert.rejects(mcp.callTool('get_project', { projectId: 10 }), /参照範囲外/);
  await mcp.callTool('get_project', { projectKey: 'DEMO' });
  await mcp.callTool('get_project', { projectId: 10 });
  assert.deepEqual(fixture.toolCalls.map(call => call.arguments), [{ projectKey: 'DEMO' }, { projectKey: 'DEMO' }]);
});

test('explicit issue allows direct read and numeric IDs are converted to a verified key', async t => {
  const fixture = setup({ onTool: () => issue('OTHER-4', 404, 40) });
  const mcp = await open(t, fixture, { issueKeys: ['DEMO-1', 'OTHER-4'] });
  await assert.rejects(mcp.callTool('get_issue', { issueId: 404 }), /参照範囲外/);
  await mcp.callTool('get_issue', { issueKey: 'OTHER-4' });
  await mcp.callTool('get_issue', { issueId: 404 });
  assert.deepEqual(fixture.toolCalls.map(call => call.arguments), [{ issueKey: 'OTHER-4' }, { issueKey: 'OTHER-4' }]);
});

test('unlisted issue key in a selected project requires verified project ownership', async t => {
  let wrongProject = false;
  const fixture = setup({ onTool: name => name === 'get_project' ? project() : issue('DEMO-2', 102, wrongProject ? 90 : 10) });
  const mcp = await open(t, fixture);
  await mcp.callTool('get_issue', { issueKey: 'DEMO-2' });
  assert.deepEqual(fixture.toolCalls.map(call => call.name), ['get_project', 'get_issue']);
  wrongProject = true;
  await assert.rejects(mcp.callTool('get_issue', { issueKey: 'DEMO-2' }), /参照範囲外/);
});

test('mismatched issue identities and unselected list results never reach the model', async t => {
  const fixture = setup({ onTool: name => name === 'get_project' ? project() : name === 'get_issues' ? [issue('FOREIGN-1', 901, 90)] : issue('DEMO-2', 102) });
  const mcp = await open(t, fixture);
  await assert.rejects(mcp.callTool('get_issue', { issueKey: 'DEMO-1' }), /参照範囲外/);
  await assert.rejects(mcp.callTool('get_issues', {}), /参照範囲外/);
  await assert.rejects(mcp.callTool('get_issue', { issueId: 901 }), /参照範囲外/);
});

test('project bootstrap failure is not retried and mismatched project identity is rejected', async t => {
  const fixture = setup({ onTool: () => project('FOREIGN', 90) });
  const mcp = await open(t, fixture);
  await assert.rejects(mcp.callTool('get_issues', {}), /参照範囲外/);
  await assert.rejects(mcp.callTool('get_issues', {}), /参照範囲外/);
  assert.equal(fixture.toolCalls.length, 1);
});

test('comments have a bounded count, validated identity, and a generated source URL', async t => {
  let wrongIdentity = false;
  const fixture = setup({ onTool: name => name === 'get_issue' ? issue() : [{ id: 1, issueId: wrongIdentity ? 999 : 101, projectId: 10,
    content: 'Comment', createdUser: { name: 'Member', mailAddress: 'private@example.invalid' }, changeLog: { private: true }, created: '2026-01-01' }] });
  const mcp = await open(t, fixture);
  await mcp.callTool('get_issue', { issueKey: 'DEMO-1' });
  const result = await mcp.callTool('get_issue_comments', { issueId: 101 });
  assert.deepEqual(fixture.toolCalls[1].arguments, { issueKey: 'DEMO-1', count: 20, order: 'desc' });
  assert.ok(result.text.includes('Comment'));
  assert.ok(!result.text.includes('private'));
  assert.deepEqual(result.sources, [{ title: 'DEMO-1 コメント', url: 'https://example.backlog.com/view/DEMO-1' }]);
  await assert.rejects(mcp.callTool('get_issue_comments', { issueKey: 'DEMO-1', count: 21 }), /参照範囲外/);
  wrongIdentity = true;
  await assert.rejects(mcp.callTool('get_issue_comments', { issueKey: 'DEMO-1' }), /参照範囲外/);
});

test('untrusted fields and links are not followed, summaries are bounded, and echoed keys are redacted', async t => {
  const fixture = setup({ onTool: name => name === 'get_project' ? project() : Array.from({ length: 10 }, (_, n) => issue(`DEMO-${n + 1}`, 101 + n, 10, {
    summary: options.apiKey, description: `${options.apiKey} ${'long '.repeat(2000)} https://evil.invalid/read-me`,
    url: 'https://evil.invalid', attachments: [{ url: 'https://evil.invalid/private' }], createdUser: { mailAddress: 'private@example.invalid' },
  })) });
  const mcp = await open(t, fixture);
  const result = await mcp.callTool('get_issues', {});
  assert.ok(result.text.length <= 12000);
  assert.ok(!JSON.stringify(result).includes(options.apiKey));
  assert.ok(!result.text.includes('mailAddress'));
  assert.ok(!result.text.includes('attachments'));
  assert.ok(result.sources.every(source => source.url.startsWith(`${options.origin}/view/DEMO-`)));
  assert.deepEqual(fixture.toolCalls.map(call => call.name), ['get_project', 'get_issues']);
});

test('server tool errors never expose diagnostics or API credentials', async t => {
  const fixture = setup({ onTool: (name, args, child, request) => {
    child.stderr.write(`request failed https://example.backlog.com/api?apiKey=${options.apiKey}`);
    response(child, request.id, { isError: true, content: [{ type: 'text', text: options.apiKey }] });
  } });
  const mcp = await open(t, fixture, { maxToolCalls: 1 });
  await assert.rejects(mcp.callTool('get_issue', { issueKey: 'DEMO-1' }), error => !error.message.includes(options.apiKey) && /APIキー/.test(error.message));
  await assert.rejects(mcp.callTool('get_issue', { issueKey: 'DEMO-1' }), /回数上限/);
});

test('requests are correlated and server-initiated sampling is denied', async t => {
  const fixture = setup({ onTool: (name, args, child, request) => {
    response(child, request.id + 999, dataResponse(project('FOREIGN', 90)));
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'sampling-request', method: 'sampling/createMessage', params: { secret: options.apiKey } }) + '\n');
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { private: options.apiKey } }) + '\n');
    const message = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: dataResponse(project()) }) + '\n';
    child.stdout.write(message.slice(0, 25)); child.stdout.write(message.slice(25));
  } });
  const mcp = await open(t, fixture);
  const result = await mcp.callTool('get_project', { projectKey: 'DEMO' });
  assert.ok(result.text.includes('DEMO'));
  const denial = fixture.messages.find(message => message.id === 'sampling-request');
  assert.equal(denial.error.code, -32601);
  assert.ok(!JSON.stringify(fixture.messages).includes(options.apiKey));
});

test('simultaneous calls are serialized and close is idempotent', async t => {
  let active = 0;
  let peak = 0;
  const fixture = setup({ onTool: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--; return project();
  } });
  const mcp = await open(t, fixture);
  await Promise.all([mcp.callTool('get_project', { projectKey: 'DEMO' }), mcp.callTool('get_project', { projectKey: 'DEMO' })]);
  assert.equal(peak, 1);
  await Promise.all([mcp.close(), mcp.close()]);
  await assert.rejects(mcp.callTool('get_project', { projectKey: 'DEMO' }), { name: 'AbortError' });
});

test('aborted request terminates the owned process and removes isolated home', async t => {
  const controller = new AbortController();
  const fixture = setup({ onTool: () => undefined, closeOnEof: false });
  const mcp = await open(t, fixture, { signal: controller.signal });
  const operation = mcp.callTool('get_issue', { issueKey: 'DEMO-1' });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(operation, { name: 'AbortError' });
  await mcp.close();
  assert.equal(fixture.kills, 1);
  await assert.rejects(access(fixture.spawns[0].settings.cwd), { code: 'ENOENT' });
});

test('timeout on Windows kills only the owned process tree using an absolute executable', async t => {
  const fixture = setup({ onTool: () => undefined, closeOnEof: false, toolTimeoutMs: 15, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
  const mcp = await open(t, fixture);
  await assert.rejects(mcp.callTool('get_issue', { issueKey: 'DEMO-1' }), /タイムアウト/);
  await mcp.close();
  assert.equal(fixture.spawns[1].command, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(fixture.spawns[1].args, ['/PID', '198765', '/T', '/F']);
  assert.equal(fixture.spawns[1].settings.shell, false);
  assert.equal(fixture.spawns[1].settings.windowsHide, true);
});

test('malformed and oversized JSON-RPC output fails closed without leaking its contents', async t => {
  for (const output of [options.apiKey + '\n', JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }) + '\n']) {
    const fixture = setup({ onTool: (name, args, child) => { child.stdout.write(output); } });
    const mcp = await open(t, fixture);
    await assert.rejects(mcp.callTool('get_issue', { issueKey: 'DEMO-1' }), error => !error.message.includes(options.apiKey));
    await mcp.close();
    await assert.rejects(access(fixture.spawns[0].settings.cwd), { code: 'ENOENT' });
  }
});

test('invalid or truncated JSON tool payload is never forwarded as model text', async t => {
  const fixture = setup({ onTool: (name, args, child, request) => response(child, request.id, { content: [{ type: 'text', text: options.apiKey + '... truncated' }] }) && undefined });
  const mcp = await open(t, fixture);
  await assert.rejects(mcp.callTool('get_issue', { issueKey: 'DEMO-1' }), error => /安全に確認/.test(error.message) && !error.message.includes(options.apiKey));
});

test('duplicate catalog entries, repeated cursors and unsupported protocols fail before any API request', async () => {
  const variants = [
    { onList: (child, request) => response(child, request.id, { tools: [...catalog, catalog[0]] }) },
    { onList: (child, request) => response(child, request.id, { tools: catalog, nextCursor: 'same' }) },
    { onMessage: (child, message) => { if (message.method !== 'initialize') return false; response(child, message.id, { protocolVersion: 'unknown' }); return true; } },
  ];
  for (const variant of variants) {
    const fixture = setup(variant);
    await assert.rejects(fixture.create(options));
    assert.equal(fixture.toolCalls.length, 0);
    await assert.rejects(access(fixture.spawns[0].settings.cwd), { code: 'ENOENT' });
  }
});

test('startup failures are sanitized and abort before startup spawns nothing', async () => {
  const fixture = setup({ failSpawn: true });
  await assert.rejects(fixture.create(options), error => !error.message.includes(options.apiKey));
  await assert.rejects(access(fixture.spawns[0].settings.cwd), { code: 'ENOENT' });
  const controller = new AbortController(); controller.abort();
  const beforeStart = setup();
  await assert.rejects(beforeStart.create({ ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(beforeStart.spawns.length, 0);
});
