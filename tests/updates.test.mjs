/*
 * 检查更新与卡内组件代装（交接 0.6 甲组第 9 项）的 Node 测试。
 *   node --test tests/updates.test.mjs
 * 假远端：内存里的「URL → 文本」，内容取自本次构建（与 node build.mjs 写进 dist/ 的相同）；另造一个更早的版本 4.0.0-alpha.0 当「旧版」。
 * 假酒馆：原生世界书（loadWorldInfo / saveWorldInfo）、原生正则（extension_settings.regex、角色卡 regex_scripts）；假酒馆助手：脚本库。
 * 覆盖：成功更新、没有更新、下载失败、校验失败（含换镜像）、玩家改过的条目 / 脚本 / 正则不覆盖、写到一半失败的逐项退回、
 *       检查之后宿主又变了、空宿主代装、远端版本比对、发布清单（哈希、指纹、历史）、没有 Web Crypto 时的纯 JS SHA-256。
 * 没覆盖：真实酒馆与酒馆助手的行为（脚本库写入后是否立即重载、原生接口的真实形状）、真远端（第 10 项推送之后）、面板 DOM（在 ① 的冒烟里）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { buildCard, extBundle, versionModule, componentFingerprints, releaseManifest, loadCanon, textHash, MANIFEST_FILE, BOOK_NAME } from '../build.mjs';

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
/* 被测代码跑在另一个 vm 上下文里，原型不同：比较前先转成普通值。 */
const same = (actual, expected) => assert.deepStrictEqual(clone(actual), clone(expected));
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const canon = loadCanon();
const card = buildCard();
const VERSION = card.version;
const OLD = '4.0.0-alpha.0';
const EXT = extBundle(VERSION);
const BASE = 'https://ext.test/reader-II/';
const REMOTE = 'https://remote.test/reader-II/';
const CORE = canon.entryName(card.worldbook.json.entries[2]);
const INITVAR = canon.entryName(card.worldbook.json.entries[0]);
const RENDER = card.regex.find((item) => item.data.replaceString.includes('data-reader-dream-slot')).data;

const pick = (c) => ({ script: c.script, loader: c.loader, regex: c.regex.map(({ target, data }) => ({ target, data })), worldbook: { json: c.worldbook.json } });
const outputsOf = (c) => [
  ['dist/reader-ii.script.json', json(c.script)],
  ['dist/reader-ii.loader.json', json(c.loader)],
  ...c.regex.map((item) => [`dist/${item.target}`, json(item.data)]),
  ['dist/reader-ii.worldbook.json', json(c.worldbook.json)],
];
function makeRelease(c, version, previous = null) {
  const outputs = outputsOf(c);
  return { card: c, outputs, manifest: releaseManifest({ version, outputs, components: componentFingerprints(c, canon), previous, canon }) };
}

/* 旧版：脚本与加载器的版本标记不同、渲染正则换了一处、初始化与核心条目不同、多一个新版已不用的条目；另两条正则与两个条目和新版相同。 */
function oldCard() {
  const old = clone(pick(card));
  for (const key of ['script', 'loader']) {
    old[key].content = old[key].content.replace(`/*! Reader-II ${VERSION} · `, `/*! Reader-II ${OLD} · `) + '\n/* old */\n';
    old[key].name = old[key].name.replace(VERSION, OLD);
  }
  const render = old.regex.find((item) => item.data.id === RENDER.id);
  render.data.replaceString = render.data.replaceString.replace('data-preserve-html="1"', 'data-preserve-html="0"');
  const entries = old.worldbook.json.entries;
  entries[0].content += '\n  旧字段: 1';
  entries[2].content = entries[2].content.replace(`core v${VERSION}`, `core v${OLD}`);
  entries[4] = { ...clone(entries[3]), uid: 4, comment: 'Reader-II旧条目', content: '只有旧版才有的条目' };
  return old;
}
const OLD_RELEASE = makeRelease(oldCard(), OLD);
const NEW_RELEASE = makeRelease(pick(card), VERSION, OLD_RELEASE.manifest);

