/*
 * 分卷导演（Volume Director）的 Node 测试。
 *   node --test tests/director.test.mjs
 * 六组场景：
 *   1. Skill 的优先级与切片      2. 楼层锚点与快照环        3. 三级偏移路由与静态前缀
 *   4. 完结双保险与归档分流      5. 提示词槽位与独立运行    6. 世界书模板与权限
 * 纯逻辑（director-core.js / director-wb.js）单独装进一个 vm 上下文直接测；运行器（director.js）用整包 + mock 酒馆 +
 * 按提示词内容分流的脚本化模型来测。没覆盖：真实酒馆、IndexedDB（走内存退路）、导演页与状态浮窗的 DOM。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EXT_MODULES, AGENT_MODULES, DEFAULTS_MODULE, DIRECTOR_SKILL_HEADINGS, bundle, defaultsModule, inlineDefaults, skillHeadings } from '../build.mjs';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等不到：' + label);
    await sleep(5);
  }
}

const SKILL = read('knowledge/volume-director/SKILL.md');
const CODE = bundle(EXT_MODULES);

/* ---------- 纯逻辑 ---------- */
function loadCore() {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  for (const file of ['src/reader-env.js', 'src/agent/kernel.js', 'src/agent/director-core.js', 'src/agent/director-wb.js']) {
    vm.runInContext(read(file), ctx, { filename: file });
  }
  return ctx.__ReaderIIModules;
}
const M = loadCore();
const core = M.directorCore;
const wbCore = M.directorWorldbook;

/* ---------- 样例：大纲、简报、模型的回复 ---------- */
const HIDDEN = '灯塔的旧账本其实被莫师傅藏在了钟楼的夹层里，他是为了替死去的徒弟瞒下一笔亏空。';
const CLOCK = '第三天傍晚，港务司会来清点灯塔的库房；雨停之前渡船不开。';
const OUTLINE = [
  '### 板块 A：全景勘察与卷核定性',
  '旧港的雨季。林渡在艾琳的酒馆落脚修钟，镇上的灯塔换了看守。',
  '### 板块 B：核心人物与独立关系网',
  '- [既有] 艾琳：酒馆老板娘，记账一丝不苟，嘴硬心软。',
  '- [新增] 莫师傅：钟楼的老匠人，耳背，爱把零件揣在围裙里。',
  '- [新增] 港务司书记：只在清点那天露面的小吏。',
  '### 板块 C：后台实情与客观时钟',
  '**后台完整实情**：' + HIDDEN,
  '**客观推进时钟**：' + CLOCK,
  '### 板块 D：分阶段动态推演',
  '#### Phase 1：雨夜来客',
  '灯塔的新看守冒雨来酒馆打听修钟的人。',
  '#### Phase 2：钟楼的夹层',
  '林渡上钟楼校时，莫师傅守着楼梯不肯让开。',
  '#### Phase 3：清点之日',
  '港务司的人到了，账本的去向摆上桌面。',
  '### 板块 E：收束形态与跨卷钩子库',
  '多元收束：账本归还，或由林渡代为保管。钩子：莫师傅徒弟留下的一只怀表。',
].join('\n');
const OUTLINE_V2 = OUTLINE.replace('#### Phase 1：雨夜来客', '#### Phase 1：渡口改道').replace('#### Phase 2：钟楼的夹层', '#### Phase 2：对岸的钟').replace('\n#### Phase 3：清点之日\n港务司的人到了，账本的去向摆上桌面。', '');
const INDEX = {
  title: '雨季的钟',
  phases: [{ n: 1, title: '雨夜来客' }, { n: 2, title: '钟楼的夹层' }, { n: 3, title: '清点之日' }],
  new_characters: [
    { name: '莫师傅', kind: 'npc', brief: '钟楼的老匠人，耳背', keywords: ['莫师傅', '老莫'] },
    { name: '港务司书记', kind: 'temp_event', brief: '清点那天露面的小吏', keywords: ['书记'] },
  ],
};
const brief = (tag) => [
  '【当前阶段与承接】' + tag + '。{{user}}刚在酒馆坐下，门外有人收伞。',
  '【在场角色意图（仅表现层）】艾琳照常擦杯子，对<user>多看了一眼。',
  '【本轮细节与暗压】柜台上的座钟慢了七分钟。',
  '【节奏与情绪红线】不要快进到钟楼；留给玩家决定要不要搭话。',
  '【本轮防 AI 味忌口】禁止写「眼底闪过一丝算计」；禁止替玩家做决定。',
].join('\n');
const delivery = (outline, index, firstBrief, note = '') => (note ? `<restructure_note>${note}</restructure_note>\n` : '<self_check>\n1. 通过\n</self_check>\n')
  + `<volume_outline>\n${outline}\n</volume_outline>\n<volume_index>\n${JSON.stringify(index)}\n</volume_index>\n<first_brief>\n${firstBrief}\n</first_brief>`;
const judge = (fields = {}) => JSON.stringify({
  drift_level: 0, reason: '顺着雨夜的节奏走', phase_cursor: 1, state_delta: '新看守进了门，还没开口', facts_add: [], local_patch: '',
  next_brief: brief('下一轮'), volume_completed: false, ...fields,
});
const ENTRY_NPC = '<reader_entry_name>莫师傅</reader_entry_name>\n<reader_content>\n基本信息:\n  姓名: 莫师傅\n  身份: 钟楼的老匠人，守了四十年的钟。\n背景:\n  现状: 每天清晨上钟楼校时，耳背，说话嗓门大。\n性格:\n  核心: 倔，护短，嘴上不饶人。认定的事八匹马拉不回，对徒弟的事绝口不提。\n语言风格:\n  语气: 短句，带旧港的土话，常把「啥」挂在嘴边。\n</reader_content>\n<reader_primary_keywords>\n莫师傅\n老莫\n</reader_primary_keywords>\n<reader_secondary_keywords></reader_secondary_keywords>';
const ENTRY_TEMP = '<reader_entry_name>港务司书记</reader_entry_name>\n<reader_content>\n名称: 港务司书记\n定位: 清点那天带着册子来的小吏，只认条文。\n样子: 灰呢制服，袖口磨得发亮，腋下夹一本硬皮册子。\n言行: 说话先清嗓子，问一句记一笔。\n与主角: 公事公办，对林渡没有成见。\n</reader_content>\n<reader_primary_keywords>\n书记\n</reader_primary_keywords>\n<reader_secondary_keywords></reader_secondary_keywords>';
const ARCHIVE = JSON.stringify({ title: '雨季的钟', summary: '账本的去向摆上了桌面，莫师傅把怀表交给了林渡。', hooks: ['莫师傅徒弟留下的怀表', '港务司的旧册子少了一页'], entries: [{ name: '莫师傅', keep: true, why: '结下了交情' }] });

/* 按提示词的内容分流的脚本化模型：不靠调用顺序，测试里换一种回复只要改对应的那一项。 */
function scriptedModel(replies = {}) {
  const calls = [];
  const table = {
    plan: delivery(OUTLINE, INDEX, brief('Phase 1 · 雨夜')),
    judge: judge(),
    restructure: delivery(OUTLINE_V2, { title: '雨季的钟', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] }, brief('重构后的 Phase 1'), '玩家提前渡河，原定的钟楼冲突不再成立'),
    archive: ARCHIVE,
    entry_npc: ENTRY_NPC,
    entry_temp: ENTRY_TEMP,
    ...replies,
  };
  function classify(prompts) {
    const system = String(prompts[0].content), last = String(prompts.at(-1).content);
    const allUser = prompts.slice(1).map((m) => String(m.content || '')).join('\n');
    if (system.includes('分卷导演 · 场记')) return 'judge';
    if (system.includes('正在给刚刚落幕的这一卷归档')) return 'archive';
    if (system.includes('通用世界书条目编写器')) return last.includes('一次性的龙套') ? 'entry_temp' : 'entry_npc';
    if (allUser.includes('## 结构重构')) return 'restructure';
    if (allUser.includes('## 编纲与交付任务')) return 'plan';
    return 'other';
  }
  async function handler(config) {
    const prompts = plain(config.ordered_prompts);
    const kind = classify(prompts);
    const call = { kind, prompts, system: String(prompts[0].content), last: String(prompts.at(-1).content) };
    calls.push(call);
    let reply = table[kind];
    if (Array.isArray(reply)) reply = reply.length > 1 ? reply.shift() : reply[0];
    if (typeof reply === 'function') reply = await reply(call, calls);
    if (reply instanceof Error) throw reply;
    return reply === undefined ? '（没有脚本化的回复：' + kind + '）' : reply;
  }
  return { calls, table, handler, of: (kind) => calls.filter((call) => call.kind === kind) };
}

const EVENTS = ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED',
  'MESSAGE_DELETED', 'MESSAGE_EDITED', 'CHAT_CHANGED', 'WORLDINFO_ENTRIES_LOADED', 'GENERATE_AFTER_DATA', 'CHAT_COMPLETION_SETTINGS_READY',
  'CHAT_COMPLETION_PROMPT_READY', 'GENERATE_AFTER_COMBINE_PROMPTS'];

/* mock 酒馆 + mock 酒馆助手；事件源是真的能发事件的。options: { replies, chat, agentSettings, directorSettings, storage, readerOff, debounceMs, fetch } */
function makeHost(options = {}) {
  const model = scriptedModel(options.replies);
  const chat = options.chat || [
    { name: '艾琳', is_user: false, mes: '「欢迎回来。」艾琳放下了手里的杯子。' },
    { name: '林渡', is_user: true, mes: '我推开了酒馆的门，把工具箱搁在柜台上。' },
    { name: '艾琳', is_user: false, mes: '雨水顺着门檐落下来，她递来一条干毛巾。' },
  ];
  const worldbooks = { 设定集: [{ uid: 0, name: '旧港', enabled: true, content: '旧港在北岸，雨季很长。', strategy: { type: 'constant', keys: [] }, position: { order: 100 } }] };
  const mounted = { additional: [] };
  const storage = new Map(Object.entries(options.storage || {}).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const listeners = new Map();
  const eventSource = {
    on(name, handler) { listeners.set(name, [...(listeners.get(name) || []), handler]); },
    makeLast(name, handler) { this.on(name, handler); },
    removeListener(name, handler) { listeners.set(name, (listeners.get(name) || []).filter((fn) => fn !== handler)); },
    async emit(name, ...args) { for (const fn of listeners.get(name) || []) await fn(...args); },
  };
  const metadata = { variables: {} };
  if (options.readerOff !== false) metadata.reader_ii_enabled = false;   /* 默认：这张卡没启用 Reader-II，导演独立运行 */
  const ctx = {
    chat, characterId: 0, name1: '林渡', name2: '艾琳', chatId: 'chat-1',
    characters: [{ name: '艾琳', avatar: 'ailin.png', description: '旧港酒馆的老板娘。', data: { description: '旧港酒馆的老板娘。', extensions: {} } }],
    chatMetadata: metadata, extensionSettings: {}, powerUserSettings: { persona_description: '走街串巷的修表匠，话不多。' },
    getCurrentChatId: () => ctx.chatId, saveMetadata: async () => {}, saveSettingsDebounced: () => {}, saveChat: async () => {},
    setExtensionPrompt: () => {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    eventSource, eventTypes: Object.fromEntries(EVENTS.map((name) => [name, name])),
  };
  const helper = {
    getWorldbookNames: () => Object.keys(worldbooks),
    getGlobalWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: '设定集', additional: mounted.additional.slice() }),
    getChatWorldbookName: () => null,
    getWorldbook: async (name) => plain(worldbooks[name]),
    createWorldbook: async (name) => { worldbooks[name] = []; },
    rebindCharWorldbooks: async (_which, books) => { mounted.additional = books.additional.slice(); },
    updateWorldbookWith: async (name, updater) => { worldbooks[name] = plain(updater(plain(worldbooks[name]))); return plain(worldbooks[name]); },
    createWorldbookEntries: async (name, entries) => {
      const made = entries.map((entry, index) => ({ uid: worldbooks[name].length + index + 10, enabled: true, strategy: { type: 'selective', keys: [] }, position: {}, ...entry }));
      worldbooks[name].push(...made);
      return { new_entries: plain(made) };
    },
    getVariables: () => ({}),
    generateRaw: (config) => model.handler(config),
  };
  const host = {
    SillyTavern: { getContext: () => ctx }, TavernHelper: helper,
    localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    console: { log() {}, info() {}, warn() {}, error() {} },
    toastr: { warning: (text) => host.__toasts.push(text) }, __toasts: [],
    document: { querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }), body: { appendChild() {} }, head: { appendChild() {} } },
    navigator: { userAgent: 'node-test' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    fetch: options.fetch || (async () => { throw new Error('离线'); }),
    Function, setTimeout, clearTimeout, AbortController, crypto: globalThis.crypto,
    __READER_II_NO_AUTOBOOT__: true,
  };
  host.window = host;
  host.parent = host;
  if (options.agentSettings || options.directorSettings) {
    ctx.extensionSettings.reader_ii = { ...(options.agentSettings ? { agent: options.agentSettings } : {}), ...(options.directorSettings ? { director: options.directorSettings } : {}) };
  }
  vm.createContext(host);
  vm.runInContext(CODE, host, { filename: 'reader-ii.ext.js' });
  const modules = host.__ReaderIIModules;
  const createDirector = modules.createDirector;
  modules.createDirector = (env, kit, llm, deps) => createDirector(env, kit, llm, Object.assign({}, deps, { debounceMs: options.debounceMs ?? 5 }));
  modules.bootReaderII();
  const api = host.ReaderII;
  const h = {
    host, api, modules, ctx, chat, worldbooks, mounted, storage, model, director: api.director, agent: api.agent, vfs: api.vfs,
    emit: (name, ...args) => eventSource.emit(name, ...args),
    readJson: async (path) => { const text = await api.vfs.readText(path); return text ? JSON.parse(text) : null; },
    dir: () => 'ws:/director/chats/' + core.hashId(JSON.stringify(['card:ailin.png', String(ctx.chatId)])),
    /* 演一个回合：用户发言 → AI 回复 → 酒馆的生成结束事件 → 等后台巡检跑完。judges 是这一回合预期多出来的场记调用数。 */
    async turn(userText, aiText, judges = 1) {
      const before = model.of('judge').length;
      await eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
      chat.push({ name: '林渡', is_user: true, mes: userText });
      chat.push({ name: '艾琳', is_user: false, mes: aiText });
      await eventSource.emit('MESSAGE_RECEIVED', chat.length - 1);
      await eventSource.emit('GENERATION_ENDED', chat.length - 1);
      if (judges > 0) await until(() => model.of('judge').length >= before + judges && !api.director.getStatus().work, '后台巡检');
      else await sleep(40);
    },
    dispose() { try { api.dispose(); } catch { /* ignore */ } },
  };
  return h;
}

/* 开一卷并等它定稿。 */
async function activated(options = {}) {
  const h = makeHost(options);
  await h.director.ready();
  const result = await h.director.activate(options.activate);
  assert.deepEqual(plain(result), { done: true });
  return h;
}

/* ========================================================================================================
 * 1. Skill 的优先级与切片
 * ====================================================================================================== */

test('构建把导演 Skill 与通用角色条目模板内联进扩展包，标题表与运行时一致', () => {
  assert.deepEqual(plain(core.REQUIRED_HEADINGS), DIRECTOR_SKILL_HEADINGS);
  for (const heading of DIRECTOR_SKILL_HEADINGS) assert.ok(skillHeadings(SKILL).includes(heading), heading);
  assert.ok(AGENT_MODULES.indexOf(DEFAULTS_MODULE) < AGENT_MODULES.indexOf('src/agent/skills.js'), '内联资料要先于知识库加载');
  assert.ok(AGENT_MODULES.indexOf('src/agent/kernel.js') < AGENT_MODULES.indexOf('src/agent/jobs.js'));
  for (const [before, after] of [['src/agent/agent.js', 'src/agent/director-core.js'], ['src/agent/director-core.js', 'src/agent/director-wb.js'],
    ['src/agent/director-wb.js', 'src/agent/director.js'], ['src/agent/director.js', 'src/agent/ui-theme.js'], ['src/agent/ui-float.js', 'src/agent/ui.js'],
    ['src/agent/ui-director.js', 'src/agent/ui.js'], ['src/agent/ui.js', 'src/agent/boot.js']]) {
    assert.ok(AGENT_MODULES.indexOf(before) >= 0 && AGENT_MODULES.indexOf(before) < AGENT_MODULES.indexOf(after), before + ' → ' + after);
  }
  const ctx = vm.createContext({});
  vm.runInContext(defaultsModule(), ctx);
  const inlined = ctx.__ReaderIIModules;
  assert.equal(inlined.READER_BUILTIN_SKILLS['volume-director'], SKILL);
  assert.equal(inlined.READER_DEFAULT_ENTRY_TEMPLATE.id, 'reader-default-generic-character');
  assert.ok(inlined.READER_DEFAULT_ENTRY_TEMPLATE.templateText.includes('基本信息:') && inlined.READER_DEFAULT_ENTRY_TEMPLATE.output.targetWorldbook);
  /* 正文里即使写了 </script，嵌进页面也不会提前结束脚本；少了必需的标题，构建直接报错。 */
  const defaults = inlineDefaults();
  assert.doesNotMatch(defaultsModule({ skills: { x: '</script><b>' }, template: defaults.template }), /<\/script/i);
  assert.equal(skillHeadings('## 甲\n```md\n## 代码块里的不算\n```\n## 乙').join('|'), '## 甲|## 乙');
});

test('Skill 按用途切片：编纲、运行期、归档、建档各取所需', () => {
  const planner = core.sliceDirectorSkillDetailed(SKILL, 'planner');
  assert.deepEqual(plain([planner.degraded, planner.missing]), [false, []]);
  for (const part of ['# 单卷群像导演', '## 最高原则', '## 阶段一', '## 阶段二', '## 阶段三', '## 阶段四', '## 阶段六']) assert.ok(planner.text.includes(part), part);
  assert.ok(!planner.text.includes('## 阶段五') && !planner.text.includes('三级偏移判定'), '编纲不带运行期协议');
  assert.ok(!/^---\nname:/.test(planner.text), '去掉 frontmatter');

  const runtime = core.sliceDirectorSkillDetailed(SKILL, 'runtime');
  assert.equal(runtime.degraded, false);
  assert.ok(runtime.text.includes('## 最高原则') && runtime.text.includes('## 阶段五') && runtime.text.includes('三级偏移判定'));
  assert.ok(!runtime.text.includes('## 阶段三') && !runtime.text.includes('## 阶段四') && !runtime.text.includes('## 阶段六'));
  const redlines = runtime.text.slice(runtime.text.indexOf('## 红线速记')).split('\n').filter((line) => /^\d+\. 严禁/.test(line));
  assert.equal(redlines.length, 10, '十条红线只留标题');
  assert.ok(runtime.text.length < planner.text.length / 2, '运行期切片要比编纲切片小得多');

  const archive = core.sliceDirectorSkillDetailed(SKILL, 'archive');
  assert.equal(archive.degraded, false);
  assert.ok(archive.text.includes('丙、完结判定与资产沉淀协议') && archive.text.includes('已完结卷档案'));
  assert.ok(!archive.text.includes('三级偏移判定') && !archive.text.includes('## 阶段') && archive.text.length < 900);

  const worldbook = core.sliceDirectorSkillDetailed(SKILL, 'worldbook');
  assert.ok(worldbook.text.length < 400 && /严禁写进后台尚未揭晓的秘密/.test(worldbook.text));
  assert.equal(worldbook.text, core.sliceDirectorSkill('随便什么', 'worldbook'), '建档提示是固定的');
});

test('Skill 的标题缺失时平滑降级；用户自己加的段进编纲，不进运行期', () => {
  const noStage4 = SKILL.replace('## 阶段四：单卷动态大纲产出规范', '## 大纲规范（我改了标题）');
  const noStage5 = SKILL.replace('## 阶段五：后台运行期执导协议（适用于多轮互动实时导演）', '## 运行期');
  /* 拿不到内置正文（单独加载 director-core 的环境）时才退回整篇照发。 */
  const bare = core.sliceDirectorSkillDetailed(noStage4, 'planner');
  assert.deepEqual(plain([bare.degraded, bare.missing, bare.filled]), [true, ['阶段四'], []]);
  assert.ok(bare.text.includes('## 阶段五'), '没有内置正文可补时整篇照发');
  /* 扩展包里有内置 Skill：缺的段用内置的同名段补上。 */
  M.READER_BUILTIN_SKILLS = { 'volume-director': SKILL };
  try {
    const planner = core.sliceDirectorSkillDetailed(noStage4, 'planner');
    assert.equal(planner.degraded, true);
    assert.deepEqual(plain([planner.missing, planner.filled]), [['阶段四'], ['阶段四']]);
    assert.ok(planner.text.includes('## 阶段四：单卷动态大纲产出规范'), '缺的段用内置 Skill 的同名段补上');
    assert.ok(planner.text.includes('## 大纲规范（我改了标题）'), '改了标题认不出的那段仍作为自定义段带上');
    assert.ok(!planner.text.includes('## 阶段五') && !planner.text.includes('三级偏移判定'), '降级也不把运行期协议塞给总导演');
    assert.equal(core.sliceDirectorSkillDetailed(noStage4, 'runtime').degraded, false, '运行期用不到阶段四');

    const runtime = core.sliceDirectorSkillDetailed(noStage5, 'runtime');
    assert.deepEqual(plain([runtime.degraded, runtime.missing, runtime.filled]), [true, ['阶段五'], ['阶段五']]);
    assert.ok(runtime.text.includes('## 阶段五') && runtime.text.includes('三级偏移判定'), '运行期缺阶段五时用内置的补上');
    assert.ok(!runtime.text.includes('## 阶段一') && !runtime.text.includes('## 阶段四'), '降级也不把编纲阶段塞给场记');
  } finally { delete M.READER_BUILTIN_SKILLS; }
  const archive = core.sliceDirectorSkillDetailed(noStage5, 'archive');
  assert.equal(archive.degraded, true);
  assert.ok(archive.text.length < 700 && !archive.text.includes('## 阶段一') && archive.text.includes('已完结卷档案'), '归档绝不回退全文');

  /* 标题只改了后半句：照样切得开。红线读不出三条时用内置的速记。 */
  const renamed = SKILL.replace('## 阶段二：十条 AI 弊病绝杀红线（针对抽象劣质特质，不限题材）', '## 阶段二：我的红线').replace(/^\d+\. \*\*严禁.*\*\*$/gm, '（删掉了）');
  const fallback = core.sliceDirectorSkillDetailed(renamed, 'runtime');
  assert.equal(fallback.degraded, false);
  assert.match(fallback.text, /1\. 严禁为剧情量身定做的塑料道具、机制与体质/);
  assert.equal(core.sliceDirectorSkillDetailed(renamed, 'planner').degraded, false);

  const extended = SKILL + '\n\n---\n\n## 我的补充规则\n每卷至少一场吃饭的戏。\n\n```md\n## 代码块里的标题不是新的一段\n```\n';
  const withExtra = core.sliceDirectorSkillDetailed(extended, 'planner');
  assert.equal(withExtra.degraded, false);
  assert.ok(withExtra.text.includes('## 我的补充规则') && withExtra.text.includes('每卷至少一场吃饭的戏') && withExtra.text.includes('## 代码块里的标题不是新的一段'));
  assert.ok(!core.sliceDirectorSkill(extended, 'runtime').includes('我的补充规则'));
  assert.equal(core.splitSkill(extended).sections.filter((section) => section.title === '我的补充规则').length, 1);
});

