import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  HOST_NAME, REGISTRY_KEY, parseSetupArgs, supportsNode, nativeManifest,
  renderLauncher, parseRegistryValue, registryReadArgs, setupNative, execute,
} from '../scripts/setup-native.mjs';

const ID = 'gmapnijbahkdgphpeopgnmplopbpicka';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'backlog-native-test-日本語 space-')));
  const tempRoot = await realpath(tmpdir());
  await mkdir(path.join(root, 'bridge'));
  await writeFile(path.join(root, 'bridge', 'native-host.mjs'), '// fixture');
  return {
    root,
    manifestPath: path.join(root, '.native-host', `${HOST_NAME}.json`),
    async cleanup() {
      if (path.dirname(root) === tempRoot && path.basename(root).startsWith('backlog-native-test-')) {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

function mockCommands(initial = {}, { compileFails = false, actualCompiler = false } = {}) {
  const registry = new Map(Object.entries(initial));
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('/target:winexe')) {
      if (actualCompiler) return execute(command, args);
      if (compileFails) return { code: 1, stdout: 'compile failed', stderr: '' };
      await writeFile(args.find(value => value.startsWith('/out:')).slice(5), 'fake executable');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('-EncodedCommand')) {
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.ok(script.includes('UTF8Encoding'));
      assert.ok(script.includes('OpenBaseKey'));
      const view = script.includes('::Registry32') ? '32' : '64';
      return registry.has(view)
        ? { code: 0, stdout: JSON.stringify(registry.get(view)), stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
    }
    assert.equal(args[1], REGISTRY_KEY);
    const view = args.find(value => value.startsWith('/reg:')).slice(5);
    if (args[0] === 'add') {
      assert.ok(args.includes('/ve'));
      registry.set(view, args[args.indexOf('/d') + 1]);
    } else if (args[0] === 'delete') {
      assert.ok(args.includes('/ve'), 'must not delete the registry key');
      registry.delete(view);
    } else assert.fail(`Unexpected command: ${args}`);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls, registry };
}

function dependencies(root, run, extra = {}) {
  return {
    root, nodePath: process.execPath, nodeVersion: '22.12.0', platform: 'win32',
    env: { SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows' },
    discoverCodex: async () => { throw new Error('not installed'); }, run, ...extra,
  };
}

test('setup arguments accept exactly one valid Chrome ID or uninstall', () => {
  assert.deepEqual(parseSetupArgs(['--extension-id', ID]), { extensionId: ID, uninstall: false });
  assert.deepEqual(parseSetupArgs(['--uninstall']), { uninstall: true });
  for (const argv of [[], ['--extension-id', '*'], ['--extension-id', ID, '--uninstall'], ['--extension-id', 'a'.repeat(31) + 'z']]) {
    assert.throws(() => parseSetupArgs(argv), /32文字/);
  }
  assert.equal(supportsNode('22.11.0'), false);
  assert.equal(supportsNode('20.19.0'), false);
  assert.equal(supportsNode('22.12.0'), true);
  assert.equal(supportsNode('24.0.0'), true);
});

test('manifest allows only the specified extension and stores an absolute executable path', () => {
  const manifest = nativeManifest('C:\\日本語 space\\launcher.exe', ID);
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`]);
  assert.throws(() => nativeManifest('launcher.exe', ID), /絶対パス/);
});

test('C# source embeds paths as UTF-8 base64 without treating path text as source', () => {
  const rendered = renderLauncher('__NODE_BASE64__|__SCRIPT_BASE64__|__CODEX_BASE64__|__EXTENSION_ID__', {
    nodePath: 'C:\\Program Files\\node.exe', scriptPath: 'C:\\日本語 & special\\native-host.mjs', extensionId: ID,
    codexBin: 'C:\\Users\\Example\\codex.exe',
  });
  const values = rendered.split('|');
  assert.equal(Buffer.from(values[0], 'base64').toString(), 'C:\\Program Files\\node.exe');
  assert.equal(Buffer.from(values[1], 'base64').toString(), 'C:\\日本語 & special\\native-host.mjs');
  assert.equal(Buffer.from(values[2], 'base64').toString(), 'C:\\Users\\Example\\codex.exe');
  assert.equal(values[3], ID);
  assert.throws(() => renderLauncher('', { nodePath: 'node.exe', scriptPath: 'C:\\host.mjs', extensionId: ID }), /絶対パス/);
});

test('registry reads request explicit UTF-8 JSON and preserve Japanese paths', () => {
  assert.equal(parseRegistryValue(JSON.stringify('C:\\日本語 space\\manifest.json')), 'C:\\日本語 space\\manifest.json');
  assert.throws(() => parseRegistryValue('not json'), /確認できません/);
  assert.throws(() => parseRegistryValue('123'), /確認できません/);
  const encoded = registryReadArgs('32').at(-1);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(script.includes('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'));
  assert.ok(script.includes('ConvertTo-Json'));
  assert.throws(() => registryReadArgs('32; malicious'), /不正/);
});

test('registration compiles a windowless launcher and supports Copilot-only installs', { skip: process.platform !== 'win32' }, async () => {
  const files = await fixture();
  try {
    const mock = mockCommands();
    const result = await setupNative({ extensionId: ID }, dependencies(files.root, mock.run));
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(result.nodePath, process.execPath);
    assert.equal(result.codexBin, '');
    assert.equal(mock.registry.get('32'), files.manifestPath);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`]);
    assert.ok(mock.calls.some(call => call.args.includes('/target:winexe')));
    assert.ok(mock.calls.findIndex(call => call.args[0] === 'add') > mock.calls.findIndex(call => call.args.includes('/target:winexe')));
  } finally { await files.cleanup(); }
});

