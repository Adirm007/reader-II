// ② 卡内组件的构建（交接 7.F）：主脚本 JSON、控制器资源包、夜梦助手加载器、正则。
// 运行：node --test tests/card.test.mjs（约 2 秒；只用 Node 标准库，不写文件）
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as B from '../build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const manifest = JSON.parse(read('manifest.json'));
let memo = null;
const card = () => memo || (memo = B.buildCard());
const markers = (code, kind) => [...code.matchAll(new RegExp(`^/\\* ==== Reader-II ${kind}：(.+?) ==== \\*/$`, 'gm'))].map((m) => m[1]);
const MACRO = /<user>|\{\{user\}\}|<(?:bot|char)>|\{\{char\}\}/i;
const FORBIDDEN = [MACRO, /\$\d/, /<\/script/i];
const CDN = 'https://cdn.jsdelivr.net/gh/Adirm007/reader-II@main/';

test('主脚本 JSON：酒馆助手脚本的字段齐全，id 固定，按钮与 reader-core.js 订阅的一致', () => {
  const { script } = card();
  assert.equal(script.type, 'script');
  assert.equal(script.enabled, true);
  assert.equal(script.id, B.SCRIPT_ID);
  assert.match(script.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(script.id, '0c955120-625a-4cad-8af9-3aa1cccd1222', '与 v3.3 主系统的 id 不同（v3.3 的 JSON 已在第 10 项清理时删除）');
  assert.ok(script.name.includes(manifest.version) && script.info.includes(manifest.version));
  assert.deepEqual(script.button, { enabled: true, buttons: [{ name: 'Reader Core', visible: true }, { name: '夜梦助手', visible: true }] });
  const subscribed = [...read('src/reader-core.js').matchAll(/getButtonEvent\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(subscribed.sort(), [...B.SCRIPT_BUTTONS].sort());
  assert.deepEqual(Object.keys(script), ['type', 'enabled', 'name', 'id', 'content', 'info', 'button', 'data', 'export_with']);
  assert.deepEqual(JSON.parse(JSON.stringify(script)), script);
});

test('主脚本：模块按 4.3 的顺序、逐字取自 src/，能编译；没有酒馆宏、$+数字、</script', () => {
  const { content } = card().script;
  assert.doesNotThrow(() => new vm.Script(content, { filename: 'reader-ii.script.js' }));
  for (const pattern of FORBIDDEN) assert.equal(pattern.exec(content), null, String(pattern));
  /* 与 tests/core.test.mjs 的 CORE_SOURCES 相同 */
  assert.deepEqual(markers(content, '模块').map((name) => name.replace(/^src\//, '').replace(/\.js$/, '')), [
    'reader-env', 'reader-mvu-guard', 'reader-runtime-store', 'reader-economy', 'reader-host-adapter',
    'reader-semantic-codec', 'reader-semantic-router', 'reader-character-scan', 'reader-llm-gateway',
    'reader-adaptation-llm', 'reader-event-parser', 'reader-ui-bridge', 'reader-host-kit',
    'reader-auto-adapt', 'reader-lwb-host', 'reader-assets', 'reader-shell', 'reader-core',
  ]);
  for (const file of B.CARD_MODULES) if (file !== B.ASSETS_MODULE) assert.ok(content.includes(read(file).trim()), file);
  assert.ok(content.startsWith(`/*! Reader-II ${manifest.version} · `));
});

test('资源包：用壳的解法（DecompressionStream）能解开；字段与壳要的一致；不放 letterViews.legacy', async () => {
  const { script, assets } = card();
  const start = script.content.indexOf('/* ==== Reader-II 模块：reader-assets ==== */');
  const end = script.content.indexOf('/* ==== Reader-II 模块：src/reader-shell.js ==== */');
  assert.ok(start > 0 && end > start);
  const context = {};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(script.content.slice(start, end), context);
  const packed = context.__ReaderIIModules.READER_ASSETS_GZIP;
  const bytes = Uint8Array.from(atob(packed), (ch) => ch.charCodeAt(0));
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const decoded = JSON.parse(text);
  assert.deepEqual(decoded, JSON.parse(JSON.stringify(assets)));
  assert.deepEqual(Object.keys(decoded).sort(), ['body', 'controller', 'css', 'letterScript', 'letterViews', 'version']);
  assert.deepEqual(Object.keys(decoded.letterViews), ['current']);
  assert.equal(decoded.version, manifest.version);
  assert.ok(decoded.letterViews.current.html.length > 1000 && decoded.letterViews.current.css.length > 1000);
  assert.ok(decoded.body.includes('旁观札记') && !decoded.body.includes('<!--DREAM_LETTER-->'));
  assert.doesNotThrow(() => new vm.Script(decoded.letterScript, { filename: 'letter.generic.js' }));
  assert.equal(/<\/script/i.exec(decoded.letterScript), null);
  assert.equal(B.packAssets(assets), packed, '同样的输入得到同样的产物');
});

test('控制器：按 4.4 的顺序拼接，抽卡包在 ReaderTransactions 之后、reader-ui-switch 最后；能编译', () => {
  const { controller } = card().assets;
  assert.deepEqual(markers(controller, '控制器'), [
    'controller-prelude.js', 'src/controller/reader-transactions-generic.js', 'generated/reader-gacha.generic.js',
    'reader-ui.js', 'booksea-album.js', 'legacy-reader.js', 'template-system.js', 'controller-adapter.js',
    'src/controller/generic-hooks.js', 'reader-ui-switch.js',
  ]);
  assert.doesNotThrow(() => new vm.Script(controller, { filename: 'reader-controller.generic.js' }));
  const transactions = controller.indexOf('globals.ReaderTransactions = createReaderTransactions(globals)');
  const gacha = controller.indexOf('/* DREAM_READER_GACHA_BEGIN */');
  assert.ok(transactions > 0 && gacha > transactions);
  assert.ok(controller.includes(read('generated/reader-gacha.generic.js').trim()));
  assert.ok(controller.includes(read('src/controller/sha256-shim.js').trim().slice(0, 200)), '专辑前面带 SHA-256 垫片');
  assert.ok(controller.includes('reader-default-generic-character') && controller.includes('reader_ii_template_library_v1'));
  for (const file of ['src/controller/reader-transactions-generic.js', 'src/controller/generic-hooks.js', 'src/controller/sha256-shim.js']) {
    assert.equal(MACRO.exec(read(file)), null, file);
  }
});

test('assertEmbeddable：三项检查各自报得出来', () => {
  assert.throws(() => B.assertEmbeddable("var a = '<user>';", '样例'), /酒馆宏/);
  assert.throws(() => B.assertEmbeddable("s.replace(/(a)/, '$1')", '样例'), /\$1/);
  assert.throws(() => B.assertEmbeddable("var a = '</SCRIPT>';", '样例'), /<\/SCRIPT/);
  assert.equal(B.assertEmbeddable('var a = `${b}`;', '样例'), 'var a = `${b}`;');
});

/* 加载器跑在假的酒馆助手脚本 iframe 里：host 是酒馆主窗口，document 只模拟加载器会用到的几个方法。 */
function loaderWorld({ installed = false, ready = false } = {}) {
  const appended = [], opened = [], toasts = [], logs = [];
  const hostListeners = new Map(), buttons = new Map(), scriptListeners = new Map();
  const head = {
    appendChild(node) { node.parentNode = head; appended.push(node); },
    removeChild(node) { node.parentNode = null; appended.splice(appended.indexOf(node), 1); },
  };
  const doc = {
    head,
    createElement(tag) {
      const attrs = {};
      return { tagName: tag.toUpperCase(), src: '', parentNode: null, setAttribute(key, value) { attrs[key] = String(value); }, getAttribute(key) { return key in attrs ? attrs[key] : null; } };
    },
    querySelector(selector) {
      assert.equal(selector, 'script[data-reader-ii]');
      return appended.find((node) => node.getAttribute('data-reader-ii') !== null) || null;
    },
  };
  const api = { ready: true, agent: { open(tab) { opened.push(tab); } } };
  const host = {
    document: doc,
    SillyTavern: { getContext() { return {}; } },
    addEventListener(type, fn) { hostListeners.set(type, fn); },
    removeEventListener(type, fn) { if (hostListeners.get(type) === fn) hostListeners.delete(type); },
    toastr: { warning(message) { toasts.push(String(message)); } },
  };
  host.parent = host;
  if (installed) host.__ReaderIIBase = 'http://127.0.0.1:8000/scripts/extensions/third-party/reader-II/';
  if (ready) host.ReaderII = api;
  const context = {
    parent: host,
    /* 酒馆助手的脚本 iframe 也带着 SillyTavern：加载器不能把自己当成酒馆主窗口 */
    SillyTavern: host.SillyTavern,
    document: { title: '脚本 iframe' },
    console: { warn: (...args) => logs.push(args), info() {}, log() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    eventOn(event, fn) { buttons.set(event, fn); },
    getButtonEvent(name) { return 'button:' + name; },
    addEventListener(type, fn) { scriptListeners.set(type, fn); },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(card().loader.content, context, { filename: 'reader-ii.loader.js' });
  return {
    host, appended, opened, toasts, logs,
    becomeReady() { host.ReaderII = api; const fn = hostListeners.get('reader-ii:ready'); if (fn) fn(); },
    click(name) { return buttons.get('button:' + name)(); },
    stop() { const fn = scriptListeners.get('pagehide'); if (fn) fn(); },
  };
}

test('加载器 JSON：字段齐全，能编译，没有酒馆宏、$+数字、</script；CDN 地址与 reader-core.js 相同', () => {
  const { loader } = card();
  assert.equal(loader.type, 'script');
  assert.equal(loader.id, B.LOADER_ID);
  assert.notEqual(loader.id, B.SCRIPT_ID);
  assert.deepEqual(loader.button.buttons.map((item) => item.name), ['夜梦助手', '记忆']);
  assert.doesNotThrow(() => new vm.Script(loader.content));
  for (const pattern of FORBIDDEN) assert.equal(pattern.exec(loader.content), null, String(pattern));
  assert.ok(read('src/reader-core.js').includes(`var EXT_BASE = '${CDN}';`));
  assert.ok(loader.content.includes(`var EXT_BASE = '${CDN}';`));
});

test('加载器：没装扩展时从 CDN 加载 ① 到酒馆主窗口，就绪后按钮打开助手与记忆', async () => {
  const w = loaderWorld();
  assert.equal(w.appended.length, 1);
  const [script] = w.appended;
  assert.equal(script.src, CDN + 'dist/reader-ii.ext.js');
  assert.equal(script.getAttribute('data-reader-ii'), 'cdn');
  assert.equal(w.host.__ReaderIICdn, true);
  assert.equal(w.host.__ReaderIIBase, CDN);
  const pending = w.click('记忆');
  assert.equal(w.appended.length, 1, '加载中再点按钮不重复插脚本');
  w.becomeReady();
  assert.equal(await pending, true);
  assert.equal(await w.click('夜梦助手'), true);
  assert.deepEqual(w.opened, ['memory', 'chat']);
  assert.deepEqual(w.toasts, []);
  w.stop();
});

test('加载器：装了扩展或 ① 已就绪时不插脚本；CDN 加载失败时节点移走，点按钮重试并提示', async () => {
  const installed = loaderWorld({ installed: true });
  assert.equal(installed.appended.length, 0);
  assert.equal(installed.host.__ReaderIICdn, undefined);
  installed.becomeReady();
  assert.equal(await installed.click('夜梦助手'), true);
  assert.deepEqual(installed.opened, ['chat']);
  installed.stop();

  const ready = loaderWorld({ ready: true });
  assert.equal(ready.appended.length, 0);
  assert.equal(await ready.click('记忆'), true);
  assert.deepEqual(ready.opened, ['memory']);
  ready.stop();

  const failing = loaderWorld();
  failing.appended[0].onerror();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(failing.appended.length, 0);
  assert.equal(failing.logs.length, 1, '启动时的失败只记日志');
  assert.deepEqual(failing.toasts, []);
  const retry = failing.click('夜梦助手');
  assert.equal(failing.appended.length, 1, '点按钮时重新加载');
  failing.appended[0].onerror();
  assert.equal(await retry, false);
  assert.equal(failing.toasts.length, 1);
  assert.match(failing.toasts[0], /扩展包加载失败/);
  failing.stop();
});

test('正则：与 正则/ 里的原样相同；渲染正则套出来的插槽是壳认得的', () => {
  const { regex } = card();
  assert.deepEqual(regex.map((item) => item.target), ['reader-ii.regex.event-prompt.json', 'reader-ii.regex.event-display.json', 'reader-ii.regex.dream-render.json']);
  for (const item of regex) assert.deepEqual(item.data, JSON.parse(read(item.source)));
  const shell = read('src/reader-shell.js');
  assert.ok(shell.includes("var SLOT = '[data-reader-dream-slot]';") && shell.includes("var SOURCE = '[data-reader-dream-source]';"));
  const render = regex[2].data;
  const [, body, flags] = /^\/([\s\S]+)\/([a-z]*)$/.exec(render.findRegex);
  const html = '前文<dream>「今晚的点单」</dream>后文'.replace(new RegExp(body, flags), (match, text) => render.replaceString.split('$1').join(text));
  assert.equal(html, '前文<div data-reader-dream-slot="1" data-preserve-html="1"><div data-reader-dream-source>今晚的点单</div></div>后文');
  const events = '甲<READER_FP_EVENT>{"fp":1}</READER_FP_EVENT>乙';
  for (const item of regex.slice(0, 2)) {
    const [, eventBody, eventFlags] = /^\/([\s\S]+)\/([a-z]*)$/.exec(item.data.findRegex);
    assert.equal(events.replace(new RegExp(eventBody, eventFlags), () => item.data.replaceString), '甲乙');
  }
});

test('世界书：buildCard 带上 7.E 的世界书（四个条目，版本标记用 manifest 的版本）；细节见 tests/worldbook.test.mjs', () => {
  const { worldbook } = card();
  assert.deepEqual(Object.values(worldbook.json.entries).map((entry) => entry.comment), ['[initvar]Reader-II初始化', '[mvu_update]Reader-II变量更新规则', '[Reader-II] 通用读者核心', 'Reader-II变量列表']);
  assert.ok(worldbook.json.entries[2].content.startsWith(`<%_ /* READER_II_WORLDBOOK core v${manifest.version} · 上游 reader-core v`));
  assert.ok(read('build.mjs').includes("['dist/reader-ii.worldbook.json', json(card.worldbook.json)"));
});
