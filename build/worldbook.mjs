// 世界书（交接 7.E）：上游 worldbook/读者核心本体.txt 的人格与机制部分 → Reader-II 通用世界书 JSON。
//
// 蓝本是旧管线（build.legacy-0726.mjs，第 10 项已删除）的 transformCore() / readerEjsBridge()，按现行上游重新对锚。
// 每处替换都校验命中次数（build/lib.mjs）；区间替换另外核对区间里该有的原文。上游改了这些地方时构建直接报错，并指出是哪一处。
// 和上游相比：
//   · 宿主变量一律经「Reader EJS 桥」读：按语义路由（聊天变量 reader_ii_runtime）读宿主卡自己的变量，没绑定的槽读后备 stat_data.READER；
//     小白X 宿主时，路由的根键改从聊天变量读。
//   · 不让模型直接写 MVU：FP、定调、主题、实体化、章节任务、复活都输出 <READER_*_EVENT>，由主脚本结算。
//   · 不带黑之作家：哀怜人格只有「哀怜的少女」，进度读 READER.进度，少女的祝福每点进度 5%（上游现值，v3.3 是 10%）。
//   · 去掉宿主卡专用的头部宏（fp定义、爆料风格……）、状态强调模块、按层级计价的命定契约（与 v3.3 相同）。
//   · 首行版本标记换成 READER_II_WORLDBOOK：原版读者的世界书更新检查认 DREAM_WORLDBOOK，留着会把这份当成原版去更新。
//   · 上游从「<%_ { _%>\n<%_\nlet _bs_scan」起是书海资料，不带。
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { read, countExact, replaceExact, replaceRange, replaceRegex } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WORLDBOOK_SOURCE = path.resolve(here, '../upstream/reader/worldbook/读者核心本体.txt');
export const ENTRY_NAMES = Object.freeze({
  init: '[initvar]Reader-II初始化',
  rules: '[mvu_update]Reader-II变量更新规则',
  core: '[Reader-II] 通用读者核心',
  list: 'Reader-II变量列表',
});

/* 区间替换：起点唯一，终点取起点之后的第一个；区间里必须含有 mustContain 的每一项（确认换掉的还是预期的那段）。 */
function replaceBetween(source, startToken, endToken, replacement, label, mustContain = []) {
  const start = source.indexOf(startToken);
  const end = start < 0 ? -1 : source.indexOf(endToken, start + startToken.length);
  if (start >= 0 && end >= 0) {
    const region = source.slice(start, end);
    for (const token of mustContain) if (!region.includes(token)) throw new Error(`${label}：区间里找不到「${token}」，上游改过这段，要重新核对`);
  }
  return replaceRange(source, startToken, endToken, replacement, label);
}

function residue(source, label, tokens) {
  for (const token of tokens) if (source.includes(token)) throw new Error(`${label} 变换后仍残留：${token}`);
  return source;
}

