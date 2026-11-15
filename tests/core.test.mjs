import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/*
 * ② 卡内组件：语义层与 reader-core 接线（7.A）。mock 酒馆、酒馆助手、MVU 与小白X，脚本 iframe 与酒馆主窗口分开。
 * 运行：node --test tests/core.test.mjs
 */
const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (name) => fs.readFileSync(path.join(dir, 'src', name), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const ref = (...segments) => 'hostref:' + encodeURIComponent(JSON.stringify(['stat_data', ...segments]));
const EXT_BASE = 'https://cdn.jsdelivr.net/gh/Adirm007/reader-II@main/';

const CORE_SOURCES = [
  'reader-env.js', 'reader-mvu-guard.js', 'reader-runtime-store.js', 'reader-economy.js', 'reader-host-adapter.js',
  'reader-semantic-codec.js', 'reader-semantic-router.js', 'reader-character-scan.js', 'reader-llm-gateway.js',
  'reader-adaptation-llm.js', 'reader-event-parser.js', 'reader-ui-bridge.js', 'reader-host-kit.js',
  'reader-auto-adapt.js', 'reader-lwb-host.js', 'reader-assets', 'reader-shell.js', 'reader-core.js',
];
/* reader-assets 由 7.F 的构建生成；这里用假资源包占位（这些 mock 里没有 DOM，壳不会真去解它，见 tests/shell.test.mjs）。 */
const ASSETS_MODULE = '(function (root) { var m = root.__ReaderIIModules = root.__ReaderIIModules || {}; m.READER_ASSETS_GZIP = '
  + JSON.stringify(gzipSync(Buffer.from(JSON.stringify({ version: 'test', css: '', body: '', controller: '', letterScript: '', letterViews: { current: { html: '', css: '' } } }))).toString('base64'))
  + '; })(globalThis);';

function loadCodec() {
  const context = { console, structuredClone };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  for (const name of ['reader-mvu-guard.js', 'reader-host-adapter.js', 'reader-semantic-codec.js', 'reader-lwb-host.js']) {
    vm.runInContext(src(name), context, { filename: name });
  }
  return context.__ReaderIIModules;
}

function inventoryMapping(m, container, draft) {
  const rootRef = ref('背包');
  return m.validateSemanticMapping('inventory', { version: 1, slot: 'inventory', rootRef, ...draft }, rootRef, container).mapping;
}

class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
}

/* 假的小白X：把 <state> 里每行「点路径: JSON」当绝对赋值（这是我们对它的假设，真机未验证）。 */
function fakeApplyText(world, mode) {
  return async (text) => {
    world.applied.push(text);
    if (mode === 'reject') return { ok: false, errors: ['数据.主角.金币 超出 $range'] };
    const body = /^<state>\n([\s\S]*)\n<\/state>$/.exec(text);
    if (!body) return { ok: false, errors: ['不是 <state> 文本'] };
    if (mode === 'ignore') return { ok: true, errors: [] };
    for (const line of body[1].split('\n')) {
      const at = line.indexOf(': ');
      const keys = line.slice(0, at).split('.');
      let cursor = world.chatMetadata.variables;
      for (const key of keys.slice(0, -1)) {
        if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
        cursor = cursor[key];
      }
      cursor[keys[keys.length - 1]] = JSON.parse(line.slice(at + 2));
    }
    return { ok: true, errors: [] };
  };
}

