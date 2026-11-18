// 单一扩展的回归：生成模块、真实提示词宿主、版本检查与旧组件退役。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { EXT_MODULES, CORE_MODULES, AGENT_MODULES, ASSETS_MODULE, PROMPTS_MODULE, generatedModules, extBundle, releaseManifest, textHash } from '../build.mjs';
import { renderEjs } from '../build/worldbook.mjs';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const generated = generatedModules('4.1.0-alpha.1');
function modules(files = []) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  for (const file of files) vm.runInContext(generated.code[file] || read(file), ctx, { filename: file });
  return { ctx, m: ctx.__ReaderIIModules };
}

test('扩展包按依赖顺序包含全部模块和两个生成模块，发布清单只有扩展包', () => {
  assert.deepEqual(EXT_MODULES, [...CORE_MODULES, ...AGENT_MODULES]);
  assert.equal(new Set(EXT_MODULES).size, EXT_MODULES.length);
  for (const name of ['src/reader-native-host.js', 'src/reader-shell.js', 'src/reader-prompt.js', 'src/reader-core.js', 'src/reader-memory.js', 'src/agent/agent.js', 'src/agent/updates.js', 'src/agent/ui-theme.js', 'src/agent/boot.js', ASSETS_MODULE, PROMPTS_MODULE]) assert.ok(EXT_MODULES.includes(name), name);
  const code = extBundle('4.1.0-alpha.1');
  let last = -1;
  for (const file of EXT_MODULES) {
    const marker = `/* ==== Reader-II 模块：${file} ==== */`;
    const at = code.indexOf(marker);
    assert.ok(at > last, file);
    assert.equal(code.indexOf(marker, at + marker.length), -1, '模块不能重复：' + file);
    last = at;
  }
  const { m } = modules([ASSETS_MODULE, PROMPTS_MODULE]);
  const assets = JSON.parse(gunzipSync(Buffer.from(m.READER_ASSETS_GZIP, 'base64')));
  assert.deepEqual(assets, generated.assets);
  assert.equal(assets.version, '4.1.0-alpha.1');
  assert.ok(assets.controller && assets.letterScript && assets.body);
  assert.deepEqual(Object.keys(m.READER_PROMPT_TEMPLATES).sort(), ['core', 'list', 'rules']);
  const manifest = releaseManifest({ version: assets.version, outputs: [['dist/reader-ii.ext.js', code]] });
  assert.equal(manifest.format, 2);
  assert.deepEqual(Object.keys(manifest.files), ['dist/reader-ii.ext.js']);
  assert.deepEqual(manifest.files['dist/reader-ii.ext.js'], { sha256: textHash(code), bytes: Buffer.byteLength(code) });
});

function promptHost({ local = {}, stat = {}, formatter = false, kit = {}, resolve = () => null } = {}) {
  const { m } = modules([PROMPTS_MODULE, 'src/reader-prompt.js']);
  const calls = [], hooks = [], errors = [];
  const ctx = {
    chatMetadata: { variables: structuredClone(local) }, extensionSettings: { regex: [] },
    chat: [{ is_user: true, mes: '夜梦，继续。' }, { is_user: false, mes: '欢迎回到旧书店。' }],
    saveMetadataDebounced() {}, saveSettingsDebounced() {},
    setExtensionPrompt: (...args) => calls.push(args),
  };
  if (formatter) ctx.MessageFormatter = { stage: { BEFORE_REGEX: 1 }, addHook: (fn) => hooks.push(fn) };
  const host = { addEventListener() {}, removeEventListener() {} };
  const api = { kit: { chatKey: () => '', ...kit }, isEnabled: () => true, hostMvu: () => true, adoptLegacyCard: async () => calls.push(['adopt']) };
  const runtime = m.createPromptRuntime(api, {
    host, context: () => ctx, getVariables: (opts) => opts.type === 'message' ? { stat_data: structuredClone(stat) } : {},
    resolveFunction: resolve, console: { info() {}, warn: (...args) => errors.push(args), error: (...args) => errors.push(args) },
  });
  return { m, ctx, host, api, runtime, calls, hooks, errors };
}

