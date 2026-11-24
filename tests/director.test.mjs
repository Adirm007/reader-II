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
    plan1: '《勘察卡》土壤够肥，关系尚浅，主角是外来的手艺人。',
    plan2: '卷核：一本账与一座钟。关系网：艾琳、莫师傅、新看守。',
    plan3: OUTLINE,
    plan4: delivery(OUTLINE, INDEX, brief('Phase 1 · 雨夜')),
    revise: '（修订版）卷核：只写日常，不写阴谋。',
    judge: judge(),
    restructure: delivery(OUTLINE_V2, { title: '雨季的钟', phases: [{ n: 1, title: '渡口改道' }, { n: 2, title: '对岸的钟' }], new_characters: [] }, brief('重构后的 Phase 1'), '玩家提前渡河，原定的钟楼冲突不再成立'),
    archive: ARCHIVE,
    entry_npc: ENTRY_NPC,
    entry_temp: ENTRY_TEMP,
    ...replies,
  };
  function classify(prompts) {
    const system = String(prompts[0].content), last = String(prompts.at(-1).content);
    if (system.includes('分卷导演 · 场记')) return 'judge';
    if (system.includes('正在给刚刚落幕的这一卷归档')) return 'archive';
    if (system.includes('通用世界书条目编写器')) return last.includes('一次性的龙套') ? 'entry_temp' : 'entry_npc';
    if (last.includes('## 结构重构')) return 'restructure';
    if (last.includes('【修订这一步】')) return 'revise';
    const step = /【步骤 (\d)\/4/.exec(last);
    return step ? 'plan' + step[1] : 'other';
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
  const planner = core.sliceDirectorSkillDetailed(noStage4, 'planner');
  assert.equal(planner.degraded, true);
  assert.deepEqual(plain(planner.missing), ['阶段四']);
  assert.ok(planner.text.includes('## 阶段五') && planner.text.includes('## 大纲规范（我改了标题）'), '降级 = 整篇照发');
  assert.equal(core.sliceDirectorSkillDetailed(noStage4, 'runtime').degraded, false, '运行期用不到阶段四');

  const noStage5 = SKILL.replace('## 阶段五：后台运行期执导协议（适用于多轮互动实时导演）', '## 运行期');
  const runtime = core.sliceDirectorSkillDetailed(noStage5, 'runtime');
  assert.deepEqual(plain([runtime.degraded, runtime.missing]), [true, ['阶段五']]);
  assert.ok(runtime.text.includes('## 阶段一'), '运行期降级 = 整篇照发');
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

test('导演的活互斥：编纲在跑时不能再开卷、巡检或重构；停下之后草稿留着，可以接着编', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = makeHost({ replies: { plan2: async () => { await gate; return '卷核：一本账与一座钟。'; } } });
  try {
    await h.director.ready();
    const running = h.director.activate();
    await until(() => h.model.of('plan2').length === 1, '编纲走到第 2 步');
    assert.deepEqual([h.director.getStatus().state, h.director.getStatus().work.kind], ['planning', 'plan']);
    await assert.rejects(() => h.director.activate(), /正在编纲/);
    await assert.rejects(() => h.director.patrolNow(), /没有正在执导的分卷/);
    assert.equal(h.api.jobs.list().filter((job) => job.owner === 'director' && job.state === 'running').length, 1, '看板上只有一张牌子');
    assert.equal(h.agent.isBusy(), false, '导演有自己的锁，不占助手主循环的');

    /* 暂停：立刻掐掉当前请求，草稿存盘。 */
    assert.equal(await h.director.pause(), 'plan');
    release();
    assert.deepEqual(plain(await running), { paused: true });
    const draft = await h.readJson(h.dir() + '/draft.json');
    assert.deepEqual([draft.state, draft.step, draft.outputs.length], ['paused', 1, 1]);
    assert.ok(draft.materials.includes('近期正文') && draft.materials.includes('旧港'), '勘察资料存在草稿里，续接时不必重来');
    assert.deepEqual([h.director.getStatus().state, h.director.getStatus().plan.state], ['draft', 'paused']);
    assert.equal(await h.readJson(h.dir() + '/active.json'), null, '没定稿就没有活跃卷');

    /* 接着编：从第 2 步继续，前面的产出不重跑。 */
    h.model.table.plan2 = '卷核：一本账与一座钟。';
    assert.deepEqual(plain(await h.director.resume()), { done: true });
    assert.equal(h.model.of('plan1').length, 1);
    assert.equal(h.director.getStatus().state, 'running');
    assert.equal(await h.readJson(h.dir() + '/draft.json'), null, '定稿之后草稿删掉');
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

test('场记的 System 是静态前缀：状态、补丁、正文怎么变都逐字节不变；编纲四步的请求一步接一步', () => {
  const base = { skillRaw: SKILL, preferences: '日常多一些', userName: '林渡', profile: '主角「林渡」：修表匠', outline: OUTLINE, index: core.normalizeIndex(INDEX, OUTLINE) };
  const first = core.buildJudgeMessages({ ...base, state: core.initialState(), brief: '简报一', turn: 3, recent: [{ floor: 4, role: 'assistant', name: '艾琳', text: '她递来毛巾。' }] });
  const state = { ...core.initialState(), phaseCursor: 2, progress: '上了钟楼', facts: ['林渡没接毛巾'], patches: [{ phase: 2, turn: 5, text: '艾琳改从后门送他上钟楼' }], turn: 5 };
  const second = core.buildJudgeMessages({ ...base, state, brief: '简报二', turn: 6, recent: [{ floor: 6, role: 'user', name: '林渡', text: '我绕到后门。' }, { floor: 7, role: 'assistant', name: '艾琳', text: '后门没有锁。' }] });
  assert.equal(first[0].content, second[0].content, 'System 逐字节相同');
  assert.ok(first[0].content.includes(OUTLINE) && first[0].content.includes('## 阶段五') && first[0].content.includes('日常多一些') && first[0].content.includes('输出契约'));
  assert.ok(!first[0].content.includes('{{user}}') && first[0].content.includes('林渡'), 'Skill 里的主角占位已经换成实名');
  assert.ok(!second[0].content.includes('艾琳改从后门送他上钟楼'), 'L1 的补丁不进静态前缀');
  assert.ok(second[1].content.includes('艾琳改从后门送他上钟楼') && second[1].content.includes('林渡没接毛巾') && second[1].content.includes('[#7 艾琳]') && second[1].content.includes('游标：Phase 2 / 3（钟楼的夹层）'));
  assert.notEqual(core.buildJudgeSystem({ ...base, outline: OUTLINE_V2 }), first[0].content, '只有大纲换了版本，前缀才变');

  const system = core.buildPlannerSystem(SKILL, '日常多一些', '林渡');
  assert.ok(system.includes('## 阶段四') && !system.includes('## 阶段五') && system.includes('用户长期偏好') && system.includes('日常多一些') && system.includes('主角实名：「林渡」'));
  assert.match(system, /角色卡的标题、世界书的书名只是资料的出处，不是人物/);
  const ctx = { system, materials: '### 近期正文\n……', outputs: ['勘察卡', '立意', '大纲'], feedback: [{ step: 2, text: '少一点阴谋' }] };
  const steps = [1, 2, 3, 4].map((n) => core.buildPlannerStepMessages(n, ctx));
  assert.deepEqual(steps.map((messages) => messages.length), [2, 4, 6, 8]);
  for (let n = 1; n < 4; n += 1) assert.deepEqual(plain(steps[n].slice(0, steps[n - 1].length)), plain(steps[n - 1]), `第 ${n + 1} 步以第 ${n} 步为前缀`);
  assert.ok(steps[0][1].content.includes('### 近期正文') && steps[0][1].content.includes('【步骤 1/4'));
  assert.ok(steps[3][3].content.includes('少一点阴谋') && !steps[3][1].content.includes('少一点阴谋'), '意见跟在提出它的那一步后面');
  assert.ok(steps[3][7].content.includes('<volume_outline>') && steps[3][7].content.includes('<volume_index>') && steps[3][7].content.includes('<first_brief>') && steps[3][7].content.includes('【本轮防 AI 味忌口】'));
  const revise = core.buildPlannerStepMessages(2, { ...ctx, outputs: ['勘察卡'], revise: { previous: '旧的立意', text: '只写日常' } });
  assert.deepEqual([revise.length, revise[4].content, /只写日常/.test(revise[5].content)], [6, '旧的立意', true]);

  /* 交付物解析：截断、缺标签、索引缺失时从 Phase 标题回推。 */
  const final = core.parseFinalOutline(delivery(OUTLINE, INDEX, brief('Phase 1')));
  assert.deepEqual([final.ok, final.index.totalPhases, final.index.title, final.index.newCharacters.length, final.index.inferred], [true, 3, '雨季的钟', 2, false]);
  assert.deepEqual(plain(final.index.newCharacters.map((item) => item.kind)), ['npc', 'temp_event']);
  const cut = core.parseFinalOutline('<self_check>ok</self_check>\n<volume_outline>\n' + OUTLINE.slice(0, 200));
  assert.deepEqual([cut.ok, cut.truncated, /调大/.test(cut.error)], [false, true, true]);
  const inferred = core.parseFinalOutline('<volume_outline>\n' + OUTLINE + '\n</volume_outline>\n<volume_index>\n{坏的 JSON\n</volume_index>');
  assert.deepEqual([inferred.ok, inferred.index.inferred, plain(inferred.index.phases.map((phase) => phase.title)), inferred.firstBrief], [true, true, ['雨夜来客', '钟楼的夹层', '清点之日'], '']);
  assert.equal(core.parseFinalOutline(OUTLINE).lenient, true, '忘了套标签但确实是一份大纲：收下');
  assert.equal(core.parseFinalOutline('抱歉，我不能完成这个请求。').ok, false);
});

test('后台巡检：L0 / L1 更新快照与简报，大纲文件与静态前缀都不变；场记判 L2 时直接拉总导演重构，可一键撤回', async () => {
  const h = await activated();
  try {
    const dir = h.dir();
    assert.deepEqual(h.model.calls.map((call) => call.kind), ['plan1', 'plan2', 'plan3', 'plan4']);
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
    assert.equal(restructure.system, h.model.of('plan1')[0].system, '重构复用编纲的 System');
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
    assert.ok(g.model.of('plan1').at(-1).last.includes('已完结各卷的档案与跨卷钩子') && g.model.of('plan1').at(-1).last.includes('清点结束，雨停了'));
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
    assert.ok(h.model.of('plan1')[0].last.includes('【用户意见（最高优先级') && h.model.of('plan1')[0].last.includes('这一卷不要阴谋'));
    /* 勘察资料：主角实名与人设、角色卡、世界书、近期正文都带上了；System 里明确了主角实名。 */
    const first = h.model.of('plan1')[0];
    for (const part of ['实名：林渡', '走街串巷的修表匠', '旧港酒馆的老板娘', '旧港在北岸', '[#2 艾琳]', '[#1 用户 · 林渡]']) assert.ok(first.last.includes(part), part);
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

test('编纲可以过目与插话：第 2 步后停下，提意见则按意见修订这一步；交付被截断时退回第 3 步之后', async () => {
  const h = makeHost({ directorSettings: { enabled: true, planMode: 'review', plannerMaxTokens: 4096 } });
  try {
    await h.director.ready();
    assert.deepEqual(plain(await h.director.activate()), { review: true });
    assert.deepEqual(h.model.calls.map((call) => call.kind), ['plan1', 'plan2']);
    let status = h.director.getStatus();
    assert.deepEqual([status.state, status.plan.state, status.plan.step, status.plan.outputs.length], ['draft', 'review', 2, 2]);

    /* 提意见：按意见重出第 2 步，再停下给用户看。 */
    assert.deepEqual(plain(await h.director.submitFeedback('只写日常，不写阴谋')), { review: true });
    const revise = h.model.of('revise')[0];
    assert.ok(revise.last.includes('只写日常，不写阴谋') && revise.prompts.at(-2).content.includes('卷核：一本账与一座钟'));
    status = h.director.getStatus();
    assert.deepEqual([status.plan.state, status.plan.outputs[1]], ['review', '（修订版）卷核：只写日常，不写阴谋。']);

    /* 过目通过：接着编。第 4 步的交付被截断 → 报错并退回第 3 步之后，草稿还在。 */
    h.model.table.plan4 = '<self_check>ok</self_check>\n<volume_outline>\n' + OUTLINE.slice(0, 150);
    await assert.rejects(() => h.director.resume(), /大纲没有写完就断了/);
    assert.ok(h.model.of('plan3')[0].prompts[3].content.includes('只写日常，不写阴谋'), '意见留在第 2 步的要求里，后面各步都看得到');
    assert.equal(h.model.of('plan3')[0].prompts[4].content, '（修订版）卷核：只写日常，不写阴谋。');
    status = h.director.getStatus();
    assert.deepEqual([status.state, status.plan.state, status.plan.step, /调大/.test(status.plan.error)], ['draft', 'failed', 3, true]);
    assert.equal(h.model.of('plan4')[0].prompts.length, 8);

    /* 调好之后接着来：只重跑第 4 步。 */
    h.model.table.plan4 = delivery(OUTLINE, INDEX, brief('Phase 1 · 雨夜'));
    assert.deepEqual(plain(await h.director.resume()), { done: true });
    assert.deepEqual([h.model.of('plan1').length, h.model.of('plan3').length, h.model.of('plan4').length], [1, 1, 2]);
    assert.equal(h.director.getStatus().state, 'running');

    /* 分卷在执导时提意见：按意见重构后续大纲。 */
    const restructured = await h.director.submitFeedback('让莫师傅早点出场');
    assert.equal(restructured.version, 2);
    assert.ok(h.model.of('restructure')[0].last.includes('让莫师傅早点出场') && h.model.of('restructure')[0].last.includes('用户的修订意见（最高优先级）'));
    await assert.rejects(() => h.director.submitFeedback('  '), /先写下你的意见/);
  } finally { h.dispose(); }
});

test('切走聊天时在途的编纲存成草稿并标为中断；回来可以接着编，也可以放弃', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = makeHost({ replies: { plan3: async () => { await gate; return OUTLINE; } } });
  try {
    await h.director.ready();
    const running = h.director.activate();
    await until(() => h.model.of('plan3').length === 1, '编纲走到第 3 步');
    const dir = h.dir();
    const metadataA = h.ctx.chatMetadata, chatA = h.chat.slice();
    h.ctx.chatId = 'chat-2';
    h.ctx.chatMetadata = { variables: {}, reader_ii_enabled: false };
    h.chat.splice(0, h.chat.length, { name: '艾琳', is_user: false, mes: '另一个聊天。' });
    await h.emit('CHAT_CHANGED');
    release();
    assert.deepEqual(plain(await running), { paused: true });
    const draft = await h.readJson(dir + '/draft.json');
    assert.deepEqual([draft.state, draft.step], ['interrupted', 2]);
    assert.equal(await h.readJson(dir + '/active.json'), null, '没有把半截大纲提交到任何聊天上');
    await h.director.ready();
    assert.equal(h.director.getStatus().state, 'idle', '新聊天不受影响');

    h.ctx.chatId = 'chat-1';
    h.ctx.chatMetadata = metadataA;
    h.chat.splice(0, h.chat.length, ...chatA);
    await h.emit('CHAT_CHANGED');
    await h.director.ready();
    const status = h.director.getStatus();
    assert.deepEqual([status.state, status.plan.state, status.plan.step], ['draft', 'interrupted', 2]);
    h.model.table.plan3 = OUTLINE;
    assert.deepEqual(plain(await h.director.resume()), { done: true });
    assert.equal(h.model.of('plan1').length, 1);

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
    const system = h.model.of('plan1')[0].system;
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
