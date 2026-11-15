(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var STORE_KEY = 'reader_ii_runtime';
  var PROMPTS_KEY = 'reader_ii_active_prompts';

  function defaultRouting() {
    var output = {};
    ['location', 'characters', 'tasks', 'skills', 'statuses', 'currency', 'inventory'].forEach(function (slot) {
      output[slot] = { status: 'unbound', rootRef: '', brokenReason: '' };
    });
    return output;
  }

  function normalizeRoute(input) {
    var source = modules.isObject(input) ? input : {};
    var status = ['unbound', 'draft', 'active', 'broken'].indexOf(source.status) >= 0
      ? source.status
      : 'unbound';
    var rootRef = typeof source.rootRef === 'string' && source.rootRef.indexOf('hostref:') === 0
      ? source.rootRef.slice(0, 4096)
      : '';
    if (!rootRef) status = 'unbound';
    return {
      status: status,
      rootRef: rootRef,
      brokenReason: status === 'broken' ? String(source.brokenReason || '').slice(0, 500) : ''
    };
  }

  function normalizeRouting(input) {
    var source = modules.isObject(input) ? input : {};
    var output = defaultRouting();
    Object.keys(output).forEach(function (slot) { output[slot] = normalizeRoute(source[slot]); });
    return output;
  }

  function sanitizePlainData(value, depth) {
    if (depth > 20) return undefined;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
      if (value.length > 12000 || /(?:<%|%>|=>|\bfunction\b|javascript:|\beval\s*\(|\bnew\s+Function\b)/i.test(value)) return undefined;
      return value;
    }
    if (Array.isArray(value)) {
      var list = [];
      value.slice(0, 100).forEach(function (item) {
        var clean = sanitizePlainData(item, depth + 1);
        if (clean !== undefined) list.push(clean);
      });
      return list;
    }
    if (!modules.isObject(value)) return undefined;
    var output = {};
    Object.keys(value).slice(0, 100).forEach(function (key) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') return;
      var clean = sanitizePlainData(value[key], depth + 1);
      if (clean !== undefined) output[key] = clean;
    });
    return output;
  }

  function sanitizeSlotRecord(input) {
    var source = modules.isObject(input) ? input : {};
    var output = {};
    ['characters', 'tasks', 'skills', 'statuses', 'inventory'].forEach(function (slot) {
      var clean = sanitizePlainData(source[slot], 0);
      if (modules.isObject(clean)) output[slot] = clean;
    });
    return output;
  }

  function sanitizeFingerprints(input) {
    var source = modules.isObject(input) ? input : {};
    var output = {};
    ['characters', 'tasks', 'skills', 'statuses', 'inventory'].forEach(function (slot) {
      if (typeof source[slot] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(source[slot])) output[slot] = source[slot];
    });
    return output;
  }

  function defaultRuntimeState() {
    return {
      settledEvents: {},
      assistantTransactions: {},
      routing: defaultRouting(),
      semanticMappings: {},
      mappingDrafts: {},
      schemaFingerprints: {},
      customConditions: {
        personas: {},
        transactions: {}
      }
    };
  }

  function normalizeRuntimeState(input) {
    var source = modules.isObject(input) ? input : {};
    var custom = modules.isObject(source.customConditions) ? source.customConditions : {};
    return {
      settledEvents: modules.safeRecord(source.settledEvents),
      assistantTransactions: modules.safeRecord(source.assistantTransactions),
      routing: normalizeRouting(source.routing),
      semanticMappings: sanitizeSlotRecord(source.semanticMappings),
      mappingDrafts: sanitizeSlotRecord(source.mappingDrafts),
      schemaFingerprints: sanitizeFingerprints(source.schemaFingerprints),
      customConditions: {
        personas: modules.safeRecord(custom.personas),
        transactions: modules.safeRecord(custom.transactions)
      }
    };
  }

  function createRuntimeStore(env) {
    var memory = defaultRuntimeState();

    function context() {
      try {
        var host = env && env.host;
        var tavern = host && host.SillyTavern;
        return tavern && typeof tavern.getContext === 'function' ? tavern.getContext() : null;
      } catch (error) {
        return null;
      }
    }

    function variables() {
      var ctx = context();
      if (ctx && ctx.chatMetadata) {
        if (!modules.isObject(ctx.chatMetadata.variables)) ctx.chatMetadata.variables = {};
        return ctx.chatMetadata.variables;
      }
      if (env && typeof env.getVariables === 'function') {
        try { return env.getVariables({ type: 'chat' }) || {}; }
        catch (error) { /* use in-memory fallback */ }
      }
      return null;
    }

    function read() {
      var vars = variables();
      var raw = vars && vars[STORE_KEY];
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (error) { raw = null; }
      }
      memory = normalizeRuntimeState(raw || memory);
      return modules.clone(memory);
    }

    function persist(state) {
      memory = normalizeRuntimeState(state);
      var vars = variables();
      if (vars) vars[STORE_KEY] = modules.clone(memory);
      var ctx = context();
      if (ctx && typeof ctx.saveMetadata === 'function') {
        try { ctx.saveMetadata(); } catch (error) { /* persistence is best-effort */ }
      } else if (env && typeof env.insertOrAssignVariables === 'function') {
        try {
          var payload = {};
          payload[STORE_KEY] = modules.clone(memory);
          env.insertOrAssignVariables(payload, { type: 'chat' });
        } catch (error) { /* retain in-memory state */ }
      }
      return modules.clone(memory);
    }

    function mutate(updater) {
      var state = read();
      var result = updater(state);
      persist(state);
      return result;
    }

    function setActivePrompts(prompts) {
      var list = Array.isArray(prompts) ? prompts.map(String).slice(0, 12) : [];
      var vars = variables();
      if (vars) vars[PROMPTS_KEY] = JSON.stringify(list);
      var ctx = context();
      if (ctx && typeof ctx.saveMetadata === 'function') {
        try { ctx.saveMetadata(); } catch (error) { /* best-effort */ }
      } else if (env && typeof env.insertOrAssignVariables === 'function') {
        try {
          var payload = {};
          payload[PROMPTS_KEY] = JSON.stringify(list);
          env.insertOrAssignVariables(payload, { type: 'chat' });
        } catch (error) { /* EJS will use an empty list */ }
      }
      return list;
    }

    function getActivePrompts() {
      var vars = variables();
      var raw = vars && vars[PROMPTS_KEY];
      if (Array.isArray(raw)) return raw.map(String).slice(0, 12);
      if (typeof raw === 'string') {
        try {
          var parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.map(String).slice(0, 12) : [];
        } catch (error) { return []; }
      }
      return [];
    }

    return {
      key: STORE_KEY,
      promptsKey: PROMPTS_KEY,
      read: read,
      persist: persist,
      mutate: mutate,
      setActivePrompts: setActivePrompts,
      getActivePrompts: getActivePrompts
    };
  }

  modules.defaultRuntimeState = defaultRuntimeState;
  modules.normalizeRuntimeState = normalizeRuntimeState;
  modules.defaultSemanticRouting = defaultRouting;
  modules.normalizeSemanticRouting = normalizeRouting;
  modules.createRuntimeStore = createRuntimeStore;
})(typeof globalThis !== 'undefined' ? globalThis : window);
