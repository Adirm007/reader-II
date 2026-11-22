// 上游控制器的其余部分 → Reader-II 通用版（交接 7.C）。这里只做变换与校验，不拼最终产物；拼装在 7.F 的 build.mjs。
//
// 每处替换都校验命中次数（build/lib.mjs）：上游改了锚点时构建直接报错并指出是哪一处；变换后做残留检查与语法检查。
// 7.F 拼控制器时的顺序（照上游 tools/build_core.mjs，去掉发布工具、书海宿主与黑之作家缓存）：
//   controller-prelude.js（原样）→ src/controller/reader-transactions-generic.js → generated/reader-gacha.generic.js
//   → reader-ui.js → booksea-album.js（前面带 SHA-256 垫片）→ legacy-reader.js → template-system.js
//   → controller-adapter.js → 通用钩子（src/controller/generic-hooks.js）→ reader-ui-switch.js（原样）
// legacy-reader.css 原样；legacy-body.html 是控制器页面的 body；letter.js 与两套轻信视图交给壳（7.D）挂载。
// 各段的 localStorage 键都换成 reader-II 自己的（build/local-keys.mjs，表在 src/reader-env.js 的 LOCAL_KEYS；交接 0.6 甲组第 11 项）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read, countExact, replaceExact, replaceRegex, patchFunction, assertSyntax, assertNoMacro } from './lib.mjs';
import { transformLegacy } from './legacy.mjs';
import { renameLocalKeys, findOldLocalKeys } from './local-keys.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PATHS = Object.freeze({
  upstream: path.resolve(here, '../upstream/reader/source'),
  templates: path.resolve(here, '../模板'),
  controller: path.resolve(here, '../src/controller'),
});
export const GENERIC_TEMPLATE_ID = 'reader-default-generic-character';
/* reader-II 自己的本机存储键：同一个浏览器里也装了原版读者时，两边的模板库与写作设置互不干扰。
 * 抽卡包读同一个模板库：gacha/src/reader/gacha-reader.ts 的 TEMPLATE_LIBRARY_KEY 必须与这里一致（tests/build.test.mjs 核对）。 */
export const TEMPLATE_LIBRARY_KEY = 'reader_ii_template_library_v1';
export const WRITER_SETTINGS_KEY = 'reader_ii_writer_settings_v1';

function residue(source, label, tokens) {
  for (const token of tokens) if (source.includes(token)) throw new Error(`${label} 变换后仍残留：${token}`);
  return source;
}

