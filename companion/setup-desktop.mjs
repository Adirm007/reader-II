/* macOS / Linux 用户级桌面启动入口。启动和退出仍由 standalone.mjs 管理。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const companion = path.join(path.dirname(script), 'standalone.mjs');
const owner = '# Reader-II companion installer ' + pathToFileURL(script).href;
const exists = file => fs.lstatSync(file, { throwIfNoEntry: false });

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

function onPath(name) {
  return (process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute)
    .map(dir => path.join(dir, name)).find(executable);
}

async function chooseApp(platform) {
  if (platform === 'darwin') {
    const bundle = ['/Applications', path.join(os.homedir(), 'Applications')].map(dir => path.join(dir, 'TauriTavern.app')).find(fs.existsSync);
    if (bundle) return bundle;
    const pick = spawnSync('/usr/bin/osascript', ['-e', 'POSIX path of (choose file of type {"com.apple.application-bundle"} with prompt "选择 TauriTavern.app")'], { encoding: 'utf8' });
    if (pick.status === 0 && pick.stdout.trim()) return pick.stdout.trim();
    if (pick.stderr?.includes('(-128)')) return '';
  } else {
    const found = onPath('tauritavern') || onPath('TauriTavern') || onPath('tauri-tavern');
    if (found) return found;
    const zenity = onPath('zenity');
    if (zenity && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
      const pick = spawnSync(zenity, ['--file-selection', '--title=选择 TauriTavern 程序或 AppImage'], { encoding: 'utf8' });
      if (pick.status === 0 && pick.stdout.trim()) return pick.stdout.trim();
      if (pick.status === 1 && !pick.stderr?.trim()) return '';
    }
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const input = (await prompt.question('粘贴酒馆程序的完整路径（macOS 可选 .app，Linux 可选 AppImage），然后按回车：')).trim();
    return input.replace(/^(["'])(.*)\1$/, '$2');
  } finally { prompt.close(); }
}

function resolveApp(input, platform) {
  let exe = path.resolve(input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input);
  if (platform === 'darwin' && exe.toLowerCase().endsWith('.app')) {
    const plist = path.join(exe, 'Contents', 'Info.plist');
    const read = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { encoding: 'utf8' });
    const name = read.stdout?.trim();
    if (read.status !== 0 || !name || path.basename(name) !== name) throw Error('读不到应用程序中的可执行文件，请选择 TauriTavern.app。');
    exe = path.join(exe, 'Contents', 'MacOS', name);
  }
  if (!executable(exe)) throw Error('找不到可执行的酒馆程序：' + exe + '。如果是 AppImage，请在文件属性里允许执行，再重试。');
  return exe;
}

export function desktopFile(platform, home, dataHome) {
  if (platform === 'darwin') return path.join(home, 'Desktop', 'TauriTavern + Reader-II.command');
  if (platform === 'linux') return path.join(dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(home, '.local', 'share'), 'applications', 'reader-ii-tauritavern.desktop');
  throw Error('此安装方式用于 macOS 或 Linux 桌面；Windows 请运行 Windows-Tauri.cmd。');
}

export function launcherText(platform, node, companionFile, exe) {
  const argv = [node, companionFile, '--host', '127.0.0.1', '--port', '8790', '--tavern', exe];
  if (argv.some(arg => /[\x00-\x1f\x7f]/.test(arg))) throw Error('程序路径含有控制字符，请换到普通文件夹后再安装。');
  if (platform === 'darwin') {
    const quote = arg => "'" + arg.replaceAll("'", "'\\''") + "'";
    return ['#!/bin/sh', owner, 'exec ' + argv.map(quote).join(' '), ''].join('\n');
  }
  // desktop-entry Exec 会先解码字符串转义，再处理命令行引号和 % 字段。
  const quote = arg => '"' + arg.replaceAll('%', '%%').replace(/["`$\\]/g, '\\$&').replaceAll('\\', '\\\\') + '"';
  return ['[Desktop Entry]', owner, 'Type=Application', 'Name=TauriTavern + Reader-II',
    'Terminal=true', 'Categories=Game;', 'Exec=' + argv.map(quote).join(' '), ''].join('\n');
}

export function setLauncher(file, content) {
  const previous = exists(file);
  if (previous) {
    const original = previous.isFile() ? fs.readFileSync(file, 'utf8') : '';
    if (!original.split('\n').includes(owner)) throw Error('同名入口不属于此安装目录，已保留：' + file);
    if (content === null) { fs.unlinkSync(file); return; }
    if (original !== content) throw Error('已有启动入口。要换用其他酒馆，请先运行卸载命令再重新安装。');
    return;
  }
  if (content === null) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx', 0o755);
  try { fs.writeFileSync(fd, content); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
  fs.closeSync(fd);
}

async function main() {
  const [action, supplied, ...extra] = process.argv.slice(2);
  if (extra.length || (supplied && action !== 'install') || !['install', 'uninstall'].includes(action)) {
    throw Error('用法：node setup-desktop.mjs install [酒馆程序路径] 或 node setup-desktop.mjs uninstall。含空格的路径请加双引号。');
  }
  const file = desktopFile(process.platform, os.homedir(), process.env.XDG_DATA_HOME);
  if (action === 'uninstall') {
    setLauncher(file, null);
    console.log('已移除启动入口。请退出酒馆；需要完整清理时，备份工作文件后按 README 删除解压目录和独立数据目录。');
    return;
  }
  const input = supplied || await chooseApp(process.platform);
  if (!input) { console.log('已取消安装。'); return; }
  const app = resolveApp(input, process.platform);
  setLauncher(file, launcherText(process.platform, process.execPath, companion, app));
  console.log('已配置：' + file + '\n请先退出原先打开的酒馆，以后从新入口打开。酒馆退出时伴侣也会关闭。请保留当前解压目录。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
