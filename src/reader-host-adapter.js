(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  function valueType(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value === 'object' ? 'object' : typeof value;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ':' + stableStringify(value[key]);
      }).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function hashText(text) {
    var hash = 2166136261;
    for (var index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function operationsForType(type, isTopRoot) {
    if (type === 'number') return ['set', 'delta'];
    if (type === 'string') return ['set'];
    if (type === 'boolean') return ['set', 'toggle'];
    if (type === 'object') return isTopRoot ? ['set', 'merge'] : ['set', 'merge', 'remove'];
    if (type === 'array') return isTopRoot
      ? ['set', 'append', 'remove_value']
      : ['set', 'append', 'remove_value', 'remove'];
    if (type === 'null') return isTopRoot ? ['set'] : ['set', 'remove'];
    return [];
  }

  function childKeys(value) {
    if (Array.isArray(value)) return value.map(function (_, index) { return index; });
    if (!value || typeof value !== 'object') return [];
    return Object.keys(value).filter(function (key) {
      return key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
    }).sort(function (left, right) { return left.localeCompare(right, 'zh-CN'); });
  }

  function createHostAdapter(controller, env, economy) {
    function safeStringSample(value) {
      var text = String(value || '');
      if (text.length <= 20 && !/\s|@|https?:|\d{4,}/i.test(text)) return text;
      return '[文本形态：' + text.length + '字]';
    }

    function summarizeValue(value, depth) {
      if (depth > 4) return { type: 'truncated' };
      if (Array.isArray(value)) return {
        type: 'array',
        length: value.length,
        samples: value.slice(0, 3).map(function (item) { return summarizeValue(item, depth + 1); })
      };
      if (value && typeof value === 'object') {
        var fields = {};
        childKeys(value).slice(0, 20).forEach(function (key) { fields[String(key)] = summarizeValue(value[key], depth + 1); });
        return { type: 'object', fields: fields, truncated: childKeys(value).length > 20 };
      }
      if (typeof value === 'string') return { type: 'string', sample: safeStringSample(value) };
      if (typeof value === 'number') return { type: 'number', sample: Number.isFinite(value) ? value : 'non-finite' };
      if (typeof value === 'boolean') return { type: 'boolean', sample: value };
      return { type: value === null ? 'null' : typeof value };
    }
    function descriptor(data, segments) {
      var missing = {};
      var current = economy.getHostValue(data, segments, missing);
      if (current === missing) return null;
      var type = valueType(current);
      var ref = economy.createHostRef(segments);
      var labels = segments.slice(1).map(String);
      var preview;
      if (type === 'object') preview = '{' + Object.keys(current).slice(0, 8).join('、') + (Object.keys(current).length > 8 ? '…' : '') + '}';
      else if (type === 'array') preview = '[共' + current.length + '项]';
      else if (type === 'string') preview = current.slice(0, 100);
      else preview = String(current);
      return {
        ref: ref,
        segments: segments.slice(),
        path: economy.hostDisplayPath(segments),
        label: labels.join(' › '),
        name: labels[labels.length - 1],
        parentRef: segments.length > 2 ? economy.createHostRef(segments.slice(0, -1)) : '',
        depth: segments.length - 2,
        valueType: type,
        value: type === 'object' ? {} : type === 'array' ? [] : modules.clone(current),
        preview: preview,
        readable: true,
        writable: operationsForType(type, segments.length === 2).length > 0,
        operations: operationsForType(type, segments.length === 2),
        hasChildren: type === 'object' ? Object.keys(current).length > 0 : type === 'array' && current.length > 0
      };
    }

    function enumerate(data) {
      var statData = data && data.stat_data;
      if (!statData || typeof statData !== 'object') return [];
      var roots = childKeys(statData).filter(function (key) { return key !== 'READER'; });
      var stack = [];
      for (var rootIndex = roots.length - 1; rootIndex >= 0; rootIndex -= 1) {
        stack.push(['stat_data', roots[rootIndex]]);
      }
      var output = [];
      var visited = typeof WeakSet === 'function' ? new WeakSet() : null;
      while (stack.length) {
        var segments = stack.pop();
        var item = descriptor(data, segments);
        if (!item) continue;
        output.push(item);
        var current = economy.getHostValue(data, segments, undefined);
        if (!current || typeof current !== 'object') continue;
        if (visited) {
          if (visited.has(current)) continue;
          visited.add(current);
        }
        var keys = childKeys(current);
        for (var keyIndex = keys.length - 1; keyIndex >= 0; keyIndex -= 1) {
          stack.push(segments.concat([keys[keyIndex]]));
        }
      }
      return output;
    }

    async function listHostVariables(options) {
      var snapshot = await controller.snapshot();
      var variables = enumerate(snapshot.data);
      var query = String(options && options.query || '').trim().toLowerCase();
      var valueTypes = options && Array.isArray(options.valueTypes) ? options.valueTypes : null;
      var leavesOnly = options && options.leavesOnly === true;
      return variables.filter(function (item) {
        if (query && (item.label + ' ' + item.path + ' ' + item.preview).toLowerCase().indexOf(query) < 0) return false;
        if (valueTypes && valueTypes.indexOf(item.valueType) < 0) return false;
        if (leavesOnly && item.hasChildren) return false;
        return true;
      });
    }

    async function listHostChildren(parentInput) {
      var snapshot = await controller.snapshot();
      if (!parentInput) return enumerate(snapshot.data).filter(function (item) { return item.depth === 0; });
      var parent = economy.normalizeHostRef(parentInput);
      if (!parent) throw new Error('宿主父路径引用无效');
      var value = economy.getHostValue(snapshot.data, parent, undefined);
      if (!value || typeof value !== 'object') return [];
      return childKeys(value).map(function (key) { return descriptor(snapshot.data, parent.concat([key])); }).filter(Boolean);
    }

    async function readHostRef(input, fallback) {
      var segments = economy.normalizeHostRef(input);
      if (!segments) throw new Error('宿主路径引用无效');
      var snapshot = await controller.snapshot();
      var missing = {};
      var value = economy.getHostValue(snapshot.data, segments, missing);
      return value === missing ? fallback : modules.clone(value);
    }

    function writeValue(data, segments, operation, input) {
      var missing = {};
      var current = economy.getHostValue(data, segments, missing);
      if (current === missing) throw new Error('宿主路径当前不存在：' + economy.hostDisplayPath(segments));
      var type = valueType(current);
      var allowed = operationsForType(type, segments.length === 2);
      if (allowed.indexOf(operation) < 0) throw new Error('操作 ' + operation + ' 不适用于宿主' + type + '变量');
      if (operation === 'remove') {
        if (!economy.deleteHostValue(data, segments)) throw new Error('宿主路径删除失败');
        return undefined;
      }
      if (operation === 'delta') {
        var delta = Number(input);
        var number = Number(current);
        if (!Number.isFinite(delta) || !Number.isFinite(number + delta)) throw new Error('宿主数值增减必须是有限数值');
        economy.setHostValue(data, segments, number + delta);
        return number + delta;
      }
      if (operation === 'toggle') {
        economy.setHostValue(data, segments, !current);
        return !current;
      }
      if (operation === 'merge') {
        if (!modules.isObject(input)) throw new Error('宿主对象merge必须提供JSON对象');
        var merged = modules.mergeKnown(current, input);
        economy.setHostValue(data, segments, merged);
        return modules.clone(merged);
      }
      if (operation === 'append') {
        var appended = current.slice();
        appended.push(modules.clone(input));
        economy.setHostValue(data, segments, appended);
        return modules.clone(appended);
      }
      if (operation === 'remove_value') {
        var needle = stableStringify(input);
        var filtered = current.filter(function (item) { return stableStringify(item) !== needle; });
        economy.setHostValue(data, segments, filtered);
        return modules.clone(filtered);
      }
      if (operation === 'set') {
        var incomingType = valueType(input);
        if (type !== 'null' && incomingType !== type) throw new Error('宿主变量类型不可从 ' + type + ' 改成 ' + incomingType);
        if (type === 'number' && !Number.isFinite(Number(input))) throw new Error('宿主数值必须是有限数值');
        var next = type === 'number' ? Number(input) : modules.clone(input);
        economy.setHostValue(data, segments, next);
        return modules.clone(next);
      }
      throw new Error('未知宿主写入操作：' + operation);
    }

    async function writeHostRef(input, rawOperation, value) {
      var segments = economy.normalizeHostRef(input);
      if (!segments) throw new Error('宿主路径引用无效');
      var operation = String(rawOperation || 'set');
      return controller.mutate('write_host_ref:' + economy.createHostRef(segments), function (data) {
        return writeValue(data, segments, operation, value);
      });
    }

    async function getHostTreeSummary() {
      var snapshot = await controller.snapshot();
      var variables = enumerate(snapshot.data);
      var roots = variables.filter(function (item) { return item.depth === 0; }).length;
      return {
        status: roots ? '已连接' : '无宿主MVU',
        roots: roots,
        nodes: variables.length
      };
    }

    async function summarizeHostRef(input) {
      var segments = economy.normalizeHostRef(input);
      if (!segments) throw new Error('宿主路径引用无效');
      var snapshot = await controller.snapshot();
      var missing = {};
      var value = economy.getHostValue(snapshot.data, segments, missing);
      if (value === missing) throw new Error('宿主路径当前不存在');
      return {
        rootRef: economy.createHostRef(segments),
        displayPath: economy.hostDisplayPath(segments),
        rootType: valueType(value),
        structure: summarizeValue(value, 0)
      };
    }

    return {
      listHostVariables: listHostVariables,
      listHostChildren: listHostChildren,
      readHostRef: readHostRef,
      writeHostRef: writeHostRef,
      readHostPath: readHostRef,
      writeHostPath: writeHostRef,
      getHostTreeSummary: getHostTreeSummary,
      summarizeHostRef: summarizeHostRef,
      createHostRef: economy.createHostRef
    };
  }

  modules.stableStringify = stableStringify;
  modules.hashText = hashText;
  modules.createHostAdapter = createHostAdapter;
})(typeof globalThis !== 'undefined' ? globalThis : window);