/* ---------- Reader EJS 桥：核心条目与变量列表条目共用 ---------- */
export function readerEjsBridge() {
  return String.raw`
let _reader_state = getvar('stat_data.READER', { defaults: {}, clone: true });
if (!_reader_state || typeof _reader_state !== 'object') _reader_state = {};
let _reader_stat_data = getvar('stat_data', { defaults: {}, clone: true });
if (!_reader_stat_data || typeof _reader_stat_data !== 'object') _reader_stat_data = {};
let _reader_kind_raw = getLocalVar('reader_ii_host_kind');
let _reader_lwb = _reader_kind_raw === 'lwb' || (_reader_kind_raw !== 'mvu' && !Object.keys(_reader_stat_data).some(function(_key) { return _key !== 'READER'; }));
let _reader_runtime_raw = getLocalVar('reader_ii_runtime');
if (!_reader_runtime_raw) { try { _reader_runtime_raw = getvar('reader_ii_runtime', { defaults: {} }); } catch (_reader_runtime_get_error) {} }
if (typeof _reader_runtime_raw === 'string') { try { _reader_runtime_raw = JSON.parse(_reader_runtime_raw); } catch (_reader_runtime_parse_error) { _reader_runtime_raw = {}; } }
let _reader_runtime = (_reader_runtime_raw && typeof _reader_runtime_raw === 'object') ? _reader_runtime_raw : {};
let _reader_routing = (_reader_runtime.routing && typeof _reader_runtime.routing === 'object') ? _reader_runtime.routing : {};
let _reader_mappings = (_reader_runtime.semanticMappings && typeof _reader_runtime.semanticMappings === 'object') ? _reader_runtime.semanticMappings : {};
let _reader_get = function(_path, _fallback) {
  let _parts = String(_path || '').split('.').filter(Boolean);
  let _value = _reader_state;
  for (let _index = 0; _index < _parts.length; _index++) {
    if (!_value || typeof _value !== 'object' || !Object.prototype.hasOwnProperty.call(_value, _parts[_index])) return _fallback;
    _value = _value[_parts[_index]];
  }
  return _value === undefined ? _fallback : _value;
};
let _reader_dangerous_segment = function(_segment) { return _segment === '__proto__' || _segment === 'prototype' || _segment === 'constructor'; };
let _reader_decode_ref = function(_ref) {
  if (typeof _ref !== 'string' || _ref.indexOf('hostref:') !== 0) return null;
  let _segments;
  try { _segments = JSON.parse(decodeURIComponent(_ref.slice(8))); } catch (_error) { return null; }
  if (!Array.isArray(_segments) || _segments.length < 2 || _segments[0] !== 'stat_data' || _segments[1] === 'READER') return null;
  for (let _i = 0; _i < _segments.length; _i++) {
    let _segment = _segments[_i];
    if (typeof _segment === 'number') { if (!Number.isInteger(_segment) || _segment < 0) return null; }
    else if (typeof _segment !== 'string' || !_segment || _reader_dangerous_segment(_segment)) return null;
  }
  return _segments;
};
let _reader_read_segments = function(_root, _segments, _fallback) {
  let _value = _root;
  for (let _i = 0; _i < _segments.length; _i++) {
    let _segment = _segments[_i];
    if (!_value || typeof _value !== 'object' || !Object.prototype.hasOwnProperty.call(_value, _segment)) return _fallback;
    _value = _value[_segment];
  }
  return _value === undefined ? _fallback : _value;
};
let _reader_route = function(_slot) {
  let _route = _reader_routing[_slot];
  return (_route && typeof _route === 'object') ? _route : { status: 'unbound', rootRef: '' };
};
let _reader_uses_fallback = function(_slot) { let _status = _reader_route(_slot).status; return _status !== 'active' && _status !== 'broken'; };
let _reader_host_value = function(_slot, _fallback) {
  let _segments = _reader_decode_ref(_reader_route(_slot).rootRef);
  if (!_segments) return _fallback;
  let _root = _reader_stat_data;
  if (_reader_lwb && !/^(?:READER$|reader_|dream_|LWB_)/i.test(String(_segments[1]))) {
    _root = {};
    try { _root[_segments[1]] = getLocalVar(String(_segments[1])); } catch (_reader_lwb_error) {}
  }
  return _reader_read_segments({ stat_data: _root }, _segments, _fallback);
};
let _reader_relative = function(_value, _path, _fallback) {
  if (!Array.isArray(_path) || !_path.length) return _fallback;
  for (let _i = 0; _i < _path.length; _i++) if (_reader_dangerous_segment(_path[_i])) return _fallback;
  return _reader_read_segments(_value, _path, _fallback);
};
let _reader_entries = function(_container, _kind) {
  if (_kind === 'array') return Array.isArray(_container) ? _container.map(function(_value, _index) { return { key: _index, value: _value }; }) : [];
  if (!_container || typeof _container !== 'object' || Array.isArray(_container)) return [];
  return Object.keys(_container).filter(function(_key) { return !_reader_dangerous_segment(_key); }).map(function(_key) { return { key: _key, value: _container[_key] }; });
};
let _reader_name = function(_entry, _mapping) {
  let _raw = _mapping && _mapping.name && _mapping.name.from === 'key' ? _entry.key : _reader_relative(_entry.value, _mapping && _mapping.name && _mapping.name.path, undefined);
  return typeof _raw === 'string' ? _raw.trim() : '';
};
let _reader_favor = function(_raw, _transform) {
  let _value;
  if (_transform && _transform.type === 'enum') {
    if (!_transform.values || !Object.prototype.hasOwnProperty.call(_transform.values, String(_raw))) return null;
    _value = Number(_transform.values[String(_raw)]);
  } else {
    let _number = Number(_raw);
    if (!Number.isFinite(_number)) return null;
    _value = _transform && _transform.type === 'linear' ? _number * Number(_transform.scale) + Number(_transform.offset || 0) : _number;
  }
  return Number.isFinite(_value) && _value >= 0 && _value <= 100 ? _value : null;
};
let _reader_presence = function(_raw) {
  if (_raw === true || _raw === false) return _raw;
  if (_raw === 1 || _raw === 0) return _raw === 1;
  if (typeof _raw !== 'string') return null;
  let _value = _raw.trim().toLowerCase();
  if (['true','yes','on','1','是','在场','当前在场'].indexOf(_value) >= 0) return true;
  if (['false','no','off','0','否','不在场','离场','当前不在场'].indexOf(_value) >= 0) return false;
  return null;
};
let _reader_identity = function(_raw) {
  if (typeof _raw === 'string' && _raw.trim()) return _raw.trim();
  if (!Array.isArray(_raw)) return undefined;
  let _values = _raw.filter(function(_item) { return typeof _item === 'string' && _item.trim(); }).map(function(_item) { return _item.trim(); });
  return _values.length ? _values : undefined;
};
let _reader_container_view = function(_slot) {
  let _mapping = _reader_mappings[_slot];
  let _container = _reader_host_value(_slot, undefined);
  if (!_mapping || !_container || typeof _container !== 'object') return null;
  let _actual_kind = Array.isArray(_container) ? 'array' : 'object';
  if (_mapping.containerKind !== _actual_kind) return null;
  let _output = [];
  _reader_entries(_container, _actual_kind).forEach(function(_entry) {
    if (!_entry.value || typeof _entry.value !== 'object') return;
    let _name_value = _reader_name(_entry, _mapping);
    if (!_name_value) return;
    if (_slot === 'characters') {
      let _favor_spec = _mapping.fields && _mapping.fields.favor;
      let _favor_value = _favor_spec ? _reader_favor(_reader_relative(_entry.value, _favor_spec.path, undefined), _favor_spec.transform) : null;
      if (_favor_value === null) return;
      let _character_value = { name: _name_value, favor: _favor_value };
      let _present_spec = _mapping.fields && _mapping.fields.present;
      let _present_raw = _present_spec ? _reader_relative(_entry.value, _present_spec.path, undefined) : _entry.value['在场'];
      let _present_value = _reader_presence(_present_raw);
      let _identity_spec = _mapping.fields && _mapping.fields.identity;
      let _identity_raw = _identity_spec ? _reader_relative(_entry.value, _identity_spec.path, undefined) : _entry.value['身份'];
      let _identity_value = _reader_identity(_identity_raw);
      if (_present_value !== null) _character_value.present = _present_value;
      if (_identity_value !== undefined) _character_value.identity = _identity_value;
      if (_present_value === true) _character_value.details = _entry.value;
      _output.push(_character_value);
    } else if (_slot === 'statuses') {
      let _effect_spec = _mapping.fields && _mapping.fields.effect;
      let _duration_spec = _mapping.fields && _mapping.fields.duration;
      let _effect_value = _effect_spec ? _reader_relative(_entry.value, _effect_spec.path, undefined) : undefined;
      let _duration_value = _duration_spec ? _reader_relative(_entry.value, _duration_spec.path, undefined) : undefined;
      if (typeof _effect_value !== 'string' || !_effect_value.trim() || typeof _duration_value !== 'string' || !_duration_value.trim()) return;
      let _status_value = { name: _name_value, effect: _effect_value, duration: _duration_value };
      let _source_spec = _mapping.fields && _mapping.fields.source;
      let _source_value = _source_spec ? _reader_relative(_entry.value, _source_spec.path, undefined) : undefined;
      if (typeof _source_value === 'string' && _source_value.trim()) _status_value.source = _source_value;
      _output.push(_status_value);
    } else _output.push(_name_value);
  });
  if (_slot === 'tasks' || _slot === 'skills') {
    let _seen_names = {};
    _output = _output.filter(function(_name_value) { if (_seen_names[_name_value]) return false; _seen_names[_name_value] = true; return true; });
  }
  return _output;
};
let _reader_location_raw = _reader_uses_fallback('location') ? _reader_get('地点', '') : _reader_host_value('location', null);
let _reader_location_parts = [];
let _reader_location_seen_values = Object.create(null);
let _reader_location_seen_objects = [];
let _reader_location_invalid = false;
let _reader_collect_location = function(_value, _depth) {
  if (_reader_location_invalid) return;
  if (typeof _value === 'string') {
    let _text = _value.trim();
    if (_text && !_reader_location_seen_values[_text]) {
      _reader_location_seen_values[_text] = true;
      _reader_location_parts.push(_text);
      if (_reader_location_parts.length > 50 || _reader_location_parts.join(' - ').length > 1000) _reader_location_invalid = true;
    }
    return;
  }
  if (!_value || typeof _value !== 'object') return;
  if (_depth > 12) { _reader_location_invalid = true; return; }
  if (_reader_location_seen_objects.indexOf(_value) >= 0) return;
  _reader_location_seen_objects.push(_value);
  if (Array.isArray(_value)) _value.forEach(function(_item) { _reader_collect_location(_item, _depth + 1); });
  else Object.keys(_value).filter(function(_key) { return ['__proto__', 'prototype', 'constructor'].indexOf(_key) < 0; }).forEach(function(_key) { _reader_collect_location(_value[_key], _depth + 1); });
};
_reader_collect_location(_reader_location_raw, 0);
let _reader_location = _reader_location_invalid ? '' : _reader_location_parts.join(' - ');
let _reader_characters_view = _reader_container_view('characters');
let _reader_relationships = _reader_uses_fallback('characters')
  ? Object.keys(_reader_get('关系列表', {})).map(function(_name) {
      let _item = _reader_get('关系列表', {})[_name];
      let _result = { name: _name };
      let _favor = Number(_item && _item['好感度']);
      if (Number.isFinite(_favor) && _favor >= 0 && _favor <= 100) _result.favor = _favor;
      let _present = _reader_presence(_item && _item['在场']);
      let _identity = _reader_identity(_item && _item['身份']);
      if (_present !== null) _result.present = _present;
      if (_identity !== undefined) _result.identity = _identity;
      if (_present === true) _result.details = _item;
      return _result;
    }).filter(function(_item) { return _item.name; })
  : (_reader_characters_view || []);
let _reader_relationship_prompt_view = _reader_relationships.map(function(_item) {
  if (_item.present === true && _item.details && typeof _item.details === 'object') {
    let _full = { '名称': _item.name };
    Object.keys(_item.details).filter(function(_key) { return !_reader_dangerous_segment(_key); }).forEach(function(_key) { _full[_key] = _item.details[_key]; });
    return _full;
  }
  let _summary = { '名称': _item.name };
  if (_item.identity !== undefined) _summary['身份'] = _item.identity;
  return _summary;
});
let _reader_tasks_view = _reader_container_view('tasks');
let _reader_tasks_available = _reader_route('tasks').status !== 'broken' && (_reader_uses_fallback('tasks') || _reader_tasks_view !== null);
let _reader_task_names = _reader_uses_fallback('tasks') ? Object.keys(_reader_get('任务列表', {})) : (_reader_tasks_view || []);
let _reader_tasks_object = {};
_reader_task_names.forEach(function(_name) { _reader_tasks_object[_name] = _reader_uses_fallback('tasks') ? _reader_get('任务列表', {})[_name] : {}; });
let _reader_skills_view = _reader_container_view('skills');
let _reader_skills_available = _reader_route('skills').status !== 'broken' && (_reader_uses_fallback('skills') || _reader_skills_view !== null);
let _reader_skill_names = _reader_uses_fallback('skills') ? Object.keys(_reader_get('主角.技能', {})) : (_reader_skills_view || []);
let _reader_statuses_view = _reader_container_view('statuses');
let _reader_statuses_available = _reader_route('statuses').status !== 'broken' && (_reader_uses_fallback('statuses') || _reader_statuses_view !== null);
let _reader_statuses = _reader_uses_fallback('statuses')
  ? Object.keys(_reader_get('主角.状态效果', {})).map(function(_name) { let _item = _reader_get('主角.状态效果', {})[_name]; return { name: _name, effect: _item && _item['效果'], duration: _item && _item['剩余时间'], source: _item && _item['来源'] }; }).filter(function(_item) { return typeof _item.effect === 'string' && typeof _item.duration === 'string'; })
  : (_reader_statuses_view || []);
let _reader_effects = {};
_reader_statuses.forEach(function(_status) { _reader_effects[_status.name] = { '效果': _status.effect, '剩余时间': _status.duration, '来源': _status.source || '' }; });
let _reader_fp_mode = _reader_route('currency').status === 'active' ? 'host' : (_reader_route('currency').status === 'broken' ? 'broken' : 'independent');
let _reader_fp_raw = _reader_uses_fallback('currency') ? _reader_get('命运点数', 0) : _reader_host_value('currency', null);
let _reader_fp = typeof _reader_fp_raw === 'number' && Number.isFinite(_reader_fp_raw) ? _reader_fp_raw : 0;
let _reader_tasks_use_fallback = _reader_uses_fallback('tasks');
let _reader_inventory_raw = _reader_uses_fallback('inventory') ? _reader_get('背包', {}) : {};
let _reader_inventory = (_reader_inventory_raw && typeof _reader_inventory_raw === 'object' && !Array.isArray(_reader_inventory_raw)) ? _reader_inventory_raw : {};
`;
}

