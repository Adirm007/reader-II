// 构建管线变换（交接 7.C，连同 5.4 的 legacy）：锚点命中、残留检查、产物语法，以及几段新代码在 vm 里的行为。
// 运行：node --test tests/build.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { read, countExact, findFunctions, assertNoMacro } from '../build/lib.mjs';
import { transformLegacy } from '../build/legacy.mjs';
import * as C from '../build/controller.mjs';
import { loadLocalKeys, findOldLocalKeys, LOCAL_KEY_SITES } from '../build/local-keys.mjs';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const up = name => read(path.join(root, 'upstream/reader/source', name));
const memo = new Map();
const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
const legacy = () => once('legacy', () => transformLegacy(up('legacy-reader.js')));
const ui = () => once('ui', () => C.transformReaderUi(up('reader-ui.js')));
const templates = () => once('templates', () => C.transformTemplateSystem(up('template-system.js')));
const letter = () => once('letter', () => C.transformLetter(up('letter.js'), { legacyLetterBody: up('legacy-letter-body.html'), legacyCss: up('legacy-reader.css') }));
const sha = hexOf => createHash('sha256').update(hexOf).digest('hex');

test('legacy-reader.js：通用化跑通，新入口的函数与动作都在', () => {
  const s = legacy();
  for (const name of ['dreamOpenAgent', 'dreamOpenPanel', 'dreamOpenGacha', 'openIndependentApiSettings', 'pToast', 'getReaderCoreApi']) {
    assert.equal(findFunctions(s, name).length, 1, name);
  }
  for (const act of ['eggagent', 'eggmemory', 'eggpanel']) assert.ok(s.includes(`act==='${act}'`), act);
  assert.ok(s.includes('请读者写一则旁观札记'));
});

test('legacy-body.html：旁观札记、夜梦助手 / 记忆入口，小憩不动', () => {
  const s = C.transformLegacyBody(up('legacy-body.html'));
  for (const [token, n] of [
    ["orderItem('请读者写一则旁观札记')", 1], ['<span>旁观札记</span>', 1], ["onclick=\"dreamOpenAgent('chat')\"", 1],
    ["onclick=\"dreamOpenAgent('memory')\"", 1], ['条目模仿、命运抽卡与夜梦助手的请求可分别指定方案', 1], ["orderItem('使用间章:小憩')", 1],
  ]) assert.equal(countExact(s, token), n, token);
  for (const token of ['更新新闻', '新闻更新', '检查更新', 'openDreamWorldbookUpdate', '书海']) assert.ok(!s.includes(token), token);
});

test('reader-ui.js：彩蛋页入口换成夜梦助手 / 记忆 / 语义适配，三套主题的文案', () => {
  const s = ui();
  for (const [token, n] of [
    ['i("eggagent")', 1], ['i("eggmemory")', 1], ['i("eggpanel")', 1], ['和夜梦说说话', 1],
    ['sea:"夜梦助手"', 3], ['{text:"请读者写一则旁观札记"}', 3], ['name:"旁观札记"', 3],
  ]) assert.equal(countExact(s, token), n, token);
  for (const token of ['eggbooksea', 'eggwb', '检查更新', '书海', '普罗泰利西翁', '更新新闻', '新闻更新']) assert.ok(!s.includes(token), token);
  /* 新版前端只渲染 data-dlb，动作由 legacy 的处理函数接；新动作在那边都有。 */
  for (const act of ['eggagent', 'eggmemory', 'eggpanel']) assert.ok(legacy().includes(`act==='${act}'`), act);
});

test('controller-adapter.js：去掉两个检查更新的 setTimeout，其余不动', () => {
  const input = up('controller-adapter.js'), s = C.transformControllerAdapter(input);
  for (const token of ['ReaderUpdates', 'dreamWbAutoCheck', 'getUpdateOptions', 'scriptOwner', 'TEMP_MAIN_CARD_43']) assert.ok(!s.includes(token), token);
  assert.equal(countExact(s, 'window.ReaderController = {'), 1);
  assert.match(s, /\}\)\(\);\s*$/);
  assert.ok(input.length - s.length < 600, '只删了末尾那几行');
});

