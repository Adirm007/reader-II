import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { currentLetterView, transformLetter } from '../build/controller.mjs';
import { assertNoMacro, assertSyntax } from '../build/lib.mjs';

/*
 * ② 常驻壳（交接 7.D）：在真 Chrome（无头）里跑 src/reader-shell.js。
 * 假酒馆主页 + 假酒馆助手脚本 iframe；资源包 = 假控制器 + 上游变换后的真轻信（letter.js 与当前视图）。② 的完整冒烟在 7.G。
 * 运行：node --test tests/shell.test.mjs   （CHROME=/path/to/chrome 可换浏览器；找不到浏览器时跳过浏览器那几项）
 * 只用 Node 标准库（Node 22+ 的全局 WebSocket）。
 */
const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const up = (name) => fs.readFileSync(path.join(dir, 'upstream/reader/source', name), 'utf8');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SKIP = fs.existsSync(CHROME) ? false : `找不到 Chrome（${CHROME}）`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NAME1 = 'A"lice<&>\'';
const NAME2 = '夜梦';
const HTML_NAME1 = NAME1.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EVENTS = {
  CHAT_CHANGED: 'chat_id_changed', MESSAGE_SENT: 'message_sent', USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', MESSAGE_RECEIVED: 'message_received', MESSAGE_UPDATED: 'message_updated',
  MESSAGE_EDITED: 'message_edited', MESSAGE_SWIPED: 'message_swiped', MESSAGE_DELETED: 'message_deleted', GENERATION_ENDED: 'generation_ended',
};

/* 假控制器：记下壳注入的东西，提供 ReaderController 的接口。字符串里的两个宏要被壳按 script 模式替换。 */
const FAKE_CONTROLLER = String.raw`(function () {
  var world = window.parent.__world;
  var settings = { theme: 'summer', mode: 'inline', address: '', fontSize: 16, defaultFontSize: 16, ui: { css: '', art: {} } };
  world.controllers.push({
    generation: window.__readerRuntimeGeneration,
    core: window.ReaderCore && window.ReaderCore.marker,
    hostApi: window.__readerHostApi === window.parent.ReaderShell,
    helper: typeof window.TavernHelper.fakeHelperFn === 'function' ? window.TavernHelper.fakeHelperFn() : null,
    lodash: typeof window._ === 'function' && typeof window._.get === 'function',
    tavern: window.SillyTavern === window.parent.SillyTavern,
    eventOn: typeof window.eventOn,
    events: window.tavern_events && window.tavern_events.CHAT_CHANGED,
    user: '<user>',
    char: "{{char}}",
    body: document.getElementById('ctl-body').textContent
  });
  window.ReaderController = {
    open: function (page) { world.calls.push(['open', page]); return true; },
    close: function () { world.calls.push(['close']); },
    command: function (name) { world.calls.push(['command', name].concat([].slice.call(arguments, 1))); return 'ok:' + name; },
    settings: function () { return settings; },
    refreshEnvelope: function () { world.envelopes += 1; },
    dispose: function () { world.calls.push(['dispose', window.__readerRuntimeGeneration]); }
  };
})();`;

function assetsModule(packed) {
  return `(function (root) { var m = root.__ReaderIIModules = root.__ReaderIIModules || {}; m.READER_ASSETS_GZIP = ${JSON.stringify(packed)}; })(typeof globalThis !== 'undefined' ? globalThis : window);`;
}
const ASSETS = {
  version: 'shell-test',
  css: '#ctl-body{color:#123}',
  body: '<div id="ctl-body">给 <user> 的菜单</div>',
  controller: FAKE_CONTROLLER,
  letterViews: { current: currentLetterView(up('letter-body.html'), up('reader-letter.css')) },
  letterScript: transformLetter(up('letter.js'), { legacyLetterBody: up('legacy-letter-body.html'), legacyCss: up('legacy-reader.css') }),
};
const ROUTES = {
  '/assets.js': assetsModule(gzipSync(Buffer.from(JSON.stringify(ASSETS))).toString('base64')),
  '/assets-broken.js': assetsModule(gzipSync(Buffer.from('{"version":"broken"}')).toString('base64')),
};