/* ---------- 核心条目 ---------- */
const REVIVE_EVENT = (persona) => '实际发生此次复活时，回复末尾输出一次<READER_FP_EVENT>{"event_id":"resurrection:<本轮复活摘要>","source":"reader_owned","category":"resurrection","persona":"' + persona + '","evidence":"<本轮实际复活的证据>"}</READER_FP_EVENT>';
const FP_PROTOCOL = String.raw`      结算协议:
        只有本轮实际完成符合条件的事件时，才在回复末尾输出一次<READER_FP_EVENT>{"event_id":"<本轮唯一事件摘要>","source":"narrative","category":"<chapter_D|chapter_C|chapter_B|chapter_A|chapter_S|fate_achievement|emotional_interaction|highlight_moment|adversity>","amount":<固定档位填对应值，区间奖励填裁定值>,"evidence":"<本轮完成证据>"}</READER_FP_EVENT>
        单纯继续叙事、重复回顾或尚未完成的事件不得发放FP
`;
const ADVERSITY = '        逆境克服: 在劣势下设法克服困难，战胜强于自身(指实际强度，而非单纯层级)之敌，视情况获得1000-50000FP\n';
const SYSTEM_CLOSE = "</<%- getvar('系统名') %>>";

/* 截出人格与机制部分（上游第 1 行到关掉第 2 行 `<%_ { _%>` 的那一行），读出上游世界书版本。 */
export function upstreamCore(source = read(WORLDBOOK_SOURCE)) {
  const booksea = '<%_ { _%>\n<%_\nlet _bs_scan = { start: -2 };';
  if (countExact(source, booksea) !== 1) throw new Error('世界书：找不到书海资料的起点（或不止一处），上游改过结构，要重新核对');
  const core = source.slice(0, source.indexOf(booksea));
  if (!core.endsWith('\n_%>\n<%_ } _%>\n')) throw new Error('世界书：人格与机制部分的结尾不是预期的 `<%_ } _%>`');
  const mark = /^<%_ \/\* DREAM_WORLDBOOK reader-core v([0-9][0-9A-Za-z_.-]*) \*\/ _%>\n/.exec(core);
  if (!mark) throw new Error('世界书：首行版本标记不是预期的写法');
  return { core, upstreamVersion: mark[1], lines: core.split('\n').length - 1 };
}

