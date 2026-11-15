/** Reader-II 命运抽卡（通用版）的测试：只测通用化改动过的地方与角色条目生成；与上游相同的部分（资料库抽样、小池解析、保底概率……）在上游读者的测试里。
 *  运行：在 gacha/ 的盘外副本里 npm install 之后 npm test。 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DEFAULT_QUALITY_NAMES,DEFAULT_RULES,QUALITY_PRESETS,TIERS,UNIQUE,activeScale,makeScale,normalizeQualityNames,qualityOf,ratesText,seededRng,setQualityScale,starOfQuality} from '../src/gacha/rarity';
import {createNet,type FetchLike} from '../src/gacha/net';
import type {WorkCard} from '../src/gacha/sources';
import {buildCharacterDossier,characterDossierText,characterPassages,hasCharacterMaterial,sameCharacter} from '../src/gacha/dossier';
import {kindPrompt,planPrompt,type GachaCard,type SmallPool} from '../src/gacha/pool';
import {CAST_COST,DRAW_COST,PRICE_SCALE_MAX,PRICE_SCALE_MIN,SETTINGS_KEY,TEN_COST,createGacha,defaultSettings,localGachaPort,normalizeDurable,normalizeSettings,priceScaleOf,qualityList,type CommitRequest,type GachaPort,type GachaSettings,type StoredDurable} from '../src/gacha/session';
import {BAG_TAG,RECYCLE_BASE,RECYCLE_ORDER,applyGachaDraw,applyRecycle,gachaBagItem,ledgerAfterDraw,ledgerAfterRecycle,listGachaBag,normalizeLedger,recyclePrice,scaledPrice,type BagLedger,type BagStore} from '../src/gacha/bag';
import {DEFAULT_SPEC_ENTRIES,defaultSpecSettings,normalizeSpecSettings} from '../src/gacha/spec';
import {ENTRY_EXTRA_KEY,buildWorldbookEntry,defaultEntrySettings,ensureWorldbook,entryMarker,entryPrompt,findMarkedEntry,normalizeEntryRecords,normalizeEntrySettings,parseEntryReply,pickTemplate,readTemplateLibrary,setWorldbookEntryEnabled,worldbookEntryPort,writeWorldbookEntry,type WorldbookWriter} from '../src/gacha/entry';
import {GENERIC_ENTRY_TEMPLATE} from '../src/gacha/entry-template.generated';
import {DURABLE_KEY,TEMPLATE_LIBRARY_KEY,createReaderGacha,readerGachaPort,readerTemplateLibrary,storedPriceScale,type ReaderGachaHost,type ReaderTx} from '../src/reader/gacha-reader';

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const own = (parent: Obj, key: string): Obj => {const v = parent[key]; if (v && typeof v === 'object' && !Array.isArray(v)) return v as Obj; const next: Obj = {}; parent[key] = next; return next;};
const ownList = (parent: Obj, key: string): unknown[] => {if (!Array.isArray(parent[key])) parent[key] = []; return parent[key] as unknown[];};

/* ---------- 假网络：按 URL 片段返回 JSON ---------- */
type Route = [RegExp, unknown | ((url: string, init?: RequestInit) => unknown)];
function fakeFetch(routes: Route[], log: string[] = []): FetchLike {
  return async (url, init) => {
    log.push((init?.method ?? 'GET') + ' ' + url);
    for (const [re, body] of routes) if (re.test(url)) {
      const v = typeof body === 'function' ? (body as (u: string, i?: RequestInit) => unknown)(url, init) : body;
      if (typeof v === 'number') return new Response('{}', {status: v});
      return new Response(JSON.stringify(v), {status: 200});
    }
    return new Response('{"error":"no route"}', {status: 404});
  };
}
const work = (key: string, title: string, extra: Partial<WorkCard> = {}): WorkCard => ({key, source: key.split(':')[0] as WorkCard['source'], sourceId: key.split(':').slice(1).join(':'), title, media: 'anime', ...extra});
function memoryStorage() {const m = new Map<string, string>(); return {getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => {m.set(k, v);}, m};}

/* ---------- 三种宿主背包（真正的读写在读者的语义层，这里只模拟它对抽卡露出的三个接口） ---------- */
/** 以名字为键的表，条目带数量：同名叠加。 */
const tableStore: BagStore = {
  list: data => Object.entries(rec(data.bag)).map(([name, v]) => ({name, count: Number(rec(v).count) || 0})),
  add(data, item) {const bag = own(data, 'bag'), old = rec(bag[item.name]); bag[item.name] = {...item, count: (Number(old.count) || 0) + item.count}; return {name: item.name};},
  remove(data, name, count) {
    const bag = own(data, 'bag'), have = Number(rec(bag[name]).count) || 0, n = Math.min(have, Math.max(0, count));
    if (n >= have) delete bag[name]; else bag[name] = {...rec(bag[name]), count: have - n};
    return {removed: n};
  },
};
/** 以名字为键的表，条目没有数量字段：同名的另一件加上区分用的后缀，找到空位再放。 */
const plainTableStore: BagStore = {
  list: data => Object.keys(rec(data.bag)).map(name => ({name, count: 1})),
  add(data, item, options) {
    const bag = own(data, 'bag');
    let name = item.name;
    if (name in bag) {const alt = `${item.name}（${options?.distinct ?? '另一件'}）`; name = alt; for (let i = 2; name in bag; i++) name = alt + i;}
    bag[name] = {品质: item.quality, 说明: item.description};
    return {name};
  },
  remove(data, name) {const bag = own(data, 'bag'); if (!(name in bag)) return {removed: 0}; delete bag[name]; return {removed: 1};},
};
/** 对象数组，条目没有数量字段：每件一条。 */
const rowsStore: BagStore = {
  list: data => {const n = new Map<string, number>(); for (const row of ownList(data, 'items')) {const name = String(rec(row).name); n.set(name, (n.get(name) ?? 0) + 1);} return [...n].map(([name, count]) => ({name, count}));},
  add(data, item) {const rows = ownList(data, 'items'); for (let i = 0; i < item.count; i++) rows.push({name: item.name, 描述: `${item.quality} ${item.type}：${item.description}`}); return {name: item.name};},
  remove(data, name, count) {
    const rows = ownList(data, 'items');
    let removed = 0;
    for (let i = rows.length - 1; i >= 0 && removed < count; i--) if (rec(rows[i]).name === name) {rows.splice(i, 1); removed++;}
    return {removed};
  },
};
/** 名字数组：只有名字，同名可以有好几个。 */
const namesStore: BagStore = {
  list: data => {const n = new Map<string, number>(); for (const name of ownList(data, 'names')) n.set(String(name), (n.get(String(name)) ?? 0) + 1); return [...n].map(([name, count]) => ({name, count}));},
  add(data, item) {const names = ownList(data, 'names'); for (let i = 0; i < item.count; i++) names.push(item.name); return {name: item.name};},
  remove(data, name, count) {
    const names = ownList(data, 'names');
    let removed = 0;
    for (let i = names.length - 1; i >= 0 && removed < count; i--) if (names[i] === name) {names.splice(i, 1); removed++;}
    return {removed};
  },
};
const charge = (d: Obj, cost: number) => {const fp = Number(d.fp); if (fp < cost) throw Error('FP不足，当前仅有 ' + fp + 'FP'); d.fp = fp - cost; return fp - cost;};
const credit = (d: Obj, amount: number) => {d.fp = Number(d.fp) + amount; return Number(d.fp);};

/* ---------- 一个小池与几张卡 ---------- */
const SAO = work('bangumi:7', '刀剑神域', {original: 'ソードアート・オンライン'});
const SAO_POOL = {version: 2, workKey: 'bangumi:7', work: SAO, items: [], fates: [], by: 'model', at: 1, sources: []} as SmallPool;
const KIRITO: GachaCard = {id: 'bangumi:7#character0', kind: 'character', star: UNIQUE, name: '桐人', description: '被困在死亡游戏里的独行剑士', role: '主角', power: '二刀流，全服反应最快'};
const SWORD: GachaCard = {id: 'bangumi:7#item0', kind: 'item', star: 6, name: '逐暗者', description: '漆黑的单手直剑', type: '武器', owner: '桐人', use: '斩击'};
const POTION: GachaCard = {id: 'bangumi:7#item1', kind: 'item', star: 2, name: '回复水晶', description: '瞬间回复生命', type: '消耗品'};
const FATE: GachaCard = {id: 'bangumi:7#fate0', kind: 'fate', star: 4, name: '第七十四层', description: '独自面对楼层首领', chapter: '艾恩葛朗特', hook: '你推开了首领房间的门'};

