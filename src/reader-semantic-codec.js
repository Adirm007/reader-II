(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var SLOT_KEYS = ['location', 'characters', 'tasks', 'skills', 'statuses', 'currency', 'inventory'];
  var CONTAINER_SLOTS = ['characters', 'tasks', 'skills', 'statuses', 'inventory'];
  var INVENTORY_FIELDS = ['count', 'quality', 'type', 'tags', 'effect', 'description'];
  /* 未绑定宿主背包时的 Reader 后备背包（stat_data.READER.背包）。 */
  var FALLBACK_INVENTORY_MAPPING = {
    version: 1,
    slot: 'inventory',
    rootRef: '',
    containerKind: 'object',
    entryKind: 'object',
    name: { from: 'key' },
    fields: {
      count: { path: ['数量'] },
      quality: { path: ['品质'] },
      type: { path: ['类型'] },
      tags: { path: ['标签'] },
      effect: { path: ['效果'] },
      description: { path: ['描述'] }
    },
    construct: { constants: [] }
  };

  function isSlot(slot) {
    return SLOT_KEYS.indexOf(String(slot || '')) >= 0;
  }

  function normalizeLocationValue(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') {
      throw new Error('当前地点必须绑定字符串叶节点，或包含地点文本的对象/数组节点');
    }
    var parts = [];
    var seenValues = Object.create(null);
    var visited = typeof WeakSet === 'function' ? new WeakSet() : null;
    var invalidReason = '';

    function visit(current, depth) {
      if (invalidReason) return;
      if (typeof current === 'string') {
        var text = current.trim();
        if (text && !seenValues[text]) {
          seenValues[text] = true;
          parts.push(text);
          if (parts.length > 50 || parts.join(' - ').length > 1000) invalidReason = '地点节点包含的文本过多';
        }
        return;
      }
      if (!current || typeof current !== 'object') return;
      if (depth > 12) {
        invalidReason = '地点节点层级过深';
        return;
      }
      if (visited) {
        if (visited.has(current)) return;
        visited.add(current);
      }
      var values = Array.isArray(current)
        ? current
        : Object.keys(current).filter(function (key) {
          return ['__proto__', 'prototype', 'constructor'].indexOf(key) < 0;
        }).map(function (key) { return current[key]; });
      values.forEach(function (item) { visit(item, depth + 1); });
    }

    visit(value, 0);
    if (invalidReason) throw new Error(invalidReason);
    if (!parts.length) throw new Error('当前地点节点中没有可用的字符串值');
    return parts.join(' - ');
  }

  function validateLeaf(slot, value) {
    if (slot === 'location') {
      return normalizeLocationValue(value);
    }
    if (slot === 'currency') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('货币必须绑定有限数值叶节点');
      return value;
    }
    throw new Error('此槽位不是叶节点槽位');
  }

  function safeRelativePath(input, label) {
    if (!Array.isArray(input) || !input.length || input.length > 12) throw new Error(label + '必须是非空相对路径段数组');
    return input.map(function (segment) {
      if (typeof segment === 'number') {
        if (!Number.isInteger(segment) || segment < 0) throw new Error(label + '含无效数组下标');
        return segment;
      }
      if (typeof segment !== 'string' || !segment || ['__proto__', 'prototype', 'constructor'].indexOf(segment) >= 0) {
        throw new Error(label + '含危险或无效路径段');
      }
      return segment;
    });
  }

  function readRelative(value, path, missing) {
    var cursor = value;
    for (var index = 0; index < path.length; index += 1) {
      if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, path[index])) return missing;
      cursor = cursor[path[index]];
    }
    return cursor;
  }

  function assertOnlyKeys(value, keys, label) {
    if (!modules.isObject(value)) throw new Error(label + '必须是对象');
    Object.keys(value).forEach(function (key) {
      if (keys.indexOf(key) < 0) throw new Error(label + '包含不允许的字段：' + key);
    });
  }

  function rejectExecutableContent(value, path) {
    var label = path || 'mapping';
    if (typeof value === 'function') throw new Error(label + '不得包含函数');
    if (typeof value === 'string' && /(?:<%|%>|=>|\bfunction\b|javascript:|\beval\s*\(|\bnew\s+Function\b)/i.test(value)) {
      throw new Error(label + '不得包含JS/EJS/表达式');
    }
    if (Array.isArray(value)) value.forEach(function (item, index) { rejectExecutableContent(item, label + '[' + index + ']'); });
    else if (modules.isObject(value)) Object.keys(value).forEach(function (key) { rejectExecutableContent(value[key], label + '.' + key); });
  }

  function normalizeNameSpec(input, containerKind, entryKind) {
    assertOnlyKeys(input, ['from', 'path'], 'name');
    if (entryKind === 'name') {
      if (containerKind !== 'array' || input.from !== 'value') throw new Error('字符串数组背包的名字只能来自条目本身（from=value）');
      return { from: 'value' };
    }
    if (input.from === 'value') throw new Error('只有字符串数组背包可用条目本身作为名字');
    if (input.from === 'key') {
      if (containerKind !== 'object') throw new Error('只有对象表可用对象键作为名字');
      if (input.path !== undefined && (!Array.isArray(input.path) || input.path.length !== 0)) {
        throw new Error('对象键名字不得再声明非空path');
      }
      return { from: 'key' };
    }
    if (input.from !== 'path') throw new Error('name.from只能是key或path');
    return { from: 'path', path: safeRelativePath(input.path, 'name.path') };
  }

  function normalizeFavorTransform(input) {
    var source = input === undefined ? { type: 'identity' } : input;
    if (!modules.isObject(source)) throw new Error('favor.transform必须是对象');
    if (source.type === 'identity') {
      assertOnlyKeys(source, ['type'], 'favor.transform');
      return { type: 'identity' };
    }
    if (source.type === 'linear') {
      assertOnlyKeys(source, ['type', 'scale', 'offset'], 'favor.transform');
      var scale = Number(source.scale);
      var offset = Number(source.offset || 0);
      if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(offset)) throw new Error('favor线性换算必须使用有限且非零比例');
      return { type: 'linear', scale: scale, offset: offset };
    }
    if (source.type === 'enum') {
      assertOnlyKeys(source, ['type', 'values'], 'favor.transform');
      if (!modules.isObject(source.values) || !Object.keys(source.values).length) throw new Error('favor枚举表不能为空');
      var values = {};
      Object.keys(source.values).forEach(function (key) {
        if (['__proto__', 'prototype', 'constructor'].indexOf(key) >= 0) throw new Error('favor枚举含危险键');
        var mapped = Number(source.values[key]);
        if (!Number.isFinite(mapped) || mapped < 0 || mapped > 100) throw new Error('favor枚举结果必须在0～100');
        values[key] = mapped;
      });
      return { type: 'enum', values: values };
    }
    throw new Error('未知favor换算类型');
  }

  function normalizeFieldSpec(input, label, allowTransform) {
    assertOnlyKeys(input, allowTransform ? ['path', 'transform'] : ['path'], label);
    var output = { path: safeRelativePath(input.path, label + '.path') };
    if (allowTransform) output.transform = normalizeFavorTransform(input.transform);
    return output;
  }

  function normalizeMappingShape(slot, input, expectedRootRef) {
    var raw = input;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (error) { throw new Error('映射不是有效JSON'); }
    }
    rejectExecutableContent(raw);
    assertOnlyKeys(raw, ['version', 'slot', 'rootRef', 'containerKind', 'entryKind', 'name', 'fields', 'construct'], 'mapping');
    if (raw.version !== 1) throw new Error('不支持的映射版本');
    if (raw.slot !== slot || CONTAINER_SLOTS.indexOf(slot) < 0) throw new Error('映射槽位不匹配');
    if (raw.rootRef !== expectedRootRef) throw new Error('LLM不得改变用户锁定的根路径');
    if (raw.containerKind !== 'object' && raw.containerKind !== 'array') throw new Error('containerKind只能是object或array');
    var entryKind = 'object';
    if (slot === 'inventory') {
      entryKind = raw.entryKind === undefined ? 'object' : raw.entryKind;
      if (['object', 'count', 'name'].indexOf(entryKind) < 0) throw new Error('entryKind只能是object、count或name');
      if (entryKind === 'count' && (raw.containerKind !== 'object' || !raw.name || raw.name.from !== 'key')) {
        throw new Error('“物品名: 数量”背包必须是对象表并以对象键为名字');
      }
    } else if (raw.entryKind !== undefined) throw new Error('只有背包映射可声明entryKind');
    var mapping = {
      version: 1,
      slot: slot,
      rootRef: expectedRootRef,
      containerKind: raw.containerKind,
      name: normalizeNameSpec(raw.name, raw.containerKind, entryKind),
      fields: {}
    };
    if (slot === 'inventory') mapping.entryKind = entryKind;
    assertOnlyKeys(raw.fields || {}, slot === 'characters' ? ['favor', 'present', 'identity'] : slot === 'statuses' ? ['effect', 'duration', 'source'] : slot === 'inventory' ? INVENTORY_FIELDS : [], 'fields');
    if (slot === 'characters') {
      if (!raw.fields || !raw.fields.favor) throw new Error('重要角色映射缺少favor');
      mapping.fields.favor = normalizeFieldSpec(raw.fields.favor, 'fields.favor', true);
      if (raw.fields.present) mapping.fields.present = normalizeFieldSpec(raw.fields.present, 'fields.present', false);
      if (raw.fields.identity) mapping.fields.identity = normalizeFieldSpec(raw.fields.identity, 'fields.identity', false);
    }
    if (slot === 'statuses') {
      if (!raw.fields || !raw.fields.effect || !raw.fields.duration) throw new Error('状态映射缺少effect或duration');
      mapping.fields.effect = normalizeFieldSpec(raw.fields.effect, 'fields.effect', false);
      mapping.fields.duration = normalizeFieldSpec(raw.fields.duration, 'fields.duration', false);
      if (raw.fields.source) mapping.fields.source = normalizeFieldSpec(raw.fields.source, 'fields.source', false);
      mapping.construct = normalizeStatusConstruct(raw.construct, mapping);
    } else if (slot === 'inventory') {
      if (entryKind === 'object') {
        INVENTORY_FIELDS.forEach(function (field) {
          if (raw.fields && raw.fields[field]) mapping.fields[field] = normalizeFieldSpec(raw.fields[field], 'fields.' + field, false);
        });
        mapping.construct = normalizeStatusConstruct(raw.construct, mapping);
      } else {
        if (raw.fields && Object.keys(raw.fields).length) throw new Error('这种背包形状不需要字段映射');
        if (raw.construct !== undefined) throw new Error('这种背包形状不需要construct');
      }
    } else if (raw.construct !== undefined) throw new Error('只有状态与背包映射可声明construct');
    return mapping;
  }

  function entriesFor(container, kind) {
    if (kind === 'array') return Array.isArray(container) ? container.map(function (value, index) { return { key: index, value: value }; }) : [];
    if (!modules.isObject(container)) return [];
    return Object.keys(container).filter(function (key) {
      return ['__proto__', 'prototype', 'constructor'].indexOf(key) < 0;
    }).map(function (key) { return { key: key, value: container[key] }; });
  }

  function entryName(entry, mapping) {
    var raw;
    if (mapping.name.from === 'key') raw = entry.key;
    else if (mapping.name.from === 'value') raw = entry.value;
    else raw = readRelative(entry.value, mapping.name.path, undefined);
    return typeof raw === 'string' ? raw.trim() : '';
  }

  function convertFavor(raw, transform) {
    var output;
    if (transform.type === 'enum') {
      if (!Object.prototype.hasOwnProperty.call(transform.values, String(raw))) return null;
      output = Number(transform.values[String(raw)]);
    } else {
      var number = Number(raw);
      if (!Number.isFinite(number)) return null;
      output = transform.type === 'linear' ? number * transform.scale + transform.offset : number;
    }
    return Number.isFinite(output) && output >= 0 && output <= 100 ? output : null;
  }

  function normalizePresence(raw) {
    if (raw === true || raw === false) return raw;
    if (raw === 1 || raw === 0) return raw === 1;
    if (typeof raw !== 'string') return null;
    var value = raw.trim().toLowerCase();
    if (['true', 'yes', 'on', '1', '是', '在场', '当前在场'].indexOf(value) >= 0) return true;
    if (['false', 'no', 'off', '0', '否', '不在场', '离场', '当前不在场'].indexOf(value) >= 0) return false;
    return null;
  }

  function normalizeIdentity(raw) {
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (!Array.isArray(raw)) return undefined;
    var values = raw.filter(function (item) { return typeof item === 'string' && item.trim(); }).map(function (item) { return item.trim(); });
    return values.length ? values : undefined;
  }

  function listContainerNames(mapping, container) {
    var seen = Object.create(null);
    return entriesFor(container, mapping.containerKind).map(function (entry) {
      return entry.value && typeof entry.value === 'object' ? entryName(entry, mapping) : '';
    }).filter(function (name) {
      if (!name || seen[name]) return false;
      seen[name] = true;
      return true;
    });
  }

  function normalizeContainer(mapping, container) {
    if (mapping.slot === 'inventory') return readInventory(mapping, container);
    var entries = entriesFor(container, mapping.containerKind);
    var output = [];
    entries.forEach(function (entry) {
      if (!entry.value || typeof entry.value !== 'object') return;
      var name = entryName(entry, mapping);
      if (!name) return;
      if (mapping.slot === 'characters') {
        var rawFavor = readRelative(entry.value, mapping.fields.favor.path, undefined);
        var favor = convertFavor(rawFavor, mapping.fields.favor.transform);
        if (favor === null) return;
        var character = { name: name, favor: favor };
        var presentRaw = mapping.fields.present
          ? readRelative(entry.value, mapping.fields.present.path, undefined)
          : entry.value.在场;
        var present = normalizePresence(presentRaw);
        var identityRaw = mapping.fields.identity
          ? readRelative(entry.value, mapping.fields.identity.path, undefined)
          : entry.value.身份;
        var identity = normalizeIdentity(identityRaw);
        if (present !== null) character.present = present;
        if (identity !== undefined) character.identity = identity;
        if (present === true) character.details = modules.clone(entry.value);
        output.push(character);
      } else if (mapping.slot === 'statuses') {
        var effect = readRelative(entry.value, mapping.fields.effect.path, undefined);
        var duration = readRelative(entry.value, mapping.fields.duration.path, undefined);
        if (typeof effect !== 'string' || !effect.trim() || typeof duration !== 'string' || !duration.trim()) return;
        var item = { name: name, effect: effect, duration: duration };
        if (mapping.fields.source) {
          var source = readRelative(entry.value, mapping.fields.source.path, undefined);
          if (typeof source === 'string' && source.trim()) item.source = source;
        }
        output.push(item);
      } else output.push(name);
    });
    if (mapping.slot === 'tasks' || mapping.slot === 'skills') {
      var seen = {};
      return output.filter(function (name) {
        if (seen[name]) return false;
        seen[name] = true;
        return true;
      });
    }
    return output;
  }

  function structureShape(value, depth) {
    if (depth > 6) return '*';
    if (Array.isArray(value)) {
      if (!value.length) return ['array', 'empty'];
      var shapes = value.slice(0, 5).map(function (item) { return structureShape(item, depth + 1); });
      var unique = {};
      shapes.forEach(function (shape) { unique[JSON.stringify(shape)] = shape; });
      return ['array', Object.keys(unique).sort().map(function (key) { return unique[key]; })];
    }
    if (modules.isObject(value)) {
      var output = {};
      Object.keys(value).filter(function (key) { return ['__proto__', 'prototype', 'constructor'].indexOf(key) < 0; }).sort().slice(0, 40).forEach(function (key) {
        output[key] = structureShape(value[key], depth + 1);
      });
      return output;
    }
    return value === null ? 'null' : typeof value;
  }

  function structureFingerprint(value) {
    var text = modules.stableStringify ? modules.stableStringify(structureShape(value, 0)) : JSON.stringify(structureShape(value, 0));
    return modules.hashText ? modules.hashText(text) : text;
  }

  function validateMapping(slot, input, expectedRootRef, container, options) {
    var mapping = normalizeMappingShape(slot, input, expectedRootRef);
    var actualKind = Array.isArray(container) ? 'array' : modules.isObject(container) ? 'object' : typeof container;
    if (actualKind !== mapping.containerKind) throw new Error('映射容器类型与宿主根不一致');
    var entries = entriesFor(container, mapping.containerKind);
    var allowEmpty = options && options.allowEmpty === true;
    if (!entries.length && !allowEmpty) throw new Error('空容器没有可验证样例，请提供示例条目或稍后重试');
    var normalized = normalizeContainer(mapping, container);
    if (entries.length && !normalized.length) throw new Error('当前样例无法满足此槽位的必需语义');
    if (slot === 'inventory') {
      var bagClone = modules.clone(container);
      var probe = '__Reader背包往返测试__';
      while (normalized.some(function (item) { return item.name === probe; })) probe += '_';
      addInventoryItem(mapping, bagClone, { name: probe, count: 1, quality: '测试', type: '测试', tags: ['Reader-II'], effect: { 说明: '往返验证' }, description: 'Reader背包映射往返验证' });
      if (!readInventory(mapping, bagClone).some(function (item) { return item.name === probe; })) {
        throw new Error('背包构造后无法按同一映射重新读取');
      }
      if (!removeInventoryItem(mapping, bagClone, probe, 1).removed) throw new Error('背包构造后无法按同一映射移除');
    }
    if (slot === 'statuses') {
      var names = normalized.map(function (item) { return item.name; });
      if (new Set(names).size !== names.length) throw new Error('状态名字无法安全判重');
      var cloned = modules.clone(container);
      var testName = '__Reader映射往返测试__';
      while (names.indexOf(testName) >= 0) testName += '_';
      var insertion = insertStatusIfAbsent(mapping, cloned, {
        name: testName,
        effect: 'Reader状态映射往返验证',
        duration: '1轮',
        source: 'Reader-II'
      });
      if (!insertion.inserted) throw new Error('状态构造dry-run未能插入');
      var reread = normalizeContainer(mapping, cloned).find(function (item) { return item.name === testName; });
      if (!reread || reread.effect !== 'Reader状态映射往返验证' || reread.duration !== '1轮') {
        throw new Error('状态构造后无法按同一映射重新读取');
      }
    }
    return {
      mapping: mapping,
      fingerprint: structureFingerprint(container),
      preview: modules.clone(normalized.slice(0, 5))
    };
  }

  function normalizeStatusConstruct(input, mapping) {
    var source = input === undefined ? { constants: [] } : input;
    assertOnlyKeys(source, ['constants'], 'construct');
    var constants = source.constants === undefined ? [] : source.constants;
    if (!Array.isArray(constants) || constants.length > 16) throw new Error('construct.constants必须是至多16项的数组');
    var occupied = [];
    if (mapping.name.from === 'path') occupied.push(JSON.stringify(mapping.name.path));
    Object.keys(mapping.fields).forEach(function (key) { occupied.push(JSON.stringify(mapping.fields[key].path)); });
    return {
      constants: constants.map(function (item, index) {
        assertOnlyKeys(item, ['path', 'value'], 'construct.constants[' + index + ']');
        var path = safeRelativePath(item.path, 'construct.constants[' + index + '].path');
        if (occupied.indexOf(JSON.stringify(path)) >= 0) throw new Error('固定常量不得覆盖Reader标准状态语义字段');
        var value = item.value;
        if (!(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
          throw new Error('固定构造常量只能是JSON标量');
        }
        return { path: path, value: value };
      })
    };
  }

  function setRelative(target, path, value) {
    var cursor = target;
    for (var index = 0; index < path.length - 1; index += 1) {
      var segment = path[index];
      var nextSegment = path[index + 1];
      if (!cursor[segment] || typeof cursor[segment] !== 'object') cursor[segment] = typeof nextSegment === 'number' ? [] : {};
      cursor = cursor[segment];
    }
    cursor[path[path.length - 1]] = modules.clone(value);
  }

  function canonicalStatus(input) {
    var source = modules.isObject(input) ? input : {};
    var output = {
      name: typeof source.name === 'string' ? source.name.trim().slice(0, 120) : '',
      effect: typeof source.effect === 'string' ? source.effect.trim().slice(0, 4000) : '',
      duration: typeof source.duration === 'string' ? source.duration.trim().slice(0, 500) : ''
    };
    if (!output.name || !output.effect || !output.duration) throw new Error('状态名字、效果和持续时间均为必需语义');
    if (typeof source.source === 'string' && source.source.trim()) output.source = source.source.trim().slice(0, 300);
    return output;
  }

  function buildStatusEntry(mapping, input) {
    var status = canonicalStatus(input);
    var entry = {};
    if (mapping.name.from === 'path') setRelative(entry, mapping.name.path, status.name);
    setRelative(entry, mapping.fields.effect.path, status.effect);
    setRelative(entry, mapping.fields.duration.path, status.duration);
    if (mapping.fields.source && status.source) setRelative(entry, mapping.fields.source.path, status.source);
    (mapping.construct && mapping.construct.constants || []).forEach(function (constant) {
      setRelative(entry, constant.path, constant.value);
    });
    return { status: status, entry: entry };
  }

  function insertStatusIfAbsent(mapping, container, input) {
    var built = buildStatusEntry(mapping, input);
    var current = normalizeContainer(mapping, container);
    var existing = current.find(function (item) { return item.name === built.status.name; });
    if (existing) return { inserted: false, status: modules.clone(existing) };
    if (mapping.containerKind === 'array') {
      if (!Array.isArray(container)) throw new Error('状态宿主容器不再是数组');
      container.push(built.entry);
      return { inserted: true, status: built.status, locator: { kind: 'array', index: container.length - 1 }, entry: modules.clone(built.entry) };
    }
    if (!modules.isObject(container)) throw new Error('状态宿主容器不再是对象表');
    if (Object.prototype.hasOwnProperty.call(container, built.status.name)) throw new Error('状态对象键已存在，无法安全插入');
    container[built.status.name] = built.entry;
    return { inserted: true, status: built.status, locator: { kind: 'key', key: built.status.name }, entry: modules.clone(built.entry) };
  }

  /* 已有同名状态则原地更新语义字段，否则插入；节奏调整这类“同名覆盖”的写入使用。 */
  function upsertStatus(mapping, container, input) {
    var built = buildStatusEntry(mapping, input);
    var entries = entriesFor(container, mapping.containerKind);
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      if (!entry.value || typeof entry.value !== 'object' || entryName(entry, mapping) !== built.status.name) continue;
      setRelative(entry.value, mapping.fields.effect.path, built.status.effect);
      setRelative(entry.value, mapping.fields.duration.path, built.status.duration);
      if (mapping.fields.source && built.status.source) setRelative(entry.value, mapping.fields.source.path, built.status.source);
      return { inserted: false, updated: true, status: built.status };
    }
    return insertStatusIfAbsent(mapping, container, input);
  }

  /* ---------- 背包 ---------- */
  function inventoryCount(raw) {
    var number = Math.floor(Number(raw));
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function readInventory(mapping, container) {
    var entries = entriesFor(container, mapping.containerKind);
    var output = [];
    entries.forEach(function (entry) {
      var name = entryName(entry, mapping);
      if (!name) return;
      var item = { name: name, key: entry.key, count: 1 };
      if (mapping.entryKind === 'count') {
        item.count = inventoryCount(entry.value);
        if (!item.count) return;
      } else if (mapping.entryKind !== 'name') {
        if (!entry.value || typeof entry.value !== 'object') return;
        if (mapping.fields.count) {
          var rawCount = readRelative(entry.value, mapping.fields.count.path, undefined);
          item.count = rawCount === undefined ? 1 : inventoryCount(rawCount);
          if (!item.count) return;
        }
        ['quality', 'type', 'description'].forEach(function (field) {
          if (!mapping.fields[field]) return;
          var value = readRelative(entry.value, mapping.fields[field].path, undefined);
          if (typeof value === 'string' && value.trim()) item[field] = value.trim();
        });
        if (mapping.fields.tags) {
          var tags = readRelative(entry.value, mapping.fields.tags.path, undefined);
          if (Array.isArray(tags)) item.tags = tags.filter(function (tag) { return typeof tag === 'string'; });
          else if (typeof tags === 'string' && tags.trim()) item.tags = tags.split(/[,，、\s]+/).filter(Boolean);
        }
        if (mapping.fields.effect) {
          var effect = readRelative(entry.value, mapping.fields.effect.path, undefined);
          if (typeof effect === 'string' || modules.isObject(effect)) item.effect = modules.clone(effect);
        }
      }
      output.push(item);
    });
    return output;
  }

  function effectText(effect) {
    if (typeof effect === 'string') return effect.trim();
    if (!modules.isObject(effect)) return '';
    return Object.keys(effect).map(function (key) { return key + '：' + String(effect[key]); }).join('；');
  }

  /* 宿主条目里没有对应字段的语义并进描述，信息不丢。 */
  function buildInventoryEntry(mapping, item) {
    var entry = {};
    var extras = [];
    if (mapping.name.from === 'path') setRelative(entry, mapping.name.path, item.name);
    if (mapping.fields.count) setRelative(entry, mapping.fields.count.path, item.count);
    if (item.quality) {
      if (mapping.fields.quality) setRelative(entry, mapping.fields.quality.path, item.quality);
      else extras.push('品质：' + item.quality);
    }
    if (item.type) {
      if (mapping.fields.type) setRelative(entry, mapping.fields.type.path, item.type);
      else extras.push('类型：' + item.type);
    }
    if (item.tags && item.tags.length) {
      if (mapping.fields.tags) setRelative(entry, mapping.fields.tags.path, item.tags.slice());
      else extras.push('标签：' + item.tags.join('、'));
    }
    var effect = effectText(item.effect);
    if (effect) {
      if (mapping.fields.effect) setRelative(entry, mapping.fields.effect.path, modules.isObject(item.effect) ? modules.clone(item.effect) : effect);
      else extras.push(effect);
    }
    var description = [String(item.description || '').trim()].concat(mapping.fields.description ? extras : []).filter(Boolean).join(' ');
    if (mapping.fields.description) { if (description) setRelative(entry, mapping.fields.description.path, description); }
    else if (mapping.fields.effect && !effect) {
      var folded = [String(item.description || '').trim()].concat(extras).filter(Boolean).join(' ');
      if (folded) setRelative(entry, mapping.fields.effect.path, folded);
    }
    (mapping.construct && mapping.construct.constants || []).forEach(function (constant) {
      setRelative(entry, constant.path, constant.value);
    });
    return entry;
  }

  function sameInventoryItem(existing, item) {
    if (existing.quality && item.quality && existing.quality !== item.quality) return false;
    if (existing.type && item.type && existing.type !== item.type) return false;
    if (existing.effect !== undefined && item.effect !== undefined) {
      var stringify = modules.stableStringify || JSON.stringify;
      if (stringify(existing.effect) !== stringify(item.effect)) return false;
    }
    return true;
  }

  var RESERVED_KEYS = ['__proto__', 'prototype', 'constructor'];
  var MAX_SEPARATE_PIECES = 99;

  function inventoryStackable(mapping) {
    return mapping.entryKind === 'count' || (mapping.entryKind !== 'name' && !!(mapping.fields && mapping.fields.count));
  }

  /* 不能叠加数量的背包：一件占一个条目。名字数组与数组容器直接再放一条；对象表（名字做键）找空位。 */
  function addSeparately(mapping, container, item, distinct) {
    var pieces = Math.min(MAX_SEPARATE_PIECES, item.count);
    var names = [];
    for (var piece = 0; piece < pieces; piece += 1) {
      var name = item.name;
      if (mapping.containerKind === 'object') {
        var alternative = item.name + '（' + distinct + '）';
        for (var suffix = 1; RESERVED_KEYS.indexOf(name) >= 0 || Object.prototype.hasOwnProperty.call(container, name); suffix += 1) {
          name = suffix === 1 ? alternative : alternative + suffix;
        }
      }
      if (mapping.entryKind === 'name') container.push(name);
      else {
        var entry = buildInventoryEntry(mapping, Object.assign({}, item, { name: name, count: 1 }));
        if (mapping.containerKind === 'array') container.push(entry);
        else container[name] = entry;
      }
      names.push(name);
    }
    return { name: names[0], names: names, stacked: false, count: pieces };
  }

  /*
   * 放入物品。能叠加数量时：同名且同品质、同效果则叠加；同名但不是同一件东西时改用
   * “名字（distinct）”“名字（distinct）2”……绝不覆盖宿主已有物品。
   * 不能叠加时（名字数组、没有数量字段的对象条目）一件占一个条目，见 addSeparately。
   * 返回实际使用的名字；分条放入时 names 是每一件的名字。
   */
  function addInventoryItem(mapping, container, input, options) {
    var source = modules.isObject(input) ? input : {};
    var baseName = typeof source.name === 'string' ? source.name.trim().slice(0, 120) : '';
    if (!baseName) throw new Error('物品名不能为空');
    var item = {
      name: baseName,
      count: Math.max(1, inventoryCount(source.count) || 1),
      quality: typeof source.quality === 'string' ? source.quality.trim().slice(0, 40) : '',
      type: typeof source.type === 'string' ? source.type.trim().slice(0, 40) : '',
      tags: Array.isArray(source.tags) ? source.tags.filter(function (tag) { return typeof tag === 'string' && tag.trim(); }).map(function (tag) { return tag.trim().slice(0, 80); }).slice(0, 16) : [],
      effect: typeof source.effect === 'string' || modules.isObject(source.effect) ? modules.clone(source.effect) : undefined,
      description: typeof source.description === 'string' ? source.description.trim().slice(0, 2000) : ''
    };
    if (mapping.containerKind === 'array' ? !Array.isArray(container) : !modules.isObject(container)) throw new Error('背包宿主容器类型已改变，请重新适配');
    var distinct = options && typeof options.distinct === 'string' && options.distinct.trim() ? options.distinct.trim().slice(0, 60) : '其二';
    if (!inventoryStackable(mapping)) return addSeparately(mapping, container, item, distinct);
    var current = readInventory(mapping, container);
    var byName = Object.create(null);
    current.forEach(function (entry) { if (!byName[entry.name]) byName[entry.name] = entry; });
    var name = item.name;
    var existing = byName[name];
    if (existing && mapping.entryKind === 'object' && !sameInventoryItem(existing, item)) {
      var alternative = item.name + '（' + distinct + '）';
      name = alternative;
      for (var suffix = 2; byName[name] && !sameInventoryItem(byName[name], item); suffix += 1) name = alternative + suffix;
      existing = byName[name];
    }
    item.name = name;
    if (existing) {
      var total = Math.min(9999, existing.count + item.count);
      if (mapping.entryKind === 'count') container[existing.key] = total;
      else setRelative(container[existing.key], mapping.fields.count.path, total);
      return { name: name, stacked: true, count: total };
    }
    if (mapping.entryKind === 'count') container[name] = item.count;
    else {
      var entry = buildInventoryEntry(mapping, item);
      if (mapping.containerKind === 'array') container.push(entry);
      else {
        if (Object.prototype.hasOwnProperty.call(container, name)) throw new Error('背包对象键已存在，无法安全放入：' + name);
        container[name] = entry;
      }
    }
    return { name: name, stacked: false, count: item.count };
  }

  /*
   * 移出若干件；数量不足时移出现有的全部。同名的条目按顺序逐个扣减（不能叠加时一个条目算一件），
   * 直到移够或没有了。返回实际移出的件数与同名剩余件数。
   */
  function removeInventoryItem(mapping, container, name, amount) {
    var want = Math.max(1, inventoryCount(amount) || 1);
    var target = String(name);
    var stackable = inventoryStackable(mapping);
    var matches = readInventory(mapping, container).filter(function (entry) { return entry.name === target; });
    var removed = 0;
    var emptied = [];
    for (var index = 0; index < matches.length && removed < want; index += 1) {
      var entry = matches[index];
      var have = stackable ? entry.count : 1;
      var take = Math.min(have, want - removed);
      removed += take;
      if (take >= have) emptied.push(entry.key);
      else if (mapping.entryKind === 'count') container[entry.key] = have - take;
      else setRelative(container[entry.key], mapping.fields.count.path, have - take);
    }
    if (mapping.containerKind === 'array') {
      emptied.sort(function (left, right) { return right - left; }).forEach(function (key) { container.splice(key, 1); });
    } else emptied.forEach(function (key) { delete container[key]; });
    var left = readInventory(mapping, container).reduce(function (sum, entry) {
      return entry.name === target ? sum + entry.count : sum;
    }, 0);
    return { removed: removed, left: left };
  }

  modules.SEMANTIC_SLOT_KEYS = SLOT_KEYS;
  modules.SEMANTIC_CONTAINER_SLOTS = CONTAINER_SLOTS;
  modules.isSemanticSlot = isSlot;
  modules.normalizeSemanticLocation = normalizeLocationValue;
  modules.validateSemanticLeaf = validateLeaf;
  modules.validateSemanticMapping = validateMapping;
  modules.normalizeSemanticContainer = normalizeContainer;
  modules.listSemanticContainerNames = listContainerNames;
  modules.normalizeSemanticPresence = normalizePresence;
  modules.semanticStructureFingerprint = structureFingerprint;
  modules.normalizeCanonicalStatus = canonicalStatus;
  modules.insertSemanticStatusIfAbsent = insertStatusIfAbsent;
  modules.upsertSemanticStatus = upsertStatus;
  modules.FALLBACK_INVENTORY_MAPPING = FALLBACK_INVENTORY_MAPPING;
  modules.readSemanticInventory = readInventory;
  modules.addSemanticInventoryItem = addInventoryItem;
  modules.removeSemanticInventoryItem = removeInventoryItem;
})(typeof globalThis !== 'undefined' ? globalThis : window);