export function transformCore(source, { version = 'dev', upstreamVersion = '?' } = {}) {
  source = replaceRegex(source, /^<%_ \/\* DREAM_WORLDBOOK reader-core v[^\n]*\n/, `<%_ /* READER_II_WORLDBOOK core v${version} · 上游 reader-core v${upstreamVersion} */ _%>\n`, '版本标记');

  /* 头部宏：原版给宿主卡的其他条目用（{{getvar::fp定义}} 之类），通用版没有那些条目。 */
  source = replaceRegex(source, /^\s*setLocalVar\('系统核心名',[^\n]*\);\n/gm, '', '移除系统核心名局部变量', 2);
  source = replaceRegex(source, /^\s*setLocalVar\('系统核心',[^\n]*\);\n/gm, '', '移除系统核心局部变量', 2);
  source = replaceRegex(source, /^\s*setLocalVar\('fp定义',[^\n]*\);\n/gm, '', '移除FP定义局部变量', 6);
  source = replaceRegex(source, /^\s*setLocalVar\('爆料风格',[^\n]*\);\n/gm, '', '移除爆料风格局部变量', 6);
  source = replaceRegex(source, /^\s*setLocalVar\('技能获取系统优势',[\s\S]*?\);\n/gm, '', '移除技能获取局部变量', 6);
  source = replaceExact(source, "setLocalVar('生命层级成长系统优势', '');\n", '', '移除生命层级空变量');
  source = replaceExact(source, "setLocalVar('经验值获取系统优势', '');\n", '', '移除经验值空变量');
  source = replaceRegex(source, /^\s*setLocalVar\('登神长阶系统优势',[\s\S]*?\);\n/gm, '', '移除特定成长体系局部变量', 6);

  source = replaceExact(source, 'let _custom_condition_output = [];', `let _custom_condition_output = [];\n${readerEjsBridge()}`, 'Reader EJS桥接');

  /* 自定义人格的条件机制由主脚本求值（reader-runtime-store.js 写聊天变量 reader_ii_active_prompts），这里只读结果。 */
  source = replaceBetween(
    source,
    '  let _custom_condition_rules = Array.isArray(_custom_persona.conditionalMechanisms) ? _custom_persona.conditionalMechanisms : [];',
    '// Selection is recomputed from the selected MVU snapshot; only raw text is cached.',
    String.raw`  let _custom_condition_prompt_raw = getLocalVar('reader_ii_active_prompts');
  try {
    _custom_condition_output = Array.isArray(_custom_condition_prompt_raw)
      ? _custom_condition_prompt_raw
      : JSON.parse(String(_custom_condition_prompt_raw || '[]'));
  } catch (_custom_condition_prompt_error) {
    _custom_condition_output = [];
  }
  if (!Array.isArray(_custom_condition_output)) _custom_condition_output = [];
}
`,
    '自定义条件改读主脚本的求值结果',
    ["setLocalVar('dream_custom_condition_state'", 'setMessageVar(', '_custom_condition_output.push(_custom_rule_prompt);'],
  );

  /* 哀怜人格：去掉黑之作家的挑选（关系列表的好感、生命值、精神崩溃）与 dream_black_author_prompt 缓存，只留哀怜的少女。 */
  source = replaceBetween(
    source,
    '// Selection is recomputed from the selected MVU snapshot; only raw text is cached.',
    "} else if (_persona_mode === 'shoujo') {",
    String.raw`let _dream_progress = 0;
let _dream_seed = 9;
if (_persona_mode === 'kuromaku') {
  _dream_seed = Number(getLocalVar('dream_seed'));
  if (!Number.isInteger(_dream_seed) || _dream_seed < 1 || _dream_seed > 9) {
    _dream_seed = Math.floor(Math.random() * 9) + 1;
    setLocalVar('dream_seed', _dream_seed);
  }
  let _dream_progress_value = Number(_reader_get('进度', 0));
  _dream_progress = Number.isFinite(_dream_progress_value) && _dream_progress_value > 0 ? Math.floor(_dream_progress_value) : 0;
  setLocalVar('系统名', '哀怜的少女');
  setLocalVar('复活机制', '<复活机制>\n核心: 夜梦给予<user>的祝福，可让<user>死亡后一段时间内于不明次元·某' + _dream_theme_place + '复活，每次实际复活获得200fp奖励；` + REVIVE_EVENT('kuromaku') + String.raw`；死亡不能终止叙事，禁止在战斗中改变设定、创造有利条件或机械降神。\n</复活机制>');
`,
    '哀怜人格只留哀怜的少女',
    ['dream_black_author_prompt', "'哀怜的少女'", '每次实际复活获得200fp奖励；死亡不能终止叙事', '"path": "/事件/进度"'],
  );

  source = replaceExact(source, '虚海中的不明存在', '世界外的不明存在', '存在定义', 6);
  source = replaceExact(source, '每次复活可获得200fp奖励，因此<user>死亡并不能终止叙事', '每次复活可获得200fp奖励；' + REVIVE_EVENT('${_persona_mode}') + '；因此<user>死亡并不能终止叙事', '其他人格复活事件', 4);
  source = replaceExact(source, '每次复活获得200fp；死亡不能终止叙事', '每次复活获得200fp；' + REVIVE_EVENT('custom') + '；死亡不能终止叙事', '自定义人格复活事件');

  /* 地点：主题地点（海滨咖啡馆 / 茶楼）的判断照上游，只是地点改读语义层。 */
  source = replaceExact(source, "  let _loc = getMessageVar('stat_data.世界.地点') || '';", '  let _loc = _reader_location;', '唤醒地点');
  source = replaceExact(source, '<%_ if (!_dream_profile_missing && (!_silent_mode || _force_awaken)) { _%>', '<%_ if (!_silent_mode || _force_awaken) { _%>', '主块不再等黑之作家资料');
  source = replaceExact(
    source,
    "<% if (_persona_mode === 'kuromaku') { %>\n<% if (_dream_black_profile) { %>\n<%- _dream_profile_text('definition') %>\n<% } else { %>\n哀怜的少女:\n",
    "<% if (_persona_mode === 'kuromaku') { %>\n哀怜的少女:\n",
    '哀怜定义去掉黑之作家分支（开头）',
  );
  source = replaceExact(
    source,
    "<% } %>\n<% } else if (_persona_mode === 'shoujo') { %>\n心爱的少女:\n",
    "<% } else if (_persona_mode === 'shoujo') { %>\n心爱的少女:\n",
    '哀怜定义去掉黑之作家分支（结尾）',
  );
  source = replaceExact(source, "let _cafe_loc = getMessageVar('stat_data.世界.地点') || '';", 'let _cafe_loc = _reader_location;', '咖啡馆地点');

  /* 章节任务：任务槽坏了时不生成；「章节起始」挪到判断之后，带上本轮有没有生成指令。 */
  const chapter = /^     【章节起始】: [^\n]*\n/m.exec(source);
  source = replaceRegex(source, /^     【章节起始】: [^\n]*\n/m, '', '移除静态章节起始提示');
  const chapterLine = replaceExact(chapter[0], '以在次轮（非本轮，无[章节生成指令]时禁用章节任务,有则强制生成）', "（无[章节生成指令]时禁用章节任务,有则强制生成。当前:<%- _ch_shouldGen ? '有' : '无' %>）", '章节起始提示改写');
  source = replaceExact(source, "let _ch_taskList = getMessageVar('stat_data.任务列表') || {};", 'let _ch_taskList = _reader_tasks_object;', 'Reader任务列表');
  source = replaceExact(
    source,
    "}\n_%>\n<%_ if (_ch_shouldGen && _ch_type === 'epic') { _%>",
    "}\nif (!_reader_tasks_available) { _ch_shouldGen = false; _ch_type = ''; }\n_%>\n" + chapterLine + "<%_ if (_ch_shouldGen && _ch_type === 'epic') { _%>",
    '任务槽坏了时停用章节任务',
  );
  source = replaceExact(source, '<%_ } else if (_ch_hasAny && !_ch_shouldGen) { _%>', '<%_ } else if (_reader_tasks_available && _ch_hasAny && !_ch_shouldGen) { _%>', '任务槽坏了时不误报已存在');

  /* 初始技能：技能与状态都认；文本取上游新语义（故事的主人只免疫夺走行动权的效果），去掉宿主卡专用的品质 / 消耗 / 标签。 */
  source = replaceExact(
    source,
    "let _skill_hasMain = getMessageVar('stat_data.主角.技能.故事的主人');",
    String.raw`let _skill_hasInterlude = _reader_skill_names.indexOf('间章:小憩') >= 0;
let _skill_hasMain = _reader_skill_names.indexOf('故事的主人') >= 0
  || _reader_statuses.some(function(_status) { return _status && _status.name === '故事的主人'; });`,
    '初始技能与状态检查',
  );
  source = replaceBetween(
    source,
    '<% if (_skill_hasMain == null) { %>',
    "<%_ if (matchChatMessages(/膝枕|躺.*腿|枕.*腿|靠.*腿/, { start: -1, role: 'user' })) { _%>",
    String.raw`<% if (_ch_shouldGen && _reader_tasks_use_fallback) { %>
本轮生成章节任务后，回复末尾输出一次：
<READER_TASK_EVENT>{"action":"create","task_id":"<任务名>","type":"<史诗之章|成长之章|前进之章>","title":"<任务名>","issuer":"九十九夜梦","goal":"<任务目标>","reward_fp":<1500~50000内裁定并锁定>,"treasure":"<原版宝具奖励说明>"}</READER_TASK_EVENT>
<% } else if (_ch_shouldGen) { %>
按当前任务系统的既有格式创建上述章节任务，并通过其既有变量更新规则写入对应任务。
<% } %>
<%_
let _reader_task_entries = _reader_tasks_use_fallback ? Object.entries(_reader_get('任务列表', {})).filter(function(_entry) {
  let _task = _entry[1];
  return _task && typeof _task === 'object' && _task['状态'] === '进行中';
}) : [];
_%>
<%_ if (_reader_task_entries.length > 0) { _%>
【Reader章节任务检查】
以下任务仍在进行中。只有本轮剧情已经实际满足某项任务目标时，才结算该任务；尚在推进、仅有意图或只完成一部分时禁止结算。
<%_ for (let _task_index = 0; _task_index < _reader_task_entries.length; _task_index++) { let _task_entry = _reader_task_entries[_task_index]; let _task_id = _task_entry[0]; let _task_data = _task_entry[1]; _%>
- ID: <%- _task_id %>
  详情: <%- _task_data['详情'] || '' %>
  目标: <%- _task_data['目标'] || '' %>
  完成奖励: <%- _task_data['奖励'] || '按任务创建时的说明结算' %>
  若本轮实际完成，正文中兑现奖励，并在回复末尾输出一次：
  <READER_TASK_EVENT>{"action":"complete","task_id":"<%- _task_id %>"}</READER_TASK_EVENT>
<%_ } _%>
<%_ } _%>
<%_ if (_reader_skills_available && !_skill_hasInterlude) { _%>
本轮必须为<user>添加间章:小憩技能： 名称: 间章:小憩 效果: 叙事抽离: 无论身处何地（包括虚海/绝境），无视空间封锁，将使用者转移至只有读者一人的[不明次元·某<%- _dream_theme_place %>]。 战斗限制: 若战斗中使用，发动后需至[下下回合开始时]方可生效传送，但除非死亡否则不会被打断 描述: 累了吗？那先停笔休息一下吧。
<%_ } _%>
<%_ if ((_reader_skills_available || _reader_statuses_available) && !_skill_hasMain) { _%>
本轮必须为<user>添加故事的主人被动技能/永久状态：名称: 故事的主人 效果: 永久免疫[支配]、[心灵控制]、[意志剥夺]等夺走行动权、可能导致"主角失格"的精神干涉，无视来源实力差距，不可被驱散、压制或无效化；[恐惧]、[魅惑]等照常检定，生效时只施加数值减益，不替<user>决定言行 描述: 读者的加护，作为既是执笔者兼故事的主角，主人公的意志应是自由的。
<%_ } _%>
`,
    'Reader任务事件与初始技能',
    ['开局为<user>添加间章:小憩技能', '开局为<user>添加故事的主人被动技能', '夺走行动权', '[恐惧]、[魅惑]等照常检定', '<%- _dream_theme_place %>'],
  );

  /* 定调：地点与已有定调改读语义层；写入改为事件，由主脚本扣 1000 FP 并加状态。 */
  source = replaceExact(source, "    let _ts_location = getMessageVar('stat_data.世界.地点') || '';", '    let _ts_location = _reader_location;', '定调地点');
  source = replaceExact(
    source,
    "let _ts_toneVar = getMessageVar('stat_data.主角.状态效果.定调');\n    let _ts_hasTone = (_ts_toneVar !== undefined && _ts_toneVar !== null);",
    "let _ts_hasTone = Object.keys(_reader_effects).some(function(_key) { return _key.indexOf('定调') !== -1; });",
    '定调状态',
  );
  source = replaceRegex(source, /\{ "op": "insert", "path": "\/主角\/状态效果\/定调",[^\n]*\}/g, '<READER_ACTION_EVENT>{"event_id":"tone:<作品名>","action":"tone_apply","title":"<作品名>"}</READER_ACTION_EVENT>', '定调写入', 2);
  source = replaceExact(source, 'FP扣除：{ "op": "delta", "path": "/命运点数", "value": -1000 }\n', '', '定调扣款');

  /* 主题写入：9999 FP（上游现值）；状态与余额读语义层；写入改为事件。通用版的定调状态用《作品名》。 */
  source = replaceExact(source, "    let _tw_seObj = getMessageVar('stat_data.主角.状态效果') || {};", '    let _tw_seObj = _reader_effects;', '主题写入读状态');
  source = replaceExact(source, "    let _tw_fp = getMessageVar('stat_data.命运点数') || 0;", '    let _tw_fp = _reader_fp;', '主题写入读余额');
  source = replaceExact(source, 'let _tw_workMatch = _tw_toneEffect.match(/「(.+?)」/);', 'let _tw_workMatch = _tw_toneEffect.match(/[「《](.+?)[」》]/);', '主题写入认《》');
  source = replaceBetween(
    source,
    '4. 在<UpdateVariable>中执行以下操作：\n',
    '<%_\n    } else if (_tw_hasTheme) {',
    String.raw`4. 回复末尾输出一次下面的事件（扣除9999 FP、添加主题状态都由 Reader 结算，不要另写变量更新）：
<READER_ACTION_EVENT>{"event_id":"theme:<%- _tw_workName %>","action":"theme_write","title":"<%- _tw_workName %>","description":"<该主题对世界的影响、规则、大势或极少情况下会出现的地点>"}</READER_ACTION_EVENT>
`,
    '主题写入事件',
    ['"path": "/命运点数", "value": -9999', '"path": "/主角/状态效果/主题:'],
  );

  /* 状态强调模块与按层级计价的命定契约：v3.3 起通用版就不带。 */
  source = replaceBetween(source, "<%_\nlet _seObj = getMessageVar('stat_data.主角.状态效果') || {};", '      2. 【命定契约】:', '', '移除状态强调模块', ['【状态检查', '等同虚海规则', '等同<虚海规则>']);
  source = replaceBetween(source, '      2. 【命定契约】:', '      隐蔽原则:', '', '移除命定契约', ['缔结契约', '七层级']);

  /* FP：显示当前值；只有独立 FP（没绑定宿主货币）时才给获取规则与结算协议。主块与静默分支各一处。 */
  source = replaceExact(source, '      获取规则:', "      当前FP: <%- _reader_fp %>\n<%_ if (_reader_fp_mode === 'independent') { _%>\n      获取规则:", 'FP模式分流', 2);
  source = replaceExact(source, '        D级任务: +50', '        D级: +50', '篇章等级', 2);
  source = replaceExact(
    source,
    '命运成就: +5000~50000 (成为领主/探索古城/击败传奇生物/拯救城市/颠覆阴谋/逆转战争等)',
    '命运成就: +5000~50000 (成为伟人/探索未知/击败传奇生物/拯救城市/颠覆阴谋/逆转战争等)',
    '命运成就示例',
    2,
  );
  source = replaceExact(source, ADVERSITY + '<%_', ADVERSITY + FP_PROTOCOL + '<%_ } _%>\n<%_', '剧情FP事件协议');
  source = replaceExact(source, ADVERSITY + SYSTEM_CLOSE, ADVERSITY + FP_PROTOCOL + '<%_ } _%>\n' + SYSTEM_CLOSE, '静默分支FP事件协议');
  source = replaceExact(
    source,
    '绝不主动发言或进行任何干涉。当用户满足FP获取规则时，也需保持静默，但在<UpdateVariable>中静默操作增加FP:',
    "绝不主动发言或进行任何干涉。<% if (_reader_fp_mode === 'independent') { %>当用户满足FP获取规则时，也需保持静默，只在回复末尾静默输出一次FP结算事件:<% } %>",
    '静默分支不写变量',
  );

  /* 功能：只留与宿主世界无关的几项；实体化走事件。 */
  source = replaceBetween(
    source,
    '      功能(以下功能不进行任何检定):',
    '      规则:',
    String.raw`      功能(以下功能不进行任何检定):
         记录本: 将持有物以设定集形式储存，无限容量，外人无法察觉
         剧情感知: 为<user>观察并提供目标或地区详细情报，可用于搜寻伙伴
         实体化: 消耗FP使"九十九夜梦"临时实体化24小时(100FP)，具体能力遵守宿主世界规则，可随时提前消失
         实体化结算协议: 仅当<user>本轮明确要求实体化、当前FP不少于100且当前没有“实体化”效果时，才执行实体化并在回复末尾输出<READER_ACTION_EVENT>{"event_id":"entity_manifest:<本轮摘要>","action":"entity_manifest"}</READER_ACTION_EVENT>；FP不足或已经实体化时不得输出事件
`,
    '世界观专用功能',
    ['实体化:', '命运抽卡', '新闻资讯'],
  );

  /* 黑之作家的 persona 分支、主块尾部、静默分支与「本轮机制」块。复活机制在主块尾部输出（上游靠宿主卡的其他条目输出）。 */
  source = replaceBetween(
    source,
    "<% if (_persona_mode === 'kuromaku' && _dream_black_profile) { %>\n",
    '哀怜的少女:\n  核心概念:',
    "<% if (_persona_mode === 'kuromaku') { %>\n",
    '哀怜 persona 去掉黑之作家分支',
    ["_dream_profile_text('persona')", "<% } else if (_persona_mode === 'kuromaku') { %>"],
  );
  source = replaceExact(
    source,
    SYSTEM_CLOSE + '\n<%_ } else if (!_dream_profile_missing) { _%>',
    "<%- getvar('复活机制') %>\n" + SYSTEM_CLOSE + '\n<%_ } else { _%>',
    '复活机制输出与静默分支',
  );
  source = replaceBetween(
    source,
    '<%_ if (_dream_black_profile) { _%>\n<读者本轮机制>\n',
    "<%_\nif (_persona_mode === 'kuromaku' && _dream_progress >= 1) {",
    '',
    '移除黑之作家本轮机制',
    ["_dream_profile_text('curse')", '[读者资料未就绪]'],
  );
  /* 少女的祝福：上游直接 setMessageVar，通用版改为提示，按当前状态规则维护；已经是同样的效果时不再提示。 */
  source = replaceBetween(
    source,
    "if (_persona_mode === 'kuromaku' && _dream_progress >= 1) {\n",
    '\n_%>',
    String.raw`if (_persona_mode === 'kuromaku' && _dream_progress >= 1 && _reader_statuses_available) {
  let _dream_bless_bonus = Math.min(_dream_progress, _dream_seed) * 5;
  let _dream_bless_effect = '造成的最终伤害+' + _dream_bless_bonus + '%，受到的全类型伤害-' + _dream_bless_bonus + '%，经验获取+' + _dream_bless_bonus + '%';
  let _dream_bless_now = _reader_effects['祝福'];
  if (!_dream_bless_now || _dream_bless_now['效果'] !== _dream_bless_effect) {
_%>
【少女的祝福状态维护】通过当前生效的变量更新规则确保存在名为“祝福”的状态：效果为“<%- _dream_bless_effect %>”，持续时间为“永久”，来源为“少女的祝福”。已有同名状态时按当前规则更新。
<%_
  }
}`,
    '少女祝福改为状态提示',
    ['Math.min(_dream_progress, _dream_seed) * 5', "setMessageVar('stat_data.主角.状态效果.祝福'"],
  );

  return residue(source, '读者核心', [
    'getMessageVar(', 'setMessageVar(', 'dream_black_author_prompt', '_dream_black', '_dream_profile', 'DREAM_WORLDBOOK',
    '"op":', '<UpdateVariable>', '99999', '{{getvar::系统名}}', '虚海中的不明存在', '虚海规则', '_bs_', '书海',
  ]);
}