test('工作区里的 Skill 覆盖内置的，改动当场生效；删掉或恢复默认回到内置；离线时内置正文来自内联', async () => {
  const h = makeHost();
  try {
    const builtin = await h.director.getSkill();
    assert.equal(builtin.source, 'builtin');
    assert.equal(builtin.text, SKILL, '离线（fetch 一律失败）时读到的是随包内联的正文');
    assert.equal(builtin.degraded, false);
    const mine = SKILL.replace('# 单卷群像导演 · 叙事创作与动态执导协议', '# 我改过的导演手册');
    const saved = await h.director.saveSkill(mine);
    assert.deepEqual([saved.source, saved.text.includes('# 我改过的导演手册')], ['user', true]);
    /* 知识库（助手读的 kb:/）跟着热重载：vfs.onWrite → skills.reload。 */
    await until(async () => String(await h.vfs.readText('kb:/volume-director/SKILL.md')).includes('# 我改过的导演手册'), '知识库热重载');

    /* 不经过导演，直接删工作区里的文件：导演与知识库都回到内置。 */
    await h.vfs.remove('ws:/skills/volume-director/SKILL.md');
    await until(async () => (await h.director.getSkill()).source === 'builtin', '删文件后回到内置');
    await until(async () => String(await h.vfs.readText('kb:/volume-director/SKILL.md')).includes('# 单卷群像导演 · 叙事创作与动态执导协议'), '知识库回到内置');

    await h.director.saveSkill(mine);
    const reset = await h.director.resetSkill();
    assert.deepEqual([reset.source, reset.text], ['builtin', SKILL]);
    assert.equal(await h.vfs.readText('ws:/skills/volume-director/SKILL.md'), null);
    await assert.rejects(() => h.director.saveSkill('   '), /不能是空的/);

    /* 用户改坏了标题：导演照常能用，并把缺了哪一段说出来。 */
    const broken = await h.director.saveSkill(SKILL.replace('## 阶段五：', '## 第五阶段：'));
    assert.equal(broken.degraded, true);
    assert.ok(plain(broken.missing).includes('阶段五'));
  } finally { h.dispose(); }
});

/* ========================================================================================================
 * 2. 楼层锚点与快照环
 * ====================================================================================================== */

const floors = (...texts) => texts.map((text, index) => ({ name: index % 2 ? '林渡' : '艾琳', is_user: index % 2 === 1, mes: text }));
function snap(view, floor, fields = {}) {
  return core.makeSnapshot(core.anchorOf(view, floor), { outlineVersion: 1, kind: 'patrol', state: { ...core.initialState(), turn: view.turns(floor) }, brief: '简报@' + floor, ...fields });
}

test('注入锚点：常规取最新一楼；重掷、续写与末楼是 AI 的重新生成排除待替换的那一楼', () => {
  const chat = floors('开场', '用户一', '回复一', '用户二', '回复二');
  const view = core.createChatView(chat);
  assert.deepEqual(plain(core.injectionAnchor(view, 'normal')), { maxFloor: 4, floor: 4, excluded: -1, type: 'normal' });
  for (const type of ['swipe', 'continue', 'regenerate']) {
    assert.deepEqual(plain(core.injectionAnchor(view, type)), { maxFloor: 3, floor: 2, excluded: 4, type }, type);
  }
  /* 末楼是用户发言时的重新生成：没有要被替换的 AI 楼，按常规取。 */
  const waiting = core.createChatView(chat.slice(0, 4));
  assert.deepEqual(plain(core.injectionAnchor(waiting, 'regenerate')), { maxFloor: 3, floor: 2, excluded: -1, type: 'regenerate' });
  /* 隐藏楼层不算；回合 = 一段连续的 AI 楼（群聊里几个角色接连回复算一个回合）。 */
  const group = core.createChatView([{ mes: '开场' }, { mes: '用户', is_user: true }, { mes: '甲' }, { mes: '乙' }, { mes: '系统提示', is_system: true }]);
  assert.deepEqual([group.lastVisible(), group.lastAssistant(), group.turns(), group.turns(1)], [3, 3, 2, 1]);
  assert.deepEqual(plain(core.injectionAnchor(group, 'swipe')), { maxFloor: 2, floor: 2, excluded: 3, type: 'swipe' });
});

test('快照按楼层指纹取用：重掷、切回、删楼、改楼各自对得上；别的扩展补写的块不影响指纹', () => {
  const chat = floors('开场', '用户一', '回复一', '用户二', '回复二');
  let view = core.createChatView(chat);
  let snaps = core.emptySnapshots();
  snaps.base = snap(view, 0, { kind: 'base', brief: '开卷简报' });
  snaps = core.pushSnapshot(snaps, snap(view, 2));
  snaps = core.pushSnapshot(snaps, snap(view, 4));
  const at = (type) => { const v = core.createChatView(chat); const a = core.injectionAnchor(v, type); return core.pickSnapshot(snaps, v, a.maxFloor); };

  assert.equal(at('normal').entry.brief, '简报@4');
  /* 重掷第 4 楼：被拒的旧回复还在聊天末尾，但不能拿它的快照来指导重写它自己。 */
  assert.equal(at('swipe').entry.brief, '简报@2');
  assert.equal(at('regenerate').entry.brief, '简报@2');
  assert.equal(at('continue').entry.brief, '简报@2');

  /* 重掷出了新正文：第 4 楼的旧快照对不上了，常规生成退回第 2 楼的。 */
  chat[4].mes = '回复二（第二页）';
  assert.deepEqual([at('normal').entry.brief, at('normal').forked], ['简报@2', false]);
  view = core.createChatView(chat);
  snaps = core.pushSnapshot(snaps, snap(view, 4, { brief: '简报@4·第二页' }));
  assert.equal(at('normal').entry.brief, '简报@4·第二页');
  assert.equal(snaps.ring.filter((entry) => entry.floor === 4).length, 2, '同一楼不同 Swipe 的快照互不删除');
  /* 切回第一页：原来那条又对上了。 */
  chat[4].mes = '回复二';
  assert.equal(at('normal').entry.brief, '简报@4');
  /* 同一楼、同一份正文再存一次：顶替旧的，不重复。 */
  snaps = core.pushSnapshot(snaps, snap(core.createChatView(chat), 4, { brief: '简报@4·更新' }));
  assert.equal(snaps.ring.filter((entry) => entry.floor === 4).length, 2);
  assert.equal(at('normal').entry.brief, '简报@4·更新');

  /* 别的扩展在收楼后往正文里补写变量块、事件块、思维链：指纹不变。 */
  chat[4].mes = '<think>想一想</think>回复二<UpdateVariable>金币+1</UpdateVariable><READER_FP_EVENT>{"x":1}</READER_FP_EVENT>';
  assert.equal(at('normal').entry.brief, '简报@4·更新');
  chat[4].mes = '回复二';

  /* 删楼：退到留下来的最后一楼的状态。 */
  const removed = chat.splice(3, 2);
  assert.equal(at('normal').entry.brief, '简报@2');
  chat.push(...removed);
  /* 改了第 2 楼：它自己和把它算进前文的第 4 楼都落空，退回基线；改回去又都对上。 */
  chat[2].mes = '回复一（改过）';
  assert.deepEqual([at('normal').entry.brief, at('normal').source, at('normal').forked], ['开卷简报', 'base', false]);
  chat[2].mes = '回复一';
  assert.equal(at('normal').entry.brief, '简报@4·更新');
  /* 连基线那一楼都变了：这段聊天与记录不是同一条线。 */
  chat[0].mes = '另一条线的开场';
  assert.deepEqual([at('normal').forked, at('normal').source], [true, 'base']);
  /* 聊天还没有 AI 楼时立的基线什么时候都算数。 */
  const empty = core.emptySnapshots();
  empty.base = core.makeSnapshot(core.anchorOf(core.createChatView([]), -1), { kind: 'base', brief: '白板开卷' });
  assert.deepEqual([core.pickSnapshot(empty, core.createChatView(chat), 4).entry.brief, core.pickSnapshot(empty, core.createChatView(chat), 4).forked], ['白板开卷', false]);
});

test('快照环留最近 20 条；大纲按版本留存，删楼越过重构时取回上一版', () => {
  const texts = ['开场'];
  for (let i = 1; i <= 30; i += 1) texts.push('用户' + i, '回复' + i);
  const chat = floors(...texts);
  const view = core.createChatView(chat);
  let snaps = core.emptySnapshots();
  assert.equal(core.addVersion(snaps, { outline: OUTLINE, index: core.normalizeIndex(INDEX, OUTLINE), note: '首次编纲' }), 1);
  snaps.base = snap(view, 0, { kind: 'base' });
  for (let floor = 2; floor <= 20; floor += 2) snaps = core.pushSnapshot(snaps, snap(view, floor));
  /* 第 20 楼之后发生了结构重构：大纲第 2 版。 */
  assert.equal(core.addVersion(snaps, { outline: OUTLINE_V2, index: core.normalizeIndex(null, OUTLINE_V2), note: '重构' }), 2);
  for (let floor = 22; floor <= 60; floor += 2) snaps = core.pushSnapshot(snaps, snap(view, floor, { outlineVersion: 2 }));
  assert.equal(snaps.ring.length, core.RING_LIMIT);
  assert.equal(snaps.ring[0].floor, 22, '最旧的先丢');
  assert.deepEqual(Object.keys(snaps.versions).sort(), ['1', '2'], '基线还引用着第 1 版，不能删');

  /* 再重构两次：没人引用、也不在最新两版里的版本被清掉；基线引用的第 1 版一直留着。 */
  core.addVersion(snaps, { outline: 'v3', index: null });
  core.addVersion(snaps, { outline: 'v4', index: null });
  snaps = core.pushSnapshot(snaps, snap(view, 60, { outlineVersion: 4 }));
  assert.deepEqual(Object.keys(snaps.versions).sort(), ['1', '2', '3', '4']);
  snaps.ring = snaps.ring.filter((entry) => entry.outlineVersion !== 2);
  core.addVersion(snaps, { outline: 'v5', index: null });
  core.pruneVersions(snaps);
  assert.deepEqual(Object.keys(snaps.versions).sort(), ['1', '4', '5']);

  /* 跨重构回滚：第 3 楼判成第 1 版、第 5 楼重构成第 2 版；把第 4、5 楼删掉，取到的快照指回第 1 版大纲。 */
  const small = floors('开场', '用户一', '回复一', '用户二', '回复二');
  const v = core.createChatView(small);
  let two = core.emptySnapshots();
  core.addVersion(two, { outline: OUTLINE, index: core.normalizeIndex(INDEX, OUTLINE) });
  two.base = snap(v, 0, { kind: 'base' });
  two = core.pushSnapshot(two, snap(v, 2));
  core.addVersion(two, { outline: OUTLINE_V2, index: core.normalizeIndex(null, OUTLINE_V2) });
  two = core.pushSnapshot(two, snap(v, 4, { outlineVersion: 2, kind: 'restructure' }));
  assert.equal(core.pickSnapshot(two, v, 4).entry.outlineVersion, 2);
  const rolled = core.createChatView(small.slice(0, 3));
  const picked = core.pickSnapshot(two, rolled, rolled.lastVisible());
  assert.deepEqual([picked.entry.outlineVersion, picked.entry.floor], [1, 2]);
  assert.equal(two.versions[picked.entry.outlineVersion].outline, OUTLINE);
});

test('导演的活互斥：编纲在跑时不能再开卷、巡检或重构；停下之后断点草稿留着，可以续编', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = makeHost({ replies: { plan: async () => { await gate; return delivery(OUTLINE, INDEX, brief('Phase 1 · 雨夜')); } } });
  try {
    await h.director.ready();
    const running = h.director.activate();
    await until(() => h.model.of('plan').length === 1, '编纲开始请求模型');
    assert.deepEqual([h.director.getStatus().state, h.director.getStatus().work.kind], ['planning', 'plan']);
    await assert.rejects(() => h.director.activate(), /正在编纲/);
    await assert.rejects(() => h.director.patrolNow(), /没有正在执导的分卷/);
    assert.equal(h.api.jobs.list().filter((job) => job.owner === 'director' && job.state === 'running').length, 1, '看板上只有一张牌子');
    assert.equal(h.agent.isBusy(), false, '导演有自己的锁，不占助手主循环的');

    /* 暂停：立刻掐掉当前请求，断点草稿存盘。 */
    assert.equal(await h.director.pause(), 'plan');
    release();
    assert.deepEqual(plain(await running), { paused: true });
    const draft = await h.readJson(h.dir() + '/draft.json');
    assert.deepEqual([draft.v, draft.mode, draft.state, draft.messages.length], [2, 'auto', 'paused', 1]);
    assert.ok(draft.materials.includes('近期正文') && draft.materials.includes('旧港'), '勘察地图存在草稿里，续接时不必重来');
    assert.deepEqual([h.director.getStatus().state, h.director.getStatus().plan.state, h.director.getStatus().plan.hasCheckpoint], ['draft', 'paused', true]);
    assert.equal(await h.readJson(h.dir() + '/active.json'), null, '没定稿就没有活跃卷');

    /* 接着编：直接沿断点继续，完成定稿并清理草稿。 */
    h.model.table.plan = delivery(OUTLINE, INDEX, brief('Phase 1 · 雨夜'));
    assert.deepEqual(plain(await h.director.resume()), { done: true });
    assert.equal(h.director.getStatus().state, 'running');
    assert.equal(await h.readJson(h.dir() + '/draft.json'), null, '定稿之后草稿与探索会话立刻清空');
  } finally { h.dispose(); }
});

/* ========================================================================================================
 * 3. 三级偏移路由与静态前缀
 * ====================================================================================================== */

test('判定解析与状态迁移：L0 只推进，L1 留补丁不动大纲，L2 交给重构；冷却期内的 L2 降成 L1', () => {
  const index = core.normalizeIndex(INDEX, OUTLINE);
  const parsed = core.parseVerdict('好的，判定如下：\n```json\n' + judge({ drift_level: 'L1', phase_cursor: '2', facts_add: ['林渡没接毛巾'], local_patch: '艾琳改从后门送他上钟楼' }) + '\n```');
  assert.equal(parsed.ok, true);
  assert.deepEqual([parsed.verdict.drift_level, parsed.verdict.phase_cursor, parsed.verdict.volume_completed], [1, 2, false]);
  assert.equal(core.parseVerdict('我觉得没问题').ok, false);
  assert.match(core.parseVerdict('{"drift_level":0}').error, /next_brief/);
  assert.match(core.parseVerdict('{"next_brief":"x"}').error, /drift_level/);
  assert.equal(core.parseVerdict('{"drift_level":2,"reason":"掀桌"}').ok, true, 'L2 可以没有简报：马上要重构');

  const start = { ...core.initialState(), turn: 3 };
  const l0 = core.applyVerdict(start, core.parseVerdict(judge({ facts_add: ['新看守进了门'] })).verdict, index, { turn: 4, l2Cooldown: 2 });
  assert.deepEqual([l0.level, l0.restructure, l0.state.phaseCursor, l0.state.patches.length, plain(l0.state.facts)], [0, false, 1, 0, ['新看守进了门']]);
  assert.equal(start.facts.length, 0, '不改传进来的状态');

  const l1 = core.applyVerdict(l0.state, parsed.verdict, index, { turn: 5, l2Cooldown: 2 });
  assert.deepEqual([l1.level, l1.restructure, l1.state.phaseCursor], [1, false, 2]);
  assert.deepEqual(plain(l1.state.patches), [{ phase: 2, turn: 5, text: '艾琳改从后门送他上钟楼' }]);
  assert.deepEqual(plain(l1.state.facts), ['新看守进了门', '林渡没接毛巾']);
  /* 游标只进不退、不超过阶段数；走过去两个阶段的补丁清掉。 */
  const back = core.applyVerdict(l1.state, core.parseVerdict(judge({ phase_cursor: 1 })).verdict, index, { turn: 6 });
  assert.deepEqual([back.state.phaseCursor, back.state.patches.length], [2, 1]);
  const far = core.applyVerdict({ ...l1.state, patches: [{ phase: 1, turn: 2, text: '旧补丁' }] }, core.parseVerdict(judge({ phase_cursor: 9 })).verdict, index, { turn: 7 });
  assert.deepEqual([far.state.phaseCursor, far.state.patches.length], [3, 0]);

  const verdict2 = core.parseVerdict(judge({ drift_level: 2, reason: '林渡连夜渡河离开了旧港' })).verdict;
  const l2 = core.applyVerdict(l1.state, verdict2, index, { turn: 6, l2Cooldown: 2 });
  assert.deepEqual([l2.level, l2.restructure, l2.downgraded, l2.state.lastL2Turn], [2, true, false, 6]);
  /* 重构之后不到两个回合又判 L2：按 L1 接住，不重构；用户手动要求的不受冷却限制。 */
  const cooling = core.applyVerdict(l2.state, verdict2, index, { turn: 7, l2Cooldown: 2 });
  assert.deepEqual([cooling.level, cooling.restructure, cooling.downgraded, cooling.state.lastL2Turn], [1, false, true, 6]);
  assert.match(cooling.state.patches.at(-1).text, /冷却期内的结构偏移/);
  assert.equal(core.applyVerdict(l2.state, verdict2, index, { turn: 7, l2Cooldown: 2, manual: true }).restructure, true);
  assert.equal(core.applyVerdict(l2.state, verdict2, index, { turn: 8, l2Cooldown: 2 }).restructure, true, '过了冷却期');
});

test('场记与总导演 Skill 严格隔离且前缀静态；单会话编纲消息、插话与自动质检校验完备', () => {
  assert.equal(core.normalizeSettings({ planMode: 'review' }).planMode, 'auto', '编纲模式只保留 auto');
  const base = { skillRaw: SKILL, preferences: '日常多一些', userName: '林渡', profile: '主角「林渡」：修表匠', outline: OUTLINE, index: core.normalizeIndex(INDEX, OUTLINE) };
  const first = core.buildJudgeMessages({ ...base, state: core.initialState(), brief: '简报一', turn: 3, recent: [{ floor: 4, role: 'assistant', name: '艾琳', text: '她递来毛巾。' }] });
  const state = { ...core.initialState(), phaseCursor: 2, progress: '上了钟楼', facts: ['林渡没接毛巾'], patches: [{ phase: 2, turn: 5, text: '艾琳改从后门送他上钟楼' }], turn: 5 };
  const second = core.buildJudgeMessages({ ...base, state, brief: '简报二', turn: 6, recent: [{ floor: 6, role: 'user', name: '林渡', text: '我绕到后门。' }, { floor: 7, role: 'assistant', name: '艾琳', text: '后门没有锁。' }] });
  assert.equal(first[0].content, second[0].content, '场记 System 逐字节相同');
  assert.ok(first[0].content.includes(OUTLINE) && first[0].content.includes('## 阶段五') && !first[0].content.includes('## 阶段四') && !first[0].content.includes('## 阶段六'), '场记只读运行期协议，不串大纲编撰段');
  assert.ok(first[0].content.includes('日常多一些') && first[0].content.includes('输出契约'));
  assert.ok(!first[0].content.includes('{{user}}') && first[0].content.includes('林渡'), 'Skill 里的主角占位已经换成实名');
  assert.ok(!second[0].content.includes('艾琳改从后门送他上钟楼'), 'L1 的补丁不进静态前缀');
  assert.ok(second[1].content.includes('艾琳改从后门送他上钟楼') && second[1].content.includes('林渡没接毛巾') && second[1].content.includes('[#7 艾琳]') && second[1].content.includes('游标：Phase 2 / 3（钟楼的夹层）'));
  assert.notEqual(core.buildJudgeSystem({ ...base, outline: OUTLINE_V2 }), first[0].content, '只有大纲换了版本，前缀才变');

  const system = core.buildPlannerSystem(SKILL, '日常多一些', '林渡');
  assert.ok(system.includes('## 阶段一') && system.includes('## 阶段四') && system.includes('## 阶段六') && !system.includes('## 阶段五'), '总导演只读大纲创作与自检切片，不串场记协议');
  assert.ok(system.includes('用户长期偏好') && system.includes('日常多一些') && system.includes('主角实名：「林渡」'));
  assert.match(system, /角色卡的标题、世界书的书名只是资料的出处，不是人物/);

  const planMsgs = core.buildPlannerMessages({ system, materials: '### 近期正文\n……', feedback: [{ text: '少一点阴谋' }] });
  assert.equal(planMsgs.length, 2);
  assert.ok(planMsgs[1].content.includes('### 近期正文') && planMsgs[1].content.includes('## 编纲与交付任务（单会话连贯完成）') && planMsgs[1].content.includes('少一点阴谋'));
  assert.ok(planMsgs[1].content.includes('<self_check>') && planMsgs[1].content.includes('<volume_outline>') && planMsgs[1].content.includes('<volume_index>') && planMsgs[1].content.includes('<first_brief>') && planMsgs[1].content.includes('【本轮防 AI 味忌口】'));
  assert.match(core.buildInterjectionMessage('先查一下银币数量'), /用户实时插话.*先查一下银币数量/s);

  /* 交付物解析与自动质检闭环：完整交付通过；截断、坏索引、缺简报、自检未通过均触发打回。 */
  const valid = delivery(OUTLINE, INDEX, brief('Phase 1'));
  const final = core.parseFinalOutline(valid);
  assert.deepEqual([final.ok, final.index.totalPhases, final.index.title, final.index.newCharacters.length, final.index.inferred], [true, 3, '雨季的钟', 2, false]);
  assert.deepEqual(plain(final.index.newCharacters.map((item) => item.kind)), ['npc', 'temp_event']);
  assert.equal(core.validateFinalDelivery(valid, { userName: '林渡' }).ok, true);

  const cut = core.parseFinalOutline('<self_check>ok</self_check>\n<volume_outline>\n' + OUTLINE.slice(0, 200));
  assert.deepEqual([cut.ok, cut.truncated, /调大/.test(cut.error)], [false, true, true]);
  const badJson = '<volume_outline>\n' + OUTLINE + '\n</volume_outline>\n<volume_index>\n{坏的 JSON\n</volume_index>';
  const inferred = core.parseFinalOutline(badJson);
  assert.deepEqual([inferred.ok, inferred.indexOk, inferred.index.inferred, plain(inferred.index.phases.map((phase) => phase.title)), inferred.firstBrief], [true, false, true, ['雨夜来客', '钟楼的夹层', '清点之日'], '']);
  const vBadJson = core.validateFinalDelivery(badJson, { userName: '林渡' });
  assert.equal(vBadJson.ok, false);
  assert.ok(vBadJson.issues.some((s) => s.includes('<volume_index>')) && vBadJson.issues.some((s) => s.includes('<first_brief>')));

  const unfixedSelfCheck = '<self_check>\n1. 通过\n2. 命名嗅探：未通过，存在罐头人名\n</self_check>\n' + `<volume_outline>\n${OUTLINE}\n</volume_outline>\n<volume_index>\n${JSON.stringify(INDEX)}\n</volume_index>\n<first_brief>\n${brief('Phase 1')}\n</first_brief>`;
  const vCheck = core.validateFinalDelivery(unfixedSelfCheck, { userName: '林渡' });
  assert.equal(vCheck.ok, false);
  assert.equal(vCheck.hardFailure, false, '仅自检未通过属于软失败，允许一键忽略自检定稿');
  assert.match(vCheck.issues[0], /尚未修正/);
  assert.match(core.buildRevisionPrompt(vCheck.issues), /自动质检打回/);

  /* P1-6 反例：否定语境和括号讨论里的「失败 / 无需修改 / 不存在问题」绝不能误杀合格稿件；全角板块Ａ/Ｄ也放行 */
  const trickyPass = '<self_check>\n'
    + '1. 去塑料件：通过，无需修改\n'
    + '2. 命名嗅探：通过，不存在问题\n'
    + '3. 转场检验：通过，无需重写\n'
    + '8. 互动自由度：通过（玩家强攻失败、提前撤退或掀桌均已接住）\n'
    + '</self_check>\n'
    + `<volume_outline>\n${OUTLINE.replace('板块 A', '板块Ａ').replace('板块 D', '板块Ｄ')}\n</volume_outline>\n<volume_index>\n${JSON.stringify(INDEX)}\n</volume_index>\n<first_brief>\n${brief('Phase 1')}\n</first_brief>`;
  assert.equal(core.validateFinalDelivery(trickyPass, { userName: '林渡' }).ok, true, '正向通过+否定语境/括号含「失败」与全角板块号均放行');

  const fixedSelfCheck = '<self_check>\n1. 通过\n2. 命名嗅探：原先未通过，已修正为旧港本土地名\n</self_check>\n' + `<volume_outline>\n${OUTLINE}\n</volume_outline>\n<volume_index>\n${JSON.stringify(INDEX)}\n</volume_index>\n<first_brief>\n${brief('Phase 1')}\n</first_brief>`;
  assert.equal(core.validateFinalDelivery(fixedSelfCheck, { userName: '林渡' }).ok, true, '标明已修正的自检行放行');
  assert.equal(core.parseFinalOutline(OUTLINE).lenient, true, '忘了套标签但确实是一份大纲：parseFinalOutline 宽容收下');
  assert.equal(core.validateFinalDelivery(OUTLINE).ok, false, '缺少 volume_index 与 first_brief 仍判不合格');
  assert.equal(core.parseFinalOutline('抱歉，我不能完成这个请求。').ok, false);
});