test('通用钩子：补 openGacha / openIndependentApiSettings，点立绘打开夜梦助手', () => {
  const calls = [], listeners = [], appended = [];
  const ctx = vm.createContext({
    pD: {
      addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
      createElement: tag => ({ tag, textContent: '' }),
      head: { appendChild: node => appended.push(node) },
    },
    dreamOpenGacha: () => { calls.push('gacha'); return 'gacha-opened'; },
    openIndependentApiSettings: (event, toast) => { calls.push(['api', event, toast === ctx.pToast]); return 'api-opened'; },
    pToast() {},
    dreamOpenAgent: tab => { calls.push('agent:' + tab); return true; },
  });
  ctx.window = ctx;
  ctx.__readerControllerAlive = true;
  ctx.__readerHostApi = { refresh: () => calls.push('refresh') };
  ctx.ReaderController = { command(name, ...args) { calls.push(['original', name, ...args]); return 'original'; } };
  vm.runInContext(C.genericHooks(), ctx);

  const app = ctx.ReaderController;
  assert.equal(app.command('openGacha'), 'gacha-opened');
  assert.equal(app.command('openIndependentApiSettings'), 'api-opened');
  assert.equal(app.command('togglePlay', 5), 'original');
  assert.deepEqual(calls, ['gacha', 'refresh', ['api', null, true], 'refresh', ['original', 'togglePlay', 5]]);
  ctx.__readerControllerAlive = false;
  assert.equal(app.command('openGacha'), false);
  ctx.__readerControllerAlive = true;

  const click = listeners.find(item => item.type === 'click');
  assert.ok(click && click.capture === true, '捕获阶段委托在 pD 上');
  let stopped = 0;
  const event = target => ({ target, preventDefault() {}, stopPropagation() { stopped += 1; } });
  calls.length = 0;
  click.fn(event({ closest: selector => (selector === '[data-u4-her]' ? {} : null) }));
  click.fn(event({ closest: () => null }));
  click.fn(event(null));
  assert.deepEqual(calls, ['agent:chat']);
  assert.equal(stopped, 1);
  assert.match(appended[0].textContent, /\[data-u4-her\]\{cursor:pointer\}/);
});

function loadShim(extra = {}) {
  const ctx = vm.createContext({ TextEncoder, ...extra });
  ctx.window = ctx;
  vm.runInContext(C.sha256Shim(), ctx);
  return ctx.DreamFixedReleaseClient.sha256;
}

test('SHA-256 垫片：crypto.subtle 与纯 JS 兜底都与 node:crypto 一致', async () => {
  const software = loadShim();
  const subtle = loadShim({ crypto: webcrypto });
  const broken = loadShim({ crypto: { subtle: { digest: async () => { throw new Error('不可用'); } } } });
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 1000, 65543, (1 << 20) + 13]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) bytes[i] = (i * 131 + n * 7 + (i >>> 8)) & 255;
    const want = sha(bytes);
    assert.equal(await software(bytes.buffer), want, `纯 JS，${n} 字节`);
    assert.equal(await subtle(bytes.buffer), want, `crypto.subtle，${n} 字节`);
    assert.equal(await broken(bytes), want, `digest 失败时退回纯 JS，${n} 字节`);
  }
  assert.equal(await software('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const big = Uint8Array.from({ length: 300 }, (_, i) => i & 255), part = sha(big.subarray(10, 110));
  assert.equal(await software(new DataView(big.buffer, 10, 100)), part, '视图只算自己那一段');
  assert.equal(await subtle(big.subarray(10, 110)), part);
  await assert.rejects(software(12), { name: 'TypeError' });

  const keep = vm.createContext({});
  keep.window = keep;
  keep.DreamFixedReleaseClient = { sha256: () => 'kept' };
  vm.runInContext(C.sha256Shim(), keep);
  assert.equal(keep.DreamFixedReleaseClient.sha256(), 'kept', '已有 sha256 时不覆盖');
});

