/** 命运抽卡：抽到的卡放进主角背包的样子（Reader-II 通用版）。
 *  这里只描述“放进去的是什么”——名字、品质、类型、标签、效果、描述；真正写到哪里由读者的语义路由决定：
 *  背包槽绑定了宿主变量就按宿主条目的字段写（宿主没有的字段并进描述），否则写进 Reader 后备背包。
 *  物品按模型给的类型放入：按世界书细则写过属性的带着格式化的标签与效果；技能书页只写大概，在正文里研读时由正文模型生成完整的技能；
 *  命运是“命运”类型的一页，在正文里翻开就会降临；角色是一页角色书页，具现后完全保有自由意志，主角无法强制约束。
 *  回收不靠宿主条目上的标签（宿主未必有这个字段）：抽卡把入包的东西记在聊天变量的账本里，回收时与背包里实际还在的东西对账。 */
import {type CardKind,type GachaCard,type SmallPool} from './pool';
import {MEDIA_LABEL} from './sources';
import {isStar,type QualityScale,type Star} from './rarity';
import {isSkillPage} from './spec';

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
/** 背包物品上的来源标签。 */
export const BAG_TAG = '命运抽卡';

/** 放进背包的一件东西（与宿主无关的语义形状）。 */
export type BagItem = {name: string; count: number; quality: string; type: string; tags: string[]; effect: Record<string, string>; description: string};
/** 读者语义层给出的背包读写（见 src/controller/reader-transactions-generic.js）。 */
export type BagStore = {
  list(data: Obj): {name: string; count: number}[];
  add(data: Obj, item: BagItem, options?: {distinct?: string}): {name: string};
  remove(data: Obj, name: string, count: number): {removed: number};
};

/** 角色书页上写给正文模型看的规矩（与设置里角色池的说明一致）。 */
export const CHARACTER_PAGE = {持有: '以书页的形式被主角持有', 具现: '一旦被选择具现，便在完全保有自身自由意志的情况下自由行动，主角无法强制约束'} as const;
export function gachaBagItem(card: GachaCard, pool: SmallPool, scale: QualityScale): BagItem {
  const work = pool.work, from = `${MEDIA_LABEL[work.media]}《${work.title}》`, quality = scale.label(card.star);
  if (card.kind === 'character') return {
    name: `角色·${card.name}`, count: 1, quality, type: '角色书页', tags: [BAG_TAG, '角色', '书页', `作品:${work.title}`],
    effect: {身份: card.description, ...(card.role ? {定位: card.role} : {}), 实力: card.power ? `完全等同原作：${card.power}` : '完全等同原作', ...CHARACTER_PAGE},
    description: `抽自${from}的${quality}角色书页${card.role ? `（${card.role}）` : ''}。`,
  };
  if (card.kind === 'fate') return {
    name: `命运·${card.name}`, count: 1, quality, type: '命运', tags: [BAG_TAG, '命运', `作品:${work.title}`],
    effect: {命运: card.description, ...(card.hook ? {契机: card.hook} : {}), 使用: '在故事中翻开这一页，这段命运便会降临。'},
    description: `抽自${from}${card.chapter ? '·' + card.chapter : ''}的${quality}命运。`,
  };
  const origin = `抽自${from}的${quality}${isSkillPage(card) ? '技能书页' : '物品'}${card.owner ? `，原属${card.owner}` : ''}。`, owner = card.owner ? [`原主:${card.owner}`] : [];
  if (isSkillPage(card)) return {
    name: card.name, count: 1, quality, type: '技能书页', tags: [BAG_TAG, '物品', '书页', `作品:${work.title}`, ...owner],
    effect: {技能: card.description, ...(card.use ? {用途: card.use} : {}), 使用: '翻开研读即可习得这项技能，具体的消耗与效果在习得时按世界规则生成；书页可以转赠他人。'},
    description: origin,
  };
  // 按世界书细则写过属性：带着格式化的标签与效果，抽到就能直接用；来历写进描述。
  if (card.spec) return {
    name: card.name, count: 1, quality, type: card.spec.type || card.type || '道具', tags: [BAG_TAG, '物品', `作品:${work.title}`, ...owner, ...card.spec.tags],
    effect: {...card.spec.effects},
    description: `${card.description}${card.use ? (/[。！？]$/.test(card.use) ? card.use : card.use + '。') : ''}${origin}`,
  };
  return {
    name: card.name, count: 1, quality, type: card.type || '道具', tags: [BAG_TAG, '物品', `作品:${work.title}`, ...owner],
    effect: {来历: card.description, ...(card.use ? {用途: card.use} : {})},
    description: origin,
  };
}

