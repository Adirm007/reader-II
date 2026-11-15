/*
 * 夜梦助手内核的 Node 测试（mock 酒馆 + mock 酒馆助手 + 脚本化的模型回复）。
 *   node --test tests/agent.test.mjs
 * 覆盖：启动、VFS 各挂载点的读 / 检索 / 精确替换、JSON 指针、撤销与冲突、权限矩阵、
 *       主循环（工具调用、确认、拒绝、重复调用、步数上限、轻聊）、工具箱按需打开、插件对接与剧情察知。
 * 没覆盖：真实酒馆、IndexedDB（这里走内存退路）、面板 DOM、沙箱 iframe、无酒馆助手时的原生世界书通道。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EXT_MODULES, bundle } from '../build.mjs';

const CODE = bundle(EXT_MODULES);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
/* 被测代码跑在另一个 vm 上下文里，数组与对象的原型不同：比较前先转成普通值。 */
const same = (actual, expected) => assert.deepStrictEqual(clone(actual), expected);

function makeHost(options = {}) {
  const chat = [
    { name: '旁白', is_user: false, mes: '清晨，王都的钟声响起。<UpdateVariable>x</UpdateVariable>' },
    { name: '我', is_user: true, mes: '我推开了酒馆的门。' },
    { name: '艾琳', is_user: false, mes: '「欢迎回来。」艾琳放下了手里的杯子。' },
  ];
  const worldbooks = {
    设定集: [
      { uid: 0, name: '王都', enabled: true, content: '王都位于北方。\n人口十万。\n守卫队长是雷恩。', strategy: { type: 'selective', keys: ['王都'] }, position: { type: 'before_character_definition', order: 100 } },
      { uid: 1, name: '艾琳', enabled: true, content: '艾琳是酒馆的老板娘。', strategy: { type: 'constant', keys: [] }, position: {} },
    ],
    公共资料: [{ uid: 0, name: '货币', enabled: true, content: '通用货币是金币。', strategy: { type: 'selective', keys: ['金币'] }, position: {} }],
  };
  const regexes = {
    global: [{ id: 'g1', script_name: '状态栏', enabled: true, find_regex: '/<status>([\\s\\S]*?)<\\/status>/g', replace_string: '<div class="bar">$1</div>' }],
    character: [],
  };
  const longScript = 'const a=1;' + 'x'.repeat(5000) + ';function brokenThing(){ return undefinedVariable + 1 }' + 'y'.repeat(5000);
  const scripts = { global: [{ type: 'script', id: 's1', name: '大脚本', enabled: true, content: longScript, info: '' }], character: [], preset: [] };
  const vars = { chat: { 数据: { 角色: { 金币: 10 } } }, global: {}, character: {}, message: { stat_data: { 主角: { 生命: 100 } } } };
  const storage = new Map();
  const llmCalls = [];
  const replies = options.replies ? options.replies.slice() : [];
  const ctx = {
    chat, characterId: 0, name1: '我', name2: '艾琳', chatId: 'chat-1',
    characters: [{ name: '艾琳', avatar: 'ailin.png', description: '老板娘', data: { description: '老板娘', alternate_greetings: ['你好'], extensions: {} } }],
    chatMetadata: { variables: vars.chat }, extensionSettings: {},
    getCurrentChatId: () => 'chat-1', saveMetadata: async () => {}, saveSettingsDebounced: () => {}, saveChat: async () => {},
    setExtensionPrompt: () => {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    eventSource: { on() {}, once() {}, removeListener() {}, emit: async () => {} },
    eventTypes: { GENERATION_ENDED: 'generation_ended', MESSAGE_RECEIVED: 'message_received', CHAT_CHANGED: 'chat_id_changed', GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS' },
  };
  const helper = {
    getWorldbookNames: () => Object.keys(worldbooks),
    getGlobalWorldbookNames: () => ['公共资料'],
    getCharWorldbookNames: () => ({ primary: '设定集', additional: [] }),
    getChatWorldbookName: () => null,
    getWorldbook: async (name) => clone(worldbooks[name]),
    createWorldbook: async (name) => { worldbooks[name] = []; },
    updateWorldbookWith: async (name, updater) => { worldbooks[name] = clone(updater(clone(worldbooks[name]))); return clone(worldbooks[name]); },
    createWorldbookEntries: async (name, entries) => {
      const made = entries.map((entry, index) => ({ uid: worldbooks[name].length + index + 10, enabled: true, strategy: { type: 'selective', keys: [] }, position: {}, ...entry }));
      worldbooks[name].push(...made);
      return { new_entries: clone(made) };
    },
    /* 照酒馆助手当前版本的类型定义：选项键是 type（3.x 是 scope）。 */
    getTavernRegexes: ({ type }) => clone(regexes[type]),
    updateTavernRegexesWith: async (updater, { type }) => { regexes[type] = clone(updater(clone(regexes[type]))); },
    getScriptTrees: ({ type }) => clone(scripts[type]),
    updateScriptTreesWith: async (updater, { type }) => { scripts[type] = clone(updater(clone(scripts[type]))); },
    getVariables: (option) => clone(vars[option.type]),
    replaceVariables: async (value, option) => { vars[option.type] = clone(value); if (option.type === 'chat') ctx.chatMetadata.variables = vars.chat; },
    setChatMessages: async (list) => { list.forEach((item) => { chat[item.message_id].mes = item.message; }); },
    generateRaw: async (config) => {
      llmCalls.push(clone(config.ordered_prompts));
      const next = replies.shift();
      if (next === undefined) return '（没有更多脚本化回复）';
      return typeof next === 'function' ? next(config) : next;
    },
  };
  const host = {
    SillyTavern: { getContext: () => ctx }, TavernHelper: helper,
    localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    console: { log() {}, info() {}, warn() {}, error() {} },
    document: { querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }), body: { appendChild() {} }, head: { appendChild() {} } },
    navigator: { userAgent: 'node-test' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    fetch: async (url) => ({ ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => `---\nname: demo\ndescription: 演示\n---\n这是 ${url} 的正文`, json: async () => [{ name: 'third-party/demo-ext' }] }),
    Function, setTimeout, clearTimeout, AbortController, crypto: globalThis.crypto,
    ...(options.globals || {}),
  };
  host.window = host;
  host.parent = host;
  vm.createContext(host);
  vm.runInContext(CODE, host, { filename: 'reader-ii.ext.js' });
  return { host, api: host.ReaderII, agent: host.ReaderII.agent, vfs: host.ReaderII.vfs, worldbooks, regexes, scripts, vars, chat, llmCalls, ctx };
}

const call = (name, args) => `<tool_call name="${name}">\n${Object.entries(args).map(([key, value]) => `<arg name="${key}">${value}</arg>`).join('\n')}\n</tool_call>`;

test('启动：全局对象、旧名与挂载点', () => {
  const { host, api, vfs } = makeHost();
  assert.equal(api.ready, true);
  assert.equal(host.ReaderAgent, api.agent);
  assert.equal(host.ReaderMemory, api.memory);
  const mounts = vfs.mounts().map((item) => item.id);
  for (const id of ['chat', 'card', 'cards', 'wb', 'regex', 'script', 'preset', 'var', 'ext', 'page', 'ws', 'kb', 'mem']) assert.ok(mounts.includes(id), `缺少挂载点 ${id}`);
  const core = api.agent.listTools().filter((item) => item.toolset === 'core').map((item) => item.name);
  same(core.sort(), ['edit', 'grep', 'ls', 'read', 'remove', 'run_js', 'skill', 'todo', 'toolbox', 'write']);
});

test('VFS：列目录、分段读、检索、精确替换', async () => {
  const { vfs, worldbooks } = makeHost();
  const books = await vfs.list('wb:/', {});
  same(books.items.map((item) => item.name), ['设定集', '公共资料']);
  assert.match(books.items[0].note, /当前卡/);
  const read = await vfs.read('wb:/设定集/王都', { offset: 2, limit: 1 });
  assert.match(read.text, /^\s+2\t人口十万。$/);
  assert.match(read.more, /offset=3/);
  const found = await vfs.grep('wb:/', '雷恩', {});
  assert.equal(found.total, 1);
  assert.match(found.hits[0], /^wb:\/设定集\/王都:3: /);
  await vfs.edit('wb:/设定集/王都', '人口十万', '人口二十万', false, null);
  assert.match(worldbooks.设定集[0].content, /人口二十万/);
  await assert.rejects(vfs.edit('wb:/设定集/王都', '不存在的句子', 'x', false, null), /没有找到/);
  await vfs.write('wb:/设定集/新条目', '全新的内容', null);
  assert.equal(worldbooks.设定集.at(-1).name, '新条目');
  const meta = JSON.parse(await vfs.readText('wb:/设定集/王都.meta.json'));
  assert.equal(meta.strategy.keys[0], '王都');
  assert.equal(meta.content, undefined);
});

test('VFS：超长单行的脚本用 grep 定位、按列读取', async () => {
  const { vfs, scripts } = makeHost();
  const hit = await vfs.grep('script:/', 'undefinedVariable', {});
  assert.equal(hit.total, 1);
  assert.match(hit.hits[0], /\[列 \d+\]/);
  assert.ok(hit.hits[0].length < 500, '命中行应当被截短');
  const column = Number(hit.hits[0].match(/\[列 (\d+)\]/)[1]);
  const part = await vfs.read('script:/global/大脚本/content.js', { column: column - 40, cap: 1000 });
  assert.match(part.text, /brokenThing/);
  await vfs.edit('script:/global/大脚本/content.js', 'return undefinedVariable + 1', 'return 1', false, null);
  assert.match(scripts.global[0].content, /function brokenThing\(\)\{ return 1 \}/);
});

test('VFS：JSON 指针读写变量、正则字段、聊天正文、角色卡', async () => {
  const { vfs, vars, regexes, chat, ctx } = makeHost();
  assert.equal(await vfs.readText('var:/chat.json#/数据/角色/金币'), '10');
  await vfs.write('var:/chat.json#/数据/角色/金币', '25', null);
  assert.equal(vars.chat.数据.角色.金币, 25);
  assert.equal(await vfs.readText('var:/mvu.json#/stat_data/主角/生命'), '100');
  assert.equal(await vfs.readText('var:/chat.json#/没有/这个'), null);
  assert.match(await vfs.readText('regex:/global/状态栏/replace.html'), /class="bar"/);
  await vfs.edit('regex:/global/状态栏/replace.html', 'class="bar"', 'class="status-bar"', false, null);
  assert.match(regexes.global[0].replace_string, /status-bar/);
  await vfs.edit('chat:/2', '欢迎回来', '你回来了', false, null);
  assert.match(chat[2].mes, /你回来了/);
  assert.equal(await vfs.readText('card:/description.md'), '老板娘');
  assert.equal(await vfs.readText('card:/greetings/1.md'), '你好');
  assert.equal(vfs.scope('wb:/设定集/王都', 'write'), 'card');
  assert.equal(vfs.scope('wb:/公共资料/货币', 'write'), 'tavern');
  assert.equal(vfs.scope('ws:/notes/a.md', 'write'), 'workspace');
  await vfs.write('ws:/notes/a.md', '草稿', null);
  same((await vfs.list('ws:/notes', {})).items.map((item) => item.name), ['a.md']);
  assert.ok(ctx);
});

test('VFS：cards:/ 别的角色卡（含浅卡补全）、mem:/ 记忆', async () => {
  const { vfs, ctx, api } = makeHost();
  ctx.characters.push({ name: '雷恩', avatar: 'lein.png', shallow: true, data: { creator: '某人' } });
  ctx.unshallowCharacter = async (index) => { ctx.characters[index] = { name: '雷恩', avatar: 'lein.png', data: { description: '守卫队长', creator: '某人', extensions: {} } }; };
  same((await vfs.list('cards:/', {})).items.map((item) => item.name), ['艾琳', '雷恩']);
  assert.equal(await vfs.readText('cards:/雷恩/description.md'), '守卫队长');
  assert.equal(vfs.scope('cards:/艾琳/description.md', 'write'), 'card');
  assert.equal(vfs.scope('cards:/雷恩/description.md', 'write'), 'tavern');
  await vfs.write('cards:/雷恩/description.md', '王都守卫队长', null);
  assert.equal(ctx.characters[1].data.description, '王都守卫队长');
  await vfs.write('mem:/chat/王都人口.md', '王都人口十万。', null);
  const [record] = await api.memory.list({ store: 'chat' });
  assert.equal(record.title, '王都人口');
  assert.equal(record.owner, 'agent');
  await vfs.write('mem:/chat/王都人口.meta.json', JSON.stringify({ owner: 'story', keys: ['王都'] }), null);
  const meta = JSON.parse(await vfs.readText('mem:/chat/王都人口.meta.json'));
  assert.equal(meta.owner, 'story');
  same(meta.keys, ['王都']);
  assert.equal(vfs.scope('mem:/ocean/x.md', 'write'), 'chat');
  assert.match(JSON.stringify(await vfs.grep('mem:/', '十万', {})), /mem:\/chat\/王都人口\.md/);
  await vfs.remove('mem:/chat/王都人口.md', null);
  same(await api.memory.list({ store: 'chat' }), []);
});

test('权限：档位 × 确认方式 × 规则', () => {
  const { host } = makeHost();
  const modules = host.__ReaderIIModules;
  let settings = { mode: 'card', approval: 'ask', rules: [] };
  const permissions = modules.createPermissions(() => settings);
  assert.equal(permissions.evaluate({ effect: 'read', scope: 'tavern', tool: 'read' }).decision, 'allow');
  assert.equal(permissions.evaluate({ effect: 'write', scope: 'card', tool: 'edit' }).decision, 'ask');
  assert.equal(permissions.evaluate({ effect: 'write', scope: 'tavern', tool: 'edit' }).decision, 'deny');
  assert.equal(permissions.evaluate({ effect: 'write', scope: 'workspace', tool: 'write' }).decision, 'allow');
  assert.equal(permissions.evaluate({ effect: 'note', scope: 'chat', tool: 'memory_save' }).decision, 'allow');
  assert.equal(permissions.evaluate({ effect: 'read', scope: 'device', tool: 'read' }).decision, 'deny');
  settings = { mode: 'readonly', approval: 'yolo', rules: [] };
  assert.equal(permissions.evaluate({ effect: 'write', scope: 'chat', tool: 'edit' }).decision, 'deny');
  assert.equal(permissions.evaluate({ effect: 'note', scope: 'chat', tool: 'memory_save' }).decision, 'deny');
  settings = { mode: 'tavern', approval: 'auto', rules: [{ effect: 'deny', action: '*', pattern: 'wb:/私密/**' }, { effect: 'ask', action: 'read', pattern: 'chat:/**' }] };
  assert.equal(permissions.evaluate({ effect: 'write', scope: 'tavern', tool: 'edit' }).decision, 'allow');
  assert.equal(permissions.evaluate({ effect: 'danger', scope: 'tavern', tool: 'remove' }).decision, 'ask');
  assert.equal(permissions.evaluate({ effect: 'read', scope: 'tavern', tool: 'read', path: 'wb:/私密/日记' }).decision, 'deny');
  assert.equal(permissions.evaluate({ effect: 'read', scope: 'chat', tool: 'read', path: 'chat:/3' }).decision, 'ask');
  settings = { mode: 'device', approval: 'yolo', rules: [] };
  assert.equal(permissions.evaluate({ effect: 'danger', scope: 'device', tool: 'shell' }).decision, 'allow');
});

test('主循环：读 → 改（确认）→ 回答，随后整轮撤销', async () => {
  const replies = [
    '我先看看这个条目。\n' + call('read', { path: 'wb:/设定集/王都' }),
    call('edit', { path: 'wb:/设定集/王都', old: '人口十万', new: '人口三十万' }),
    '已经把王都的人口改成三十万了。',
  ];
  const { agent, worldbooks, llmCalls } = makeHost({ replies });
  const asked = [];
  const events = [];
  const result = await agent.run('把王都人口改成三十万', { confirm: async (request) => { asked.push(request); return 'allow'; }, onEvent: (event) => events.push(event.type) });
  assert.equal(result.answer, '已经把王都的人口改成三十万了。');
  assert.equal(result.error, '');
  same(result.steps.map((step) => [step.name, step.ok]), [['read', true], ['edit', true]]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tier, 'write');
  assert.equal(asked[0].scope, 'card');
  assert.match(worldbooks.设定集[0].content, /人口三十万/);
  assert.equal(result.changes, 1);
  assert.ok(events.includes('confirm') && events.includes('final'));
  const system = llmCalls[0][0].content;
  assert.match(system, /【核心工具】/);
  assert.match(system, /【工具箱】/);
  assert.match(system, /【当前剧情】/);
  assert.match(system, /艾琳放下了手里的杯子/);
  assert.ok(!/fp_adjust/.test(system), '没打开的工具箱不该出现在提示词里');
  assert.match(llmCalls[1].at(-1).content, /<tool_result name="read" status="ok">/);

  const runs = await agent.listRuns(5);
  assert.equal(runs[0].id, result.runId);
  const report = await agent.undo(result.runId);
  same(report.conflicts, []);
  assert.match(worldbooks.设定集[0].content, /人口十万/);
});

test('主循环：拒绝、档位不足、撤销冲突', async () => {
  const replies = [
    call('edit', { path: 'wb:/设定集/王都', old: '人口十万', new: '人口一万' }),
    call('edit', { path: 'wb:/公共资料/货币', old: '金币', new: '银币' }),
    '两处都没有改成。',
    call('edit', { path: 'wb:/设定集/王都', old: '人口十万', new: '人口五万' }),
    '改好了。',
  ];
  const { agent, worldbooks, vfs } = makeHost({ replies });
  const first = await agent.run('改两处', { confirm: async () => 'deny' });
  same(first.steps.map((step) => step.denied), [true, true]);
  assert.match(first.steps[1].summary, /酒馆全权/);
  assert.match(worldbooks.设定集[0].content, /人口十万/);
  assert.match(worldbooks.公共资料[0].content, /金币/);

  const second = await agent.run('再改一次', { confirm: async () => 'allow' });
  assert.match(worldbooks.设定集[0].content, /人口五万/);
  await vfs.edit('wb:/设定集/王都', '人口五万', '人口六万', false, null);
  const conflict = await agent.undo(second.runId);
  assert.equal(conflict.conflicts.length, 1);
  assert.match(worldbooks.设定集[0].content, /人口六万/);
  const forced = await agent.undo(second.runId, { force: true });
  assert.equal(forced.restored.length, 1);
  assert.match(worldbooks.设定集[0].content, /人口十万/);
});

test('主循环：重复只读调用复用结果、未知工具、步数上限', async () => {
  const same = call('read', { path: 'wb:/设定集/艾琳' });
  const { agent, llmCalls } = makeHost({ replies: [same, same, call('nope', { a: 1 }), '好了。'] });
  const result = await agent.run('看看艾琳', {});
  assert.equal(result.steps[1].summary, '重复调用，复用结果');
  assert.equal(result.steps[2].ok, false);
  assert.match(llmCalls[3].at(-1).content, /没有名为 nope 的工具/);

  const loop = makeHost({ replies: Array.from({ length: 10 }, (_, index) => call('ls', { path: 'wb:/', offset: String(index) })) });
  loop.agent.saveSettings({ maxSteps: 3 });
  const capped = await loop.agent.run('一直列', {});
  assert.match(capped.answer, /超出了上限/);
  assert.equal(loop.llmCalls.length, 4);
});

test('省 token：轻聊不带工具；关掉剧情察知；工具箱按需打开', async () => {
  const lite = makeHost({ replies: ['晚上好，作家先生。'] });
  lite.agent.saveSettings({ lite: true, plotContext: false });
  const greeting = await lite.agent.run('晚上好', {});
  assert.equal(greeting.answer, '晚上好，作家先生。');
  const system = lite.llmCalls[0][0].content;
  assert.ok(!/【核心工具】/.test(system) && !/【当前剧情】/.test(system) && !/tool_call/.test(system));

  const full = makeHost({ replies: [call('toolbox', { name: 'tavern' }), '打开了。', '第二轮。'] });
  const opened = await full.agent.run('打开酒馆工具箱', {});
  assert.equal(opened.steps[0].ok, true);
  assert.match(opened.steps[0].summary, /已打开工具箱 tavern/);
  assert.ok(!/【已打开的工具箱：tavern】/.test(full.llmCalls[0][0].content));
  await full.agent.run('继续', {});
  assert.match(full.llmCalls[2][0].content, /【已打开的工具箱：tavern】/);
  assert.match(full.llmCalls[2][0].content, /slash_run/);
});

test('插件对接：探测、工具箱、剧情摘要、声明式自定义对接', async () => {
  const globals = {
    STBaiBaiBook: {
      getSnapshot: () => ({ state: { time: '第三天清晨', location: '王都酒馆' } }),
      getInjectedHistory: () => ({ relativeText: '昨天：主角抵达王都，结识了艾琳。' }),
      query: (query) => ({ asked: query.resource }),
    },
    MyPlugin: { getNote: (id) => `note-${id}` },
  };
  const { agent, llmCalls } = makeHost({ globals, replies: [call('baibai_query', { resource: 'state' }), call('myplugin_note', { id: '7' }), '查到了。'] });
  agent.saveSettings({ connectors: [{ id: 'myplugin', title: '我的插件', summary: '演示', detect: 'window.MyPlugin', tools: [{ name: 'myplugin_note', summary: '取备注', effect: 'read', call: 'MyPlugin.getNote', params: [{ name: 'id', type: 'string', required: true }] }] }] });
  const ids = agent.listConnectors().map((item) => item.id);
  assert.ok(ids.includes('baibai') && ids.includes('myplugin') && ids.includes('tavernhelper'));
  const result = await agent.run('查一下状态', {});
  same(result.steps.map((step) => step.ok), [true, true]);
  assert.match(result.steps[1].summary, /note-7/);
  const system = llmCalls[0][0].content;
  assert.match(system, /摘要来自柏宝书/);
  assert.match(system, /主角抵达王都/);
  assert.match(system, /- baibai：/);
});

test('记忆：来源标记 owner 与 unify（助手夜梦 = 正文夜梦）', async () => {
  const { api, worldbooks } = makeHost();
  const memory = api.memory;
  assert.equal(memory.getSettings().unify, false);
  await memory.add({ type: 'fact', title: '王都人口', content: '王都人口十万。', keys: ['王都'], source: 'manual' }, { store: 'chat' });
  await memory.add({ type: 'bond', title: '喜欢猫', content: '用户在王都说过喜欢猫。', keys: ['王都'], source: 'agent' }, { store: 'chat' });
  await memory.add({ type: 'howto', title: '修脚本', content: '王都的脚本这样修。', keys: ['王都'], source: 'agent' }, { store: 'chat' });
  same((await memory.list({ store: 'chat' })).map((item) => item.owner).sort(), ['agent', 'agent', 'story']);
  let block = await memory.buildInjection('我们去王都吧');
  assert.match(block.text, /王都人口/);
  assert.doesNotMatch(block.text, /喜欢猫|修脚本|同一个人/);
  assert.ok((await memory.search('王都 猫')).some((item) => item.title === '喜欢猫'), '助手那边照样读得到');
  memory.saveSettings({ unify: true });
  block = await memory.buildInjection('我们去王都吧');
  assert.match(block.text, /同一个人/);
  assert.match(block.text, /\[情感·助手那边\] 喜欢猫/);
  assert.doesNotMatch(block.text, /修脚本/, '功能记忆是戏外的做法，不进正文');
  /* 《夜之洋》：助手记忆的条目开关跟着 unify，真实开关留在元数据里。 */
  const saved = await memory.add({ type: 'bond', title: '夜里聊天', content: '和用户聊到深夜。', keys: ['深夜'], source: 'agent' }, { store: 'ocean' });
  const entryOf = () => worldbooks['夜之洋'].find((entry) => entry.content.includes(saved.id));
  assert.equal(entryOf().enabled, true);
  memory.saveSettings({ unify: false });
  await memory.syncOceanVisibility();
  assert.equal(entryOf().enabled, false);
  const back = await memory.get(saved.id);
  assert.equal(back.enabled, true);
  assert.equal(back.owner, 'agent');
});

test('知识：目录只列名字，skill 才读正文；kb:/ 可读参考文件', async () => {
  const { agent, vfs, llmCalls } = makeHost({ replies: [call('skill', { name: 'ejs-prompt-template' }), '读完了。'] });
  const result = await agent.run('教我写 EJS', {});
  assert.equal(result.steps[0].ok, true);
  assert.match(llmCalls[0][0].content, /- ejs-prompt-template：/);
  assert.match(llmCalls[1].at(-1).content, /knowledge\/ejs-prompt-template\/SKILL\.md 的正文/);
  assert.match(await vfs.readText('kb:/ejs-prompt-template/reference.md'), /ST-Prompt-Template/);
});

test('协议：标准写法、invoke 写法、块内 JSON、未闭合', () => {
  const { host } = makeHost();
  const protocol = host.__ReaderIIModules.agentProtocol;
  assert.equal(protocol.parse(call('read', { path: 'a' })).calls[0].args.path, 'a');
  assert.equal(protocol.parse('<invoke name="read"><parameter name="path">b</parameter></invoke>').calls[0].args.path, 'b');
  assert.equal(protocol.parse('<tool_call name="read">{"path":"c"}</tool_call>').calls[0].args.path, 'c');
  const open = protocol.parse('先说一句\n<tool_call name="write"><arg name="path">ws:/a</arg><arg name="content">没写完');
  assert.equal(open.truncated, true);
  assert.equal(open.calls.length, 0);
});