test('an existing foreign registration is neither overwritten nor removed', { skip: process.platform !== 'win32' }, async () => {
  const files = await fixture();
  try {
    const foreign = 'C:\\Another workspace\\.native-host\\com.backlog_ai.reply.json';
    const mock = mockCommands({ 32: foreign });
    await assert.rejects(setupNative({ extensionId: ID }, dependencies(files.root, mock.run)), /別のフォルダー/);
    const result = await setupNative({ uninstall: true }, dependencies(files.root, mock.run));
    assert.equal(result.uninstalled, false);
    assert.equal(result.preservedOtherRegistration, true);
    assert.equal(mock.registry.get('32'), foreign);
    assert.ok(mock.calls.every(call => call.args.includes('-EncodedCommand')));
  } finally { await files.cleanup(); }
});

test('uninstall deletes only an owned default value and preserves the other registry view', { skip: process.platform !== 'win32' }, async () => {
  const files = await fixture();
  try {
    const foreign = 'C:\\Another workspace\\host.json';
    const mock = mockCommands({ 32: files.manifestPath.toUpperCase(), 64: foreign });
    const result = await setupNative({ uninstall: true }, dependencies(files.root, mock.run));
    assert.equal(result.uninstalled, true);
    assert.equal(result.preservedOtherRegistration, true);
    assert.equal(mock.registry.has('32'), false);
    assert.equal(mock.registry.get('64'), foreign);
    assert.deepEqual(mock.calls.filter(call => call.args[0] === 'delete').map(call => call.args), [
      ['delete', REGISTRY_KEY, '/ve', '/f', '/reg:32'],
    ]);
  } finally { await files.cleanup(); }
});

test('a compiler failure does not change the registry', { skip: process.platform !== 'win32' }, async () => {
  const files = await fixture();
  try {
    const mock = mockCommands({}, { compileFails: true });
    await assert.rejects(setupNative({ extensionId: ID }, dependencies(files.root, mock.run)), /ランチャーの作成に失敗/);
    assert.ok(!mock.calls.some(call => call.args[0] === 'add'));
  } finally { await files.cleanup(); }
});

test('explicit invalid CODEX_BIN fails but does not fall back or register', { skip: process.platform !== 'win32' }, async () => {
  const files = await fixture();
  try {
    const mock = mockCommands();
    await assert.rejects(setupNative({ extensionId: ID }, dependencies(files.root, mock.run, {
      env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', CODEX_BIN: 'bad' },
      discoverCodex: async () => { throw new Error('invalid CODEX_BIN'); },
    })), /invalid CODEX_BIN/);
    assert.ok(!mock.calls.some(call => call.args[0] === 'add'));
  } finally { await files.cleanup(); }
});