test('后台巡检：L0 / L1 更新快照与简报，大纲文件与静态前缀都不变；场记判 L2 时直接拉总导演重构，可一键撤回', async () => {
  const h = await activated();
  try {
    const dir = h.dir();
    assert.deepEqual(h.model.calls.map((call) => call.kind), ['plan']);
    assert.equal(await h.vfs.readText(dir + '/outline.md'), OUTLINE);
    const status = h.director.getStatus();
    assert.deepEqual([status.state, status.volume.no, status.volume.title, status.volume.totalPhases, status.volume.version], ['running', 1, '雨季的钟', 3, 1]);
    /* 开卷那一楼已经有首轮简报：不为它多调一次场记。 */
    await sleep(40);
    assert.equal(h.model.of('judge').length, 0);

    /* L0 */
    await h.turn('我接过毛巾，问她镇上谁会修钟。', '「钟楼的莫师傅。」她朝窗外抬了抬下巴。');
    assert.equal(h.model.of('judge').length, 1);
    let snaps = await h.readJson(dir + '/snapshots.json');
    assert.deepEqual([snaps.ring.length, snaps.ring[0].floor, snaps.ring[0].kind, snaps.ring[0].state.driftLevel], [1, 4, 'patrol', 0]);
    assert.match((await h.director.getBrief()).text, /下一轮。林渡刚在酒馆坐下/);

    /* L1：补丁记在快照的状态里，outline.md 一个字不动。 */
    h.model.table.judge = judge({ drift_level: 1, phase_cursor: 2, local_patch: '艾琳改从后门送他上钟楼', facts_add: ['林渡没走正门'], reason: '换了路' });
    await h.turn('我不走正门，绕到钟楼后面。', '后门的锁早就锈死了，她却从围裙里摸出一把钥匙。');
    snaps = await h.readJson(dir + '/snapshots.json');
    assert.deepEqual(plain(snaps.ring.at(-1).state.patches), [{ phase: 2, turn: 4, text: '艾琳改从后门送他上钟楼' }]);
    assert.equal(await h.vfs.readText(dir + '/outline.md'), OUTLINE);
    assert.deepEqual(Object.keys(snaps.versions), ['1']);
    assert.deepEqual([h.director.getStatus().volume.phaseCursor, h.director.getStatus().volume.driftLevel], [2, 1]);

    /* 第三轮：补丁只出现在动态的 User 里；三轮的 System 逐字节相同。 */
    h.model.table.judge = judge({ phase_cursor: 2 });
    await h.turn('我接过钥匙。', '钥匙在锁孔里转了半圈。');
    const judges = h.model.of('judge');
    assert.equal(judges.length, 3);
    assert.equal(judges[0].system, judges[1].system);
    assert.equal(judges[1].system, judges[2].system);
    assert.ok(judges[2].last.includes('艾琳改从后门送他上钟楼') && !judges[2].system.includes('艾琳改从后门送他上钟楼'));
    assert.ok(judges[2].last.includes('[#8 艾琳]') && judges[2].last.includes('钥匙在锁孔里转了半圈'));
    assert.ok(!h.model.calls.some((call) => call.kind === 'other'), '没有走助手的主循环或 delegate_task');

    /* L2：场记之后紧跟着就是总导演的重构请求（同一份编纲 System），不经过助手。 */
    h.model.table.judge = judge({ drift_level: 2, reason: '林渡连夜渡河离开了旧港', next_brief: '' });
    await h.turn('我收起工具箱，连夜渡河去对岸。', '渡船离了岸，旧港的灯一盏一盏沉进雨里。');
    await until(() => h.model.of('restructure').length === 1 && !h.director.getStatus().work, '重构完成');
    const kinds = h.model.calls.map((call) => call.kind);
    assert.deepEqual(kinds.slice(-2), ['judge', 'restructure']);
    const restructure = h.model.of('restructure')[0];
    assert.equal(restructure.system, h.model.of('plan')[0].system, '重构复用编纲的 System');
    assert.equal(restructure.prompts.length, 2, '无状态：不带之前的对话');
    assert.ok(restructure.last.includes('林渡连夜渡河离开了旧港') && restructure.last.includes('林渡没走正门') && restructure.last.includes(OUTLINE) && restructure.last.includes('渡船离了岸'));
    assert.equal(await h.vfs.readText(dir + '/outline.md'), OUTLINE_V2);
    const after = h.director.getStatus();
    assert.deepEqual([after.state, after.volume.version, after.volume.phaseCursor, after.volume.totalPhases, after.canUndoRestructure], ['running', 2, 1, 2, true]);
    assert.match((await h.director.getBrief()).text, /重构后的 Phase 1/);
    snaps = await h.readJson(dir + '/snapshots.json');
    assert.deepEqual(Object.keys(snaps.versions).sort(), ['1', '2']);
    assert.equal(snaps.versions['2'].note, '玩家提前渡河，原定的钟楼冲突不再成立');

    /* 冷却期：紧接着又判 L2，按 L1 接住，不再重构。 */
    await h.turn('我在对岸找了间客栈。', '客栈的伙计认得那只工具箱。');
    assert.equal(h.model.of('restructure').length, 1);
    snaps = await h.readJson(dir + '/snapshots.json');
    assert.deepEqual([snaps.ring.at(-1).state.driftLevel, snaps.ring.at(-1).outlineVersion], [1, 2]);

    /* 一键撤回：大纲、状态、简报回到重构之前，从当前楼层起生效。 */
    assert.deepEqual(plain(await h.director.undoRestructure()), { version: 1 });
    assert.equal(await h.vfs.readText(dir + '/outline.md'), OUTLINE);
    const undone = h.director.getStatus();
    assert.deepEqual([undone.volume.version, undone.volume.phaseCursor, undone.canUndoRestructure], [1, 2, false]);
    assert.deepEqual(plain(undone.volume.patches.map((patch) => patch.text)), ['艾琳改从后门送他上钟楼']);
    await assert.rejects(() => h.director.undoRestructure(), /没有可以撤回的重构/);

    /* 删楼退回到 L1 那一楼：状态自动回滚，不必再调模型。 */
    const calls = h.model.calls.length;
    h.chat.splice(7);
    await h.emit('MESSAGE_DELETED', h.chat.length);
    await sleep(40);
    assert.equal(h.model.calls.length, calls);
    const rolled = h.director.getStatus();
    assert.deepEqual([rolled.volume.briefFloor, rolled.volume.phaseCursor, rolled.volume.version], [6, 2, 1]);
  } finally { h.dispose(); }
});

test('场记连续三次失败自动暂停并告警；回复不合约定时先重试一次；恢复后清零', async () => {
  const h = await activated({ replies: { judge: '我觉得这一轮写得不错。' } });
  try {
    h.chat.push({ name: '林渡', is_user: true, mes: '我接过毛巾。' }, { name: '艾琳', is_user: false, mes: '她笑了一下。' });
    for (let round = 1; round <= 3; round += 1) {
      await assert.rejects(() => h.director.patrolNow(), /没有按约定返回 JSON/);
      assert.equal(h.model.of('judge').length, round * 2, '每次巡检：回复不合约定就重试一次');
      assert.equal(h.director.getStatus().failStreak, round);
    }
    const status = h.director.getStatus();
    assert.deepEqual([status.state, status.paused, status.pausedBy], ['paused', true, 'failures']);
    assert.match(status.lastError, /没有按约定返回 JSON/);
    assert.equal(h.director.injectable(), false, '暂停之后不再注入');
    assert.equal(await h.director.briefFor('normal'), '');
    assert.ok(h.host.__toasts.some((text) => /连续 3 次巡检失败，已自动暂停/.test(text)));
    assert.equal(h.api.jobs.list().filter((job) => job.state === 'failed').length >= 1, true);

    /* 暂停着的时候后台不再自己巡检。 */
    const calls = h.model.calls.length;
    await h.emit('GENERATION_ENDED');
    await sleep(40);
    assert.equal(h.model.calls.length, calls);

    h.model.table.judge = judge();
    assert.deepEqual(plain(await h.director.resume()), { resumed: true });
    await until(() => h.model.of('judge').length === 7 && !h.director.getStatus().work, '恢复后补上巡检');
    const resumed = h.director.getStatus();
    assert.deepEqual([resumed.state, resumed.failStreak, resumed.lastError], ['running', 0, '']);
    assert.equal(h.director.injectable(), true);
  } finally { h.dispose(); }
});

/* ========================================================================================================
 * 4. 完结双保险与归档分流
 * ====================================================================================================== */

test('完结的闸门：不在最后一个 Phase 不算；到了终幕也要连着两轮确认', () => {
  const index = core.normalizeIndex(INDEX, OUTLINE);
  const done = (cursor) => core.parseVerdict(judge({ phase_cursor: cursor, volume_completed: true })).verdict;
  const early = core.applyVerdict(core.initialState(), done(2), index, { turn: 1 });
  assert.deepEqual([early.readyToFinish, early.state.finishStreak], [false, 0], '非终幕禁止完结');
  const landing = core.applyVerdict(early.state, done(3), index, { turn: 2 });
  assert.deepEqual([landing.readyToFinish, landing.state.finishStreak], [false, 1], '刚落地：还差一轮余韵');
  const settled = core.applyVerdict(landing.state, done(3), index, { turn: 3 });
  assert.deepEqual([settled.readyToFinish, settled.state.finishStreak], [true, 2]);
  /* 中间有一轮没判完结：重新数。 */
  const broken = core.applyVerdict(landing.state, core.parseVerdict(judge({ phase_cursor: 3 })).verdict, index, { turn: 3 });
  assert.deepEqual([broken.readyToFinish, broken.state.finishStreak], [false, 0]);
  assert.equal(core.applyVerdict(broken.state, done(3), index, { turn: 4 }).readyToFinish, false);
  /* 没有阶段表（大纲里读不出 Phase）时，只看场记的两轮确认。 */
  const loose = core.applyVerdict({ ...core.initialState(), finishStreak: 1 }, done(1), core.normalizeIndex(null, '没有阶段的大纲'), { turn: 2 });
  assert.equal(loose.readyToFinish, true);
  /* 归档回复的解析与兜底。 */
  const parsed = core.parseArchive('```json\n' + ARCHIVE + '\n```');
  assert.deepEqual([parsed.ok, parsed.archive.hooks.length, parsed.archive.entries[0].keep], [true, 2, true]);
  assert.equal(core.parseArchive(JSON.stringify({ summary: '长'.repeat(900) })).archive.summary.length, core.ARCHIVE_LIMIT);
  assert.equal(core.parseArchive('归档完成').ok, false);
  const fallback = core.fallbackArchive(index, { ...core.initialState(), progress: '账本归还', facts: ['怀表交给了林渡'] });
  assert.deepEqual([fallback.fallback, fallback.summary, fallback.title], [true, '账本归还；怀表交给了林渡', '雨季的钟']);
});

test('完结归档：进入待完结 → 沉淀档案 → 一次性条目只关不删、新角色按勾选去留 → 清空活跃卷；可一键恢复', async () => {
  const g = await activated({ agentSettings: { mode: 'card', approval: 'auto' } });
  try {
    const dir = g.dir();
    /* 先给两位新角色建档（一位长期角色、一位一次性的）。 */
    const pending = g.director.getStatus().pending;
    assert.deepEqual(plain(pending.map((item) => [item.name, item.kind, item.status])), [['莫师傅', 'npc', 'pending'], ['港务司书记', 'temp_event', 'pending']]);
    for (const item of pending) assert.equal((await g.director.confirmPendingEntry(item.id)).ok, true);
    const book = () => g.worldbooks['Reader生成条目'];
    assert.deepEqual(plain(book().map((entry) => [entry.name, entry.enabled, entry.extra.reader_ii_director.roleKind])), [['莫师傅', true, 'npc'], ['港务司书记', true, 'temp_event']]);

    /* 还没到最后一个 Phase：场记说完结也不算。 */
    g.model.table.judge = judge({ phase_cursor: 2, volume_completed: true });
    await g.turn('我上了钟楼。', '莫师傅守着楼梯。');
    assert.equal(g.director.getStatus().state, 'running');
    /* 终幕第一次确认：还差一轮余韵。第二次确认：进入待完结，提示用户。 */
    g.model.table.judge = judge({ phase_cursor: 3, volume_completed: true, facts_add: ['账本摆上了桌面'], state_delta: '清点结束，雨停了' });
    await g.turn('我把账本放在桌上。', '港务司的书记合上了册子。');
    assert.equal(g.director.getStatus().state, 'running');
    assert.ok(g.model.of('judge').at(-1).last.includes('游标：Phase 2 / 3'));
    await g.turn('我送莫师傅回钟楼。', '他把一只怀表塞进我手里。');
    assert.equal(g.director.getStatus().state, 'pending_finish');
    assert.ok(g.host.__toasts.some((text) => /已经走到落幕/.test(text)));
    assert.equal(g.director.injectable(), true, '待完结期间照常注入');

    /* 接着往下演 → 回到执导中，完结的计数清零；再连着两轮确认才会再次提示。 */
    assert.equal(await g.director.continueVolume(), true);
    assert.equal(g.director.getStatus().state, 'running');
    await g.turn('我在钟楼下站了一会儿。', '雨后的风把钟声送得很远。');
    assert.equal(g.director.getStatus().state, 'running');
    await g.turn('我回了酒馆。', '艾琳把灯拨亮了些。');
    assert.equal(g.director.getStatus().state, 'pending_finish');

    const entries = await g.director.listVolumeEntries();
    assert.deepEqual(plain(entries.map((item) => [item.name, item.roleKind, item.enabled])), [['莫师傅', 'npc', true], ['港务司书记', 'temp_event', true]]);
    const result = await g.director.finish({ keepEntryIds: entries.filter((item) => item.roleKind === 'npc').map((item) => item.id) });
    assert.deepEqual([result.volumeNo, result.disabled, result.fallback, plain(result.hooks)], [1, 1, false, ['莫师傅徒弟留下的怀表', '港务司的旧册子少了一页']]);
    const archiveCall = g.model.of('archive')[0];
    assert.ok(archiveCall.system.includes('丙、完结判定与资产沉淀协议') && !archiveCall.system.includes('## 阶段一'), '归档只带阶段五·丙');
    assert.ok(archiveCall.last.includes('账本摆上了桌面') && archiveCall.last.includes('莫师傅（新角色）') && archiveCall.last.includes('港务司书记（一次性事件 / 龙套）'));

    /* 档案沉淀；活跃卷、大纲、快照、简报清空。 */
    const archive = await g.readJson(dir + '/archive.json');
    assert.deepEqual([archive.volumes.length, archive.volumes[0].volumeNo, archive.volumes[0].title, archive.volumes[0].summary], [1, 1, '雨季的钟', '账本的去向摆上了桌面，莫师傅把怀表交给了林渡。']);
    assert.deepEqual(plain(archive.volumes[0].disabled), ['港务司书记']);
    assert.equal((await g.readJson(dir + '/active.json')).status, 'idle');
    assert.equal(await g.vfs.readText(dir + '/outline.md'), null);
    assert.equal(await g.vfs.readText(dir + '/snapshots.json'), null);
    const idle = g.director.getStatus();
    assert.deepEqual([idle.state, idle.hasArchive, idle.canRestoreArchive, idle.volume], ['idle', true, true, null]);
    assert.equal(g.director.injectable(), false);
    assert.equal(await g.director.briefFor('normal'), '');
    /* 分流：一次性条目停用但还在（只关不删）；新角色保留启用。 */
    assert.deepEqual(plain(book().map((entry) => [entry.name, entry.enabled])), [['莫师傅', true], ['港务司书记', false]]);
    assert.ok(book()[1].content.includes('灰呢制服'));

    /* 一键恢复：活跃卷回来，被停用的条目重新启用，档案里刚加的那一卷去掉。 */
    assert.deepEqual(plain(await g.director.restoreLastArchive()), { volumeNo: 1, entries: 1 });
    const back = g.director.getStatus();
    assert.deepEqual([back.volume.no, back.volume.phaseCursor, back.canRestoreArchive, back.hasArchive], [1, 3, false, false]);
    assert.ok(['running', 'pending_finish'].includes(back.state));
    assert.equal(await g.vfs.readText(dir + '/outline.md'), OUTLINE);
    assert.deepEqual(plain(book().map((entry) => entry.enabled)), [true, true]);
    assert.equal((await g.readJson(dir + '/archive.json')).volumes.length, 0);
    assert.equal(g.director.injectable(), true);

    /* 再完结一次，这回不勾新角色：它也停用（仍然只关不删）。归档模型坏了也不卡住：用进度与硬事实兜底。 */
    g.model.table.archive = '归档完成。';
    const again = await g.director.finish({ keepEntryIds: [] });
    assert.deepEqual([again.disabled, again.fallback], [2, true]);
    assert.match(again.summary, /清点结束，雨停了；账本摆上了桌面/);
    assert.deepEqual(plain(book().map((entry) => entry.enabled)), [false, false]);
    assert.equal(book().length, 2);

    /* 下一卷开卷时，上一卷的档案与钩子进了勘察资料，卷号接着排。 */
    g.model.table.archive = ARCHIVE;
    await g.director.activate();
    assert.ok(g.model.of('plan').at(-1).last.includes('已完结各卷的档案与跨卷钩子') && g.model.of('plan').at(-1).last.includes('清点结束，雨停了'));
    assert.equal(g.director.getStatus().volume.no, 2);
  } finally { g.dispose(); }
});

/* ========================================================================================================
 * 5. 提示词槽位与独立运行
 * ====================================================================================================== */

test('简报净化：主角名换成实名，{{char}} 不动手，其余宏与 EJS 失活，剥块、防泄密、限长', () => {
  assert.equal(core.expandUser('{{user}}、{{ User }}、<user>、<USER> 与 {{char}}、<char>', '林渡'), '林渡、林渡、林渡、林渡 与 {{char}}、<char>');
  assert.equal(core.expandUser('{{user}}', '$1'), '$1', '名字里的 $ 不当替换记号');
  const raw = '<thinking>先想想</thinking>```\n' + brief('Phase 1') + '\n```\n{{setvar::gold::999}}{{char}}说：<% fetch("/x") %> <char> <UpdateVariable>金币+1</UpdateVariable><READER_FP_EVENT>{"a":1}</READER_FP_EVENT><b>加粗</b><script>alert(1)</script>';
  const clean = core.sanitizeBriefDetailed(raw, { userName: '林渡' });
  assert.ok(clean.text.startsWith('【当前阶段与承接】Phase 1。林渡刚在酒馆坐下'));
  assert.ok(clean.text.includes('对林渡多看了一眼'));
  for (const bad of ['{{', '}}', '<%', '%>', '<user>', '<char>', '先想想', '金币+1', 'READER_FP_EVENT', '<b>', 'alert(1)', '```']) assert.ok(!clean.text.includes(bad), bad);
  assert.ok(clean.text.includes('｛｛setvar::gold::999｝｝') && clean.text.includes('｛｛char｝｝') && clean.text.includes('＜% fetch("/x") %＞') && clean.text.includes('＜char＞'), '写了什么看得出来，但不会再被执行');
  assert.ok(!clean.text.includes('艾琳说') , '{{char}} 没有被换成卡的名字');

  /* 防泄密：与「后台完整实情」连续重合 18 个字以上的那一句整句拿掉；公开的时钟节点不算。 */
  assert.equal(core.hiddenTruth(OUTLINE).includes('灯塔的旧账本其实被莫师傅藏在了钟楼的夹层里'), true);
  assert.equal(core.hiddenTruth(OUTLINE).includes('港务司会来清点'), false);
  const leaky = '【当前阶段与承接】Phase 2。\n【在场角色意图（仅表现层）】莫师傅守着楼梯。灯塔的旧账本其实被莫师傅藏在了钟楼的夹层里，他不想让人上去。他的手一直按着围裙。\n【本轮细节与暗压】第三天傍晚，港务司会来清点灯塔的库房；雨停之前渡船不开。';
  const guarded = core.sanitizeBriefDetailed(leaky, { userName: '林渡', outline: OUTLINE });
  assert.equal(guarded.leaks, 1);
  assert.ok(!guarded.text.includes('旧账本其实被莫师傅藏在'));
  assert.ok(guarded.text.includes('【在场角色意图（仅表现层）】莫师傅守着楼梯。') && guarded.text.includes('他的手一直按着围裙。'), '只拿掉泄密的那一句，栏名与前后句都在');
  assert.ok(guarded.text.includes('第三天傍晚，港务司会来清点灯塔的库房'), '时钟的节点可以露出');
  assert.equal(core.sanitizeBriefDetailed('莫师傅藏了账本。', { outline: OUTLINE }).leaks, 0, '短的重合不算');

  /* 限长：从最长的一段缩起，各栏的开头都留得住。 */
  const long = core.BRIEF_COLUMNS.map((column, index) => column + '细节'.repeat(index === 1 ? 300 : 40) + '。').join('\n');
  const clamped = core.clampBrief(long, core.BRIEF_LIMIT);
  assert.ok(clamped.length <= core.BRIEF_LIMIT, String(clamped.length));
  for (const column of core.BRIEF_COLUMNS) assert.ok(clamped.includes(column), column);
  assert.equal(core.clampBrief('短的', 550), '短的');
  assert.ok(core.sanitizeBrief('字'.repeat(2000), {}).length <= 550);
});

/* 只装正文提示词模块：导演槽位自己的开关、注入位置与防吞槽兜底（与读者的三段互不牵连）。 */
function slotHarness({ readerOn = false, coexisting = false } = {}) {
  const sandbox = vm.createContext({ setTimeout, clearTimeout, console });
  for (const name of ['reader-prompt-placement', 'reader-prompt']) vm.runInContext(read('src/' + name + '.js'), sandbox);
  const modules = sandbox.__ReaderIIModules;
  modules.READER_PROMPT_TEMPLATES = { core: () => '读者核心', rules: () => '更新规则', list: () => '变量列表' };
  const listeners = new Map();
  const eventSource = {
    on(name, handler) { listeners.set(name, [...(listeners.get(name) || []), handler]); },
    makeLast(name, handler) { this.on(name, handler); },
    removeListener(name, handler) { listeners.set(name, (listeners.get(name) || []).filter((fn) => fn !== handler)); },
    async emit(name, ...args) { for (const fn of listeners.get(name) || []) await fn(...args); },
  };
  const prompts = {};
  const ctx = {
    chat: [{ mes: '开场' }, { mes: '用户输入', is_user: true }], chatId: 'A', chatMetadata: {}, extensionSettings: {}, mainApi: 'openai',
    setExtensionPrompt(id, text) { prompts[id] = text; },
    eventSource, eventTypes: Object.fromEntries(EVENTS.map((name) => [name, name])),
  };
  const state = { reader: readerOn, coexisting, active: true, brief: '【当前阶段与承接】林渡在酒馆。', asked: [] };
  const api = { kit: { chatKey: () => ctx.chatId }, isEnabled: () => state.reader, isCoexisting: () => state.coexisting };
  const runtime = modules.createPromptRuntime(api, { context: () => ctx, host: {}, getVariables: () => ({}) });
  const registered = runtime.registerSlot('director', { active: () => state.active, brief: (type) => { state.asked.push(type); return state.brief; } });
  return { modules, ctx, prompts, state, runtime, registered, emit: eventSource.emit.bind(eventSource) };
}

