// 世界书（交接 7.E）：上游核心的变换、四个条目的 JSON 与 EJS 渲染。
// 运行：node --test tests/worldbook.test.mjs（只用 Node 标准库，约 1 秒）。
// 渲染默认用 build/worldbook.mjs 里的小 EJS 解释器；环境变量 READER_II_EJS 指向装好的 ejs 包目录（如 /tmp/x/node_modules/ejs）时改用真 ejs。
// 共享盘上不能装 node_modules，要用真 ejs 就在盘外装一份。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as W from '../build/worldbook.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = W.buildWorldbook({ version: 'test' });
const entries = Object.values(built.json.entries);
const content = (name) => entries.find((entry) => entry.comment === W.ENTRY_NAMES[name]).content;
const core = content('core');

let engine = { name: '小 EJS 解释器', render: W.renderEjs };
if (process.env.READER_II_EJS) {
  const ejs = createRequire(import.meta.url)(path.resolve(process.env.READER_II_EJS));
  engine = { name: `ejs ${ejs.VERSION}`, render: (template, locals) => ejs.compile(template, { async: true })(locals) };
}
console.log(`世界书渲染引擎：${engine.name}`);

/* 最小的提示词模板宿主：getvar 读「聊天变量 + 楼层变量」的合并缓存，getLocalVar 读聊天变量，setLocalVar 两边都写（同 ST-Prompt-Template）。 */
function host({ local = {}, stat = {}, user = '继续。', assistant = '' } = {}) {
  const chatVars = structuredClone(local);
  const messageVars = { stat_data: structuredClone(stat) };
  let cache = {};
  const readPath = (object, key) => String(key).split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
  const writePath = (object, key, value) => {
    const parts = String(key).split('.');
    let owner = object;
    for (const part of parts.slice(0, -1)) owner = owner[part] && typeof owner[part] === 'object' ? owner[part] : (owner[part] = {});
    owner[parts.at(-1)] = value;
  };
  const locals = {
    getvar(key, options = {}) {
      const value = readPath(options.scope === 'local' ? chatVars : cache, key);
      const result = value === undefined ? options.defaults : value;
      return options.clone ? structuredClone(result) : result;
    },
    getLocalVar(key, options = {}) { const value = readPath(chatVars, key); return value === undefined ? options.defaults : value; },
    setLocalVar(key, value) { writePath(chatVars, key, structuredClone(value)); writePath(cache, key, structuredClone(value)); return value; },
    getChatMessage(index, role) { return role === 'assistant' ? assistant : user; },
    matchChatMessages(patterns, options = {}) {
      const text = options.role === 'assistant' ? assistant : user;
      return (Array.isArray(patterns) ? patterns : [patterns]).some((p) => (p instanceof RegExp ? p.test(text) : text.includes(String(p))));
    },
  };
  return {
    chatVars,
    async render(name = 'core') {
      cache = structuredClone({ ...chatVars, ...messageVars });
      const out = await engine.render(content(name), locals);
      assert.doesNotMatch(out, /<%|%>/, '模型不该看到 EJS 原文');
      assert.doesNotMatch(out, /undefined|NaN|\[object Object\]/, '不该渲染出 undefined / NaN / [object Object]');
      return out;
    },
  };
}

const ref = (segments) => 'hostref:' + encodeURIComponent(JSON.stringify(segments));
const active = (segments) => ({ status: 'active', rootRef: ref(segments) });
const runtime = (routing) => ({ reader_ii_runtime: { routing } });
function reader(extra = {}) {
  const base = { 地点: '某城的旅店', 关系列表: {}, 任务列表: {}, 主角: { 技能: { '间章:小憩': {}, 故事的主人: {} }, 状态效果: {} }, 命运点数: 120 };
  return { READER: { ...base, ...extra, 主角: { ...base.主角, ...(extra.主角 || {}) } } };
}
const TONE = { 类型: '特殊', 效果: '将故事基调和行文风格转变为近似《测试作品》的风格；解除时由当前状态系统同步处理相关主题。', 层数: 1, 剩余时间: '永久，直至用户要求解除', 来源: '定调' };