/* ---------- 其余三个条目 ---------- */
export const READER_INIT_VARIABLES = String.raw`READER:
  地点: ''
  关系列表: {}
  任务列表: {}
  主角:
    技能: {}
    状态效果: {}
  命运点数: 0`;

export const READER_UPDATE_RULES = String.raw`<%_
let _reader_rules_raw = getLocalVar('reader_ii_runtime');
if (!_reader_rules_raw) { try { _reader_rules_raw = getvar('reader_ii_runtime', { defaults: {} }); } catch (_reader_rules_get_error) {} }
if (typeof _reader_rules_raw === 'string') { try { _reader_rules_raw = JSON.parse(_reader_rules_raw); } catch (_reader_rules_parse_error) { _reader_rules_raw = {}; } }
let _reader_rules_routing = (_reader_rules_raw && _reader_rules_raw.routing && typeof _reader_rules_raw.routing === 'object') ? _reader_rules_raw.routing : {};
let _reader_rules_fallback = function(_slot) { let _route = _reader_rules_routing[_slot]; return !_route || _route.status === 'unbound' || _route.status === 'draft'; };
let _reader_rules_bag = getvar('stat_data.READER.背包', { defaults: {} });
let _reader_rules_has_bag = _reader_rules_fallback('inventory') && !!_reader_rules_bag && typeof _reader_rules_bag === 'object' && !Array.isArray(_reader_rules_bag) && Object.keys(_reader_rules_bag).length > 0;
let _reader_rules_any = ['location','characters','skills','statuses'].some(_reader_rules_fallback) || _reader_rules_has_bag;
_%><%_ if (_reader_rules_any) { _%>
# Reader-II 当前生效的后备 MVU 更新规则

针对下列本轮显示的 Reader 后备变量，按照 type / format / check 更新。仅使用本轮已有叙事证据生成叶节点级最小 JSONPatch 变更。

<%_ if (_reader_rules_fallback('location')) { _%>
## /READER/地点
type: string
format: <大范围>-<区域>-<势力或聚落>-<详细位置>
check:
  - 主角实际移动后更新
  - 按现有信息从大到小排列地点层级，未知层级省略
  - 进入 Reader 咖啡馆时使用“不明次元·某咖啡馆”
<%_ } _%>
<%_ if (_reader_rules_fallback('characters')) { _%>
## /READER/关系列表
type: |-
  {
    [角色名: string]: {
      在场?: boolean;
      身份?: string[];
      状态效果?: {
        [状态名: string]: {
          类型: '增益' | '减益' | '特殊';
          效果: string;
          层数: number;
          剩余时间: string;
          来源: string;
        }
      };
      背包?: {
        [物品名: string]: {
          数量: number;
          标签: string[];
          效果: string | { [效果名: string]: string };
          描述: string;
        }
      };
      装备?: {
        [装备名: string]: {
          标签: string[];
          效果: string | { [效果名: string]: string };
          描述: string;
          位置: string;
        }
      };
      技能?: {
        [技能名: string]: {
          消耗: string;
          标签: string[];
          效果: string | { [效果名: string]: string };
          描述: string;
        }
      };
      性格?: string;
      外貌?: string;
      着装?: string;
      好感度?: number;
      心里话?: string;
      背景故事?: string;
    }
  }
check:
  - 记录已经出场且值得持续追踪的角色，角色名保持唯一、完整、稳定
  - 各字段随剧情中的实际变化更新；没有叙事依据的可选字段保持原值
  - 好感度范围为0～100，变化需有明确互动依据
<%_ } _%>
<%_ if (_reader_rules_fallback('skills')) { _%>
## /READER/主角/技能
type: |-
  {
    [技能名: string]: {
      消耗: string;
      标签: string[];
      效果: string | { [效果名: string]: string };
      描述: string;
    }
  }
check:
  - 主角实际获得、失去或改变技能时更新
  - 技能失去时移除对应技能条目
<%_ } _%>
<%_ if (_reader_rules_fallback('statuses')) { _%>
## /READER/主角/状态效果
type: |-
  {
    [状态名: string]: {
      类型: '增益' | '减益' | '特殊';
      效果: string;
      层数: number;
      剩余时间: string;
      来源: string;
    }
  }
check:
  - 主角获得、消除或改变状态时更新
  - 剩余时间随叙事时间推进；进入或脱离战斗时在回合数与实际时间之间换算
  - 剩余时间归零或效果完成触发后移除整个状态条目
  - 层数变化需有明确原因
  - 解除定调时按状态效果中的绑定说明同步删除主题
<%_ } _%>
<%_ if (_reader_rules_has_bag) { _%>
## /READER/背包
type: |-
  {
    [物品名: string]: {
      数量: number;
      品质?: string;
      类型?: string;
      标签?: string[];
      效果?: string | { [效果名: string]: string };
      描述?: string;
    }
  }
check:
  - 这是主角的后备背包（命运抽卡入包的书页与物品也在这里），只记主角实际持有的东西
  - 物品被使用、消耗、交出或丢失时减少数量；数量归零时移除整个条目
  - 获得新物品时按上面的结构添加；已有同名物品时增加数量
  - 书页与物品按其效果中的说明使用，没有实际用掉就不改；没有变化的条目不改写品质、标签、效果与描述
<%_ } _%>

仅在确有变化时输出合法的 <UpdateVariable><Analysis>…</Analysis><JSONPatch>[…]</JSONPatch></UpdateVariable>。
<%_ } _%>`;

