/*
 * 后端伴侣的操作：环境探测、命令与后台任务、文件读写与检索、HTTP 代发、无头浏览器、stdio MCP。
 * 每个操作是 async (payload) => 结果；出错就抛 Error（消息原样交给助手），可带 code。
 * 能不能调用由 core.mjs 的放行决定；这里只管「怎么做」和几条硬规矩：
 *   - 伴侣自己的数据目录（密钥、放行记录）不能经文件接口碰；工作目录 workspace 例外；
 *   - 管理页上限定了目录（fsRoots）时，文件接口只在这些目录里活动；
 *   - 管理页上关掉了命令 / 浏览器时，对应操作直接拒绝。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBrowser } from './browser.mjs';
import { createMcpHub } from './mcp-stdio.mjs';

const WIN = process.platform === 'win32';
const TERMUX = !!process.env.TERMUX_VERSION || String(process.env.PREFIX || '').includes('com.termux');
const MAX_READ = 3 * 1024 * 1024;
const MAX_HTTP = 5 * 1024 * 1024;
const HEAD_KEEP = 200000;
const TAIL_KEEP = 800000;
const RETURN_TAIL = 60000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next', '.svn', '.hg', '.idea']);
const BINARY_TYPE = /^(?:image|audio|video|font)\/|^application\/(?:octet-stream|zip|pdf|gzip|x-tar|x-7z-compressed|x-msdownload|wasm|msword|vnd\.)/;
const TEXT_TYPE = /^text\/|(?:^|[\/+.-])(?:json|xml|javascript|yaml|csv|html|markdown)(?:$|[;\s+])/;
/* application/vnd.github.raw+json、image/svg+xml 这类带 +json / +xml 的是文本，不算二进制。 */
const isBinaryType = (type) => { const value = String(type || '').toLowerCase(); return !TEXT_TYPE.test(value) && BINARY_TYPE.test(value); };
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection']);

export function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

const clamp = (value, minimum, maximum, fallback) => {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
};
/* 等一个 Promise 最多 ms 毫秒；它先完成就把定时器清掉，不让几十秒的定时器白白挂着。 */
const within = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  promise.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
});

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function expandHome(value) {
  const text = String(value);
  return text === '~' ? os.homedir() : /^~[\\/]/.test(text) ? path.join(os.homedir(), text.slice(2)) : text;
}

