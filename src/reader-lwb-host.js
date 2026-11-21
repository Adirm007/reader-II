(function (root) {
  'use strict';

  /*
   * 小白X（LittleWhiteBox）作为第三种变量宿主（另两种：酒馆助手 + MVU；没有 MVU 的纯文字卡）。
   *   读：酒馆的聊天局部变量 chat_metadata.variables（按小白X 的存储方式解码 JSON 字符串对象/数组）。
   *   写：变量 3.0 走 LWB_StateV3.apply(ops)；变量 2.0 优先走 LWB_StateV2.apply({ ops })，
   *       旧版本或无 apply 接口时回退到 LWB_StateV2.applyText('<state>…</state>')（负数写作 (-n) 避免被当成相对减量）。
   * Reader 自己的 READER 命名空间不放这里，仍在 MVU 楼层变量里（与纯文字卡相同），宿主切换时不用搬家。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  /* 聊天变量里属于 Reader 自己（reader_ii_runtime、dream_persona…）或小白X 元数据的键，不算宿主变量。 */
  var OWN_KEYS = /^(?:READER$|reader_|dream_|LWB_|lwb-state3$)/i;
  var RESERVED_KEYS = ['__proto__', 'prototype', 'constructor'];

  function isObject(value) {
    return modules.isObject ? modules.isObject(value) : !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  /* 小白X 2.0/3.0 把对象和数组以 JSON 字符串存在 chat_metadata.variables 里；兼容已解码的对象和普通字符串。 */
  function decodeStoredVariable(value) {
    if (typeof value !== 'string') return clone(value);
    var trimmed = value.trim();
    if (!trimmed) return value;
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try { return JSON.parse(trimmed); } catch (error) { return value; }
    }
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
      var num = Number(trimmed);
      if (Number.isFinite(num)) return num;
    }
    return value;
  }

  function formatV2Path(segments) {
    return segments.map(function (part, index) {
      var text = String(part);
      if (/^[^.[\]"'\\*\s]+$/.test(text) && !/^\d+$/.test(text)) return (index ? '.' : '') + text;
      return '[' + JSON.stringify(text) + ']';
    }).join('');
  }

  function same(left, right) {
    if (left === undefined || right === undefined) return left === right;
    var stringify = modules.stableStringify || JSON.stringify;
    return stringify(left) === stringify(right);
  }

  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  /* 能直接写进 <state> 点路径的键：不是纯数字，不含分隔符、引号、YAML 特殊字符，也不以指令符号开头。 */
  function safeSegment(segment) {
    var text = String(segment);
    if (!text || /^\d+$/.test(text) || RESERVED_KEYS.indexOf(text) >= 0) return false;
    if (/[\s.:\[\]{}"'#,\\]/.test(text)) return false;
    return !/^[-?!&*|>%@`$~=<+]/.test(text);
  }

  function valueAt(tree, path) {
    var cursor = tree;
    for (var index = 0; index < path.length; index += 1) {
      if (!cursor || typeof cursor !== 'object' || !has(cursor, path[index])) return undefined;
      cursor = cursor[path[index]];
    }
    return cursor;
  }

  /* 两棵变量树的差异 → [{ path, value, removed? }]。数组整体写；对象里有键被删时整体写这个对象。 */
  function diff(before, after) {
    var out = [];
    walk(isObject(before) ? clone(before) : {}, isObject(after) ? clone(after) : {}, [], out);
    return out;
  }

  function walk(before, after, path, out) {
    var removed = Object.keys(before).filter(function (key) { return !has(after, key); });
    if (removed.length && path.length) {
      out.push({ path: path, value: clone(after) });
      return;
    }
    removed.forEach(function (key) { out.push({ path: [key], value: null, removed: true }); });
    Object.keys(after).forEach(function (key) {
      var left = before[key];
      var right = after[key];
      if (same(left, right)) return;
      if (isObject(left) && isObject(right)) walk(left, right, path.concat(key), out);
      else out.push({ path: path.concat(key), value: clone(right) });
    });
  }

  /* 路径里有写不进 <state> 的键时，退到最深的可写祖先整体写；祖先已整体写过的子路径去掉。 */
  function expressible(changes, after) {
    var output = changes.map(function (change) {
      var depth = 0;
      while (depth < change.path.length && safeSegment(change.path[depth])) depth += 1;
      if (depth === 0) throw new Error('小白X 变量名「' + change.path[0] + '」含有写不进 <state> 的字符，Reader 不能改它');
      if (depth === change.path.length) return change;
      var path = change.path.slice(0, depth);
      var value = valueAt(after, path);
      return value === undefined ? { path: path, value: null, removed: true } : { path: path, value: clone(value) };
    });
    return output.filter(function (change, index) {
      return !output.some(function (other, otherIndex) {
        if (otherIndex === index || other.path.length > change.path.length) return false;
        var prefix = other.path.every(function (segment, position) { return change.path[position] === segment; });
        return prefix && (other.path.length < change.path.length || otherIndex < index);
      });
    });
  }

  function formatStateValue(value) {
    if (value === undefined || value === null) return 'null';
    // 小白X <state> 解析器把裸负号数字（-5）当成相对减量，绝对负数必须加括号 (-5)。
    if (typeof value === 'number' && value < 0) return '(' + JSON.stringify(value) + ')';
    return JSON.stringify(value);
  }

  function stateText(changes) {
    return '<state>\n' + changes.map(function (change) {
      return change.path.join('.') + ': ' + formatStateValue(change.value);
    }).join('\n') + '\n</state>';
  }

  function resultErrors(result) {
    if (result === false) return ['小白X 返回了失败'];
    if (!result || typeof result !== 'object') return [];
    var list = result.errors !== undefined ? result.errors : result.diagnostics !== undefined ? result.diagnostics : result.error;
    var messages = (Array.isArray(list) ? list : list ? [list] : []).map(function (item) {
      if (typeof item === 'string') return item;
      if (item && typeof item.message === 'string') return item.message;
      if (item && typeof item.code === 'string') return item.code;
      try { return JSON.stringify(item); } catch (error) { return String(item); }
    }).filter(Boolean);
    if (!messages.length && (result.ok === false || result.success === false || result.status === 'failed')) messages.push('小白X 返回了失败');
    return messages;
  }

  /* 精确叶子差异（支持 del/remove，不把整个父对象重写），用于 V2 JSON apply 与 V3 apply。 */
  function structuredDiff(before, after) {
    var out = [];
    (function walkStructured(left, right, path) {
      Object.keys(left).forEach(function (key) {
        if (!has(right, key)) out.push({ path: path.concat(key), value: undefined, removed: true });
      });
      Object.keys(right).forEach(function (key) {
        if (same(left[key], right[key])) return;
        if (isObject(left[key]) && isObject(right[key])) walkStructured(left[key], right[key], path.concat(key));
        else out.push({ path: path.concat(key), value: clone(right[key]) });
      });
    })(isObject(before) ? clone(before) : {}, isObject(after) ? clone(after) : {}, []);
    return out;
  }

  function createLwbHost(env) {
    function find(name) {
      if (env && typeof env.find === 'function') return env.find(name);
      try { return env && env.host ? env.host[name] : undefined; } catch (error) { return undefined; }
    }

    function stateApi() {
      var api = find('LWB_StateV2');
      return api && (typeof api.apply === 'function' || typeof api.applyText === 'function') ? api : null;
    }

    function stateV3Api() {
      var api = find('LWB_StateV3');
      return api && typeof api.apply === 'function' ? api : null;
    }

    function metadata() {
      var ctx = null;
      try { ctx = env && typeof env.context === 'function' ? env.context() : null; } catch (error) { ctx = null; }
      return ctx && isObject(ctx.chatMetadata) ? ctx.chatMetadata : null;
    }

    function isV3Chat() {
      var meta = metadata();
      return !!(meta && meta['lwb-state3'] && stateV3Api());
    }

    function rawVariables() {
      var meta = metadata();
      if (meta) return isObject(meta.variables) ? meta.variables : {};
      if (env && typeof env.getVariables === 'function') {
        try {
          var vars = env.getVariables({ type: 'chat' });
          return isObject(vars) ? vars : {};
        } catch (error) { /* 没有聊天 */ }
      }
      return {};
    }

    /* 宿主变量：聊天局部变量去掉 Reader 自己的键，并解码小白X 存成 JSON 字符串的对象/数组。返回副本。 */
    function readVariables() {
      var raw = rawVariables();
      var output = {};
      Object.keys(raw).forEach(function (key) {
        if (OWN_KEYS.test(key) || RESERVED_KEYS.indexOf(key) >= 0 || raw[key] === undefined) return;
        output[key] = decodeStoredVariable(raw[key]);
      });
      return output;
    }

    /* 这个聊天在用小白X 的变量 2.0 或 3.0：接口在，聊天元数据里有它的记录，并且有宿主变量。 */
    function inUse() {
      if (!Object.keys(readVariables()).length) return false;
      if (isV3Chat()) return true;
      if (!stateApi()) return false;
      var meta = metadata();
      return !!meta && Object.keys(meta).some(function (key) { return /^LWB_(?:RULES|SNAP)/.test(key); });
    }

    /* 语义层用的楼层数据：楼层变量的副本，但 stat_data 换成小白X 的宿主变量，再放回楼层里的 READER。 */
    function compose(message) {
      var source = isObject(message) ? message : {};
      var data = {};
      Object.keys(source).forEach(function (key) { if (key !== 'stat_data') data[key] = clone(source[key]); });
      data.stat_data = readVariables();
      var reader = isObject(source.stat_data) ? source.stat_data.READER : undefined;
      if (reader !== undefined) data.stat_data.READER = clone(reader);
      return data;
    }

    /* 把语义层改过的数据合回楼层变量：stat_data 里只换 READER（MVU 自己的变量不动），其余顶层键照搬。 */
    function merge(latest, data) {
      var next = clone(isObject(latest) ? latest : {}) || {};
      Object.keys(data || {}).forEach(function (key) { if (key !== 'stat_data') next[key] = clone(data[key]); });
      if (!isObject(next.stat_data)) next.stat_data = {};
      var reader = data && isObject(data.stat_data) ? data.stat_data.READER : undefined;
      if (reader !== undefined) next.stat_data.READER = clone(reader);
      else delete next.stat_data.READER;
      return next;
    }

    function hostPart(statData) {
      var output = {};
      if (!isObject(statData)) return output;
      Object.keys(statData).forEach(function (key) { if (key !== 'READER') output[key] = clone(statData[key]); });
      return output;
    }

    function mismatches(changes) {
      var current = readVariables();
      return changes.filter(function (change) {
        var value = valueAt(current, change.path);
        if (change.removed) return value !== undefined && value !== null;
        return !same(value, change.value);
      });
    }

    /* 把宿主部分从 before 改成 after：按当前聊天版本交给小白X 3.0 / 2.0，再回读核对。没有改动时什么也不做。 */
    async function apply(before, after) {
      var targetAfter = clone(isObject(after) ? after : {});
      var changes, text = '', result;
      if (isV3Chat()) {
        changes = structuredDiff(before, targetAfter);
        if (!changes.length) return { changes: [], text: '' };
        var v3Ops = changes.map(function (change) {
          return change.removed ? { op: 'remove', path: change.path } : { op: 'set', path: change.path, value: change.value };
        });
        result = await stateV3Api().apply(v3Ops);
      } else {
        var api = stateApi();
        if (!api) throw new Error('小白X 的变量接口不可用：请在小白X 设置里开启「变量管理 2.0」或「3.0」');
        if (typeof api.apply === 'function') {
          changes = structuredDiff(before, targetAfter);
          if (!changes.length) return { changes: [], text: '' };
          var v2Ops = changes.map(function (change) {
            var p = formatV2Path(change.path);
            return change.removed ? { op: 'del', path: p } : { op: 'set', path: p, value: change.value };
          });
          result = await api.apply({ ops: v2Ops });
        } else {
          changes = expressible(diff(before, targetAfter), targetAfter);
          if (!changes.length) return { changes: [], text: '' };
          text = stateText(changes);
          result = await api.applyText(text);
        }
      }
      var errors = resultErrors(result);
      if (errors.length) throw new Error('小白X 没有接受这次写入：' + errors.join('；'));
      var wrong = mismatches(changes);
      if (wrong.length) {
        await new Promise(function (resolve) { setTimeout(resolve, 60); });
        wrong = mismatches(wrong);
      }
      if (wrong.length) {
        throw new Error('小白X 没有按预期写入：' + wrong.map(function (change) { return change.path.join('.'); }).join('、'));
      }
      return { changes: changes, text: text, result: result };
    }

    return {
      available: function () { return !!(stateV3Api() || stateApi()); },
      inUse: inUse,
      readVariables: readVariables,
      compose: compose,
      merge: merge,
      hostPart: hostPart,
      apply: apply
    };
  }

  modules.lwbStateDiff = function (before, after) { return expressible(diff(before, after), clone(isObject(after) ? after : {})); };
  modules.lwbStateText = stateText;
  modules.createLwbHost = createLwbHost;
})(typeof globalThis !== 'undefined' ? globalThis : window);
