/* 专用桌面快捷方式。只在用户从它启动酒馆时运行，随那个 TauriTavern 进程退出。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createCompanion } from './core.mjs';

const script = fileURLToPath(import.meta.url);
const psArgs = ['-NoLogo', '-NoProfile', '-STA', '-Command'];
const environment = { ...process.env, READER_SETUP_SCRIPT: script, READER_SETUP_NODE: process.execPath, READER_SETUP_DESKTOP: '', READER_SETUP_TAVERN: '' };
const ps = 'powershell.exe';
const shortcuts = `
  $ErrorActionPreference = 'Stop'
  $desktop = if ($env:READER_SETUP_DESKTOP) { $env:READER_SETUP_DESKTOP } else { [Environment]::GetFolderPath('DesktopDirectory') }
  $file = Join-Path $desktop 'TauriTavern + Reader-II.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($file)
  $prefix = '"' + $env:READER_SETUP_SCRIPT + '" start "'
  if ((Test-Path -LiteralPath $file) -and !$link.Arguments.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A desktop shortcut with the same name belongs to another installation.'
  }
`;
function powershell(code) {
  const result = spawnSync(ps, [...psArgs, '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' + code], { env: environment, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr.trim() || '操作未完成。');
  return result.stdout.trim();
}

async function configure(action) {
  if (!action) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { action = (await prompt.question('按回车创建桌面启动方式；如需卸载，输入 2 后按回车：')).trim() === '2' ? 'uninstall' : 'install'; }
    finally { prompt.close(); }
  }
  if (action === 'uninstall') {
    powershell(shortcuts + `if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }`);
    console.log('已移除专用桌面快捷方式。请在托盘中彻底退出酒馆，伴侣控制台会随之关闭。');
    console.log('如果是专为安装伴侣下载的 ZIP，可删除 ZIP 和解压目录。授权、记录、工作文件另存在 ' + (process.env.READER_II_COMPANION_HOME || path.join(os.homedir(), '.reader-ii-companion')) + '；备份需要的文件后可删除。');
    return;
  }
  if (action !== 'install') throw Error('用法：Windows-Tauri.cmd install 或 Windows-Tauri.cmd uninstall');
  const target = powershell(shortcuts + `
    $exe = $env:READER_SETUP_TAVERN
    if (!$exe) {
      $app = Get-Process -Name TauriTavern -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
      $exe = $app.Path
    }
    if (!$exe) {
      Add-Type -AssemblyName System.Windows.Forms
      $dialog = New-Object Windows.Forms.OpenFileDialog
      $dialog.Title = 'Select TauriTavern.exe'
      $dialog.Filter = 'TauriTavern.exe|TauriTavern.exe'
      if ($dialog.ShowDialog() -ne 'OK') { exit 0 }
      $exe = $dialog.FileName
    }
    if ((Split-Path -Leaf $exe) -ine 'TauriTavern.exe' -or !(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Select TauriTavern.exe.' }
    $link.TargetPath = $env:READER_SETUP_NODE
    $link.Arguments = $prefix + $exe + '"'
    $link.WorkingDirectory = Split-Path -Parent $exe
    $link.IconLocation = $exe + ',0'
    $link.Description = 'TauriTavern + Reader-II Companion'
    $link.Save()
    Write-Output $exe
  `);
  console.log(target ? '桌面已创建「TauriTavern + Reader-II」。以后从它打开酒馆。现在也可以双击它，让伴侣接上已打开的酒馆。请保留并固定当前解压文件夹的位置。' : '已取消，未创建快捷方式。');
}

async function start(exe) {
  if (!exe || path.basename(exe).toLowerCase() !== 'tauritavern.exe' || !fs.existsSync(exe)) throw Error('找不到 TauriTavern.exe。请重新运行 Windows-Tauri.cmd 选择位置。');
  const companion = createCompanion({ mode: 'standalone' });
  try {
    await companion.start({ serveApi: true, port: 8790, host: '127.0.0.1', portFallback: false });
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw Error('本机 8790 端口已被使用。如果伴侣已开，请使用原窗口；否则先关闭占用该端口的程序。');
    throw error;
  }
  const watcher = spawn(ps, [...psArgs, `
    $ErrorActionPreference = 'Stop'
    $exe = $env:READER_SETUP_TAVERN
    $app = Get-Process -Name TauriTavern -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Select-Object -First 1
    if (!$app) { $app = Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -PassThru }
    $app.WaitForExit()
  `], { env: { ...environment, READER_SETUP_TAVERN: exe }, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  const stop = () => watcher.kill();
  process.once('SIGINT', stop);
  try {
    console.log('伴侣会在酒馆进程退出时关闭。按 Ctrl+C 可以单独停止伴侣。');
    const code = await new Promise((resolve, reject) => { watcher.once('error', reject); watcher.once('exit', resolve); });
    if (code) throw Error('启动或等待酒馆时出错。');
  } finally {
    process.off('SIGINT', stop);
    await companion.close();
  }
}

try {
  if (process.platform !== 'win32') throw Error('此桌面启动方式适用于 Windows 上的 TauriTavern。');
  if (Number(process.versions.node.split('.')[0]) < 18) throw Error('需要 Node.js 18 或更新版本，请安装 Node.js LTS 后重新打开。');
  const [action, exe, shortcutDirectory] = process.argv.slice(2);
  if (action === 'start') await start(exe);
  else {
    if (exe && exe !== '-') environment.READER_SETUP_TAVERN = path.resolve(exe);
    if (shortcutDirectory) environment.READER_SETUP_DESKTOP = path.resolve(shortcutDirectory);
    await configure(action);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  if (process.argv[2] === 'start' && process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { await prompt.question('按回车关闭。'); } finally { prompt.close(); }
  }
}
