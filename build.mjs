#!/usr/bin/env node
/*
 * Reader-II 构建。只用 Node 标准库。
 *
 *   node build.mjs            构建 ① 扩展包与 ② 卡内组件，写进 dist/
 *   node build.mjs --check    只做检查，不写文件
 *
 * ① dist/reader-ii.ext.js：夜梦助手（Agent 内核）+ 记忆 + 模型网关 + 宿主工具箱，由 index.js 在酒馆就绪后加载。
 * ② 卡内组件（交接 7.F），都是导入用的 JSON：
 *    dist/reader-ii.script.json   主脚本（酒馆助手脚本）：语义层 + 常驻壳 + 读者控制器资源包（gzip + base64）
 *    dist/reader-ii.loader.json   夜梦助手加载器（酒馆助手脚本，可选）：没装扩展、也不带卡时，从 CDN 加载 ①
 *    dist/reader-ii.regex.*.json  正则 ×3：正则/ 里的原样（交接 4.1「保持不变」），只做校验
 *    dist/reader-ii.worldbook.json 世界书（交接 7.E，build/worldbook.mjs）：初始化、变量更新规则、通用读者核心、变量列表
 * 发布清单（交接 0.6 甲组第 9 项）：dist/reader-ii.manifest.json 记下上面每个文件的 SHA-256 与卡内组件的指纹，
 *    扩展的「检查卡内组件」据此先校验再代装；历史版本的指纹随清单累积（版本号变了才把上一版记进 history）。
 * 版本号只有一个来源：manifest.json 的 version（语义化版本）。构建把它写进 ① 与 ② 的 modules.BUILD_VERSION。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';
import { transformUpstream } from './build/controller.mjs';
import { assertNoMacro } from './build/lib.mjs';
import { buildWorldbook } from './build/worldbook.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

/* ① 顺序即依赖顺序：后面的模块在加载期会用到前面的。 */
export const EXT_MODULES = [
  'src/reader-env.js',
  'src/reader-host-kit.js',
  'src/reader-llm-gateway.js',
  'src/reader-memory.js',
  'src/agent/store.js',
  'src/agent/protocol.js',
  'src/agent/permissions.js',
  'src/agent/vfs.js',
  'src/agent/providers.js',
  'src/agent/tools.js',
  'src/agent/connectors.js',
  'src/agent/skills.js',
  'src/agent/legacy-tools.js',
  'src/agent/personas.js',
  'src/agent/agent.js',
  'src/agent/updates.js',
  'src/agent/ui.js',
  'src/agent/boot.js'
];

export function bundle(files) {
  return files.map((file) => {
    const code = read(file);
    try { new vm.Script(code, { filename: file }); }
    catch (error) { throw new Error(`${file} 语法错误：${error.message}`); }
    return `/* ---- ${file} ---- */\n${code.trim()}\n`;
  }).join('\n');
}

function syntax(code, filename) {
  try { new vm.Script(code, { filename }); }
  catch (error) { throw new Error(`${filename} 语法错误：${error.message}`); }
  return code;
}

const banner = (version, what) => `/*! Reader-II ${version} · ${what} · https://github.com/Adirm007/reader-II · 许可见 LICENSE */\n`;

/* 版本号写进模块表：① 的 ReaderII.version、检查更新，② 的 ReaderCore.version 都取它。 */
export function versionModule(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`manifest.json 的版本号不是语义化版本：${version}`);
  return `(function (root) { (root.__ReaderIIModules = root.__ReaderIIModules || {}).BUILD_VERSION = ${JSON.stringify(version)}; })(typeof globalThis !== 'undefined' ? globalThis : window);\n`;
}

export function extBundle(version) {
  return syntax(banner(version, '夜梦助手扩展包') + versionModule(version) + bundle(EXT_MODULES), 'dist/reader-ii.ext.js');
}

/* ---------- ② 卡内组件（交接 7.F） ---------- */

/* 主脚本的模块，顺序即依赖顺序（交接 4.3，与 tests/core.test.mjs 的 CORE_SOURCES 一致）。reader-assets 由构建生成。
 * 记忆、Agent 及其面板在 ①，不进 ②（交接 0.4）。 */
