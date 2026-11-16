/*
 * 无头浏览器：用设备上已有的 Chrome / Chromium / Edge，经调试协议（CDP）操作。不依赖 puppeteer。
 *
 * 用 --remote-debugging-pipe：调试协议走子进程的 3、4 号管道（消息以 \0 分隔的 JSON），不开调试端口，
 * 所以设备上别的程序连不上这个浏览器。每次启动用一个临时的用户目录，关掉时删除——不碰用户自己的浏览器资料。
 * 只开一个标签页；空闲 10 分钟自动关掉。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const IDLE_MS = 10 * 60 * 1000;

function candidates(config) {
  const list = [];
  if (config.browserPath) list.push(config.browserPath);
  if (process.env.CHROME) list.push(process.env.CHROME);
  if (WIN) {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      list.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];
    for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) for (const name of names) list.push(path.join(dir, name));
  }
  return list;
}

export function createBrowser({ config, workspace }) {
  let proc = null, profile = '', buffer = Buffer.alloc(0), sequence = 0, sessionId = '', idle = null, note = '';
  const pending = new Map();
  const consoleLog = [];
  let loadWaiters = [];

  function find() {
    for (const file of candidates(config)) {
      try { if (fs.statSync(file).isFile()) return file; } catch { /* 不存在 */ }
    }
    return '';
  }

  function record(kind, text) {
    consoleLog.push({ at: Date.now(), kind, text: String(text).slice(0, 1000) });
    if (consoleLog.length > 200) consoleLog.splice(0, consoleLog.length - 200);
  }

  function onMessage(message) {
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || 'CDP 出错'));
      else waiter.resolve(message.result || {});
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type)).join(' ');
      record(message.params.type, text);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails || {};
      record('exception', (details.exception && details.exception.description) || details.text || '未知异常');
    } else if (message.method === 'Page.loadEventFired') {
      const waiters = loadWaiters;
      loadWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  function send(method, params, session) {
    if (!proc) return Promise.reject(new Error('浏览器没有在运行'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      const message = { id, method, params: params || {} };
      if (session) message.sessionId = session;
      proc.stdio[3].write(JSON.stringify(message) + '\0', (error) => { if (error) { pending.delete(id); reject(error); } });
    });
  }

  function teardown(reason) {
    for (const waiter of pending.values()) waiter.reject(new Error(reason || '浏览器已经关闭'));
    pending.clear();
    loadWaiters.forEach((resolve) => resolve());
    loadWaiters = [];
    proc = null;
    sessionId = '';
    buffer = Buffer.alloc(0);
    if (idle) { clearTimeout(idle); idle = null; }
    const dir = profile;
    profile = '';
    if (dir) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  function boot(binary, noSandbox) {
    return new Promise((resolve, reject) => {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-ii-browser-'));
      const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--mute-audio', '--window-size=1280,900', 'about:blank'];
      if (noSandbox) args.unshift('--no-sandbox');
      let child;
      try { child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true }); }
      catch (error) { reject(error); return; }
      let settled = false;
      const started = Date.now();
      child.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
      child.on('exit', (code) => {
        if (!settled) { settled = true; const early = new Error(`浏览器刚启动就退出了（退出码 ${code}）`); early.early = Date.now() - started < 8000; reject(early); }
        if (proc === child) teardown('浏览器进程退出了');
      });
      child.stdio[3].on('error', () => {});
      child.stdio[4].on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const end = buffer.indexOf(0);
          if (end < 0) break;
          const raw = buffer.subarray(0, end).toString('utf8');
          buffer = buffer.subarray(end + 1);
          try { onMessage(JSON.parse(raw)); } catch { /* 不是完整的消息 */ }
        }
      });
      proc = child;
      /* 能答上一条命令就算起来了。 */
      send('Target.getTargets').then(() => { if (!settled) { settled = true; resolve(); } }, (error) => { if (!settled) { settled = true; reject(error); } });
      setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch { /* ignore */ } reject(new Error('浏览器 20 秒内没有起来')); } }, 20000).unref();
    });
  }

  async function ensure() {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { close().catch(() => {}); }, IDLE_MS);
    idle.unref();
    if (proc && sessionId) return;
    if (proc) await close();
    const binary = find();
    if (!binary) throw new Error('这台设备上没有找到 Chrome / Chromium / Edge，无头浏览器用不了。装上其中一个，或请用户在伴侣的管理页里填浏览器的路径。');
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    note = '';
    try { await boot(binary, root || process.env.READER_II_CHROME_NO_SANDBOX === '1'); }
    catch (error) {
      teardown('启动失败');
      if (!error.early || root) throw new Error(`启动浏览器失败（${binary}）：${error.message}`);
      /* 有些虚拟机、容器里沙箱起不来：再试一次不带沙箱的，并如实说明。 */
      try { await boot(binary, true); note = '（这台设备上浏览器的沙箱起不来，这次是以 --no-sandbox 启动的：只打开信得过的网页。）'; }
      catch (second) { teardown('启动失败'); throw new Error(`启动浏览器失败（${binary}）：${second.message}`); }
    }
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
  }

  async function evaluate(expression) {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (out.exceptionDetails) {
      const details = out.exceptionDetails;
      throw new Error('页面里的脚本出错：' + String((details.exception && details.exception.description) || details.text || '未知错误').slice(0, 1500));
    }
    return out.result ? out.result.value : undefined;
  }

  async function close() {
    const child = proc;
    if (!child) return;
    try {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        const done = () => { clearTimeout(timer); resolve(); };
        send('Browser.close').then(done, done);
      });
    } catch { /* 已经关了 */ }
    try { child.kill(); } catch { /* ignore */ }
    if (proc === child) teardown('浏览器已经关闭');
  }

  async function run(payload) {
    const action = String(payload.action || '');
    if (action === 'close') { await close(); return '浏览器已关闭。'; }
    if (action === 'status') return proc ? { running: true, url: sessionId ? await evaluate('location.href').catch(() => '') : '' } : { running: false };
    if (!['open', 'text', 'eval', 'click', 'type', 'console', 'screenshot'].includes(action)) throw new Error('action 只能是 open | text | eval | click | type | console | screenshot | close');
    if (action !== 'open' && !proc) throw new Error('浏览器还没打开：先用 action=open 打开一个网址。');
    await ensure();

    if (action === 'open') {
      let target;
      try { target = new URL(String(payload.url || '')); } catch { throw new Error('url 要是完整的网址'); }
      if (!/^(?:https?|file):$/.test(target.protocol)) throw new Error('只能打开 http / https / file 地址');
      consoleLog.length = 0;
      const loaded = new Promise((resolve) => { loadWaiters.push(resolve); });
      const nav = await send('Page.navigate', { url: target.href }, sessionId);
      if (nav.errorText) throw new Error('打不开这个地址：' + nav.errorText);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 20000);
        loaded.then(() => { clearTimeout(timer); resolve(); });
      });
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(20000, Number(payload.waitMs) || 300))));
      const info = await evaluate('({ title: document.title, url: location.href, chars: document.body ? document.body.innerText.length : 0 })');
      const errors = consoleLog.filter((item) => item.kind === 'error' || item.kind === 'exception').length;
      return `已打开：${info.title || '（无标题）'}  ${info.url}\n页面文字 ${info.chars} 字${errors ? `，控制台有 ${errors} 条报错（action=console 查看）` : ''}。用 action=text 取文字。${note}`;
    }
    if (action === 'text') {
      const selector = payload.selector ? JSON.stringify(String(payload.selector)) : 'null';
      const out = await evaluate(`(() => { const sel = ${selector}; const node = sel ? document.querySelector(sel) : document.body; if (!node) return { missing: true }; return { title: document.title, url: location.href, text: String(node.innerText || node.textContent || '') }; })()`);
      if (out.missing) throw new Error('页面里没有匹配这个选择器的元素：' + String(payload.selector));
      return `${out.title || '（无标题）'}  ${out.url}\n\n${out.text.length > 60000 ? out.text.slice(0, 60000) + `\n…（共 ${out.text.length} 字，已截断；用 selector 只取需要的部分）` : out.text}`;
    }
    if (action === 'eval') {
      const value = await evaluate(`(async () => {\n${String(payload.code || '')}\n})()`);
      if (value === undefined) return '（没有返回值）';
      try { return typeof value === 'string' ? value : JSON.stringify(value, null, 1); } catch { return String(value); }
    }
    if (action === 'click' || action === 'type') {
      if (!payload.selector) throw new Error('要给出 selector');
      const selector = JSON.stringify(String(payload.selector));
      const found = await evaluate(`(() => { const node = document.querySelector(${selector}); if (!node) return false; node.scrollIntoView({ block: 'center' }); ${action === 'click' ? 'node.click();' : 'node.focus(); if ("value" in node) node.value = "";'} return true; })()`);
      if (!found) throw new Error('页面里没有匹配这个选择器的元素：' + String(payload.selector));
      if (action === 'type') {
        await send('Input.insertText', { text: String(payload.text == null ? '' : payload.text) }, sessionId);
        await evaluate(`(() => { const node = document.querySelector(${selector}); if (node) { node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return action === 'click' ? '已点击。' : '已输入。';
    }
    if (action === 'console') {
      return consoleLog.slice(-80).map((item) => `${new Date(item.at).toLocaleTimeString()} [${item.kind}] ${item.text}`).join('\n') || '（控制台没有输出）';
    }
    /* screenshot */
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const dir = path.join(workspace, 'screenshots');
    await fsp.mkdir(dir, { recursive: true });
    const name = new Date().toISOString().replace(/[:.]/g, '-') + '.png';
    await fsp.writeFile(path.join(dir, name), Buffer.from(shot.data, 'base64'));
    return `截图存在 dev:/@ws/screenshots/${name}（${path.join(dir, name)}）。你看不到图片本身：需要判断画面请用 text / eval 取信息，或请用户打开它看。`;
  }

  return { run, close, find };
}