function serve(release = NEW_RELEASE, base = BASE) {
  const files = new Map([[base + 'manifest.json', json({ version: release.manifest.version })], [base + MANIFEST_FILE, json(release.manifest)]]);
  for (const [file, text] of release.outputs) files.set(base + file, text);
  return files;
}

/* 宿主里装着旧版：玩家关掉了主脚本、藏了一个按钮、存了脚本变量；关掉了核心条目；渲染正则关掉并改了作用范围；还有自己的条目。 */
function oldHost({ editCore = false, editScript = false, editRender = false, regexScope = 'global' } = {}) {
  const old = OLD_RELEASE.card;
  const script = {
    type: 'script', enabled: false, name: old.script.name, id: old.script.id, content: old.script.content + (editScript ? '\n// 我改的' : ''), info: old.script.info,
    button: { enabled: true, buttons: [{ name: 'Reader Core', visible: false }, { name: '夜梦助手', visible: true }] }, data: { 我的变量: 1 },
  };
  const loader = { type: 'script', enabled: true, name: old.loader.name, id: old.loader.id, content: old.loader.content, info: old.loader.info, button: clone(old.loader.button), data: {} };
  const entries = clone(old.worldbook.json.entries);
  if (editCore) entries[2].content = '玩家改过的核心';
  else entries[2].disable = true;
  entries[7] = { ...clone(old.worldbook.json.entries[2]), uid: 7, comment: canon.backupName('3.9.9', CORE), disable: true };
  entries[9] = { ...clone(old.worldbook.json.entries[3]), uid: 9, comment: '我的设定', content: 'mine', constant: false, key: ['我的'] };
  const regex = old.regex.map(({ data }) => clone(data));
  const render = regex.find((item) => item.id === RENDER.id);
  render.disabled = true;
  render.placement = [1, 2];
  if (editRender) render.replaceString += '<!-- 我改的 -->';
  return {
    scripts: { character: [script], global: [loader], preset: [] },
    books: { [BOOK_NAME]: { entries } },
    regex: regexScope === 'global' ? regex : [],
    charRegex: regexScope === 'character' ? regex : [],
  };
}

function makeHost({ files = serve(), scripts = {}, books = {}, regex = [], charRegex = [], helper = true, crypto = true, encoder = true } = {}) {
  const state = {
    files, books: clone(books), scripts: { character: [], global: [], preset: [], ...clone(scripts) },
    writes: { book: 0, script: 0, ext: 0 }, bound: [], fetched: [], failScript: false, failExt: false,
  };
  const characters = [{ name: '测试卡', avatar: 'test.png', data: { extensions: { regex_scripts: clone(charRegex) } } }];
  const extensionSettings = { regex: clone(regex) };
  const ctx = {
    characters, characterId: 0, extensionSettings, chat: [], chatMetadata: {}, name1: '我', name2: '测试卡',
    saveSettingsDebounced: () => {}, getRequestHeaders: () => ({}),
    loadWorldInfo: async (name) => (state.books[name] ? clone(state.books[name]) : { entries: {} }),
    saveWorldInfo: async (name, data) => { state.writes.book += 1; state.books[name] = clone(data); },
    updateWorldInfoList: async () => {},
    writeExtensionField: async (id, key, value) => { state.writes.ext += 1; if (state.failExt) throw new Error('角色卡保存失败'); characters[id].data.extensions[key] = clone(value); },
    eventSource: { on() {}, once() {}, removeListener() {}, emit: async () => {} }, eventTypes: {},
  };
  const tavernHelper = {
    getWorldbookNames: () => Object.keys(state.books),
    getGlobalWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: state.bound[0] || null, additional: state.bound.slice(1) }),
    getChatWorldbookName: () => null,
    rebindCharWorldbooks: async (_which, value) => { state.bound = [value.primary, ...value.additional].filter(Boolean); },
    getScriptTrees: ({ type }) => clone(state.scripts[type]),
    updateScriptTreesWith: async (updater, { type }) => {
      state.writes.script += 1;
      if (state.failScript) throw new Error('脚本库保存失败');
      state.scripts[type] = clone(updater(clone(state.scripts[type])));
      return clone(state.scripts[type]);
    },
  };
  const storage = new Map();
  const host = {
    SillyTavern: { getContext: () => ctx }, ...(helper ? { TavernHelper: tavernHelper } : {}),
    localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    console: { log() {}, info() {}, warn() {}, error() {} },
    document: { querySelectorAll: () => [], getElementById: () => null },
    navigator: { userAgent: 'node-test' },
    fetch: async (url) => {
      state.fetched.push(url);
      const body = state.files.get(url);
      return body === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => body };
    },
    setTimeout, clearTimeout, AbortController,
    ...(encoder ? { TextEncoder } : {}), ...(crypto ? { crypto: globalThis.crypto } : {}),
    __READER_II_NO_AUTOBOOT__: true, __ReaderIIBase: BASE,
  };
  host.window = host;
  host.parent = host;
  vm.createContext(host);
  vm.runInContext(EXT, host, { filename: 'reader-ii.ext.js' });
  const modules = host.__ReaderIIModules;
  const env = modules.createEnv(host);
  const updates = modules.createUpdater(env, modules.createHostKit(env));
  updates.saveSettings({ remotes: [REMOTE] });
  return { host, ctx, state, characters, extensionSettings, updates, modules };
}

