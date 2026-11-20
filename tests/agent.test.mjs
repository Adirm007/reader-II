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
  if (options.agentSettings) ctx.extensionSettings.reader_ii = { agent: options.agentSettings };
  if (options.requestMoreRounds || options.inspectHistory) host.__READER_II_NO_AUTOBOOT__ = true;
  vm.createContext(host);
  vm.runInContext(CODE, host, { filename: 'reader-ii.ext.js' });
  if (options.requestMoreRounds || options.inspectHistory) {
    const modules = host.__ReaderIIModules;
    if (options.requestMoreRounds) {
      const createUi = modules.createAgentUi;
      modules.createAgentUi = (...args) => ({ ...createUi(...args), requestMoreRounds: options.requestMoreRounds });
    }
    if (options.inspectHistory) {
      const createHistory = modules.createThreadHistory;
      modules.createThreadHistory = (...args) => {
        const history = createHistory(...args);
        options.inspectHistory(history);
        return history;
      };
    }
    modules.bootReaderII();
  }
  return { host, api: host.ReaderII, agent: host.ReaderII.agent, vfs: host.ReaderII.vfs, worldbooks, regexes, scripts, vars, chat, llmCalls, ctx };
}

const call = (name, args) => `<tool_call name="${name}">\n${Object.entries(args).map(([key, value]) => `<arg name="${key}">${value}</arg>`).join('\n')}\n</tool_call>`;

test('误称无工具或列完计划只说要做时能继续，避免反复催促', async () => {
  const replies = ['我没有可用的工具。', call('capabilities', { query: '世界书' }),
    call('todo', { items: JSON.stringify([{ text: '核对王都位置', status: 'doing' }]) }), '我这就查看。',
    call('read', { path: 'wb:/设定集/王都' }), '王都位于北方。'];
  const { agent, llmCalls } = makeHost({ replies });
  const result = await agent.run('帮我看看王都在哪里');
  assert.equal(result.answer, '王都位于北方。');
  same(result.steps.map((step) => step.name), ['capabilities', 'todo', 'read']);
  assert.match(llmCalls[1].at(-1).content, /capabilities/);
  assert.match(llmCalls[4].at(-1).content, /核对王都位置/);
});

test('助手从楼层 MVU 探测七槽，确认后绑定，并用读回的逐项结果作答', async () => {
  const statData = {
    世界: { 位置: '灯塔' }, 任务列表: { 修灯: {} }, 关系列表: { 小舟: { 好感度: 52 } },
    主角: { 金币: 37, 状态效果: { 清醒: { 效果: '不易入睡', 持续时间: '一小时' } }, 技能列表: [{ 名称: '航海' }], 背包: { 灯油: { 数量: 3 } } },
  };
  let report, state;
  function result(config, name) {
    const feedback = config.ordered_prompts.at(-1).content;
    const match = new RegExp('<action_result name="' + name + '" status="ok">\\n([\\s\\S]*?)\\n</action_result>').exec(feedback);
    assert.ok(match, feedback);
    return JSON.parse(match[1]);
  }
  const { host, agent, ctx, vars } = makeHost({
    agentSettings: { toolProtocol: 'text', plotContext: false, recall: false },
    replies: [
      call('ls', { path: 'var:/' }),
      config => {
        assert.match(config.ordered_prompts.at(-1).content, /mvu\.json/);
        return call('read', { path: 'var:/mvu.json#/stat_data' });
      },
      config => {
        assert.match(config.ordered_prompts.at(-1).content, /灯塔/);
        return call('toolbox', { name: 'reader' });
      },
      config => {
        assert.match(config.ordered_prompts.at(-1).content, /adapt_variables/);
        return call('adapt_variables', { use_llm: false });
      },
      config => {
        report = result(config, 'adapt_variables');
        return call('reader_state', {});
      },
      config => {
        state = result(config, 'reader_state');
        return report.slots.map(slot => slot.label + ' → ' + state.routing[slot.slot].target).join('\n');
      },
    ],
  });
  ctx.characters[0].data.description = '';
  ctx.characters[0].data.extensions.reader_ii = { enabled: true };
  vars.message.stat_data = clone(statData);
  await host.ReaderCore.ready();
  const confirmed = [];
  const run = await agent.run('核对这张卡的七个语义槽并逐项报告', { confirm: req => { confirmed.push(req.name); return 'allow'; } });
  assert.equal(run.error, '');
  same(confirmed, ['adapt_variables']);
  same(run.steps.map(step => step.name), ['ls', 'read', 'toolbox', 'adapt_variables', 'reader_state']);
  assert.ok(run.steps.every(step => step.ok));
  assert.equal(report.boundCount, 7, JSON.stringify(report));
  assert.equal(run.answer.split('\n').length, 7);
  for (const slot of report.slots) {
    assert.equal(slot.changed, true);
    assert.equal(state.routing[slot.slot].target, slot.path);
    assert.equal(state.routing[slot.slot].status, 'active');
    assert.equal(vars.chat.reader_ii_runtime.routing[slot.slot].status, 'active');
  }
  assert.equal(state.location, '灯塔');
  assert.equal(state.fp, 37);
  assert.equal(state.inventory[0].count, 3);
  assert.equal(state.characters[0].favor, 52);
  const { READER, ...untouched } = vars.message.stat_data;
  same(untouched, statData);
});

test('助手声明的语义映射与实际 DSL 对齐，误传标量映射会提示可重试参数', async () => {
  const { host, ctx, vars } = makeHost();
  ctx.characters[0].data.extensions.reader_ii = { enabled: true };
  vars.message.stat_data.位置 = '码头';
  await host.ReaderCore.ready();
  const modules = host.__ReaderIIModules;
  const def = modules.createAgentTools({}, {}, { core: () => host.ReaderCore }).find('adapt_variables');
  const mapping = modules.agentProtocol.toolSchema(def).function.parameters.properties.mappings;
  assert.equal(mapping.additionalProperties, false);
  same(Object.keys(mapping.properties).sort(), ['characters', 'inventory', 'skills', 'statuses', 'tasks']);
  const characters = mapping.properties.characters;
  assert.equal(characters.additionalProperties, false);
  assert.ok(characters.required.includes('name'));
  assert.ok(characters.properties.fields.required.includes('favor'));
  const roots = { location: ['位置'] };
  await assert.rejects(def.run({ roots, mappings: { location: { type: 'string' } } }), /location.*roots.*mappings/);
  assert.equal(host.ReaderCore.getSemanticRouting().location.status, 'unbound');
  const retry = await def.run({ roots, use_llm: false });
  assert.equal(retry.boundCount, 1);
  assert.equal(await host.ReaderCore.getLocation(), '码头');
});