/* ---------- 入包账本 ---------- */
/** 账本上的一条：背包里叫这个名字的东西是命运抽卡抽来的、是第几档、还剩几件记在账上。 */
export type BagLedgerEntry = {star: Star; kind: CardKind; work: string; type: string; count: number};
export type BagLedger = Record<string, BagLedgerEntry>;
export const LEDGER_LIMIT = 800;
const kindOf = (v: unknown): CardKind => v === 'fate' ? 'fate' : v === 'character' ? 'character' : 'item';
export function normalizeLedger(raw: unknown): BagLedger {
  const out: BagLedger = {};
  for (const [name, value] of Object.entries(rec(raw)).slice(-LEDGER_LIMIT)) {
    const v = rec(value), star = Math.round(Number(v.star)), count = Math.floor(Number(v.count));
    if (!name || name.length > 160 || !isStar(star) || !(count >= 1)) continue;
    out[name] = {star, kind: kindOf(v.kind), work: String(v.work ?? '').slice(0, 60), type: String(v.type ?? '').slice(0, 40), count: Math.min(9999, count)};
  }
  return out;
}
/** 入包之后记账：added 是每张卡实际放进背包时用的名字。 */
export function ledgerAfterDraw(ledger: BagLedger, cards: readonly GachaCard[], added: readonly string[], pool: SmallPool): BagLedger {
  const next: BagLedger = {...ledger};
  cards.forEach((card, i) => {
    const name = added[i]; if (!name) return;
    const old = next[name];
    next[name] = {star: card.star, kind: card.kind, work: pool.work.title, type: card.kind === 'fate' ? '命运' : card.kind === 'character' ? '角色书页' : card.spec?.type || card.type || '道具', count: Math.min(9999, (old && old.star === card.star ? old.count : 0) + 1)};
  });
  return normalizeLedger(next);
}
export function ledgerAfterRecycle(ledger: BagLedger, removed: readonly {name: string; removed: number}[]): BagLedger {
  const next: BagLedger = {...ledger};
  for (const r of removed) {
    const old = next[r.name]; if (!old) continue;
    const left = old.count - Math.max(0, Math.floor(r.removed));
    if (left >= 1) next[r.name] = {...old, count: left}; else delete next[r.name];
  }
  return next;
}

export type DrawWrite = {cost: number; cards: GachaCard[]; pool: SmallPool; bag: boolean; scale: QualityScale};
/** 在一份（可改写的）楼层变量上扣命运点数并把抽到的东西放进主角背包。
 *  charge 负责校验与扣点（读者用 ReaderTransactions.charge）；花费为 0 时不碰命运点数。返回每张卡实际入包的名字。 */
export function applyGachaDraw(data: Obj, req: DrawWrite, store: BagStore, charge: (data: Obj, cost: number) => number, readFp: (data: Obj) => number | null): {fp: number | null; added: string[]} {
  const fp = req.cost > 0 ? charge(data, req.cost) : readFp(data);
  const added: string[] = [];
  if (req.bag && req.cards.length) {
    for (const card of req.cards) added.push(store.add(data, gachaBagItem(card, req.pool, req.scale), {distinct: `《${req.pool.work.title}》`}).name);
  }
  return {fp, added};
}

/* ---------- 回收 ---------- */
/** 各档每件的回收基础价（第 7 档与第 6 档同价）。按现行出货率与保底，抽一次平均只能回收抽卡价的六成左右，抽了再回收换不回本。 */
export const RECYCLE_BASE: Readonly<Record<Star, number>> = {1: 8, 2: 20, 3: 100, 4: 200, 5: 2000, 6: 6000, 7: 6000};
/** 价格倍率作用于抽卡价与回收价：宿主货币的量级与命运点数差得多时，在设置里调它。 */
export function scaledPrice(base: number, scale: number): number {
  if (!(base > 0)) return 0;
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.max(1, Math.round(base * factor));
}
export const recyclePrice = (star: Star, scale = 1): number => scaledPrice(RECYCLE_BASE[star] ?? 0, scale);
export const RECYCLE_ORDER: readonly Star[] = [7, 6, 5, 4, 3, 2, 1];
export type BagEntry = {name: string; quality: string; kind: 'item' | 'fate' | 'character'; type: string; count: number; price: number; work: string; star: Star};
export type RecyclePick = {name: string; count: number};
/** 账本与背包对账：只列出账上有、背包里也确实还在的东西；件数取两边较小的那个。 */
export function listGachaBag(data: Obj, ledger: BagLedger, store: BagStore, scale: QualityScale, priceScale = 1): BagEntry[] {
  const have = new Map<string, number>();
  for (const item of store.list(data)) have.set(item.name, (have.get(item.name) ?? 0) + Math.max(0, Math.floor(item.count)));
  const out: BagEntry[] = [];
  for (const [name, entry] of Object.entries(ledger)) {
    const count = Math.min(entry.count, have.get(name) ?? 0), price = recyclePrice(entry.star, priceScale);
    if (count <= 0 || !price) continue;
    out.push({name, quality: scale.label(entry.star), kind: entry.kind, type: entry.type, count, price, work: entry.work, star: entry.star});
  }
  return out.sort((a, b) => b.star - a.star || a.name.localeCompare(b.name, 'zh'));
}
/** 在一份（可改写的）楼层变量上回收：逐件核对账上有、背包里还在，再移出并加回命运点数。 */
export function applyRecycle(data: Obj, picks: RecyclePick[], ledger: BagLedger, store: BagStore, credit: (data: Obj, amount: number) => number, priceScale = 1): {fp: number; gained: number; removed: number; items: {name: string; removed: number}[]} {
  if (!picks.length) throw Error('没有选择要回收的东西');
  let gained = 0, removed = 0;
  const items: {name: string; removed: number}[] = [];
  for (const pick of picks) {
    const entry = ledger[pick.name], want = Math.min(entry?.count ?? 0, Math.floor(Number(pick.count) || 0));
    if (!entry || want <= 0) throw Error(`「${pick.name}」不在命运抽卡的入包记录里，不能回收`);
    const done = store.remove(data, pick.name, want).removed;
    if (done <= 0) throw Error(`背包里的「${pick.name}」已经变了，请重新打开回收`);
    gained += done * recyclePrice(entry.star, priceScale); removed += done; items.push({name: pick.name, removed: done});
  }
  return {fp: credit(data, gained), gained, removed, items};
}