const statusOf = (plan) => Object.fromEntries(plan.items.map((item) => [item.key, item.status]));
const entriesOf = (state) => Object.values(state.books[BOOK_NAME].entries);
const named = (state, name) => entriesOf(state).filter((entry) => entry.comment === name);

test('检查更新：版本号规则与远端 manifest.json 比对（没有更新 / 有新版 / 换源 / 失败）', async () => {
  const { updates, state } = makeHost();
  const compare = updates.compareVersions;
  assert.equal(compare('4.0.0-alpha.1', '4.0.0-alpha.2'), -1);
  assert.equal(compare('4.0.0-alpha.2', '4.0.0-beta.1'), -1);
  assert.equal(compare('4.0.0-beta.1', '4.0.0'), -1);
  assert.equal(compare('4.0.0', '4.0.1'), -1);
  assert.equal(compare('4.0.0-alpha.10', '4.0.0-alpha.9'), 1);
  assert.equal(compare('v4.1.0', '4.1.0'), 0);
  assert.throws(() => compare('4.0', '4.0.0'), /版本号/);
  assert.equal(updates.version, VERSION);
  assert.equal(updates.carrier(), 'extension');

  state.files.set(REMOTE + 'manifest.json', json({ version: VERSION }));
  let result = await updates.checkRemote();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'same');
  state.files.set(REMOTE + 'manifest.json', json({ version: '4.0.1' }));
  result = await updates.checkRemote();
  assert.equal(result.status, 'newer');
  assert.equal(result.latest, '4.0.1');
  assert.equal(updates.getSettings().lastCheck.latest, '4.0.1');

  updates.saveSettings({ remotes: ['https://down.test/', REMOTE] });
  result = await updates.checkRemote();
  assert.equal(result.source, REMOTE);
  assert.equal(result.errors.length, 1);
  updates.saveSettings({ remotes: 'https://down.test/ https://down2.test' });
  result = await updates.checkRemote();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.errors.length, 2);
  same(updates.getSettings().remotes, ['https://down.test/', 'https://down2.test/']);

  updates.saveSettings({ remotes: [] });
  same(updates.getSettings().remotes, updates.defaults);
  assert.throws(() => updates.saveSettings({ remotes: 'ftp://example.com/' }), /http/);
});