function createWorld(options = {}) {
  const world = {
    mvuData: options.mvuData || { stat_data: {} },
    chatMetadata: { variables: options.chatVariables || {}, ...(options.metadata || {}) },
    messages: new Map(),
    rootEvents: [],
    rootListeners: [],
    hostEvents: [],
    applied: [],
    logs: [],
    toasts: [],
    storage: new Map(options.storage || []),
    listeners: new Map(),
  };
  const tavernContext = {
    get chatMetadata() { return world.chatMetadata; },
    saveMetadata() {},
    getCurrentChatId: () => 'chat-1',
    characterId: '0',
    chat: [{ mes: '开场', swipe_id: 0 }],
  };
  const host = {
    document: options.document || { title: '假酒馆' },
    SillyTavern: { getContext: () => tavernContext },
    CustomEvent: FakeEvent,
    dispatchEvent(event) { world.hostEvents.push(event); return true; },
    addEventListener() {},
    removeEventListener() {},
    localStorage: {
      getItem: (key) => (world.storage.has(key) ? world.storage.get(key) : null),
      setItem: (key, value) => world.storage.set(key, String(value)),
      removeItem: (key) => world.storage.delete(key),
    },
    toastr: { warning: (message) => world.toasts.push(String(message)), info() {}, success() {}, error() {} },
    ...(options.host || {}),
  };
  if (options.lwb) host.LWB_StateV2 = { applyText: fakeApplyText(world, options.lwb), getInputSchema: () => ({}) };
  const root = {
    console: {
      log() {}, info() {}, debug() {},
      warn: (...args) => world.logs.push(['warn', ...args]),
      error: (...args) => world.logs.push(['error', ...args]),
    },
    setTimeout, clearTimeout, setInterval, clearInterval, structuredClone, atob, Uint8Array, Blob, DecompressionStream, Response,
    __READER_DISABLE_MVU_IMPORT__: true,
    CustomEvent: FakeEvent,
    dispatchEvent(event) { world.rootEvents.push(event); return true; },
    addEventListener(type, handler) { world.rootListeners.push([type, handler]); },
    Mvu: {
      events: {
        VARIABLE_INITIALIZED: 'VARIABLE_INITIALIZED',
        VARIABLE_UPDATE_STARTED: 'VARIABLE_UPDATE_STARTED',
        VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED',
        BEFORE_MESSAGE_UPDATE: 'BEFORE_MESSAGE_UPDATE',
      },
      getMvuData: () => structuredClone(world.mvuData),
      async replaceMvuData(next) { world.mvuData = structuredClone(next); },
    },
    eventOn(event, handler) {
      if (!world.listeners.has(event)) world.listeners.set(event, []);
      world.listeners.get(event).push(handler);
      return { stop() {} };
    },
    getButtonEvent: (name) => `BUTTON:${name}`,
    tavern_events: {
      MESSAGE_SENT: 'MESSAGE_SENT', MESSAGE_RECEIVED: 'MESSAGE_RECEIVED', MESSAGE_UPDATED: 'MESSAGE_UPDATED',
      MESSAGE_EDITED: 'MESSAGE_EDITED', MESSAGE_SWIPED: 'MESSAGE_SWIPED', MESSAGE_DELETED: 'MESSAGE_DELETED', CHAT_CHANGED: 'CHAT_CHANGED',
    },
    getChatMessages(id) {
      if (typeof id === 'string' && id.includes('-')) return [...world.messages.values()].sort((a, b) => a.message_id - b.message_id);
      const item = world.messages.get(Number(id));
      return item ? [item] : [];
    },
    getVariables: (option) => (option && option.type === 'message' ? structuredClone(world.mvuData) : world.chatMetadata.variables),
    insertOrAssignVariables: (values) => Object.assign(world.chatMetadata.variables, values),
    async injectPrompts() {},
    TavernHelper: { async generateRaw() { return ''; }, async generate() { return ''; }, async getModelList() { return []; } },
    initializeGlobal() {},
    parent: host,
  };
  if (options.allowExtImport !== true) root.__READER_DISABLE_EXT_IMPORT__ = true;
  root.window = root;
  root.globalThis = root;
  vm.createContext(root);
  for (const name of CORE_SOURCES) {
    vm.runInContext(name === 'reader-assets' ? ASSETS_MODULE : src(name), root, { filename: name });
  }
  world.root = root;
  world.host = host;
  world.api = root.ReaderCore;
  return world;
}

/* 控制器 iframe：只装 ReaderTransactions，酒馆助手的楼层变量接口直接读写 world.mvuData。 */
function loadTransactions(world) {
  const helper = {
    getLastMessageId: () => 0,
    getVariables: () => structuredClone(world.mvuData),
    async updateVariablesWith(updater) {
      world.mvuData = structuredClone(updater(structuredClone(world.mvuData)));
      return world.mvuData;
    },
  };
  const win = { console, structuredClone, TavernHelper: helper, parent: world.host, navigator: {} };
  win.window = win;
  win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(src('controller/reader-transactions-generic.js'), win, { filename: 'reader-transactions-generic.js' });
  return win.ReaderTransactions;
}