test('compiled WinExe returns small binary frames before stdin EOF and preserves Unicode paths and Windows arguments', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const files = await fixture();
  try {
    await writeFile(path.join(files.root, 'bridge', 'native-host.mjs'),
      'process.stderr.write(JSON.stringify(process.argv.slice(2))); process.stdin.on("data",b=>process.stdout.write(b));');
    const mock = mockCommands({}, { actualCompiler: true });
    const result = await setupNative({ extensionId: ID }, dependencies(files.root, mock.run));
    await access(result.launcherPath);
    const chromeArgs = [`chrome-extension://${ID}/`, '--parent-window=0', 'a space and "quotes" ending\\'];
    const bytes = Buffer.from([0, 255, 10, 13, 128, 65, 0, 10]);
    const observed = await new Promise((resolve, reject) => {
      const child = spawn(result.launcherPath, chromeArgs, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = [];
      const errors = [];
      let failure;
      let receivedBeforeEof = false;
      const timer = setTimeout(() => {
        failure = new Error('Small native frame was buffered until stdin EOF.');
        child.kill('SIGKILL');
      }, 5000);
      child.stdout.on('data', chunk => {
        output.push(chunk);
        if (Buffer.concat(output).length >= bytes.length && !receivedBeforeEof) {
          receivedBeforeEof = !child.stdin.writableEnded;
          child.stdin.end();
        }
      });
      child.stderr.on('data', chunk => errors.push(chunk));
      child.stdin.on('error', () => {});
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else resolve({ code, receivedBeforeEof, output: Buffer.concat(output), error: Buffer.concat(errors).toString('utf8') });
      });
      // Keep the pipe open: Chrome connectNative does not send EOF for each
      // message. Only close after a complete response has actually arrived.
      child.stdin.write(bytes);
    });
    assert.equal(observed.code, 0, observed.error);
    assert.equal(observed.receivedBeforeEof, true);
    assert.deepEqual(observed.output, bytes);
    assert.deepEqual(JSON.parse(observed.error), ['--extension-id', ID, ...chromeArgs]);
  } finally { await files.cleanup(); }
});

test('terminating the launcher also terminates its Node child and descendant through the Windows Job Object', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const files = await fixture();
  let launcher;
  let children = [];
  const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await writeFile(path.join(files.root, 'bridge', 'native-host.mjs'),
      'import {spawn} from "node:child_process"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true}); process.stderr.write(JSON.stringify([process.pid,child.pid])+"\\n"); setInterval(()=>{},1000);');
    const mock = mockCommands({}, { actualCompiler: true });
    const result = await setupNative({ extensionId: ID }, dependencies(files.root, mock.run));
    launcher = spawn(result.launcherPath, [`chrome-extension://${ID}/`, '--parent-window=0'], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = new Promise(resolve => launcher.once('close', resolve));
    children = await new Promise((resolve, reject) => {
      let text = '';
      launcher.once('error', reject);
      launcher.stderr.on('data', bytes => {
        text += bytes.toString('utf8');
        if (text.includes('\n')) {
          try { resolve(JSON.parse(text.trim())); } catch { reject(new Error(text)); }
        }
      });
    });
    assert.equal(children.length, 2);
    assert.ok(children.every(pid => Number.isInteger(pid) && isAlive(pid)));
    // SIGKILL on Windows terminates this one process; it does not recursively
    // kill the Node descendants. Their exit therefore checks the Job policy.
    launcher.kill('SIGKILL');
    await closed;
    const deadline = Date.now() + 3000;
    while (children.some(isAlive) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(children.every(pid => !isAlive(pid)), 'Node child or provider descendant survived launcher termination');
  } finally {
    if (launcher && launcher.exitCode === null) launcher.kill('SIGKILL');
    for (const pid of children) { if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { } } }
    await files.cleanup();
  }
});