test('booksea-album.js：去掉书海专辑，留下读者的六首，校验走垫片', async () => {
  const s = C.transformBookseaAlbum(up('booksea-album.js'));
  assert.equal(countExact(s, '  var catalog=[];'), 1);
  assert.ok(s.indexOf('root.DreamFixedReleaseClient = Object.freeze') < s.indexOf('DREAM_BOOKSEA_ALBUM_BEGIN'), '垫片在专辑前面');
  const albumPart = s.slice(s.indexOf('/* DREAM_BOOKSEA_ALBUM_BEGIN */'));
  assert.ok(up('booksea-album.js').length - albumPart.length > 18000, '书海清单约 21 KB（垫片另算）');

  const reports = [];
  const ctx = vm.createContext({
    TextEncoder, AbortController, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
    fetch: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(2376164) }),
  });
  ctx.window = ctx;
  vm.runInContext(s, ctx);
  const album = ctx.ReaderBookseaAlbum;
  assert.equal(album.catalog.length, 0);
  assert.equal(album.songs.length, 0);
  assert.equal(album.readerCatalog.length, 6);
  assert.equal(Object.keys(album.readerSongs).length, 6);
  /* 字节数对、哈希不对：应报「校验失败」，而不是「校验模块未就绪」（没有 crypto，走纯 JS）。 */
  const audio = { preload: '', pause() {}, load() {}, removeAttribute() {}, play: async () => assert.fail('不该播放') };
  const player = album.createPlayer(audio, message => reports.push(message));
  assert.equal(await player.play(album.readerSongs['four-little-swans'].url), false);
  assert.equal(reports.at(-1), '配乐暂时无法播放，请重试：配乐校验失败');
  player.dispose();
});

test('template-system.js：默认模板换成通用角色条目模板，存进模板库', () => {
  const s = templates(), { text, settings } = C.loadGenericTemplate();
  for (const token of ['reader-default-fated-character', '常规命定角色生成', '原缘加强默认模板', '阿斯塔利亚', '命定', 'reader_generic_']) assert.ok(!s.includes(token), token);
  const store = new Map();
  const ctx = vm.createContext({ console, setTimeout: () => 0 });
  ctx.window = ctx;
  ctx.parent = ctx;
  ctx.localStorage = { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  vm.runInContext(s, ctx);
  const lib = ctx.ReaderTemplateSystem.loadLibrary();
  const [t] = lib.templates;
  assert.equal(lib.templates.length, 1);
  assert.equal(lib.yuanTemplateId, 'reader-default-generic-character');
  assert.equal(t.id, 'reader-default-generic-character');
  assert.equal(t.name, settings.name);
  assert.equal(t.templateText, text);
  assert.equal(t.generationInstruction, settings.generationInstruction);
  assert.equal(t.entryNameRule, settings.entryNameRule);
  assert.equal(t.source.label, 'Reader通用内置模板');
  for (const key of ['targetWorldbook', 'keywordMode', 'keywordRule', 'order', 'positionType', 'preventIncoming']) assert.equal(t.output[key], settings.output[key], key);
  assert.equal(t.output.targetWorldbook, 'Reader生成条目');
  assert.equal(t.output.enabled, true);
  const saved = JSON.parse(store.get(C.TEMPLATE_LIBRARY_KEY));
  assert.equal(saved.templates[0].id, 'reader-default-generic-character', '抽卡包读同一个模板库');
  assert.equal(saved.templates[0].templateText, text);
  assert.equal(C.TEMPLATE_LIBRARY_KEY, 'reader_ii_template_library_v1');
  assert.ok(s.includes("var WRITER_KEY='reader_ii_writer_settings_v1';"));
  assert.deepEqual([...store.keys()].filter(key => !key.startsWith('reader_ii_')), [], '只写 reader-II 自己的键');
  /* 抽卡包读同一个模板库；它自己的本机键也不与原版读者共用。 */
  const gachaSource = read(path.join(root, 'gacha/src/reader/gacha-reader.ts')), gachaBundle = read(path.join(root, 'generated/reader-gacha.generic.js'));
  assert.equal(countExact(gachaSource, `TEMPLATE_LIBRARY_KEY = '${C.TEMPLATE_LIBRARY_KEY}'`), 1);
  for (const key of [C.TEMPLATE_LIBRARY_KEY, 'reader_ii_gacha_settings_v1', 'reader_ii_gacha_device_v1']) assert.ok(gachaBundle.includes(key), key);
  for (const key of ['reader_generic_template_library_v1', 'dream_gacha_settings_v1', 'dream_gacha_device_v1']) assert.ok(!gachaBundle.includes(key), key);
});

function runLetter({ attribute, mesid, nested }) {
  const registered = [], ready = [];
  const tavern = {
    document: { addEventListener: type => ready.push(type), removeEventListener() {} },
    SillyTavern: { getContext: () => ({ characterId: 3, getCurrentChatId: () => 'chat-a', chat: { 4: { mes: '旧信', swipe_id: 0 }, 7: { mes: '信', swipe_id: 0 } }, chatMetadata: { variables: {} } }) },
    ReaderShell: { registerLetter: info => { registered.push(info); return () => {}; } },
  };
  tavern.parent = tavern;
  /* 正文美化的 iframe：没有 SillyTavern，轻信不该在它上面监听。 */
  const beautifier = { parent: tavern, document: { addEventListener() { throw new Error('监听到了美化 iframe 上'); } } };
  const style = { getPropertyValue: () => '', getPropertyPriority: () => '', setProperty() {}, removeProperty() {} };
  const frame = {
    isConnected: true, style,
    getAttribute: name => (name === 'data-reader-message-id' ? attribute : null),
    closest: selector => (selector === '.mes' && mesid != null ? { getAttribute: name => (name === 'mesid' ? mesid : null) } : null),
  };
  const node = () => ({ style: {}, textContent: '', setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } });
  const document = {
    createElement: node, head: { appendChild() {} }, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    documentElement: { setAttribute() {}, getAttribute: () => 'cafe', style }, addEventListener() {},
  };
  const ctx = vm.createContext({ document, frameElement: frame, parent: nested ? beautifier : tavern, localStorage: { getItem: () => null, setItem() {} } });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};
  vm.runInContext(letter(), ctx);
  return { registered, ready, frame };
}