export const ASSETS_MODULE = 'reader-assets';
export const CARD_MODULES = [
  'src/reader-env.js', 'src/reader-mvu-guard.js', 'src/reader-runtime-store.js', 'src/reader-economy.js', 'src/reader-host-adapter.js',
  'src/reader-semantic-codec.js', 'src/reader-semantic-router.js', 'src/reader-character-scan.js',
  'src/reader-llm-gateway.js', 'src/reader-adaptation-llm.js', 'src/reader-event-parser.js', 'src/reader-ui-bridge.js',
  'src/reader-host-kit.js', 'src/reader-auto-adapt.js', 'src/reader-lwb-host.js',
  ASSETS_MODULE, 'src/reader-shell.js', 'src/reader-core.js',
];
/* 酒馆助手认脚本用的 id，固定不变：以后导入新版时它认得是同一个脚本。与 v3.3 主系统的 id 不同（两者不能同时启用）。 */
export const SCRIPT_ID = 'b7e4c1d2-3a9f-4e6b-8c15-2f7a9d0e4b63';
export const LOADER_ID = 'e2a95f17-6c3b-4d84-a0f2-9b1c7e5d3a48';
/* reader-core.js 用 getButtonEvent 订阅的脚本按钮（tests/card.test.mjs 核对两边一致）。 */
export const SCRIPT_BUTTONS = ['Reader Core', '夜梦助手'];
export const LOADER_BUTTONS = ['夜梦助手', '记忆'];
export const REGEX_FILES = [
  ['正则/regex-Reader-II事件隐藏-提示词.json', 'reader-ii.regex.event-prompt.json'],
  ['正则/regex-Reader-II事件隐藏-显示.json', 'reader-ii.regex.event-display.json'],
  ['正则/regex-读者对话渲染-Reader-II.json', 'reader-ii.regex.dream-render.json'],
];

/* 酒馆助手把脚本放进 iframe 运行：酒馆宏会被替换，「$」加数字可能被当成替换串，</script 会提前结束脚本。主脚本与加载器里都不能有。 */
export function assertEmbeddable(code, label) {
  assertNoMacro(code, label);
  const dollar = /\$\d/.exec(code);
  if (dollar) throw new Error(`${label} 里有 ${dollar[0]}，附近：${JSON.stringify(code.slice(Math.max(0, dollar.index - 40), dollar.index + 20))}`);
  const close = /<\/script/i.exec(code);
  if (close) throw new Error(`${label} 里有 ${close[0]}，附近：${JSON.stringify(code.slice(Math.max(0, close.index - 40), close.index + 20))}`);
  return code;
}

const partMarker = (kind, name) => `/* ==== Reader-II ${kind}：${name} ==== */`;

/* 控制器 iframe 里的脚本，顺序见 build/controller.mjs 开头（交接 4.4）：prelude 最先，reader-ui-switch 最后；
 * 抽卡包排在 ReaderTransactions 之后（它要用控制器窗口上的 ReaderTransactions，上游有同样的约束）。 */
export function controllerParts(parts) {
  return [
    ['controller-prelude.js', parts.prelude],
    ['src/controller/reader-transactions-generic.js', assertNoMacro(read('src/controller/reader-transactions-generic.js'), 'reader-transactions-generic.js')],
    ['generated/reader-gacha.generic.js', read('generated/reader-gacha.generic.js')],
    ['reader-ui.js', parts.ui],
    ['booksea-album.js', parts.album],
    ['legacy-reader.js', parts.legacy],
    ['template-system.js', parts.templates],
    ['controller-adapter.js', parts.adapter],
    ['src/controller/generic-hooks.js', assertNoMacro(parts.hooks, 'generic-hooks.js')],
    ['reader-ui-switch.js', parts.uiSwitch],
  ];
}

/* 各段之间加分号：前一段没以分号结尾时，下一段开头的括号不会被当成函数调用。 */
export function buildController(parts) {
  const code = controllerParts(parts).map(([name, source]) => `${partMarker('控制器', name)}\n${source.trim()}\n;`).join('\n');
  return syntax(code, 'reader-controller.generic.js');
}

/* 资源包：字段与 transformUpstream() 同名，壳（reader-shell.js 的 checkAssets）按这些字段取用。 */
export function buildAssets(parts, version) {
  const controller = buildController(parts);
  syntax(parts.letterScript, 'letter.generic.js');
  /* 壳把 letterScript 放进 <script>、样式放进 <style>（都在 srcdoc 里）：不能提前结束标签。 */
  if (/<\/script/i.test(parts.letterScript)) throw new Error('letter.js 里有 </script，会提前结束轻信页的脚本');
  for (const [label, css] of [['控制器样式', parts.css], ['轻信样式', parts.letterViews.current.css]]) {
    if (/<\/style/i.test(css)) throw new Error(`${label}里有 </style`);
  }
  /* letterViews.legacy 壳用不到：旧版视图已嵌在 letterScript 里（交接 0.5 的 7.D 条目），省掉约 80 KB 重复的 CSS。 */
  return { version, css: parts.css, body: parts.body, controller, letterViews: { current: parts.letterViews.current }, letterScript: parts.letterScript };
}