test('导演槽位不随读者的开关走：卡没启用 Reader-II、或与原版读者共存时照常注入，也不去动读者的事件块', async () => {
  for (const mode of [{ readerOn: false }, { readerOn: false, coexisting: true }]) {
    const s = slotHarness(mode);
    try {
      assert.equal(s.registered, true);
      assert.equal(s.runtime.registerSlot('别的槽', { active: () => true, brief: () => 'x' }), false);
      assert.deepEqual(plain(await s.runtime.render('normal')), { core: '', rules: '', list: '', director: '【当前阶段与承接】林渡在酒馆。' });

      await s.emit('GENERATION_AFTER_COMMANDS', 'swipe', {}, false);
      const lore = { characterLore: [] };
      await s.emit('WORLDINFO_ENTRIES_LOADED', lore);
      assert.equal(lore.characterLore.length, 1, '只有导演这一条，没有读者的三段');
      const entry = lore.characterLore[0];
      assert.deepEqual([entry.content, entry.position, entry.depth, entry.order, entry.constant], ['【当前阶段与承接】林渡在酒馆。', 4, 1, 300, true]);
      assert.deepEqual(plain(s.state.asked.slice(-1)), ['swipe'], '生成类型原样交给导演，由它决定取哪一楼的快照');

      /* 防吞槽：世界书通道的那一条没进最终请求（被别的扩展吞了）时补回去；已经在了就不重复。 */
      const swallowed = { type: 'swipe', prompt: [{ role: 'system', content: '预设' }, { role: 'user', content: '用户输入' }] };
      await s.emit('GENERATE_AFTER_DATA', swallowed, false);
      assert.equal(swallowed.prompt.filter((message) => message.content.includes('【当前阶段与承接】林渡在酒馆。')).length, 1);
      const present = { type: 'swipe', prompt: [{ role: 'system', content: '【当前阶段与承接】林渡在酒馆。' }, { role: 'user', content: '用户输入' }] };
      await s.emit('GENERATE_AFTER_DATA', present, false);
      assert.equal(present.prompt.filter((message) => message.content.includes('【当前阶段与承接】林渡在酒馆。')).length, 1);

      /* 只有导演在执导：聊天记录里读者的事件块、变量块不归我们清（那是读者的活）。 */
      const history = '旧回复<READER_FP_EVENT>{"x":1}</READER_FP_EVENT><UpdateVariable>y</UpdateVariable>';
      const ready = { chat: [{ role: 'assistant', content: history }, { role: 'system', content: '【当前阶段与承接】林渡在酒馆。' }] };
      await s.emit('CHAT_COMPLETION_PROMPT_READY', ready);
      assert.equal(ready.chat[0].content, history);
      const combined = { prompt: history + '\n【当前阶段与承接】林渡在酒馆。' };
      await s.emit('GENERATE_AFTER_COMBINE_PROMPTS', combined);
      assert.ok(combined.prompt.includes('<READER_FP_EVENT>'));
      await s.emit('GENERATION_ENDED');

      /* 导演不在执导：整轮都不介入。 */
      s.state.active = false;
      await s.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
      const idle = { characterLore: [] };
      await s.emit('WORLDINFO_ENTRIES_LOADED', idle);
      assert.equal(idle.characterLore.length, 0);
      await s.emit('GENERATION_ENDED');
      /* 位置设置里关掉这一槽：不注入。 */
      s.state.active = true;
      s.ctx.extensionSettings.reader_ii = { storyPromptPlacement: { director: { enabled: false } } };
      await s.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
      const off = { characterLore: [] };
      await s.emit('WORLDINFO_ENTRIES_LOADED', off);
      assert.equal(off.characterLore.length, 0);
      await s.emit('GENERATION_ENDED');
      assert.equal(s.runtime.registerSlot('director', null), false, '传 null 取消登记');
      assert.equal((await s.runtime.render('normal')).director, undefined);
    } finally { s.runtime.dispose(); }
  }

  /* 读者也启用时：四段并存；读者让位（停用、进入共存）只撤它自己的三段。 */
  const both = slotHarness({ readerOn: true });
  try {
    await both.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    const lore = { characterLore: [] };
    await both.emit('WORLDINFO_ENTRIES_LOADED', lore);
    assert.deepEqual(plain(lore.characterLore.map((entry) => entry.content)), ['读者核心', '更新规则', '变量列表', '【当前阶段与承接】林渡在酒馆。']);
    both.state.reader = false;
    both.runtime.yieldStory();
    const yielded = { characterLore: [] };
    await both.emit('WORLDINFO_ENTRIES_LOADED', yielded);
    assert.deepEqual(plain(yielded.characterLore.map((entry) => entry.content)), ['【当前阶段与承接】林渡在酒馆。']);
    await both.emit('GENERATION_ENDED');
  } finally { both.runtime.dispose(); }
});