test('letter.js：嵌套时找到酒馆主窗口，楼层号取自 iframe 属性，登记到 ReaderShell', () => {
  const nested = runLetter({ attribute: '7', mesid: null, nested: true });
  assert.equal(nested.registered.length, 1);
  assert.equal(nested.registered[0].messageId, 7);
  assert.equal(nested.registered[0].frame, nested.frame);
  assert.equal(nested.registered[0].isCurrent(), true);
  assert.deepEqual(nested.ready, ['reader:ready']);
  /* 没有属性时退回 .mes 的 mesid。 */
  const direct = runLetter({ attribute: null, mesid: '4', nested: false });
  assert.equal(direct.registered[0].messageId, 4);

  const s = letter(), match = /\n {2}var legacyView = (\{.*\});\n/.exec(s);
  assert.ok(match, '旧轻信视图已嵌入');
  assert.ok(!match[1].includes('<'), "'<' 已转义");
  const view = JSON.parse(match[1]);
  assert.ok(!view.html.includes('<!--DREAM_LETTER-->'));
  assert.ok(view.html.includes('wrapper-v9-fix'));
  assert.ok(view.css.endsWith(C.LEGACY_LETTER_EXTRA_CSS));
  assert.ok(view.css.startsWith(up('legacy-reader.css').slice(0, 200)));
});

test('一次跑完所有变换；按 7.F 的顺序拼成控制器能通过语法检查；新代码里没有酒馆宏', () => {
  const parts = C.transformUpstream();
  assert.deepEqual(Object.keys(parts).sort(), ['adapter', 'album', 'body', 'css', 'hooks', 'legacy', 'letterScript', 'letterViews', 'prelude', 'templates', 'ui', 'uiSwitch']);
  assert.equal(parts.legacy, legacy());
  assert.equal(parts.templates, templates());
  const controller = [
    parts.prelude, read(path.join(root, 'src/controller/reader-transactions-generic.js')), read(path.join(root, 'generated/reader-gacha.generic.js')),
    parts.ui, parts.album, parts.legacy, parts.templates, parts.adapter, parts.hooks, parts.uiSwitch,
  ].join('\n;\n');
  assert.doesNotThrow(() => new vm.Script(controller, { filename: 'reader-controller.generic.js' }));
  assert.doesNotThrow(() => new vm.Script(parts.letterScript, { filename: 'letter.generic.js' }));
  assertNoMacro(parts.hooks, 'generic-hooks.js');
  assertNoMacro(C.sha256Shim(), 'sha256-shim.js');
  assert.ok(!parts.body.includes('<!--DREAM_LETTER-->') && parts.body.includes('旁观札记'));
  for (const view of [parts.letterViews.current, parts.letterViews.legacy]) assert.ok(view.html.length > 1000 && view.css.length > 1000);
});

/* 控制器与 letter.js 里还留着的 dream_* 键都是聊天变量（按聊天分开，世界书也读），不改（交接 0.6 甲组第 11 项）。 */
const CHAT_KEYS = ['dream_persona', 'dream_appearance', 'dream_sub_persona_map', 'dream_sub_persona_panel', 'dream_custom_persona', 'dream_custom_personas',
  'dream_custom_persona_id', 'dream_custom_condition_state', 'dream_silent_mode', 'dream_cafe_envelope_beautify', 'dream_yuan_plus_enabled',
  'dream_yuan_plus_preference', 'dream_yuan_plus_stream', 'dream_banlist', 'dream_letter_limit', 'dream_user_address', 'dream_visual_theme', 'dream_gacha'];

