#!/usr/bin/env node
/* 只用 Node 标准库的浏览器冒烟。加载 dist/，请在界面完成后先构建。
 * node tools/smoke/run.mjs                 扩展助手，有/无酒馆助手
 * node tools/smoke/run.mjs card            按卡启用，有插件/无酒馆助手且无 MVU
 * node tools/smoke/run.mjs [card] --shots <目录>
 *   第一种模式存三主题 × 桌面/手机 × 大厅/对话/记忆/设置顶部/语义适配，共 30 张 PNG。
 * CHROME=/usr/bin/google-chrome 可指定浏览器。外网只给图片占位，其余请求拦下。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
let SUITE = 'ext', SHOTS = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === 'card' || args[i] === 'ext') SUITE = args[i];
  else if (args[i] === '--shots' && args[i + 1] && !args[i + 1].startsWith('--')) SHOTS = resolve(args[++i]);
  else throw new Error('用法：node tools/smoke/run.mjs [ext|card] [--shots <目录>]');
}
const MODES = SUITE === 'card'
  ? [['有酒馆助手与 MVU', 'auto=1'], ['原生宿主：没有酒馆助手、没有 MVU', 'auto=1&native=1']]
  : [['有酒馆助手', 'auto=1'], ['没有酒馆助手', 'auto=1&th=0']];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.css': 'text/css' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function inside(path) {
  const file = join(ROOT, normalize(decodeURIComponent(path)));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) throw new Error('forbidden');
  return file;
}

function serve(host) {
  const server = http.createServer(async (request, response) => {
    try {
      const file = inside(new URL(request.url, 'http://local').pathname);
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => resolve(server)); });
}

function launch(profile) {
  const binary = process.env.CHROME || '/usr/bin/google-chrome';
  const child = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('浏览器没有在 20 秒内启动')); }, 20000);
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve({ child, endpoint: match[1] }); }
    });
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`启动不了浏览器（${binary}）：${error.message}`)); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`浏览器提前退出了（${code}）`)); });
  });
}

function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  const listeners = new Set();
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) { listeners.forEach((listener) => listener(message)); return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({ send, listeners, close: () => socket.close() }));
    socket.addEventListener('error', () => reject(new Error('连不上浏览器的调试端口')));
  });
}

async function captureShots(cdp, sessionId, evaluate) {
  await mkdir(SHOTS, { recursive: true });
  let count = 0;
  // 截图时按「减少动态效果」渲染：界面的过渡动画随之关掉，不会截到页签淡入淡出的中间态。
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  try {
    for (const theme of ['cafe', 'summer', 'ink']) {
      for (const [viewport, width, height, deviceScaleFactor, mobile] of [
        ['desktop', 1280, 800, 1, false], ['mobile', 375, 812, 2, true],
      ]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile }, sessionId);
        for (const page of ['lobby', 'chat', 'memory', 'settings', 'panel']) {
          await evaluate(`window.__smokeView(${JSON.stringify(theme)}, ${JSON.stringify(page)})`);
          const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, sessionId);
          await writeFile(join(SHOTS, `${theme}-${viewport}-${page}.png`), Buffer.from(data, 'base64'));
          count++;
        }
      }
    }
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    await cdp.send('Emulation.setEmulatedMedia', { features: [] }, sessionId).catch(() => {});
  }
  return count;
}

async function runPage(cdp, url, shots) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [], warnings = [], blocked = [];
  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const eventText = (args) => args.map((arg) => String(arg.value ?? arg.description ?? arg.type)).join(' ');
  const onEvent = async (message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      errors.push((details.exception?.description || details.text).split('\n').slice(0, 3).join(' | '));
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const { type, args } = message.params;
      if (type === 'error' || type === 'assert') errors.push(eventText(args).slice(0, 400));
      else if (type === 'warning') warnings.push(eventText(args).slice(0, 300));
    } else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request, resourceType } = message.params;
      try {
        if (resourceType === 'Image') {
          await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: PNG.toString('base64'), responseHeaders: [{ name: 'Content-Type', value: 'image/png' }] }, sessionId);
        } else {
          blocked.push(resourceType + ' ' + request.url);
          await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId);
        }
      } catch (error) { errors.push('拦截请求失败：' + error.message); }
    }
  };
  cdp.listeners.add(onEvent);
  try {
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }, { urlPattern: 'http://*', requestStage: 'Request' }] }, sessionId);
    // 本机静态资源直接放行；假 API 在页面内拦截，不接触真实服务。
    const originalListener = onEvent;
    cdp.listeners.delete(onEvent);
    const filtered = (message) => {
      if (message.sessionId === sessionId && message.method === 'Fetch.requestPaused' && message.params.request.url.startsWith(new URL(url).origin + '/')) {
        cdp.send('Fetch.continueRequest', { requestId: message.params.requestId }, sessionId).catch((error) => errors.push(error.message));
      } else return originalListener(message);
    };
    cdp.listeners.add(filtered);
    try {
      await cdp.send('Page.navigate', { url }, sessionId);
      const started = Date.now();
      let title = '';
      while (Date.now() - started < 180000) {
        title = await evaluate('document.title').catch(() => '');
        if (/^SMOKE (PASS|FAIL)/.test(title)) break;
        await sleep(250);
      }
      const log = await evaluate("document.getElementById('smoke-log')?.innerText || ''").catch(() => '');
      let shotCount = 0;
      if (shots) {
        try { shotCount = await captureShots(cdp, sessionId, evaluate); }
        catch (error) { errors.push('截图失败：' + error.message); }
      }
      return { title, log, errors, warnings, blocked, shotCount };
    } finally { cdp.listeners.delete(filtered); }
  } finally {
    cdp.listeners.delete(onEvent);
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

async function runSuite(cdp, port) {
  let failed = false;
  for (const [index, [label, query]] of MODES.entries()) {
    const page = SUITE === 'card' ? 'card.html' : 'host.html';
    const outcome = await runPage(cdp, `http://127.0.0.1:${port}/tools/smoke/${page}?${query}`, SHOTS && index === 0);
    failed ||= !/^SMOKE PASS/.test(outcome.title) || outcome.errors.length > 0;
    console.log(`\n== ${label} == ${outcome.title || '180 秒内没有结果'}`);
    console.log(outcome.log.split('\n').filter((line) => /^(PASS|FAIL)/.test(line)).map((line) => '  ' + line).join('\n'));
    for (const error of outcome.errors) console.log('  FAIL 浏览器异常：' + error);
    if (outcome.warnings.length) console.log('  console.warn：' + [...new Set(outcome.warnings)].join(' | '));
    if (outcome.blocked.length) console.log(`  已拦外网请求 ${outcome.blocked.length} 个`);
    if (outcome.shotCount) console.log(`  截图 ${outcome.shotCount} 张：${SHOTS}`);
  }
  return failed;
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'reader-ii-smoke-'));
  let server = null, browser = null, cdp = null;
  let failed = false;
  try {
    server = await serve('127.0.0.1');
    browser = await launch(profile);
    cdp = await connect(browser.endpoint);
    failed = await runSuite(cdp, server.address().port);
  } finally {
    if (cdp) cdp.close();
    if (browser) browser.child.kill();
    if (server) server.close();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 浏览器还占着就留给系统清理 */ }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(String(error && error.message || error)); process.exit(2); });
