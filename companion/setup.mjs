/* 在原生 SillyTavern 安装/移除伴侣。Node 18+，无需 npm。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const marker = '.reader-ii-install.json';
const files = ['package.json', 'index.mjs', 'core.mjs', 'ops.mjs', 'mcp-stdio.mjs', 'admin.mjs', 'browser.mjs', 'setup.mjs'];
const hash = data => createHash('sha256').update(data).digest('hex');
const setting = /^(enableServerPlugins:[ \t]*)(true|false)([ \t]*(?:#[^\r\n]*)?)(?=\r?$)/gm;
const read = file => fs.readFileSync(file, 'utf8');

function writeConfig(file, original, next) {
  if (original === next) return;
  const target = fs.realpathSync(file);
  const temp = target + '.reader-ii-' + randomUUID();
  fs.writeFileSync(temp, next, { flag: 'wx', mode: fs.statSync(target).mode });
  try {
    if (read(target) !== original) throw Error('config.yaml 正在被修改，请稍后重试。');
    fs.renameSync(temp, target);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function tavernAt(directory) {
  return fs.existsSync(path.join(directory, 'config.yaml')) && fs.existsSync(path.join(directory, 'server.js'));
}

async function findTavern(input) {
  if (input) return path.resolve(input);
  for (const start of [process.cwd(), here]) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (tavernAt(dir)) return dir;
      if (dir === path.dirname(dir)) break;
    }
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const value = (await prompt.question('把酒馆文件夹的完整路径粘贴到这里（里面有 config.yaml 和 server.js），然后按回车：')).trim();
    return path.resolve(value.replace(/^"(.*)"$/, '$1'));
  } finally { prompt.close(); }
}

function configEdit(original) {
  const matches = [...original.matchAll(setting)];
  const keys = original.match(/^enableServerPlugins[ \t]*:/gm) || [];
  if (keys.length !== matches.length || matches.length > 1) throw Error('config.yaml 的 enableServerPlugins 格式不明确，请手动设为 true 后重新安装。');
  if (matches.length) {
    return { text: original.replace(setting, '$1true$3'), previous: matches[0][2] };
  }
  const end = original.includes('\r\n') ? '\r\n' : '\n';
  const added = (original && !original.endsWith('\n') ? end : '') + 'enableServerPlugins: true' + end;
  return { text: original + added, previous: 'missing', added };
}

function install(plugins, dest, config) {
  if (fs.existsSync(dest)) throw Error('已存在 ' + dest + '。安装器会保留该目录；由本工具安装的版本可以先卸载再更新。');
  for (const entry of fs.readdirSync(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = path.join(plugins, entry.name, 'package.json');
    if (!fs.existsSync(file)) continue;
    let name;
    try { name = JSON.parse(read(file)).name; } catch { continue; }
    if (name === 'reader-ii' || name === 'reader-ii-companion') throw Error('已有 Reader-II 后端插件：' + path.dirname(file) + '。请先核对原安装，避免启动两份。');
  }
  const raw = read(config);
  const bom = raw.startsWith('\ufeff') ? '\ufeff' : '';
  const update = configEdit(raw.slice(bom.length));
  const sources = files.map(name => [name, fs.readFileSync(path.join(here, name))]);
  fs.mkdirSync(dest);
  const created = [];
  try {
    for (const [name, bytes] of sources) {
      fs.writeFileSync(path.join(dest, name), bytes, { flag: 'wx' });
      created.push(name);
    }
    const info = { previous: update.previous, added: update.added, hashes: Object.fromEntries(sources.map(([name, bytes]) => [name, hash(bytes)])) };
    fs.writeFileSync(path.join(dest, marker), JSON.stringify(info), { flag: 'wx' });
    created.push(marker);
    writeConfig(config, raw, bom + update.text);
  } catch (error) {
    for (const name of created.reverse()) fs.unlinkSync(path.join(dest, name));
    fs.rmdirSync(dest);
    throw error;
  }
  console.log('已安装。重启酒馆后，伴侣会一起启动；关闭酒馆时伴侣也会停止。助手设置 → 后端伴侣 → 检测。');
}

function uninstall(plugins, dest, config) {
  if (!fs.existsSync(dest)) { console.log('该插件目录已经移除。'); return; }
  if (fs.lstatSync(dest).isSymbolicLink() || !fs.existsSync(path.join(dest, marker))) throw Error('该目录不属于本安装器。请核对目录内容后手动卸载。');
  const record = JSON.parse(read(path.join(dest, marker)));
  if (!record.hashes || !files.every(name => /^[a-f0-9]{64}$/.test(record.hashes[name]))) throw Error('安装记录不完整，未移除文件。');
  for (const name of files) {
    const file = path.join(dest, name);
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || hash(fs.readFileSync(file)) !== record.hashes[name])) {
      throw Error('已保留手动修改的 ' + file + '。请先备份并手动移除插件目录。');
    }
  }
  const others = fs.readdirSync(plugins, { withFileTypes: true }).some(item => item.name !== path.basename(dest) && !item.name.startsWith('.') && (item.isDirectory() || item.isSymbolicLink() || /\.[cm]?js$/.test(item.name)));
  const raw = read(config);
  const bom = raw.startsWith('\ufeff') ? '\ufeff' : '';
  const body = raw.slice(bom.length);
  let next = raw;
  if (!others && (body.match(/^enableServerPlugins[ \t]*:/gm) || []).length === 1) {
    if (record.previous === 'false') next = bom + body.replace(setting, '$1false$3');
    if (record.previous === 'missing' && /^(?:\r?\n)?enableServerPlugins: true\r?\n$/.test(record.added)) {
      // 在尾部时连同安装时补上的换行一起还原。在中间时保留前后设置之间的分行。
      next = bom + (body.endsWith(record.added) ? body.slice(0, -record.added.length) : body.replace(/^enableServerPlugins: true(?:\r?\n|$)/m, ''));
    }
  }
  writeConfig(config, raw, next);
  for (const name of files) if (fs.existsSync(path.join(dest, name))) fs.unlinkSync(path.join(dest, name));
  fs.unlinkSync(path.join(dest, marker));
  if (!fs.readdirSync(dest).length) fs.rmdirSync(dest);
  else console.log('已保留用户另外添加的文件：' + dest);
  console.log('伴侣插件已卸载。重启酒馆以停止正在运行的旧实例。');
  if (others) console.log('酒馆还有其他插件，已保留 enableServerPlugins 的当前设置。');
  console.log('确认不再需要授权记录、截图和工作文件后，可手动删除数据目录：' + (process.env.READER_II_COMPANION_HOME || path.join(os.homedir(), '.reader-ii-companion')));
}

try {
  let [action, directory] = process.argv.slice(2);
  if (action === 'windows' && process.platform === 'win32') {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { action = (await prompt.question('按回车安装，或输入 2 后按回车卸载：')).trim() === '2' ? 'uninstall' : 'install'; }
    finally { prompt.close(); }
    const picker = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-Command',
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $d=New-Object Windows.Forms.OpenFileDialog; $d.Title='Select config.yaml in your SillyTavern folder'; $d.Filter='config.yaml|config.yaml'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }"
    ], { encoding: 'utf8', windowsHide: true });
    if (picker.error || picker.status !== 0) throw Error('无法打开文件选择窗口，可改用 node setup.mjs install 或 uninstall。');
    if (!picker.stdout.trim()) { console.log('已取消。'); process.exit(0); }
    directory = path.dirname(picker.stdout.trim());
  }
  if (!['install', 'uninstall'].includes(action)) throw Error('用法：node setup.mjs install 或 node setup.mjs uninstall，可在末尾加上酒馆根目录路径。');
  const root = await findTavern(directory);
  if (!tavernAt(root)) throw Error('找不到酒馆的 config.yaml 和 server.js：' + root);
  const plugins = path.join(root, 'plugins'), dest = path.join(plugins, 'reader-ii-companion'), config = path.join(root, 'config.yaml');
  if (action === 'install') {
    fs.mkdirSync(plugins, { recursive: true });
    install(plugins, dest, config);
  } else uninstall(plugins, dest, config);
} catch (error) { console.error(error.message); process.exitCode = 1; }