test('JSON：四个条目，字段与 v3.3 的世界书相同；能往返；EJS 条目都能编译', () => {
  /* v3.3 的「世界书-Reader-II核心.json」已在第 10 项清理时删除，这里留着它的字段与四个条目的设置（2026-11-15 取）。 */
  const keys = ['uid', 'key', 'keysecondary', 'comment', 'content', 'constant', 'vectorized', 'selective', 'selectiveLogic', 'addMemo', 'order', 'position', 'disable', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'probability', 'useProbability', 'depth', 'group', 'groupOverride', 'groupWeight', 'scanDepth', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'automationId', 'role', 'sticky', 'cooldown', 'delay'];
  const v33 = [
    { comment: '[initvar]Reader-II初始化', uid: 0, constant: false, disable: true, position: 4, order: 100, depth: 4 },
    { comment: '[mvu_update]Reader-II变量更新规则', uid: 1, constant: true, disable: false, position: 4, order: 100, depth: 4 },
    { comment: '[Reader-II] 通用读者核心', uid: 2, constant: true, disable: false, position: 0, order: 100, depth: 4 },
    { comment: 'Reader-II变量列表', uid: 3, constant: true, disable: false, position: 4, order: 200, depth: 1 },
  ];
  assert.deepEqual(entries.map((entry) => entry.comment), v33.map((entry) => entry.comment));
  entries.forEach((entry, index) => {
    assert.deepEqual(Object.keys(entry), keys);
    for (const key of ['uid', 'constant', 'disable', 'position', 'order', 'depth']) assert.equal(entry[key], v33[index][key], `${entry.comment}.${key}`);
  });
  assert.deepEqual(JSON.parse(JSON.stringify(built.json)), built.json);
  assert.equal(content('init'), W.READER_INIT_VARIABLES);
  assert.doesNotMatch(content('init'), /背包/, '初始化不加背包：后备背包按需出现');
  for (const name of ['rules', 'core', 'list']) assert.doesNotThrow(() => W.assertEjs(content(name), name));
  assert.throws(() => W.assertEjs('<%_ if (true) { _%>没关上', '坏模板'), /坏模板 的 EJS 编译不过/);
});

test('核心：取上游人格与机制部分；不读 MVU 路径、不带书海与多核心管理；保留黑幕完整机制、附加设定、主题与称呼', () => {
  assert.ok(built.upstreamLines >= 1900, String(built.upstreamLines));
  assert.equal(built.upstreamVersion, '2026.11.22.1');
  assert.ok(core.startsWith('<%_ /* READER_II_WORLDBOOK core vtest · 上游 reader-core v2026.11.22.1 */_%>\n'));
  for (const token of ['getMessageVar(', 'setMessageVar(', 'dream_black_author_prompt', 'DREAM_WORLDBOOK', '"op":', '99999', '书海', 'dream_core_manager']) {
    assert.ok(!core.includes(token), token);
  }
  for (const token of ["getLocalVar('dream_letter_limit')", "getLocalVar('dream_user_address')", "getLocalVar('dream_extra_settings')", '_dream_theme_place', "'海滨咖啡馆'", "'茶楼'", '消耗9999 FP', '"action":"theme_write"', '"action":"tone_apply"', '"action":"entity_manifest"', 'kuromaku_kill', 'kuromaku_ending', "_reader_get('进度', 0)"]) {
    assert.ok(core.includes(token), token);
  }
  for (const id of ['classic', 'victoria1', 'western_short', 'black_knit', 'knit_linen', 'white_mohair', 'dino_pajama', 'cold_look', 'white_hoodie', 'jacket_work', 'nailong_pajama']) {
    assert.ok(core.includes(`"${id}": "`) && core.includes(`_dreamAppearance === '${id}'`), id);
  }
});

test('锚点失效或区间内容变了时报错，并指出是哪一处', () => {
  const { core: source } = W.upstreamCore(fs.readFileSync(W.WORLDBOOK_SOURCE, 'utf8').replace(/\r\n/g, '\n'));
  assert.throws(() => W.transformCore(source.replace('let _custom_condition_output = [];', 'let _other = [];')), /Reader EJS桥接/);
  assert.throws(() => W.transformCore(source.replaceAll('七层级', '第七层')), /移除命定契约：区间里找不到「七层级」/);
  assert.throws(() => W.upstreamCore(source), /书海资料的起点/);
});