/** 一次回复里带着规划与三种卡：物品 40 件、命运 24 张、角色 20 位。 */
const ITEM_STARS = [6, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1];
const FATE_STARS = [5, 5, 5, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1];
const MODEL_REPLY = JSON.stringify({protagonist: '英雄', plan: {items: 40, fates: 24, characters: 20},
  items: ITEM_STARS.map((star, i) => ({name: '物品' + i, star, type: '武器', owner: '英雄', description: '来历' + i, use: '用途'})),
  fates: FATE_STARS.map((star, i) => ({name: '命运' + i, star, chapter: '第' + i + '章', description: '走向' + i, hook: '契机'})),
  characters: Array.from({length: 20}, (_, i) => ({name: '角色' + i, role: i ? '同伴' : '主角', description: '身份' + i, power: '实力' + i})),
});
/** 假宿主：命运点数与背包放在一份数据里，扣点、入包与回收都走 bag.ts 的真实现；保底与账本、缓存、设置各存各的。 */
function fakePort(over: Partial<GachaPort> = {}, start = 10000, store: BagStore = tableStore) {
  let durable: unknown, device: unknown, settings: unknown, blocked: string | undefined, data: Obj = {fp: start};
  const commits: CommitRequest[] = [], casts: {cost: number; theme: string}[] = [], llmCalls: string[] = [];
  const port: GachaPort = {
    contextId: 'c', mode: 'host',
    readDurable: () => durable, async writeDurable(v) {durable = structuredClone(v);},
    readDevice: () => device, writeDevice(v) {device = structuredClone(v);},
    readSettings: () => settings, writeSettings(v) {settings = structuredClone(v);},
    wallet: () => blocked ? {fp: Number(data.fp), blocked} : {fp: Number(data.fp)},
    async commit(req) {commits.push(req); const next = structuredClone(data), r = applyGachaDraw(next, req, store, charge, d => Number(d.fp)); data = next; return {fp: r.fp, ...(r.added.length ? {added: r.added} : {})};},
    async commitCast(req) {casts.push(req); const next = structuredClone(data), fp = charge(next, req.cost); data = next; return {fp};},
    bag: (ledger, scale) => listGachaBag(data, ledger, store, activeScale(), scale),
    async recycle(picks, ledger, scale) {const next = structuredClone(data), r = applyRecycle(next, picks, ledger, store, credit, scale); data = next; return r;},
    async llm(system, _user, o) {llmCalls.push(o.purpose + ':' + system.slice(0, 8)); return o.purpose === 'pool' ? MODEL_REPLY : '{}';},
    fetch: fakeFetch([
      [/api\.bgm\.tv\/v0\/search/, () => ({total: 500, data: Array.from({length: 40}, (_, i) => ({id: Math.floor(Math.random() * 1e9) + i, type: 2, name_cn: '作品' + Math.random().toString(36).slice(2), images: {}, tags: []}))})],
      [/api\.bgm\.tv\/v0\/subjects\/\d+\/characters/, [{id: 1, name: '主角', relation: '主角', type: 1}]],
      [/api\.bgm\.tv\/v0\/subjects\/\d+$/, {summary: '简介'}],
      [/api\.bgm\.tv\/v0\/characters/, {summary: '', infobox: []}],
      [/wikipedia/, {query: {search: [], pages: {}}}],
      [/anilist|vndb|jikan/, 500],
    ]),
    ...over,
  };
  return {port, commits, casts, llmCalls, get data() {return data;}, get fp() {return Number(data.fp);}, block(why?: string) {blocked = why;}, get durable() {return durable as StoredDurable;}, get device() {return device;}};
}
/** 假读者：通用版 ReaderTransactions 的这一部分（命运点数与背包经语义层读写；这里用带数量的表）。 */
function fakeReader(o: {fp?: number} = {}) {
  let data: Obj = {fp: o.fp ?? 3000, bag: {}}, chatId = 'c1', runs = 0, transacts = 0, seq = 0;
  const ctx = {characterId: 'x', getCurrentChatId: () => chatId, chat: [{mes: '你好'}], chatMetadata: {variables: {} as Obj}, saves: 0, async saveMetadata() {ctx.saves++;}};
  const fp = (d: Obj) => {const v = Number(d.fp); if (d.fp === undefined || !Number.isFinite(v) || v < 0) throw Error('还没有读到有效的命运点数'); return v;};
  const tx: ReaderTx = {
    capture: () => ({chatId, characterId: 'x', messageId: 0, id: 'reader-' + ++seq}),
    read: () => structuredClone(data), fp,
    charge(d, cost) {const v = fp(d); if (v < cost) throw Error('FP不足，当前仅有 ' + v + 'FP'); d.fp = v - cost; return v - cost;},
    credit(d, amount) {const v = fp(d) + amount; d.fp = v; return v;},
    inventory: d => tableStore.list(d), inventoryAdd: (d, item, options) => tableStore.add(d, item, options), inventoryRemove: (d, name, count) => tableStore.remove(d, name, count),
    async transact(_t, _id, mutate) {transacts++; const next = structuredClone(data), r = mutate(next); data = next; return r;},
    async run(_k, action) {runs++; return action(tx.capture());},
  };
  return {ctx, tx, switchChat() {chatId = 'c2';}, get data() {return data;}, stats: () => ({runs, transacts})};
}
const readerHost = (r: ReturnType<typeof fakeReader>, over: Partial<ReaderGachaHost> = {}): ReaderGachaHost => ({document: undefined as never, transactions: r.tx, context: () => r.ctx, storage: memoryStorage(), fetch: async () => new Response('{}'), proxyBase: 'http://127.0.0.1:8017', ...over});

/* ====================== 7.B：通用化 ====================== */