test('代装：空宿主一次装好主脚本、三条正则与世界书；再检查就是「没有更新」', async () => {
  const { updates, state, extensionSettings } = makeHost();
  const plan = await updates.inspect({ scope: 'character' });
  const status = statusOf(plan);
  assert.equal(status.script, 'missing');
  assert.equal(status.loader, 'missing');
  assert.equal(status.worldbook, 'missing');
  assert.equal(plan.actions, 5, '主脚本 + 三条正则 + 世界书；加载器可选，不代装');
  same(state.writes, { book: 0, script: 0, ext: 0 });

  const report = await updates.apply(plan);
  assert.equal(report.ok, true);
  assert.equal(report.done.length, 5);
  const script = state.scripts.character.find((item) => item.id === card.script.id);
  assert.equal(script.content, card.script.content);
  assert.equal(script.enabled, true);
  same(script.button, card.script.button);
  assert.equal(state.scripts.character.some((item) => item.id === card.loader.id), false);
  same(state.books[BOOK_NAME].entries, card.worldbook.json.entries);
  same(state.bound, [BOOK_NAME]);
  same(extensionSettings.regex, card.regex.map((item) => item.data));
  assert.equal(updates.getSettings().installed.version, VERSION);

  const again = await updates.inspect();
  assert.equal(again.actions, 0);
  assert.ok(again.items.every((item) => item.status === 'current' || item.key === 'loader'), JSON.stringify(statusOf(again)));
  const writes = clone(state.writes);
  const none = await updates.apply(again);
  assert.equal(none.done.length, 0);
  same(state.writes, writes);
  await assert.rejects(updates.apply(again), /用过/);
});

test('成功更新：旧版 → 新版；旧条目留作停用的备份，玩家的开关、按钮、脚本变量、正则设置都保留', async () => {
  const { updates, state, extensionSettings } = makeHost(oldHost());
  const plan = await updates.inspect();
  const status = statusOf(plan);
  assert.equal(status.script, 'outdated');
  assert.equal(status.loader, 'outdated');
  assert.equal(status.worldbook, 'outdated');
  assert.equal(status['regex:' + RENDER.id], 'outdated');
  assert.equal(plan.items.filter((item) => item.key.startsWith('regex:') && item.status === 'current').length, 2);
  assert.equal(plan.items.find((item) => item.key === 'script').from, OLD);
  assert.equal(plan.actions, 4);

  const report = await updates.apply(plan);
  assert.equal(report.done.length, 4);
  const script = state.scripts.character[0];
  assert.equal(script.content, card.script.content);
  assert.equal(script.name, card.script.name);
  assert.equal(script.enabled, false);
  same(script.data, { 我的变量: 1 });
  same(script.button.buttons, [{ name: 'Reader Core', visible: false }, { name: '夜梦助手', visible: true }]);
  assert.equal(state.scripts.global[0].content, card.loader.content);

  const render = extensionSettings.regex.find((item) => item.id === RENDER.id);
  assert.equal(render.replaceString, RENDER.replaceString);
  assert.equal(render.disabled, true);
  same(render.placement, [1, 2]);

  const core = named(state, CORE);
  assert.equal(core.length, 1);
  assert.equal(core[0].content, card.worldbook.json.entries[2].content);
  assert.equal(core[0].disable, true, '玩家关掉的条目，新版也关着');
  const backup = named(state, canon.backupName(OLD, CORE));
  assert.equal(backup.length, 1);
  assert.equal(backup[0].disable, true);
  assert.equal(backup[0].content, OLD_RELEASE.card.worldbook.json.entries[2].content);
  assert.equal(named(state, canon.backupName('3.9.9', CORE)).length, 0, '同一条目只留最新一份备份');
  assert.equal(entriesOf(state).filter((entry) => entry.comment.includes('[initvar]')).length, 1, '备份名里不能再有 [initvar]');
  assert.equal(named(state, INITVAR)[0].content, card.worldbook.json.entries[0].content);
  assert.equal(named(state, 'Reader-II旧条目').length, 0);
  assert.equal(named(state, canon.backupName(OLD, 'Reader-II旧条目'))[0].disable, true);
  assert.equal(named(state, '我的设定')[0].content, 'mine');
  assert.equal(named(state, canon.entryName(card.worldbook.json.entries[1]))[0].uid, 1, '没变的条目原地不动');
  assert.equal((await updates.inspect()).actions, 0);
});