export function readerVariableList() {
  return String.raw`<%_ {
${readerEjsBridge()}
let _reader_current_variable = {};
if (_reader_uses_fallback('location')) _reader_current_variable['当前地点'] = _reader_location;
if (_reader_uses_fallback('characters')) _reader_current_variable['重要角色'] = _reader_relationship_prompt_view;
if (_reader_uses_fallback('tasks')) _reader_current_variable['任务'] = _reader_get('任务列表', {});
if (_reader_uses_fallback('skills')) _reader_current_variable['用户技能'] = _reader_get('主角.技能', {});
if (_reader_uses_fallback('statuses')) _reader_current_variable['用户状态'] = _reader_get('主角.状态效果', {});
if (_reader_uses_fallback('currency')) _reader_current_variable['当前FP'] = _reader_fp;
if (Object.keys(_reader_inventory).length > 0) _reader_current_variable['用户背包'] = _reader_inventory;
_%>
<reader_current_variable>
<%- JSON.stringify(_reader_current_variable, null, 2) %>
</reader_current_variable>
<%_ } _%>`;
}

/* 条目字段同 v3.3 的「世界书-Reader-II核心.json」（酒馆世界书导出格式；那份文件已删，字段清单留在 tests/worldbook.test.mjs）。 */
export function worldbookEntry(uid, comment, content, options = {}) {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment,
    content,
    constant: options.constant !== false,
    vectorized: false,
    selective: false,
    selectiveLogic: 0,
    addMemo: true,
    order: options.order ?? 100,
    position: options.position ?? 4,
    disable: options.disable === true,
    excludeRecursion: true,
    preventRecursion: true,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: options.depth ?? 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: false,
    automationId: '',
    role: null,
    sticky: null,
    cooldown: null,
    delay: null,
  };
}

