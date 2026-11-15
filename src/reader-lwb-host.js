(function (root) {
  'use strict';

  /*
   * 小白X（LittleWhiteBox）作为第三种变量宿主（另两种：酒馆助手 + MVU；没有 MVU 的纯文字卡）。
   *   读：酒馆的聊天局部变量 chat_metadata.variables。小白X 的状态通常在一个根变量里（如「数据」）。
   *   写：LWB_StateV2.applyText('<state>…</state>')，让小白X 的楼层账本、模板与约束校验保持一致；
   *       从不直接改 chat_metadata.variables 里它管的变量。
   * Reader 自己的 READER 命名空间不放这里，仍在 MVU 楼层变量里（与纯文字卡相同），宿主切换时不用搬家。
   *
   * 没在真实的小白X 上验证过的两点（见交接 0.5）：<state> 里给对象赋值是整体替换还是合并；删除怎么写。
   * 这里的写法：只改叶子时逐条写绝对值；对象里有键被删时整体重写这个对象；顶层变量被删时写 null。
   * 写完回读核对，没按预期落地就报错，不静默。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  /* 聊天变量里属于 Reader 自己（reader_ii_runtime、dream_persona…）或小白X 元数据的键，不算宿主变量。 */
  var OWN_KEYS = /^(?:READER$|reader_|dream_|LWB_)/i;
  var RESERVED_KEYS = ['__proto__', 'prototype', 'constructor'];

  function isObject(value) {
    return modules.isObject ? modules.isObject(value) : !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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

  function stateText(changes) {
    return '<state>\n' + changes.map(function (change) {
      return change.path.join('.') + ': ' + JSON.stringify(change.value === undefined ? null : change.value);
    }).join('\n') + '\n</state>';
  }

  function resultErrors(result) {
    if (result === false) return ['小白X 返回了失败'];
    if (!result || typeof result !== 'object') return [];
    var list = result.errors !== undefined ? result.errors : result.error;
    var messages = (Array.isArray(list) ? list : list ? [list] : []).map(function (item) {
      if (typeof item === 'string') return item;
      if (item && typeof item.message === 'string') return item.message;
      try { return JSON.stringify(item); } catch (error) { return String(item); }
    }).filter(Boolean);
    if (!messages.length && (result.ok === false || result.success === false)) messages.push('小白X 返回了失败');
    return messages;
  }

  function createLwbHost(env) {
    function find(name) {
      if (env && typeof env.find === 'function') return env.find(name);
      try { return env && env.host ? env.host[name] : undefined; } catch (error) { return undefined; }
    }

    function stateApi() {
      var api = find('LWB_StateV2');
      return api && typeof api.applyText === 'function' ? api : null;
    }

    function metadata() {
      var ctx = null;
      try { ctx = env && typeof env.context === 'function' ? env.context() : null; } catch (error) { ctx = null; }
      return ctx && isObject(ctx.chatMetadata) ? ctx.chatMetadata : null;
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

    /* 宿主变量：聊天局部变量去掉 Reader 自己的键。返回副本。 */
    function readVariables() {
      var raw = rawVariables();
      var output = {};
      Object.keys(raw).forEach(function (key) {
        if (OWN_KEYS.test(key) || RESERVED_KEYS.indexOf(key) >= 0 || raw[key] === undefined) return;
        output[key] = clone(raw[key]);
      });
      return output;
    }

    /* 这个聊天在用小白X 的变量 2.0：接口在，聊天元数据里有它的规则或快照，并且有宿主变量。 */
    function inUse() {
      if (!stateApi()) return false;
      var meta = metadata();
      var marked = !!meta && Object.keys(meta).some(function (key) { return /^LWB_(?:RULES|SNAP)/.test(key); });
      return marked && Object.keys(readVariables()).length > 0;
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

    /* 把宿主部分从 before 改成 after：生成 <state> 文本交给小白X，再回读核对。没有改动时什么也不做。 */
    async function apply(before, after) {
      var changes = expressible(diff(before, after), clone(isObject(after) ? after : {}));
      if (!changes.length) return { changes: [], text: '' };
      var api = stateApi();
      if (!api) throw new Error('小白X 的变量 2.0 接口不可用：请在小白X 设置里开启「变量管理 2.0 (state)」');
      var text = stateText(changes);
      var result = await api.applyText(text);
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
      available: function () { return !!stateApi(); },
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