test('导演独立运行：卡没启用 Reader-II 时照样执导；按楼层与生成类型取简报，按回合间隔注入；开关随聊天', async () => {
  const h = makeHost({ directorSettings: { enabled: false } });
  try {
    await h.director.ready();
    const reader = h.host.__ReaderIICore;
    assert.equal(reader.isEnabled(), false, '这张卡没启用 Reader-II');
    assert.deepEqual([h.director.isEnabled(), h.director.injectable(), h.director.getStatus().state], [false, false, 'idle']);
    /* 开卷顺手把这个聊天的开关打开；总开关不动。 */
    await h.director.activate({ feedback: '这一卷不要阴谋' });
    assert.deepEqual([h.director.isEnabled(), h.director.getSettings().enabled, h.director.getStatus().chatSwitch], [true, false, true]);
    assert.ok(h.model.of('plan')[0].last.includes('【用户意见（最高优先级') && h.model.of('plan')[0].last.includes('这一卷不要阴谋'));
    /* 勘察资料：主角实名与人设、角色卡、世界书全量目录路径、近期正文都带上了；System 里明确了主角实名。 */
    const first = h.model.of('plan')[0];
    for (const part of ['实名：林渡', '走街串巷的修表匠', '旧港酒馆的老板娘', 'wb:/设定集/旧港', '常驻', '[#2 艾琳]', '[#1 用户 · 林渡]']) assert.ok(first.last.includes(part), part);
    assert.ok(first.system.includes('主角实名：「林渡」') && !first.system.includes('{{user}}'));

    assert.equal(h.director.injectable(), true);
    const firstBrief = await h.director.briefFor('normal');
    assert.ok(firstBrief.includes('Phase 1 · 雨夜。林渡刚在酒馆坐下') && firstBrief.includes('对林渡多看了一眼') && !/\{\{|<user>/.test(firstBrief));
    /* 真实的正文提示词模块：读者的三段是空的，导演简报照常给出。 */
    assert.deepEqual(plain(await reader.prompt.render('normal')), { core: '', rules: '', list: '', director: firstBrief });

    /* 一个回合之后：常规生成用新简报；重掷 / 续写 / 重新生成这一楼，用的仍是指导它的那一份（上一楼的）。 */
    h.model.table.judge = judge({ next_brief: brief('第二轮') });
    await h.turn('我接过毛巾。', '她朝窗外抬了抬下巴。');
    assert.match(await h.director.briefFor('normal'), /第二轮。林渡/);
    for (const type of ['swipe', 'continue', 'regenerate']) assert.match(await h.director.briefFor(type), /Phase 1 · 雨夜。林渡/, type);
    /* 重掷出了新正文、巡检还没跑：常规生成退回上一楼的简报，不会拿旧正文的快照来用。 */
    h.chat.at(-1).mes = '她没有回答，只是把灯拨亮了些。';
    await h.emit('GENERATION_STARTED', 'swipe', {}, false);
    await h.emit('MESSAGE_SWIPED', h.chat.length - 1);
    assert.match(await h.director.briefFor('normal'), /Phase 1 · 雨夜。林渡/);
    h.model.table.judge = judge({ next_brief: brief('第二轮·第二页') });
    await h.emit('GENERATION_ENDED');
    await until(() => h.model.of('judge').length === 2 && !h.director.getStatus().work, '重掷后的巡检');
    assert.match(await h.director.briefFor('normal'), /第二轮·第二页。林渡/);
    /* 切回第一页：原来那条快照又对上了，不必再调模型。 */
    h.chat.at(-1).mes = '她朝窗外抬了抬下巴。';
    await h.emit('MESSAGE_SWIPED', h.chat.length - 1);
    await sleep(40);
    assert.equal(h.model.of('judge').length, 2);
    assert.match(await h.director.briefFor('normal'), /第二轮。林渡/);

    /* 每两个回合注入一次：开卷后的第 0、2、4……个回合注入，重掷与当初那次生成的结论一致。 */
    h.director.saveSettings({ injectEvery: 2 });
    assert.equal(await h.director.briefFor('normal'), '', '第 1 个回合不注入');
    assert.match(await h.director.briefFor('swipe'), /Phase 1 · 雨夜/, '重掷的是第 0 个回合生成的那一楼');
    h.director.saveSettings({ injectEvery: 1, patrolEvery: 2 });
    /* 每两个回合巡检一次：下一个回合不调场记，再下一个才调。 */
    await h.turn('我问她钟楼怎么走。', '「出门右转，听见钟声就是。」', 0);
    assert.equal(h.model.of('judge').length, 2);
    assert.match(await h.director.briefFor('normal'), /第二轮。林渡/, '没巡检的回合沿用上一份简报');
    await h.turn('我背起工具箱出了门。', '雨小了。');
    assert.equal(h.model.of('judge').length, 3);
    assert.ok(h.model.of('judge')[2].last.includes('[#5 用户 · 林渡]') && h.model.of('judge')[2].last.includes('[#8 艾琳]'), '隔了一个回合：把中间的楼层一并交给场记');

    /* 用户改写简报：照样净化；这个聊天单独关掉导演之后不注入、不巡检，状态都留着。 */
    const saved = await h.director.saveBrief('【当前阶段与承接】{{user}}站在钟楼下。{{getvar::x}}');
    assert.equal(saved.text, '【当前阶段与承接】林渡站在钟楼下。｛｛getvar::x｝｝');
    assert.equal(await h.director.briefFor('normal'), saved.text);
    assert.equal(h.director.setChatEnabled(false), false);
    assert.deepEqual([h.director.injectable(), await h.director.briefFor('normal'), (await reader.prompt.render('normal')).director], [false, '', undefined]);
    await h.turn('我敲了敲钟楼的门。', '没有人应。', 0);
    assert.equal(h.model.of('judge').length, 3);
    assert.equal(h.director.getStatus().state, 'running');
    assert.equal(h.director.setChatEnabled(null), false, '跟随总开关（关）');
    h.director.saveSettings({ enabled: true });
    assert.equal(h.director.injectable(), true);
  } finally { h.dispose(); }
});

test('档案跟着聊天的稳定身份走：切聊天互不串；改名或开分支后按指针把原来的档接过去，各自往下演', async () => {
  const h = await activated();
  try {
    await h.turn('我接过毛巾。', '她朝窗外抬了抬下巴。');
    const oldDir = h.dir();
    const ref = h.ctx.chatMetadata.variables.reader_ii_director_ref;
    assert.deepEqual([ref.ownerKey, ref.on, 'ws:/director/chats/' + ref.chatHash], [JSON.stringify(['card:ailin.png', 'chat-1']), true, oldDir]);
    /* 角色列表的下标变了（前面多导入了一张卡）：稳定身份不变，档还在。 */
    h.ctx.characters.unshift({ name: '别的卡', avatar: 'other.png' });
    h.ctx.characterId = 1;
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    assert.deepEqual([h.director.getStatus().state, h.dir()], ['running', oldDir]);

    /* 换到同一张卡的另一个聊天：那里没有分卷，不注入。 */
    const metadataA = h.ctx.chatMetadata, chatA = h.chat.slice();
    h.ctx.chatId = 'chat-2';
    h.ctx.chatMetadata = { variables: {}, reader_ii_enabled: false };
    h.chat.splice(0, h.chat.length, { name: '艾琳', is_user: false, mes: '新的一天。' });
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    assert.deepEqual([h.director.getStatus().state, h.director.injectable(), await h.director.briefFor('normal')], ['idle', false, '']);
    assert.equal(await h.readJson(h.dir() + '/active.json'), null);

    /* 开分支：新聊天带着原聊天的元数据（指针在里面）与前半段楼层，自己没有档 → 按指针认领一份。 */
    h.ctx.chatId = 'chat-1 - Branch #1';
    h.ctx.chatMetadata = plain(metadataA);
    h.chat.splice(0, h.chat.length, ...chatA.slice(0, 3));
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    const branchDir = h.dir();
    assert.notEqual(branchDir, oldDir);
    const branch = h.director.getStatus();
    assert.deepEqual([branch.state, branch.volume.title, branch.volume.briefFloor], ['running', '雨季的钟', 2], '分支停在第 2 楼：取到的是开卷时的状态');
    assert.match(await h.director.briefFor('normal'), /Phase 1 · 雨夜/);
    assert.equal((await h.readJson(branchDir + '/active.json')).ownerKey, JSON.stringify(['card:ailin.png', 'chat-1 - Branch #1']));
    assert.equal(h.ctx.chatMetadata.variables.reader_ii_director_ref.ownerKey, JSON.stringify(['card:ailin.png', 'chat-1 - Branch #1']), '指针改指自己');
    /* 分支里往下演，不影响原聊天的档。 */
    h.model.table.judge = judge({ next_brief: brief('分支里的第二轮') });
    await h.turn('我没有接毛巾。', '她把毛巾搭回了椅背。');
    assert.equal((await h.readJson(branchDir + '/snapshots.json')).ring.at(-1).brief.includes('分支里的第二轮'), true);
    assert.equal((await h.readJson(oldDir + '/snapshots.json')).ring.at(-1).brief.includes('分支里的第二轮'), false);

    /* 别的卡的聊天即使带着这个指针（聊天文件被挪了过去）也不认领。 */
    h.ctx.characterId = 0;
    h.ctx.chatId = 'chat-9';
    h.ctx.chatMetadata = plain(metadataA);
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    assert.equal(h.director.getStatus().state, 'idle');
  } finally { h.dispose(); }
});

/* ========================================================================================================
 * 6. 世界书模板与权限
 * ====================================================================================================== */

test('条目模板与输出协议：模板库与内联默认模板合并；四个标签的解析、截断检测；条目上的记号', () => {
  const inline = inlineDefaults().template;
  const mine = { id: 'mine', name: '我的模板', templateText: '名字: ${名字}\n来历: ${来历}', generationInstruction: '照着写', entryNameRule: '用名字', output: { targetWorldbook: '我的人物志', strategyType: 'selective', keywordMode: 'smart', order: 77 } };
  const lib = wbCore.readLibrary({ yuanTemplateId: 'mine', templates: [mine, { id: '', name: '坏的' }] }, inline);
  assert.deepEqual(plain(lib.templates.map((item) => item.id)), ['mine', 'reader-default-generic-character']);
  assert.equal(lib.defaultId, 'reader-default-generic-character', '约定的默认模板优先');
  assert.equal(wbCore.readLibrary({ yuanTemplateId: 'mine', templates: [mine] }, null).defaultId, 'mine');
  assert.deepEqual(plain(wbCore.readLibrary(null, inline).templates.map((item) => [item.id, item.builtin, item.output.targetWorldbook])), [['reader-default-generic-character', true, 'Reader生成条目']]);
  /* 模板库里有同一个 id 时以模板库里的为准（用户改过默认模板）。 */
  const edited = wbCore.readLibrary({ templates: [{ ...inline, name: '我改过的默认模板' }] }, inline);
  assert.deepEqual(plain(edited.templates.map((item) => item.name)), ['我改过的默认模板']);

  const template = lib.templates[0];
  const messages = wbCore.buildEntryMessages({ character: INDEX.new_characters[0], template, outline: OUTLINE, recent: '[#2 艾琳]\n她递来毛巾。', userName: '林渡', preferences: '不要苦大仇深' });
  assert.ok(messages[0].content.includes('通用世界书条目编写器') && messages[0].content.includes('严禁写进后台尚未揭晓的秘密') && messages[0].content.includes('林渡') && messages[0].content.includes('不要苦大仇深'));
  const user = messages[1].content;
  for (const part of ['姓名：莫师傅', '钟楼的老匠人，耳背', '莫师傅、老莫', '照着写', '用名字', '名字: ${名字}', '<reader_entry_name>', '<reader_content>', '<reader_primary_keywords>', '<reader_secondary_keywords>', '她递来毛巾']) assert.ok(user.includes(part), part);
  assert.ok(!user.includes('旧账本其实被莫师傅藏在') && user.includes('只有导演能看的后台实情，建档时不提供'), '交给建档模型的大纲去掉了后台实情');
  assert.ok(user.includes(CLOCK), '公开的时钟留着');
  /* 一次性的龙套用紧凑的小卡片，不用三四千字的人物志。 */
  const compact = wbCore.buildEntryMessages({ character: INDEX.new_characters[1], template, outline: OUTLINE, userName: '林渡' })[1].content;
  assert.ok(compact.includes('一次性的龙套') && compact.includes('全文 200–320 字') && !compact.includes('来历: ${来历}'));

  const parsed = wbCore.parseEntryReply('```\n' + ENTRY_NPC + '\n```', '备用名', 'npc');
  assert.deepEqual([parsed.entryName, plain(parsed.primary), plain(parsed.secondary), parsed.content.startsWith('基本信息:')], ['莫师傅', ['莫师傅', '老莫'], [], true]);
  assert.throws(() => wbCore.parseEntryReply('<reader_entry_name>莫师傅</reader_entry_name><reader_content>基本信息:\n  姓名: 莫', '莫师傅', 'npc'), /没有写完就断了/);
  assert.throws(() => wbCore.parseEntryReply('<reader_content>太短</reader_content>', '莫师傅', 'npc'), /太短/);
  assert.throws(() => wbCore.parseEntryReply('', '莫师傅', 'npc'), /没有返回条目正文/);
  const untagged = wbCore.parseEntryReply('姓名: 老周（周师傅）\n' + '他在渡口摆了二十年的渡。'.repeat(12), '备用名', 'npc');
  assert.equal(untagged.entryName, '老周', '没按协议加标签时整段当正文，名字从正文里认');
  assert.equal(wbCore.parseEntryReply(ENTRY_TEMP, '书记', 'temp_event').entryName, '港务司书记');

  const entry = wbCore.buildEntry(template, parsed, { chatKey: 'K', volumeId: 'vol-1', floorAnchor: 4, roleKind: 'npc', name: '莫师傅' }, ['老莫']);
  assert.deepEqual(plain(entry.extra.reader_ii_director), { v: 1, chatKey: 'K', volumeId: 'vol-1', floorAnchor: 4, roleKind: 'npc', name: '莫师傅' });
  assert.deepEqual([entry.name, entry.enabled, entry.strategy.type, plain(entry.strategy.keys), entry.position.order, entry.recursion.prevent_incoming], ['莫师傅', true, 'selective', ['莫师傅', '老莫'], 77, true]);
  assert.deepEqual(plain(wbCore.markerOf(entry)), plain(entry.extra.reader_ii_director));
  assert.equal(wbCore.markerOf({ extra: { dream_gacha: { v: 1 } } }), null, '别人建的条目不认');
  /* 模型没给关键词：用条目名、角色名与导演给的叫法兜底。 */
  assert.deepEqual(plain(wbCore.buildEntry(template, { ...parsed, primary: [] }, { name: '莫师傅' }, ['老莫']).strategy.keys), ['莫师傅', '老莫']);
});

test('给新角色建档：复用模板库的模板，条目带记号、不重复写，挂到当前卡，记入改动记录并可撤销', async () => {
  const mine = { id: 'mine', name: '我的模板', templateText: '名字: ${名字}\n来历: ${来历；两百字}', generationInstruction: '照着我的模板写', entryNameRule: '用名字', output: { targetWorldbook: '我的人物志', strategyType: 'selective', keywordMode: 'smart', order: 77 } };
  const h = await activated({ agentSettings: { mode: 'card', approval: 'auto' }, directorSettings: { enabled: true, wbTemplateId: 'mine' }, storage: { reader_ii_template_library_v1: { templates: [mine] } } });
  try {
    assert.deepEqual(plain(h.director.listTemplates().map((item) => [item.id, item.builtin, item.targetWorldbook])), [['mine', false, '我的人物志'], ['reader-default-generic-character', true, 'Reader生成条目']]);
    const pending = h.director.getStatus().pending;
    const npc = pending.find((item) => item.kind === 'npc');
    const result = await h.director.confirmPendingEntry(npc.id);
    assert.deepEqual([result.ok, result.book, result.name, result.skipped], [true, '我的人物志', '莫师傅', false]);
    const call = h.model.of('entry_npc')[0];
    assert.ok(call.last.includes('照着我的模板写') && call.last.includes('来历: ${来历；两百字}') && !call.last.includes('旧账本其实被莫师傅藏在'));
    const entry = h.worldbooks['我的人物志'][0];
    assert.deepEqual([entry.name, entry.enabled, entry.position.order, plain(entry.strategy.keys)], ['莫师傅', true, 77, ['莫师傅', '老莫']]);
    assert.ok(entry.content.startsWith('基本信息:'));
    const mark = entry.extra.reader_ii_director;
    assert.deepEqual([mark.v, mark.chatKey, mark.roleKind, mark.name, mark.floorAnchor, mark.volumeId], [1, JSON.stringify(['card:ailin.png', 'chat-1']), 'npc', '莫师傅', 2, h.director.getStatus().volume.id]);
    assert.deepEqual(plain(h.mounted.additional), ['我的人物志'], '新建的书挂到了当前角色卡上');
    assert.deepEqual(plain(h.director.getStatus().pending.map((item) => item.name)), ['港务司书记']);
    assert.equal(h.director.getStatus().created, 1);

    /* 同一个聊天、同一位角色不重复写：再建一次（比如重构后的大纲又列了他）只会认出已有的那一条。 */
    const wb = h.modules.createDirectorWorldbook(null, h.api.kit, h.api.llm, { vfs: h.vfs, permissions: h.agent.permissions, journal: null });
    const again = await wb.writeEntry({ book: '我的人物志', entry: plain(entry), confirmed: true });
    assert.deepEqual([again.skipped, again.name, h.worldbooks['我的人物志'].length], [true, '莫师傅', 1]);
    assert.equal((await wb.findExisting('我的人物志', mark.chatKey, '莫师傅')).uid, entry.uid);
    /* 书里已有同名的别人的条目：换个名字写，不去覆盖。 */
    h.worldbooks['设定集'].push({ uid: 5, name: '港务司书记', enabled: true, content: '（用户自己写的条目）', strategy: { type: 'selective', keys: [] }, position: {} });
    const other = wbCore.buildEntry(wb.pickTemplate('mine'), wbCore.parseEntryReply(ENTRY_TEMP, '港务司书记', 'temp_event'), { chatKey: mark.chatKey, volumeId: mark.volumeId, roleKind: 'temp_event', name: '港务司书记' });
    const renamed = await wb.writeEntry({ book: '设定集', entry: other, confirmed: true });
    assert.deepEqual([renamed.name, h.worldbooks['设定集'].find((item) => item.uid === 5).content], ['港务司书记（导演建档）', '（用户自己写的条目）']);

    /* 改动记录里有这一笔，撤销之后条目没了。 */
    const runs = await h.agent.listRuns(10);
    const run = runs.find((item) => item.title === '导演 · 新角色建档：莫师傅');
    assert.ok(run && run.changes === 2, '正文与设置各记一处');
    assert.ok(plain(run.notes).some((note) => note.includes('挂到当前角色卡')), '挂书这一步撤销不了，记在备注里');
    const report = await h.agent.undo(run.id);
    assert.deepEqual([report.restored.length, report.conflicts.length], [2, 0]);
    assert.equal(h.worldbooks['我的人物志'].length, 0);
  } finally { h.dispose(); }
});

test('建档走助手的权限体系：只读档位与禁止规则拦得住；「每次询问」时后台不自动写，等用户亲手点', async () => {
  /* 只读档位：写不了，条目标成没写成并给出原因，世界书没被碰过；也不为它白调一次模型之外的任何写入。 */
  const readonly = await activated({ agentSettings: { mode: 'readonly', approval: 'yolo' } });
  try {
    const item = readonly.director.getStatus().pending[0];
    await assert.rejects(() => readonly.director.confirmPendingEntry(item.id), /当前权限档位是「只读」/);
    assert.equal(readonly.worldbooks['Reader生成条目'], undefined);
    const after = readonly.director.getStatus().pending.find((entry) => entry.id === item.id);
    assert.deepEqual([after.status, /只读/.test(after.error)], ['failed', true]);
    assert.equal((await readonly.agent.listRuns(10)).length, 0);
    assert.equal(await readonly.director.discardPendingEntry(item.id), true);
    assert.equal(readonly.director.getStatus().pending.some((entry) => entry.id === item.id), false);
  } finally { readonly.dispose(); }

  /* 禁止规则永远生效，哪怕确认方式是「全部直接执行」。 */
  const denied = await activated({ agentSettings: { mode: 'tavern', approval: 'yolo', rules: [{ effect: 'deny', action: 'write', pattern: 'wb:/Reader生成条目/**' }] } });
  try {
    await assert.rejects(() => denied.director.confirmPendingEntry(denied.director.getStatus().pending[0].id), /权限规则「wb:\/Reader生成条目\/\*\*」禁止了这项操作/);
    assert.equal(denied.worldbooks['Reader生成条目'], undefined);
  } finally { denied.dispose(); }

  /* 策略是「自动写入」、但确认方式是「每次写入前询问」：后台不替用户做主，也不白花一次模型请求；用户亲手点了才写。 */
  const asking = await activated({ agentSettings: { mode: 'card', approval: 'ask' }, directorSettings: { enabled: true, wbPolicy: 'auto' } });
  try {
    await until(() => asking.director.getStatus().pending.every((item) => /等你确认/.test(item.error)), '自动建档停下来等确认');
    assert.equal(asking.model.calls.filter((call) => call.kind.startsWith('entry')).length, 0);
    assert.equal(asking.worldbooks['Reader生成条目'], undefined);
    const item = asking.director.getStatus().pending[0];
    assert.equal((await asking.director.confirmPendingEntry(item.id)).ok, true, '用户亲手点 = 确认');
    assert.equal(asking.worldbooks['Reader生成条目'].length, 1);
  } finally { asking.dispose(); }

  /* 权限允许直接写时，「自动写入」在定稿后挨个建档；「不建档」则连待办都不列。 */
  const auto = await activated({ agentSettings: { mode: 'card', approval: 'auto' }, directorSettings: { enabled: true, wbPolicy: 'auto' } });
  try {
    await until(() => (auto.worldbooks['Reader生成条目'] || []).length === 2 && !auto.director.getStatus().work, '自动建档');
    assert.deepEqual(plain(auto.worldbooks['Reader生成条目'].map((entry) => [entry.name, entry.extra.reader_ii_director.roleKind])), [['莫师傅', 'npc'], ['港务司书记', 'temp_event']]);
    assert.deepEqual([auto.director.getStatus().pending.length, auto.director.getStatus().created], [0, 2]);
    assert.equal((await auto.agent.listRuns(10)).filter((run) => run.title.startsWith('导演 · 新角色建档')).length, 2);
  } finally { auto.dispose(); }
  const none = await activated({ directorSettings: { enabled: true, wbPolicy: 'none' } });
  try {
    assert.equal(none.director.getStatus().pending.length, 0);
  } finally { none.dispose(); }
});

/* ========================================================================================================
 * 其余：编纲的插话与过目、手动修订、看板与设置
 * ====================================================================================================== */

test('自动质检与自查打回重写：发现未过关项或截断时在同一会话自动重写，全通过后才定稿清对话；超限保留断点', async () => {
  /* 场景 A：第 1 稿 <self_check> 残留未通过项 → 自动打回；第 2 稿大纲被截断 → 再打回；第 3 稿通过 → 定稿清草稿。 */
  const unfixed = '<self_check>\n1. 通过\n2. 命名嗅探：未通过，有罐头名\n</self_check>\n'
    + `<volume_outline>\n${OUTLINE}\n</volume_outline>\n<volume_index>\n${JSON.stringify(INDEX)}\n</volume_index>\n<first_brief>\n${brief('Phase 1')}\n</first_brief>`;
  const truncated = '<self_check>\n1. 通过\n</self_check>\n<volume_outline>\n' + OUTLINE.slice(0, 150);
  const okDelivery = delivery(OUTLINE, INDEX, brief('Phase 1 · 雨夜'));
  const h = makeHost({ replies: { plan: [unfixed, truncated, okDelivery] } });
  try {
    await h.director.ready();
    assert.deepEqual(plain(await h.director.activate()), { done: true });
    const plans = h.model.of('plan');
    assert.equal(plans.length, 3, '两次自动打回 + 最终通过共 3 次请求');
    assert.match(plans[1].last, /自动质检打回.*尚未修正/s);
    assert.equal(plans[1].prompts.length, 4, '第 1 次打回在同一会话内追加 assistant + user');
    assert.match(plans[2].last, /自动质检打回.*大纲没有写完就断了/s);
    assert.equal(plans[2].prompts.length, 6, '第 2 次打回继续沿原会话追加');
    assert.equal(h.director.getStatus().state, 'running');
    assert.equal(await h.readJson(h.dir() + '/draft.json'), null, '全通过后立刻清理草稿对话');

    /* 分卷在执导时提意见：按意见重构后续大纲。 */
    const restructured = await h.director.submitFeedback('让莫师傅早点出场');
    assert.equal(restructured.version, 2);
    assert.ok(h.model.of('restructure')[0].last.includes('让莫师傅早点出场') && h.model.of('restructure')[0].last.includes('用户的修订意见（最高优先级）'));
    await assert.rejects(() => h.director.submitFeedback('  '), /先写下你的意见/);
  } finally { h.dispose(); }

  /* 场景 B：连续 3 次都坏（超过 MAX_SELF_REVISIONS = 2）→ 停止并保留断点；修好后点 resume() 沿断点一次定稿。 */
  const hCap = makeHost({ replies: { plan: [truncated, truncated, truncated] } });
  try {
    await hCap.director.ready();
    await assert.rejects(() => hCap.director.activate(), /自动修订 2 次后仍未通过质检/);
    const status = hCap.director.getStatus();
    assert.deepEqual([status.state, status.plan.state, status.plan.revisions, status.plan.hasCheckpoint], ['draft', 'failed', 2, true]);
    assert.equal(await hCap.readJson(hCap.dir() + '/active.json'), null, '质检未过绝不落盘提交');
    hCap.model.table.plan = okDelivery;
    assert.deepEqual(plain(await hCap.director.resume()), { done: true });
    assert.equal(hCap.director.getStatus().state, 'running');
    assert.equal(await hCap.readJson(hCap.dir() + '/draft.json'), null, '续跑通过后清空断点');
  } finally { hCap.dispose(); }
});

test('切走聊天时在途的编纲存成断点草稿并标为中断；回来可以沿断点续编，也可以放弃', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = makeHost({ replies: { plan: async () => { await gate; return delivery(OUTLINE, INDEX, brief('Phase 1 · 雨夜')); } } });
  try {
    await h.director.ready();
    const running = h.director.activate();
    await until(() => h.model.of('plan').length === 1, '编纲开始执行');
    const dir = h.dir();
    const metadataA = h.ctx.chatMetadata, chatA = h.chat.slice();
    h.ctx.chatId = 'chat-2';
    h.ctx.chatMetadata = { variables: {}, reader_ii_enabled: false };
    h.chat.splice(0, h.chat.length, { name: '艾琳', is_user: false, mes: '另一个聊天。' });
    await h.emit('CHAT_CHANGED');
    release();
    assert.deepEqual(plain(await running), { paused: true });
    const draft = await h.readJson(dir + '/draft.json');
    assert.deepEqual([draft.v, draft.state, draft.messages.length], [2, 'interrupted', 1]);
    assert.equal(await h.readJson(dir + '/active.json'), null, '没有把半截大纲提交到任何聊天上');
    await h.director.ready();
    assert.equal(h.director.getStatus().state, 'idle', '新聊天不受影响');

    h.ctx.chatId = 'chat-1';
    h.ctx.chatMetadata = metadataA;
    h.chat.splice(0, h.chat.length, ...chatA);
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    const status = h.director.getStatus();
    assert.deepEqual([status.state, status.plan.state, status.plan.hasCheckpoint], ['draft', 'interrupted', true]);
    h.model.table.plan = delivery(OUTLINE, INDEX, brief('Phase 1 · 雨夜'));
    assert.deepEqual(plain(await h.director.resume()), { done: true });

    /* 放弃这一卷：不归档，点错了还能恢复。 */
    await h.director.discardVolume();
    assert.deepEqual([h.director.getStatus().state, h.director.getStatus().canRestoreArchive, (await h.director.getArchive()).volumes.length], ['idle', true, 0]);
    assert.equal((await h.director.restoreLastArchive()).volumeNo, 1);
    assert.equal(h.director.getStatus().state, 'running');
  } finally { h.dispose(); }
});

test('手动修订：改大纲存成新版本并从当前楼层起生效；快照可以回退；直接改 outline.md 也会被收进来', async () => {
  const h = await activated();
  try {
    const dir = h.dir();
    await h.turn('我接过毛巾。', '她朝窗外抬了抬下巴。');
    const edited = OUTLINE.replace('#### Phase 3：清点之日', '#### Phase 3：清点之日\n#### Phase 4：雨停之后');
    assert.deepEqual(plain(await h.director.saveOutline(edited)), { version: 2 });
    let outline = await h.director.getOutline();
    assert.deepEqual([outline.version, outline.index.totalPhases, outline.index.title, outline.text === edited], [2, 4, '雨季的钟', true]);
    assert.equal(await h.vfs.readText(dir + '/outline.md'), edited);
    assert.deepEqual(plain(outline.versions.map((item) => [item.n, item.note])), [[1, '首次编纲'], [2, '手动修订']]);
    await assert.rejects(() => h.director.saveOutline('太短'), /大纲太短/);
    /* 下一次巡检用的是新大纲：静态前缀跟着换。 */
    await h.turn('我出了门。', '雨小了。');
    assert.ok(h.model.of('judge').at(-1).system.includes('#### Phase 4：雨停之后'));

    /* 让助手（或用户）直接改 outline.md：下一次巡检时当成手动修订收进来。 */
    const direct = edited.replace('#### Phase 4：雨停之后', '#### Phase 4：雨停之后\n#### Phase 5：渡船开了');
    await h.vfs.write(dir + '/outline.md', direct);
    await h.turn('我往钟楼走。', '钟声响了三下。');
    outline = await h.director.getOutline();
    assert.deepEqual([outline.version, outline.index.totalPhases, outline.versions.at(-1).note], [3, 5, '直接改了 outline.md']);
    assert.ok(h.model.of('judge').at(-1).system.includes('#### Phase 5：渡船开了'));

    /* 快照列表：从新到旧；把最早的那条用到当前楼层上 → 大纲版本、状态、简报一起回去。 */
    const list = await h.director.listSnapshots();
    assert.ok(list.length >= 4 && list[0].current === true && list.at(-1).kind === 'base', JSON.stringify(list.map((item) => [item.floor, item.kind, item.current])));
    assert.deepEqual([list.at(-1).outlineVersion, list.at(-1).matches], [1, true]);
    await h.director.rollbackTo(list.at(-1).id);
    const rolled = await h.director.getOutline();
    assert.deepEqual([rolled.version, rolled.text === OUTLINE], [1, true]);
    assert.equal(await h.vfs.readText(dir + '/outline.md'), OUTLINE);
    assert.match((await h.director.getBrief()).text, /Phase 1 · 雨夜/);
    assert.equal((await h.director.listSnapshots())[0].kind, 'manual');
    await assert.rejects(() => h.director.rollbackTo('没有这条'), /已经不在了/);
  } finally { h.dispose(); }
});

test('档案是工作区里的普通文件：被改坏、被塞进奇怪的值时，读回来按类型收敛，不把脏数据交给界面与提示词', async () => {
  /* 纯逻辑：快照与版本表逐字段规范化。 */
  const dirty = core.normalizeSnapshots({
    versions: { 1: { outline: OUTLINE, index: { title: '<b>卷</b>', phases: [{ n: '2', title: '<i>乙</i>' }, { n: 1, title: '甲' }], totalPhases: 'NaN' }, note: 7 }, 坏键: { outline: 'x' }, 3: 'x' },
    base: { id: 5, floor: '<img src=x onerror=alert(1)>', contentHash: 9, outlineVersion: '<x>', kind: '<script>', at: 'soon', state: { phaseCursor: '<b>9</b>', facts: [1, '', '事实'], patches: 'x', turn: -4 }, brief: 42 },
    ring: [null, 'x', { floor: 4.9, contentHash: 'abc', tailHash: 'def', outlineVersion: 2.7, kind: 'patrol', state: { phaseCursor: 2, driftLevel: 9 }, brief: '简报' }],
  });
  assert.deepEqual(Object.keys(dirty.versions), ['1']);
  assert.deepEqual(plain(dirty.versions[1].index), { title: '<b>卷</b>', phases: [{ n: 1, title: '甲' }, { n: 2, title: '<i>乙</i>' }], totalPhases: 2, newCharacters: [], inferred: false });
  assert.deepEqual([dirty.versions[1].note, dirty.versions[1].at], ['7', 0]);
  assert.deepEqual([dirty.base.id, dirty.base.floor, dirty.base.contentHash, dirty.base.outlineVersion, dirty.base.kind, dirty.base.at, dirty.base.brief], ['5', -1, '', 1, 'patrol', 0, '42']);
  assert.deepEqual([dirty.base.state.phaseCursor, plain(dirty.base.state.facts), dirty.base.state.patches.length, dirty.base.state.turn], [1, ['1', '事实'], 0, 0]);
  assert.deepEqual([dirty.ring.length, dirty.ring[0].floor, dirty.ring[0].outlineVersion, dirty.ring[0].state.driftLevel], [1, 4, 2, 2]);
  assert.deepEqual(plain(core.normalizeSnapshots('坏的')), { v: 1, versions: {}, base: null, ring: [] });

  /* 运行器：把落盘的档案改脏再重新读入（切走再切回来）。 */
  const h = await activated();
  try {
    const dir = h.dir();
    const active = await h.readJson(dir + '/active.json');
    Object.assign(active, { volumeNo: '<img src=x onerror=alert(1)>', title: 12345, baseTurn: 'x', outlineVersion: '<b>', paused: 'yes', failStreak: -3, pausedBy: { a: 1 },
      pendingEntries: [{ id: 7, name: '<b>莫师傅</b>', kind: '<x>', brief: 9, status: 'writing', error: null }, 'x', { name: '' }], createdEntries: 'x' });
    await h.vfs.write(dir + '/active.json', JSON.stringify(active));
    const snaps = await h.readJson(dir + '/snapshots.json');
    snaps.base.state.phaseCursor = '<svg onload=alert(1)>';
    snaps.ring = 'x';
    await h.vfs.write(dir + '/snapshots.json', JSON.stringify(snaps));
    const metadata = h.ctx.chatMetadata;
    h.ctx.chatId = 'chat-2';
    h.ctx.chatMetadata = { variables: {}, reader_ii_enabled: false };
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    h.ctx.chatId = 'chat-1';
    h.ctx.chatMetadata = metadata;
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    const status = h.director.getStatus();
    assert.deepEqual([status.state, status.volume.no, status.volume.title, status.volume.version, status.volume.phaseCursor, status.volume.baseTurn, status.paused, status.failStreak, status.pausedBy],
      ['running', 0, '12345', 1, 1, 0, false, 0, '']);
    assert.deepEqual(plain(status.pending), [{ id: '7', name: '<b>莫师傅</b>', kind: 'npc', brief: '9', status: 'pending', error: '' }]);
    assert.equal(status.created, 0);
    assert.match(await h.director.briefFor('normal'), /Phase 1 · 雨夜/, '基线快照还在，照常注入');
    /* 快照文件整个没了：没法注入也没法巡检，回到空闲而不是报错。 */
    await h.vfs.remove(dir + '/snapshots.json');
    h.ctx.chatId = 'chat-2';
    h.ctx.chatMetadata = { variables: {}, reader_ii_enabled: false };
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    h.ctx.chatId = 'chat-1';
    h.ctx.chatMetadata = metadata;
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    assert.deepEqual([h.director.getStatus().state, h.director.injectable()], ['idle', false]);
  } finally { h.dispose(); }
});

test('后台任务看板、设置与偏好：牌子的生命周期、按级别过滤、偏好两层合并进提示词', async () => {
  /* 看板本身。 */
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  vm.runInContext(read('src/agent/jobs.js'), ctx);
  const board = ctx.__ReaderIIModules.createJobBoard();
  const seen = [];
  const off = board.onChange((job, reason) => seen.push(reason + ':' + job.state));
  let cancelled = 0;
  const job = board.start({ owner: 'director', kind: 'plan', title: '导演 · 编纲', steps: 4, cancel: () => { cancelled += 1; } });
  const minor = board.start({ owner: 'director', kind: 'patrol', level: 'minor', title: '导演 · 后台巡检' });
  job.update({ stage: '第 2 步', step: 2 });
  job.log('第 1 步完成');
  assert.deepEqual(plain(board.list().map((item) => [item.kind, item.level, item.state, item.step, item.canCancel])), [['patrol', 'minor', 'running', 0, false], ['plan', 'major', 'running', 2, true]], '从新到旧');
  assert.equal(board.busy(), true);
  assert.deepEqual([board.cancel(job.id), cancelled, board.cancel(minor.id)], [true, 1, false]);
  minor.done('L0 顺轨');
  job.fail(new Error('模型没有回复'));
  assert.deepEqual(plain(board.list().map((item) => [item.kind, item.state, item.result])), [['patrol', 'done', 'L0 顺轨'], ['plan', 'failed', '模型没有回复']]);
  assert.equal(board.busy(), false);
  assert.deepEqual([board.dismiss(job.id), board.list().length], [true, 1]);
  off();
  assert.ok(seen.includes('start:running') && seen.includes('end:failed') && seen.includes('remove:failed'));

  /* 设置的归一化。 */
  assert.deepEqual(plain(core.normalizeSettings(null)), plain(core.DEFAULT_SETTINGS));
  const odd = core.normalizeSettings({ enabled: 'yes', injectEvery: 0, patrolEvery: 99, planMode: 'x', wbPolicy: 'auto', floatMode: 'major', plannerMaxTokens: 10, timeoutMs: 1, l2Cooldown: -3 });
  assert.deepEqual([odd.enabled, odd.injectEvery, odd.patrolEvery, odd.planMode, odd.wbPolicy, odd.floatMode, odd.plannerMaxTokens, odd.timeoutMs, odd.l2Cooldown], [false, 1, 20, 'auto', 'auto', 'major', 2048, 20000, 0]);
  /* 勘察预算：窗口的一半折成字，6K–36K；窗口小的模型再按余量收紧。各段按权重分，短的把余额让出来。 */
  assert.equal(core.reconBudget(200000, 13000, 8192), 36000);
  assert.equal(core.reconBudget(8000, 0, 0), 5348);
  assert.ok(core.reconBudget(32768, 13000, 8192) < core.reconBudget(32768, 0, 0));
  const shares = core.allocateBudget(1000, [{ key: 'a', weight: 1, size: 100 }, { key: 'b', weight: 1, size: 5000 }, { key: 'c', weight: 2, size: 5000 }, { key: 'd', weight: 1, size: 0 }]);
  assert.deepEqual(plain(shares), { a: 100, b: 300, c: 600 });
  const composed = core.composeMaterials([{ key: 'x', title: '甲', text: '短', weight: 1 }, { key: 'y', title: '乙', text: '正文'.repeat(500), weight: 1, tail: true }, { key: 'z', title: '空的', text: '' }], 200);
  assert.ok(composed.text.includes('### 甲\n短') && composed.text.includes('### 乙\n…') && !composed.text.includes('空的') && composed.used.y <= 199);
  assert.equal(core.summarizeWorldbook([{ name: '乙', enabled: true, content: '乙的正文', position: { order: 5 } }, { name: '关着的', enabled: false, content: 'x' },
    { name: '甲', enabled: true, content: '甲的正文', strategy: { type: 'constant' } }]), '- [常驻] 甲：甲的正文\n- 乙：乙的正文');
  assert.match(core.summarizeVariables({ 主角: { 金币: 37, 背包: [1, 2, 3, 4, 5, 6, 7, 8] } }, 3, 200), /"金币":37.*共 8 项/);

  const h = makeHost();
  try {
    await h.director.ready();
    await h.director.savePreferences({ global: '不要为了深刻硬凑代价', card: '她和主角已经是过命的交情' });
    const prefs = await h.director.getPreferences();
    assert.deepEqual([prefs.global, prefs.card, prefs.hasCard, prefs.cardLabel], ['不要为了深刻硬凑代价', '她和主角已经是过命的交情', true, '艾琳']);
    assert.equal(await h.vfs.readText('ws:/director/preferences.md'), '不要为了深刻硬凑代价');
    assert.equal(await h.vfs.readText('ws:/director/cards/' + core.hashId('card:ailin.png') + '/preferences.md'), '她和主角已经是过命的交情');
    await h.director.activate();
    const system = h.model.of('plan')[0].system;
    assert.ok(system.includes('【全局偏好】\n不要为了深刻硬凑代价') && system.includes('【这张卡的偏好（与全局冲突时以这里为准）】\n她和主角已经是过命的交情'));
    /* 偏好跟卡走：换一个聊天还在；巡检也带着。 */
    await h.turn('我接过毛巾。', '她朝窗外抬了抬下巴。');
    assert.ok(h.model.of('judge')[0].system.includes('她和主角已经是过命的交情'));
    h.ctx.chatId = 'chat-2';
    h.ctx.chatMetadata = { variables: {}, reader_ii_enabled: false };
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    assert.equal((await h.director.getPreferences()).card, '她和主角已经是过命的交情');
    await h.director.savePreferences({ card: '' });
    assert.equal(await h.vfs.readText('ws:/director/cards/' + core.hashId('card:ailin.png') + '/preferences.md'), null);

    /* 设置随账号走（extension_settings），并留一份本机兜底；对外入口挂在 ReaderII.agent.director 与 ReaderII.director 上。 */
    const saved = h.director.saveSettings({ patrolEvery: 3, floatMode: 'major', timeoutMs: 5 });
    assert.deepEqual([saved.patrolEvery, saved.floatMode, saved.timeoutMs], [3, 'major', 20000]);
    assert.equal(h.ctx.extensionSettings.reader_ii.director.patrolEvery, 3);
    assert.equal(JSON.parse(h.storage.get('reader_ii_director_settings_v1')).floatMode, 'major');
    assert.equal(h.api.agent.director, h.director);
    assert.equal(typeof h.api.jobs.onChange, 'function');
    const placement = h.modules.readerPromptPlacement.placements(h.ctx);
    assert.deepEqual([placement.director.enabled, placement.director.position, placement.director.depth, placement.director.order], [true, 4, 1, 300]);
  } finally { h.dispose(); }
});

/* ========================================================================================================
 * 7. 总导演真 Agent（只读 VFS 工具探索、全量轻索引、白名单隔离、协议回退与防空转）
 * ====================================================================================================== */

test('世界书全量目录索引不遗漏末尾绿灯条目；变量全景探测同时覆盖 MVU 与小白X并过滤内部噪点键', () => {
  /* 构造 1 条常驻 + 20 条绿灯关键词条目（末尾为关键人物「格温」且正文很长），另有同名条目与关闭条目。 */
  const entries = [
    { uid: 0, name: '世界概览', enabled: true, content: '长背景'.repeat(400), strategy: { type: 'constant', keys: [] }, position: { order: 100 } },
    { uid: 1, name: '关闭的条目', enabled: false, content: '不应该出现', strategy: { type: 'selective', keys: ['隐藏'] }, position: { order: 99 } },
  ];
  for (let i = 1; i <= 18; i += 1) {
    entries.push({ uid: i + 1, name: '绿灯设定' + i, enabled: true, content: '内容'.repeat(300), strategy: { type: 'selective', keys: ['关键词' + i] }, position: { order: 50 - i } });
  }
  entries.push({ uid: 90, name: '重复名', enabled: true, content: '第一份正文', strategy: { type: 'selective', keys: ['甲'] }, position: { order: 10 } });
  entries.push({ uid: 91, name: '重复名', enabled: true, content: '第二份正文', strategy: { type: 'selective', keys: ['乙'] }, position: { order: 9 } });
  entries.push({ uid: 99, name: '格温', enabled: true, content: '前段公开信息。' + '铺垫'.repeat(400) + '中后段隐秘设定：格温藏着半枚银徽章。', strategy: { type: 'selective', keys: ['格温', '银发'] }, position: { order: 1 } });

  const map = core.indexWorldbook('命定之诗', entries, { tag: '[角色主书]' });
  assert.ok(map.includes('【命定之诗】 [角色主书]（启用 22 条）'));
  assert.ok(map.includes('wb:/命定之诗/世界概览 ｜ 世界概览 ｜ 常驻 ｜ 1200 字'));
  assert.ok(map.includes('wb:/命定之诗/格温 ｜ 格温 ｜ 关键词（格温、银发） ｜ '));
  assert.ok(map.includes('wb:/命定之诗/重复名%2390') && map.includes('wb:/命定之诗/重复名%2391'), '同名条目按 uid 区分并编码');
  assert.ok(!map.includes('关闭的条目'), '未启用条目不列入');
  assert.ok(!map.includes('中后段隐秘设定'), '轻索引目录不截正文塞入，由导演按路径 read 全文');
  for (let i = 1; i <= 18; i += 1) assert.ok(map.includes('wb:/命定之诗/绿灯设定' + i), '不遗漏绿灯设定 ' + i);

  /* composeMaterials 的 preserve 保护：即使近期正文非常长，全量目录与变量探测也不会被截丢末尾绿灯条目。 */
  const composed = core.composeMaterials([
    { key: 'persona', title: '主角', text: '实名：林渡', weight: 8, preserve: true },
    { key: 'books', title: '世界书全量目录地图', text: map, weight: 24, preserve: true },
    { key: 'floors', title: '近期正文', text: '旧楼层正文。'.repeat(6000), weight: 40, tail: true },
  ], 5000);
  assert.ok(composed.text.includes('wb:/命定之诗/格温'), 'preserve 保全末尾绿灯条目不被正文挤掉');

  /* 变量全景探测：同时覆盖 mvu.json、chat.json（含小白X变量）与 character.json，彻底过滤 reader_ii_* 等内部噪点。 */
  const varIndex = core.indexVariableSources([
    { path: 'var:/mvu.json', label: 'MVU / 最新楼层变量', data: { stat_data: { 时间: '雨季第三日', 角色: { 艾琳: { 信任: 82 } } }, display_data: { 金币: '37枚' }, 楼层临时标记: '暴雨' } },
    { path: 'var:/chat.json', label: '聊天变量（含小白X等）', data: {
      reader_ii_director: { enabled: true }, reader_ii_director_ref: { chatHash: 'abc' }, reader_ii_agent: { turns: [] }, dream_persona: 'reader',
      小白X角色状态: { 格温: { 好感: 74, 秘密进度: 2 } }, 随身铜币: 19,
    } },
    { path: 'var:/character.json', label: '角色卡变量', data: { 阵营声望: { 旧港商会: 12 }, reader_ii_internal: 1 } },
  ]);
  assert.ok(varIndex.includes('var:/mvu.json#/stat_data/时间') && varIndex.includes('var:/mvu.json#/stat_data/角色'));
  assert.ok(varIndex.includes('var:/message/latest.json#/楼层临时标记'));
  assert.ok(varIndex.includes('var:/chat.json#/小白X角色状态') && varIndex.includes('var:/chat.json#/随身铜币'));
  assert.ok(varIndex.includes('var:/character.json#/阵营声望'));
  for (const noise of ['reader_ii_director', 'reader_ii_agent', 'reader_ii_internal', 'dream_persona']) {
    assert.ok(!varIndex.includes(noise), '过滤内部噪点键：' + noise);
  }

  /* 人类可读工具轨迹文案 */
  assert.equal(core.describeToolCall('read', { path: 'wb:/命定之诗/格温' }), '查阅世界书 wb:/命定之诗/格温');
  assert.equal(core.describeToolCall('read', { path: 'var:/chat.json#/人物状态' }), '查看变量 var:/chat.json#/人物状态');
  assert.equal(core.describeToolCall('grep', { path: 'chat:/', pattern: '铜币' }), '搜索历史 chat:/ 关键词「铜币」');
});

/* 为真 Agent 测试构建带独立 API 原生工具后端、多源变量与多条目世界书的宿主。 */
function makeNativeDirectorHost(options = {}) {
  const backendCalls = [];
  const chat = options.chat || [
    { name: '艾琳', is_user: false, mes: '开场：柜台下压着一枚刻字的旧铜币。' },
    { name: '林渡', is_user: true, mes: '我推开酒馆门。' },
    { name: '艾琳', is_user: false, mes: '她擦着杯子说雨还没停。' },
  ];
  const worldbooks = options.worldbooks || {
    命定之诗: [
      { uid: 0, name: '旧港规矩', enabled: true, content: '旧港宵禁从子时开始。', strategy: { type: 'constant', keys: [] }, position: { order: 100 } },
      { uid: 1, name: '格温', enabled: true, content: '表层：钟表铺学徒。\n' + '日常。'.repeat(120) + '\n中后段隐秘设定：格温其实保管着旧港渡船的备用舵钥匙。', strategy: { type: 'selective', keys: ['格温', '学徒'] }, position: { order: 10 } },
    ],
  };
  const variables = {
    chat: {
      reader_ii_director: { enabled: true },
      reader_ii_agent: { v: 2, turns: [] },
      人物状态: { 格温: { 好感度: 68, 戒心: '低', 携带物: ['备用舵钥匙', '磨损怀表'] } },
      ...(options.chatVars || {}),
    },
    mvu: {
      stat_data: { 天气: '大雨', 资金: { 铜币: 24 } },
      ...(options.mvuVars || {}),
    },
    character: { 初始阵营: '旧港修表行', ...(options.charVars || {}) },
    global: {},
  };
  const preset = { id: 'dir-preset', name: '总导演专用', apiurl: 'https://dir.test/v1', key: 'dir-secret', model: 'director-flagship', source: 'openai' };
  const storage = {
    reader_ii_independent_api_v2: { version: 2, presets: [preset], defaultId: preset.id, routes: {} },
    reader_ii_task_connections_v1: { director: { selected: preset.id, model: 'director-flagship', enabled: true, effort: 'high' } },
    ...(options.storage || {}),
  };

  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith('/status') || url.endsWith('/models')) {
      return Response.json({ data: [{ id: 'director-flagship', context_length: 128000, supported_reasoning_efforts: ['low', 'high'] }] });
    }
    if (url === '/api/backends/chat-completions/generate' || url.endsWith('/chat/completions')) {
      backendCalls.push({ url, body: plain(body), headers: plain(init.headers) });
      const res = await options.backend(body, backendCalls.length, init.signal);
      const status = res && res.status ? res.status : 200;
      const payload = res && res.status ? res.body : res;
      return { ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload), json: async () => plain(payload) };
    }
    throw new Error('unexpected fetch: ' + url);
  };

  const h = makeHost({ chat, storage, fetch, agentSettings: options.agentSettings, directorSettings: options.directorSettings });
  /* 覆盖世界书与变量读取接口，模拟真实酒馆中的多源变量（MVU + 小白X聊天变量 + 角色卡变量） */
  Object.keys(h.worldbooks).forEach((k) => delete h.worldbooks[k]);
  Object.assign(h.worldbooks, worldbooks);
  h.host.TavernHelper.getCharWorldbookNames = () => ({ primary: Object.keys(worldbooks)[0], additional: [] });
  h.ctx.chatMetadata.variables = variables.chat;
  h.host.TavernHelper.getVariables = (opt) => {
    if (!opt || opt.type === 'chat') return plain(variables.chat);
    if (opt.type === 'character') return plain(variables.character);
    if (opt.type === 'global') return plain(variables.global);
    if (opt.type === 'message') return plain(variables.mvu);
    return {};
  };
  return { ...h, backendCalls, variables };
}