const HOST_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>假酒馆</title></head>
<body>
<div id="chat"></div>
<div id="dfb">旧信封</div><div id="dlb-overlay"></div><style id="dlb-style"></style><div id="dream-hb"></div><div id="reader-core-launcher"></div>
<script>
(function () {
  var world = window.__world = {
    chatId: 'chat-1', characterId: '0', name1: ${JSON.stringify(NAME1)}, name2: ${JSON.stringify(NAME2)},
    chat: [{ mes: 'm0', swipe_id: 0 }, { mes: 'm1', swipe_id: 0 }, { mes: 'm2', swipe_id: 0 }, { mes: 'm3', swipe_id: 0 }],
    listeners: {}, firsts: [], removed: [], controllers: [], calls: [], envelopes: 0, readyEvents: 0,
    previousStopped: 0, staleDisposed: 0, scriptLoaded: false
  };
  window.__events = ${JSON.stringify(EVENTS)};
  window.__dhb = setInterval(function () {}, 100000);
  window.ReaderShell = { stop: function () { world.previousStopped += 1; } };
  var context = {
    get chat() { return world.chat; },
    get characterId() { return world.characterId; },
    get chatId() { return world.chatId; },
    getCurrentChatId: function () { return world.chatId; },
    get name1() { return world.name1; },
    get name2() { return world.name2; },
    chatMetadata: { variables: {} },
    eventTypes: { GENERATION_AFTER_COMMANDS: 'generation_after_commands' },
    eventSource: {
      on: function () {},
      makeFirst: function (event, fn) { world.firsts.push({ event: event, fn: fn }); },
      removeListener: function (event) { world.removed.push(event); }
    }
  };
  window.SillyTavern = { getContext: function () { return context; } };
  document.addEventListener('reader:ready', function () { world.readyEvents += 1; });
  window.__emit = function (name) {
    (world.listeners[window.__events[name]] || []).slice().forEach(function (handler) { handler(); });
  };
  window.__slot = function (text, mounted) {
    return '<div data-reader-dream-slot="1" data-preserve-html="1"' + (mounted ? ' data-reader-mounted="' + mounted + '"' : '') + '><div data-reader-dream-source>' + text + '</div></div>';
  };
  window.__message = function (id, html) {
    var mes = document.createElement('div');
    mes.className = 'mes';
    mes.setAttribute('mesid', String(id));
    var text = document.createElement('div');
    text.className = 'mes_text';
    text.innerHTML = html;
    mes.appendChild(text);
    document.getElementById('chat').appendChild(mes);
    return text;
  };
  /* 上一个壳死掉时留下的控制器 */
  var stale = document.createElement('iframe');
  stale.id = 'reader-ii-controller';
  document.body.appendChild(stale);
  stale.contentWindow.ReaderController = { dispose: function () { world.staleDisposed += 1; } };
  /* 楼层 0 在主文档；楼层 1 在两层嵌套的正文美化 iframe 里（内层是外层加载后才建的）；楼层 3 是外层渲染复制出的陈旧 loading 占位 */
  window.__message(0, '开场白' + window.__slot('第一封信 <b>粗体</b>'));
  var outer = document.createElement('iframe');
  outer.id = 'beauty-outer';
  outer.addEventListener('load', function () {
    var holder = outer.contentDocument.getElementById('inner-host');
    if (!holder || holder.querySelector('iframe')) return;
    var inner = outer.contentDocument.createElement('iframe');
    inner.id = 'beauty-inner';
    inner.srcdoc = '<!doctype html><html><body>美化内层' + window.__slot('嵌套的信') + '</body></html>';
    holder.appendChild(inner);
  });
  outer.srcdoc = '<!doctype html><html><body><div id="inner-host">美化外层</div></body></html>';
  window.__message(1, '').appendChild(outer);
  window.__message(3, window.__slot('复制出的信', 'loading'));
  /* 酒馆助手的脚本 iframe 最后加载 */
  var script = document.createElement('iframe');
  script.id = 'th-script';
  script.style.display = 'none';
  script.src = '/script.html' + location.search;
  document.body.appendChild(script);
})();
</script>
</body></html>`;

const scriptHtml = (assets) => `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script>
  var world = parent.__world;
  window.tavern_events = parent.__events;
  window.eventOn = function (event, handler) {
    var list = world.listeners[event] = world.listeners[event] || [];
    list.push(handler);
    return { stop: function () { var at = list.indexOf(handler); if (at >= 0) list.splice(at, 1); } };
  };
  window.TavernHelper = { fakeHelperFn: function () { return this === window.TavernHelper ? 'bound' : 'unbound'; } };
  window._ = function () {};
  window._.get = function () { return 'lodash'; };