async function bindCurrency(api, segments) {
  await api.selectSemanticRoot('currency', ref(...segments));
  await api.confirmSemanticBinding('currency');
}

/* ---------- 7.A.1 背包 codec 的不可叠加情形 ---------- */

test('背包 codec：名字数组同名再放一条，移除时按件循环', () => {
  const m = loadCodec();
  const bag = ['火把', '绳子'];
  const mapping = inventoryMapping(m, bag, { containerKind: 'array', entryKind: 'name', name: { from: 'value' }, fields: {} });
  const added = m.addSemanticInventoryItem(mapping, bag, { name: '火把' });
  assert.deepEqual(plain(added), { name: '火把', names: ['火把'], stacked: false, count: 1 });
  assert.deepEqual(bag, ['火把', '绳子', '火把']);
  m.addSemanticInventoryItem(mapping, bag, { name: '火把', count: 2 });
  assert.equal(bag.filter((item) => item === '火把').length, 4);
  assert.deepEqual(plain(m.removeSemanticInventoryItem(mapping, bag, '火把', 3)), { removed: 3, left: 1 });
  assert.deepEqual(bag, ['绳子', '火把']);
  assert.deepEqual(plain(m.removeSemanticInventoryItem(mapping, bag, '火把', 5)), { removed: 1, left: 0 });
  assert.deepEqual(plain(m.removeSemanticInventoryItem(mapping, bag, '火把', 1)), { removed: 0, left: 0 });
  assert.deepEqual(bag, ['绳子']);
});

test('背包 codec：没有数量字段的数组条目再放一条', () => {
  const m = loadCodec();
  const bag = [{ 名称: '护符', 描述: '旧的' }];
  const mapping = inventoryMapping(m, bag, {
    containerKind: 'array', entryKind: 'object', name: { from: 'path', path: ['名称'] }, fields: { description: { path: ['描述'] } },
  });
  const added = m.addSemanticInventoryItem(mapping, bag, { name: '护符', description: '新的', quality: '稀有' });
  assert.equal(added.stacked, false);
  assert.equal(added.duplicate, undefined, '不得再返回 duplicate 而不放入');
  assert.equal(bag.length, 2);
  assert.deepEqual(plain(bag[1]), { 名称: '护符', 描述: '新的 品质：稀有' });
  assert.equal(m.readSemanticInventory(mapping, bag).filter((item) => item.name === '护符').length, 2);
  assert.deepEqual(plain(m.removeSemanticInventoryItem(mapping, bag, '护符', 1)), { removed: 1, left: 1 });
  assert.equal(bag.length, 1);
});

