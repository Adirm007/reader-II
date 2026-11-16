/*
 * stdio 类 MCP 服务器的转发：在设备上启动服务器进程，把前端发来的 JSON-RPC 消息写进它的标准输入，
 * 从标准输出按行读回应。协议本身（initialize、tools/list、tools/call）由前端的 mcp.js 负责，这里只搬运。
 *
 * 服务器主动发来的请求（要求采样、列目录之类）一律回「不支持」；通知直接丢掉。
 * 空闲 20 分钟自动停掉；伴侣退出时全部停掉。
 */
import { spawn } from 'node:child_process';

const WIN = process.platform === 'win32';
const IDLE_MS = 20 * 60 * 1000;

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

/* Windows 上 npx、uvx 之类是 .cmd，要经 cmd 启动；经 cmd 时参数自己加引号。 */
function quoteWin(arg) {
  const text = String(arg);
  return /^[A-Za-z0-9_./:=@\\-]+$/.test(text) ? text : '"' + text.replace(/"/g, '\\"') + '"';
}

export function createMcpHub({ workspace }) {
  const servers = new Map();
  /* 进程可能在 start 返回后、下一条请求到达前退出；保留最近的原因，避免只报「没在运行」。 */
  const stopped = new Map();

  function stopServer(entry, reason) {
    if (!servers.has(entry.id) || servers.get(entry.id) !== entry) return;
    servers.delete(entry.id);
    stopped.delete(entry.id);
    stopped.set(entry.id, reason || 'MCP 服务器已经停止');
    while (stopped.size > 20) stopped.delete(stopped.keys().next().value);
    if (entry.idle) clearTimeout(entry.idle);
    for (const waiter of entry.pending.values()) { clearTimeout(waiter.timer); waiter.reject(fail(reason || 'MCP 服务器已经停止', 'mcp_not_running')); }
    entry.pending.clear();
    try {
      if (WIN && entry.child.pid) spawn('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else entry.child.kill('SIGTERM');
    } catch { /* 已经没了 */ }
  }

  function touch(entry) {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => stopServer(entry, 'MCP 服务器空闲太久，已经停掉'), IDLE_MS);
    entry.idle.unref();
  }

  async function start(payload) {
    const id = String(payload.id || '');
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(id)) throw fail('服务器的 id 不对');
    const command = String(payload.command || '').trim();
    if (!command) throw fail('没有给出启动命令');
    const args = (Array.isArray(payload.args) ? payload.args : []).map(String);
    const signature = JSON.stringify([command, args, payload.cwd || '']);
    const running = servers.get(id);
    if (running) {
      if (running.signature === signature) { touch(running); return { running: true, started: false, pid: running.child.pid }; }
      stopServer(running, 'MCP 服务器的启动命令变了，已经重启');
    }
    stopped.delete(id);
    const env = { ...process.env };
    if (payload.env && typeof payload.env === 'object') for (const [key, value] of Object.entries(payload.env)) env[String(key)] = String(value);
    let child;
    try {
      child = WIN
        ? spawn([quoteWin(command), ...args.map(quoteWin)].join(' '), [], { cwd: payload.cwd ? String(payload.cwd) : workspace, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(command, args, { cwd: payload.cwd ? String(payload.cwd) : workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { throw fail('启动不了这个 MCP 服务器：' + error.message); }

    const entry = { id, signature, child, pending: new Map(), buffer: '', stderr: '', idle: null };
    servers.set(id, entry);
    touch(entry);

    const decoder = new TextDecoder('utf-8');
    child.stdout.on('data', (chunk) => {
      entry.buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const end = entry.buffer.indexOf('\n');
        if (end < 0) break;
        const line = entry.buffer.slice(0, end).trim();
        entry.buffer = entry.buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { entry.stderr = (entry.stderr + line + '\n').slice(-4000); continue; }
        for (const item of Array.isArray(message) ? message : [message]) {
          if (!item || typeof item !== 'object') continue;
          if (item.id !== undefined && item.id !== null && (item.result !== undefined || item.error !== undefined)) {
            const waiter = entry.pending.get(item.id);
            if (waiter) { entry.pending.delete(item.id); clearTimeout(waiter.timer); waiter.resolve(item); }
          } else if (item.method && item.id !== undefined && item.id !== null) {
            /* 服务器向客户端提的请求：这里不提供采样、目录之类的能力。 */
            try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: item.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); } catch { /* 管道已断 */ }
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => { entry.stderr = (entry.stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    const gone = (why) => stopServer(entry, `MCP 服务器进程退出了（${why}）${entry.stderr.trim() ? '：' + entry.stderr.trim().slice(-600) : ''}`);
    child.on('error', (error) => gone(error.message));
    child.on('exit', (code, signal) => gone(signal ? '信号 ' + signal : '退出码 ' + code));

    /* 尽早报告已经发生的退出；仍存活只表示进程已启动，协议是否就绪要看 initialize 的回应。 */
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!servers.has(id) || servers.get(id) !== entry) throw fail(`MCP 服务器一启动就退出了：${stopped.get(id) || entry.stderr.trim().slice(-600) || '没有任何输出。检查命令与参数，以及要用的工具（node、npx、uvx 等）装了没有。'}`);
    return { running: true, started: true, pid: child.pid };
  }

  function send(payload) {
    const id = String(payload.id || '');
    const entry = servers.get(id);
    if (!entry) return Promise.reject(fail(stopped.get(id) || '这个 MCP 服务器没有在运行', 'mcp_not_running'));
    const message = payload.message;
    if (!message || typeof message !== 'object') return Promise.reject(fail('消息不对'));
    touch(entry);
    const line = JSON.stringify(message) + '\n';
    /* 通知没有回应。 */
    if (message.id === undefined || message.id === null) {
      try { entry.child.stdin.write(line); } catch (error) { return Promise.reject(fail('写不进 MCP 服务器：' + error.message, 'mcp_not_running')); }
      return Promise.resolve({ response: null });
    }
    return new Promise((resolve, reject) => {
      const limit = Math.max(1000, Math.min(600000, Number(payload.timeoutMs) || 60000));
      const timer = setTimeout(() => {
        entry.pending.delete(message.id);
        reject(fail(`MCP 服务器超过 ${Math.round(limit / 1000)} 秒没有回应${entry.stderr.trim() ? '。它最近的输出：' + entry.stderr.trim().slice(-400) : ''}`));
      }, limit);
      entry.pending.set(message.id, { resolve: (response) => resolve({ response }), reject, timer });
      try { entry.child.stdin.write(line); }
      catch (error) { clearTimeout(timer); entry.pending.delete(message.id); reject(fail('写不进 MCP 服务器：' + error.message, 'mcp_not_running')); }
    });
  }

  function stop(payload) {
    const entry = servers.get(String(payload.id || ''));
    if (entry) stopServer(entry, 'MCP 服务器已经停止');
    return { ok: true, wasRunning: !!entry };
  }

  return {
    start, send, stop,
    closeAll: () => { for (const entry of [...servers.values()]) stopServer(entry, '伴侣正在退出'); },
    running: () => [...servers.keys()],
  };
}