test('档位名：默认 1星…6星 与 唯一；四套预设可以一键填入；自己填的名字整理成 7 项；服务按设置换档位名，界面、提示词与入包都用它', async () => {
  setQualityScale(undefined);
  assert.deepEqual(TIERS.map(s => qualityOf(s)), ['1星', '2星', '3星', '4星', '5星', '6星', '唯一']); assert.equal(activeScale().name, '1星～6星');
  assert.deepEqual(QUALITY_PRESETS.map(p => [p.id, p.names.length, new Set(p.names).size]), [['star', 7, 7], ['word', 7, 7], ['letter', 7, 7], ['color', 7, 7]]);
  assert.deepEqual(QUALITY_PRESETS.find(p => p.id === 'word')!.names, ['普通', '优良', '稀有', '史诗', '传说', '神话', '唯一']);
  assert.deepEqual(TIERS.map(s => normalizeQualityNames(['凡', '', '凡', ' 灵 ', '<b>仙</b>', undefined, '道'])[s]), ['凡', '2星', '3星', '灵', 'b仙/b', '6星', '道'], '空的、重复的退回默认名；尖括号去掉');
  assert.deepEqual(TIERS.map(s => normalizeQualityNames({1: '白', 7: '金'})[s]), ['白', '2星', '3星', '4星', '5星', '6星', '金'], '也认以 1–7 为键的对象');
  assert.deepEqual(TIERS.map(s => normalizeQualityNames(['2星'])[s]), ['2星', '2星′', '3星', '4星', '5星', '6星', '唯一'], '默认名被别的档位占用时加记号，仍然不重名');
  assert.deepEqual(qualityList(undefined), TIERS.map(s => DEFAULT_QUALITY_NAMES[s])); assert.deepEqual(defaultSettings().quality, qualityList(undefined));
  assert.deepEqual(normalizeSettings({quality: ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX']}).quality, ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX']); assert.equal(normalizeSettings({quality: 'x'}).quality[5], '6星');
  const custom = makeScale(normalizeQualityNames(['凡品', '良品', '上品', '极品', '绝品', '仙品', '命定']));
  assert.equal(custom.label(6), '仙品'); assert.equal(custom.name, '凡品～仙品');
  // 服务：建立时与保存设置时换上设置里的档位名。
  const f = fakePort(), g = createGacha(f.port, {rng: seededRng(3)});
  assert.equal(g.scale().label(6), '6星');
  g.saveSettings({...g.settings(), quality: ['凡品', '良品', '上品', '极品', '绝品', '仙品', '命定']});
  assert.equal(g.scale().label(6), '仙品'); assert.equal(qualityOf(7), '命定'); assert.equal(starOfQuality('极品'), 4); assert.equal(starOfQuality('神话'), undefined);
  assert.match(ratesText(DEFAULT_RULES, true)[0]!, /^命定 0\.3% · 仙品 0\.3% · 绝品 1\.2%/);
  const again = createGacha(f.port); assert.equal(again.scale().label(1), '凡品', '下次打开还是这套名字');
  // 入包：品质写的是设置里的名字。
  assert.deepEqual([gachaBagItem(SWORD, SAO_POOL, activeScale()).quality, gachaBagItem(KIRITO, SAO_POOL, activeScale()).quality], ['仙品', '命定']);
  assert.match(gachaBagItem(SWORD, SAO_POOL, activeScale()).description, /^抽自动画《刀剑神域》的仙品物品，原属桐人。$/);
  // 提示词只说 1★ 最低、6★ 最高，不带任何一套固定的档位名。
  const d = {work: SAO, synopsis: '简介', characters: [], sections: [], facts: [], sources: [], notes: []};
  for (const p of [planPrompt(d, ['item', 'fate', 'character']), kindPrompt(d, 'fate', {item: 30, fate: 20, character: 10}, ['item', 'fate', 'character'])]) {
    assert.match(p.system, /1★ 最低、6★ 最高/); assert.ok(!/普通|优良|稀有|史诗|传说|神话/.test(p.system + p.user), '提示词里没有固定的档位名');
  }
  setQualityScale(undefined);
});

test('价格倍率：抽卡价与回收价一起缩放（默认 1，范围 0.001～1000）；宿主按缩放后的价钱扣点；本机演示不扣点；大厅价签读这台设备存的设置', async () => {
  assert.deepEqual([priceScaleOf(undefined), priceScaleOf('2.5'), priceScaleOf(0), priceScaleOf(-1), priceScaleOf(PRICE_SCALE_MAX + 1), priceScaleOf(PRICE_SCALE_MIN), priceScaleOf('abc'), priceScaleOf(null), priceScaleOf(true)], [1, 2.5, 1, 1, 1, PRICE_SCALE_MIN, 1, 1, 1]);
  assert.equal(defaultSettings().priceScale, 1); assert.equal(normalizeSettings({priceScale: 0.01}).priceScale, 0.01); assert.equal(normalizeSettings({priceScale: 1e9}).priceScale, 1);
  assert.deepEqual([scaledPrice(200, 1), scaledPrice(200, 0.01), scaledPrice(8, 0.001), scaledPrice(2000, 100), scaledPrice(0, 5), scaledPrice(200, NaN), scaledPrice(200, -3)], [200, 2, 1, 200000, 0, 200, 200], '有价的东西缩放后至少 1；倍率不对时按 1');
  assert.deepEqual(RECYCLE_ORDER.map(s => recyclePrice(s)), [6000, 6000, 2000, 200, 100, 20, 8]); assert.deepEqual(RECYCLE_ORDER.map(s => recyclePrice(s, 0.01)), [60, 60, 20, 2, 1, 1, 1]); assert.equal(RECYCLE_BASE[7], RECYCLE_BASE[6]);
  const f = fakePort({}, 1e6), g = createGacha(f.port, {rng: seededRng(7)});
  assert.deepEqual([g.castCost(), g.cost(1), g.cost(10)], [CAST_COST, DRAW_COST, TEN_COST]); assert.deepEqual([CAST_COST, DRAW_COST, TEN_COST], [1000, 200, 2000]);
  g.saveSettings({...g.settings(), priceScale: 0.05});
  assert.deepEqual([g.castCost(), g.cost(1), g.cost(10)], [50, 10, 100]);
  await g.cast('acg-fantasy'); assert.deepEqual(f.casts.map(c => c.cost), [50]); assert.equal(f.fp, 1e6 - 50);
  const w = g.spread()!.works[0]!; await g.compile(w);
  const out = await g.draw(w.key, 10);
  assert.equal(out.record.cost, 100); assert.equal(f.commits.at(-1)!.cost, 100); assert.equal(f.fp, 1e6 - 150);
  // 回收价按同一个倍率。
  const held = g.bag(), low = held.at(-1)!;
  assert.equal(low.price, recyclePrice(low.star, 0.05)); assert.equal((await g.recycle([{name: low.name, count: 1}])).gained, low.price);
  g.saveSettings({...g.settings(), priceScale: 20}); assert.equal(g.cost(10), 40000); assert.equal(g.canDraw(1).ok, true);
  // 本机演示不扣点，倍率不影响。
  const local = createGacha(localGachaPort(memoryStorage(), async () => new Response('{}')));
  local.saveSettings({...local.settings(), priceScale: 50}); assert.deepEqual([local.castCost(), local.cost(1), local.cost(10)], [0, 0, 0]);
  // 大厅价签：没有面板时读这台设备存的设置。
  const storage = memoryStorage(), api = createReaderGacha();
  assert.deepEqual(api.price(storage), {cast: 1000, single: 200, ten: 2000});
  storage.setItem(SETTINGS_KEY, JSON.stringify({priceScale: 0.5})); assert.equal(storedPriceScale(storage), 0.5); assert.deepEqual(api.price(storage), {cast: 500, single: 100, ten: 1000});
  storage.setItem(SETTINGS_KEY, '{坏的'); assert.deepEqual(api.price(storage), {cast: 1000, single: 200, ten: 2000});
  setQualityScale(undefined);
});

test('入包账本：抽卡时记下入包的名字、档位与件数，回收时销账；回收只认账上有、背包里也确实还在的东西，件数取两边较小的', () => {
  setQualityScale(undefined);
  let ledger: BagLedger = {};
  ledger = ledgerAfterDraw(ledger, [SWORD, POTION, POTION, KIRITO, FATE], ['逐暗者', '回复水晶', '回复水晶', '角色·桐人', '命运·第七十四层'], SAO_POOL);
  assert.deepEqual(ledger, {
    逐暗者: {star: 6, kind: 'item', work: '刀剑神域', type: '武器', count: 1}, 回复水晶: {star: 2, kind: 'item', work: '刀剑神域', type: '消耗品', count: 2},
    '角色·桐人': {star: 7, kind: 'character', work: '刀剑神域', type: '角色书页', count: 1}, '命运·第七十四层': {star: 4, kind: 'fate', work: '刀剑神域', type: '命运', count: 1},
  });
  assert.deepEqual(ledgerAfterDraw(ledger, [SWORD], [''], SAO_POOL), ledger, '没有放进背包的不记账');
  assert.equal(ledgerAfterDraw(ledger, [{...POTION, star: 5}], ['回复水晶'], SAO_POOL).回复水晶!.count, 1, '同名但档位变了：按新的重新记');
  assert.deepEqual(normalizeLedger({好的: {star: 3, kind: 'fate', work: 'w', type: 't', count: 2}, 档位不对: {star: 9, count: 1}, 没有件数: {star: 2, count: 0}, 不是对象: 5}), {好的: {star: 3, kind: 'fate', work: 'w', type: 't', count: 2}});
  assert.deepEqual(normalizeDurable({}).bag, {}); assert.deepEqual(normalizeDurable({bag: ledger}).bag, ledger);
  // 对账：背包里少了（正文里用掉了一瓶、书页被具现了）就按背包里的算；背包里多出来的（不是抽卡给的）不算。
  const data: Obj = {fp: 100, bag: {逐暗者: {count: 1}, 回复水晶: {count: 1}, 自己买的药: {count: 9}}};
  const listed = listGachaBag(data, ledger, tableStore, activeScale(), 1);
  assert.deepEqual(listed.map(e => [e.name, e.quality, e.kind, e.count, e.price, e.star]), [['逐暗者', '6星', 'item', 1, 6000, 6], ['回复水晶', '2星', 'item', 1, 20, 2]], '按档位从高到低；角色书页与命运已经不在背包里');
  assert.equal(listGachaBag(data, ledger, tableStore, activeScale(), 0.5)[0]!.price, 3000);
  // 回收：逐件核对，移出并加回命运点数；销账。
  assert.throws(() => applyRecycle(structuredClone(data), [], ledger, tableStore, credit), /没有选择要回收的东西/);
  assert.throws(() => applyRecycle(structuredClone(data), [{name: '自己买的药', count: 1}], ledger, tableStore, credit), /不在命运抽卡的入包记录里/);
  assert.throws(() => applyRecycle(structuredClone(data), [{name: '角色·桐人', count: 1}], ledger, tableStore, credit), /已经变了/, '账上有、背包里没有了');
  const r = applyRecycle(data, [{name: '回复水晶', count: 5}, {name: '逐暗者', count: 1}], ledger, tableStore, credit, 2);
  assert.deepEqual(r, {fp: 100 + 40 + 12000, gained: 12040, removed: 2, items: [{name: '回复水晶', removed: 1}, {name: '逐暗者', removed: 1}]}, '想收 5 瓶，账上 2 瓶、背包里只剩 1 瓶：收 1 瓶');
  assert.deepEqual(data, {fp: 12140, bag: {自己买的药: {count: 9}}});
  ledger = ledgerAfterRecycle(ledger, r.items);
  assert.deepEqual(Object.entries(ledger).map(([k, v]) => [k, v.count]), [['回复水晶', 1], ['角色·桐人', 1], ['命运·第七十四层', 1]], '收掉几件销几件，收完的从账上去掉');
  assert.deepEqual(ledgerAfterRecycle(ledger, [{name: '没记过的', removed: 3}]), ledger);
});

test('三种背包形状：以名字为键的表、对象数组、名字数组——入包与回收都只经语义层的三个接口，回收不看宿主条目上的标签', () => {
  setQualityScale(['凡', '良', '上', '极', '绝', '仙', '命']);
  const cards = [SWORD, POTION, POTION, KIRITO, FATE], req = {cost: 300, cards, pool: SAO_POOL, bag: true, scale: activeScale()};
  for (const [label, store, key] of [['带数量的表', tableStore, 'bag'], ['对象数组', rowsStore, 'items'], ['名字数组', namesStore, 'names']] as const) {
    const data: Obj = {fp: 1000, 别的变量: {原样: true}};
    const drawn = applyGachaDraw(data, req, store, charge, d => Number(d.fp));
    assert.deepEqual(drawn, {fp: 700, added: ['逐暗者', '回复水晶', '回复水晶', '角色·桐人', '命运·第七十四层']}, label);
    assert.deepEqual(store.list(data).map(e => [e.name, e.count]), [['逐暗者', 1], ['回复水晶', 2], ['角色·桐人', 1], ['命运·第七十四层', 1]], label);
    assert.deepEqual(data.别的变量, {原样: true}, '其余变量原样保留');
    const ledger = ledgerAfterDraw({}, cards, drawn.added, SAO_POOL);
    assert.deepEqual(listGachaBag(data, ledger, store, activeScale()).map(e => [e.name, e.quality, e.count]), [['角色·桐人', '命', 1], ['逐暗者', '仙', 1], ['命运·第七十四层', '极', 1], ['回复水晶', '良', 2]], label);
    const r = applyRecycle(data, [{name: '回复水晶', count: 1}, {name: '角色·桐人', count: 1}], ledger, store, credit);
    assert.deepEqual([r.fp, r.gained, r.removed, r.items], [700 + 20 + 6000, 6020, 2, [{name: '回复水晶', removed: 1}, {name: '角色·桐人', removed: 1}]], label);
    assert.deepEqual(store.list(data).map(e => [e.name, e.count]), [['逐暗者', 1], ['回复水晶', 1], ['命运·第七十四层', 1]], label);
    assert.ok(Array.isArray(data[key]) || typeof data[key] === 'object');
  }
  // 宿主条目的字段由语义层决定：这里的对象数组只留了名字与一段描述，品质、类型都并在描述里；名字数组什么都不留——回收照样认得（靠账本）。
  const rows: Obj = {fp: 0};
  applyGachaDraw(rows, {...req, cost: 0, cards: [SWORD]}, rowsStore, charge, () => 0);
  assert.deepEqual(rows.items, [{name: '逐暗者', 描述: '仙 武器：抽自动画《刀剑神域》的仙物品，原属桐人。'}]);
  // 以名字为键、没有数量字段的表：同名的另一件加上作品名区分，账本按实际用的名字记。
  const plain: Obj = {fp: 0, bag: {逐暗者: {说明: '玩家原来就有的同名物品'}}};
  const twice = applyGachaDraw(plain, {...req, cost: 0, cards: [SWORD, SWORD]}, plainTableStore, charge, () => 0);
  assert.deepEqual(twice.added, ['逐暗者（《刀剑神域》）', '逐暗者（《刀剑神域》）2']); assert.equal(rec(rec(plain.bag).逐暗者).说明, '玩家原来就有的同名物品', '不覆盖已有的东西');
  const ledger = ledgerAfterDraw({}, [SWORD, SWORD], twice.added, SAO_POOL);
  assert.deepEqual(listGachaBag(plain, ledger, plainTableStore, activeScale()).map(e => e.name), ['逐暗者（《刀剑神域》）', '逐暗者（《刀剑神域》）2'], '玩家原来那件不在账上，不能回收');
  // 入包的东西：名字、品质、类型、标签、效果、描述齐全，写不写得下由语义层决定。
  const item = gachaBagItem(KIRITO, SAO_POOL, activeScale());
  assert.deepEqual([item.name, item.count, item.quality, item.type, item.tags], ['角色·桐人', 1, '命', '角色书页', [BAG_TAG, '角色', '书页', '作品:刀剑神域']]);
  assert.deepEqual(item.effect, {身份: '被困在死亡游戏里的独行剑士', 定位: '主角', 实力: '完全等同原作：二刀流，全服反应最快', 持有: '以书页的形式被主角持有', 具现: '一旦被选择具现，便在完全保有自身自由意志的情况下自由行动，主角无法强制约束'});
  setQualityScale(undefined);
});

test('抽卡服务（通用版）：换大池、编纂、十连入包并记账、回收销账；细则默认关闭、不预设条目名；背包里还在的角色书页算抽到过', async () => {
  assert.deepEqual(DEFAULT_SPEC_ENTRIES, []); assert.deepEqual(defaultSpecSettings(), {enabled: false, entries: []});
  assert.deepEqual(normalizeSpecSettings({entries: ['物品规则']}), {enabled: false, entries: ['物品规则']}); assert.deepEqual(normalizeSpecSettings({enabled: true, entries: ['物品规则']}), {enabled: true, entries: ['物品规则']});
  const often = {...DEFAULT_RULES, rates: {1: .6, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: .4}};
  const f = fakePort({specs: async () => {throw Error('细则默认关闭，不该读世界书');}}, 1e6), g = createGacha(f.port, {rng: seededRng(61), rules: often});
  g.saveSettings({...g.settings(), characterPool: true});
  await g.cast('acg-fantasy');
  const w = g.spread()!.works[0]!, pool = await g.compile(w);
  assert.deepEqual(f.llmCalls.map(c => c.split(':')[0]), ['pool', 'pool', 'pool'], '规划与物品、命运、角色各一次；没有按细则写属性');
  assert.equal(pool.characters!.length, 20);
  const out = await g.draw(w.key, 10), names = out.cards.map(c => c.kind === 'character' ? '角色·' + c.name : c.kind === 'fate' ? '命运·' + c.name : c.name);
  assert.ok(out.record.bagged); assert.equal(f.fp, 1e6 - 1000 - 2000);
  const ledger = f.durable.bag;
  assert.deepEqual(Object.keys(ledger).sort(), [...new Set(names)].sort(), '入包的每样东西都记在账上'); assert.equal(Object.values(ledger).reduce((n, e) => n + e.count, 0), 10);
  assert.deepEqual(g.bag().map(e => e.count).reduce((a, b) => a + b, 0), 10); assert.ok(g.bag().every(e => e.work === pool.work.title && e.quality === qualityOf(e.star)));
  // 回收一件：背包、命运点数与账本一起变。
  const pick = g.bag().find(e => e.kind !== 'character')!, before = f.fp;
  const r = await g.recycle([{name: pick.name, count: 1}]);
  assert.deepEqual([r.gained, r.removed, r.fp], [pick.price, 1, before + pick.price]); assert.equal(f.fp, before + pick.price);
  assert.equal(f.durable.bag[pick.name]?.count ?? 0, pick.count - 1); assert.equal(Object.values(f.durable.bag).reduce((n, e) => n + e.count, 0), 9);
  await assert.rejects(g.recycle([{name: '不存在', count: 1}]), /不在命运抽卡的入包记录里/); assert.equal(f.fp, before + pick.price, '核对不过时什么也不写');
  // 聊天里的记录丢了，背包里还留着的这部作品的角色书页也算抽到过。
  const page = g.bag().find(e => e.kind === 'character');
  if (page) {
    const amnesia = createGacha({...f.port, readDurable: () => ({bag: f.durable.bag})}, {rng: seededRng(5), rules: often});
    amnesia.saveSettings({...amnesia.settings(), characterPool: true});
    assert.ok(!amnesia.uniquesLeft(pool).some(c => '角色·' + c.name === page.name)); assert.equal(amnesia.uniquesLeft(pool).length, 20 - g.bag().filter(e => e.kind === 'character').length);
  }
  // 大保底兑换来的东西也记账。
  const g2 = createGacha(f.port, {rng: seededRng(9), rules: {...often, spark: 10}}), mythic = pool.items.find(c => c.star === 6)!;
  const got = await g2.exchange(w.key, mythic.id);
  assert.equal(got.warning, undefined); assert.equal(f.durable.bag[mythic.name]!.star, 6); assert.ok(g2.bag().some(e => e.name === mythic.name));
});

test('读者端口（通用版）：扣点与入包在一次提交里完成并回传入包的名字；按账本列出与回收；聊天切换后旧操作不落盘；不再有上游的书海旅程限制', async () => {
  setQualityScale(undefined);
  const r = fakeReader({fp: 3000}), port = readerGachaPort(readerHost(r));
  assert.deepEqual(port.wallet(), {fp: 3000}); assert.equal(port.mode, 'host');
  const res = await port.commit!({cost: 2000, cards: [SWORD, POTION, POTION, KIRITO], pool: SAO_POOL, bag: true, scale: activeScale()});
  assert.deepEqual(res, {fp: 1000, added: ['逐暗者', '回复水晶', '回复水晶', '角色·桐人']}); assert.deepEqual(r.stats(), {runs: 1, transacts: 1});
  assert.deepEqual(Object.entries(rec(r.data.bag)).map(([k, v]) => [k, rec(v).count, rec(v).quality]), [['逐暗者', 1, '6星'], ['回复水晶', 2, '2星'], ['角色·桐人', 1, '唯一']]);
  await assert.rejects(port.commit!({cost: 5000, cards: [SWORD], pool: SAO_POOL, bag: true, scale: activeScale()}), /FP不足/); assert.equal(r.data.fp, 1000);
  const quiet = r.stats().transacts;
  assert.deepEqual(await port.commit!({cost: 0, cards: [SWORD], pool: SAO_POOL, bag: false, scale: activeScale()}), {fp: 1000}); assert.equal(r.stats().transacts, quiet, '不扣点也不入包时不提交');
  assert.deepEqual(await port.commitCast!({cost: 400, theme: '奇幻'}), {fp: 600});
  const ledger = ledgerAfterDraw({}, [SWORD, POTION, POTION, KIRITO], res.added!, SAO_POOL);
  assert.deepEqual(port.bag!(ledger, 1).map(e => [e.name, e.count, e.price]), [['角色·桐人', 1, 6000], ['逐暗者', 1, 6000], ['回复水晶', 2, 20]]); assert.deepEqual(port.bag!({}, 1), [], '账上没有的不列出');
  const back = await port.recycle!([{name: '回复水晶', count: 2}], ledger, 0.5);
  assert.deepEqual(back, {fp: 620, gained: 20, removed: 2, items: [{name: '回复水晶', removed: 2}]}); assert.equal(rec(r.data.bag).回复水晶, undefined);
  // 保底、账本与记录写进聊天变量。
  await port.writeDurable({version: 1, pity: {since6: 1, total: 1}, points: {}, uniques: {}, bag: ledger, history: [], updated: 1});
  assert.deepEqual(rec(r.ctx.chatMetadata.variables[DURABLE_KEY]).bag, ledger); assert.equal(r.ctx.saves, 1);
  // 聊天切换：旧端口的读写一律拒绝。
  r.switchChat();
  await assert.rejects(port.commit!({cost: 1, cards: [SWORD], pool: SAO_POOL, bag: true, scale: activeScale()}), /聊天已切换/);
  await assert.rejects(port.recycle!([{name: '逐暗者', count: 1}], ledger, 1), /聊天已切换/); assert.deepEqual(port.bag!(ledger, 1), []); assert.ok(port.wallet().blocked);
  assert.equal(createReaderGacha().version, '2.0.0');
});

/* ====================== 通用角色模板 ====================== */

test('通用角色模板：生成文件与 模板/ 里的两个文件同步；写清外貌、性格、语言风格、能力；用字数区间约束篇幅；没有特别能力时整节不写；不预设世界观、不带酒馆宏', async () => {
  const {renderTemplateModule} = await import('../sync-template.mjs' as string) as {renderTemplateModule(): Promise<string>};
  assert.equal((await readFile(new URL('../src/gacha/entry-template.generated.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'), await renderTemplateModule(), '改了 模板/ 之后要在 gacha/ 里运行 node sync-template.mjs');
  const t = GENERIC_ENTRY_TEMPLATE as {id: string; name: string; templateText: string; generationInstruction: string; entryNameRule: string; output: Obj};
  assert.deepEqual([t.id, t.name, t.output.targetWorldbook, t.output.strategyType], ['reader-default-generic-character', '通用角色条目', 'Reader生成条目', 'selective']);
  const text = t.templateText, at = (s: string) => text.indexOf('\n' + s);
  for (const section of ['基本信息:', '背景:', '外貌:', '性格:', '语言风格:', '能力:', '与主角:', '扮演要点:']) assert.ok(at(section) > 0, section);
  assert.ok(at('外貌:') < at('性格:') && at('性格:') < at('语言风格:') && at('语言风格:') < at('能力:'));
  for (const field of ['容貌:', '发与瞳:', '体态:', '衣着:', '核心:', '底线与矛盾:', '语气:', '称谓:', '口癖:', '台词示例:', '具体能力:', '弱点与限制:']) assert.ok(text.includes('  ' + field), field);
  assert.match(text, /填好之后全文 3000–4000 字；没有「能力」一节时 2800–3600 字/); assert.match(text, /把「能力」一节连同标题整节删去/);
  assert.match(t.generationInstruction, /全文 3000–4000 字，没有「能力」一节时 2800–3600 字/); assert.match(t.generationInstruction, /把「能力」一节连同标题整节删去/);
  // 要写内容的占位符都标了字数区间；各字段的区间加起来盖得住全文的区间（含能力 3000–4000，不含能力 2800–3600）。
  const sum = (part: string) => [...part.matchAll(/(\d+)–(\d+) 字\}/g)].reduce<[number, number, number]>((n, m) => [n[0] + Number(m[1]), n[1] + Number(m[2]), n[2] + 1], [0, 0, 0]);
  const all = sum(text), power = sum(text.slice(at('能力:'), at('与主角:'))), rest = [all[0] - power[0], all[1] - power[1]];
  assert.ok(all[2] >= 40, '每个字段都有字数区间'); assert.ok(power[2] >= 6);
  assert.ok(all[0] <= 3000 && all[1] >= 4000, `含能力：各字段合计 ${all[0]}–${all[1]} 字`); assert.ok(rest[0]! <= 2800 && rest[1]! >= 3600, `不含能力：各字段合计 ${rest[0]}–${rest[1]} 字`);
  assert.ok(!/<user>|\{\{|<char>|<bot>|\$\d|\$</i.test(text + t.generationInstruction + t.entryNameRule + JSON.stringify(t.output)), '模板里不能有酒馆宏与正则替换记号');
  assert.ok(!/命定|阿斯塔利亚|生命层级|魔法|修仙|斗气/.test(text), '不预设任何一张卡的世界观');
});

/* ====================== 角色条目生成 ====================== */

/** 假的酒馆助手世界书：按书名存条目，新条目给一个编号；记下新建、挂载与写入。 */
function fakeWorldbooks(start: {primary: string | null; additional: string[]} = {primary: '主世界书', additional: []}, initial: Record<string, Obj[]> = {主世界书: []}) {
  const books = new Map<string, Obj[]>(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)])), calls: string[] = [];
  let bound = structuredClone(start), uid = 100;
  const helper = {
    getCharWorldbookNames: () => structuredClone(bound),
    getWorldbookNames: () => [...books.keys()],
    getWorldbook: async (name: string) => {if (!books.has(name)) throw Error('没有世界书 ' + name); return structuredClone(books.get(name)!);},
    createWorldbook: async (name: string) => {calls.push('create ' + name); books.set(name, []);},
    createWorldbookEntries: async (name: string, entries: Obj[]) => {calls.push('add ' + name); const rows = entries.map(e => ({...structuredClone(e), uid: uid++})); books.get(name)!.push(...rows); return {worldbook: books.get(name), new_entries: rows};},
    updateWorldbookWith: async (name: string, updater: (entries: Obj[]) => Obj[]) => {calls.push('update ' + name); books.set(name, updater(structuredClone(books.get(name) ?? [])));},
    rebindCharWorldbooks: async (_c: 'current', next: {primary: string | null; additional: string[]}) => {calls.push('bind'); bound = structuredClone(next);},
  };
  return {helper: helper as unknown as WorldbookWriter, books, calls, get bound() {return bound;}};
}
/** 玩家在模板系统里自己做的模板（模板库里存的形状）。 */
const MINE = {id: 'mine', name: '我的模板', templateText: '姓名: ${姓名}\n口癖: ${口癖}', generationInstruction: '照我的格式写。', output: {targetWorldbook: '自定义人物志', strategyType: 'constant', positionType: 'at_depth', depth: 2, role: 'assistant'}};
const entryReply = (name: string) => `<reader_entry_name>${name}</reader_entry_name>\n<reader_content>\n基本信息:\n  姓名: ${name}\n性格:\n  核心: ${'沉着、重诺，对同伴温和，对敌人毫不留情。'.repeat(6)}\n</reader_content>\n<reader_primary_keywords>\n${name}\n${name}的书页\n</reader_primary_keywords>\n<reader_secondary_keywords></reader_secondary_keywords>`;
type WbRow = {name: string; enabled: boolean; content: string; probability: number; strategy: {type: string; keys: string[]; keys_secondary: {logic: string; keys: string[]}; scan_depth: unknown}; position: {type: string; order: number; role: string; depth: number}; recursion: Obj; effect: Obj; extra: Obj};

test('角色条目生成：默认关闭；默认用抽卡自带的通用角色模板，模板库里的模板也可以选；提示带着模板、角色资料与输出协议；解析容忍没加标签，回复被截断的不收', () => {
  assert.deepEqual(normalizeSettings({}).characterEntry, {enabled: false, templateId: '', references: []}); assert.deepEqual(defaultEntrySettings(), {enabled: false, templateId: '', references: []});
  assert.deepEqual(normalizeEntrySettings({enabled: true, templateId: ' mine ', references: ['世界规则', '', '世界规则', 7]}), {enabled: true, templateId: 'mine', references: ['世界规则', '7']});
  // 没有模板系统：只有自带的通用模板。
  const alone = readTemplateLibrary(undefined), generic = pickTemplate(alone, '')!;
  assert.deepEqual(alone.templates.map(t => [t.id, t.builtin]), [['reader-default-generic-character', true]]); assert.equal(alone.defaultId, 'reader-default-generic-character');
  assert.deepEqual([generic.name, generic.output.targetWorldbook, generic.output.strategyType, generic.output.keywordMode, generic.output.positionType, generic.output.order], ['通用角色条目', 'Reader生成条目', 'selective', 'smart', 'after_character_definition', 601]);
  assert.match(generic.output.keywordRule, /全名、姓或名单独的写法、昵称、绰号、头衔/);
  // 有模板库：里面的模板也可以选；默认仍是通用模板。模板库里有同一个 id（玩家改过）时用模板库里的。
  const lib = readTemplateLibrary({yuanTemplateId: 'mine', templates: [MINE, {id: 'bad', name: '', templateText: 'x'}]});
  assert.deepEqual(lib.templates.map(t => t.id), ['mine', 'reader-default-generic-character']); assert.equal(lib.defaultId, 'reader-default-generic-character');
  assert.equal(pickTemplate(lib, 'mine')!.name, '我的模板'); assert.equal(pickTemplate(lib, 'gone')!.name, '通用角色条目', '选过的模板被删掉后回到默认');
  const mine = pickTemplate(lib, 'mine')!;
  assert.deepEqual([mine.output.strategyType, mine.output.keywordMode, mine.output.positionType, mine.output.depth, mine.output.role], ['constant', 'none', 'at_depth', 2, 'assistant'], '蓝灯不取关键词');
  const edited = readTemplateLibrary({templates: [{id: 'reader-default-generic-character', name: '我改过的通用模板', templateText: '姓名: x', output: {strategyType: 'constant'}}]});
  assert.deepEqual(edited.templates.map(t => [t.name, t.output.targetWorldbook]), [['我改过的通用模板', 'Reader生成条目']], '没写目标世界书的模板写进默认的那一本');
  const p = entryPrompt(generic, KIRITO, SAO_POOL, '〔这位角色〕桐人\n资料库里的介绍：黑衣剑士。', [{name: '世界规则', content: '这个世界没有魔法。'}]);
  for (const part of ['【格式模板】\n# 格式：严格遵循下面的 YAML 结构', '\n外貌:', '\n语言风格:', '\n能力:', '全文 3000–4000 字', '【生成指令】\n依据模板中的字段', '【条目命名规则】', '姓名：桐人（主角）', '出处：动画《刀剑神域》（原题：ソードアート・オンライン）',
    '原作中的实力：二刀流，全服反应最快', '实力完全等同原作', '【参考资料】\n〔这位角色〕桐人', '【当前世界观参考】\n【世界规则】\n这个世界没有魔法。', '【智能关键词规则】\n主要关键词：', '必须同时输出关键词标签。', '<reader_content>']) assert.ok(p.user.includes(part), part);
  assert.match(p.system, /不编造原作没有的/);
  const blue = entryPrompt(mine, KIRITO, SAO_POOL, '资料');
  assert.ok(blue.user.includes('不要输出关键词标签。') && !blue.user.includes('【智能关键词规则】') && !blue.user.includes('【当前世界观参考】') && blue.user.includes('照我的格式写。'));
  const parsed = parseEntryReply('```\n' + entryReply('桐人') + '\n```', '桐人');
  assert.equal(parsed.entryName, '桐人'); assert.match(parsed.content, /^基本信息:\n  姓名: 桐人/); assert.ok(!parsed.content.includes('reader_')); assert.deepEqual(parsed.primary, ['桐人', '桐人的书页']);
  assert.equal(parseEntryReply('基本信息:\n  姓名: "桐谷和人"\n' + '性格: 沉着。'.repeat(30), '桐人').entryName, '桐谷和人'); assert.equal(parseEntryReply('性格: 沉着。'.repeat(30), '桐人').entryName, '桐人');
  assert.throws(() => parseEntryReply('<reader_content>基本信息:\n' + '性格: 沉着。'.repeat(30), '桐人'), /没有写完/); assert.throws(() => parseEntryReply('{}', '桐人'), /太短/);
  const marker = entryMarker(SAO_POOL, KIRITO), green = buildWorldbookEntry(generic, parsed, marker) as WbRow;
  assert.deepEqual([green.name, green.enabled, green.probability], ['桐人', true, 100]);
  assert.deepEqual(green.strategy, {type: 'selective', keys: ['桐人', '桐人的书页'], keys_secondary: {logic: 'and_any', keys: []}, scan_depth: 'same_as_global'});
  assert.deepEqual(green.position, {type: 'after_character_definition', order: 601, role: 'system', depth: 0});
  assert.deepEqual(green.extra, {[ENTRY_EXTRA_KEY]: {v: 1, key: 'bangumi:7#桐人', work: '刀剑神域', character: '桐人'}}, '条目上留着记号');
  const constant = buildWorldbookEntry(mine, parsed, marker) as WbRow;
  assert.deepEqual(constant.strategy.keys, []); assert.deepEqual(constant.position, {type: 'at_depth', order: 601, role: 'assistant', depth: 2});
  assert.deepEqual(normalizeEntryRecords({'角色·桐人': {book: 'Reader生成条目', name: '桐人', uid: 3, marker: 'bangumi:7#桐人', character: '桐人', work: '刀剑神域', workKey: 'bangumi:7', at: 5}, 坏的: {name: 'x'}}),
    {'角色·桐人': {book: 'Reader生成条目', name: '桐人', uid: 3, marker: 'bangumi:7#桐人', character: '桐人', work: '刀剑神域', workKey: 'bangumi:7', at: 5, held: true, enabled: true}});
});

test('角色条目生成：世界书读写——目标世界书不存在就新建并挂到角色卡上；同名的别的条目不覆盖；关闭只改开关不删条目；按记号认出写过的条目', async () => {
  const wb = fakeWorldbooks({primary: '主世界书', additional: ['别的书']}, {主世界书: [{uid: 1, name: '桐人', content: '玩家自己写的', enabled: true}], 别的书: []});
  const entry = {name: '桐人', enabled: true, content: '正文'.repeat(80), extra: {[ENTRY_EXTRA_KEY]: {v: 1, key: 'bangumi:7#桐人', work: '刀剑神域', character: '桐人'}}};
  const ref = await writeWorldbookEntry(wb.helper, 'Reader生成条目', entry);
  assert.deepEqual(ref, {book: 'Reader生成条目', name: '桐人', uid: 100});
  assert.deepEqual(wb.calls, ['create Reader生成条目', 'bind', 'add Reader生成条目']); assert.deepEqual(wb.bound, {primary: '主世界书', additional: ['别的书', 'Reader生成条目']}, '挂成附加世界书，原来的绑定不动');
  assert.deepEqual(await writeWorldbookEntry(wb.helper, '主世界书', entry), {book: '主世界书', name: '桐人（《刀剑神域》）', uid: 101});
  assert.equal(wb.calls.filter(c => c === 'bind' || c.startsWith('create')).length, 2); assert.equal(wb.books.get('主世界书')![0]!.content, '玩家自己写的');
  const lone = fakeWorldbooks({primary: null, additional: []}, {});
  assert.equal(await ensureWorldbook(lone.helper, ' 人物志 '), '人物志'); assert.deepEqual(lone.bound, {primary: '人物志', additional: []});
  await assert.rejects(ensureWorldbook(lone.helper, '  '), /没有设置目标世界书/);
  assert.equal(await setWorldbookEntryEnabled(wb.helper, ref, false), true);
  const rows = () => wb.books.get('Reader生成条目')!;
  assert.deepEqual([rows()[0]!.enabled, rows()[0]!.content, rows().length], [false, entry.content, 1], '只关不删');
  assert.deepEqual(await findMarkedEntry(wb.helper, 'Reader生成条目', 'bangumi:7#桐人'), {book: 'Reader生成条目', name: '桐人', uid: 100, enabled: false});
  assert.equal(await findMarkedEntry(wb.helper, 'Reader生成条目', 'bangumi:7#亚丝娜'), undefined); assert.equal(await findMarkedEntry(wb.helper, '不存在的书', 'bangumi:7#桐人'), undefined);
  assert.equal(await setWorldbookEntryEnabled(wb.helper, {book: '主世界书', name: '桐人（《刀剑神域》）', uid: 101}, false), true); assert.equal(wb.books.get('主世界书')![0]!.enabled, true, '玩家自己那条同名条目不动');
  rows()[0]!.name = '黑衣剑士';
  assert.equal(await setWorldbookEntryEnabled(wb.helper, ref, true), false, '改了名、又没给记号：不动'); assert.equal(await setWorldbookEntryEnabled(wb.helper, ref, true, 'bangumi:7#桐人'), true); assert.equal(rows()[0]!.enabled, true);
  const old = fakeWorldbooks(); delete (old.helper as unknown as Obj).createWorldbookEntries;
  assert.deepEqual(await writeWorldbookEntry(old.helper, '主世界书', entry), {book: '主世界书', name: '桐人'}, '只有 updateWorldbookWith 时也能写；取不回编号时只按名字认');
});

test('角色资料：资料库里这位角色的条目、维基里讲他的段落、他自己的维基条目与 Fandom 页面汇总成详细资料；对不上名字时把同作角色交给模型辨认；什么都查不到时不算有资料', async () => {
  assert.equal(sameCharacter(['桐人'], ['キリト', '桐人']), true); assert.equal(sameCharacter(['阿尔托莉雅'], ['阿尔托莉雅·潘德拉贡']), true); assert.equal(sameCharacter(['Kirito'], ['kirito ']), true);
  assert.equal(sameCharacter(['Rem'], ['Remilia']), false, '拉丁字母太短不按包含算'); assert.equal(sameCharacter(['桐人'], ['亚丝娜']), false); assert.equal(sameCharacter(['爱'], ['爱丽丝']), false);
  const WIKI = '《刀剑神域》是川原砾的轻小说。\n\n== 故事简介 ==\n一万名玩家被困在游戏里。桐人决定独自攻略。\n\n== 登场人物 ==\n=== 主要人物 ===\n桐人（キリト）\n本作主角，使用二刀流的独行玩家。\n亚丝娜（アスナ）\n女主角，血盟骑士团副团长。\n\n== 制作 ==\n桐人的配音是松冈祯丞。';
  const passages = characterPassages(WIKI, ['桐人', 'キリト'], '中文维基百科');
  assert.deepEqual(passages.map(s => s.heading), ['主要人物', '故事简介']); assert.match(passages[0]!.text, /二刀流/); assert.ok(!passages.some(s => s.text.includes('松冈祯丞')), '制作等章节不收');
  assert.deepEqual(characterPassages('== 人物 ==\n=== 桐人 ===\n黑衣剑士。\n=== 亚丝娜 ===\n闪光。', ['桐人'], 'w').map(s => [s.heading, s.text]), [['桐人', '黑衣剑士。']], '以他为标题的小节整节收下');
  const fandomText = (who: string) => `${who} is a character of Sword Art Online, a player trapped in the death game. `.repeat(3), log: string[] = [];
  const fetcher = fakeFetch([
    [/api\.bgm\.tv\/v0\/subjects\/7\/characters/, [{id: 11, name: 'キリト', relation: '主角', type: 1}, {id: 12, name: 'アスナ', relation: '主角', type: 1}]],
    [/api\.bgm\.tv\/v0\/subjects\/7$/, {summary: '少年被困在死亡游戏里。'}],
    [/api\.bgm\.tv\/v0\/characters\/11/, {name: 'キリト', summary: '黑衣剑士，独行玩家。', infobox: [{key: '简体中文名', value: '桐人'}, {key: '别名', value: [{v: '桐谷和人'}, {v: 'Kirito'}]}, {key: '性别', value: '男'}, {key: '引用来源', value: 'wiki'}]}],
    [/api\.bgm\.tv\/v0\/characters\/12/, {name: 'アスナ', summary: '血盟骑士团副团长。', infobox: [{key: '简体中文名', value: '亚丝娜'}]}],
    [/zh\.wikipedia\.org\/w\/api\.php\?action=query&list=search/, {query: {search: [{title: '桐人'}]}}],
    [/zh\.wikipedia\.org\/w\/api\.php\?action=query&prop=extracts/, (url: string) => decodeURIComponent(url).includes('titles=桐人')
      ? {query: {pages: {'2': {title: '桐人', extract: '桐人是《刀剑神域》的主角。\n== 能力 ==\n二刀流与极快的反应。\n== 评价 ==\n人气很高。'}}}} : {query: {pages: {'1': {title: '刀剑神域', extract: WIKI}}}}],
    [/swordartonline\.fandom\.com\/api\.php\?action=query/, (url: string) => ({query: {search: [{title: /srsearch=Kirito/.test(url) ? 'Kirito' : 'Sword Art Online'}]}})],
    [/swordartonline\.fandom\.com\/api\.php\?action=parse/, (url: string) => ({parse: {text: {'*': '<p>' + fandomText(/page=Kirito/.test(url) ? 'Kirito' : 'The series') + '</p>'}}})],
  ], log);
  const sao = work('bangumi:7', '刀剑神域', {english: 'Sword Art Online', wiki: {zh: '刀剑神域'}}), memo = new Map<string, unknown>(), steps: string[] = [];
  const cd = await buildCharacterDossier(sao, {name: '桐人', role: '主角'}, {net: createNet(fetcher, {useProxy: false}), memo}, s => steps.push(s)), p = cd.profile;
  assert.deepEqual(p.names, ['桐人', 'キリト', '桐谷和人', 'Kirito'], '书页上的中文名靠资料库里的别名对上'); assert.equal(p.description, '黑衣剑士，独行玩家。'); assert.deepEqual(p.facts, ['简体中文名：桐人', '别名：桐谷和人 / Kirito', '性别：男']);
  assert.deepEqual(p.sources, ['Bangumi', '中文维基百科', '中文维基百科「桐人」', 'Fandom']); assert.deepEqual(p.passages.map(s => s.heading), ['主要人物', '故事简介', '桐人', '能力', 'Kirito']);
  assert.equal(log.filter(u => /characters\/1[12]$/.test(u)).length, 3, '名单上的原名对得上：只多取这一位的详情');
  assert.equal(hasCharacterMaterial(cd), true); assert.ok(steps.includes('正在查找「桐人」的角色资料'));
  const text = characterDossierText(cd);
  for (const part of ['〔这位角色〕桐人（又作：キリト / 桐谷和人 / Kirito）【主角】', '· 性别：男', '资料库里的介绍：黑衣剑士，独行玩家。', '【主要人物·中文维基百科】桐人（キリト）', '【能力·中文维基百科「桐人」】二刀流与极快的反应。',
    '【Kirito·Fandom（swordartonline）】Kirito is a character', '〔作品资料〕\n作品：《刀剑神域》', '简介：少年被困在死亡游戏里。']) assert.ok(text.includes(part), part);
  assert.ok(text.indexOf('〔这位角色〕') < text.indexOf('〔作品资料〕')); assert.ok(characterDossierText(cd, 3000).length <= 3200, '有长度上限');
  const before = log.length, asuna = await buildCharacterDossier(sao, {name: '亚丝娜'}, {net: createNet(fetcher, {useProxy: false}), memo, fandom: false});
  assert.ok(!log.slice(before).some(u => /subjects\/7$/.test(u)), '同一部作品的资料不重查'); assert.equal(asuna.profile.description, '血盟骑士团副团长。'); assert.equal(asuna.profile.role, '主角');
  const ani = fakeFetch([
    [/graphql\.anilist\.co/, (_u: string, init?: RequestInit) => String(init?.body).includes('alternative')
      ? {data: {Media: {characters: {edges: [{role: 'MAIN', node: {name: {full: 'Kirito', native: 'キリト', alternative: ['Kazuto']}, description: 'The Black Swordsman.', gender: 'Male', age: '16'}}]}}}}
      : {data: {Media: {description: 'A death game.', characters: {edges: [{role: 'MAIN', node: {name: {full: 'Kirito', native: 'キリト'}, description: 'Hero.'}}]}}}}],
    [/wikipedia/, {query: {search: [], pages: {}}}],
  ]);
  const loose = await buildCharacterDossier(work('anilist:9', 'Sword Art Online'), {name: '桐人'}, {net: createNet(ani, {useProxy: false}), fandom: false});
  assert.equal(loose.profile.description, ''); assert.deepEqual(loose.profile.others.map(o => [o.names, o.role, o.facts]), [[['キリト', 'Kirito', 'Kazuto'], '主角', ['性别：Male', '年龄：16']]]);
  assert.match(characterDossierText(loose), /请自行辨认哪一条是他/);
  const none = await buildCharacterDossier(work('openlibrary:/works/OL1W', '无名之书', {media: 'book'}), {name: '某人'}, {net: createNet(fakeFetch([]), {useProxy: false}), fandom: false});
  assert.equal(hasCharacterMaterial(none), false); assert.match(characterDossierText(none), /没有查到专门讲这位角色的资料/);
});

test('角色条目生成（服务层）：开着角色池并抽到角色书页时在后台按通用模板写条目并启用；写不成不影响抽卡、可以重试；回收书页时关闭条目（不删）；同一张卡的别的聊天再抽到时复用；查不到资料就不写', async () => {
  const wb = fakeWorldbooks(), lib = () => readTemplateLibrary({templates: [MINE]}), BOOK = 'Reader生成条目';
  const charactersOf = (o: {cards: GachaCard[]}) => o.cards.filter(c => c.kind === 'character').map(c => c.name);
  /** 一个聊天：自己的命运点数、背包、保底与账本；世界书跟着角色卡、小池缓存跟着设备，可以与别的聊天共用。rate 是角色（第 7 档）的出货率。 */
  function chat(o: {device?: () => unknown; fetch?: FetchLike; books?: ReturnType<typeof fakeWorldbooks>; rate?: number} = {}) {
    const f = fakePort({...(o.device ? {readDevice: o.device} : {}), ...(o.fetch ? {fetch: o.fetch} : {})}, 1e8), prompts: string[] = [], rate = o.rate ?? .2;
    let broken = false;
    const think = f.port.llm!;
    f.port.llm = async (system, user, opt) => {
      if (opt.purpose !== 'entry') return think(system, user, opt);
      prompts.push(user);
      if (broken) throw Error('模型接口 HTTP 500');
      return entryReply(/姓名：([^（\n]+)/.exec(user)![1]!);
    };
    f.port.specs = async names => names.map(name => ({name, content: name + '的规则'}));
    f.port.entries = worldbookEntryPort((o.books ?? wb).helper, lib);
    const g = createGacha(f.port, {rng: seededRng(61), rules: {...DEFAULT_RULES, rates: {1: 1 - rate, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: rate}}}), events: {character: string; ok: boolean; text: string}[] = [];
    g.onEntry(e => events.push(e));
    const pull = async (key: string) => {for (let i = 0; i < 12; i++) {const out = await g.draw(key, 10); if (charactersOf(out).length) return out;} throw Error('没抽到角色');};
    return {f, g, prompts, events, pull, has: (name: string) => name in rec(f.data.bag), breakModel(v: boolean) {broken = v;}};
  }
  /** 条目状态按名字排好再比（通用版的背包按档位与名字排，不是入包的先后）。 */
  const states = (rows: {character: string; state: string}[]) => rows.map(s => `${s.character}:${s.state}`).sort();
  const on = (g: ReturnType<typeof chat>['g'], extra: Partial<GachaSettings> = {}) => g.saveSettings({...g.settings(), characterPool: true, characterEntry: {...g.settings().characterEntry, enabled: true}, ...extra});
  const a = chat(), g = a.g, book = () => wb.books.get(BOOK) ?? [];
  assert.equal(g.canWriteEntries(), true); assert.equal(g.entriesOn(), false, '默认关闭');
  assert.deepEqual(g.entryTemplates(), {defaultId: 'reader-default-generic-character', templates: [{id: 'mine', name: '我的模板', book: '自定义人物志'}, {id: 'reader-default-generic-character', name: '通用角色条目', book: BOOK}]});
  g.saveSettings({...g.settings(), characterPool: true});
  await g.cast('acg-fantasy');
  const w = g.spread()!.works[0]!, pool = await g.compile(w), title = pool.work.title;
  const first = await a.pull(w.key), early = charactersOf(first); await g.entryIdle();
  assert.equal(first.entries, undefined); assert.equal(a.prompts.length, 0); assert.equal(wb.calls.length, 0); assert.deepEqual(g.entryStatus(pool), [], '没打开这项功能：不问模型、不碰世界书');
  on(g);
  assert.deepEqual(states(g.entryStatus(pool)), early.map(n => n + ':none').sort(), '之前抽到的书页还没有条目');
  const second = await a.pull(w.key), fresh = charactersOf(second);
  assert.deepEqual(second.entries, fresh); assert.ok(g.entryStatus(pool).some(s => s.state === 'queued' || s.state === 'running'), '抽卡不等条目写完');
  await g.entryIdle();
  assert.deepEqual(book().map(e => [e.name, e.enabled]), fresh.map(n => [n, true]), '每位角色一个条目，已启用');
  assert.deepEqual(wb.calls.filter(c => !c.startsWith('add')), ['create ' + BOOK, 'bind']); assert.deepEqual(wb.bound, {primary: '主世界书', additional: [BOOK]});
  const row = book()[0] as unknown as WbRow, key = '角色·' + fresh[0]!;
  assert.deepEqual(row.strategy.keys, [fresh[0], fresh[0] + '的书页']); assert.deepEqual(row.extra[ENTRY_EXTRA_KEY], {v: 1, key: w.key + '#' + fresh[0], work: title, character: fresh[0]});
  assert.equal(a.prompts.length, fresh.length);
  for (const part of ['【格式模板】\n# 格式：严格遵循下面的 YAML 结构', '姓名：' + fresh[0], `〔这位角色〕${fresh[0]}`, '〔作品资料〕', '简介：简介']) assert.ok(a.prompts[0]!.includes(part), part);
  assert.ok(!a.prompts[0]!.includes('【当前世界观参考】'), '通用版不预设世界观参考条目');
  assert.deepEqual(a.f.durable.entries[key], {book: BOOK, name: fresh[0]!, uid: 100, marker: w.key + '#' + fresh[0], character: fresh[0]!, work: title, workKey: w.key, at: a.f.durable.entries[key]!.at, held: true, enabled: true});
  assert.equal(a.f.durable.bag[key]!.kind, 'character', '入包账本与条目记录各记各的'); assert.match(a.events[0]!.text, /的角色条目已写进世界书《Reader生成条目》并启用。$/);
  assert.deepEqual(states(g.entryStatus(pool)), [...early.map(n => n + ':none'), ...fresh.map(n => n + ':on')].sort());
  // 填了世界观参考条目名：写条目时一并读世界书。
  on(g, {characterEntry: {enabled: true, templateId: '', references: ['世界规则']}});
  assert.deepEqual(g.generateEntry(w.key, '角色·' + early[0]!), {ok: true}); assert.deepEqual(g.generateEntry(w.key, '角色·' + early[0]!), {ok: false, reason: '这位角色的条目正在写'});
  await g.entryIdle();
  assert.equal(book().at(-1)!.name, early[0]); assert.ok(a.prompts.at(-1)!.includes('【当前世界观参考】\n【世界规则】\n世界规则的规则'));
  // 模型出错：抽卡照常完成、书页照样进背包，只是没有条目；修好后可以重试。
  a.breakModel(true);
  const third = await a.pull(w.key), failed = charactersOf(third); await g.entryIdle();
  assert.equal(third.cards.length, 10); assert.ok(failed.every(n => a.has('角色·' + n))); assert.ok(!book().some(e => failed.includes(String(e.name))));
  assert.match(a.events.at(-1)!.text, /的角色条目没能生成：模型接口 HTTP 500$/);
  const bad = g.entryStatus(pool).find(s => s.character === failed[0])!;
  assert.deepEqual([bad.state, bad.note], ['failed', '模型接口 HTTP 500']);
  a.breakModel(false); assert.equal(g.generateEntry(w.key, bad.key).ok, true); await g.entryIdle();
  assert.equal(g.entryStatus(pool).find(s => s.character === failed[0])!.state, 'on');
  // 回收：条目关闭，但还在世界书里；别的条目不动；账本销账。
  const size = book().length, done = await g.recycle([{name: key, count: 1}]);
  assert.equal(done.closed, 1); assert.equal(done.warning, undefined); assert.equal(book().length, size, '只关不删'); assert.deepEqual(book().map(e => e.enabled), book().map(e => e.name !== fresh[0]));
  assert.deepEqual([a.f.durable.entries[key]!.held, a.f.durable.entries[key]!.enabled, a.f.durable.bag[key]], [false, false, undefined]);
  const quiet = wb.calls.length, item = g.bag().find(e => e.kind === 'item')!;
  assert.equal((await g.recycle([{name: item.name, count: item.count}])).closed, undefined); assert.equal(wb.calls.length, quiet, '回收没有条目的东西不碰世界书');
  // 条目还没写完书页就被回收了：写完也不落进世界书。
  const late = await a.pull(w.key), victim = charactersOf(late).at(-1)!;
  await g.recycle([{name: '角色·' + victim, count: 1}]); await g.entryIdle();
  assert.ok(!book().some(e => e.name === victim)); assert.match(a.events.find(e => e.character === victim)!.text, /书页已经回收，条目没有写入/);
  // 同一张角色卡的另一个聊天：世界书里已经有这位角色的条目，再抽到时不问模型，关着的重新启用。
  const existing = new Set(book().map(e => String(e.name))), b = chat({device: () => a.f.device, rate: .5}), drawn: string[] = [];
  on(b.g);
  for (let i = 0; i < 20 && !b.has(key); i++) drawn.push(...charactersOf(await b.g.draw(w.key, 10)));
  await b.g.entryIdle();
  assert.ok(b.has(key)); assert.equal(new Set(book().map(e => e.name)).size, book().length, '没有重复的条目');
  assert.equal(b.prompts.length, drawn.filter(n => !existing.has(n)).length, '已经有条目的角色不再问模型');
  assert.equal(book().find(e => e.name === fresh[0])!.enabled, true); assert.match(b.events.find(e => e.character === fresh[0])!.text, /已重新启用。$/);
  // 选了模板库里的模板：照它的输出设置写（另一本世界书、蓝灯）；抽到的东西不进背包时不写条目。
  const other = fakeWorldbooks(), d = chat({device: () => a.f.device, books: other, rate: .5});
  on(d.g, {autoBag: false, characterEntry: {enabled: true, templateId: 'mine', references: []}});
  assert.equal((await d.pull(w.key)).entries, undefined); await d.g.entryIdle(); assert.equal(d.prompts.length, 0);
  on(d.g, {autoBag: true, characterEntry: {enabled: true, templateId: 'mine', references: []}});
  const custom = charactersOf(await d.pull(w.key)); await d.g.entryIdle();
  const mineRow = other.books.get('自定义人物志')![0] as unknown as WbRow;
  assert.equal(other.books.get('自定义人物志')!.length, custom.length); assert.deepEqual([mineRow.strategy.type, mineRow.strategy.keys, mineRow.position.type, mineRow.position.depth], ['constant', [], 'at_depth', 2]);
  assert.ok(d.prompts[0]!.includes('照我的格式写。'));
  // 资料库里什么都查不到：不问模型，也不写条目；抽卡照常。
  const empty = fakeWorldbooks(), c = chat({device: () => a.f.device, fetch: async () => new Response('{}', {status: 404}), books: empty, rate: .5});
  on(c.g);
  const lost = await c.pull(w.key); await c.g.entryIdle();
  assert.equal(lost.cards.length, 10); assert.equal(c.prompts.length, 0); assert.equal(empty.calls.length, 0); assert.match(c.events[0]!.text, /资料库里没有查到这部作品与这位角色的资料/);
});

test('读者端口：角色条目生成——没有模板系统也有自带的通用模板，模板系统模板库里的模板一并可选；条目经酒馆助手写进世界书；聊天切换后旧的生成不落盘', async () => {
  const r = fakeReader(), wb = fakeWorldbooks();
  assert.equal(readerGachaPort(readerHost(r)).entries, undefined, '酒馆助手不能写世界书时没有这一项');
  const port = readerGachaPort(readerHost(r, {helper: wb.helper, templates: {loadLibrary: () => ({yuanTemplateId: 'mine', templates: [MINE]})}}));
  assert.deepEqual(port.entries!.templates().templates.map(t => t.id), ['mine', 'reader-default-generic-character']); assert.equal(port.entries!.templates().defaultId, 'reader-default-generic-character');
  const root = globalThis as {ReaderTemplateSystem?: unknown};
  root.ReaderTemplateSystem = {loadLibrary: () => ({templates: [MINE]})};
  try {assert.deepEqual(readerTemplateLibrary({}).templates.map(t => t.id), ['mine', 'reader-default-generic-character']);} finally {delete root.ReaderTemplateSystem;}
  const storage = memoryStorage(); storage.setItem(TEMPLATE_LIBRARY_KEY, JSON.stringify({templates: [MINE]}));
  assert.deepEqual(readerTemplateLibrary({storage}).templates.map(t => t.name), ['我的模板', '通用角色条目']); assert.deepEqual(readerTemplateLibrary({}).templates.map(t => t.name), ['通用角色条目'], '没有模板系统：只有自带的通用模板');
  const ref = await port.entries!.write('Reader生成条目', {name: '桐人', enabled: true, content: '正文'});
  assert.deepEqual(ref, {book: 'Reader生成条目', name: '桐人', uid: 100}); assert.equal(await port.entries!.setEnabled(ref, false), true); assert.equal(wb.books.get('Reader生成条目')![0]!.enabled, false);
  r.switchChat();
  await assert.rejects(port.entries!.write('Reader生成条目', {name: '亚丝娜', content: '正文'}), /聊天已切换/); await assert.rejects(port.entries!.setEnabled(ref, true), /聊天已切换/);
  assert.equal(wb.books.get('Reader生成条目')!.length, 1);
});