test('本机存储键：控制器与 letter.js 只用 reader-II 自己的键，旧键只在 reader-env.js 的迁移里读', () => {
  const keys = loadLocalKeys(), parts = C.transformUpstream();
  const controller = [
    parts.prelude, read(path.join(root, 'src/controller/reader-transactions-generic.js')), read(path.join(root, 'generated/reader-gacha.generic.js')),
    parts.ui, parts.album, parts.legacy, parts.templates, parts.adapter, parts.hooks, parts.uiSwitch,
  ].join('\n;\n');
  const letterScript = parts.letterScript;
  /* 旧键：控制器里只剩 TK 的定义（它同时是聊天变量的名字），letter.js 里一处都没有 */
  assert.deepEqual(findOldLocalKeys(controller), { dream_visual_theme: 1 });
  assert.equal(countExact(controller, `TK='dream_visual_theme',READER_II_THEME_KEY=${JSON.stringify(keys.dream_visual_theme)},`), 1);
  assert.deepEqual(findOldLocalKeys(letterScript), {});
  /* TK 只剩定义、聊天变量的读写与标签名（syncLabels / updateLabel）；主题的本机兜底走新常量 */
  const tk = [...parts.legacy.matchAll(/\bTK\b/g)].map(m => parts.legacy.slice(Math.max(0, m.index - 16), m.index + 2));
  assert.equal(tk.length, 6, tk.join(' | '));
  assert.equal(tk.filter(text => /[gs]etSTVariable\(TK$/.test(text)).length, 3, tk.join(' | '));
  assert.equal(tk.filter(text => /\.updateLabel\(TK$|key===TK$/.test(text)).length, 2, tk.join(' | '));
  for (const token of ['gLS(TK', 'sLS(TK', 'getItem(TK', 'setItem(TK']) assert.ok(!controller.includes(token), token);
  assert.equal(countExact(parts.legacy, 'gLS(READER_II_THEME_KEY,'), 1);
  assert.equal(countExact(parts.legacy, 'sLS(READER_II_THEME_KEY,'), 3);
  /* 剩下的 dream_* 字面量都是聊天变量；没有拼出来的 dream_ 键 */
  const unknown = new Set();
  for (const text of [controller, letterScript]) {
    for (const m of text.matchAll(/(['"])(dream_[A-Za-z0-9_]*)\1/g)) if (!CHAT_KEYS.includes(m[2])) unknown.add(m[2]);
    assert.doesNotMatch(text, /['"]dream_['"]\s*\+/);
  }
  assert.deepEqual([...unknown], [], '新出现的 dream_* 键：先判断是聊天变量还是本机存储，本机存储的加进 src/reader-env.js 的 LOCAL_KEYS');
  /* 表里每个新键都用上了；各段的处数表只用表里的旧键 */
  for (const newKey of Object.values(keys)) assert.ok(controller.includes(newKey) || letterScript.includes(newKey), newKey);
  for (const sites of Object.values(LOCAL_KEY_SITES)) for (const oldKey of Object.keys(sites)) assert.ok(keys[oldKey], oldKey);
  /* ① ② 自己的代码不直接读写旧键（网关与面板用 modules.localKey） */
  for (const file of fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter(name => String(name).endsWith('.js'))) {
    assert.doesNotMatch(read(path.join(root, 'src', String(file))), /\.(?:getItem|setItem|removeItem)\(\s*['"]dream_/, String(file));
  }
});

test('reader-env.js：旧键的偏好抄到新键，只抄一次；旧键不删，缓存不抄；网关读写新键', () => {
  const ctx = vm.createContext({ console });
  for (const file of ['src/reader-env.js', 'src/reader-llm-gateway.js']) vm.runInContext(read(path.join(root, file)), ctx, { filename: file });
  const M = ctx.__ReaderIIModules, K = M.localKey, store = new Map();
  let failOnce = null;
  ctx.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { if (key === failOnce) { failOnce = null; throw new Error('QuotaExceededError'); } store.set(key, String(value)); },
    removeItem: key => store.delete(key),
  };
  const plans = { version: 2, presets: [{ id: 'p1', name: '旧方案', apiurl: 'https://api.example.com/v1', key: 'test-key', model: 'm-old', source: 'openai' }], defaultId: 'p1', routes: {} };
  const old = {
    dream_visual_theme: 'ink', dream_font_size: '18', dream_auto_unseal: 'on', dream_render_mode: 'inline', dream_albums: '{"默认":[]}',
    dream_independent_api_v2: JSON.stringify(plans), dream_independent_api_models_v1: '{}', dream_gallery_cache_v1: '{"t":1}', dream_lobby_open: '1',
  };
  for (const [key, value] of Object.entries(old)) store.set(key, value);
  store.set(K('dream_render_mode'), 'float'); /* 新键已有值：不动 */
  failOnce = K('dream_albums'); /* 这一项写不进去（例如超出配额）：不记，下次再抄 */
  const env = M.createEnv(ctx);
  assert.equal(env.storage, ctx.localStorage);
  for (const key of ['dream_visual_theme', 'dream_font_size', 'dream_auto_unseal', 'dream_independent_api_v2']) assert.equal(store.get(K(key)), old[key], key);
  assert.equal(store.get(K('dream_render_mode')), 'float');
  for (const key of ['dream_albums', 'dream_independent_api_models_v1', 'dream_gallery_cache_v1', 'dream_lobby_open']) assert.ok(!store.has(K(key)), key);
  for (const [key, value] of Object.entries(old)) assert.equal(store.get(key), value, '旧键不删不改：' + key);
  /* 之后：用户把字号恢复默认（删掉新键）、原版读者又写了旧键，都不再抄；只补上次没抄成的那一项 */
  store.delete(K('dream_font_size'));
  store.set('dream_play_mode', 'random');
  assert.deepEqual([...M.migrateLocalKeys(ctx.localStorage)], [K('dream_albums')]);
  assert.equal(store.get(K('dream_albums')), old.dream_albums);
  assert.ok(!store.has(K('dream_font_size')) && !store.has(K('dream_play_mode')));
  assert.deepEqual([...M.migrateLocalKeys(ctx.localStorage)], []);
  assert.deepEqual(JSON.parse(store.get(M.LOCAL_KEYS_MARK)).sort(), [...M.LOCAL_KEYS].filter(entry => entry[2]).map(entry => entry[0]).sort());
  assert.throws(() => K('dream_nope'), /本机存储键表里没有 dream_nope/);
  /* 网关：读的是迁移过来的方案，存的时候只写新键 */
  const llm = M.createLlmGateway(env);
  assert.equal(llm.presetKey, 'reader_ii_independent_api_v2');
  assert.equal(llm.getSettings().model, 'm-old');
  llm.saveSettings({ enabled: true, apiurl: 'https://api.example.com/v1', key: 'test-key', model: 'm-new', source: 'openai' });
  assert.equal(JSON.parse(store.get(K('dream_independent_api_v2'))).presets[0].model, 'm-new');
  assert.equal(store.get('dream_independent_api_v2'), old.dream_independent_api_v2);
});

test('锚点失效时报错，并指出是哪一处', () => {
  const letterInput = up('letter.js').replace("localStorage.getItem('dream_ui_v4')", "localStorage.getItem('dream_ui_v4')||localStorage.getItem('dream_ui_v4')");
  assert.throws(() => C.transformLetter(letterInput, { legacyLetterBody: up('legacy-letter-body.html'), legacyCss: '' }), /letter\.js：本机键 dream_ui_v4：预期命中 1 处，实际 2 处/);
  assert.throws(() => C.transformReaderUi(up('reader-ui.js').replace('sea:"书海迷宫"', 'sea:"别的"')), /三套主题的书海标题：预期命中 3 处，实际 2 处/);
  assert.throws(() => C.transformControllerAdapter(up('controller-adapter.js').replace('dreamWbAutoCheck(); }, 5000);', 'later(); }, 5000);')), /检查更新的 setTimeout：预期命中 1 处，实际 0 处/);
  assert.throws(() => C.transformLetter(up('letter.js').replace('host.ReaderCore', 'host.Other'), { legacyLetterBody: up('legacy-letter-body.html'), legacyCss: '' }), /轻信找的宿主接口/);
  const template = C.loadGenericTemplate();
  assert.throws(() => C.transformTemplateSystem(up('template-system.js'), { ...template, settings: { ...template.settings, id: 'other' } }), /id 应为/);
  assert.throws(() => C.transformTemplateSystem(up('template-system.js'), { ...template, text: template.text + '\n给{{user}}' }), /记号 \{\{user\}\}/);
});