test('读者人格：咖啡馆、复活事件、当前 FP 与结算协议、默认称呼与一天一封信', async () => {
  const out = await host({ stat: reader({ 地点: '不明次元·某咖啡馆' }) }).render();
  for (const token of ['<读者>', '</读者>', '【咖啡馆】', '"persona":"reader"', '<复活机制>', '当前FP: 120', '获取规则:', '\n      结算协议:\n', '"作家先生"或"作家小姐"', '一天只会主动给<user>发一封信件', '当前:无']) {
    assert.ok(out.includes(token), token);
  }
  assert.doesNotMatch(out, /黑之作家|本轮名单|读者资料未就绪|本轮必须为<user>添加/);
});

test('黑幕人格完整五态：常规哀怜 / 达标点杀 / 进度9且已点杀触发诅咒与一次性CG / 刺穿清除祝福 / 折断告白保留祝福', async () => {
  const local = { dream_persona: 'kuromaku' };
  // 1. 普通哀怜（无合格目标、未达诅咒）：祝福每点进度 5%，封顶 9（45%）
  const ordinary = await host({ local, stat: reader({ 进度: 3 }) }).render();
  for (const token of ['<哀怜的少女>', '哀怜的少女:', '世界外的不明存在', '"persona":"kuromaku"', '【少女的祝福状态维护】', '造成的最终伤害+15%，受到的全类型伤害-15%，经验获取+15%']) {
    assert.ok(ordinary.includes(token), token);
  }
  assert.doesNotMatch(ordinary, /黑之作家|本轮名单|诅咒尽头|无形恶意/);
  const blessed15 = { 类型: '特殊', 效果: '造成的最终伤害+15%，受到的全类型伤害-15%，经验获取+15%', 层数: 1, 剩余时间: '永久', 来源: '少女的祝福' };
  assert.doesNotMatch(await host({ local, stat: reader({ 进度: 3, 主角: { 状态效果: { 祝福: blessed15 } } }) }).render(), /少女的祝福状态维护/);
  assert.doesNotMatch(await host({ local, stat: reader({ 进度: 0 }) }).render(), /少女的祝福状态维护/);

  // 2. 进度 9 但从未点杀：不触发诅咒
  const notCursedYet = await host({ local, stat: reader({ 进度: 9, 黑幕已点杀: false }) }).render();
  assert.doesNotMatch(notCursedYet, /黑之作家|诅咒尽头/);

  // 3. 常规点杀（好感>=70，兼容无血量通用卡；死亡/崩溃角色被排除）
  const killTurn = await host({
    local,
    stat: reader({
      关系列表: {
        存活同伴: { 好感度: 75, 状态效果: {} },
        已故同伴: { 好感度: 90, 状态效果: { 已死亡: { 效果: '已死' } } },
        九十九夜梦: { 好感度: 100, 状态效果: {} },
      },
    }),
  }).render();
  assert.match(killTurn, /黑之作家/);
  assert.ok(killTurn.includes('存活同伴'));
  assert.ok(!killTurn.includes('已故同伴'));
  assert.match(killTurn, /"action":"kuromaku_kill"/);

  // 4. 进度 >= 9 且黑幕已点杀：诅咒常驻，切换第三人格；未主动寻找不出一次性CG，主动寻找出一次性CG
  const cursedIdle = await host({ local, user: '在城里逛逛。', stat: reader({ 进度: 9, 黑幕已点杀: true }) }).render();
  assert.match(cursedIdle, /黑之作家/);
  assert.match(cursedIdle, /纸牌/);
  assert.doesNotMatch(cursedIdle, /纸牌与仪式匕首/);
  assert.match(cursedIdle, /\+45%/);

  const cursedSeek = await host({ local, user: '夜梦，出来见我，我要找你当面对质。', stat: reader({ 进度: 9, 黑幕已点杀: true }) }).render();
  assert.match(cursedSeek, /纸牌与仪式匕首/);
  assert.match(cursedSeek, /"action":"kuromaku_ending","ending":"killed"/);
  assert.match(cursedSeek, /"action":"kuromaku_ending","ending":"confessed"/);

  // 5. 刺穿结局（killed）：永久回到纯哀怜的少女、移除祝福、复活解禁按需注入
  const killedOut = await host({
    local,
    user: '继续旅途。',
    stat: reader({
      进度: 9, 黑幕已点杀: true, 黑幕结局: 'killed',
      关系列表: { 存活同伴: { 好感度: 95, 状态效果: {} } },
      主角: { 状态效果: { 祝福: { 效果: '造成的最终伤害+45%', 剩余时间: '永久', 来源: '少女的祝福' } } },
    }),
  }).render();
  assert.match(killedOut, /<哀怜的少女>/);
  assert.doesNotMatch(killedOut, /黑之作家|纸牌与仪式匕首|复活解禁/);
  assert.match(killedOut, /移除名为“祝福”的状态效果/);

  const killedRevive = await host({ local, user: '我想复活之前死去的同伴。', stat: reader({ 进度: 9, 黑幕已点杀: true, 黑幕结局: 'killed' }) }).render();
  assert.match(killedRevive, /【复活解禁】/);

  // 6. 折断结局（confessed）：保留告白后第三人格与祝福，零恶意/诅咒词，复活解禁按需注入
  const confessedOut = await host({
    local,
    user: '今天休息。',
    stat: reader({ 进度: 9, 黑幕已点杀: true, 黑幕结局: 'confessed', 关系列表: { 存活同伴: { 好感度: 95, 状态效果: {} } } }),
  }).render();
  assert.match(confessedOut, /黑之作家/);
  assert.match(confessedOut, /卸下假面/);
  assert.doesNotMatch(confessedOut, /【无形恶意】|【自然死亡】|【诅咒尽头】|纸牌与仪式匕首|复活解禁/);
  assert.match(confessedOut, /造成的最终伤害\+45%/);
});

