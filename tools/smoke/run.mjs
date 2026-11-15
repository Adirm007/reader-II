#!/usr/bin/env node
/*
 * 无头浏览器冒烟：自己起一个静态服务器和无头 Chrome，逐步打印结果，用退出码表示成败。先 node build.mjs，冒烟加载的是 dist/ 里的包。
 *
 *   node tools/smoke/run.mjs          ① 酒馆扩展：host.html?auto=1 的两种模式（有 / 没有酒馆助手）
 *   node tools/smoke/run.mjs card     ② 卡内组件：card.html?auto=1 的两种模式
 *                                       - 装了扩展，127.0.0.1（完整场景，中途刷新一次进第二阶段）
 *                                       - 没装扩展，用本机的局域网地址打开（非安全上下文，没有 crypto.subtle）；
 *                                         ② 从 CDN 拉 ①，这里把 cdn.jsdelivr.net/gh/Adirm007/reader-II@main/ 换成本地文件
 *                                     其余外网请求一律拦下（图片回一个 1×1 PNG），并经调试协议收集页面与所有 iframe 里的异常和 console.error。
 *   CHROME=/path/to/chrome node tools/smoke/run.mjs [card]
 *
 * 只用 Node 标准库（需要 Node 22+ 的全局 WebSocket）。不用 --virtual-time-budget：
 * IndexedDB 这类真实的异步操作在虚拟时间里跑不完。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUITE = process.argv[2] === 'card' ? 'card' : 'ext';
const MODES = [['有酒馆助手', 'auto=1'], ['没有酒馆助手', 'auto=1&th=0']];
const CDN = 'https://cdn.jsdelivr.net/gh/Adirm007/reader-II@main/';
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
  return new Promise((resolve) => server.listen(0, host, () => resolve(server)));
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) if (item.family === 'IPv4' && !item.internal) return item.address;
  }
  return null;
}

function launch(profile) {
  const binary = process.env.CHROME || '/usr/bin/google-chrome';
  const child = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('浏览器没有在 20 秒内启动')), 20000);
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

async function runPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result.value;
  const started = Date.now();
  let title = '';
  while (Date.now() - started < 60000) {
    title = await evaluate('document.title').catch(() => '');
    if (/^SMOKE (PASS|FAIL)/.test(title)) break;
    await sleep(250);
  }
  const log = await evaluate("document.getElementById('smoke-log').innerText").catch(() => '');
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return { title, log };
}

/* ② 的一页：拦外网请求（CDN 换成本地文件）、收集异常与 console.error / warning，等标题出结果（第一阶段会刷新一次）。 */
async function runCardPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [], warnings = [], blocked = [], served = [];
  const text = (args) => args.map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type)).join(' ');
  const onEvent = async (message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      errors.push('异常：' + (details.exception && details.exception.description || details.text).split('\n').slice(0, 3).join(' | '));
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const type = message.params.type;
      if (type === 'error' || type === 'assert') errors.push('console.error：' + text(message.params.args).slice(0, 400));
      else if (type === 'warning') warnings.push(text(message.params.args).slice(0, 300));
    } else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request, resourceType } = message.params;
      try {
        if (request.url.startsWith(CDN)) {
          const path = new URL(request.url).pathname.slice(new URL(CDN).pathname.length);
          let body;
          try { body = await readFile(inside('/' + path)); } catch { body = null; }
          served.push(path + (body ? '' : '（本地没有，回 404）'));
          await cdp.send('Fetch.fulfillRequest', {
            requestId, responseCode: body ? 200 : 404, body: (body || Buffer.from('not found')).toString('base64'),
            responseHeaders: [{ name: 'Content-Type', value: TYPES[extname(path)] || 'application/octet-stream' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
          }, sessionId);
        } else if (resourceType === 'Image') {
          await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: PNG.toString('base64'), responseHeaders: [{ name: 'Content-Type', value: 'image/png' }] }, sessionId);
        } else {
          blocked.push(`${resourceType} ${request.url.slice(0, 120)}`);
          await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId);
        }
      } catch (error) {
        errors.push('运行器处理请求失败：' + error.message);
      }
    }
  };
  cdp.listeners.add(onEvent);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result.value;
  const started = Date.now();
  let title = '';
  while (Date.now() - started < 180000) {
    title = await evaluate('document.title').catch(() => '');
    if (/^SMOKE (PASS|FAIL)/.test(title)) break;
    await sleep(300);
  }
  const log = await evaluate("document.getElementById('smoke-log').innerText").catch(() => '');
  const missing = await evaluate("JSON.stringify({ helper: [...window.__mock.helperMissing], mvu: [...window.__mock.mvuMissing] })").catch(() => '{}');
  cdp.listeners.delete(onEvent);
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return { title, log, errors, warnings, blocked, served, missing: JSON.parse(missing || '{}') };
}

