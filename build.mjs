#!/usr/bin/env node
/*
 * Reader-II 构建。只用 Node 标准库。
 *
 *   node build.mjs            构建扩展包，写进 dist/
 *   node build.mjs --check    只做检查，不写文件
 *
 * 产物只有一个：dist/reader-ii.ext.js（由 index.js 在酒馆就绪后加载）。里面是全部功能：
 *   语义层（七槽路由、经济、事件）、常驻壳与读者控制器资源（大厅、轻信、抽卡；gzip + base64）、
 *   提示词模板（编译成函数）、记忆、夜梦助手（Agent 内核）与面板。
 * 4.1 之前另有「卡内组件」（酒馆助手脚本、世界书、三条正则的 JSON）与 CDN 加载器，现在都并进了扩展（交接 0.9）。
 * 发布清单 dist/reader-ii.manifest.json 记下扩展包的 SHA-256。
 * 版本号只有一个来源：manifest.json 的 version（语义化版本），构建把它写进 modules.BUILD_VERSION。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';
import { transformUpstream } from './build/controller.mjs';
import { assertNoMacro } from './build/lib.mjs';
import { promptTemplates, promptsModule, PROMPTS_MODULE } from './build/prompts.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

/* 读者控制器资源包与提示词模板由构建生成，不是源文件。 */
export const ASSETS_MODULE = 'reader-assets';
export { PROMPTS_MODULE };

/* 顺序即依赖顺序：后面的模块在加载期会用到前面的。 */
export const CORE_MODULES = [
  'src/reader-env.js', 'src/reader-host-kit.js', 'src/reader-native-host.js', 'src/reader-agent-transport.js',
  'src/reader-media.js', 'src/reader-task-models.js', 'src/reader-llm-gateway.js',
  /* 语义层 */
  'src/reader-mvu-guard.js', 'src/reader-runtime-store.js', 'src/reader-economy.js', 'src/reader-host-adapter.js',
  'src/reader-semantic-codec.js', 'src/reader-semantic-router.js', 'src/reader-character-scan.js',
  'src/reader-adaptation-llm.js', 'src/reader-event-parser.js', 'src/reader-ui-bridge.js', 'src/reader-auto-adapt.js', 'src/reader-lwb-host.js',
  /* 读者界面与提示词 */
  ASSETS_MODULE, PROMPTS_MODULE, 'src/reader-shell.js', 'src/reader-prompt-placement.js', 'src/reader-prompt.js', 'src/reader-core.js',
];
export const AGENT_MODULES = [
  'src/reader-memory.js',
  'src/agent/store.js', 'src/agent/protocol.js', 'src/agent/permissions.js', 'src/agent/vfs.js', 'src/agent/providers.js', 'src/agent/tools.js',
  'src/agent/net.js', 'src/agent/web.js', 'src/agent/device.js', 'src/agent/mcp.js', 'src/agent/connectors.js', 'src/agent/skills.js',
  'src/agent/legacy-tools.js', 'src/agent/personas.js', 'src/agent/agent.js', 'src/agent/updates.js',
  'src/agent/ui-theme.js', 'src/agent/ui-net.js', 'src/agent/ui-models.js', 'src/agent/ui.js', 'src/agent/boot.js',
];
export const EXT_MODULES = [...CORE_MODULES, ...AGENT_MODULES];

function syntax(code, filename) {
  try { new vm.Script(code, { filename }); }
  catch (error) { throw new Error(`${filename} 语法错误：${error.message}`); }
  return code;
}

const banner = (version, what) => `/*! Reader-II ${version} · ${what} · https://github.com/Adirm007/reader-II · 许可见 LICENSE */\n`;

/* 版本号写进模块表：ReaderII.version、ReaderCore.version 与检查更新都取它。 */
export function versionModule(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`manifest.json 的版本号不是语义化版本：${version}`);
  return `(function (root) { (root.__ReaderIIModules = root.__ReaderIIModules || {}).BUILD_VERSION = ${JSON.stringify(version)}; })(typeof globalThis !== 'undefined' ? globalThis : window);\n`;
}

const partMarker = (kind, name) => `/* ==== Reader-II ${kind}：${name} ==== */`;

/* ---------- 读者控制器资源包 ---------- */

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
  /* letterViews.legacy 壳用不到：旧版视图已嵌在 letterScript 里，省掉约 80 KB 重复的 CSS。 */
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