test('附加设定（机制/外貌/性格）无分隔标签直接融入对应提示词，且禁书支持超过10本', async () => {
  const extraItems = [
    { id: 'm1', name: '进度联动', kind: 'mechanism', enabled: true, applyWhenSilent: true, content: '当前FP=<%= stat_data.READER.命运点数 %>' },
    { id: 'p1', name: '口癖', kind: 'personality', enabled: true, applyWhenSilent: false, content: '偶尔轻轻叹气' },
    { id: 'a1', name: '', kind: 'appearance', enabled: true, applyWhenSilent: false, content: '戴着无框金丝眼镜' },
  ];
  const banlist = Array.from({ length: 14 }, (_, i) => `通用禁书${i + 1}`);
  const out = await host({
    local: { dream_extra_settings: JSON.stringify(extraItems), dream_banlist: JSON.stringify(banlist) },
    user: '看看定调书架',
    stat: reader({ 地点: '不明次元·某咖啡馆', 命运点数: 333 }),
  }).render();
  assert.doesNotMatch(out, /【附加设定】|性格补充|外貌补充/);
  assert.ok(out.includes('【进度联动】: 当前FP=333'));
  assert.match(out, /性格:[^\r\n]*；口癖：偶尔轻轻叹气/);
  assert.match(out, /此刻形象:[^\r\n]*；戴着无框金丝眼镜/);
  assert.match(out, /\[书目展示\]/);
  for (const title of banlist) assert.ok(out.includes(title), title);
});

test('主题与设置：盛夏主题的地点与服装、关掉发言限制、自定义称呼', async () => {
  const local = { dream_visual_theme: 'summer', dream_letter_limit: 'off', dream_user_address: '阿明' };
  const out = await host({ local, stat: reader({ 地点: '南方的海滨' }) }).render();
  for (const token of ['【海滨咖啡馆】', '深蓝色连体泳衣', '称呼<user>为"阿明"', '在某个海滨咖啡馆中阅读着']) assert.ok(out.includes(token), token);
  assert.doesNotMatch(out, /一天只会主动给<user>发一封信件/);
  assert.ok((await host({ local: { dream_visual_theme: 'ink' }, stat: reader({ 地点: '江南古城' }) }).render()).includes('【茶楼】'));
});

test('宿主货币：MVU 路由与小白X 聊天变量都读得到；绑定了宿主货币时不给获取规则', async () => {
  const mvu = await host({ local: runtime({ currency: active(['stat_data', '主角', '金币']) }), stat: { 主角: { 金币: 70 }, ...reader() } }).render();
  assert.ok(mvu.includes('当前FP: 70'));
  assert.doesNotMatch(mvu, /获取规则:|^ {6}结算协议:/m);
  const lwbLocal = { 数据: { 主角: { 金币: 55 } }, ...runtime({ currency: active(['stat_data', '数据', '主角', '金币']) }) };
  assert.ok((await host({ local: lwbLocal, stat: reader() }).render()).includes('当前FP: 55'));
  assert.ok((await host({ local: { ...lwbLocal, reader_ii_host_kind: 'mvu' }, stat: reader() }).render()).includes('当前FP: 0'));
});