/* 最近的、真实存在的上级目录解析掉符号链接，再接回剩下的部分：防止用符号链接绕出允许的目录。 */
async function realish(full) {
  let current = full;
  const tail = [];
  for (;;) {
    try { return path.join(await fsp.realpath(current), ...tail.reverse()); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return full;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function createOps({ config, home, workspace, log, version }) {
  /* ---------- 路径 ---------- */
  function guard(real) {
    if (inside(real, home) && !inside(real, workspace)) throw fail('伴侣自己的数据目录不能经这里访问。');
    if (config.fsRoots.length) {
      const allowed = config.fsRoots.map((item) => path.resolve(expandHome(item)));
      if (!inside(real, workspace) && !allowed.some((item) => inside(real, item))) throw fail(`这个路径不在允许的目录里：${real}。用户在伴侣的管理页上把文件访问限定在了：${allowed.join('、')}。`);
    }
    return real;
  }

  /* dev:/ 的路径段 → 设备上的绝对路径。~ 是用户目录，@ws 是伴侣的工作目录，其余是绝对路径（Windows 从盘符开始）。 */
  async function locate(segs) {
    const list = (Array.isArray(segs) ? segs : []).map(String);
    if (!list.length) throw fail('要给出具体的路径');
    let base, rest;
    if (list[0] === '~') { base = os.homedir(); rest = list.slice(1); }
    else if (list[0] === '@ws') { base = workspace; rest = list.slice(1); }
    else if (WIN) {
      if (!/^[A-Za-z]:$/.test(list[0])) throw fail('Windows 上的路径要从盘符开始，例如 dev:/C:/Users；用户目录写 dev:/~/，伴侣的工作目录写 dev:/@ws/');
      base = list[0].toUpperCase() + '\\';
      rest = list.slice(1);
    } else { base = '/'; rest = list; }
    for (const part of rest) {
      if (part === '.' || part === '..' || part.includes('\0') || part.includes('/') || (WIN && part.includes('\\'))) throw fail('路径里有不允许的段：' + part);
    }
    return guard(await realish(path.join(base, ...rest)));
  }

  /* 设备上的原生路径（device_exec 的 cwd）。 */
  async function locateNative(value) {
    const full = path.resolve(expandHome(String(value)));
    return guard(await realish(full));
  }

  /* ---------- 文件 ---------- */
  async function roots() {
    const items = [{ name: '~', dir: true, note: '用户目录 ' + os.homedir() }, { name: '@ws', dir: true, note: '伴侣的工作目录 ' + workspace }];
    if (WIN) {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        if (fs.existsSync(letter + ':\\')) items.push({ name: letter + ':', dir: true });
      }
    } else {
      try {
        for (const entry of await fsp.readdir('/', { withFileTypes: true })) if (entry.isDirectory()) items.push({ name: entry.name, dir: true });
      } catch { /* 根目录列不出来就只给两个别名 */ }
    }
    return { items, total: items.length };
  }

  async function fsList(payload) {
    const list = Array.isArray(payload.segs) ? payload.segs.map(String) : [];
    if (!list.length) return roots();
    const full = await locate(list);
    let entries;
    try { entries = await fsp.readdir(full, { withFileTypes: true }); }
    catch (error) {
      throw fail(error.code === 'ENOENT' ? '没有这个目录：' + full : error.code === 'ENOTDIR' ? '这是一个文件，不是目录：' + full : `读不了这个目录（${error.code || error.message}）：${full}`);
    }
    const items = entries.map((entry) => {
      let dir = entry.isDirectory();
      if (!dir && entry.isSymbolicLink()) { try { dir = fs.statSync(path.join(full, entry.name)).isDirectory(); } catch { dir = false; } }
      return { name: entry.name, dir };
    }).sort((left, right) => (left.dir === right.dir ? 0 : left.dir ? -1 : 1) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const offset = clamp(payload.offset, 0, 10000000, 0);
    const page = items.slice(offset, offset + clamp(payload.limit, 1, 2000, 100));
    await Promise.all(page.map(async (item) => {
      if (item.dir) return;
      try { item.size = (await fsp.stat(path.join(full, item.name))).size; } catch { /* 读不到大小就不写 */ }
    }));
    return { items: page, total: items.length };
  }

  const looksBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

  async function fsRead(payload) {
    const full = await locate(payload.segs);
    let stat;
    try { stat = await fsp.stat(full); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { missing: true };
      throw fail(`读不了（${error.code || error.message}）：${full}`);
    }
    if (stat.isDirectory()) return { dir: true };
    if (stat.size > MAX_READ) return { tooLarge: true, bytes: stat.size };
    const buffer = await fsp.readFile(full);
    if (looksBinary(buffer)) return { binary: true, bytes: buffer.length };
    /* 换行统一成 \n 交给助手（精确替换不必操心 \r）；写回时如果原文件是 CRLF 会还原。 */
    return { text: buffer.toString('utf8').replace(/\r\n/g, '\n') };
  }

  async function fsWrite(payload) {
    const full = await locate(payload.segs);
    let existing = null, mode;
    try {
      const stat = await fsp.stat(full);
      if (stat.isDirectory()) throw fail('这是一个目录，不能当文件写：' + full);
      mode = stat.mode;
      existing = await fsp.readFile(full);
    } catch (error) {
      if (error.code !== 'ENOENT') { if (!error.code) throw error; throw fail(`写不了（${error.code}）：${full}`); }
    }
    let body = String(payload.text == null ? '' : payload.text);
    if (existing && !looksBinary(existing) && /\r\n/.test(existing.toString('utf8'))) body = body.replace(/\r?\n/g, '\r\n');
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const temp = `${full}.reader-ii-${process.pid}-${Date.now()}.tmp`;
    try {
      await fsp.writeFile(temp, body, { mode: mode === undefined ? 0o644 : mode });
      await fsp.rename(temp, full);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw fail(`写不了（${error.code || error.message}）：${full}`);
    }
    return { ok: true, bytes: Buffer.byteLength(body), created: existing === null, path: full };
  }

  async function fsRemove(payload) {
    const full = await locate(payload.segs);
    let stat;
    try { stat = await fsp.lstat(full); } catch { throw fail('没有这个文件：' + full); }
    try {
      if (stat.isDirectory()) await fsp.rmdir(full);
      else await fsp.unlink(full);
    } catch (error) {
      throw fail(error.code === 'ENOTEMPTY' || error.code === 'EEXIST' ? '目录不是空的。要删整个目录请用 device_exec，并先跟用户确认：' + full : `删不了（${error.code || error.message}）：${full}`);
    }
    return { ok: true, path: full };
  }

  async function fsGrep(payload) {
    const full = await locate(payload.segs);
    const flags = String(payload.flags || 'i').replace(/[^imsu]/g, '');
    let expression;
    try { expression = new RegExp(String(payload.pattern), flags); }
    catch { expression = new RegExp(String(payload.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); }
    const context = clamp(payload.context, 0, 5, 0);
    const limit = clamp(payload.limit, 1, 200, 40);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) throw fail('没有这个路径：' + full);
    const hits = [];
    let total = 0, files = 0, scanned = 0, note = '';
    const started = Date.now();
    const clipLine = (line) => (line.length > 300 ? line.slice(0, 300) + '…' : line);

    async function scan(file, rel) {
      let info;
      try { info = await fsp.stat(file); } catch { return; }
      if (!info.isFile() || info.size > 1500000) return;
      let buffer;
      try { buffer = await fsp.readFile(file); } catch { return; }
      if (looksBinary(buffer)) return;
      scanned += 1;
      const text = buffer.toString('utf8');
      if (!expression.test(text)) return;
      files += 1;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const found = expression.exec(lines[index]);
        if (!found) continue;
        total += 1;
        if (hits.length >= limit) continue;
        if (context) {
          const from = Math.max(0, index - context);
          hits.push({ rel, from: from + 1, lines: lines.slice(from, Math.min(lines.length, index + context + 1)).map(clipLine) });
        } else {
          const line = lines[index];
          hits.push({ rel, line: index + 1, text: line.length > 300 ? `[列 ${found.index}] …${line.slice(Math.max(0, found.index - 100), found.index + 180)}…` : line });
        }
      }
    }

    if (stat.isFile()) {
      await scan(full, '');
      return { hits, total, files, scanned, single: true };
    }
    const stack = [{ dir: full, rel: '' }];
    while (stack.length) {
      if (scanned >= 6000 || Date.now() - started > 20000) { note = `（设备上的检索在看过 ${scanned} 个文件后停下了：范围太大，请把目录缩小一些）`; break; }
      const current = stack.pop();
      let entries;
      try { entries = await fsp.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
      entries.sort((left, right) => (left.name < right.name ? 1 : -1));
      for (const entry of entries) {
        const rel = current.rel ? current.rel + '/' + entry.name : entry.name;
        const child = path.join(current.dir, entry.name);
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) stack.push({ dir: child, rel }); }
        else if (entry.isFile()) await scan(child, rel);
      }
    }
    return { hits, total, files, scanned, single: false, note };
  }

  /* ---------- 命令与任务 ---------- */
  const jobs = new Map();
  let jobSeq = 0;

  function shellFor(name) {
    const wanted = String(name || '').toLowerCase();
    if (WIN) {
      if (wanted === 'powershell' || wanted === 'pwsh') {
        return { file: wanted === 'pwsh' ? 'pwsh.exe' : 'powershell.exe', args: (command) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + command] };
      }
      /* 与 Node 自己的 shell: true 相同的调用方式；chcp 65001 让输出是 UTF-8，中文不乱码。 */
      return { file: process.env.ComSpec || 'cmd.exe', args: (command) => ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`], verbatim: true };
    }
    if (wanted === 'bash' || wanted === 'zsh') return { file: wanted, args: (command) => ['-c', command] };
    const candidates = ['/bin/sh', path.join(String(process.env.PREFIX || '/usr'), 'bin', 'sh'), '/system/bin/sh'];
    return { file: candidates.find((item) => fs.existsSync(item)) || 'sh', args: (command) => ['-c', command] };
  }

  function composed(job) {
    return job.head + (job.dropped ? `\n…（中间省略了 ${job.dropped} 字）…\n` : '') + job.tail;
  }

  function summary(job) {
    return {
      id: job.id, command: job.command.slice(0, 300), cwd: job.cwd, running: !job.endedAt, exitCode: job.exitCode, signal: job.signal,
      startedAt: job.startedAt, durationMs: (job.endedAt || Date.now()) - job.startedAt, totalChars: job.total,
    };
  }

  function killJob(job) {
    if (job.endedAt || !job.child || !job.child.pid) return false;
    try {
      if (WIN) spawn('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else {
        try { process.kill(-job.child.pid, 'SIGTERM'); } catch { job.child.kill('SIGTERM'); }
        setTimeout(() => { if (!job.endedAt) { try { process.kill(-job.child.pid, 'SIGKILL'); } catch { /* 已经没了 */ } } }, 3000).unref();
      }
    } catch { /* 尽力而为 */ }
    return true;
  }

  function launch({ command, cwd, shell, stdin, extraEnv, rid }) {
    const picked = shellFor(shell);
    const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', ...(extraEnv || {}) };
    const child = spawn(picked.file, picked.args(command), {
      cwd, env, windowsHide: true, windowsVerbatimArguments: picked.verbatim === true, detached: !WIN,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const job = { id: 'j' + (++jobSeq), rid: rid || '', command, cwd, startedAt: Date.now(), endedAt: 0, exitCode: null, signal: null, head: '', tail: '', dropped: 0, total: 0, child, done: null };
    const append = (chunk) => {
      let text = chunk;
      job.total += text.length;
      if (job.head.length < HEAD_KEEP) {
        const take = HEAD_KEEP - job.head.length;
        job.head += text.slice(0, take);
        text = text.slice(take);
      }
      if (text) {
        job.tail += text;
        if (job.tail.length > TAIL_KEEP) { const cut = job.tail.length - TAIL_KEEP; job.dropped += cut; job.tail = job.tail.slice(cut); }
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new TextDecoder('utf-8');
      stream.on('data', (chunk) => append(decoder.decode(chunk, { stream: true })));
    }
    job.done = new Promise((resolve) => {
      let settled = false;
      const finish = (code, signal, note) => {
        if (settled) return;
        settled = true;
        job.endedAt = Date.now();
        job.exitCode = code;
        job.signal = signal || null;
        if (note) append(note);
        resolve();
      };
      child.on('error', (error) => finish(-1, null, `\n（命令没能启动：${error.message}）`));
      child.on('close', (code, signal) => finish(code, signal));
    });
    if (stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(String(stdin)); }
    jobs.set(job.id, job);
    return job;
  }

  function prune() {
    for (const [id, job] of jobs) if (job.endedAt && Date.now() - job.endedAt > 30 * 60 * 1000) jobs.delete(id);
  }

  async function exec(payload) {
    if (!config.exec) throw fail('用户在伴侣的管理页上关掉了命令执行。', 'disabled');
    const command = String(payload.command || '').trim();
    if (!command) throw fail('命令是空的');
    prune();
    if ([...jobs.values()].filter((job) => !job.endedAt).length >= 8) throw fail('同时在跑的任务太多了（8 个）。先用 device_job 看看，停掉不用的。');
    let cwd = workspace;
    if (Array.isArray(payload.cwdSegs) && payload.cwdSegs.length) cwd = await locate(payload.cwdSegs);
    else if (payload.cwd) cwd = await locateNative(payload.cwd);
    try { if (!(await fsp.stat(cwd)).isDirectory()) throw new Error('not a directory'); } catch { throw fail('工作目录不存在：' + cwd); }
    const extraEnv = {};
    if (payload.env && typeof payload.env === 'object') for (const [key, value] of Object.entries(payload.env)) extraEnv[String(key)] = String(value);
    const job = launch({ command, cwd, shell: payload.shell, stdin: payload.stdin === undefined ? undefined : String(payload.stdin), extraEnv, rid: payload.rid ? String(payload.rid) : '' });
    await within(job.done, payload.background === true ? 400 : clamp(payload.timeoutSec, 1, 900, 60) * 1000);
    const output = composed(job);
    return {
      id: job.id, running: !job.endedAt, exitCode: job.exitCode, signal: job.signal, durationMs: (job.endedAt || Date.now()) - job.startedAt,
      output: output.length > RETURN_TAIL ? output.slice(-RETURN_TAIL) : output, totalChars: job.total, truncated: output.length > RETURN_TAIL, cwd,
    };
  }

  async function jobOp(payload) {
    const action = String(payload.action || 'list');
    if (action === 'list') { prune(); return { jobs: [...jobs.values()].map(summary) }; }
    const job = payload.id ? jobs.get(String(payload.id)) : payload.rid ? [...jobs.values()].find((item) => item.rid === String(payload.rid)) : null;
    if (!job) {
      if (action === 'kill' && payload.rid) return { killed: false };
      throw fail('没有这个任务：' + String(payload.id || '') + '。用 action=list 看看现在有哪些。');
    }
    if (action === 'kill') {
      const killed = killJob(job);
      if (killed) await within(job.done, 4000);
      return { killed, ...summary(job) };
    }
    const text = composed(job);
    if (action === 'log') {
      const offset = clamp(payload.offset, 0, 100000000, 0);
      const piece = text.slice(offset, offset + 20000);
      return { ...summary(job), text: piece, next: offset + piece.length, more: offset + piece.length < text.length };
    }
    return { ...summary(job), tail: text.slice(-2000) };
  }

  /* 跑一条短命令取输出（环境探测用）。 */
  function quick(command, timeoutMs) {
    return new Promise((resolve) => {
      let output = '';
      let child;
      try {
        const picked = shellFor('');
        child = spawn(picked.file, picked.args(command), { windowsHide: true, windowsVerbatimArguments: picked.verbatim === true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { resolve(null); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
      child.stdout.on('data', (chunk) => { if (output.length < 4000) output += chunk; });
      child.stderr.on('data', (chunk) => { if (output.length < 4000) output += chunk; });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? String(output) : null); });
    });
  }

  /* ---------- 环境 ---------- */
  const PROBES = [
    ['git', 'git --version'], ['node', 'node --version'], ['npm', 'npm --version'], ['pnpm', 'pnpm --version'],
    ['python', WIN ? 'python --version' : 'python3 --version'], ['pip', WIN ? 'pip --version' : 'pip3 --version'], ['uv', 'uv --version'],
    ['curl', 'curl --version'], ['rg', 'rg --version'], ['ffmpeg', 'ffmpeg -version'], ['gh', 'gh --version'],
  ];
  const PURPOSE = {
    git: '版本管理、克隆与推送仓库', node: '运行 JavaScript、多数 MCP 服务器（npx）', npm: '装 JavaScript 依赖', pnpm: '装 JavaScript 依赖（可选）',
    python: '运行 Python 脚本与一部分 MCP 服务器', pip: '装 Python 依赖', uv: 'Python 的快速安装器与 uvx（一部分 MCP 服务器用它启动）',
    curl: '下载', rg: '快速检索（可选）', ffmpeg: '处理音视频与图片（可选）', gh: 'GitHub 命令行（可选）',
  };
  const INSTALL = {
    termux: { manager: 'pkg', git: 'pkg install -y git', node: 'pkg install -y nodejs', npm: 'pkg install -y nodejs', python: 'pkg install -y python', pip: 'pkg install -y python', curl: 'pkg install -y curl', rg: 'pkg install -y ripgrep', ffmpeg: 'pkg install -y ffmpeg', gh: 'pkg install -y gh', uv: 'pkg install -y uv', pnpm: 'npm install -g pnpm' },
    winget: { manager: 'winget', git: 'winget install --id Git.Git -e --source winget', node: 'winget install --id OpenJS.NodeJS.LTS -e --source winget', npm: 'winget install --id OpenJS.NodeJS.LTS -e --source winget', python: 'winget install --id Python.Python.3.12 -e --source winget', pip: 'winget install --id Python.Python.3.12 -e --source winget', curl: 'winget install --id cURL.cURL -e --source winget', rg: 'winget install --id BurntSushi.ripgrep.MSVC -e --source winget', ffmpeg: 'winget install --id Gyan.FFmpeg -e --source winget', gh: 'winget install --id GitHub.cli -e --source winget', uv: 'winget install --id astral-sh.uv -e --source winget', pnpm: 'npm install -g pnpm' },
    brew: { manager: 'brew', git: 'brew install git', node: 'brew install node', npm: 'brew install node', python: 'brew install python', pip: 'brew install python', curl: 'brew install curl', rg: 'brew install ripgrep', ffmpeg: 'brew install ffmpeg', gh: 'brew install gh', uv: 'brew install uv', pnpm: 'npm install -g pnpm' },
    apt: { manager: 'apt', git: 'sudo apt-get install -y git', node: 'sudo apt-get install -y nodejs npm', npm: 'sudo apt-get install -y npm', python: 'sudo apt-get install -y python3', pip: 'sudo apt-get install -y python3-pip', curl: 'sudo apt-get install -y curl', rg: 'sudo apt-get install -y ripgrep', ffmpeg: 'sudo apt-get install -y ffmpeg', gh: 'sudo apt-get install -y gh', uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh', pnpm: 'npm install -g pnpm' },
    dnf: { manager: 'dnf', git: 'sudo dnf install -y git', node: 'sudo dnf install -y nodejs npm', npm: 'sudo dnf install -y npm', python: 'sudo dnf install -y python3', pip: 'sudo dnf install -y python3-pip', curl: 'sudo dnf install -y curl', rg: 'sudo dnf install -y ripgrep', ffmpeg: 'sudo dnf install -y ffmpeg', gh: 'sudo dnf install -y gh', uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh', pnpm: 'npm install -g pnpm' },
    pacman: { manager: 'pacman', git: 'sudo pacman -S --noconfirm git', node: 'sudo pacman -S --noconfirm nodejs npm', npm: 'sudo pacman -S --noconfirm npm', python: 'sudo pacman -S --noconfirm python', pip: 'sudo pacman -S --noconfirm python-pip', curl: 'sudo pacman -S --noconfirm curl', rg: 'sudo pacman -S --noconfirm ripgrep', ffmpeg: 'sudo pacman -S --noconfirm ffmpeg', gh: 'sudo pacman -S --noconfirm github-cli', uv: 'sudo pacman -S --noconfirm uv', pnpm: 'npm install -g pnpm' },
  };
  let envCache = null;

  async function envOp(payload) {
    if (envCache && payload.refresh !== true && Date.now() - envCache.at < 5 * 60 * 1000) return envCache.value;
    const found = await Promise.all(PROBES.map(async ([name, command]) => {
      const out = await quick(command, 6000);
      const match = out && /(\d+\.\d+(?:\.\d+)?)/.exec(out);
      return [name, out === null ? null : match ? match[1] : '已安装'];
    }));
    const tools = Object.fromEntries(found);
    let manager = null;
    if (TERMUX) manager = 'termux';
    else if (WIN) manager = (await quick('winget --version', 6000)) !== null ? 'winget' : null;
    else if (process.platform === 'darwin') manager = (await quick('brew --version', 6000)) !== null ? 'brew' : null;
    else for (const candidate of ['apt', 'dnf', 'pacman']) { if ((await quick(`${candidate === 'apt' ? 'apt-get' : candidate} --version`, 6000)) !== null) { manager = candidate; break; } }
    const table = manager ? INSTALL[manager] : null;
    const missing = Object.keys(tools).filter((name) => tools[name] === null).map((name) => ({ name, purpose: PURPOSE[name], install: table ? table[name] : null }));
    const chrome = browser.find();
    const value = {
      companion: version, platform: process.platform, os: `${os.type()} ${os.release()}`, arch: os.arch(), termux: TERMUX, node: process.version,
      shell: shellFor('').file, home: os.homedir(), workspace, cwd: process.cwd(), cpus: os.cpus().length, memoryGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
      tools, missing, packageManager: table ? table.manager : null,
      installNote: table ? '缺的工具可以用 install 里的命令装（先跟用户确认；带 sudo 的命令要用户自己在终端里跑）。' : (WIN ? '这台 Windows 上没有 winget：请用户到各工具的官网下载安装包。' : '没认出包管理器：请按这个系统的习惯安装。'),
      browser: chrome || null, browserNote: chrome ? '' : '没有找到 Chrome / Chromium / Edge，无头浏览器用不了；装上其中一个即可（或在伴侣的管理页里填浏览器的路径）。',
      limits: { exec: config.exec, browser: config.browser, fsRoots: config.fsRoots },
    };
    envCache = { at: Date.now(), value };
    return value;
  }

  /* ---------- HTTP 代发 ---------- */
  async function readCapped(stream, cap, until) {
    const decoder = new TextDecoder('utf-8');
    const reader = stream.getReader();
    let text = '', truncated = false;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      text += decoder.decode(step.value, { stream: true });
      if (text.length > cap) { truncated = true; text = text.slice(0, cap); await reader.cancel().catch(() => {}); break; }
      if (until && until(text)) { await reader.cancel().catch(() => {}); break; }
    }
    return { text, truncated };
  }

  /* SSE 文本里是否已经有了某个 id 的 JSON-RPC 回应（MCP 的流式回应：拿到就不必等对方关流）。 */
  function sseHas(text, wantId) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          if (item && item.id === wantId && (item.result !== undefined || item.error !== undefined)) return true;
        }
      } catch { /* 还没收全，或不是 JSON */ }
    }
    return false;
  }

  async function httpOp(payload) {
    let target;
    try { target = new URL(String(payload.url)); } catch { throw fail('网址不对：' + String(payload.url).slice(0, 200)); }
    if (!/^https?:$/.test(target.protocol)) throw fail('只能访问 http / https 地址');
    const method = String(payload.method || 'GET').toUpperCase();
    const headers = {};
    if (payload.headers && typeof payload.headers === 'object') {
      for (const [key, value] of Object.entries(payload.headers)) if (!HOP_HEADERS.has(String(key).toLowerCase())) headers[key] = String(value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), clamp(payload.timeoutMs, 1000, 300000, 30000));
    try {
      const response = await fetch(target, {
        method, headers, redirect: 'follow', signal: controller.signal,
        body: payload.body === null || payload.body === undefined || method === 'GET' || method === 'HEAD' ? undefined : String(payload.body),
      });
      const out = {};
      response.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
      const type = String(out['content-type'] || '');
      if (isBinaryType(type) || !response.body) {
        if (response.body) await response.body.cancel().catch(() => {});
        return { status: response.status, headers: out, text: '', binary: isBinaryType(type), truncated: false, url: response.url };
      }
      const wantId = payload.sseUntilId;
      const until = wantId !== null && wantId !== undefined && /text\/event-stream/i.test(type) ? (text) => sseHas(text, wantId) : null;
      const read = await readCapped(response.body, MAX_HTTP, until);
      return { status: response.status, headers: out, text: read.text, binary: false, truncated: read.truncated, url: response.url };
    } catch (error) {
      if (controller.signal.aborted) throw fail('对方超过时限没有回应');
      throw fail('请求失败：' + String((error.cause && (error.cause.code || error.cause.message)) || error.message));
    } finally { clearTimeout(timer); }
  }

  /* ---------- 浏览器与 MCP ---------- */
  const browser = createBrowser({ config, workspace });
  const mcp = createMcpHub({ workspace });

  async function browserOp(payload) {
    if (!config.browser) throw fail('用户在伴侣的管理页上关掉了无头浏览器。', 'disabled');
    return browser.run(payload);
  }

  const table = {
    env: envOp, exec, job: jobOp,
    fs_list: fsList, fs_read: fsRead, fs_write: fsWrite, fs_remove: fsRemove, fs_grep: fsGrep,
    http: httpOp, browser: browserOp,
    mcp_start: (payload) => { if (!config.exec) throw fail('用户在伴侣的管理页上关掉了命令执行，所以也不能启动命令类的 MCP 服务器。', 'disabled'); return mcp.start(payload); },
    mcp_send: (payload) => mcp.send(payload),
    mcp_stop: (payload) => mcp.stop(payload),
  };

  return {
    table,
    jobsBrief: () => [...jobs.values()].filter((job) => !job.endedAt).map(summary),
    close: async () => {
      for (const job of jobs.values()) killJob(job);
      mcp.closeAll();
      await browser.close().catch(() => {});
    },
  };
}