const nativeReply = (message, finish = 'stop') => ({ choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }] });
const toolCall = (name, args, id = 'c_' + name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('总导演真 Agent 单会话原生工具循环：并行查阅世界书与小白X变量、白名单拒写、一轮成稿定稿清史、实时可观测日志', async () => {
  const jobSnapshots = [];
  const h = makeNativeDirectorHost({
    backend: (body, seq) => {
      const sys = String(body.messages[0].content);
      if (sys.includes('分卷导演 · 场记')) return nativeReply({ content: judge() });
      if (body.messages.some((m) => String(m.content || '').includes('## 结构重构'))) {
        /* 定稿后插话触发 L2 重构：总导演同样可在重构里调只读工具查变量！ */
        if (!body.messages.some((m) => m.role === 'tool')) {
          return nativeReply({ tool_calls: [toolCall('read', { path: 'var:/mvu.json#/stat_data/资金' }, 'c_mvu')] }, 'tool_calls');
        }
        assert.ok(body.messages.at(-1).content.includes('"铜币": 24'));
        return nativeReply({ content: delivery(OUTLINE_V2, { title: '雨季的钟', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] }, brief('重构 Phase 1'), '核实资金变量后重构') });
      }
      /* 单会话开卷：第 1 轮并行查世界书绿灯条目全文 + 小白X变量深层结构 + 搜历史楼层，并顺手试探写工具 write（应被拦截） */
      if (seq === 1) {
        return nativeReply({
          content: '',
          tool_calls: [
            toolCall('read', { path: 'wb:/命定之诗/格温' }, 'c_wb'),
            toolCall('read', { path: 'var:/chat.json#/人物状态/格温' }, 'c_var'),
            toolCall('grep', { path: 'chat:/', pattern: '旧铜币' }, 'c_grep'),
            toolCall('write', { path: 'wb:/命定之诗/格温', content: '非法篡改' }, 'c_bad_write'),
          ],
        }, 'tool_calls');
      }
      if (seq === 2) {
        /* 验证工具返回里拿到了世界书后段隐秘设定、小白X变量完整结构、历史命中，且 write 被拦截拒绝；一轮直接交付完整四段成果 */
        const toolMsgs = body.messages.filter((m) => m.role === 'tool');
        assert.equal(toolMsgs.length, 4);
        assert.ok(toolMsgs[0].content.includes('中后段隐秘设定：格温其实保管着旧港渡船的备用舵钥匙'));
        assert.ok(toolMsgs[1].content.includes('"好感度": 68') && toolMsgs[1].content.includes('备用舵钥匙'));
        assert.ok(toolMsgs[2].content.includes('chat:/0:1:') && toolMsgs[2].content.includes('旧铜币'));
        assert.match(toolMsgs[3].content, /未执行.*禁止调用「write」/);
        return nativeReply({ content: delivery(OUTLINE, INDEX, brief('Phase 1 · 雨夜')) });
      }
      return nativeReply({ content: 'ok' });
    },
  });
  try {
    await h.director.ready();
    /* 验证白名单列表：只含只读工具，严禁出现写/删/脚本/联网工具 */
    const listed = h.director.listReadonlyTools().map((t) => t.name);
    for (const okTool of ['ls', 'read', 'grep']) assert.ok(listed.includes(okTool), '缺少核心只读工具 ' + okTool);
    for (const badTool of ['write', 'edit', 'remove', 'run_js', 'slash_run', 'web_fetch', 'device_exec', 'delegate_task', 'toolbox']) {
      assert.ok(!listed.includes(badTool), '禁止向总导演暴露 ' + badTool);
    }

    const off = h.api.jobs.onChange((job) => {
      if (job.owner === 'director') jobSnapshots.push({ stage: job.stage, lines: job.lines.slice() });
    });

    const result = await h.director.activate();
    assert.deepEqual(plain(result), { done: true });

    /* 1. 验证原世界书未被非法篡改，且不占主助手锁、不写夜梦历史、不带夜梦人格 */
    assert.ok(h.worldbooks.命定之诗[1].content.includes('中后段隐秘设定') && !h.worldbooks.命定之诗[1].content.includes('非法篡改'));
    assert.equal(h.agent.isBusy(), false);
    assert.equal(h.agent.getHistory().length, 0);
    assert.ok(!h.backendCalls[0].body.messages[0].content.includes('九十九夜梦'));

    /* 2. 验证声明给模型的 tools 白名单只含只读工具，且整轮只发 2 次请求（1 轮工具探索 + 1 轮一气呵成定稿） */
    const declared = h.backendCalls[0].body.tools.map((t) => t.function.name);
    assert.ok(declared.includes('ls') && declared.includes('read') && declared.includes('grep'));
    assert.ok(!declared.some((n) => ['write', 'edit', 'remove', 'run_js', 'toolbox', 'delegate_task'].includes(n)));
    assert.equal(h.backendCalls.length, 2, '单会话两轮（工具查阅 + 完整交付）直接定稿，不拆四步');

    /* 3. 验证 append-only 前缀缓存：第 2 轮请求严格保留第 1 轮的 System 与初始 User 前缀 */
    assert.deepEqual(plain(h.backendCalls[1].body.messages.slice(0, 2)), plain(h.backendCalls[0].body.messages.slice(0, 2)));

    /* 4. 验证实时可观测性：jobs 看板实时记录人类可读探索轨迹 */
    const allLogs = jobSnapshots.flatMap((s) => s.lines).join('\n');
    assert.ok(allLogs.includes('查阅世界书 wb:/命定之诗/格温'), '实时日志包含世界书路径');
    assert.ok(allLogs.includes('查看变量 var:/chat.json#/人物状态/格温'), '实时日志包含变量路径');
    assert.ok(allLogs.includes('搜索历史 chat:/ 关键词「旧铜币」'), '实时日志包含历史检索');
    assert.ok(allLogs.includes('已拦截未授权工具：write'), '实时日志记录非法写工具拦截');

    /* 5. 定稿清史：草稿删除；随后场记巡检仍是无工具单步（不带 tools，不带探索历史） */
    assert.equal(await h.readJson(h.dir() + '/draft.json'), null);
    h.chat.push({ name: '林渡', is_user: true, mes: '我问格温铜币的事。' }, { name: '艾琳', is_user: false, mes: '格温低头拧紧了发条。' });
    await h.director.patrolNow();
    const judgeCall = h.backendCalls.find((c) => c.body.messages[0].content.includes('分卷导演 · 场记'));
    assert.ok(judgeCall, '场记完成巡检');
    assert.equal(judgeCall.body.tools, undefined, '场记保持无工具轻量架构');
    assert.equal(judgeCall.body.messages.length, 2, '场记无状态单步，不含编纲探索历史');

    /* 6. 定稿后用户插话修订（L2 重构）：总导演同样能调只读工具核实变量，完成后清空探索记录 */
    const revised = await h.director.submitFeedback('先查一下 var:/mvu.json 的资金，再把后续改成渡口改道');
    assert.equal(revised.version, 2);
    off();
  } finally { h.dispose(); }
});

test('上游故障精确断点续传、工作态编纲与重构实时自由插话、连接器静态只读工具过滤', async () => {
  /* 场景 A：第 1 轮查完世界书落盘断点，第 2 轮上游持续 502 崩溃 → 修好后 resume() 沿原生断点续跑，绝不重复读第 1 轮资料、绝不误降级文本协议 */
  let upstreamDown = true;
  const hResume = makeNativeDirectorHost({
    backend: (body) => {
      const hasWbTool = body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c_wb_once');
      if (!hasWbTool) {
        return nativeReply({ tool_calls: [toolCall('read', { path: 'wb:/命定之诗/格温' }, 'c_wb_once')] }, 'tool_calls');
      }
      if (upstreamDown) {
        return { status: 502, body: { error: { message: 'upstream gateway down' } } };
      }
      assert.ok(Array.isArray(body.tools) && body.tools.length > 0, '上游 502 不误降级为文本协议，续传仍走原生工具');
      assert.ok(body.messages.some((m) => m.role === 'tool' && m.content.includes('备用舵钥匙')), '续传时已保留此前查到的世界书结果');
      return nativeReply({ content: delivery(OUTLINE, INDEX, brief('断点续传成稿')) });
    },
  });
  try {
    /* 验证宿主已装 MVU 与柏宝书插件：仅暴露静态只读工具，绝不暴露写工具和试算工具 */
    hResume.host.Mvu = { getMvuData: () => ({ stat_data: { 天气: '大雨' } }), parseMessage: async () => null, replaceMvuData: async () => {} };
    hResume.host.STBaiBaiBook = { getSnapshot: async () => ({ state: { location: '旧港' } }), query: async () => ({ ok: true }) };
    hResume.agent.listConnectors();
    const names = hResume.director.listReadonlyTools().map((t) => t.name);
    assert.ok(names.includes('mvu_inspect') && names.includes('baibai_query'), '纳入已启用连接器的纯只读查询工具');
    assert.ok(!names.includes('mvu_apply_update') && !names.includes('mvu_test_update'), '严禁暴露写入与试算工具');

    await hResume.director.ready();
    await assert.rejects(() => hResume.director.activate(), /502|gateway/);
    const draft = await hResume.readJson(hResume.dir() + '/draft.json');
    assert.deepEqual([draft.v, draft.state, draft.protocol, draft.rounds, draft.toolCalls], [2, 'failed', 'native', 1, 1]);
    assert.ok(draft.messages.some((m) => m.role === 'tool' && m.content.includes('备用舵钥匙')), '工具结果已持久化进 draft.json 断点');
    assert.equal(await hResume.readJson(hResume.dir() + '/active.json'), null, '失败前绝不提交');

    /* 修好上游后沿断点续编：不再重发 c_wb_once，一次定稿并清空 draft.json */
    upstreamDown = false;
    assert.deepEqual(plain(await hResume.director.resume()), { done: true });
    assert.equal(await hResume.readJson(hResume.dir() + '/draft.json'), null, '续编定稿后清空草稿');
    assert.equal(hResume.backendCalls.filter((c) => !c.body.messages.some((m) => m.role === 'tool')).length, 1, '绝不重复跑第 1 轮已查工具');
  } finally { hResume.dispose(); }

  /* 场景 B：工作态自由插话（Inbox 架构）——编纲进行中连点两次插话与重构进行中插话，即时入队零轮询，原任务保留已查资料无缝完成 */
  let holdPlan = true, holdRestructure = true;
  const hLive = makeNativeDirectorHost({
    backend: async (body, seq, signal) => {
      const waitAbort = () => new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        if (signal && signal.aborted) abort();
        else if (signal) signal.addEventListener('abort', abort, { once: true });
      });
      const isRestructure = body.messages.some((m) => String(m.content || '').includes('## 结构重构'));
      if (!isRestructure) {
        const hasWb = body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c_live_wb');
        const hasInterject1 = body.messages.some((m) => m.role === 'user' && String(m.content).includes('顺手查一下格温的好感度'));
        const hasInterject2 = body.messages.some((m) => m.role === 'user' && String(m.content).includes('再加一条：雨天不要跳日'));
        const hasVar = body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c_live_var');
        if (!hasWb) return nativeReply({ tool_calls: [toolCall('read', { path: 'wb:/命定之诗/格温' }, 'c_live_wb')] }, 'tool_calls');
        if (holdPlan && !hasInterject1) {
          holdPlan = false;
          await waitAbort();
        }
        assert.ok(hasWb && hasInterject1 && hasInterject2, 'Inbox 连点两次插话全部保留，且不丢此前已查世界书');
        if (!hasVar) return nativeReply({ tool_calls: [toolCall('read', { path: 'var:/chat.json#/人物状态/格温' }, 'c_live_var')] }, 'tool_calls');
        assert.ok(body.messages.at(-1).content.includes('"好感度": 68'));
        return nativeReply({ content: delivery(OUTLINE, { ...INDEX, title: '格温与旧铜币' }, brief('插话后成稿')) });
      }
      /* 重构进行中实时插话 */
      const hasMvu = body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c_rs_mvu');
      const hasRsNote = body.messages.some((m) => m.role === 'user' && String(m.content).includes('把标题改成渡口新局'));
      if (!hasMvu) return nativeReply({ tool_calls: [toolCall('read', { path: 'var:/mvu.json#/stat_data/资金' }, 'c_rs_mvu')] }, 'tool_calls');
      if (holdRestructure && !hasRsNote) {
        holdRestructure = false;
        await waitAbort();
      }
      assert.ok(hasMvu && hasRsNote, '重构中途插话保留已查变量结果并带上新要求');
      return nativeReply({ content: delivery(OUTLINE_V2, { title: '渡口新局', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] }, brief('重构插话成稿'), '按实时插话改题') });
    },
  });
  try {
    await hLive.director.ready();
    const planning = hLive.director.activate();
    await until(() => !holdPlan, '编纲查完第 1 轮资料并挂起等待第 2 轮');
    /* 用户连点两次实时插话：全部立即入队不丢单、不换锁、不轮询 */
    const q1 = await hLive.director.submitFeedback('顺手查一下格温的好感度，把她列为核心人物');
    const q2 = await hLive.director.submitFeedback('再加一条：雨天不要跳日');
    assert.deepEqual(plain(q1), { queued: true, kind: 'plan' });
    assert.deepEqual(plain(q2), { queued: true, kind: 'plan' });
    assert.deepEqual(plain(await planning), { done: true });
    assert.equal(hLive.director.getStatus().volume.title, '格温与旧铜币');

    /* 执导中发起重构，中途再实时插话 */
    const restructuring = hLive.director.restructureNow('手动重构');
    await until(() => !holdRestructure, '重构查完第 1 轮变量并挂起等待第 2 轮');
    const qRs = await hLive.director.submitFeedback('把标题改成渡口新局');
    assert.deepEqual(plain(qRs), { queued: true, kind: 'restructure' });
    const rsRes = await restructuring;
    assert.equal(rsRes.version, 2);
    assert.equal(hLive.director.getStatus().volume.title, '渡口新局');
    assert.equal(await hLive.readJson(hLive.dir() + '/restructure-draft.json'), null, '重构完成后清理断点');
  } finally { hLive.dispose(); }
});