test('玩家改过的不覆盖：条目另存停用的新版供对照，脚本与正则保持原样', async () => {
  const { updates, state, extensionSettings } = makeHost(oldHost({ editCore: true, editScript: true, editRender: true }));
  const plan = await updates.inspect();
  const status = statusOf(plan);
  assert.equal(status.script, 'modified');
  assert.equal(status['regex:' + RENDER.id], 'modified');
  assert.equal(status.worldbook, 'outdated');
  assert.ok(plan.kept.includes('主脚本') && plan.kept.includes(`世界书条目「${CORE}」`), JSON.stringify(plan.kept));

  const report = await updates.apply(plan);
  assert.ok(report.kept.includes('主脚本'));
  assert.ok(state.scripts.character[0].content.endsWith('// 我改的'));
  assert.ok(extensionSettings.regex.find((item) => item.id === RENDER.id).replaceString.endsWith('<!-- 我改的 -->'));
  const core = named(state, CORE);
  assert.equal(core.length, 1);
  assert.equal(core[0].content, '玩家改过的核心');
  assert.notEqual(core[0].disable, true);
  const side = named(state, canon.sideName(VERSION, CORE));
  assert.equal(side.length, 1);
  assert.equal(side[0].disable, true);
  assert.equal(side[0].content, card.worldbook.json.entries[2].content);
  assert.equal(named(state, INITVAR)[0].content, card.worldbook.json.entries[0].content, '没改过的照常更新');

  const again = await updates.inspect();
  assert.equal(again.actions, 0, '对照条目已经在了，不再重复加');
  assert.equal(statusOf(again).worldbook, 'modified');
});

test('下载失败：宿主一处都不动', async () => {
  const files = serve();
  files.delete(BASE + 'dist/reader-ii.worldbook.json');
  const setup = oldHost();
  const { updates, state, extensionSettings } = makeHost({ ...setup, files });
  await assert.rejects(updates.inspect(), (error) => error.code === 'download' && /下载失败/.test(error.message) && /宿主没有任何改动/.test(error.message));
  same(state.writes, { book: 0, script: 0, ext: 0 });
  same(state.books, setup.books);
  same(state.scripts, setup.scripts);
  same(extensionSettings.regex, setup.regex);
});

test('校验失败：宿主一处都不动；换一个同版本的镜像就能继续', async () => {
  const files = serve();
  const file = BASE + 'dist/reader-ii.script.json';
  files.set(file, files.get(file).replace('Reader Core', 'Reader Cora'));
  const setup = oldHost();
  const { updates, state } = makeHost({ ...setup, files });
  await assert.rejects(updates.inspect(), (error) => error.code === 'verify' && /校验失败/.test(error.message));
  same(state.writes, { book: 0, script: 0, ext: 0 });
  same(state.books, setup.books);

  for (const [url, text] of serve(OLD_RELEASE, REMOTE)) files.set(url, text);
  await assert.rejects(updates.inspect(), (error) => /版本是 4\.0\.0-alpha\.0/.test(error.message), '版本不同的镜像不用');
  for (const [url, text] of serve(NEW_RELEASE, REMOTE)) files.set(url, text);
  const plan = await updates.inspect();
  assert.equal(plan.source, REMOTE);
  assert.equal(plan.actions, 4);
});

test('写到一半失败：已写的逐项退回，宿主恢复原样', async () => {
  const setup = oldHost({ regexScope: 'character' });
  const { updates, state, characters } = makeHost(setup);
  const plan = await updates.inspect();
  assert.equal(plan.actions, 4);
  state.failExt = true;
  await assert.rejects(updates.apply(plan), (error) => /都已退回/.test(error.message) && error.report.rolledBack.length === 3 && error.report.stuck.length === 0);
  same(state.books, setup.books);
  same(state.scripts, setup.scripts);
  same(characters[0].data.extensions.regex_scripts, setup.charRegex);
  assert.equal(updates.getSettings().installed, null);
});