test('助手适配空槽遵守世界书和条目级读规则，受限证据不会送给模型', async () => {
  const root = { characters: ['关系列表'] };
  for (const rule of [
    { effect: 'deny', pattern: 'wb:/设定集/**', reads: 0 },
    { effect: 'ask', pattern: 'wb:/设定集/变量更新规则', reads: 1 },
    { effect: 'deny', pattern: 'wb:/设定集/变量更新规则%232', reads: 1 },
    { effect: 'allow', pattern: 'wb:/设定集/**', reads: 1 },
  ]) {
    const fixture = makeHost({
      replies: [call('adapt_variables', { roots: JSON.stringify(root), use_llm: false }), call('reader_state', {}), '已核对。'],
      agentSettings: { rules: [{ effect: rule.effect, action: 'read', pattern: rule.pattern }], recall: false, plotContext: false },
    });
    const { host, agent, vars, worldbooks, llmCalls } = fixture;
    fixture.ctx.characters[0].data.extensions.reader_ii = { enabled: true };
    vars.message.stat_data.关系列表 = {};
    worldbooks.设定集.push({ uid: 2, name: '变量更新规则', enabled: true, content: '{"关系列表":{"证据角色":{"好感度":50}}}' });
    const originalRead = host.TavernHelper.getWorldbook;
    let reads = 0;
    host.TavernHelper.getWorldbook = async (book) => { reads++; return originalRead(book); };
    await host.ReaderCore.ready();
    const result = await agent.run('从这张卡的定义绑定角色槽', { confirm: () => 'allow' });
    assert.equal(result.error, '');
    assert.equal(reads, rule.reads, rule.pattern);
    const allowed = rule.effect === 'allow';
    assert.equal(result.steps[0].ok, allowed, result.steps[0].summary);
    assert.equal(host.ReaderCore.getSemanticRouting().characters.status, allowed ? 'active' : 'unbound');
    assert.equal(result.steps[1].ok, true);
    const finalFeedback = llmCalls.at(-1).at(-1).content;
    assert.match(finalFeedback, /"skills": \[/);
    if (allowed) assert.match(finalFeedback, /stat_data\.关系列表/);
    if (!allowed) {
      assert.match(JSON.stringify(llmCalls.at(-1)), /读取权限限制/);
      assert.doesNotMatch(JSON.stringify(llmCalls), /证据角色/);
    }
  }
});

test('适配和解绑在确认和日志中说明需要手动恢复，不保存无关的楼层镜像', async () => {
  const { agent, host } = makeHost({ replies: [call('adapt_variables', {}), call('unbind_slot', { slot: 'currency' }), '已完成。'] });
  host.ReaderCore.autoAdapt = async () => ({ slots: [{ slot: 'currency', changed: true }] });
  host.ReaderCore.unbindSemanticSlot = async () => ({ status: 'unbound' });
  const asked = [];
  const result = await agent.run('绑定并解绑货币', { confirm: async (request) => { asked.push(request); return 'allow'; } });
  assert.equal(result.error, '');
  same(result.steps.map((step) => step.ok), [true, true]);
  assert.equal(asked.length, 2);
  for (const item of asked) {
    assert.match(item.description, /手动恢复/);
    assert.equal(item.path, 'var:/message/latest.json', '保留旧规则的权限匹配目标');
  }
  const report = await agent.undo(result.runId);
  same(report.restored, []);
  assert.equal(report.notes.length, 2);
  assert.ok(report.notes.every((note) => note.includes('手动恢复')));
});

test('启动：全局对象、旧名与挂载点', () => {
  const { host, api, vfs } = makeHost();
  assert.equal(api.ready, true);
  assert.equal(host.ReaderAgent, api.agent);
  assert.equal(host.ReaderMemory, api.memory);
  const mounts = vfs.mounts().map((item) => item.id);
  for (const id of ['chat', 'card', 'cards', 'wb', 'regex', 'script', 'preset', 'var', 'ext', 'page', 'ws', 'kb', 'mem']) assert.ok(mounts.includes(id), `缺少挂载点 ${id}`);
  const core = api.agent.listTools().filter((item) => item.toolset === 'core').map((item) => item.name);
  same(core.sort(), ['capabilities', 'delegate_task', 'edit', 'grep', 'ls', 'read', 'remove', 'run_js', 'skill', 'todo', 'toolbox', 'write']);
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

test('原生世界书：没有酒馆助手或编辑器下拉框，单卡可改附加书、保留其他绑定和未列出的书', async () => {
  const wi = { world_names: ['主设定', '附录', '公共资料'], world_info: { charLore: [{ name: 'ailin', extraBooks: ['附录'] }] }, selected_world_info: ['公共资料'] };
  wi.updateWorldInfoSettings = (_, active) => { wi.selected_world_info = active; };
  const { host, api, agent, vfs, ctx } = makeHost({ globals: { Function: function (...args) {
    if (args[1] === 'return import(p)') return (path) => path === '/scripts/world-info.js' ? Promise.resolve(wi) : Promise.reject(new Error(path));
    return Function(...args);
  } }, replies: [call('edit', { path: 'wb:/附录/天气', old: '晴', new: '雨' }), call('edit', { path: 'wb:/公共资料/天气', old: '晴', new: '雨' }), '完成。'] });
  host.generateRaw = host.TavernHelper.generateRaw;
  delete host.TavernHelper;
  ctx.characters[0].data.extensions.world = '主设定';
  const rawBook = () => ({ name: '保留书级数据', entries: { 4: { uid: 4, comment: '天气', content: '晴', custom: '保留条目字段' } } });
  const books = { 附录: rawBook(), 公共资料: rawBook(), 未列出: rawBook() };
  ctx.loadWorldInfo = async (name) => clone(books[name]) || null;
  ctx.saveWorldInfo = async (name, value) => { books[name] = clone(value); };
  const asks = [];
  const result = await agent.run('修改世界书', { confirm: (request) => { asks.push(request.scope); return 'allow'; } });
  assert.equal(result.steps[0].ok, true, JSON.stringify(result));
  assert.equal(result.steps[1].denied, true);
  assert.deepEqual(asks, ['card']);
  assert.equal(books.附录.entries[4].content, '雨');
  assert.equal(books.公共资料.entries[4].content, '晴');
  same((await vfs.list('wb:/')).items.map((item) => item.name), wi.world_names);
  assert.equal(await vfs.readText('wb:/未列出/天气'), '晴');
  await vfs.write('wb:/未列出/新条目', '已加入');
  assert.equal(books.未列出.entries[4].content, '晴');
  assert.equal(books.未列出.entries[4].custom, '保留条目字段');
  assert.equal(books.未列出.name, '保留书级数据');
  assert.equal(books.未列出.entries[5].content, '已加入');
  await api.kit.mountWorldbook('新书', 'character');
  same(wi.world_info.charLore[0].extraBooks, ['附录', '新书']);
  await api.kit.mountWorldbook('新书', 'global');
  same(wi.selected_world_info, ['公共资料', '新书']);
  ctx.loadWorldInfo = async () => null;
  await assert.rejects(vfs.write('wb:/附录/另一个条目', '内容'), /读取世界书/);
  assert.equal(books.附录.entries[4].content, '雨');
});

test('原生角色变量：兼容卡内对象、键值对和早期字段', async () => {
  const { host, ctx, vfs } = makeHost();
  delete host.TavernHelper;
  const data = ctx.characters[0].data;
  const variables = { 人物: { 名称: '艾琳' } };
  for (const extensions of [{ tavern_helper: { variables } }, { tavern_helper: [['scripts', []], ['variables', variables]] }, { TavernHelper_characterScriptVariables: variables }]) {
    data.extensions = extensions;
    assert.equal(await vfs.readText('var:/character.json#/人物/名称'), '艾琳');
    assert.equal(vfs.scope('var:/character.json', 'write'), 'card');
  }
  await assert.rejects(vfs.write('var:/character.json', '{}'), /replaceVariables/);
  assert.equal(await vfs.readText('var:/character.json#/人物/名称'), '艾琳');
  ctx.characterId = undefined;
  await assert.rejects(vfs.readText('var:/character.json'), /打开.*角色卡/);
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
  await vfs.write('mem:/chat/偏爱简答.md', '用户喜欢简洁的回答。', null);
  const [record] = await api.memory.list({ store: 'chat' });
  assert.equal(record.title, '偏爱简答');
  assert.equal(record.owner, 'agent');
  await assert.rejects(vfs.write('mem:/chat/偏爱简答.meta.json', JSON.stringify({ owner: 'story' }), null), /助手交流/);
  await vfs.write('mem:/chat/偏爱简答.meta.json', JSON.stringify({ keys: ['简洁'] }), null);
  const meta = JSON.parse(await vfs.readText('mem:/chat/偏爱简答.meta.json'));
  assert.equal(meta.owner, 'agent');
  same(meta.keys, ['简洁']);
  assert.equal(vfs.scope('mem:/ocean/x.md', 'write'), 'chat');
  assert.match(JSON.stringify(await vfs.grep('mem:/', '简洁', {})), /mem:\/chat\/偏爱简答\.md/);
  assert.equal((await vfs.list('mem:/', {})).items.some(item => item.name === 'summary.md'), false);
  await vfs.remove('mem:/chat/偏爱简答.md', null);
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
  assert.match(permissions.describe(), /ws:\//);
  settings.rules = [{ effect: 'ask', action: 'write', pattern: 'ws:/审核/**' }];
  assert.equal(permissions.evaluate({ effect: 'write', scope: 'workspace', path: 'ws:/审核/草稿' }).decision, 'ask');
  assert.equal(permissions.evaluate({ effect: 'write', scope: 'workspace', path: 'ws:/想法' }).decision, 'allow');
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
  assert.doesNotMatch(system, /【当前剧情】|艾琳放下了手里的杯子/);
  assert.ok(!/fp_adjust/.test(system), '没打开的工具箱不该出现在提示词里');
  assert.match(llmCalls[1].at(-1).content, /<action_result name="read" status="ok">/);

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

test('调整权限档位后在原任务复核原调用，仍须执行写入确认', async () => {
  const write = call('edit', { path: 'wb:/公共资料/货币', old: '金币', new: '银币' });
  const fixture = makeHost({ replies: [write, '已完成。'] });
  const events = [];
  const result = await fixture.agent.run('修改公共资料', {
    reviewPermission(request) {
      events.push([request.currentMode, request.requiredMode, request.path]);
      fixture.agent.saveSettings({ mode: 'tavern' });
      return true;
    },
    confirm(request) { events.push(request.name); return 'allow'; },
  });
  same(events, [['card', 'tavern', 'wb:/公共资料/货币'], 'edit']);
  assert.equal(result.steps.length, 1);
  assert.ok(result.steps[0].ok);
  assert.match(fixture.worldbooks.公共资料[0].content, /银币/);
});

test('请求复核不授予权限，跳过、本轮新增禁止规则和换聊天均不能执行原操作', async () => {
  const path = 'wb:/公共资料/货币';
  const write = call('edit', { path, old: '金币', new: '银币' });
  const rule = { effect: 'deny', action: 'write', pattern: 'wb:/公共资料/**' };
  for (const scenario of ['unchanged', 'skip', 'rule', 'newRule', 'chat']) {
    const fixture = makeHost({ replies: scenario === 'skip' ? [write, write, '结束。'] : [write, '结束。'] });
    let reviews = 0;
    let confirms = 0;
    if (scenario === 'rule') fixture.agent.saveSettings({ rules: [rule] });
    const outcome = await fixture.agent.run('核对后修改', {
      reviewPermission() {
        reviews++;
        if (scenario === 'chat') fixture.ctx.getCurrentChatId = () => 'chat-2';
        if (scenario === 'newRule') fixture.agent.saveSettings({ mode: 'tavern', rules: [rule] });
        return scenario !== 'skip';
      },
      confirm() { confirms++; return 'allow'; },
    });
    assert.equal(reviews, scenario === 'rule' ? 0 : 1, scenario);
    assert.equal(confirms, 0, scenario);
    if (scenario === 'chat') assert.equal(outcome.aborted, true);
    else assert.ok(outcome.steps.every((step) => step.denied), scenario);
    assert.match(fixture.worldbooks.公共资料[0].content, /金币/);
  }
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

test('长任务：旧设置保留，可保存超过 60 轮，发送同批工具和协议提醒各自计数', async () => {
  const lookup = (offset) => call('read', { path: 'wb:/设定集/王都', offset });
  const replies = ['我会先核对这张卡的变量结构，再逐项转换并验证。', lookup(1) + '\n' + lookup(2),
    ...Array.from({ length: 65 }, (_, index) => lookup(index + 3)), '核对完毕。'];
  assert.equal(makeHost().agent.getSettings().maxSteps, 32);
  const { agent, ctx } = makeHost({ agentSettings: { maxSteps: 16 } });
  assert.equal(agent.getSettings().maxSteps, 16);
  agent.saveSettings({ maxSteps: 66 });
  const restored = makeHost({ agentSettings: ctx.extensionSettings.reader_ii.agent, replies });
  restored.agent.saveModelSettings({ contextWindow: 1000000 });
  const result = await restored.agent.run('按顺序核对', { remember: false });
  assert.equal(result.rounds, 66);
  assert.equal(result.steps.length, 67);
  assert.equal(result.answer, '核对完毕。');
  assert.match(restored.llmCalls[0][0].content, /获配 66 轮/);
  assert.match(restored.llmCalls[0][0].content, /设置 → 工具调用/);
  assert.match(restored.llmCalls[1].at(-1).content, /实际上什么都没有执行/);
});

test('追加预算：只有新调用才询问，同一任务接着读取并保留对写入的独立确认', async () => {
  const read = call('read', { path: 'wb:/设定集/王都' });
  const edit = call('edit', { path: 'wb:/设定集/王都', old: '人口十万', new: '人口三十万' });
  const choices = [];
  const fixture = makeHost({
    agentSettings: { maxSteps: 1 },
    replies: [read, edit, read, '改完并核实了。', read, '查到了。'],
    requestMoreRounds: (request) => { choices.push([request.rounds, request.suggested, [...request.tools]]); return 2; },
  });
  const confirms = [];
  const options = { interactiveBudget: true, confirm: (request) => { confirms.push(request.name); return 'allow'; } };
  const first = await fixture.agent.run('修改并回读', options);
  assert.equal(first.answer, '改完并核实了。');
  assert.equal(first.rounds, 3);
  assert.equal(first.changes, 1);
  assert.equal((await fixture.agent.listRuns()).length, 1);
  assert.match(fixture.llmCalls[3].at(-1).content, /人口三十万/);
  assert.equal(fixture.agent.getSettings().maxSteps, 1);
  const next = await fixture.agent.run('读取即可', options);
  assert.equal(next.rounds, 1);
  assert.equal(next.answer, '查到了。');
  same(choices, [[1, 1, ['edit']]]);
  same(confirms, ['edit']);
});

test('用完预算选择汇总后，待执行的写入不会运行，修改默认值只影响下一任务', async () => {
  const read = call('read', { path: 'wb:/设定集/王都' });
  const edit = call('edit', { path: 'wb:/设定集/王都', old: '人口十万', new: '人口三十万' });
  const fixture = makeHost({
    agentSettings: { maxSteps: 1 }, replies: [() => { fixture.agent.saveSettings({ maxSteps: 200 }); return read; }, edit, '只完成了读取。'],
    requestMoreRounds: () => 0,
  });
  const result = await fixture.agent.run('先读再写', { interactiveBudget: true, confirm: () => 'allow' });
  assert.equal(result.stopReason, 'step_limit');
  assert.equal(result.rounds, 1);
  assert.equal(result.answer, '只完成了读取。');
  assert.equal(result.changes, 0);
  assert.match(fixture.worldbooks.设定集[0].content, /人口十万/);
  assert.match(fixture.llmCalls.at(-1).at(-1).content, /已到本次请求的工具步数上限/);
});

test('超长预算下连续三次同样的失败会收尾，不继续花费剩余轮数', async () => {
  const invalid = call('no_such_card_tool', {});
  const fixture = makeHost({ agentSettings: { maxSteps: 1000 }, replies: [invalid, invalid, invalid, '工具不存在。'] });
  const result = await fixture.agent.run('核对角色卡');
  assert.equal(result.stopReason, 'no_progress');
  assert.equal(result.rounds, 3);
  assert.match(fixture.llmCalls.at(-1).at(-1).content, /连续三轮相同调用/);
});

test('默认欢迎语保持临时显示，主动保存后成为首条助手消息并带进下一轮', async () => {
  const fresh = makeHost({ replies: ['答复。'] });
  const greeting = fresh.agent.getGreeting();
  assert.equal(fresh.agent.getHistory().length, 0);
  await fresh.agent.run('第一问', { lite: true });
  assert.equal(fresh.llmCalls[0].some(t => t.content === greeting.text), false);

  const edited = makeHost({ replies: ['答复。'] });
  await edited.agent.editHistoryTurn(greeting.id, '新的欢迎语', { chatKey: '0|chat-1', originalText: greeting.text });
  assert.equal(edited.agent.getHistory()[0].role, 'assistant');
  assert.equal(edited.agent.getHistory()[0].text, '新的欢迎语');
  assert.notEqual(edited.agent.getHistory()[0].id, greeting.id);
  await edited.agent.run('第一问', { lite: true });
  assert.equal(edited.llmCalls[0].filter(t => t.content === '新的欢迎语').length, 1);
});

test('线程双方消息可编辑，保留工具记录与长原文，下一轮模型读取修订稿', async () => {
  let history;
  const { agent, llmCalls } = makeHost({ replies: ['继续。'], inspectHistory: store => { history = store; } });
  const original = '长'.repeat(13000) + '旧结尾';
  await history.ready();
  await history.write({ extracted: 2, turns: [
    { id: 'u', role: 'user', text: '原问题', at: 1 },
    { id: 'a', role: 'assistant', text: original, at: 1, tools: ['read'] },
  ] });
  const [user, ai] = agent.getHistory();
  assert.equal(ai.text, original);
  assert.notEqual(user.id, ai.id);
  const snapshot = originalText => ({ chatKey: '0|chat-1', originalText });
  await agent.editHistoryTurn(user.id, '修订的问题', snapshot('原问题'));
  const revised = '修订的回答\n' + original;
  await agent.editHistoryTurn(ai.id, revised, snapshot(original));
  assert.equal(llmCalls.length, 0);
  same(history.read().turns.map(t => t.id), [user.id, ai.id]);
  assert.equal(history.read().extracted, 2);
  const run = await agent.run('继续', { lite: true });
  assert.equal(run.answer, '继续。');
  assert.equal(llmCalls[0].find(t => t.role === 'user').content, '修订的问题');
  const answerInPrompt = llmCalls[0].find(t => t.role === 'assistant').content;
  assert.match(answerInPrompt, /^修订的回答/);
  assert.match(answerInPrompt, /旧结尾/);
  assert.match(answerInPrompt, /当时用过的工具：read/);
  const turns = agent.getHistory();
  assert.equal(turns[1].text, revised);
  same(turns[1].tools, ['read']);
  assert.equal(new Set(turns.map(t => t.id)).size, 4);
});

test('消息改动冲突、聊天切换、存盘失败都保留其余记录', async () => {
  let diskFailure = false;
  const { agent, ctx } = makeHost({ replies: ['回答。'], inspectHistory(history) {
    const write = history.write;
    history.write = (...args) => { if (diskFailure) throw new Error('磁盘不可写'); return write(...args); };
  } });
  await agent.run('问题', { lite: true });
  const [user, ai] = agent.getHistory();
  const snapshot = { chatKey: '0|chat-1', originalText: user.text };
  await agent.editHistoryTurn(user.id, '先保存的内容', snapshot);
  await assert.rejects(agent.editHistoryTurn(user.id, '旧编辑器', snapshot), /已被修改/);
  ctx.getCurrentChatId = () => 'chat-2';
  await assert.rejects(agent.editHistoryTurn(user.id, '另一聊天', snapshot), /聊天已切换/);
  ctx.getCurrentChatId = () => 'chat-1';
  diskFailure = true;
  await assert.rejects(agent.editHistoryTurn(ai.id, '未落盘', { ...snapshot, originalText: ai.text }), /磁盘不可写/);
  same(agent.getHistory().map(t => t.text), ['先保存的内容', ai.text]);
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

test('剧情记忆只读单选：旧设置、关闭、无记录和接口错误都不回落正文', async () => {
  const reads = [];
  const globals = {
    STBaiBaiBook: {
      getInjectedHistory() { return { relativeText: '只供正文注入的旧楼' }; },
      getHistory() { reads.push('baibai'); return { relativeText: '柏宝书近期记录' }; },
    },
    AutoCardUpdaterAPI: {
      exportTableAsJson() {
        reads.push('shujuku');
        return {
          mate: { version: '模板信息' },
          sheet_items: { name: '物品', orderNo: 1, content: [[null, '名称'], [null, '石头'.repeat(200)]] },
          sheet_summary: { name: '总结表', orderNo: 2, sourceData: { instructions: '模板指令' },
            content: [[null, '概要'], [null, '旧楼'.repeat(200)], [null, '数据库最新剧情']] },
        };
      },
    },
    LittleWhiteBox: {},
    WORLD_ENGINE_CORE: {
      hasState() { return true; },
      loadState() {
        reads.push('worldengine');
        return { worldDigest: '幕后局势', chapterSummaries: [{ content: '最近章节' }, { content: '旧章节'.repeat(300) }],
          blackbox: '隐私配置', config: { key: '配置值' } };
      },
    },
  };
  const { agent, ctx, llmCalls } = makeHost({ globals, agentSettings: { plotContext: false, plotBudget: 200, recall: false, lite: true } });
  const story = async (patch = {}, options = {}) => {
    agent.saveSettings(patch);
    const run = await agent.run('好', { remember: false, ...options });
    assert.equal(run.error, '');
    const prompt = llmCalls.at(-1)[0].content;
    assert.doesNotMatch(prompt, /我推开了酒馆的门|放下了手里的杯子/);
    return prompt;
  };
  const noPlot = /【当前剧情】/;
  assert.equal(agent.getSettings().plotSource, 'auto');
  assert.doesNotMatch(await story(), noPlot);
  same(reads, []);
  assert.match(await story({ plotContext: true }), /柏宝书近期记录/);
  same(reads.splice(0), ['baibai']);
  assert.match(await story({ plotSource: 'shujuku' }), /数据库最新剧情/);
  assert.doesNotMatch(llmCalls.at(-1)[0].content, /柏宝书近期记录|石头|模板信息|模板指令/);
  same(reads.splice(0), ['shujuku']);
  assert.doesNotMatch(await story({}, { plotContext: false }), noPlot);
  assert.doesNotMatch(await story({ plotSource: '' }), noPlot);
  assert.equal(agent.getSettings().plotContext, false);
  same(reads, []);

  ctx.chatMetadata.extensions = { LittleWhiteBox: { storySummary: {
    json: { events: [{ title: '小白X既有事件', summary: '港口重开' }], facts: [{ s: '甲', p: '身份', o: '向导' }] },
    summaryHistory: ['回滚账本内容'],
  } } };
  ctx.extensionPrompts = { LittleWhiteBox_StorySummary: { value: '不带聊天标识的临时插槽' } };
  const oldMetadata = clone(ctx.chatMetadata.extensions);
  const lwb = await story({ plotContext: true, plotSource: 'lwb' });
  assert.match(lwb, /港口重开/);
  assert.doesNotMatch(lwb, /回滚账本内容|临时插槽/);
  same(ctx.chatMetadata.extensions, oldMetadata);
  ctx.chatMetadata.extensions.LittleWhiteBox.storySummary.summaryInvalid = true;
  assert.doesNotMatch(await story(), noPlot);
  ctx.chatMetadata.extensions = {};
  assert.doesNotMatch(await story(), noPlot);

  assert.match(await story({ plotSource: 'worldengine' }), /幕后局势\n最近章节/);
  assert.doesNotMatch(llmCalls.at(-1)[0].content, /隐私配置|配置值/);
  same(reads.splice(0), ['worldengine']);
  globals.WORLD_ENGINE_CORE.hasState = () => false;
  assert.doesNotMatch(await story(), noPlot);
  globals.AutoCardUpdaterAPI.exportTableAsJson = () => { throw Error('尚未就绪'); };
  assert.doesNotMatch(await story({ plotSource: 'shujuku' }), noPlot);
  assert.doesNotMatch(await story({ plotSource: '缺失来源' }), noPlot);
  same(reads, []);
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

test('助手记忆从空库开始，旧世界书只关闭触发，新记忆支持共享、重开与导入', async () => {
  const { api, vars, worldbooks, ctx } = makeHost();
  const memory = api.memory;
  const legacy = {
    items: {
      a: { source: 'agent', type: 'bond', title: '喜欢猫', content: '用户喜欢猫。', keys: ['猫'] },
      s: { source: 'story', type: 'episode', title: '旧正文事件', content: '剧情秘密', pinned: true },
      m: { type: 'fact', source: 'manual', title: '旧设定', content: '来源不明的旧设定', pinned: true },
    }, summary: { text: '旧正文梗概' }, cursor: { index: 7 }, cfg: { store: 'ocean' },
  };
  vars.chat.reader_ii_memory = clone(legacy);
  worldbooks['夜之洋'] = [
    { uid: 0, name: '剧情记忆-旧事件', content: '<!--yzy {"id":"old","src":"story"} -->\n剧情秘密', enabled: true },
    { uid: 1, name: '情感记忆-深夜聊天', content: '<!--yzy {"id":"night","src":"agent","t":"bond"} -->\n聊到深夜。', enabled: true, strategy: { type: 'constant', keys: [] } },
    { uid: 2, name: '背景资料', content: '他人的世界书内容。', enabled: true },
    { uid: 3, name: '剧情记忆-自建条目', content: '手工创建的同名条目', enabled: true },
    { uid: 4, name: '设定记忆-旧署名', content: '> 记录于 2025/4/1 12:00:00 ｜ 设定记忆\n旧版无标记剧情', enabled: true },
  ];
  const oldBodies = worldbooks['夜之洋'].map(e => e.content);
  await memory.syncOceanVisibility();
  same(worldbooks['夜之洋'].map(e => e.content), oldBodies);
  same(worldbooks['夜之洋'].map(e => e.enabled), [false, false, true, true, false]);
  assert.equal(memory.targetStore(), 'chat');
  same(await memory.list(), []);
  assert.equal((await memory.buildInjection('猫')).text, '');
  assert.equal(await memory.get('night'), null);
  for (const oldExport of [Object.values(legacy.items), { items: Object.values(legacy.items) }, { v: 1, kind: 'reader-ii-memory', items: Object.values(legacy.items) }]) {
    await assert.rejects(memory.importAll(oldExport), /新版助手记忆/);
  }
  await assert.rejects(memory.add({ source: 'story', content: '剧情秘密' }), /助手交流/);
  await memory.add({ type: 'howto', title: '核对步骤', content: '与用户约定的核对步骤。', pinned: true }, { store: 'ocean' });
  await memory.add({ title: '回答要简短', content: '用户希望回复简短。', pinned: true }, { store: 'chat' });
  same(vars.chat.reader_ii_memory, legacy);
  const exported = await memory.exportAll();
  assert.doesNotMatch(JSON.stringify(exported), /喜欢猫|深夜聊天|剧情秘密|旧设定|旧正文梗概|旧署名/);
  const reopened = makeHost();
  reopened.vars.chat[memory.chatKey] = clone(vars.chat[memory.chatKey]);
  reopened.worldbooks['夜之洋'] = clone(worldbooks['夜之洋']);
  same((await reopened.api.memory.list()).map(i => i.title).sort(), ['回答要简短', '核对步骤']);
  const other = makeHost().api.memory;
  assert.equal((await other.importAll(exported)).added, 2);
  assert.equal((await other.importAll(exported)).skipped, 2);
  memory.saveSettings({ unify: true, scope: 'all' });
  assert.equal((await memory.buildInjection('猫')).text, '', '只用助手的卡不会获取 Meta 身份或记忆');
  ctx.characters[0].data.extensions.reader_ii = { enabled: true };
  const block = await memory.buildInjection('猫');
  for (const word of ['真实用户', '{{user}}', '不主动超游', '回答要简短', '核对步骤']) assert.ok(block.text.includes(word), word);
  assert.doesNotMatch(block.text, /喜欢猫|深夜聊天|剧情秘密|旧设定|旧正文梗概/);
  assert.equal(worldbooks['夜之洋'].find(e => e.name.includes('核对步骤')).enabled, false);
  memory.saveSettings({ unify: false });
  assert.equal((await memory.buildInjection('猫')).text, '');
});

test('旧世界书改名和切聊天后只停用挂载书中的 Reader 标记，正文不重复读库', async () => {
  const { host, api, worldbooks, llmCalls } = makeHost();
  const old = { uid: 0, name: '剧情记忆-旧约定', enabled: true, strategy: { type: 'constant' },
    content: '<!--yzy {"id":"mabc","t":"episode","src":"story","o":"story"} -->\n> 记录于 2025/4/1 ｜ 剧情记忆\n旧剧情' };
  const handwritten = { uid: 1, name: '剧情记忆-手记', enabled: true, content: '> 记录于 昨日 ｜ 剧情记忆\n手写条目' };
  const foreign = { uid: 2, name: '插件记录', enabled: true, content: '<!--yzy {"schema":"another-plugin","id":"mabc","t":"episode"} -->\n插件资料' };
  for (const name of ['当前记忆本', '先前的全局记忆本', '另一张卡的旧本', '未挂载的资料']) {
    worldbooks[name] = clone([old, handwritten, foreign]);
  }
  const events = new Map(), reads = [], writes = [];
  let catalog = [], globalBooks = [], extraBooks = [];
  const kit = { ...api.kit, on: (name, handler) => events.set(name, handler),
    localRead: () => ({ oceanBook: '当前记忆本' }), worldbookNames: () => catalog,
    worldbookScopes: () => ({ all: catalog, global: globalBooks }), linkedWorldbooks: async () => extraBooks,
    readWorldbook: name => { reads.push(name); return api.kit.readWorldbook(name); },
    updateWorldbook: (name, fn) => { writes.push(name); return api.kit.updateWorldbook(name, fn); } };
  const modules = host.__ReaderIIModules;
  const env = modules.createEnv(host);
  const memory = modules.createMemorySystem(env, { chat() { assert.fail('正文不可整理记忆'); } }, kit, modules.createAgentHistory(env, kit));
  memory.install();
  await events.get('CHAT_CHANGED')();
  assert.deepEqual(reads, [], '启动时目录尚未就绪');
  catalog = Object.keys(worldbooks);
  globalBooks = ['先前的全局记忆本'];
  await events.get('GENERATION_AFTER_COMMANDS')();
  assert.deepEqual(writes, ['当前记忆本', '先前的全局记忆本']);
  same(worldbooks['当前记忆本'], [{ ...old, enabled: false }, handwritten, foreign]);
  same(worldbooks['先前的全局记忆本'], [{ ...old, enabled: false }, handwritten, foreign]);
  extraBooks = ['另一张卡的旧本', '先前的全局记忆本'];
  await events.get('CHAT_CHANGED')();
  same(worldbooks['另一张卡的旧本'], [{ ...old, enabled: false }, handwritten, foreign]);
  await events.get('GENERATION_AFTER_COMMANDS')();
  assert.deepEqual(reads, ['当前记忆本', '先前的全局记忆本', '另一张卡的旧本']);
  same(worldbooks['未挂载的资料'], [old, handwritten, foreign]);
  worldbooks['先前的全局记忆本'][0].enabled = true;
  events.get('WORLDINFO_UPDATED')('先前的全局记忆本');
  await events.get('GENERATION_AFTER_COMMANDS')();
  assert.equal(worldbooks['先前的全局记忆本'][0].enabled, false);
  assert.equal(llmCalls.length, 0);
  await memory.dispose();
});

test('正文消息与生成事件不触发助手记忆整理；手动、自动与工具共用助手历史游标', async () => {
  let history;
  const { host, api, agent, llmCalls, vars, ctx } = makeHost({ inspectHistory: store => { history = store; }, replies: ['好的，我之后会尽量简短。', '{"memories":[{"op":"add","type":"fact","title":"简短回答","content":"用户喜欢简短回答。","keys":["简短"]}]}'] });
  const modules = host.__ReaderIIModules;
  const events = new Map();
  const env = modules.createEnv(host);
  const kit = { ...api.kit, on: (event, handler) => events.set(event, handler), readChat() { throw new Error('记忆不应读取正文'); } };
  const separate = modules.createMemorySystem(env, { chat() { throw new Error('正文不应调用记忆模型'); } }, kit, modules.createAgentHistory(env, kit));
  separate.install();
  for (const event of ['MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'GENERATION_AFTER_COMMANDS', 'CHAT_CHANGED']) {
    await events.get(event)?.();
  }
  assert.equal((await separate.consolidate()).window, 0);
  assert.equal(vars.chat[separate.chatKey], undefined);
  assert.equal(llmCalls.length, 0);
  await history.ready();
  await history.write({ extracted: 2, turns: [
    { id: 'history-u', role: 'user', text: '之前已整理的用户消息' }, { id: 'history-a', role: 'assistant', text: '之前已整理的助手回复' }
  ] });
  assert.equal(agent.getHistory().length, 2);
  assert.equal((await api.memory.consolidate()).window, 0);
  assert.equal(llmCalls.length, 0);
  api.memory.saveSettings({ agentEveryTurns: 1 });
  ctx.name1 = '正文主角名字';
  await agent.run('以后请说简短一点。');
  const report = await api.memory.consolidate();
  assert.ok(report.ok, report.error);
  const inputs = llmCalls.filter(messages => messages[0].content.includes('整理真实用户'));
  assert.equal(inputs.length, 1);
  assert.match(inputs[0][1].content, /真实用户：以后请说简短一点。/);
  assert.match(inputs[0][1].content, /夜梦助手：好的/);
  assert.doesNotMatch(JSON.stringify(inputs), /之前已整理|正文主角名字|酒馆的门|清晨，王都/);
  assert.equal(history.read().extracted, 4);
  assert.equal((await api.memory.list({ store: 'chat' }))[0].title, '简短回答');
  assert.equal((await api.memory.status()).pending.turns, 0);
  const tool = modules.createAgentTools(env, api.kit, { memory: api.memory }).find('memory_consolidate');
  assert.equal((await tool.run({}, {})).added.length, 0);
  assert.equal(llmCalls.length, 2);
});

test('助手记忆仅在当前批次成功落盘后前移：编辑、模型格式错误或世界书写入失败后可重试', async () => {
  const { host, api, vars, ctx } = makeHost();
  const modules = host.__ReaderIIModules;
  const env = modules.createEnv(host);
  const history = modules.createAgentHistory(env, api.kit);
  history.write({ v: 1, turns: [{ role: 'user', text: '叫我小白', id: 'u' }, { role: 'assistant', text: '记下啦', id: 'a' }], extracted: 0 });
  const response = JSON.stringify({ memories: [{ type: 'fact', title: '称呼', content: '用户希望被叫作小蓝' }] });
  let answer = () => '<html>upstream error</html>';
  let failWrite = false;
  const kit = { ...api.kit, addWorldbookEntries(...args) {
    if (failWrite) throw new Error('写入失败');
    return api.kit.addWorldbookEntries(...args);
  } };
  const memory = modules.createMemorySystem(env, { chat: () => answer() }, kit, history);
  assert.match((await memory.consolidate()).error, /JSON/);
  assert.equal(history.read().extracted, 0);
  answer = () => {
    vars.chat.reader_ii_agent.turns[0].text = '叫我小蓝';
    return response;
  };
  assert.match((await memory.consolidate()).error, /变更/);
  same(await memory.list(), []);
  assert.equal(history.read().extracted, 0);
  memory.saveSettings({ store: 'ocean' });
  answer = () => response;
  failWrite = true;
  assert.match((await memory.consolidate()).error, /写入失败/);
  assert.equal(history.read().extracted, 0);
  failWrite = false;
  const saveMetadata = ctx.saveMetadata;
  ctx.saveMetadata = async () => { throw new Error('存盘失败'); };
  assert.match((await memory.consolidate()).error, /存盘失败/);
  assert.equal(history.read().extracted, 0);
  ctx.saveMetadata = saveMetadata;
  const retry = await memory.consolidate();
  assert.ok(retry.ok, retry.error);
  assert.equal(history.read().extracted, 2);
  assert.equal((await memory.list()).length, 1);
  const more = history.read();
  more.turns.push({ role: 'user', text: '嗯', id: 'u2' }, { role: 'assistant', text: '嗯嗯', id: 'a2' });
  history.write(more);
  answer = () => '{"memories":[]}';
  assert.equal((await memory.consolidate()).ok, true);
  assert.equal(history.read().extracted, 4);
});

test('整理期间在同一张卡切换助手对话，旧请求不能推进另一段对话的整理游标', async () => {
  let history, started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const { host, api, agent } = makeHost({ inspectHistory: value => { history = value; } });
  await history.ready();
  await history.write({ ...history.read(), turns: [
    { id: 'u', role: 'user', text: '我喜欢蓝色' }, { id: 'a', role: 'assistant', text: '记下了' }
  ] });
  const modules = host.__ReaderIIModules;
  const memory = modules.createMemorySystem(modules.createEnv(host), { chat: () => { started(); return response; } }, api.kit, history);
  const pending = memory.consolidate();
  await entered;
  await agent.threads.create();
  release('{"memories":[{"op":"add","title":"颜色","content":"喜欢蓝色","type":"fact"}]}');
  assert.equal((await pending).ok, false);
  assert.equal(history.read().extracted, 0);
  assert.equal((await memory.list({ store: 'chat' })).length, 0);
});

test('无卡助手记忆随酒馆账号保存，打开卡后有独立的聊天记忆', async () => {
  const { api, ctx, vars } = makeHost();
  ctx.characterId = undefined;
  ctx.getCurrentChatId = () => undefined;
  await api.memory.add({ title: '无卡偏好', content: '偏爱短篇', type: 'fact' }, { store: 'chat' });
  assert.equal((await api.memory.list({ store: 'chat' })).length, 1);
  assert.equal(vars.chat[api.memory.chatKey], undefined);
  ctx.characterId = 0;
  ctx.getCurrentChatId = () => 'chat-1';
  assert.equal((await api.memory.list({ store: 'chat' })).length, 0);
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

test('主循环：再次打开工具箱、恢复计划均重新执行，也可关闭自动打开的工具箱', async () => {
  const openReader = call('toolbox', { name: 'reader' });
  const todo = (text) => call('todo', { items: JSON.stringify([{ text, status: 'doing' }]) });
  const update = [openReader, call('toolbox', { name: 'reader', action: 'close' }), openReader,
    call('toolbox', { name: 'example', action: 'close' }), todo('甲'), todo('乙'), todo('甲')].join('\n');
  const { agent, llmCalls } = makeHost({ replies: [update, '已更新。', '好的。'] });
  agent.registerToolset({ name: 'example', auto: true, summary: '演示工具箱' });
  agent.registerTool({ name: 'example_info', toolset: 'example', run() { return '可用'; } });
  const plans = [];
  const result = await agent.run('调整计划和工具箱', { onEvent(e) { if (e.type === 'todo') plans.push(e.items[0].text); } });
  assert.ok(result.steps.every((step) => step.ok));
  assert.deepEqual(plans, ['甲', '乙', '甲']);
  await agent.run('确认');
  assert.match(llmCalls[2][0].content, /【已打开的工具箱：reader】/);
  assert.doesNotMatch(llmCalls[2][0].content, /【已打开的工具箱：example】/);
});

test('主循环：结构化失败传给模型和界面，部分写入抛错后重新读取现场', async () => {
  const read = call('read_count', {});
  const { agent, llmCalls } = makeHost({ replies: [read, read, call('advance_count', {}), read, '查完了。'] });
  let attempt = 0, count = 0;
  agent.registerTool({ name: 'read_count', scope: 'workspace', run() {
    if (++attempt === 1) return { ok: false, note: '数据正在加载' };
    return { ok: true, count };
  } });
  agent.registerTool({ name: 'advance_count', scope: 'workspace', effect: 'write', run() {
    count++;
    throw new Error('第二步写入失败');
  } });
  const events = [];
  agent.on('tool:after', (e) => events.push(e.ok));
  const result = await agent.run('获取计数并更新');
  same(result.steps.map((step) => step.ok), [false, true, false, true]);
  assert.deepEqual(events, [false, true, false, true]);
  assert.equal(result.steps[0].summary, '数据正在加载');
  assert.match(llmCalls[1].at(-1).content, /status="error"[\s\S]*数据正在加载/);
  assert.match(llmCalls[4].at(-1).content, /"count": 1/);
});

test('主循环：缓存命中也须遵守本轮刚变更的读取规则', async () => {
  const read = call('read', { path: 'wb:/设定集/王都' });
  const { agent, llmCalls } = makeHost({ replies: [read, () => {
    agent.saveSettings({ rules: [{ effect: 'deny', action: 'read', pattern: 'wb:/设定集/**' }] });
    return read;
  }, '已停止读取。'] });
  const result = await agent.run('两次检查世界书');
  assert.equal(result.steps[0].ok, true);
  assert.ok(result.steps[1].denied);
  assert.match(llmCalls[2].at(-1).content, /status="denied"/);
  assert.doesNotMatch(llmCalls[2].at(-1).content, /守卫队长/);
});

test('主循环：用户确认期间切换聊天或收回写权限，原调用不能在新环境执行', async () => {
  const write = call('edit', { path: 'wb:/设定集/王都', old: '人口十万', new: '人口九万' });
  const switched = makeHost({ replies: [write, '结束。'] });
  const stopped = await switched.agent.run('修改当前卡', { confirm() {
    switched.ctx.getCurrentChatId = () => 'chat-2';
    return 'always';
  } });
  assert.ok(stopped.aborted);
  assert.match(switched.worldbooks.设定集[0].content, /人口十万/);
  const revoked = makeHost({ replies: [write, '结束。'] });
  const denied = await revoked.agent.run('修改当前卡', { confirm() {
    revoked.agent.saveSettings({ mode: 'readonly' });
    return 'allow';
  } });
  assert.ok(denied.steps[0].denied);
  assert.match(revoked.worldbooks.设定集[0].content, /人口十万/);
});

test('撤销：插件部分写入后抛错仍保留写后镜像，外部后续修改按冲突处理', async () => {
  const { agent, vfs } = makeHost({ replies: [call('toolbox', { name: 'example' }), call('partial_write', {}), '结束。'] });
  const path = 'ws:/note.md';
  await vfs.write(path, '原稿');
  agent.registerTool({ name: 'partial_write', toolset: 'example', effect: 'write', scope: 'workspace', paths: () => [path],
    async run() {
      await vfs.write(path, '更新');
      throw new Error('未完成其余更新');
    } });
  const report = await agent.run('分步更新');
  assert.equal(report.steps[1].ok, false);
  await vfs.write(path, '后续修改');
  const undo = await agent.undo(report.runId);
  same(undo.conflicts.map((item) => item.path), [path]);
  assert.equal(await vfs.readText(path), '后续修改');
});