// 与 worldbook.test.mjs 的 host() 同一语义，独立执行 EJS 解释器作参照。
function referenceHost(local, stat) {
  const chat = structuredClone(local), cache = { ...structuredClone(local), stat_data: structuredClone(stat) };
  const get = (obj, key) => String(key).split('.').reduce((v, k) => v == null ? undefined : v[k], obj);
  return {
    getvar(key, opts = {}) { const v = get(opts.scope === 'local' ? chat : cache, key); return opts.clone ? structuredClone(v === undefined ? opts.defaults : v) : v === undefined ? opts.defaults : v; },
    getLocalVar(key, opts = {}) { const v = get(chat, key); return v === undefined ? opts.defaults : v; },
    setLocalVar(key, value) { for (const obj of [chat, cache]) { const keys = key.split('.'); let p = obj; for (const k of keys.slice(0, -1)) p = p[k] ||= {}; p[keys.at(-1)] = structuredClone(value); } return value; },
    getChatMessage: (_index, role) => role === 'assistant' ? '欢迎回到旧书店。' : '夜梦，继续。',
    matchChatMessages(patterns, opts = {}) { const text = opts.role === 'assistant' ? '欢迎回到旧书店。' : '夜梦，继续。'; return (Array.isArray(patterns) ? patterns : [patterns]).some((p) => p instanceof RegExp ? p.test(text) : text.includes(String(p))); },
  };
}

for (const persona of ['reader', 'kuromaku']) test(`三份编译模板经真实宿主渲染等同 renderEjs：${persona}`, async () => {
  const local = { dream_persona: persona, dream_seed: 2, dream_visual_theme: 'ink', dream_user_address: '作家', dream_letter_limit: 280 };
  const stat = { READER: { 地点: '旧书店', 进度: 3, 命运点数: 120, 关系列表: {}, 任务列表: {}, 主角: { 技能: { 故事的主人: {} }, 状态效果: {} } } };
  const h = promptHost({ local, stat });
  try {
    const actual = await h.runtime.inject(), reference = referenceHost(local, stat);
    for (const name of ['core', 'rules', 'list']) {
      const expected = String(await renderEjs(generated.prompts.templates[name], reference)).replace(/\n{3,}/g, '\n\n').trim();
      assert.ok(expected.length > 0, name);
      assert.equal(actual[name], expected, name);
      assert.doesNotMatch(actual[name], /<%|%>/);
    }
    assert.deepEqual(h.calls.map((args) => [args[0], args[2], args[3]]), [['reader_ii_core', 2, 0], ['reader_ii_rules', 1, 4], ['reader_ii_list', 1, 1]]);
    assert.deepEqual(h.errors, []);
  } finally { h.runtime.dispose(); }
});

test('版本比较处理预发布、数字段与 build metadata，拒绝坏版本', () => {
  const { m } = modules(['src/agent/updates.js']);
  const cmp = m.compareReaderVersions;
  const versions = ['4.0.0-alpha.1', '4.0.0-alpha.2', '4.0.0-alpha.10', '4.0.0-beta.1', '4.0.0', '4.0.1', '4.1.0'];
  for (let i = 1; i < versions.length; i++) { assert.equal(cmp(versions[i - 1], versions[i]), -1); assert.equal(cmp(versions[i], versions[i - 1]), 1); }
  assert.equal(cmp('v4.1.0+abc', '4.1.0+def'), 0);
  assert.throws(() => cmp('bad', '4.1.0'), /版本号格式不对/);
});

test('checkRemote 假 fetch：顺序回退、三种版本结果、全部失败与设置持久化', async () => {
  const { m } = modules(['src/agent/updates.js']);
  m.BUILD_VERSION = '4.1.0-alpha.1'; m.isObject = (x) => x && typeof x === 'object';
  const ctx = { extensionSettings: {}, saveSettingsDebounced() {} }, seen = [];
  let response = '{"version":"4.1.0"}';
  const updater = m.createUpdater({ host: { fetch: async (url, opts) => { seen.push([url, opts.cache]); if (url.includes('bad.test')) throw new Error('offline'); return { ok: true, text: async () => response }; } } }, { context: () => ctx, localRead: () => ({}), localWrite() {} });
  updater.saveSettings({ remotes: ['https://bad.test', 'https://ok.test/'] });
  for (const [version, status] of [['4.1.0', 'newer'], ['4.1.0-alpha.1', 'same'], ['4.0.0', 'older']]) {
    response = JSON.stringify({ version });
    const result = await updater.checkRemote();
    assert.equal(result.ok, true); assert.equal(result.status, status); assert.equal(result.latest, version); assert.equal(result.current, '4.1.0-alpha.1');
    assert.equal(result.source, 'https://ok.test/'); assert.equal(result.errors.length, 1);
    assert.equal(updater.getSettings().lastCheck.status, status);
  }
  assert.deepEqual(seen.slice(0, 2), [['https://bad.test/manifest.json', 'no-store'], ['https://ok.test/manifest.json', 'no-store']]);
  for (const body of ['not json', '{}', '{"version":"broken"}']) {
    response = body; const result = await updater.checkRemote();
    assert.equal(result.ok, false); assert.equal(result.status, 'failed'); assert.equal(result.errors.length, 2);
    assert.equal(updater.getSettings().lastCheck.status, 'older', '失败不能冒充成功');
  }
  assert.throws(() => updater.saveSettings({ remotes: ['file:///tmp/x'] }), /http\(s\)/);
});