test('对抗审查回归：P1-1/3/4/5/6/7/8/9/10 与 P2-4 边界全覆盖', async () => {
  /* 1. P1-7 大卡 420 条世界书分级降载 + 超极小预算诚实标注 ls/grep，绝不自相矛盾；P1-8 条目名含 #数字 与尾空格精确对齐 providers.js */
  const bigEntries = [];
  for (let i = 0; i < 418; i += 1) {
    bigEntries.push({ uid: i, name: '常规设定条目_' + i, enabled: true, content: '内容'.repeat(80), strategy: { type: 'selective', keys: ['关键词A_' + i, '关键词B_' + i, '关键词C_' + i, '关键词D_' + i] }, position: { order: 100 } });
  }
  bigEntries.push({ uid: 500, name: '末尾关键绿灯角色格温', enabled: true, content: '格温隐秘设定', strategy: { type: 'selective', keys: ['格温'] }, position: { order: 1 } });
  const booksSpec = [{ name: '超大设定集', tag: '[角色主书]', entries: bigEntries }, { name: '全局规则书', tag: '[全局启用]', entries: [{ uid: 0, name: '全局红线', enabled: true, content: '规则', strategy: { type: 'constant', keys: [] }, position: { order: 50 } }] }];
  const composedBig = core.composeMaterials([
    { key: 'books', title: '世界书', text: core.formatWorldbookCatalog(booksSpec).text, weight: 24, preserve: true, render: (cap) => core.formatWorldbookCatalog(booksSpec, cap).text },
    { key: 'floors', title: '近期正文', text: '正文'.repeat(4000), weight: 40, tail: true },
  ], 34000);
  assert.ok(composedBig.text.includes('末尾关键绿灯角色格温') && composedBig.text.includes('全局红线'), '420 条大卡自动切入紧凑/精简分级目录，末尾绿灯与全局书零丢失');
  const tinyCatalog = core.formatWorldbookCatalog(booksSpec, 1500);
  assert.equal(tinyCatalog.truncated, true);
  assert.ok(tinyCatalog.omitted > 0 && tinyCatalog.text.includes('全局规则书') && tinyCatalog.text.includes('ls("wb:/') && !tinyCatalog.text.includes('未截断'), '极端小预算下诚实标注省略条数并给 ls 提示，不把全局书整本吃掉');

  /* P1-8 实测：同名/含 #数字 / 尾空格 的条目路径送进真实 VFS read，100% 命中原条目不撞 uid */
  const hHash = makeNativeDirectorHost({
    worldbooks: {
      测试书: [
        { uid: 7, name: '旧港规矩', enabled: true, content: '这是 uid=7 的旧港规矩正文', strategy: { type: 'constant', keys: [] }, position: { order: 100 } },
        { uid: 3, name: '设定#7', enabled: true, content: '这是 uid=3 的设定#7 正文', strategy: { type: 'selective', keys: ['设定7'] }, position: { order: 50 } },
        { uid: 9, name: '尾空格 ', enabled: true, content: '这是 uid=9 的尾空格正文', strategy: { type: 'selective', keys: ['空格'] }, position: { order: 10 } },
      ],
    },
  });
  try {
    const idxText = core.indexWorldbook('测试书', hHash.worldbooks.测试书);
    const paths = idxText.split('\n').slice(1).map((line) => line.replace(/^- /, '').split(' ｜ ')[0]);
    const pHash = paths.find((p) => p.includes('%237%233'));
    const pSpace = paths.find((p) => p.includes('%239'));
    assert.ok(pHash && pSpace, '含 #数字 与尾空格条目自动追加 #uid：' + paths.join(', '));
    assert.match((await hHash.vfs.read(pHash)).text, /uid=3 的设定#7 正文/);
    assert.match((await hHash.vfs.read(pSpace)).text, /uid=9 的尾空格正文/);
  } finally { hHash.dispose(); }

  /* 2. P1-4：4 类非「不支持 tools」的 400 错误绝不误降级为文本协议破坏原生断点；风控 400 直接失败并保留原生断点 */
  let overflowOnce = true;
  const hNoFalseFallback = makeNativeDirectorHost({
    backend: (body) => {
      if (overflowOnce) {
        overflowOnce = false;
        return { status: 400, body: { error: { message: "This model's maximum context length is 8192 tokens (7500 in the messages, 700 in the functions)." } } };
      }
      assert.ok(Array.isArray(body.tools) && body.tools.length > 0, '含 "in the functions" 的上下文超限 400 走窗口压缩重试，绝不误降级文本协议');
      return nativeReply({ content: delivery(OUTLINE, INDEX, brief('超限重试未降级')) });
    },
  });
  try {
    await hNoFalseFallback.director.ready();
    assert.deepEqual(plain(await hNoFalseFallback.director.activate()), { done: true });
  } finally { hNoFalseFallback.dispose(); }

  const hFilter = makeNativeDirectorHost({
    backend: () => ({ status: 400, body: { error: { message: 'Request rejected by content_filter safety policy' } } }),
  });
  try {
    await hFilter.director.ready();
    await assert.rejects(() => hFilter.director.activate(), /content_filter|safety/);
    assert.equal(hFilter.backendCalls.length, 1, '风控 400 直接失败，绝不尝试降级为文本协议重试');
  } finally { hFilter.dispose(); }

  /* 3. P1-6 忽略自检一键定稿出口（commitDraftNow） */
  const badCheck = '<self_check>\n1. 通过\n2. 命名嗅探：未通过，存在罐头名\n</self_check>\n' + `<volume_outline>\n${OUTLINE}\n</volume_outline>\n<volume_index>\n${JSON.stringify(INDEX)}\n</volume_index>\n<first_brief>\n${brief('软失败放行')}\n</first_brief>`;
  const hForce = makeHost({ replies: { plan: [badCheck, badCheck, badCheck] } });
  try {
    await hForce.director.ready();
    await assert.rejects(() => hForce.director.activate(), /自动修订 2 次后仍未通过质检/);
    assert.equal(hForce.director.getStatus().plan.canForceCommit, true, '硬结构合法仅自检软失败时开放一键定稿出口');
    assert.deepEqual(plain(await hForce.director.commitDraftNow()), { done: true, forced: true });
    assert.equal(hForce.director.getStatus().state, 'running');
    assert.equal(await hForce.readJson(hForce.dir() + '/draft.json'), null);
  } finally { hForce.dispose(); }

  /* 4. P1-9 L2 重构持久化断点续传（502 崩溃 → 落盘 restructure-draft.json → 模拟刷新重加载 → resumeRestructure() 不重查第 1 轮变量） */
  let rsDown = true;
  const hRsResume = makeNativeDirectorHost({
    backend: (body) => {
      const isRs = body.messages.some((m) => String(m.content || '').includes('## 结构重构'));
      if (!isRs) return nativeReply({ content: delivery(OUTLINE, INDEX, brief('开卷')) });
      const hasMvu = body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c_rs_persist');
      if (!hasMvu) return nativeReply({ tool_calls: [toolCall('read', { path: 'var:/mvu.json#/stat_data/资金' }, 'c_rs_persist')] }, 'tool_calls');
      if (rsDown) return { status: 502, body: { error: { message: 'upstream 502' } } };
      return nativeReply({ content: delivery(OUTLINE_V2, { title: '续传重构卷', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] }, brief('重构续传'), '断点续传完成') });
    },
  });
  try {
    await hRsResume.director.ready();
    await hRsResume.director.activate();
    await assert.rejects(() => hRsResume.director.restructureNow('核心人物退场'), /502/);
    const rsDraft = await hRsResume.readJson(hRsResume.dir() + '/restructure-draft.json');
    assert.deepEqual([rsDraft.v, rsDraft.state, rsDraft.rounds, rsDraft.toolCalls, rsDraft.reason], [2, 'failed', 1, 1, '核心人物退场']);
    assert.ok(hRsResume.director.getStatus().restructureDraft && hRsResume.director.getStatus().restructureDraft.hasCheckpoint);

    rsDown = false;
    const rsDone = await hRsResume.director.resumeRestructure();
    assert.equal(rsDone.version, 2);
    assert.equal(await hRsResume.readJson(hRsResume.dir() + '/restructure-draft.json'), null, '重构续传完成后删除断点文件');
    const rsNoToolCalls = hRsResume.backendCalls.filter((c) => c.body.messages.some((m) => String(m.content || '').includes('## 结构重构')) && !c.body.messages.some((m) => m.role === 'tool'));
    assert.equal(rsNoToolCalls.length, 1, '续传沿用已读变量，不重跑第 1 轮工具调用');
  } finally { hRsResume.dispose(); }

  /* 5. P1-5 压缩后的工具结果落盘进 draft.json 后，续传绝不回填 seen，模型再次 read 能拿回完整全文 */
  const longText = '开头背景。'.repeat(1200) + '【压缩后必须能重读拿回的终极密钥：旧钟底盖刻字】';
  let compressTriggered = false, compUpstreamDown = true;
  const hComp = makeNativeDirectorHost({
    worldbooks: {
      命定之诗: [
        { uid: 0, name: '长设定A', enabled: true, content: longText, strategy: { type: 'selective', keys: ['A'] }, position: { order: 100 } },
        { uid: 1, name: '长设定B', enabled: true, content: '填充B。'.repeat(40), strategy: { type: 'selective', keys: ['B'] }, position: { order: 90 } },
        { uid: 2, name: '长设定C', enabled: true, content: '填充C。'.repeat(40), strategy: { type: 'selective', keys: ['C'] }, position: { order: 80 } },
        { uid: 3, name: '长设定D', enabled: true, content: '填充D。'.repeat(40), strategy: { type: 'selective', keys: ['D'] }, position: { order: 70 } },
        { uid: 4, name: '长设定E', enabled: true, content: '填充E。'.repeat(40), strategy: { type: 'selective', keys: ['E'] }, position: { order: 60 } },
      ],
    },
    backend: (body) => {
      const hasA = body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c_a');
      const hasB = body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c_b');
      const hasVar = body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c_mvu_cp');
      const reRead = body.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c_a_again');
      if (!hasA) return nativeReply({ tool_calls: [toolCall('read', { path: 'wb:/命定之诗/长设定A' }, 'c_a')] }, 'tool_calls');
      if (!hasB) return nativeReply({ tool_calls: [toolCall('read', { path: 'wb:/命定之诗/长设定B' }, 'c_b'), toolCall('read', { path: 'wb:/命定之诗/长设定C' }, 'c_c'), toolCall('read', { path: 'wb:/命定之诗/长设定D' }, 'c_d'), toolCall('read', { path: 'wb:/命定之诗/长设定E' }, 'c_e')] }, 'tool_calls');
      if (!compressTriggered) {
        compressTriggered = true;
        /* 收紧到 34000 tokens：刚好让第 1 条长设定 c_a 被截短并打标 compressed:true，保留其余 4 条不折叠 */
        return { status: 400, body: { error: { message: "This model's maximum context length is 34000 tokens" } } };
      }
      if (!hasVar) {
        const msgA = body.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c_a');
        assert.ok(msgA && msgA.content.includes('已压缩以节省上下文'), 'c_a 已在上下文中被截短压缩');
        /* 再做 1 轮工具调用，将带 compressed:true 的 c_a 真实落盘进 draft.json */
        return nativeReply({ tool_calls: [toolCall('read', { path: 'var:/mvu.json' }, 'c_mvu_cp')] }, 'tool_calls');
      }
      if (compUpstreamDown) {
        return { status: 502, body: { error: { message: '502 after compressed checkpoint' } } };
      }
      if (!reRead) {
        return nativeReply({ tool_calls: [toolCall('read', { path: 'wb:/命定之诗/长设定A' }, 'c_a_again')] }, 'tool_calls');
      }
      assert.ok(reRead.content.includes('旧钟底盖刻字'), '续传后重读被压缩过的条目，拿到完整原文而非 320 字残片');
      return nativeReply({ content: delivery(OUTLINE, INDEX, brief('重读全文成稿')) });
    },
  });
  try {
    await hComp.director.ready();
    await assert.rejects(() => hComp.director.activate(), /502/);
    const compDraft = await hComp.readJson(hComp.dir() + '/draft.json');
    const savedA = compDraft.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c_a');
    assert.equal(savedA && savedA.compressed, true, 'draft.json 准确保留了 compressed:true 标记');
    compUpstreamDown = false;
    assert.deepEqual(plain(await hComp.director.resume()), { done: true });
  } finally { hComp.dispose(); }

  /* 6. P1-3 跨聊天重构插话绝不串用旧聊天探索会话 */
  let holdChatARs = true;
  const hCross = makeNativeDirectorHost({
    backend: async (body, seq, signal) => {
      const waitAbort = () => new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        if (signal && signal.aborted) abort();
        else if (signal) signal.addEventListener('abort', abort, { once: true });
      });
      const isRs = body.messages.some((m) => String(m.content || '').includes('## 结构重构'));
      if (!isRs) return nativeReply({ content: delivery(OUTLINE, INDEX, brief('开卷')) });
      const isChatBNote = body.messages.some((m) => String(m.content || '').includes('只给聊天B的重构意见'));
      if (!isChatBNote) {
        if (!body.messages.some((m) => m.role === 'tool')) {
          return nativeReply({ tool_calls: [toolCall('read', { path: 'wb:/命定之诗/格温' }, 'c_chatA_only')] }, 'tool_calls');
        }
        holdChatARs = false;
        await waitAbort();
      }
      assert.ok(!body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c_chatA_only'), 'P1-3 聊天 B 重构绝不夹带聊天 A 的工具结果');
      return nativeReply({ content: delivery(OUTLINE_V2, { title: '聊天B纯净重构', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] }, brief('聊天B重构'), '聊天B独立修订') });
    },
  });
  try {
    await hCross.director.ready();
    await hCross.director.activate(); /* 聊天 A 开卷 */
    const chatAMeta = hCross.ctx.chatMetadata;
    /* 切到聊天 B 并开卷 */
    hCross.ctx.chatId = 'chat-B';
    hCross.ctx.chatMetadata = { variables: {}, reader_ii_enabled: false };
    await hCross.emit('CHAT_CHANGED');
    await hCross.director.ready();
    await hCross.director.activate();
    const chatBMeta = hCross.ctx.chatMetadata;
    /* 切回聊天 A 发起重构并挂起 */
    hCross.ctx.chatId = 'chat-1';
    hCross.ctx.chatMetadata = chatAMeta;
    await hCross.emit('CHAT_CHANGED');
    await hCross.director.ready();
    const rsA = hCross.director.restructureNow('聊天A重构');
    await until(() => !holdChatARs, '聊天A重构查完工具并挂起');
    /* 切到聊天 B 立刻提修订意见 */
    hCross.ctx.chatId = 'chat-B';
    hCross.ctx.chatMetadata = chatBMeta;
    await hCross.emit('CHAT_CHANGED');
    await hCross.director.ready();
    const rsB = await hCross.director.submitFeedback('只给聊天B的重构意见');
    assert.equal(await rsA, null);
    assert.equal(rsB.version, 2);
    assert.equal(hCross.director.getStatus().volume.title, '聊天B纯净重构');
  } finally { hCross.dispose(); }

  /* 7. P1-1 定稿写盘窗口期间插话绝不回写 draft.json、绝不报 TypeError，无缝衔接转入重构；P2-4 自定义声明式连接器不暴露给总导演 */
  const hCommitRace = makeNativeDirectorHost({
    backend: (body) => {
      if (body.messages.some((m) => String(m.content || '').includes('## 结构重构'))) {
        return nativeReply({ content: delivery(OUTLINE_V2, { title: '落盘后接上的重构', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] }, brief('落盘后重构'), '接上插话') });
      }
      return nativeReply({ content: delivery(OUTLINE, INDEX, brief('先落盘')) });
    },
  });
  try {
    /* P2-4：模拟注入一个用户自定义连接器（origin: 'custom'），总导演必须忽略它 */
    hCommitRace.host.DangerPlugin = { probe: () => true, dump: () => ({ secret: 1 }) };
    hCommitRace.agent.saveSettings({
      connectors: [{ id: 'custom_danger', title: '自定义危险插件', detect: 'DangerPlugin.probe', tools: [{ name: 'danger_read', summary: '自定义读', effect: 'read', call: 'DangerPlugin.dump', params: [] }] }],
      connectorChoices: { custom_danger: true },
    });
    hCommitRace.agent.listConnectors();
    assert.ok(!hCommitRace.director.listReadonlyTools().some((t) => t.name === 'danger_read'), 'P2-4 严禁向总导演暴露用户自定义连接器工具');

    await hCommitRace.director.ready();
    const rawWrite = hCommitRace.vfs.write.bind(hCommitRace.vfs);
    let releaseCommit, commitHit = false;
    const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
    hCommitRace.vfs.write = async (path, text) => {
      if (path.endsWith('/active.json') && !commitHit) {
        commitHit = true;
        await commitGate;
      }
      return rawWrite(path, text);
    };
    const actP = hCommitRace.director.activate();
    await until(() => commitHit, '进入不可逆写 active.json 窗口');
    const fbP = hCommitRace.director.submitFeedback('定稿瞬间补充：把后续改成渡口');
    releaseCommit();
    assert.deepEqual(plain(await actP), { done: true });
    const fbRes = await fbP;
    assert.equal(fbRes.version, 2, '定稿瞬间插话自动等落盘完成后平滑转入重构');
    assert.equal(await hCommitRace.readJson(hCommitRace.dir() + '/draft.json'), null, '绝不把已删的 draft.json 写回磁盘');
  } finally { hCommitRace.dispose(); }
});