/* 两个生成模块的代码。变换上游要零点几秒，同一个进程里按版本缓存（测试会反复打包）。 */
const generatedCache = new Map();
export function generatedModules(version = JSON.parse(read('manifest.json')).version) {
  if (generatedCache.has(version)) return generatedCache.get(version);
  const assets = buildAssets(transformUpstream(), version);
  const packed = packAssets(assets);
  const prompts = promptTemplates({ version });
  const value = {
    assets, packed, prompts,
    code: { [ASSETS_MODULE]: assetsModule(packed, version), [PROMPTS_MODULE]: promptsModule(prompts.templates) },
  };
  generatedCache.set(version, value);
  return value;
}

/* 把模块按顺序拼起来；各模块之间加分号。generated 可以给出生成模块的替身（测试用假资源包时）。 */
export function bundle(files, generated) {
  let code = null;
  return files.map((file) => {
    let source;
    if (file === ASSETS_MODULE || file === PROMPTS_MODULE) {
      if (generated && typeof generated[file] === 'string') source = generated[file];
      else { code = code || generatedModules().code; source = code[file]; }
    } else source = read(file);
    syntax(source, file);
    return `${partMarker('模块', file)}\n${source.trim()}\n;`;
  }).join('\n');
}

export function extBundle(version) {
  return syntax(banner(version, '扩展包（语义层 + 读者界面 + 提示词 + 记忆 + 夜梦助手）') + versionModule(version) + bundle(EXT_MODULES, generatedModules(version).code) + '\n', 'dist/reader-ii.ext.js');
}

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`;

/* ---------- 发布清单 ---------- */
export const MANIFEST_FILE = 'dist/reader-ii.manifest.json';
/* 与运行时相同：UTF-8，换行统一为 LF 后算 SHA-256。 */
export const textHash = (text) => createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');

export function releaseManifest({ version, outputs }) {
  const files = {};
  for (const [file, text] of outputs) files[file] = { sha256: textHash(text), bytes: Buffer.byteLength(text) };
  return { format: 2, name: 'reader-ii', version, hash: 'SHA-256（UTF-8，换行统一为 LF 后计算）', files };
}

/* 4.1 之前的产物：卡内组件已并进扩展，构建时顺手清掉，免得仓库里留着过期的文件。 */
export const RETIRED_OUTPUTS = [
  'dist/reader-ii.script.json', 'dist/reader-ii.loader.json', 'dist/reader-ii.worldbook.json',
  'dist/reader-ii.regex.event-prompt.json', 'dist/reader-ii.regex.event-display.json', 'dist/reader-ii.regex.dream-render.json',
];

/* 后端伴侣（companion/）不经打包，直接随仓库分发；它与仓库根的 package.json 里的版本号跟着 manifest.json 走。 */
export const PACKAGE_FILES = ['package.json', 'companion/package.json'];

export function syncPackageVersions(version, check = false) {
  const changed = [];
  for (const file of PACKAGE_FILES) {
    const data = JSON.parse(read(file));
    if (data.version === version) continue;
    if (check) throw new Error(`${file} 的版本号（${data.version}）与 manifest.json（${version}）不一致：先跑一次 node build.mjs`);
    data.version = version;
    writeFileSync(join(ROOT, file), JSON.stringify(data, null, 2) + '\n');
    changed.push(file);
  }
  return changed;
}

function main() {
  const manifest = JSON.parse(read('manifest.json'));
  const generated = generatedModules(manifest.version);
  const ext = extBundle(manifest.version);
  const outputs = [
    ['dist/reader-ii.ext.js', ext, `${EXT_MODULES.length} 个模块；读者界面资源包 ${kb(generated.packed)}，提示词模板取自上游世界书 v${generated.prompts.upstreamVersion}`],
  ];
  const release = releaseManifest({ version: manifest.version, outputs });
  outputs.push([MANIFEST_FILE, json(release), '发布清单']);
  const check = process.argv.includes('--check');
  const entry = 'index.js?v=' + manifest.version;
  if (manifest.js !== entry) {
    if (check) throw new Error('manifest.json 的入口与版本不一致，请先运行 node build.mjs');
    manifest.js = entry;
    writeFileSync(join(ROOT, 'manifest.json'), json(manifest));
  }
  if (!check) {
    mkdirSync(join(ROOT, 'dist'), { recursive: true });
    for (const [file, text] of outputs) writeFileSync(join(ROOT, file), text);
    for (const file of RETIRED_OUTPUTS) {
      if (!existsSync(join(ROOT, file))) continue;
      rmSync(join(ROOT, file));
      console.log(`${file}  已删除（卡内组件并进了扩展）`);
    }
  }
  for (const [file, text, note] of outputs) console.log(`${file}  ${kb(text)}  (${note})`);
  for (const file of syncPackageVersions(manifest.version, check)) console.log(`${file}  版本号同步为 ${manifest.version}`);
  console.log(check ? `检查通过（没有写文件），版本 ${manifest.version}` : `版本 ${manifest.version}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