/* gzip 头里不带时间戳，同样的输入得到同样的产物。 */
export const packAssets = (assets) => gzipSync(Buffer.from(JSON.stringify(assets), 'utf8'), { level: 9 }).toString('base64');

export function assetsModule(packed, version) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(packed)) throw new Error('资源包不是 base64');
  return [
    '(function (root) {',
    "  'use strict';",
    '  /* 构建生成（node build.mjs），不要手改：读者控制器资源包，gzip + base64 的 JSON {version, css, body, controller, letterViews, letterScript}，由 reader-shell.js 解开。 */',
    '  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};',
    "  modules.READER_ASSETS_GZIP = '" + packed + "';",
    ...(version ? ['  modules.BUILD_VERSION = ' + JSON.stringify(version) + ';'] : []),
    "})(typeof globalThis !== 'undefined' ? globalThis : window);",
  ].join('\n');
}

/* 主脚本：各模块之间同样加分号。 */
export function cardScript(version, packed) {
  const body = CARD_MODULES.map((file) => {
    const code = file === ASSETS_MODULE ? assetsModule(packed, version) : syntax(read(file), file);
    return `${partMarker('模块', file)}\n${code.trim()}\n;`;
  }).join('\n');
  const code = banner(version, '卡内组件主脚本（语义层 + 常驻壳 + 读者控制器）') + body + '\n';
  return assertEmbeddable(syntax(code, 'reader-ii.script.js'), '主脚本');
}

export function loaderScript(version) {
  const code = banner(version, '夜梦助手加载器') + syntax(read('src/reader-ii-loader.js'), 'src/reader-ii-loader.js').trim() + '\n';
  return assertEmbeddable(syntax(code, 'reader-ii.loader.js'), '加载器');
}

/* 酒馆助手脚本的导出格式（字段同根目录 v3.3 的 JSON）。 */
export function scriptJson({ id, name, info, content, buttons }) {
  return {
    type: 'script',
    enabled: true,
    name,
    id,
    content,
    info,
    button: { enabled: buttons.length > 0, buttons: buttons.map((label) => ({ name: label, visible: true })) },
    data: {},
    export_with: { data: true, button: true },
  };
}

/* 正则原样输出，只做校验。渲染正则只留插槽，由壳（reader-shell.js 的 SLOT / SOURCE）挂成轻信。 */
export function regexJsons() {
  const items = REGEX_FILES.map(([source, target]) => {
    const data = JSON.parse(read(source));
    for (const key of ['id', 'scriptName', 'findRegex', 'replaceString', 'placement']) {
      if (!(key in data)) throw new Error(`${source} 缺少 ${key}`);
    }
    const literal = /^\/([\s\S]+)\/([a-z]*)$/.exec(data.findRegex);
    if (!literal) throw new Error(`${source} 的 findRegex 不是 /…/flags 的写法`);
    try { new RegExp(literal[1], literal[2]); } catch (error) { throw new Error(`${source} 的 findRegex 写错了：${error.message}`); }
    return { source, target, data };
  });
  const render = items.filter((item) => item.data.replaceString.includes('data-reader-dream-slot'));
  if (render.length !== 1 || !render[0].data.replaceString.includes('data-reader-dream-source')) {
    throw new Error('渲染正则应当正好一条，并且留下 data-reader-dream-slot 与 data-reader-dream-source 插槽');
  }
  return items;
}

