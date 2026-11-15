// 本机存储键独立（交接 0.6 甲组第 11 项）：控制器各段与 letter.js 里沿用原版读者的 localStorage 键，构建时换成 reader-II 自己的。
//
// 唯一的一张表是 src/reader-env.js 的 modules.LOCAL_KEYS：运行时 createEnv 按它把旧键的值迁移到新键（只做一次，旧键不删），
// 构建期这里在 vm 里跑一遍那个文件取出同一张表。壳在迁移之后才创建控制器与轻信页，所以产物里只换名，不带迁移代码。
// 换名按 LOCAL_KEY_SITES 校验每段里旧键（带引号的字面量）的处数：上游新增或改了读写的地方时构建报错，提醒先更新表。
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { read, replaceExact, replaceRegex } from './lib.mjs';

export const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/reader-env.js');

const cache = new Map();
/* 返回 {旧键: 新键}。 */
export function loadLocalKeys(file = ENV_FILE) {
  if (cache.has(file)) return cache.get(file);
  const context = vm.createContext({});
  vm.runInContext(read(file), context, { filename: file });
  const table = context.__ReaderIIModules && context.__ReaderIIModules.LOCAL_KEYS;
  if (!Array.isArray(table) || !table.length) throw new Error(`${file} 里没有 modules.LOCAL_KEYS`);
  const keys = {};
  for (const entry of table) {
    const [oldKey, newKey, migrate] = entry;
    if (!/^dream_[a-z0-9_]+$/.test(oldKey) || !/^reader_ii_[a-z0-9_]+$/.test(newKey) || typeof migrate !== 'boolean' || keys[oldKey]) {
      throw new Error('LOCAL_KEYS 里有不合规的一项：' + JSON.stringify(entry));
    }
    keys[oldKey] = newKey;
  }
  if (new Set(Object.values(keys)).size !== table.length) throw new Error('LOCAL_KEYS 里有重复的新键');
  const frozen = Object.freeze(keys);
  cache.set(file, frozen);
  return frozen;
}

/* 各文件里旧键应有的处数（单双引号都算）。都是 localStorage 的键；dream_visual_theme 在 legacy 里另有聊天变量的用法，见 legacyThemeKey。 */
export const LOCAL_KEY_SITES = Object.freeze({
  'reader-ui.js': { dream_ui_v4: 1 }, /* enabled()：ui-switch 把 localStorage 传进来 */
  'legacy-reader.js': {
    dream_render_mode: 2, /* DK，以及注入酒馆主文档的悬浮心跳脚本里直接读的一处 */
    dream_auto_unseal: 1, dream_ui_v4: 1, dream_letter_unfold: 1,
    dream_font: 1, dream_font_size: 1, dream_summer_radio_pos: 1,
    dream_albums: 2, dream_playlist: 1, dream_current_album: 2, dream_play_mode: 1,
    dream_independent_api_v1: 1, dream_independent_api_v2: 1, dream_independent_api_models_v1: 1,
    dream_lobby_open: 2, dream_lobby_at: 3, dream_lobby_key: 2,
    dream_gallery_cache_v1: 1, dream_persona_dlc_cache_v1: 1, dream_persona_dlc_meta_v1: 1, dream_worldbook_check_v1: 1,
  },
  'template-system.js': { dream_visual_theme: 1 }, /* 读主题的本机兜底 */
  'controller-adapter.js': { dream_hide_persistent_float: 1 },
  'reader-ui-switch.js': { dream_ui_v4: 3, dream_hide_persistent_float: 1 }, /* 读、写、storage 事件比对的键名 */
  'letter.js': { dream_visual_theme: 1, dream_letter_unfold: 2, dream_ui_v4: 1 },
});

const quoted = key => new RegExp(`(['"])${key}\\1`, 'g');

/* 产物里还剩几处带引号的旧键：{旧键: 处数}，没有就是 {}。 */
export function findOldLocalKeys(source, keys = loadLocalKeys()) {
  const found = {};
  for (const oldKey of Object.keys(keys)) {
    const count = (source.match(quoted(oldKey)) || []).length;
    if (count) found[oldKey] = count;
  }
  return found;
}

/* legacy 的 TK = 'dream_visual_theme' 既是聊天变量的名字（getSTVariable / setSTVariable，世界书也读，不改），
 * 又被 gLS / sLS 拿来当主题的本机兜底。本机兜底改用新常量 READER_II_THEME_KEY。 */
export const LEGACY_THEME_CONST = 'READER_II_THEME_KEY';
function legacyThemeKey(source, keys) {
  const def = "TK='dream_visual_theme',";
  let s = replaceExact(source, def, `${def}${LEGACY_THEME_CONST}=${JSON.stringify(keys.dream_visual_theme)},`, 'legacy-reader.js：主题本机兜底的键');
  s = replaceExact(s, 'gLS(TK,', `gLS(${LEGACY_THEME_CONST},`, 'legacy-reader.js：读主题的本机兜底');
  s = replaceExact(s, 'sLS(TK,', `sLS(${LEGACY_THEME_CONST},`, 'legacy-reader.js：写主题的本机兜底', 3);
  /* 剩下的 TK 只能是：定义、聊天变量的读写、syncLabels / updateLabel 拿它当标签名（两边是同一份代码里的同一个常量） */
  const uses = (s.match(/\bTK\b/g) || []).length;
  const known = [/\bTK='dream_visual_theme',/g, /\b[gs]etSTVariable\(TK[,)]/g, /\.updateLabel\(TK,/g, /\bkey===TK\)/g]
    .reduce((count, pattern) => count + (s.match(pattern) || []).length, 0);
  if (uses !== known) throw new Error(`legacy-reader.js：TK 还有 ${uses - known} 处没归类的用法，先确认是不是本机存储`);
  return s;
}

/* 给一个文件换键：file 是 LOCAL_KEY_SITES 的键名。 */
export function renameLocalKeys(source, file, keys = loadLocalKeys()) {
  const sites = LOCAL_KEY_SITES[file];
  if (!sites) throw new Error(`LOCAL_KEY_SITES 里没有 ${file}`);
  let s = source;
  for (const [oldKey, expected] of Object.entries(sites)) {
    const newKey = keys[oldKey];
    if (!newKey) throw new Error(`${file}：LOCAL_KEYS 里没有 ${oldKey}`);
    s = replaceRegex(s, quoted(oldKey), (_, quote) => quote + newKey + quote, `${file}：本机键 ${oldKey}`, expected);
  }
  if (file === 'legacy-reader.js') s = legacyThemeKey(s, keys);
  if (file === 'reader-ui-switch.js') s = replaceExact(s, 'localStorage.dream_ui_v4 =', `localStorage.${keys.dream_ui_v4} =`, 'reader-ui-switch.js：开头注释里的键名');
  const left = findOldLocalKeys(s, keys);
  if (file === 'legacy-reader.js' && left.dream_visual_theme === 1) delete left.dream_visual_theme; /* TK 的定义 */
  if (Object.keys(left).length) throw new Error(`${file} 换键后仍有旧键：${JSON.stringify(left)}`);
  return s;
}