</script>
<script src="/src/reader-env.js"></script>
<script src="/src/reader-host-kit.js"></script>
<script src="${assets}"></script>
<script src="/src/reader-shell.js"></script>
<script>
  window.startShell = function () {
    var modules = window.__ReaderIIModules;
    var env = modules.createEnv(window);
    return modules.createShell({ __reader_core_api: true, marker: 'semantic-layer', kit: modules.createHostKit(env) }, env, { prepareTimeout: 3000 });
  };
  window.shell = window.startShell();
  world.scriptLoaded = true;
</script>
</body></html>`;

/* ---------- 静态服务器 + 无头 Chrome（同 tools/smoke/run.mjs 的做法） ---------- */
function serve() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://local');
    let body = null, type = 'text/javascript; charset=utf-8';
    if (url.pathname === '/host.html') { body = HOST_HTML; type = 'text/html; charset=utf-8'; }
    else if (url.pathname === '/script.html') { body = scriptHtml(url.searchParams.get('assets') === 'broken' ? '/assets-broken.js' : '/assets.js'); type = 'text/html; charset=utf-8'; }
    else if (ROUTES[url.pathname]) body = ROUTES[url.pathname];
    else if (/^\/src\/[\w.-]+\.js$/.test(url.pathname)) {
      try { body = fs.readFileSync(path.join(dir, url.pathname)); } catch { body = null; }
    }
    if (body === null) { response.writeHead(404); response.end('not found'); return; }
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function launch(profile) {
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('浏览器没有在 20 秒内启动')), 20000);
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve({ child, endpoint: match[1] }); }
    });
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`启动不了浏览器（${CHROME}）：${error.message}`)); });
  });
}

function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  const listeners = new Set();
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method) { listeners.forEach((listener) => listener(message)); return; }
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

let server = null, browser = null, cdp = null, profile = null, base = '';

before(async () => {
  if (SKIP) return;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-ii-shell-'));
  server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launch(profile);
  cdp = await connect(browser.endpoint);
});

after(async () => {
  if (cdp) cdp.close();
  if (browser) browser.child.kill();
  if (server) server.close();
  await sleep(300);
  if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 浏览器还占着就留给系统清理 */ } }
});

/* 每项一个新页面；收集页面里（含同源 iframe）的异常与 console 的 error / warning。 */
async function openPage(pathname) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const problems = [];
  const collect = (message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      problems.push('exception: ' + (details.exception && details.exception.description || details.text));
    } else if (message.method === 'Runtime.consoleAPICalled' && (message.params.type === 'error' || message.params.type === 'warning')) {
      problems.push(message.params.type + ': ' + message.params.args.map((arg) => arg.value !== undefined ? String(arg.value) : arg.description || '').join(' '));
    }
  };
  cdp.listeners.add(collect);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: base + pathname }, sessionId);
  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error('页面里出错：' + (result.exceptionDetails.exception && result.exceptionDetails.exception.description || result.exceptionDetails.text));
    return result.result.value;
  };
  const waitFor = async (expression, timeout = 8000) => {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeout) {
      try { last = await evaluate(expression); if (last) return last; } catch (error) { last = error.message; }
      await sleep(50);
    }
    throw new Error(`等不到：${expression}（最后一次：${JSON.stringify(last)}）`);
  };
  const close = async () => {
    cdp.listeners.delete(collect);
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  };
  await waitFor('!!(window.__world && window.__world.scriptLoaded)');
  return { evaluate, waitFor, close, problems };
}

/* 页面里收集所有轻信 iframe（递归进同源的嵌套 iframe）。 */
const LETTER_FRAMES = `(() => {
  const frames = [];
  (function walk(doc) {
    doc.querySelectorAll('iframe').forEach((frame) => {
      if (frame.hasAttribute('data-reader-dream-frame')) frames.push(frame);
      else if (frame.contentDocument) walk(frame.contentDocument);
    });
  })(document);
  return frames;
})()`;

/* ---------- 测试 ---------- */

test('壳的源码：语法正确，没有酒馆宏、结束 script 标签与 $+数字（主脚本会经过这些检查）', () => {
  const source = fs.readFileSync(path.join(dir, 'src/reader-shell.js'), 'utf8');
  assertSyntax(source, 'reader-shell.js');
  assertNoMacro(source, 'reader-shell.js');
  assert.equal(/<\/script/i.test(source), false);
  assert.equal(/\$\d/.test(source), false);
});

test('启动：清掉旧节点与死掉的控制器，控制器就绪，注入全局与宏，派发 reader:ready，挂上生成前钩子', { skip: SKIP }, async () => {
  const page = await openPage('/host.html');
  try {
    const r = await page.evaluate(`(async () => {
      const shell = window.ReaderShell, w = window.__world;
      const app = await shell.ready;
      const frame = document.getElementById('reader-ii-controller');
      const style = getComputedStyle(frame);
      return {
        isShell: shell.__reader_shell_api === true && shell === document.getElementById('th-script').contentWindow.shell,
        app: !!app && app === frame.contentWindow.ReaderController,
        legacy: ['dfb', 'dlb-overlay', 'dlb-style', 'dream-hb', 'reader-core-launcher'].filter((id) => document.getElementById(id)),
        frames: document.querySelectorAll('#reader-ii-controller').length,
        hidden: [frame.getAttribute('aria-hidden'), style.opacity, style.pointerEvents, style.position].join('|'),
        staleDisposed: w.staleDisposed, previousStopped: w.previousStopped, heartbeat: window.__dhb,
        controllers: w.controllers, readyEvents: w.readyEvents, firsts: w.firsts.map((f) => f.event),
        canOwn: shell.canOwnEnvelope, alive: shell.isAlive, version: shell.runtimeVersion,
        latest: shell.getLatestMessageId(), theme: shell.settings().theme,
        opened: await shell.open('memory'), lobby: await shell.open(), command: await shell.command('openGacha', 7),
        calls: w.calls.slice(),
        macroHtml: shell.macroText('a<user>b{{USER}}c<char>d{{char}}e<BOT>'),
        macroScript: shell.macroText('<user>', true),
      };
    })()`);
    assert.equal(r.isShell, true);
    assert.equal(r.app, true);
    assert.deepEqual(r.legacy, [], '旧节点要在启动时清掉');
    assert.equal(r.frames, 1);
    assert.equal(r.hidden, 'true|0|none|fixed');
    assert.equal(r.staleDisposed, 1, '死掉的控制器先 dispose 再移走');
    assert.equal(r.previousStopped, 1, '上一个壳要先停掉');
    assert.equal(r.heartbeat, null, '旧版心跳要清掉');
    assert.equal(r.controllers.length, 1);
    const injected = r.controllers[0];
    assert.equal(typeof injected.generation, 'number');
    assert.equal(injected.core, 'semantic-layer', '控制器里要有语义层 ReaderCore');
    assert.equal(injected.hostApi, true);
    assert.equal(injected.helper, 'bound', 'TavernHelper 代理把函数绑回原主人');
    assert.equal(injected.lodash, true, 'lodash 原样传过去，不能 bind');
    assert.equal(injected.tavern, true);
    assert.equal(injected.eventOn, 'function');
    assert.equal(injected.events, EVENTS.CHAT_CHANGED);
    assert.equal(injected.user, NAME1, '控制器脚本里的宏按 script 模式转义');
    assert.equal(injected.char, NAME2);
    assert.equal(injected.body, `给 ${NAME1} 的菜单`, '控制器 body 里的宏按 HTML 转义');
    assert.equal(r.readyEvents, 1, 'reader:ready 派发到酒馆主文档');
    assert.deepEqual(r.firsts, ['generation_after_commands']);
    assert.equal(r.canOwn, true);
    assert.equal(r.alive, true);
    assert.equal(r.version, 'shell-test');
    assert.equal(r.latest, 3);
    assert.equal(r.theme, 'summer');
    assert.equal(r.opened, true);
    assert.equal(r.lobby, true);
    assert.equal(r.command, 'ok:openGacha');
    assert.deepEqual(r.calls, [['open', 'memory'], ['open', 'lobby'], ['command', 'openGacha', 7]]);
    assert.equal(r.macroHtml, `a${HTML_NAME1}b${HTML_NAME1}c${NAME2}d${NAME2}e${NAME2}`);
    assert.equal(r.macroScript, JSON.stringify(NAME1).slice(1, -1).replace(/'/g, '\\u0027'));
    assert.deepEqual(page.problems, []);
  } finally { await page.close(); }
});

test('轻信挂载：主文档、两层嵌套的同源 iframe、后来加的楼层、复制出的陈旧占位；楼层号、宏、设置、自适应高度', { skip: SKIP }, async () => {
  const page = await openPage('/host.html');
  try {
    await page.evaluate('(async () => { await window.ReaderShell.ready; return true; })()');
    await page.evaluate(`(window.__message(2, '后来的楼层' + window.__slot('后来的信')), true)`);
    await page.waitFor('[0, 1, 2, 3].every((id) => window.ReaderShell.getLetters(id).length === 1)');
    const r = await page.evaluate(`(() => {
      const frames = ${LETTER_FRAMES};
      const slots = [];
      (function walk(doc) {
        doc.querySelectorAll('[data-reader-dream-slot]').forEach((slot) => slots.push(slot.getAttribute('data-reader-mounted')));
        doc.querySelectorAll('iframe:not([data-reader-dream-frame])').forEach((frame) => { if (frame.contentDocument) walk(frame.contentDocument); });
      })(document);
      return {
        letters: [0, 1, 2, 3].map((id) => window.ReaderShell.getLetters(id).map((letter) => letter.html.trim())),
        ids: frames.map((frame) => frame.getAttribute('data-reader-message-id')).sort(),
        slots: slots.sort(),
        dear: frames.map((frame) => [...frame.contentDocument.querySelectorAll('[data-dream-dear],#dream-dear-name')].map((node) => node.textContent)),
        userTags: frames.filter((frame) => frame.contentDocument.querySelector('user')).length,
        themes: frames.map((frame) => frame.contentDocument.documentElement.getAttribute('data-dream-theme')),
        heights: frames.map((frame) => parseFloat(frame.style.height)),
        leftovers: frames.filter((frame) => frame.parentElement.querySelector('[data-reader-dream-source]')).length,
        nested: frames.filter((frame) => frame.ownerDocument !== document).map((frame) => frame.ownerDocument.defaultView.frameElement.id),
      };
    })()`);
    assert.deepEqual(r.letters, [['第一封信 <b>粗体</b>'], ['嵌套的信'], ['后来的信'], ['复制出的信']]);
    assert.deepEqual(r.ids, ['0', '1', '2', '3'], '每个轻信 iframe 上都有 data-reader-message-id（嵌套的取外层 .mes 的楼层）');
    assert.deepEqual(r.slots, ['1', '1', '1', '1']);
    assert.deepEqual(r.nested, ['beauty-inner']);
    for (const names of r.dear) assert.deepEqual(names, [NAME1, NAME1, NAME1], '轻信 HTML 里的宏换成名字（HTML 转义）');
    assert.equal(r.userTags, 0);
    assert.deepEqual(r.themes, ['summer', 'summer', 'summer', 'summer'], '登记后收到控制器的设置');
    for (const height of r.heights) assert.ok(height > 100, `轻信 iframe 要按内容撑高（${height}）`);
    assert.equal(r.leftovers, 0, '挂好后原文节点由 iframe 取代');

    const size = await page.evaluate(`(async () => {
      const frame = ${LETTER_FRAMES}.find((item) => item.getAttribute('data-reader-message-id') === '0');
      const before = parseFloat(frame.style.height);
      const tall = frame.contentDocument.createElement('div');
      tall.style.height = '1500px';
      frame.contentDocument.body.appendChild(tall);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const grown = parseFloat(frame.style.height);
      tall.remove();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { before, grown, after: parseFloat(frame.style.height) };
    })()`);
    assert.ok(size.grown >= size.before + 1400, `内容变高时跟着变高：${JSON.stringify(size)}`);
    assert.ok(Math.abs(size.after - size.before) <= 2, `内容变矮时缩回去：${JSON.stringify(size)}`);
    assert.deepEqual(page.problems, []);
  } finally { await page.close(); }
});

test('聊天切换：旧控制器销毁、新控制器重建、只留新聊天的信；同一聊天的消息事件不重建；生成前发现换了聊天也重建', { skip: SKIP }, async () => {
  const page = await openPage('/host.html');
  try {
    await page.evaluate('(async () => { await window.ReaderShell.ready; return true; })()');
    await page.waitFor('window.ReaderShell.getLetters(0).length === 1');
    const r = await page.evaluate(`(async () => {
      const w = window.__world, shell = window.ReaderShell;
      const first = document.getElementById('reader-ii-controller');
      const firstGeneration = w.controllers[0].generation;
      window.__emit('MESSAGE_UPDATED');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sameChat = { controllers: w.controllers.length, sameFrame: document.getElementById('reader-ii-controller') === first };
      w.chatId = 'chat-2';
      w.chat = [{ mes: 'n0', swipe_id: 0 }];
      document.getElementById('chat').replaceChildren();
      window.__message(0, '新聊天' + window.__slot('新聊天的信'));
      window.__emit('CHAT_CHANGED');
      const app = await shell.ready;
      const second = document.getElementById('reader-ii-controller');
      return {
        sameChat, firstGeneration,
        disposed: w.calls.filter((call) => call[0] === 'dispose').map((call) => call[1]),
        controllers: w.controllers.map((item) => item.generation),
        frames: document.querySelectorAll('#reader-ii-controller').length,
        replaced: !first.isConnected && second !== first && app === second.contentWindow.ReaderController,
        readyEvents: w.readyEvents,
      };
    })()`);
    assert.deepEqual(r.sameChat, { controllers: 1, sameFrame: true }, '同一聊天的消息事件只推设置，不重建');
    assert.deepEqual(r.disposed, [r.firstGeneration], '旧控制器先 dispose');
    assert.equal(r.controllers.length, 2);
    assert.ok(r.controllers[1] > r.controllers[0]);
    assert.equal(r.frames, 1);
    assert.equal(r.replaced, true);
    assert.equal(r.readyEvents, 2, '新控制器就绪时再派发一次 reader:ready');
    await page.waitFor(`(() => { const letters = window.ReaderShell.getLetters(0); return letters.length === 1 && letters[0].html.includes('新聊天的信'); })()`);
    const prepare = await page.evaluate(`(async () => {
      const w = window.__world, prepare = w.firsts[0].fn;
      const before = w.controllers.length;
      await prepare('normal', {}, true);
      const dryRun = w.controllers.length - before;
      w.chatId = 'chat-3';
      w.chat = [];
      document.getElementById('chat').replaceChildren();
      await prepare('normal', {}, false);
      return { dryRun, rebuilt: w.controllers.length - before, ready: !!document.getElementById('reader-ii-controller').contentWindow.ReaderController };
    })()`);
    assert.deepEqual(prepare, { dryRun: 0, rebuilt: 1, ready: true }, '生成前钩子发现聊天变了就重建，并等到控制器就绪');
    assert.deepEqual(page.problems, []);
  } finally { await page.close(); }
});

test('停止与重启：stop 拆掉控制器、事件、生成前钩子与观察器；新壳接管已挂好的轻信，也挂上停着时出现的插槽', { skip: SKIP }, async () => {
  const page = await openPage('/host.html');
  try {
    await page.evaluate('(async () => { await window.ReaderShell.ready; return true; })()');
    await page.waitFor('[0, 1, 3].every((id) => window.ReaderShell.getLetters(id).length === 1)');
    const r = await page.evaluate(`(async () => {
      const w = window.__world, old = window.ReaderShell;
      old.stop();
      const result = {
        alive: old.isAlive, global: 'ReaderShell' in window, frames: document.querySelectorAll('#reader-ii-controller').length,
        removed: w.removed.slice(), listeners: Object.values(w.listeners).reduce((count, list) => count + list.length, 0),
        opened: await old.open('lobby'), letters: old.getLetters(0).length,
      };
      w.chat.push({ mes: 'm4', swipe_id: 0 });
      window.__message(4, '停着时的楼层' + window.__slot('停着时的信'));
      await new Promise((resolve) => setTimeout(resolve, 700));
      result.unmounted = document.querySelector('.mes[mesid="4"] [data-reader-dream-slot]').getAttribute('data-reader-mounted');
      const next = document.getElementById('th-script').contentWindow.startShell();
      await next.ready;
      result.replaced = window.ReaderShell === next && next !== old;
      return result;
    })()`);
    assert.equal(r.alive, false);
    assert.equal(r.global, false, '停掉后从酒馆主窗口摘掉');
    assert.equal(r.frames, 0);
    assert.deepEqual(r.removed, ['generation_after_commands']);
    assert.equal(r.listeners, 0, '酒馆事件都退订');
    assert.equal(r.opened, false);
    assert.equal(r.letters, 0);
    assert.equal(r.unmounted, null, '停掉后不再挂插槽（观察器已断开）');
    assert.equal(r.replaced, true);
    await page.waitFor('[0, 1, 3, 4].every((id) => window.ReaderShell.getLetters(id).length === 1)');
    const count = await page.evaluate(`${LETTER_FRAMES}.length`);
    assert.equal(count, 4, '已挂好的轻信不重挂，只重新登记');
    assert.deepEqual(page.problems, []);
  } finally { await page.close(); }
});

test('资源包坏了：控制器不起，插槽标记 failed 并保留原文', { skip: SKIP }, async () => {
  const page = await openPage('/host.html?assets=broken');
  try {
    assert.equal(await page.evaluate('(async () => (await window.ReaderShell.ready) === null)()'), true);
    await page.waitFor(`document.querySelector('.mes[mesid="0"] [data-reader-dream-slot]').getAttribute('data-reader-mounted') === 'failed'`);
    const r = await page.evaluate(`(async () => ({
      text: document.querySelector('.mes[mesid="0"] [data-reader-dream-source]').innerHTML,
      frames: document.querySelectorAll('#reader-ii-controller').length,
      opened: await window.ReaderShell.open('lobby'),
    }))()`);
    assert.deepEqual(r, { text: '第一封信 <b>粗体</b>', frames: 0, opened: false });
    assert.ok(page.problems.some((line) => line.includes('控制器资源包不完整')), page.problems.join('\n'));
    assert.ok(page.problems.some((line) => line.includes('轻信挂载失败，已保留原文')), page.problems.join('\n'));
  } finally { await page.close(); }
});