export function buildCard({ version = JSON.parse(read('manifest.json')).version, parts = transformUpstream() } = {}) {
  const assets = buildAssets(parts, version);
  const packed = packAssets(assets);
  const script = scriptJson({
    id: SCRIPT_ID,
    name: `Reader-II主系统-v${version}`,
    buttons: SCRIPT_BUTTONS,
    content: cardScript(version, packed),
    info: [
      'Reader-II 4.0 卡内组件主脚本：七槽语义层、常驻壳（读者控制器、轻信挂载）、命运抽卡、条目模仿。',
      '夜梦助手与记忆在 Reader-II 酒馆扩展里；没装扩展时从 jsDelivr 加载同一份。宿主没有 MVU 时从 jsDelivr 加载一份。',
      '配合 Reader-II 世界书与三条正则使用。不能与 v3.3 主系统同时启用：导入前请停用或删掉 v3.3 的主系统与兼容检查脚本。',
      `版本 ${version}`,
    ].join('\n'),
  });
  const loader = scriptJson({
    id: LOADER_ID,
    name: `Reader-II夜梦助手加载器-v${version}`,
    buttons: LOADER_BUTTONS,
    content: loaderScript(version),
    info: [
      '可选。没装 Reader-II 酒馆扩展、聊天里也没有 Reader-II 卡内组件时，用它在任意聊天里打开夜梦助手与记忆。',
      '它从 jsDelivr 加载扩展包（与扩展同一份）；装了扩展就不需要它。停用后刷新页面才会卸下。',
      `版本 ${version}`,
    ].join('\n'),
  });
  return { version, assets, packed, script, loader, regex: regexJsons(), worldbook: buildWorldbook({ version }) };
}

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`;

/* ---------- 发布清单（交接 0.6 甲组第 9 项） ---------- */
export const MANIFEST_FILE = 'dist/reader-ii.manifest.json';
export const BOOK_NAME = 'reader-ii.worldbook';

/* 指纹算法只有一份：在 vm 里跑 src/agent/updates.js，取它的 updateCanon（与扩展运行时同一实现）。 */
export function loadCanon() {
  const context = vm.createContext({});
  vm.runInContext(read('src/agent/updates.js'), context, { filename: 'src/agent/updates.js' });
  return context.__ReaderIIModules.updateCanon;
}

/* 与运行时相同：UTF-8，换行统一为 LF 后算 SHA-256。 */
export const textHash = (text) => createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');

export function componentFingerprints(card, canon = loadCanon()) {
  return {
    script: { file: 'dist/reader-ii.script.json', id: card.script.id, name: card.script.name, fingerprint: textHash(canon.scriptPayload(card.script)) },
    loader: { file: 'dist/reader-ii.loader.json', id: card.loader.id, name: card.loader.name, fingerprint: textHash(canon.scriptPayload(card.loader)) },
    regex: card.regex.map((item) => ({ file: `dist/${item.target}`, id: item.data.id, name: item.data.scriptName, fingerprint: textHash(canon.regexPayload(item.data)) })),
    worldbook: {
      file: 'dist/reader-ii.worldbook.json', book: BOOK_NAME,
      entries: Object.values(card.worldbook.json.entries).map((entry) => ({ name: canon.entryName(entry), fingerprint: textHash(canon.entryPayload(entry)) })),
    },
  };
}

/* previous 是上一次构建的清单：版本号变了，就把它的指纹记进 history（同一版本反复构建时 history 不变）。 */
export function releaseManifest({ version, outputs, components, previous = null, canon = loadCanon() }) {
  const files = {};
  for (const [file, text] of outputs) files[file] = { sha256: textHash(text), bytes: Buffer.byteLength(text) };
  const history = previous && previous.format === 1 && previous.history && typeof previous.history === 'object' ? { ...previous.history } : {};
  if (previous && previous.format === 1 && previous.version && previous.version !== version && previous.components) {
    history[previous.version] = canon.compactComponents(previous.components);
  }
  delete history[version];
  return { format: 1, name: 'reader-ii', version, hash: 'SHA-256（UTF-8，换行统一为 LF 后计算）', files, components, history };
}

function previousManifest() {
  const file = join(ROOT, MANIFEST_FILE);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${MANIFEST_FILE} 不是合法的 JSON：它带着历史版本的指纹，请先修好或从仓库恢复，不要直接删掉`); }
}

function main() {
  const manifest = JSON.parse(read('manifest.json'));
  const ext = extBundle(manifest.version);
  const card = buildCard({ version: manifest.version });
  const outputs = [
    ['dist/reader-ii.ext.js', ext, `${EXT_MODULES.length} 个模块`],
    ['dist/reader-ii.script.json', json(card.script), `${CARD_MODULES.length} 个模块，资源包 ${kb(card.packed)}`],
    ['dist/reader-ii.loader.json', json(card.loader), '可选'],
    ...card.regex.map((item) => [`dist/${item.target}`, json(item.data), item.data.scriptName]),
    ['dist/reader-ii.worldbook.json', json(card.worldbook.json), `${Object.keys(card.worldbook.json.entries).length} 个条目，取自上游世界书 v${card.worldbook.upstreamVersion}`],
  ];
  const canon = loadCanon();
  const release = releaseManifest({ version: manifest.version, outputs, components: componentFingerprints(card, canon), previous: previousManifest(), canon });
  outputs.push([MANIFEST_FILE, json(release), `发布清单：${Object.keys(release.files).length} 个文件的 SHA-256，历史版本 ${Object.keys(release.history).length} 个`]);
  const check = process.argv.includes('--check');
  if (!check) {
    mkdirSync(join(ROOT, 'dist'), { recursive: true });
    for (const [file, text] of outputs) writeFileSync(join(ROOT, file), text);
  }
  for (const [file, text, note] of outputs) console.log(`${file}  ${kb(text)}  (${note})`);
  console.log(check ? `检查通过（没有写文件），版本 ${manifest.version}` : `版本 ${manifest.version}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
