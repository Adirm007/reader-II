(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var VERSION = '4.0.0';

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); }
    catch (error) { return value; }
  }

  function safeRecord(value) {
    if (!isObject(value)) return {};
    var output = {};
    Object.keys(value).forEach(function (key) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') return;
      output[key] = clone(value[key]);
    });
    return output;
  }

  function copyPresent(source, fields) {
    var output = {};
    if (!isObject(source)) return output;
    fields.forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(source, field)) output[field] = clone(source[field]);
    });
    return output;
  }

  function normalizeRecordMap(value, normalizer) {
    if (!isObject(value)) return {};
    var output = {};
    Object.keys(value).forEach(function (key) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') return;
      if (!isObject(value[key])) return;
      output[key] = normalizer(value[key]);
    });
    return output;
  }

  function normalizeSkills(value) {
    return normalizeRecordMap(value, function (skill) {
      return copyPresent(skill, ['消耗', '标签', '效果', '描述']);
    });
  }

  function normalizeTasks(value) {
    return normalizeRecordMap(value, function (task) {
      return copyPresent(task, ['状态', '详情', '目标', '奖励']);
    });
  }

  function normalizeStatuses(value) {
    return normalizeRecordMap(value, function (status) {
      return copyPresent(status, ['类型', '效果', '层数', '剩余时间', '来源']);
    });
  }

  function normalizeItems(value) {
    return normalizeRecordMap(value, function (item) {
      return copyPresent(item, ['数量', '品质', '类型', '标签', '效果', '描述']);
    });
  }

  function normalizeRelationships(value) {
    return normalizeRecordMap(value, function (relation) {
      var output = copyPresent(relation, [
        '在场', '身份', '状态效果', '背包', '装备', '性格',
        '外貌', '着装', '好感度', '心里话', '背景故事'
      ]);
      if (Object.prototype.hasOwnProperty.call(relation, '技能')) output.技能 = normalizeSkills(relation.技能);
      return output;
    });
  }

  function finiteNonNegativeInteger(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
  }

  /*
   * Reader-II 的唯一 MVU 白名单。
   * 输出只由当前仍使用后备的语义槽组成。
   */
  function routeUsesFallback(routing, slot) {
    var route = routing && routing[slot];
    return !route || route.status === 'unbound' || route.status === 'draft';
  }

  function defaultReaderState(routing, keepProgress) {
    return normalizeReaderState({}, routing, keepProgress !== false);
  }

  function normalizeReaderState(input, routing, keepProgress) {
    var source = isObject(input) ? input : {};
    var world = isObject(source.世界) ? source.世界 : {};
    var protagonist = isObject(source.主角) ? source.主角 : {};
    var eventState = isObject(source.事件) ? source.事件 : {};
    var location = typeof source.地点 === 'string' ? source.地点 : world.地点;
    var progress = Object.prototype.hasOwnProperty.call(source, '进度') ? source.进度 : eventState.进度;

    var output = {};
    if (routeUsesFallback(routing, 'location')) output.地点 = typeof location === 'string' ? location : '';
    if (routeUsesFallback(routing, 'characters')) output.关系列表 = normalizeRelationships(source.关系列表);
    if (routeUsesFallback(routing, 'tasks')) output.任务列表 = normalizeTasks(source.任务列表);
    var protagonistOutput = {};
    if (routeUsesFallback(routing, 'skills')) protagonistOutput.技能 = normalizeSkills(protagonist.技能);
    if (routeUsesFallback(routing, 'statuses')) protagonistOutput.状态效果 = normalizeStatuses(protagonist.状态效果);
    if (Object.keys(protagonistOutput).length) output.主角 = protagonistOutput;
    if (routeUsesFallback(routing, 'currency')) output.命运点数 = finiteNonNegativeInteger(source.命运点数, 0);
    /* 后备背包按需出现：第一次放入物品时才创建，空了就不再保留。 */
    if (routeUsesFallback(routing, 'inventory') && isObject(source.背包)) {
      var items = normalizeItems(source.背包);
      if (Object.keys(items).length) output.背包 = items;
    }
    if (keepProgress !== false) output.进度 = finiteNonNegativeInteger(progress, 0);
    return output;
  }

  function ensureReaderNamespace(mvuData, fallbackReader, routing, keepProgress) {
    var data = isObject(mvuData) ? mvuData : {};
    if (!isObject(data.stat_data)) data.stat_data = {};
    var current = isObject(data.stat_data.READER) ? data.stat_data.READER : fallbackReader;
    var normalized = normalizeReaderState(current, routing, keepProgress);
    if (Object.keys(normalized).length) data.stat_data.READER = normalized;
    else delete data.stat_data.READER;
    return data;
  }

  function createMvuGuard(env, runtimeStore, chatKey) {
    var lastReader = null;
    var lastReaderChat = null;
    var installed = false;

    function isKuromaku() {
      if (!env || typeof env.getVariables !== 'function') return false;
      try {
        var variables = env.getVariables({ type: 'chat' }) || {};
        return variables.dream_persona === 'kuromaku';
      } catch (error) { return false; }
    }

    function remember(data) {
      if (data && data.stat_data && data.stat_data.READER) {
        lastReaderChat = chatKey();
        lastReader = normalizeReaderState(data.stat_data.READER, runtimeStore && runtimeStore.read().routing, isKuromaku());
      }
      return data;
    }

    function guard(data, previous) {
      var fallback = previous && previous.stat_data && previous.stat_data.READER;
      if (!fallback && lastReaderChat === chatKey()) fallback = lastReader;
      var routing = runtimeStore && runtimeStore.read ? runtimeStore.read().routing : undefined;
      ensureReaderNamespace(data, fallback, routing, isKuromaku());
      remember(data);
      return data;
    }

    function install(mvu) {
      if (installed || !mvu || !mvu.events || typeof env.eventOn !== 'function') return;
      installed = true;
      env.eventOn(mvu.events.VARIABLE_INITIALIZED, function (variables) { guard(variables); });
      env.eventOn(mvu.events.VARIABLE_UPDATE_STARTED, function (variables) { remember(variables); });
      env.eventOn(mvu.events.VARIABLE_UPDATE_ENDED, function (variables, before) { guard(variables, before); });
      env.eventOn(mvu.events.BEFORE_MESSAGE_UPDATE, function (context) {
        if (context && context.variables) guard(context.variables);
      });
    }

    return {
      install: install,
      guard: guard,
      remember: remember
    };
  }

  modules.VERSION = VERSION;
  modules.isObject = isObject;
  modules.clone = clone;
  modules.safeRecord = safeRecord;
  modules.normalizeSkills = normalizeSkills;
  modules.normalizeTasks = normalizeTasks;
  modules.normalizeStatuses = normalizeStatuses;
  modules.normalizeRelationships = normalizeRelationships;
  modules.normalizeItems = normalizeItems;
  modules.defaultReaderState = defaultReaderState;
  modules.createDefaultReaderState = defaultReaderState;
  modules.normalizeReaderState = normalizeReaderState;
  modules.ensureReaderNamespace = ensureReaderNamespace;
  modules.createMvuGuard = createMvuGuard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