async function runExtension(cdp, port) {
  let failed = false;
  for (const [label, query] of MODES) {
    const outcome = await runPage(cdp, `http://127.0.0.1:${port}/tools/smoke/host.html?${query}`);
    const ok = /^SMOKE PASS/.test(outcome.title);
    failed = failed || !ok;
    console.log(`\n== ${label} ==  ${outcome.title || '没有跑完（60 秒内没有出结果）'}`);
    console.log(outcome.log.split('\n').filter((line) => /^(PASS|FAIL)/.test(line)).map((line) => '  ' + line).join('\n'));
  }
  return failed;
}

async function runCard(cdp, port) {
  const lan = lanAddress();
  const modes = [['② 装了扩展 · 127.0.0.1', `http://127.0.0.1:${port}/tools/smoke/card.html?auto=1`]];
  if (lan) modes.push([`② 没装扩展 · 局域网 HTTP ${lan}（非安全上下文）`, `http://${lan}:${port}/tools/smoke/card.html?auto=1&ext=0`]);
  else console.log('\n（本机没有局域网 IPv4 地址，跳过「没装扩展 · 非安全上下文」那一遍）');
  let failed = false;
  for (const [label, url] of modes) {
    const outcome = await runCardPage(cdp, url);
    const clean = outcome.errors.length === 0;
    const ok = /^SMOKE PASS/.test(outcome.title) && clean;
    failed = failed || !ok;
    console.log(`\n== ${label} ==  ${outcome.title || '没有跑完（180 秒内没有出结果）'}`);
    console.log(outcome.log.split('\n').filter((line) => /^(PASS|FAIL)/.test(line)).map((line) => '  ' + line).join('\n'));
    console.log(`  ${clean ? 'PASS' : 'FAIL'}  全程（含所有 iframe）没有异常与 console.error${clean ? '' : '：\n' + outcome.errors.map((line) => '        ' + line).join('\n')}`);
    if (outcome.warnings.length) console.log(`  （console.warn ${outcome.warnings.length} 条）\n` + [...new Set(outcome.warnings)].slice(0, 12).map((line) => '        ' + line).join('\n'));
    if (outcome.served.length) console.log(`  （CDN 换成本地文件 ${outcome.served.length} 个：${[...new Set(outcome.served)].slice(0, 6).join('、')}）`);
    if (outcome.blocked.length) console.log(`  （拦下的外网请求 ${outcome.blocked.length} 个）\n` + [...new Set(outcome.blocked)].slice(0, 8).map((line) => '        ' + line).join('\n'));
    const missing = [...(outcome.missing.helper || []).map((name) => 'TavernHelper.' + name), ...(outcome.missing.mvu || []).map((name) => 'Mvu.' + name)];
    if (missing.length) console.log(`  （读过但假酒馆没实现的接口：${missing.join('、')}）`);
  }
  return failed;
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'reader-ii-smoke-'));
  const server = await serve(SUITE === 'card' ? '0.0.0.0' : '127.0.0.1');
  let browser = null;
  let failed = false;
  try {
    browser = await launch(profile);
    const cdp = await connect(browser.endpoint);
    failed = SUITE === 'card' ? await runCard(cdp, server.address().port) : await runExtension(cdp, server.address().port);
    cdp.close();
  } finally {
    if (browser) browser.child.kill();
    server.close();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 浏览器还占着就留给系统清理 */ }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(String(error && error.message || error)); process.exit(2); });