/* ---------- EJS：构建时查语法，测试里也用它渲染。规则同 ejs 3.1 ---------- */
// <%_ 吃掉同一行前面的空格与制表符；_%> 与 -%> 吃掉后面的空格、制表符和一个换行；<%- 原样输出，<%= 转义输出（都去掉尾部分号）；<%# 注释。
export function ejsSource(template) {
  const text = template.replace(/[ \t]*<%_/g, '<%_').replace(/_%>[ \t]*/g, '_%>');
  const tag = /<%([_\-=#]?)([\s\S]*?)([_\-]?)%>/g;
  let code = 'with (locals) {\nvar __o = [];\n';
  let last = 0;
  let trim = false;
  const literal = (chunk) => {
    if (trim) chunk = chunk.replace(/^\r?\n/, '');
    trim = false;
    if (chunk) code += `__o.push(${JSON.stringify(chunk)});\n`;
  };
  for (const match of text.matchAll(tag)) {
    literal(text.slice(last, match.index));
    const [, open, body, close] = match;
    if (open === '-') code += `__o.push(${body.replace(/;\s*$/, '')});\n`;
    else if (open === '=') code += `__o.push(__esc(${body.replace(/;\s*$/, '')}));\n`;
    else if (open !== '#') code += `${body}\n`;
    trim = close === '_' || close === '-';
    last = match.index + match[0].length;
  }
  literal(text.slice(last));
  return code + "return __o.join('');\n}";
}

export function assertEjs(template, label) {
  try { new vm.Script(`(async function (locals, __esc) {\n${ejsSource(template)}\n})`, { filename: label }); }
  catch (error) { throw new Error(`${label} 的 EJS 编译不过：${error.message}`); }
  return template;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
export function renderEjs(template, locals) {
  const run = new Function('locals', '__esc', `return (async function () {\n${ejsSource(template)}\n})();`);
  return run(locals, (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]));
}

/* ---------- 组装 ---------- */
export function buildWorldbook({ version = 'dev', source = read(WORLDBOOK_SOURCE) } = {}) {
  const upstream = upstreamCore(source);
  const core = transformCore(upstream.core, { version, upstreamVersion: upstream.upstreamVersion });
  const entries = [
    worldbookEntry(0, ENTRY_NAMES.init, READER_INIT_VARIABLES, { constant: false, disable: true }),
    worldbookEntry(1, ENTRY_NAMES.rules, READER_UPDATE_RULES),
    worldbookEntry(2, ENTRY_NAMES.core, core, { position: 0 }),
    worldbookEntry(3, ENTRY_NAMES.list, readerVariableList(), { depth: 1, order: 200 }),
  ];
  for (const entry of entries.slice(1)) assertEjs(entry.content, `世界书条目 ${entry.comment}`);
  return {
    upstreamVersion: upstream.upstreamVersion,
    upstreamLines: upstream.lines,
    json: { entries: Object.fromEntries(entries.map((entry) => [entry.uid, entry])) },
  };
}