test('主题写入：9999 FP，认通用版定调的《作品名》，写入走事件；余额不足时说明原因', async () => {
  const stat = (fp) => reader({ 命运点数: fp, 主角: { 状态效果: { 定调: TONE } } });
  const ok = await host({ stat: stat(10000), user: '我要主题写入' }).render();
  assert.ok(ok.includes('消耗9999 FP，将「测试作品」的主题写入世界'));
  assert.ok(ok.includes('"action":"theme_write","title":"测试作品"'));
  assert.ok((await host({ stat: stat(9998), user: '我要主题写入' }).render()).includes('FP不足（需要9999 FP，当前9998 FP）'));
});

test('静默模式：只说明保持静默与 FP 结算事件，不出人格正文', async () => {
  const out = await host({ local: { dream_silent_mode: 'on' }, stat: reader() }).render();
  for (const token of ['保持完全静默', '只在回复末尾静默输出一次FP结算事件', '\n      结算协议:\n', '当前FP: 120']) assert.ok(out.includes(token), token);
  assert.doesNotMatch(out, /书信风格|<复活机制>/);
});

test('其余人格都能渲染，复活事件带各自的人格名', async () => {
  const custom = JSON.stringify({ id: 'p1', systemName: '测试人格', definition: '一位测试用的读者' });
  for (const [persona, extra] of [['shoujo', {}], ['genki', {}], ['weirdo', {}], ['custom', { dream_custom_persona: custom }]]) {
    const out = await host({ local: { dream_persona: persona, ...extra }, stat: reader() }).render();
    assert.ok(out.includes(`"persona":"${persona}"`), persona);
  }
});

test('初始技能与章节任务：缺了才提示，槽坏了不提示；章节起始带上本轮有没有生成指令', async () => {
  const bare = reader({ 主角: { 技能: {} } });
  const missing = await host({ stat: bare }).render();
  assert.ok(missing.includes('本轮必须为<user>添加间章:小憩技能') && missing.includes('只施加数值减益'));
  const broken = { skills: { status: 'broken', rootRef: '' }, statuses: { status: 'broken', rootRef: '' }, tasks: { status: 'broken', rootRef: '' } };
  const out = await host({ local: runtime(broken), stat: bare, assistant: '那就翻开这一章吧。' }).render();
  assert.doesNotMatch(out, /本轮必须为<user>添加|\[章节生成指令\]本轮必须生成|本轮不生成章节任务/);
  assert.ok(out.includes('当前:无'));
  const epic = await host({ stat: reader(), assistant: '那就翻开这一章吧。' }).render();
  assert.ok(epic.includes('当前:有') && epic.includes('[章节生成指令]本轮必须生成读者章节任务') && epic.includes('"action":"create"'));
});

test('变量列表与更新规则：后备背包非空才出现；绑定了宿主背包时不出现', async () => {
  const bag = { 回复药: { 数量: 2, 品质: '3星', 类型: '道具', 标签: ['消耗品'], 效果: '恢复', 描述: '测试' } };
  const list = await host({ stat: reader({ 背包: bag }) }).render('list');
  assert.ok(list.includes('"用户背包"') && list.includes('"当前FP": 120') && list.includes('"当前地点": "某城的旅店"'));
  assert.doesNotMatch(await host({ stat: reader() }).render('list'), /用户背包/);
  const hosted = runtime({ inventory: active(['stat_data', '主角', '背包']) });
  assert.doesNotMatch(await host({ local: hosted, stat: { 主角: { 背包: {} }, ...reader({ 背包: bag }) } }).render('list'), /用户背包/);
  const rules = await host({ stat: reader({ 背包: bag }) }).render('rules');
  assert.ok(rules.includes('## /READER/地点') && rules.includes('## /READER/背包'));
  assert.doesNotMatch(await host({ stat: reader() }).render('rules'), /\/READER\/背包/);
  assert.doesNotMatch(await host({ local: hosted, stat: reader({ 背包: bag }) }).render('rules'), /\/READER\/背包/);
  const all = Object.fromEntries(['location', 'characters', 'tasks', 'skills', 'statuses', 'currency', 'inventory'].map((slot) => [slot, active(['stat_data', 'x'])]));
  assert.equal((await host({ local: runtime(all), stat: { x: 1, ...reader() } }).render('rules')).trim(), '');
});
