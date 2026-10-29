import { execFile } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCodexCommand } from '../bridge/providers/codex.mjs';

export const HOST_NAME = 'com.backlog_ai.reply';
export const REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_SOURCE = new URL('./NativeHostLauncher.cs', import.meta.url);
const USAGE = '登録: node scripts/setup-native.mjs --extension-id <Chromeの拡張機能ID>\n解除: node scripts/setup-native.mjs --uninstall';

export function parseSetupArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  if (argv.length === 1 && argv[0] === '--uninstall') return { uninstall: true };
  if (argv.length === 2 && argv[0] === '--extension-id' && /^[a-p]{32}$/.test(argv[1])) {
    return { extensionId: argv[1], uninstall: false };
  }
  throw new Error(`拡張機能IDはa〜pの32文字で指定してください。\n${USAGE}`);
}

export function supportsNode(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

export function nativeManifest(launcherPath, extensionId) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('拡張機能IDが不正です。');
  if (!path.win32.isAbsolute(launcherPath)) throw new Error('ランチャーには絶対パスが必要です。');
  return {
    name: HOST_NAME,
    description: 'Backlog AI reply local native messaging host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

export function renderLauncher(template, { nodePath, scriptPath, extensionId, codexBin = '' }) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('拡張機能IDが不正です。');
  for (const value of [nodePath, scriptPath, ...(codexBin ? [codexBin] : [])]) {
    if (!path.win32.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('起動対象には有効な絶対パスが必要です。');
  }
  const values = {
    __NODE_BASE64__: Buffer.from(nodePath, 'utf8').toString('base64'),
    __SCRIPT_BASE64__: Buffer.from(scriptPath, 'utf8').toString('base64'),
    __CODEX_BASE64__: Buffer.from(codexBin, 'utf8').toString('base64'),
    __EXTENSION_ID__: extensionId,
  };
  return template.replace(/__NODE_BASE64__|__SCRIPT_BASE64__|__CODEX_BASE64__|__EXTENSION_ID__/g, key => values[key]);
}

export function parseRegistryValue(stdout) {
  let value;
  try { value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); } catch { /* Reject malformed output below. */ }
  if (typeof value !== 'string' || !value.trim()) throw new Error('Native Messagingのレジストリ値を確認できませんでした。');
  return value;
}

export function registryReadArgs(view) {
  if (!['32', '64'].includes(view)) throw new Error('レジストリビューが不正です。');
  // reg.exe prints values in the active Windows code page. Read through .NET
  // with explicit UTF-8 JSON so Japanese paths survive without a decoder guess.
  // This script contains only fixed application constants, never user input.
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$base = $null
$key = $null
try {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry${view})
  $key = $base.OpenSubKey('Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}')
  if ($null -eq $key) { exit 1 }
  $value = $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -eq $value) { exit 1 }
  if ($key.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String) { exit 2 }
  [Console]::Write((ConvertTo-Json -InputObject $value -Compress))
} catch { [Console]::Error.WriteLine('Cannot read native messaging registration.'); exit 2 }
finally { if ($null -ne $key) { $key.Dispose() }; if ($null -ne $base) { $base.Dispose() } }`;
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

export function execute(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, shell: false, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !Number.isInteger(error.code)) { reject(new Error(`コマンドを実行できませんでした: ${path.basename(command)} (${error.code || 'timeout'})`)); return; }
        resolve({ code: error?.code ?? 0, stdout, stderr });
      });
  });
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function environmentValue(env, name) {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
}

export async function setupNative(options, {
  root = DEFAULT_ROOT, nodePath = process.execPath, nodeVersion = process.versions.node,
  platform = process.platform, env = process.env, run = execute,
  discoverCodex = resolveCodexCommand,
} = {}) {
  if (platform !== 'win32') throw new Error('この初期設定スクリプトはWindowsのGoogle Chrome用です。');
  if (!supportsNode(nodeVersion)) throw new Error('Node.js 22.12以上が必要です。Node.jsを更新してから再実行してください。');
  const systemRoot = environmentValue(env, 'SYSTEMROOT') || environmentValue(env, 'WINDIR');
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('WindowsのSystemRootを確認できませんでした。');
  const reg = path.win32.join(systemRoot, 'System32', 'reg.exe');
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const query = view => run(powershell, registryReadArgs(view));
  const workspace = await realpath(root);
  const nativeDir = path.join(workspace, '.native-host');
  const manifestPath = path.join(nativeDir, `${HOST_NAME}.json`);
  const registered = [];
  for (const view of ['32', '64']) {
    const result = await query(view);
    if (result.code === 1) continue; // Value absent; nothing is removed or replaced.
    if (result.code !== 0) throw new Error('Native Messagingの既存登録を確認できませんでした。');
    registered.push({ view, value: parseRegistryValue(result.stdout) });
  }
  if (options.uninstall) {
    const owned = registered.filter(item => sameWindowsPath(item.value, manifestPath));
    for (const { view } of owned) {
      // Delete only this workspace's default value, never the whole key.
      // Recheck immediately before deletion so another registration is preserved.
      const current = await query(view);
      if (current.code === 1) continue;
      if (current.code !== 0 || !sameWindowsPath(parseRegistryValue(current.stdout), manifestPath)) {
        throw new Error('登録先が変更されているため解除を停止しました。');
      }
      const result = await run(reg, ['delete', REGISTRY_KEY, '/ve', '/f', `/reg:${view}`]);
      if (result.code !== 0) throw new Error('Native Messagingの登録解除に失敗しました。');
    }
    return { uninstalled: owned.length > 0, preservedOtherRegistration: registered.some(item => !sameWindowsPath(item.value, manifestPath)), manifestPath };
  }
  if (!/^[a-p]{32}$/.test(options.extensionId || '')) throw new Error('拡張機能IDが不正です。');
  if (registered.some(item => !sameWindowsPath(item.value, manifestPath))) {
    throw new Error('別のフォルダーのBacklog AIが登録されています。そのフォルダーで登録解除してから再実行してください。');
  }
  const scriptPath = path.join(workspace, 'bridge', 'native-host.mjs');
  if (!await exists(scriptPath)) throw new Error('bridge/native-host.mjsがありません。アプリのフォルダーを確認してください。');
  if (!path.win32.isAbsolute(nodePath) || !await exists(nodePath)) throw new Error('使用中のNode.js実行ファイルを確認できませんでした。');
  let compiler;
  for (const framework of ['Framework64', 'Framework']) {
    const candidate = path.win32.join(systemRoot, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (await exists(candidate)) { compiler = candidate; break; }
  }
  if (!compiler) throw new Error('.NET Framework 4.xのC#コンパイラーがありません。Windowsの.NET Frameworkを有効にしてください。');

  let codexBin = '';
  try {
    const command = await discoverCodex({ env, platform });
    codexBin = command.prefix?.[0] || command.command;
  } catch (error) {
    // Copilot-only installations do not need Codex. Explicit invalid overrides,
    // however, are configuration errors and must not silently disappear.
    if (env.CODEX_BIN) throw error;
  }
  if (codexBin && !path.win32.isAbsolute(codexBin)) throw new Error('Codexの実行ファイルは絶対パスで指定してください。');
  if (await exists(nativeDir) && (await lstat(nativeDir)).isSymbolicLink()) {
    throw new Error('.native-hostがリンクになっています。通常のフォルダーを使用してください。');
  }
  await mkdir(nativeDir, { recursive: true });
  if (path.dirname(await realpath(nativeDir)).toLowerCase() !== workspace.toLowerCase()) {
    throw new Error('Native Messagingの生成先がアプリのフォルダー外になっています。');
  }
  const launcherPath = path.join(nativeDir, 'launcher.exe');
  const sourcePath = path.join(nativeDir, 'launcher.cs');
  const template = await readFile(LAUNCHER_SOURCE, 'utf8');
  await writeFile(sourcePath, renderLauncher(template, { nodePath, scriptPath, extensionId: options.extensionId, codexBin }), 'utf8');
  const compilation = await run(compiler, ['/nologo', '/target:winexe', '/optimize+', `/out:${launcherPath}`, sourcePath]);
  if (compilation.code !== 0 || !await exists(launcherPath)) {
    throw new Error(`ウィンドウを表示しないランチャーの作成に失敗しました。使用中の場合はChromeの拡張機能を一度オフにしてください。\n${(compilation.stdout || compilation.stderr || '').slice(0, 1500)}`);
  }
  await writeFile(manifestPath, JSON.stringify(nativeManifest(launcherPath, options.extensionId), null, 2) + '\n', 'utf8');
  // Compilation takes time. Recheck immediately before replacing any value.
  for (const view of ['32', '64']) {
    const current = await query(view);
    if (current.code === 1) continue;
    if (current.code !== 0 || !sameWindowsPath(parseRegistryValue(current.stdout), manifestPath)) {
      throw new Error('準備中に別の登録が追加されたため、Chromeへの登録を停止しました。');
    }
  }
  const registration = await run(reg, ['add', REGISTRY_KEY, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:32']);
  if (registration.code !== 0) throw new Error('Chromeへの登録に失敗しました。社内端末のレジストリ変更ポリシーを確認してください。');
  const verification = await query('32');
  if (verification.code !== 0 || !sameWindowsPath(parseRegistryValue(verification.stdout), manifestPath)) {
    throw new Error('Chromeへの登録結果を確認できませんでした。');
  }
  return { installed: true, manifestPath, launcherPath, nodePath, codexBin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseSetupArgs(process.argv.slice(2));
    if (options.help) console.log(USAGE);
    else {
      const result = await setupNative(options);
      if (options.uninstall) {
        console.log(result.uninstalled ? 'このフォルダーのChrome連携を解除しました。' : 'このフォルダーのChrome連携は登録されていません。');
        if (result.preservedOtherRegistration) console.log('別のフォルダーの登録は保持しました。');
      } else {
        console.log(`Chrome連携を登録しました。毎回サーバーを起動する必要はありません。\nNode.js: ${result.nodePath}\n登録先: ${result.manifestPath}`);
        console.log('Node.jsの場所（NVMなど）、アプリのフォルダー、拡張機能IDを変更したときは再度setupを実行してください。');
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