test('背包 codec：没有数量字段的对象表改名找空位，不覆盖宿主已有物品', () => {
  const m = loadCodec();
  const bag = { 长剑: { 描述: '旧剑' } };
  const mapping = inventoryMapping(m, bag, {
    containerKind: 'object', entryKind: 'object', name: { from: 'key' }, fields: { description: { path: ['描述'] } },
  });
  assert.equal(m.addSemanticInventoryItem(mapping, bag, { name: '长剑', description: '新剑' }, { distinct: '《某作》' }).name, '长剑（《某作》）');
  assert.equal(m.addSemanticInventoryItem(mapping, bag, { name: '长剑', description: '又一把' }, { distinct: '《某作》' }).name, '长剑（《某作》）2');
  assert.deepEqual(Object.keys(bag), ['长剑', '长剑（《某作》）', '长剑（《某作》）2']);
  assert.equal(bag.长剑.描述, '旧剑');
  assert.deepEqual(plain(m.addSemanticInventoryItem(mapping, bag, { name: '盾', count: 2 }).names), ['盾', '盾（其二）']);
  assert.deepEqual(plain(m.removeSemanticInventoryItem(mapping, bag, '长剑（《某作》）', 1)), { removed: 1, left: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(bag, '长剑（《某作》）'), false);
  assert.ok(bag['长剑（《某作》）2']);
});

test('背包 codec：可叠加时照旧叠加，同名多条按顺序扣减', () => {
  const m = loadCodec();
  const bag = [{ 名称: '药水', 数量: 2 }, { 名称: '药水', 数量: 3 }, { 名称: '面包', 数量: 1 }];
  const mapping = inventoryMapping(m, bag, {
    containerKind: 'array', entryKind: 'object', name: { from: 'path', path: ['名称'] }, fields: { count: { path: ['数量'] } },
  });
  assert.deepEqual(plain(m.removeSemanticInventoryItem(mapping, bag, '药水', 4)), { removed: 4, left: 1 });
  assert.deepEqual(plain(bag), [{ 名称: '药水', 数量: 1 }, { 名称: '面包', 数量: 1 }]);
  const stacked = m.addSemanticInventoryItem(mapping, bag, { name: '面包', count: 2 });
  assert.deepEqual(plain(stacked), { name: '面包', stacked: true, count: 3 });
});

/* ---------- 小白X 的 <state> 文本 ---------- */

test('小白X <state>：叶子逐条写绝对值，删键时整体写对象，顶层删除写 null', () => {
  const m = loadCodec();
  const before = { 数据: { 主角: { 金币: 100, 背包: { 药水: 2, 绳子: 1 }, 标签: ['a'] } }, 旧变量: 1 };
  const after = { 数据: { 主角: { 金币: 70, 背包: { 药水: 2 }, 标签: ['a', 'b'], 新字段: '有' } } };
  const changes = m.lwbStateDiff(before, after);
  assert.equal(m.lwbStateText(changes), [
    '<state>',
    '旧变量: null',
    '数据.主角.金币: 70',
    '数据.主角.背包: {"药水":2}',
    '数据.主角.标签: ["a","b"]',
    '数据.主角.新字段: "有"',
    '</state>',
  ].join('\n'));
  assert.deepEqual(plain(m.lwbStateDiff({ 数据: { 'a.b': { x: 1 }, 金币: 1 } }, { 数据: { 'a.b': { x: 2 }, 金币: 2 } })), [
    { path: ['数据'], value: { 'a.b': { x: 2 }, 金币: 2 } },
  ], '写不进点路径的键退到可写的祖先整体写');
  assert.throws(() => m.lwbStateDiff({ '坏 名': 1 }, { '坏 名': 2 }), /写不进/);
  assert.deepEqual(plain(m.lwbStateDiff({ a: 1 }, { a: 1 })), []);
});

/* ---------- 7.A.2 主题写入 ---------- */

test('主题写入扣 9999 FP', async () => {
  const world = createWorld({ chatVariables: { dream_persona: 'reader' } });
  const { api } = world;
  await api.ready();
  await api.creditFp(10000, 'test', 'credit:theme');
  world.messages.set(1, {
    message_id: 1,
    role: 'assistant',
    message: '<READER_ACTION_EVENT>{"event_id":"theme-1","action":"theme_write","title":"海边","description":"潮声常在"}</READER_ACTION_EVENT>',
  });
  const outcome = plain(await api.processMessageEvents(1));
  assert.ok(outcome.results.some((item) => item.action === 'theme_write'), JSON.stringify(outcome.results));
  assert.equal(await api.getFpBalance(), 1);
  assert.ok(await api.findStatus('主题:海边'));
  api.dispose();
});

/* ---------- 7.A.3 接线 ---------- */

test('接线：tx、listInventory、notifyChanged（主窗口与脚本窗口都派发）、autoAdapt', async () => {
  const world = createWorld({ chatVariables: { dream_persona: 'reader' } });
  const { api } = world;
  await api.ready();
  for (const name of ['currencyRead', 'currencyWrite', 'statusList', 'statusSet', 'inventoryList', 'inventoryAdd', 'inventoryRemove', 'inventoryShape', 'hostKind', 'begin']) {
    assert.equal(typeof api.tx[name], 'function', name);
  }
  assert.equal(typeof api.autoAdapt, 'function');
  assert.equal(api.tx.hostKind(), 'mvu');
  const data = structuredClone(world.mvuData);
  const session = api.tx.begin(data);
  assert.equal(session.kind, 'mvu');
  assert.equal(session.data, data);
  api.tx.currencyWrite(data, 50);
  assert.equal(api.tx.currencyRead(data), 50);
  api.tx.inventoryAdd(data, { name: '灯', count: 2 });
  assert.equal(api.tx.inventoryShape().stackable, true);
  world.mvuData = data;
  assert.deepEqual(plain(await api.listInventory()).map((item) => [item.name, item.count]), [['灯', 2]]);

  world.rootEvents.length = 0;
  world.hostEvents.length = 0;
  assert.equal(api.notifyChanged('reader_transaction'), true);
  assert.deepEqual(world.rootEvents.map((event) => [event.type, event.detail.reason]), [['reader-core-changed', 'reader_transaction']]);
  assert.deepEqual(world.hostEvents.map((event) => [event.type, event.detail.reason]), [['reader-core-changed', 'reader_transaction']]);

  const report = plain(await api.autoAdapt({ useLlm: false }));
  assert.deepEqual(report.hostRoots, []);
  assert.match(report.note, /纯文字卡/);

  /* 控制器的 ReaderTransactions 在 MVU 宿主下照旧走 updateVariablesWith，并回调 notifyChanged。 */
  const T = loadTransactions(world);
  world.hostEvents.length = 0;
  assert.equal(await T.transact(T.capture(), 'mvu-credit', (next) => T.credit(next, 5)), 55);
  assert.equal(world.mvuData.stat_data.READER.命运点数, 55);
  assert.ok(world.mvuData.dream_reader_receipts['mvu-credit']);
  assert.ok(world.hostEvents.some((event) => event.detail.reason === 'reader_transaction'));
  api.dispose();
});

test('夜梦助手：有 ① 就直接用；没有时放占位，按需从 CDN 加载扩展包；装了扩展就等它', async () => {
  const opened = [];
  const readerII = { ready: true, version: 'test', agent: { open: (tab) => opened.push(tab) }, memory: {} };

  let world = createWorld({ host: { ReaderII: readerII, ReaderAgent: readerII.agent } });
  await world.api.ready();
  assert.equal(world.api.getReaderII(), readerII);
  assert.equal(await world.api.openAgent('memory'), true);
  assert.deepEqual(opened, ['memory']);
  assert.equal(world.host.ReaderAgent, readerII.agent, '已有 ① 时不得覆盖 ReaderAgent');
  world.api.dispose();

  world = createWorld();
  await world.api.ready();
  assert.equal(world.api.getReaderII(), null);
  assert.equal(world.host.ReaderAgent.__readerCorePlaceholder, true);
  assert.equal(await world.host.ReaderAgent.open('chat'), false);
  assert.match(world.toasts.join('\n'), /没有安装/);
  world.api.dispose();
  assert.equal(world.host.ReaderAgent, undefined, '卸载时清掉占位');

  const appended = [];
  let current = null;
  const document = {
    head: {
      appendChild(node) {
        appended.push(node);
        setTimeout(() => { current.host.ReaderII = readerII; }, 20);
        return node;
      },
    },
    createElement: (tag) => ({ tagName: tag, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
    querySelector: () => null,
  };
  current = world = createWorld({ allowExtImport: true, document, storage: [['reader_ii_ext_autoload', 'off']] });
  await world.api.ready();
  assert.equal(await world.api.loadReaderII(), readerII);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].src, EXT_BASE + 'dist/reader-ii.ext.js');
  assert.equal(appended[0].attributes['data-reader-ii'], 'cdn');
  assert.equal(world.host.__ReaderIIBase, EXT_BASE, '知识库要从同一个 CDN 地址取');
  assert.equal(await world.api.openAgent('chat'), true);
  world.api.dispose();

  appended.length = 0;
  world = createWorld({
    allowExtImport: true, document, storage: [['reader_ii_ext_autoload', 'off']],
    host: { __ReaderIIBase: 'http://localhost/scripts/extensions/third-party/reader-II/' },
  });
  await world.api.ready();
  const pending = world.api.loadReaderII();
  setTimeout(() => { world.host.ReaderII = readerII; }, 20);
  assert.equal(await pending, readerII);
  assert.equal(appended.length, 0, '装了扩展时不从 CDN 重复加载');
  world.api.dispose();
});

/* ---------- 小白X 作为变量宿主 ---------- */

test('小白X 宿主：读聊天变量，写走 applyText，READER 留在 MVU', async () => {
  const world = createWorld({
    lwb: 'apply',
    chatVariables: { 数据: { 主角: { 金币: 100, 背包: { 药水: 2 } }, 地点: '王都' }, dream_persona: 'reader' },
    metadata: { LWB_SNAP: { 1: {} } },
  });
  const { api } = world;
  await api.ready();
  assert.equal(api.getHostKind(), 'lwb');
  const snapshot = plain(await api.getSnapshot());
  assert.deepEqual(snapshot.stat_data.数据, { 主角: { 金币: 100, 背包: { 药水: 2 } }, 地点: '王都' });
  assert.equal('dream_persona' in snapshot.stat_data, false, 'Reader 自己的聊天变量不算宿主变量');
  assert.equal('reader_ii_runtime' in snapshot.stat_data, false);

  await bindCurrency(api, ['数据', '主角', '金币']);
  assert.equal(await api.getFpBalance(), 100);
  assert.equal(world.applied.length, 0, '绑定本身不写宿主');
  await api.spendFp(30, 'test', 'spend:1');
  assert.deepEqual(world.applied, ['<state>\n数据.主角.金币: 70\n</state>']);
  assert.equal(world.chatMetadata.variables.数据.主角.金币, 70);
  assert.equal(world.mvuData.stat_data.数据, undefined, '宿主变量不得写进 MVU');

  assert.equal(api.setHostKind('mvu'), 'mvu');
  assert.equal(api.getHostKind(), 'mvu');
  api.setHostKind('auto');
  assert.equal(api.getHostKind(), 'lwb');
  api.dispose();
});

test('小白X 宿主：一键适配在聊天变量上找槽位，适配本身不写宿主', async () => {
  const world = createWorld({
    lwb: 'apply',
    chatVariables: { 数据: { 主角: { 金币: 100 } } },
    metadata: { LWB_RULES_V2: {} },
  });
  const { api } = world;
  await api.ready();
  const report = plain(await api.autoAdapt({ useLlm: false }));
  assert.deepEqual(report.hostRoots, ['数据']);
  assert.equal(api.getSemanticRouting().currency.status, 'active', JSON.stringify(report.slots));
  assert.equal(world.applied.length, 0);
  api.dispose();
});

test('小白X 宿主：控制器 ReaderTransactions 扣费走小白X，回执与后备背包进楼层变量', async () => {
  const world = createWorld({ lwb: 'apply', chatVariables: { 数据: { 主角: { 金币: 100 } } }, metadata: { LWB_SNAP: {} } });
  const { api } = world;
  await api.ready();
  await bindCurrency(api, ['数据', '主角', '金币']);
  const T = loadTransactions(world);
  assert.equal(T.fp(T.read(T.capture())), 100);

  const token = T.capture();
  assert.equal(await T.transact(token, 'buy-1', (data) => T.charge(data, 20)), 80);
  assert.deepEqual(world.applied, ['<state>\n数据.主角.金币: 80\n</state>']);
  assert.ok(world.mvuData.dream_reader_receipts['buy-1']);
  assert.equal(await T.transact(token, 'buy-1', (data) => T.charge(data, 20)), 80, '同一回执不得重复扣费');
  assert.equal(world.applied.length, 1);

  const name = await T.transact(T.capture(), 'bag-1', (data) => T.inventoryAdd(data, { name: '书页', count: 1 }).name);
  assert.equal(name, '书页');
  assert.equal(world.applied.length, 1, '后备背包在 READER 里，不经小白X');
  assert.equal(world.mvuData.stat_data.READER.背包.书页.数量, 1);
  assert.deepEqual(plain(T.inventory(T.read(T.capture()))).map((item) => item.name), ['书页']);
  assert.equal(world.mvuData.stat_data.数据, undefined);
  api.dispose();
});

test('小白X 拒绝或没写进去时报错，宿主与 MVU 都不变', async () => {
  for (const mode of ['reject', 'ignore']) {
    const world = createWorld({ lwb: mode, chatVariables: { 数据: { 主角: { 金币: 100 } } }, metadata: { LWB_SNAP: {} } });
    const { api } = world;
    await api.ready();
    await bindCurrency(api, ['数据', '主角', '金币']);
    const before = structuredClone(world.mvuData);
    await assert.rejects(() => api.spendFp(30, 'test', 'spend:' + mode), mode === 'reject' ? /没有接受/ : /没有按预期写入/);
    assert.equal(world.chatMetadata.variables.数据.主角.金币, 100);
    assert.deepEqual(world.mvuData, before);
    api.dispose();
  }
});

/* ---------- 7.D 常驻壳的接线（壳本身在真浏览器里测：tests/shell.test.mjs） ---------- */

test('常驻壳：core 建好壳、登记为 host.ReaderShell，pagehide（dispose）时停掉', async () => {
  const world = createWorld();
  const shell = world.host.ReaderShell;
  assert.equal(shell.__reader_shell_api, true);
  assert.equal(shell.canOwnEnvelope, true);
  assert.equal(world.api.mountDreamSlots, shell.scan, 'mountDreamSlots 改由壳提供');
  assert.equal(shell.isAlive, true);
  /* 这些 mock 没有 DOM：壳不建控制器，但接口照常可调，只是都回 false / 空。 */
  assert.equal(await shell.open('lobby'), false);
  assert.equal(await shell.command('openGacha'), false);
  assert.equal(shell.scan(), 0);
  assert.deepEqual(plain(shell.getLetters(0)), []);
  const hide = world.rootListeners.find(([type]) => type === 'pagehide');
  assert.ok(hide, 'core 要在脚本 iframe 的 pagehide 时清理');
  hide[1]();
  assert.equal(shell.isAlive, false);
  assert.equal('ReaderShell' in world.host, false, '停掉后从酒馆主窗口摘掉');
});

/* 7.G：酒馆助手给脚本 iframe 的 SillyTavern 也可能带 getContext，findHost 要取最外层的酒馆主窗口（① ② 共用）。 */
test('findHost：脚本 iframe 也带 SillyTavern.getContext 时取最外层、同源的那一层', () => {
  const context = { console, structuredClone };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(src('reader-env.js'), context, { filename: 'reader-env.js' });
  const find = context.__ReaderIIModules.findHostWindow;
  const tavern = { document: {}, SillyTavern: { getContext() { return {}; } } };
  tavern.parent = tavern;
  const script = { document: {}, SillyTavern: { getContext() { return {}; } }, parent: tavern };
  const nested = { document: {}, parent: script };
  assert.equal(find(script), tavern, '脚本 iframe 不能当成酒馆主窗口');
  assert.equal(find(nested), tavern);
  assert.equal(find(tavern), tavern, '扩展载体就在酒馆主窗口');
  const crossOrigin = { SillyTavern: { getContext() { return {}; } } };
  Object.defineProperty(crossOrigin, 'document', { get() { throw new Error('跨域'); } });
  crossOrigin.parent = crossOrigin;
  assert.equal(find({ document: {}, SillyTavern: { getContext() { return {}; } }, parent: crossOrigin }).parent, crossOrigin, '跨域的上层不算');
  const alone = { document: {} };
  alone.parent = alone;
  assert.equal(find(alone), alone, '哪层都没有酒馆时退回自己');
});

/* 7.G 冒烟查出：运行时状态平时只在有改动时才写，新聊天里没有 reader_ii_runtime，① 的记忆就不在这张卡自己的聊天里整理与注入。 */
test('聊天标记：启动时与换到新聊天后，聊天变量里有 reader_ii_runtime；已有的不改写', async () => {
  const world = createWorld({ chatVariables: { 宿主: 1 } });
  await world.api.ready();
  assert.ok(world.chatMetadata.variables.reader_ii_runtime, '新聊天里启动后要有 reader_ii_runtime');
  assert.equal(world.chatMetadata.variables.宿主, 1, '别的聊天变量不动');

  world.chatMetadata = { variables: {} };
  (world.listeners.get('CHAT_CHANGED') || []).forEach((handler) => handler());
  await world.api.ready();
  assert.ok(world.chatMetadata.variables.reader_ii_runtime, '换到新聊天后也要有');

  const original = { version: 1, keep: true };
  const kept = createWorld({ chatVariables: { reader_ii_runtime: original } });
  await kept.api.ready();
  assert.equal(kept.chatMetadata.variables.reader_ii_runtime, original, '已有标记的聊天不改写');
});