test('检查之后宿主又变了：一处都不写', async () => {
  const { updates, state } = makeHost(oldHost());
  const plan = await updates.inspect();
  state.books[BOOK_NAME].entries[2].content += '（刚改的）';
  await assert.rejects(updates.apply(plan), (error) => error.code === 'changed' && /没有写入任何东西/.test(error.message));
  same(state.writes, { book: 0, script: 0, ext: 0 });
});

test('没有酒馆助手：脚本类显示「需要酒馆助手」，正则与世界书照常', async () => {
  const { updates, state } = makeHost({ helper: false });
  const plan = await updates.inspect();
  const status = statusOf(plan);
  assert.equal(status.script, 'unavailable');
  assert.equal(status.worldbook, 'missing');
  assert.equal(plan.actions, 4);
  const report = await updates.apply(plan);
  assert.ok(report.notes.some((note) => /手动挂上/.test(note)), '没有酒馆助手挂不上世界书，提示手动挂');
  same(state.books[BOOK_NAME].entries, card.worldbook.json.entries);
});

test('发布清单：文件哈希、组件指纹、历史版本；dist/ 里的清单与文件一致', () => {
  for (const [file, text] of NEW_RELEASE.outputs) assert.equal(NEW_RELEASE.manifest.files[file].sha256, sha(text), file);
  same(Object.keys(NEW_RELEASE.manifest.history), [OLD]);
  same(NEW_RELEASE.manifest.history[OLD], canon.compactComponents(OLD_RELEASE.manifest.components));
  const rebuilt = releaseManifest({ version: VERSION, outputs: NEW_RELEASE.outputs, components: NEW_RELEASE.manifest.components, previous: NEW_RELEASE.manifest, canon });
  same(rebuilt.history, NEW_RELEASE.manifest.history);
  const next = releaseManifest({ version: '4.0.1', outputs: NEW_RELEASE.outputs, components: NEW_RELEASE.manifest.components, previous: NEW_RELEASE.manifest, canon });
  same(Object.keys(next.history).sort(), [OLD, VERSION].sort());
  assert.equal(next.history[VERSION].script, NEW_RELEASE.manifest.components.script.fingerprint);
  assert.equal(textHash('a\r\nb\r\n'), textHash('a\nb\n'));
  assert.throws(() => versionModule('4.0'), /语义化版本/);
  assert.ok(EXT.includes(`BUILD_VERSION = ${JSON.stringify(VERSION)}`));
  assert.ok(card.script.content.includes(`modules.BUILD_VERSION = ${JSON.stringify(VERSION)};`));

  const dist = new URL('../dist/reader-ii.manifest.json', import.meta.url);
  if (!existsSync(dist)) return;
  const manifest = JSON.parse(readFileSync(dist, 'utf8'));
  assert.equal(manifest.version, VERSION);
  for (const [file, meta] of Object.entries(manifest.files)) assert.equal(textHash(readFileSync(new URL('../' + file, import.meta.url), 'utf8')), meta.sha256, `${file} 与 dist 清单不符（重新跑 node build.mjs）`);
});

test('SHA-256：没有 Web Crypto、没有 TextEncoder 时用纯 JS，结果与 Node 相同；整套检查也能跑', async () => {
  const { modules, updates } = makeHost({ crypto: false, encoder: false });
  const samples = ['', 'abc', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), 'd'.repeat(119), '夜梦·読者 ✉ 🌙', 'x'.repeat(200000)];
  for (const text of samples) assert.equal(await modules.updateSha256(text), sha(text), `长度 ${text.length}`);
  assert.equal(await modules.updateSha256('a\r\nb'), sha('a\nb'));
  const plan = await updates.inspect();
  assert.equal(plan.actions, 5);
});