test('retireLegacy 停用旧世界书和嵌套脚本，清理未修改正则，保留用户数据；重复执行无副作用', async () => {
  let entries, trees;
  const h = promptHost({ formatter: true, kit: {
    worldbookScopes: () => ({ global: ['Reader-II旧版'], character_primary: 'Reader-II旧版', chat: null, character_additional: ['设定集'] }),
    readWorldbook: async () => structuredClone(entries),
    updateWorldbook: async (_name, update) => { entries = update(structuredClone(entries)); },
  }, resolve: (name) => ({ getScriptTrees: ({ type }) => trees[type], updateScriptTreesWith: async (update, { type }) => { trees[type] = update(trees[type]); } })[name] });
  const legacy = h.m.READER_LEGACY_COMPONENTS;
  entries = [...legacy.entries.map((name) => ({ name, enabled: true, content: '保留正文' })), { name: '用户条目', enabled: true }];
  trees = { character: [{ type: 'folder', scripts: [{ id: legacy.scriptId, enabled: true, data: { user: 1 } }, { id: 'user', enabled: true }] }], global: [{ id: legacy.loaderId, enabled: true }], preset: [] };
  h.ctx.extensionSettings.regex = [{ id: legacy.regexIds[0], findRegex: '/READER_(?:FP|TASK|ACTION)_EVENT/g' }, { id: legacy.regexIds[1], findRegex: '<dream>' }, { id: legacy.regexIds[2], findRegex: '用户改过' }, { id: 'user', findRegex: '<dream>' }];
  try {
    const result = await h.runtime.retireLegacy();
    assert.equal(result.needReload, true);
    assert.ok(entries.slice(0, 3).every((e) => e.enabled === false && e.content === '保留正文'));
    assert.equal(entries[3].enabled, true);
    assert.equal(trees.character[0].scripts[0].enabled, false); assert.deepEqual(trees.character[0].scripts[0].data, { user: 1 });
    assert.equal(trees.character[0].scripts[1].enabled, true); assert.equal(trees.global[0].enabled, false);
    assert.deepEqual(h.ctx.extensionSettings.regex.map((x) => x.id), [legacy.regexIds[2], 'user']);
    assert.ok(h.calls.some((x) => x[0] === 'adopt'));
    assert.deepEqual(plain(await h.runtime.retireLegacy()), { done: [], needReload: false });
    assert.deepEqual(h.errors, []);
  } finally { h.runtime.dispose(); }
});

test('没有 MessageFormatter 时安装两条内置正则且不重复，能隐藏事件并生成轻信插槽', () => {
  const h = promptHost();
  try {
    assert.equal(h.runtime.usesFormatter, false);
    const rules = h.ctx.extensionSettings.regex;
    assert.equal(rules.length, 2);
    const apply = (rule, text) => { const [, source, flags] = /^\/(.*)\/([a-z]*)$/.exec(rule.findRegex); return text.replace(new RegExp(source, flags), rule.replaceString); };
    assert.equal(apply(rules[0], '正文<READER_FP_EVENT>{"x":1}</READER_FP_EVENT>'), '正文');
    assert.match(apply(rules[1], '<dream>「欢迎回来」</dream>'), /data-reader-dream-slot="1".*欢迎回来/);
    assert.deepEqual(plain(rules.map((x) => x.placement)), [[2], [2]]);
    // 同一宿主重新装配时也不能重复安装。
    const again = h.m.createPromptRuntime(h.api, { host: h.host, context: () => h.ctx, resolveFunction: () => null });
    assert.equal(rules.length, 2); again.dispose();
  } finally { h.runtime.dispose(); }
});