test('原生工具不支持时自动回退文本协议；重复空转拦截与沿用 agent.maxSteps 预算收尾', async () => {
  /* 场景 A：原生请求返回 400 不支持 tools → 自动回退文本协议并成功查阅世界书一轮完成编纲 */
  const textSeen = [];
  const hFallback = makeNativeDirectorHost({
    backend: (body) => {
      if (Array.isArray(body.tools) && body.tools.length) {
        return { status: 400, body: { error: { message: 'Unrecognized request argument supplied: tools' } } };
      }
      textSeen.push(plain(body.messages));
      const last = String(body.messages.at(-1).content);
      if (last.includes('<action_result name="read" status="ok">')) {
        assert.ok(last.includes('备用舵钥匙'));
        return nativeReply({ content: delivery(OUTLINE, INDEX, brief('文本回退')) });
      }
      return nativeReply({ content: '<action name="read">\n<param name="path">wb:/命定之诗/格温</param>\n</action>' });
    },
  });
  try {
    await hFallback.director.ready();
    assert.deepEqual(plain(await hFallback.director.activate()), { done: true });
    assert.equal(hFallback.backendCalls.filter((c) => Array.isArray(c.body.tools) && c.body.tools.length).length, 1, '原生失败被记住，只试一次');
    assert.ok(textSeen[0][0].content.includes('<action name="工具名">'), '回退后 System 切换为文本协议工具手册');
  } finally { hFallback.dispose(); }

  /* 场景 B：重复空转拦截（模型反复用相同参数查同一条）+ 越权路径拦截（gh:/ 与 dev:/） */
  let repeatTurns = 0;
  const hIdle = makeNativeDirectorHost({
    backend: (body) => {
      const last = String(body.messages.at(-1).content);
      if (body.tool_choice === 'none') {
        assert.match(last, /拦截空转/);
        return nativeReply({ content: delivery(OUTLINE, INDEX, brief('拦截后交付')) });
      }
      repeatTurns += 1;
      if (repeatTurns === 1) return nativeReply({ tool_calls: [toolCall('read', { path: 'gh:/owner/repo/README.md' }, 'c_gh')] }, 'tool_calls');
      /* 连续两次重复读取同一条，触发空转拦截 */
      return nativeReply({ tool_calls: [toolCall('read', { path: 'wb:/命定之诗/旧港规矩' }, 'c_dup_' + repeatTurns)] }, 'tool_calls');
    },
  });
  try {
    await hIdle.director.ready();
    assert.deepEqual(plain(await hIdle.director.activate()), { done: true });
    assert.match(hIdle.backendCalls[1].body.messages.at(-1).content, /禁止访问 gh:\//);
    assert.equal(hIdle.backendCalls.at(-1).body.tool_choice, 'none', '连续重复调用触发 tool_choice=none 强制收尾');
    assert.ok(repeatTurns <= 4, '防死循环及时拦截');
  } finally { hIdle.dispose(); }

  /* 场景 C：直接沿用 agent.getSettings().maxSteps（设为 2 轮），耗尽预算后提示收尾交付 */
  let budgetCalls = 0;
  const hBudget = makeNativeDirectorHost({
    agentSettings: { maxSteps: 2 },
    backend: (body) => {
      const last = String(body.messages.at(-1).content);
      if (body.tool_choice === 'none') {
        assert.match(last, /工具轮数预算上限（2 轮）/);
        return nativeReply({ content: delivery(OUTLINE, INDEX, brief('预算收尾')) });
      }
      budgetCalls += 1;
      if (budgetCalls === 1) return nativeReply({ tool_calls: [toolCall('read', { path: 'wb:/命定之诗/旧港规矩' }, 'c_b1')] }, 'tool_calls');
      if (budgetCalls === 2) return nativeReply({ tool_calls: [toolCall('read', { path: 'wb:/命定之诗/格温' }, 'c_b2')] }, 'tool_calls');
      throw new Error('不应在 maxSteps=2 耗尽后再发起工具调用');
    },
  });
  try {
    await hBudget.director.ready();
    assert.deepEqual(plain(await hBudget.director.activate()), { done: true });
    assert.equal(budgetCalls, 2, '精确执行 agent.maxSteps=2 轮工具后收尾');
  } finally { hBudget.dispose(); }
});

test('第二轮对抗审查回归：P1-1~4 与 P2-1~6 全覆盖', async () => {
  /* 1. P2-2 inspectSelfCheck：捕获中文「失败」与「通过，但…仍有硬伤，待修改」，绝不误杀正常句 */
  assert.equal(core.inspectSelfCheck('2. 活人关系：失败').length, 1, '捕获独立中文「失败」');
  assert.equal(core.inspectSelfCheck('2. 活人关系：失败，硬造了内讧').length, 1, '捕获「失败，原因」');
  assert.equal(core.inspectSelfCheck('3. 转场：通过，但 Phase 3 转场仍有硬伤，待修改').length, 1, '捕获「通过，但…待修改」');
  assert.equal(core.inspectSelfCheck([
    '1. 命名嗅探检验：通过，无需修改',
    '8. 活人关系：通过（玩家强攻失败均已接住）',
    '3. 转场：通过，但此前发现有一处小问题，已修正',
    '4. 红线核查：通过，但不存在问题',
  ].join('\n')).length, 0, '不误杀正常通过与已修正条目');

  /* 2. P2-5 超大 40 本书 × 30 条在 4000 字预算下严格 <= 4000 且完整保留诚实附注 */
  const books40 = [];
  for (let b = 0; b < 40; b += 1) {
    const entries = [];
    for (let e = 0; e < 30; e += 1) {
      entries.push({ uid: e, name: `卷${b}_设定条目_${e}`, enabled: true, content: '设定正文'.repeat(40), strategy: { type: 'selective', keys: [`词${b}_${e}`] }, position: { order: 100 - e } });
    }
    books40.push({ name: `世界书_${String(b + 1).padStart(2, '0')}`, tag: '[全局启用]', entries });
  }
  const cat40 = core.formatWorldbookCatalog(books40, 4000);
  assert.ok(cat40.text.length <= 4000, '40 本 × 30 条输出长度必须严格不超过预算 4000，实际：' + cat40.text.length);
  assert.equal(cat40.truncated, true);
  assert.ok(cat40.omitted > 0 && cat40.text.includes('ls("wb:/') && cat40.text.includes('grep("wb:/') && !cat40.text.includes('未截断'), '诚实总附注与补查指令完整保留在末尾');

  /* 3. P1-4 providers.js 的 ls / grep / read 与 indexWorldbook 对带 #数字 和尾空格条目 100% 一致 */
  const hHash2 = makeNativeDirectorHost({
    worldbooks: {
      测试书: [
        { uid: 7, name: '旧港规矩', enabled: true, content: '这是 uid=7 的旧港规矩正文', strategy: { type: 'constant', keys: [] }, position: { order: 100 } },
        { uid: 3, name: '设定#7', enabled: true, content: '这是 uid=3 的设定#7 专属内容', strategy: { type: 'selective', keys: ['设定7'] }, position: { order: 50 } },
        { uid: 9, name: '尾空格 ', enabled: true, content: '这是 uid=9 的尾空格专属内容', strategy: { type: 'selective', keys: ['空格'] }, position: { order: 10 } },
      ],
    },
  });
  try {
    const listed = await hHash2.vfs.list('wb:/测试书');
    const lsNames = listed.items.map((x) => x.name);
    assert.ok(lsNames.includes('设定#7#3') && lsNames.includes('尾空格 #9'), 'ls 侧与目录一致追加 #uid：' + lsNames.join(', '));
    const lsHashPath = 'wb:/' + encodeURIComponent('测试书') + '/' + encodeURIComponent('设定#7#3');
    assert.match((await hHash2.vfs.read(lsHashPath)).text, /uid=3 的设定#7 专属内容/);
    /* 模型手敲不带 #3 的全名路径，pick 也应优先唯一精确匹配 uid=3 而非误按 #7 找 uid=7 */
    const rawHashPath = 'wb:/' + encodeURIComponent('测试书') + '/' + encodeURIComponent('设定#7');
    assert.match((await hHash2.vfs.read(rawHashPath)).text, /uid=3 的设定#7 专属内容/);
    /* grep 返回路径送回 read 也必须命中 uid=3 */
    const gr = await hHash2.vfs.grep('wb:/测试书', 'uid=3');
    assert.equal(gr.total, 1);
    const grepPath = gr.hits[0].replace(/:\d+:.*$/, '');
    assert.match((await hHash2.vfs.read(grepPath)).text, /uid=3 的设定#7 专属内容/);

    /* 同时验证 vfs.grep 在任务级中止时如实返回 aborted: true 与实际 scanned，不再谎报扫描完所有文件 */
    const ac = new AbortController();
    ac.abort();
    const abortedGrep = await hHash2.vfs.grep('wb:/测试书', '不存在的词', { signal: ac.signal });
    assert.deepEqual([abortedGrep.aborted, abortedGrep.scanned, abortedGrep.totalFiles], [true, 0, 3]);
    const tempReg = hHash2.modules.createRegistry();
    hHash2.modules.installCoreTools(tempReg, { vfs: hHash2.vfs, env: { host: hHash2.host, document: hHash2.host.document } });
    const grepToolDef = tempReg.find('grep');
    const toolOut = await grepToolDef.run({ path: 'wb:/测试书', pattern: '不存在的词' }, { signal: ac.signal });
    assert.match(toolOut, /检索被中断，结果不完整/);
  } finally { hHash2.dispose(); }

  /* 4. P1-1 插话落在 grep 工具执行期间：绝不中止本地只读 grep，不截断结果、不锁死 seen，完整结果与插话一起进入下一轮 */
  let releaseGrep, grepEntered = false, grepSignals = [];
  const grepGate = new Promise((resolve) => { releaseGrep = resolve; });
  const hToolRace = makeNativeDirectorHost({
    backend: (body) => {
      const toolMsgs = body.messages.filter((m) => m.role === 'tool');
      if (!toolMsgs.length) {
        return nativeReply({
          tool_calls: [
            toolCall('grep', { path: 'wb:/命定之诗', pattern: '备用舵钥匙' }, 'c_grep_1'),
            toolCall('grep', { path: 'wb:/命定之诗', pattern: '宵禁' }, 'c_grep_2'),
          ],
        }, 'tool_calls');
      }
      assert.equal(toolMsgs.length, 2, '两项 grep 均完整执行，不因中途插话被截断');
      assert.ok(toolMsgs[0].content.includes('备用舵钥匙') && !toolMsgs[0].content.includes('没有命中'), '第 1 项 grep 命中完整');
      assert.ok(toolMsgs[1].content.includes('宵禁') && !toolMsgs[1].content.includes('没有命中'), '第 2 项 grep 命中完整');
      assert.ok(body.messages.some((m) => m.role === 'user' && String(m.content).includes('工具执行中插话：加一条暗线')), '插话立即在工具完成后被消费并附在下一轮');
      return nativeReply({ content: delivery(OUTLINE, { ...INDEX, title: '工具插话零截断' }, brief('完整成稿')) });
    },
  });
  try {
    await hToolRace.director.ready();
    const rawGrep = hToolRace.vfs.grep.bind(hToolRace.vfs);
    hToolRace.vfs.grep = async (p, pat, opts) => {
      grepSignals.push(opts && opts.signal);
      if (!grepEntered) {
        grepEntered = true;
        await grepGate;
      }
      return rawGrep(p, pat, opts);
    };
    const actP = hToolRace.director.activate();
    await until(() => grepEntered, '已进入第一个 grep 执行');
    const q = await hToolRace.director.submitFeedback('工具执行中插话：加一条暗线');
    assert.deepEqual(plain(q), { queued: true, kind: 'plan' });
    assert.equal(grepSignals.every((s) => !s || !s.aborted), true, '插话只打断 LLM 请求，绝不中止本地只读工具信号');
    releaseGrep();
    assert.deepEqual(plain(await actP), { done: true });
    assert.equal(hToolRace.director.getStatus().volume.title, '工具插话零截断');
  } finally { hToolRace.dispose(); }

  /* 5. P1-2 Gemma "not enabled" 400 与 P2-6 切换导演连接后自动恢复原生工具、且 draft.json 不含死字段 nativeBackup */
  let modelMode = 'gemma_text_only';
  const hProtoRecover = makeNativeDirectorHost({
    backend: (body) => {
      if (modelMode === 'gemma_text_only') {
        if (Array.isArray(body.tools) && body.tools.length) {
          return { status: 400, body: { error: { message: 'Function calling is not enabled for models/gemma-3-27b-it' } } };
        }
        const last = String(body.messages.at(-1).content);
        if (!last.includes('<action_result')) {
          return nativeReply({ content: '<action name="read">\n<param name="path">wb:/命定之诗/格温</param>\n</action>' });
        }
        return { status: 502, body: { error: { message: 'gemma upstream 502 after tool' } } };
      }
      /* 切换到新连接后，必须自动恢复原生 tools 而不是被锁死在 text 协议 */
      assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'P2-6 切换导演模型后断点续传自动恢复原生 tools 协议');
      return nativeReply({ content: delivery(OUTLINE, { ...INDEX, title: '换模型恢复原生' }, brief('原生恢复成稿')) });
    },
  });
  try {
    await hProtoRecover.director.ready();
    await assert.rejects(() => hProtoRecover.director.activate(), /502/);
    const savedDraft = await hProtoRecover.readJson(hProtoRecover.dir() + '/draft.json');
    assert.equal(savedDraft.protocol, 'text', 'Gemma not enabled 400 自动降级为文本协议并落盘');
    assert.ok(savedDraft.protocolKey, '断点记录了 protocolKey');
    assert.equal(Object.prototype.hasOwnProperty.call(savedDraft, 'nativeBackup'), false, 'P2-6 draft.json 不再写入无用的 nativeBackup');

    /* 把导演模型切换到另一个支持原生工具的连接 */
    const nativeConn = hProtoRecover.api.llm.saveConnectionPreset({ name: '原生强模型', apiurl: 'https://director-native-2.test/v1', key: 'k2', model: 'gpt-4o', source: 'openai' });
    hProtoRecover.api.llm.saveTaskConnection('director', { selected: nativeConn.id, model: 'gpt-4o', enabled: true });
    modelMode = 'native_capable';
    assert.deepEqual(plain(await hProtoRecover.director.resume()), { done: true });
    assert.equal(hProtoRecover.director.getStatus().volume.title, '换模型恢复原生');
  } finally { hProtoRecover.dispose(); }

  /* 6. P2-1 closing 收尾窗口插话绝不丢失：失败写草稿中途收到插话，等 settled 后自动注入并续跑定稿 */
  let failLeft = 2, closingHit = false, releaseClosing;
  const closingGate = new Promise((resolve) => { releaseClosing = resolve; });
  const hClosing = makeNativeDirectorHost({
    backend: (body) => {
      if (failLeft > 0) {
        failLeft -= 1;
        return { status: 502, body: { error: { message: 'transient 502' } } };
      }
      assert.ok(body.messages.some((m) => m.role === 'user' && String(m.content).includes('收尾窗口插话不能丢')), 'closing 窗口内的插话必须完整送达续跑');
      return nativeReply({ content: delivery(OUTLINE, { ...INDEX, title: '收尾插话零丢失' }, brief('收尾插话成稿')) });
    },
  });
  try {
    await hClosing.director.ready();
    const rawWrite = hClosing.vfs.write.bind(hClosing.vfs);
    hClosing.vfs.write = async (p, text) => {
      if (p.endsWith('/draft.json') && !closingHit && text.includes('"state": "failed"')) {
        closingHit = true;
        await closingGate;
      }
      return rawWrite(p, text);
    };
    const pFail = hClosing.director.activate().catch((e) => e);
    await until(() => closingHit, '进入 catch 写 failed draft.json 的 closing 窗口');
    const fbPromise = hClosing.director.submitFeedback('收尾窗口插话不能丢');
    releaseClosing();
    const err = await pFail;
    assert.ok(err && /502/.test(String(err.message || err)), '应抛出 502 错误：' + (err && err.message));
    assert.deepEqual(plain(await fbPromise), { done: true });
    assert.equal(hClosing.director.getStatus().volume.title, '收尾插话零丢失');
  } finally { hClosing.dispose(); }

  /* 7. P1-3 + P2-3 + P2-4：已有重构断点不被自动 L2 覆盖；楼层推进后标记 stale 并拒绝续传/强制落盘；saveOutline / rollbackTo 清理旧重构断点 */
  const softBadRs = '<self_check>\n1. 通过\n2. 活人关系：失败，未改\n</self_check>\n'
    + `<volume_outline>\n${OUTLINE_V2}\n</volume_outline>\n<volume_index>\n${JSON.stringify({ title: '待定重构', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] })}\n</volume_index>\n<first_brief>\n${brief('待定重构简报')}\n</first_brief>`;
  let rsSoftFail = true;
  const hRsGuard = makeNativeDirectorHost({
    directorSettings: { enabled: true, patrolEvery: 1, l2Cooldown: 0 },
    backend: (body) => {
      const sys = String(body.messages[0] && body.messages[0].content || '');
      if (sys.includes('场记') || sys.includes('运行期')) {
        return nativeReply({ content: judge({ drift_level: 2, reason: '剧情偏离需要 L2' }) });
      }
      if (body.messages.some((m) => String(m.content || '').includes('## 结构重构'))) {
        if (rsSoftFail) return nativeReply({ content: softBadRs });
        return nativeReply({ content: delivery(OUTLINE_V2, { title: '正常重构', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] }, brief('正常重构简报'), 'ok') });
      }
      return nativeReply({ content: delivery(OUTLINE, INDEX, brief('开卷')) });
    },
  });
  try {
    await hRsGuard.director.ready();
    await hRsGuard.director.activate();
    /* 制造一份含用户意见的重构断点（软失败超限落盘，带 lastOutput 可用于校验强制落盘） */
    await assert.rejects(() => hRsGuard.director.submitFeedback('用户辛辛苦苦写的重构要求'), /尚未修正/);
    const savedRs = await hRsGuard.readJson(hRsGuard.dir() + '/restructure-draft.json');
    assert.ok(savedRs && savedRs.feedback.some((f) => f.text.includes('用户辛辛苦苦写的重构要求')));
    assert.equal(hRsGuard.director.getStatus().restructureDraft.stale, false);
    assert.equal(hRsGuard.director.getStatus().restructureDraft.canForceCommit, true);

    /* 自动/手动巡检判 L2：因为已有重构断点，绝不静默覆盖！ */
    const patrolRes = await hRsGuard.director.patrolNow();
    assert.deepEqual([patrolRes.level, patrolRes.restructured, patrolRes.restructureSkipped], [2, false, 'existing_draft']);
    const afterPatrolRs = await hRsGuard.readJson(hRsGuard.dir() + '/restructure-draft.json');
    assert.equal(afterPatrolRs.epoch, savedRs.epoch, 'P1-3 自动 L2 绝不覆盖已有重构断点');

    /* 聊天推进新楼层后，锚点变化 → stale === true，resumeRestructure 与 commitRestructureDraftNow 均明确报错拒绝 */
    hRsGuard.chat.push({ name: '林渡', is_user: true, mes: '我推开了钟楼门。' }, { name: '艾琳', is_user: false, mes: '楼上没有人。' });
    const staleSt = hRsGuard.director.getStatus().restructureDraft;
    assert.deepEqual([staleSt.stale, staleSt.canForceCommit], [true, false]);
    await assert.rejects(() => hRsGuard.director.resumeRestructure(), /已失效/);
    await assert.rejects(() => hRsGuard.director.commitRestructureDraftNow(), /已过期/);

    /* saveOutline 自动清理过期重构断点 */
    const edited = OUTLINE.replace('#### Phase 3：清点之日', '#### Phase 3：清点之日\n#### Phase 4：余波');
    await hRsGuard.director.saveOutline(edited);
    assert.equal(hRsGuard.director.getStatus().restructureDraft, null);
    assert.equal(await hRsGuard.readJson(hRsGuard.dir() + '/restructure-draft.json'), null, '手动改大纲清理旧重构断点');

    /* 再造一份重构断点，验证 rollbackTo 也清理重构断点 */
    await assert.rejects(() => hRsGuard.director.restructureNow('回退前断点'), /尚未修正/);
    assert.ok(hRsGuard.director.getStatus().restructureDraft);
    const snaps = await hRsGuard.director.listSnapshots();
    await hRsGuard.director.rollbackTo(snaps.at(-1).id);
    assert.equal(hRsGuard.director.getStatus().restructureDraft, null);
    assert.equal(await hRsGuard.readJson(hRsGuard.dir() + '/restructure-draft.json'), null, '回退快照清理旧重构断点');
  } finally { hRsGuard.dispose(); }
});

test('第三轮修复回归：过期重构断点不挡自动 L2、自检转折规则、只重交自检、协议选择、残缺参数与编造的工具结果', async () => {
  /* 1. 自检：「通过，但…」只有真写了没修好的状态才打回；只提到「问题 / 漏洞」这些名词的保留意见放行 */
  const benign = [
    '5. 主角站位：通过，但需留意 Phase 2 的节奏问题',
    '2. 命名嗅探：通过，但原先的罐头名问题已改掉',
    '7. 反偷懒套路：通过（唯独 Phase 3 稍显平淡，问题不大）',
    '1. 去塑料件检验：通过，不过此前的漏洞已补上',
    '6. 活人关系尊重检验：通过，只是关系网里的旧账问题留给下一卷',
    '3. 连续性与转场检验：通过，无需修改',
    '2. 命名嗅探：原先未通过，已修正为旧港本土地名',
  ];
  for (const line of benign) assert.equal(core.inspectSelfCheck(line).length, 0, '不应打回：' + line);
  const residual = [
    '4. 反说教：通过，但 Phase 3 转场仍有硬伤，待修改',
    '4. 反说教：通过，但还有两处透风',
    '2. 命名嗅探：通过，但罐头名还没改掉',
    '6. 活人关系尊重检验：失败，硬造了内讧',
    '2. 命名嗅探：未通过，罐头名没改掉',
  ];
  for (const line of residual) assert.equal(core.inspectSelfCheck(line).length, 1, '应当打回：' + line);

  /* 2. 只重交自检段：识别、合并与软打回提示 */
  const fullSoft = '<self_check>\n1. 通过\n2. 命名嗅探：未通过，存在罐头人名\n</self_check>\n'
    + `<volume_outline>\n${OUTLINE}\n</volume_outline>\n<volume_index>\n${JSON.stringify(INDEX)}\n</volume_index>\n<first_brief>\n${brief('Phase 1 · 雨夜')}\n</first_brief>`;
  const checkOnly = '<self_check>\n1. 通过\n2. 命名嗅探：已修正：换成旧港本土地名\n</self_check>';
  assert.equal(core.isSelfCheckOnly(checkOnly), true);
  assert.equal(core.isSelfCheckOnly(fullSoft), false);
  const merged = core.mergeSelfCheck(fullSoft, checkOnly);
  assert.ok(merged.includes('已修正：换成旧港本土地名') && !merged.includes('存在罐头人名') && merged.includes('#### Phase 1：雨夜来客'));
  assert.equal(core.validateFinalDelivery(merged, { userName: '林渡' }).ok, true);
  assert.match(core.buildRevisionPrompt(['自检未修正'], { softOnly: true }), /只需重新输出一段 <self_check>/);
  assert.doesNotMatch(core.buildRevisionPrompt(['缺少 <first_brief>']), /只需重新输出一段/);

  /* 3. 端到端：第一稿只有自检软问题 → 模型只重交 <self_check> → 换进上一稿定稿，不整卷重写 */
  const hSoft = makeHost({ replies: { plan: [fullSoft, checkOnly] } });
  try {
    await hSoft.director.ready();
    assert.deepEqual(plain(await hSoft.director.activate()), { done: true });
    const plans = hSoft.model.of('plan');
    assert.equal(plans.length, 2, '只重交了自检段，没有再整卷重写');
    assert.match(plans[1].last, /只需重新输出一段 <self_check>/);
    assert.equal(hSoft.director.getStatus().volume.title, INDEX.title);
    assert.equal(await hSoft.readJson(hSoft.dir() + '/draft.json'), null);
  } finally { hSoft.dispose(); }

  /* 4. 过期的重构断点：场记判 L2 时照常自动重构，并把旧断点里的用户意见带进去 */
  const softBadRs = '<self_check>\n1. 通过\n2. 活人关系：失败，未改\n</self_check>\n'
    + `<volume_outline>\n${OUTLINE_V2}\n</volume_outline>\n<volume_index>\n${JSON.stringify({ title: '待定重构', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] })}\n</volume_index>\n<first_brief>\n${brief('待定重构简报')}\n</first_brief>`;
  let rsSoftFail = true;
  const rsPrompts = [];
  const hStale = makeNativeDirectorHost({
    directorSettings: { enabled: true, patrolEvery: 1, l2Cooldown: 0 },
    backend: (body) => {
      const sys = String(body.messages[0] && body.messages[0].content || '');
      if (sys.includes('场记') || sys.includes('运行期')) return nativeReply({ content: judge({ drift_level: 2, reason: '剧情偏离需要 L2' }) });
      if (body.messages.some((m) => String(m.content || '').includes('## 结构重构'))) {
        rsPrompts.push(String(body.messages[1].content));
        if (rsSoftFail) return nativeReply({ content: softBadRs });
        return nativeReply({ content: delivery(OUTLINE_V2, { title: '过期断点后的重构', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] }, brief('自动重构'), '带着旧意见重构') });
      }
      return nativeReply({ content: delivery(OUTLINE, INDEX, brief('开卷')) });
    },
  });
  try {
    await hStale.director.ready();
    await hStale.director.activate();
    await assert.rejects(() => hStale.director.submitFeedback('旧断点里用户写的重构要求'), /尚未修正/);
    assert.ok(hStale.director.getStatus().restructureDraft);
    hStale.chat.push({ name: '林渡', is_user: true, mes: '我推开了钟楼门。' }, { name: '艾琳', is_user: false, mes: '楼上没有人。' });
    assert.equal(hStale.director.getStatus().restructureDraft.stale, true);
    rsSoftFail = false;
    const res = await hStale.director.patrolNow();
    assert.equal(res.level, 2);
    assert.equal(res.restructured, true, '过期的重构断点不再挡住自动 L2');
    assert.equal(res.restructureSkipped, undefined);
    assert.ok(rsPrompts.at(-1).includes('旧断点里用户写的重构要求'), '旧断点里的用户意见带进了这次重构');
    assert.equal(hStale.director.getStatus().volume.title, '过期断点后的重构');
    assert.equal(hStale.director.getStatus().restructureDraft, null);
    assert.equal(await hStale.readJson(hStale.dir() + '/restructure-draft.json'), null);
  } finally { hStale.dispose(); }

  /* 5. 用户手动选的「文本」留下的断点：改回「自动」后同一条连接重新走原生，不被当成降级沿用 */
  let protoDown = true;
  const hProto = makeNativeDirectorHost({
    agentSettings: { toolProtocol: 'text' },
    backend: (body) => {
      if (protoDown) {
        assert.ok(!body.tools, '设为文本时不带 tools');
        /* System 里的文本协议说明本身就提到 <action_result>，只看对话里有没有真实的工具结果 */
        if (!body.messages.some((m) => m.role !== 'system' && String(m.content || '').includes('<action_result'))) {
          return nativeReply({ content: '<action name="read">\n<param name="path">wb:/命定之诗/格温</param>\n</action>' });
        }
        return { status: 502, body: { error: { message: 'upstream gateway down' } } };
      }
      assert.ok(Array.isArray(body.tools) && body.tools.length > 0, '改回「自动」后同一连接重新走原生');
      return nativeReply({ content: delivery(OUTLINE, INDEX, brief('改回自动')) });
    },
  });
  try {
    await hProto.director.ready();
    await assert.rejects(() => hProto.director.activate(), /502|gateway/);
    const saved = await hProto.readJson(hProto.dir() + '/draft.json');
    assert.deepEqual([saved.protocol, saved.protocolFallback], ['text', false]);
    hProto.agent.saveSettings({ toolProtocol: 'auto' });
    protoDown = false;
    assert.deepEqual(plain(await hProto.director.resume()), { done: true });
  } finally { hProto.dispose(); }

  /* 6. 助手设为「只用原生」而总导演通道不支持原生：改用文本协议跑完，不让编纲直接失败 */
  const hNativeOnly = makeHost({ agentSettings: { toolProtocol: 'native' } });
  try {
    await hNativeOnly.director.ready();
    const lines = [];
    const off = hNativeOnly.api.jobs.onChange((job) => { if (job.owner === 'director') lines.push(...job.lines); });
    assert.deepEqual(plain(await hNativeOnly.director.activate()), { done: true });
    off();
    assert.ok(lines.some((line) => /已改用文本协议|已自动切换文本工具协议/.test(line)), '日志说明改用了文本协议');
  } finally { hNativeOnly.dispose(); }

  /* 7. 残缺的原生参数不原样发回上游：写回历史的 arguments 换成 "{}"，结果里提示模型重发 */
  const hArgs = makeNativeDirectorHost({
    backend: (body, seq) => {
      if (seq === 1) return nativeReply({ tool_calls: [{ id: 'c_bad', type: 'function', function: { name: 'read', arguments: '{"path": "wb:/命定之诗/格' } }] }, 'tool_calls');
      const echoed = body.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
      assert.equal(echoed.tool_calls[0].function.arguments, '{}', '残缺的参数换成 {}');
      const result = body.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c_bad');
      assert.match(result.content, /不是合法的 JSON/);
      return nativeReply({ content: delivery(OUTLINE, INDEX, brief('参数清洗')) });
    },
  });
  try {
    await hArgs.director.ready();
    assert.deepEqual(plain(await hArgs.director.activate()), { done: true });
  } finally { hArgs.dispose(); }

  /* 8. 文本协议下模型自己编出 <action_result>：截掉编造的部分，只执行它真正发出的调用 */
  const hFake = makeNativeDirectorHost({
    agentSettings: { toolProtocol: 'text' },
    backend: (body) => {
      const last = String(body.messages.at(-1).content);
      if (!last.includes('<action_result')) {
        return nativeReply({ content: '<action name="read">\n<param name="path">wb:/命定之诗/格温</param>\n</action>\n<action_result name="read" status="ok">\n编出来的结果\n</action_result>\n' + delivery(OUTLINE, INDEX, brief('不该被当成交付')) });
      }
      assert.ok(last.includes('备用舵钥匙') && !last.includes('编出来的结果'), '工具结果来自真实读取');
      const echoed = body.messages.filter((m) => m.role === 'assistant').at(-1);
      assert.ok(!String(echoed.content).includes('编出来的结果'), '写回历史的回复不含编造的结果');
      return nativeReply({ content: delivery(OUTLINE, INDEX, brief('文本协议')) });
    },
  });
  try {
    await hFake.director.ready();
    assert.deepEqual(plain(await hFake.director.activate()), { done: true });
    assert.equal(hFake.director.getStatus().volume.title, INDEX.title);
  } finally { hFake.dispose(); }
});