/* 把值写成能嵌进脚本的字面量：'<' 与行分隔符转义，嵌进 <script> 或 srcdoc 也不会提前结束。 */
const UNSAFE_CHARS = new RegExp('[<' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
export function jsLiteral(value) {
  return JSON.stringify(value).replace(UNSAFE_CHARS, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

/* ---------- legacy-body.html（控制器页面的 body，旧版菜单板） ---------- */
const BODY_UPDATE_ROW = '<div class="sub-opt" onclick="openDreamWorldbookUpdate(event,showToast)"><span>检查更新</span><span style="font-family:monospace;font-size:12px;">检查</span></div><div style="padding:0 10px 6px 10px;font-size:11px;color:#8a796f;font-style:italic;">分别检查正则、脚本和世界书，更新可用项目</div>';
/* 菜单板上不再放助手的入口：助手对话、助手设置、语义适配、记忆都收在大厅的「彩蛋服务台」里（交接 0.9）。 */

export function transformLegacyBody(input) {
  let s = input;
  s = replaceExact(s, "orderItem('更新新闻')", "orderItem('请读者写一则旁观札记')", '菜单板点单：旁观札记');
  s = replaceExact(s, '<span>新闻更新</span>', '<span>旁观札记</span>', '菜单板名字：旁观札记');
  s = replaceExact(s, BODY_UPDATE_ROW, '', '菜单板：去掉检查更新');
  s = replaceExact(s, '条目模仿与书海的请求可分别指定方案', '条目模仿、命运抽卡与夜梦助手的请求可分别指定方案', '菜单板：独立 API 说明');
  /* 「使用间章:小憩」不改：世界书靠这句点单触发。 */
  if (countExact(s, "orderItem('使用间章:小憩')") !== 1) throw new Error('legacy-body.html：小憩的点单应原样保留且唯一');
  return residue(s, 'legacy-body.html', ['更新新闻', '新闻更新', '检查更新', 'openDreamWorldbookUpdate', '书海']);
}

/* ---------- reader-ui.js（新版前端，打包后的 bundle；data-dlb 动作仍交给 legacy 的处理函数） ---------- */
export function transformReaderUi(input) {
  let s = input;
  s = replaceExact(s,
    '${i("eggbooksea")}><b class="q-nm">进入普罗泰利西翁</b><small class="q-ds">书海迷宫。眼下的对话会留着；输入框里有草稿的话先存好。</small><span class="sv2">进入</span>',
    '${i("eggagent")}><b class="q-nm">和夜梦说说话</b><small class="q-ds">查资料、改变量、排查这张卡、整理记忆。要动手改东西之前，她会先问你。</small><span class="sv2">打开</span>',
    '彩蛋页书海入口 → 夜梦助手');
  /* 通用版彩蛋页本身主门就是夜梦助手，去掉原版共存附加的第二道夜梦助手门。 */
  s = replaceRegex(
    s,
    /\+\([A-Za-z_$][\w$]*\.hasAgent\?`<button type="button" class="q-door" style="margin-top:10px"\$\{i\("eggagent"\)\}>[\s\S]*?<\/button>`:""\)/,
    '',
    '彩蛋页移除共存附加助手门',
  );
  /* 通用版不需要多核心管理，移除彩蛋页核心管理行。 */
  s = replaceRegex(
    s,
    /\+[A-Za-z_$][\w$]*\(i\("eggcoremgr"\),"核心管理","[^"]*",`<span class="sv2" id="dlb-egg-coremgr">\$\{[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.coreMgr\|\|"未启用"\)\}<\/span>`\)/,
    '',
    '彩蛋页移除核心管理入口',
  );
  s = replaceRegex(
    s,
    /([A-Za-z_$][\w$]*)\(i\("eggwb"\),"检查更新","分别检查正则、脚本和世界书"\)/,
    '$1(i("eggagentset"),"助手设置","模型与工具调用方式、权限、联网与插件对接、版本更新")+$1(i("eggpanel"),"语义适配","把这张卡的变量接到读者这边，可以一键适配")+$1(i("eggmemory"),"记忆","查看与助手的交流记忆，可随聊天保存或存进《夜之洋》")',
    '彩蛋页检查更新 → 助手设置 / 语义适配 / 记忆',
  );
  s = replaceExact(s, 'sea:"书海迷宫"', 'sea:"夜梦助手"', '三套主题的书海标题', 3);
  s = replaceExact(s, '{text:"更新新闻"}', '{text:"请读者写一则旁观札记"}', '三套主题的点单文本', 3);
  s = replaceExact(s, 'name:"新闻更新"', 'name:"旁观札记"', '三套主题的菜单名', 3);
  /* section[data-reader-booksea] 的样式留着无害。 */
  residue(s, 'reader-ui.js', ['eggbooksea', 'eggcoremgr', 'eggwb', '检查更新', '核心管理', '书海', '普罗泰利西翁', '更新新闻', '新闻更新']);
  s = renameLocalKeys(s, 'reader-ui.js');
  return assertSyntax(s, 'reader-ui.generic.js');
}

/* ---------- controller-adapter.js ---------- */
const ADAPTER_UPDATE_TAIL = [
  '  // TEMP_MAIN_CARD_43: the old auto-regex host restores its last accepted reader version.',
  "  if (!window.__readerHostApi?.scriptOwner && window.__readerHostApi?.getUpdateOptions?.().hostMode !== 'auto-regex')",
  '    setTimeout(function () { if (window.__readerControllerAlive) window.ReaderUpdates?.restore(); }, 0);',
  "  if (window.__readerHostApi?.getUpdateOptions?.().hostMode !== 'auto-regex')",
  '    setTimeout(function () { if (window.__readerControllerAlive) dreamWbAutoCheck(); }, 5000);',
  '',
].join('\n');

export function transformControllerAdapter(input) {
  /* createReaderBookseaHost 不存在，bookseaHost 自然为 null，书海那几行不用改。 */
  let s = replaceExact(input, ADAPTER_UPDATE_TAIL, '', '文件末尾两个检查更新的 setTimeout');
  s = replaceExact(s, '      try { window.ReaderCoreManager?.uninstallWorldInfoHook?.(); } catch (_) {}\n', '', '移除多核心管理器卸载钩子');
  residue(s, 'controller-adapter.js', ['ReaderUpdates', 'ReaderCoreManager', 'dreamWbAutoCheck', 'getUpdateOptions', 'scriptOwner']);
  return assertSyntax(renameLocalKeys(s, 'controller-adapter.js'), 'controller-adapter.generic.js');
}

/* ---------- extra-settings.js（附加设定：跨人格持久生效，按机制/外貌/性格三类并入提示词） ---------- */
export function transformExtraSettings(input) {
  assertNoMacro(input, 'extra-settings.js');
  return assertSyntax(input, 'extra-settings.generic.js');
}

/* ---------- reader-ui-switch.js（新旧前端切换；只换本机键） ---------- */
export function transformUiSwitch(input) {
  return assertSyntax(renameLocalKeys(input, 'reader-ui-switch.js'), 'reader-ui-switch.generic.js');
}

/* ---------- 新写的控制器片段（src/controller/） ---------- */
function controllerSnippet(name) {
  const code = read(path.join(PATHS.controller, name));
  assertNoMacro(code, name);
  return assertSyntax(code, name);
}
/* 通用钩子：放在 adapter 之后、ui-switch 之前。 */
export const genericHooks = () => controllerSnippet('generic-hooks.js');
export const sha256Shim = () => controllerSnippet('sha256-shim.js');

/* ---------- booksea-album.js ---------- */
export function transformBookseaAlbum(input) {
  /* 去掉书海专辑（约 21 KB）；保留读者自托管的六首 readerCatalog 与 createPlayer。 */
  const s = replaceRegex(input, /^  var catalog=\[.*\];$/m, '  var catalog=[];', '书海专辑的曲目清单');
  residue(s, 'booksea-album.js', ['"sha256":"']);
  if (countExact(s, '"sha256": "') !== 6) throw new Error('booksea-album.js：读者自托管的六首应原样保留');
  /* 校验音频时调用 root.DreamFixedReleaseClient.sha256：那个对象来自通用版不带的发布工具，垫片必须排在前面。 */
  if (countExact(s, 'root.DreamFixedReleaseClient') !== 1) throw new Error('booksea-album.js：配乐校验应恰有 1 处读取 DreamFixedReleaseClient');
  return assertSyntax(sha256Shim() + '\n;\n' + s, 'booksea-album.generic.js');
}

/* ---------- template-system.js（条目模仿） ---------- */
/* 读 模板/ 里的通用角色条目模板（抽卡包的 gacha/sync-template.mjs 读的是同一份）。 */
export function loadGenericTemplate(dir = PATHS.templates) {
  const strip = text => text.replace(/^\uFEFF/, '');
  return {
    text: strip(read(path.join(dir, '通用角色条目模板.txt'))).trim(),
    settings: JSON.parse(strip(read(path.join(dir, '通用角色条目模板.设置.json')))),
  };
}

export function transformTemplateSystem(input, template = loadGenericTemplate()) {
  const { text, settings } = template;
  if (!text) throw new Error('通用角色条目模板.txt 是空的');
  if (!settings || settings.id !== GENERIC_TEMPLATE_ID) throw new Error(`通用角色条目模板.设置.json 的 id 应为 ${GENERIC_TEMPLATE_ID}`);
  for (const key of ['name', 'generationInstruction', 'entryNameRule']) {
    if (typeof settings[key] !== 'string' || !settings[key].trim()) throw new Error('通用角色条目模板.设置.json 缺少 ' + key);
  }
  if (!settings.output || typeof settings.output !== 'object' || !String(settings.output.targetWorldbook ?? '').trim()) {
    throw new Error('通用角色条目模板.设置.json 的 output 没有写目标世界书');
  }
  /* 控制器会经过酒馆宏替换；也不能带 </script 与正则替换记号（与 gacha/sync-template.mjs 的检查一致）。 */
  const bad = /<user>|\{\{user\}\}|<(?:bot|char)>|\{\{char\}\}|\{\{match\}\}|\$(?:\d|<)|<\/script/i.exec(JSON.stringify([text, settings]));
  if (bad) throw new Error('通用角色条目模板里有控制器不能带的记号 ' + bad[0]);

  let s = input;
  s = replaceExact(s, "var DEFAULT_TEMPLATE_ID='reader-default-fated-character';", `var DEFAULT_TEMPLATE_ID='${GENERIC_TEMPLATE_ID}';`, '默认模板 id');
  s = replaceExact(s, "var LIBRARY_KEY='reader_generic_template_library_v1';", `var LIBRARY_KEY='${TEMPLATE_LIBRARY_KEY}';`, '模板库的本机键');
  s = replaceExact(s, "var WRITER_KEY='reader_generic_writer_settings_v1';", `var WRITER_KEY='${WRITER_SETTINGS_KEY}';`, '写作设置的本机键');
  s = replaceRegex(s, /^var DEFAULT_TEMPLATE_TEXT=".*";$/m, () => 'var DEFAULT_TEMPLATE_TEXT=' + jsLiteral(text) + ';', '默认模板正文');
  /* 生成指令、条目名规则与输出设置也取自 .设置.json：模板系统第一次运行时把默认模板存进模板库
   * （TEMPLATE_LIBRARY_KEY），抽卡包读同一个库、同一个 id 以库里的为准，两边要是同一份。 */
  s = patchFunction(s, 'defaultTemplate', [
    ["name:'常规命定角色生成'", 'name:' + jsLiteral(settings.name)],
    ['generationInstruction:DEFAULT_GENERATION_INSTRUCTION,entryNameRule:DEFAULT_ENTRY_NAME_RULE,output:defaultOutput()',
      'generationInstruction:' + jsLiteral(settings.generationInstruction) + ',entryNameRule:' + jsLiteral(settings.entryNameRule)
      + ',output:normalizeOutput(' + jsLiteral(settings.output) + ')'],
    ["label:'原缘加强默认模板'", "label:'Reader通用内置模板'"],
  ], '默认模板');
  /* defaultOutput 是所有模板输出设置的底子，只换目标世界书。 */
  s = patchFunction(s, 'defaultOutput', [["targetWorldbook:'阿斯塔利亚人物志'", 'targetWorldbook:' + jsLiteral(settings.output.targetWorldbook)]], '默认目标世界书');
  residue(s, 'template-system.js', ['reader-default-fated-character', '常规命定角色生成', '原缘加强默认模板', '阿斯塔利亚', '命定', 'reader_generic_']);
  s = renameLocalKeys(s, 'template-system.js');
  return assertSyntax(s, 'template-system.generic.js');
}

/* ---------- letter.js（轻信） ---------- */
/* 上游 tools/build_core.mjs 给旧轻信视图补的样式。 */
export const LEGACY_LETTER_EXTRA_CSS = '\n.menu-board{display:none!important}.reader-letter-compact .cafe-v20-responsive{display:none!important}.reader-letter-compact .outer-collapse:not([open]){display:block}.reader-letter-compact .flower-btn{display:block}';

export function legacyLetterView(legacyLetterBody, legacyCss) {
  return { html: replaceExact(legacyLetterBody, '<!--DREAM_LETTER-->', '', '旧轻信的正文插槽'), css: legacyCss + LEGACY_LETTER_EXTRA_CSS };
}

export function currentLetterView(letterBody, letterCss) {
  const css = letterCss.trim();
  if (/\$(?:\d|<)|\{\{|<\/style/i.test(css)) throw new Error('reader-letter.css 里有替换记号、宏或 </style>');
  return { html: replaceExact(letterBody, '<!--DREAM_LETTER-->', '', '轻信的正文插槽'), css };
}

const LETTER_HOST_OLD = 'var host = window.parent, frame = window.frameElement;';
const LETTER_HOST_NEW = [
  'var host = findTavernWindow(), frame = window.frameElement;',
  '  /* 插槽可能嵌在正文美化的 iframe 里：向上找到带 SillyTavern 的那一层（酒馆主窗口）。 */',
  '  function findTavernWindow() {',
  '    var win = window;',
  '    try { while (win.parent && win.parent !== win) { win = win.parent; if (win.SillyTavern) return win; } } catch (_) {}',
  '    return window.parent;',
  '  }',
].join('\n');
const LETTER_ID_OLD = [
  '    var messageId;',
  "    try { if (typeof getCurrentMessageId === 'function') messageId = getCurrentMessageId(); } catch (_) {}",
  "    if (messageId == null) messageId = frame?.closest('.mes')?.getAttribute('mesid');",
].join('\n');
const LETTER_ID_NEW = [
  "    /* 楼层号：壳挂载时写在 iframe 的 data-reader-message-id 上（壳建的 iframe 里没有 getCurrentMessageId，嵌套时 closest('.mes') 也找不到）。 */",
  "    var messageId = frame?.getAttribute('data-reader-message-id');",
  "    if (messageId === '' || messageId == null) messageId = undefined;",
  "    try { if (messageId == null && typeof getCurrentMessageId === 'function') messageId = getCurrentMessageId(); } catch (_) {}",
  "    if (messageId == null) messageId = frame?.closest('.mes')?.getAttribute('mesid');",
  "    if (typeof messageId === 'string' && /^\\d+$/.test(messageId)) messageId = Number(messageId);",
].join('\n');

export function transformLetter(input, { legacyLetterBody, legacyCss }) {
  assertNoMacro(LETTER_HOST_NEW + '\n' + LETTER_ID_NEW, 'letter.js 新增的代码');
  let s = input;
  s = replaceExact(s, LETTER_HOST_OLD, LETTER_HOST_NEW, '轻信的宿主窗口');
  s = replaceExact(s, 'function core() { return host.ReaderCore; }', 'function core() { return host.ReaderShell; }', '轻信找的宿主接口');
  s = replaceExact(s, LETTER_ID_OLD, LETTER_ID_NEW, '轻信的楼层号');
  /* window.ReaderLetterUpdaterBridge?.(…) 是可选链，留着无害。 */
  s = replaceExact(s, '__READER_LEGACY_LETTER_VIEW__', jsLiteral(legacyLetterView(legacyLetterBody, legacyCss)), '旧轻信视图');
  if (/<\/script/i.test(s)) throw new Error('letter.js 里有 </script>');
  residue(s, 'letter.js', ['host.ReaderCore', '__READER_LEGACY_LETTER_VIEW__']);
  s = renameLocalKeys(s, 'letter.js');
  return assertSyntax(s, 'letter.generic.js');
}

/* ---------- 一次跑完所有变换（7.F 与测试用；不拼接） ---------- */
export function transformUpstream({ upstream = PATHS.upstream, templates = PATHS.templates } = {}) {
  const src = name => read(path.join(upstream, name));
  const css = src('legacy-reader.css');
  const legacyLetterBody = src('legacy-letter-body.html');
  const parts = {
    /* 控制器各段，按上面注释里的顺序 */
    prelude: src('controller-prelude.js'),
    ui: transformReaderUi(src('reader-ui.js')),
    album: transformBookseaAlbum(src('booksea-album.js')),
    extraSettings: transformExtraSettings(src('extra-settings.js')),
    legacy: transformLegacy(src('legacy-reader.js')),
    templates: transformTemplateSystem(src('template-system.js'), loadGenericTemplate(templates)),
    adapter: transformControllerAdapter(src('controller-adapter.js')),
    hooks: genericHooks(),
    uiSwitch: transformUiSwitch(src('reader-ui-switch.js')),
    /* 资源（7.D 的 ASSETS 用同样的键名） */
    css,
    body: replaceExact(transformLegacyBody(src('legacy-body.html')), '<!--DREAM_LETTER-->', '', '控制器 body 的正文插槽'),
    letterScript: transformLetter(src('letter.js'), { legacyLetterBody, legacyCss: css }),
    letterViews: {
      current: currentLetterView(src('letter-body.html'), src('reader-letter.css')),
      legacy: legacyLetterView(legacyLetterBody, css),
    },
  };
  /* 本机键：各段都不再有带引号的旧键，只剩 legacy 里 TK 的定义（它同时是聊天变量的名字）。 */
  for (const [name, text] of [...Object.entries(parts).filter(([, v]) => typeof v === 'string'), ['letterViews.current', JSON.stringify(parts.letterViews.current)]]) {
    const left = findOldLocalKeys(text);
    if (name === 'legacy' && left.dream_visual_theme === 1) delete left.dream_visual_theme;
    if (Object.keys(left).length) throw new Error(`${name} 里仍有原版读者的本机键：${JSON.stringify(left)}`);
  }
  return parts;
}
