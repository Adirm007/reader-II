(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var CONTAINER_SLOTS = ['characters', 'tasks', 'skills', 'statuses', 'inventory'];
  var SLOT_LABELS = {
    characters: '重要角色',
    tasks: '任务',
    skills: '用户技能',
    statuses: '用户当前状态',
    inventory: '背包'
  };
  var SYSTEM_PROMPT = [
    '你是 Reader-II 宿主容器结构编译器，负责把用户锁定的宿主变量容器（MVU / 小白X）编译为 Reader-II DSL v1 的 JSON 映射。',
    '规则：',
    '1. 逐字保留用户锁定的 rootRef，所有相对路径用路径段数组表示并限定在该容器内部。',
    '2. 仅依据实际样本与世界书摘录中明示的字段结构填写映射；空容器且摘录无明确字段定义时返回空对象。',
    '3. 直接输出符合给定 JSON Schema 的纯 JSON 对象。'
  ].join('\n');

  var KNOWLEDGE = {
    characters: {
      purpose: 'Reader 需要角色名字、0～100好感、是否在场和身份；仅明确在场的角色会向提示词展示宿主条目全部变量。',
      name: '名字可来自对象键，或每个条目内的相对字段。',
      favor: '好感只使用 identity、linear(scale/offset) 或显式 enum 换算到 0～100。',
      present: 'present 指向布尔值或可明确识别为是/否、在场/离场的字段。',
      identity: 'identity 指向角色身份文本或文本数组。'
    },
    tasks: {
      purpose: 'Reader 只需要宿主任务名列表，用于章节任务触发时判重。',
      name: '任务名可来自对象键，或每个条目内的相对字段。'
    },
    skills: {
      purpose: 'Reader 只需要技能名列表，用于 hasSkill(name)。',
      name: '技能名可来自对象键，或每个条目内的相对字段。'
    },
    statuses: {
      purpose: 'Reader 需要状态的名字、效果文本和持续时间，来源可选。',
      name: '名字可来自对象键，或每个条目内的相对字段。',
      construct: 'construct.constants 只记录宿主新增状态时必需的固定 JSON 标量字段。'
    },
    inventory: {
      purpose: 'Reader 需要往主角背包放入、读取、移出物品（命运抽卡入包与回收）。',
      entryKind: 'object=每件物品是一个对象；count=“物品名: 数量”的对象表；name=物品名字符串数组。',
      name: 'entryKind=object 时名字可来自对象键或条目内相对字段；count 用 {"from":"key"}；name 用 {"from":"value"}。',
      fields: 'entryKind=object 时按宿主实际字段声明 count(数量)、quality(品质/稀有度)、type(类型)、tags(标签数组)、effect(效果，文本或对象)、description(描述)；宿主没有的字段不要写。',
      construct: 'construct.constants 只记录宿主新增物品时必需的固定 JSON 标量字段。'
    }
  };

  var DSL_SHAPES = {
    characters: { version: 1, slot: 'characters', rootRef: '<LOCKED_ROOT_REF>', containerKind: 'object|array', name: { from: 'key|path', path: ['from=path时的相对路径'] }, fields: { favor: { path: ['好感相对字段'], transform: { type: 'identity|linear|enum', scale: 1, offset: 0, values: { '枚举原值': 80 } } }, present: { path: ['在场状态相对字段'] }, identity: { path: ['身份相对字段'] } } },
    tasks: { version: 1, slot: 'tasks', rootRef: '<LOCKED_ROOT_REF>', containerKind: 'object|array', name: { from: 'key|path', path: ['from=path时的相对路径'] }, fields: {} },
    skills: { version: 1, slot: 'skills', rootRef: '<LOCKED_ROOT_REF>', containerKind: 'object|array', name: { from: 'key|path', path: ['from=path时的相对路径'] }, fields: {} },
    statuses: { version: 1, slot: 'statuses', rootRef: '<LOCKED_ROOT_REF>', containerKind: 'object|array', name: { from: 'key|path', path: ['from=path时的相对路径'] }, fields: { effect: { path: ['效果相对路径'] }, duration: { path: ['持续时间相对路径'] }, source: { path: ['可选来源相对路径'] } }, construct: { constants: [{ path: ['宿主必需固定字段'], value: '固定JSON标量' }] } },
    inventory: { version: 1, slot: 'inventory', rootRef: '<LOCKED_ROOT_REF>', containerKind: 'object|array', entryKind: 'object|count|name', name: { from: 'key|path|value', path: ['from=path时的相对路径'] }, fields: { count: { path: ['数量相对路径'] }, quality: { path: ['品质相对路径'] }, type: { path: ['类型相对路径'] }, tags: { path: ['标签相对路径'] }, effect: { path: ['效果相对路径'] }, description: { path: ['描述相对路径'] } }, construct: { constants: [{ path: ['宿主必需固定字段'], value: '固定JSON标量' }] } }
  };

  function extractJson(text) {
    var source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var start = source.indexOf('{');
    var end = source.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('LLM未返回JSON对象');
    try { return JSON.parse(source.slice(start, end + 1)); }
    catch (error) { throw new Error('LLM映射JSON解析失败'); }
  }

  function pathSchema() {
    return { type: 'array', minItems: 1, maxItems: 12, items: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'integer', minimum: 0 }] } };
  }

  function fieldSchema(withTransform) {
    var properties = { path: pathSchema() };
    if (withTransform) properties.transform = {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['identity', 'linear', 'enum'] },
        scale: { type: 'number' },
        offset: { type: 'number' },
        values: { type: 'object', minProperties: 1, additionalProperties: { type: 'number', minimum: 0, maximum: 100 } }
      }
    };
    return { type: 'object', additionalProperties: false, required: ['path'], properties: properties };
  }

  function mappingSchema(slot, rootRef) {
    var fieldsProperties = {};
    var fieldsRequired = [];
    if (slot === 'characters') {
      fieldsProperties.favor = fieldSchema(true);
      fieldsProperties.present = fieldSchema(false);
      fieldsProperties.identity = fieldSchema(false);
      fieldsRequired = ['favor'];
    } else if (slot === 'statuses') {
      fieldsProperties.effect = fieldSchema(false);
      fieldsProperties.duration = fieldSchema(false);
      fieldsProperties.source = fieldSchema(false);
      fieldsRequired = ['effect', 'duration'];
    } else if (slot === 'inventory') {
      ['count', 'quality', 'type', 'tags', 'effect', 'description'].forEach(function (field) { fieldsProperties[field] = fieldSchema(false); });
    }
    var properties = {
      version: { type: 'integer', enum: [1] },
      slot: { type: 'string', enum: [slot] },
      rootRef: rootRef === undefined ? { type: 'string' } : { type: 'string', enum: [rootRef] },
      containerKind: { type: 'string', enum: ['object', 'array'] },
      name: {
        type: 'object',
        additionalProperties: false,
        required: ['from'],
        properties: { from: { type: 'string', enum: slot === 'inventory' ? ['key', 'path', 'value'] : ['key', 'path'] }, path: pathSchema() }
      },
      fields: { type: 'object', additionalProperties: false, required: fieldsRequired, properties: fieldsProperties }
    };
    // 助手传的是映射草案；版本、槽、根和容器类型由 adapt_variables 从实际目标补齐。
    var required = rootRef === undefined
      ? (fieldsRequired.length ? ['name', 'fields'] : ['name'])
      : ['version', 'slot', 'rootRef', 'containerKind', 'name', 'fields'];
    if (slot === 'inventory') properties.entryKind = { type: 'string', enum: ['object', 'count', 'name'] };
    if (slot === 'statuses' || slot === 'inventory') {
      properties.construct = {
        type: 'object',
        additionalProperties: false,
        properties: {
          constants: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'value'],
              properties: {
                path: pathSchema(),
                value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] }
              }
            }
          }
        }
      };
    }
    return { type: 'object', additionalProperties: false, required: required, properties: properties };
  }

  function schemaEnvelope(name, description, value) {
    return { name: name, description: description, value: value };
  }

  /* 用当前卡与聊天的变量定义辅助空容器。只读相关世界书，示例只存在于内存。 */
  async function readRules(kit, allowed) {
    var chat = kit.chatKey();
    var books = await kit.linkedWorldbooks();
    var rules = [];
    for (var book of books) {
      if (kit.chatKey() !== chat) throw new Error('聊天已改变，请重新适配');
      if (allowed && !allowed(book)) continue;
      var entries;
      try { entries = await kit.readWorldbook(book); } catch (error) { continue; }
      if (kit.chatKey() !== chat) throw new Error('聊天已改变，请重新适配');
      if (allowed && !allowed(book)) continue;
      entries.forEach(function (entry) {
        var name = String(entry.name || entry.comment || '');
        if (/Reader-II|读者核心/i.test(name) || !/initvar|mvu[_ -]?update|变量.*(?:规则|更新|结构|定义|初始)|(?:初始化|更新).*变量|variable.*(?:rule|schema|update)|schema/i.test(name)) return;
        if (entry.enabled === false && !/initvar|初始/i.test(name)) return;
        if (allowed && (!allowed(book, name) || (entry.uid != null && !allowed(book, name + '#' + entry.uid)))) return;
        if (typeof entry.content === 'string') rules.push({ source: '《' + book + '》的「' + name + '」', text: entry.content });
      });
    }
    return rules;
  }

  function documentedSample(input, segments, kind) {
    var owns = function (value, key) { return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key); };
    var matches = function (value) {
      return (kind === 'array' ? Array.isArray(value) : modules.isObject(value)) && Object.keys(value).length > 0;
    };
    var data = owns(input, 'stat_data') ? input.stat_data : input;
    for (var key of segments) data = owns(data, key) ? data[key] : undefined;
    if (matches(data)) return data;
    /* 世界书也常给出 JSON Patch 示例，如 /羁绊列表/角色名。 */
    var operations = Array.isArray(input) ? input : [input];
    for (var op of operations) {
      if (!op || (op.op !== 'add' && op.op !== 'replace') || typeof op.path !== 'string' || op.path[0] !== '/') continue;
      var path = op.path.slice(1).split('/').map(function (part) { return part.replace(/~1/g, '/').replace(/~0/g, '~'); });
      if (path[0] === 'stat_data') path.shift();
      if (!segments.every(function (segment, i) { return String(segment) === path[i]; })) continue;
      if (path.length === segments.length && matches(op.value)) return op.value;
      if (path.length === segments.length + 1 && op.value !== undefined) {
        var name = path[path.length - 1];
        if (kind === 'array') {
          if (name === '-' || /^\d+$/.test(name)) return [op.value];
        } else if (name && !['__proto__', 'constructor', 'prototype'].includes(name)) {
          var example = {}; example[name] = op.value;
          return example;
        }
      }
    }
    return null;
  }

  function evidenceFor(path, kind, rules) {
    var segments = path.slice(1);
    var leaf = String(segments[segments.length - 1]);
    var excerpts = [];
    var sources = [];
    for (var rule of rules || []) {
      if (!rule.text.includes(leaf)) continue;
      var blocks = [rule.text];
      var fences = /(?:\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60|<JSONPatch>\s*([\s\S]*?)<\/JSONPatch>)/gi;
      var match;
      while ((match = fences.exec(rule.text))) blocks.push(match[1] || match[2]);
      for (var block of blocks) {
        var json;
        try { json = JSON.parse(block.trim()); } catch (error) { continue; }
        var sample = documentedSample(json, segments, kind);
        if (sample) return { sample: sample, source: rule.source };
      }
      /* YAML 规则按缩进取本节，保留父路径信息，不把别的槽或整本世界书送进模型。 */
      var lines = rule.text.split(/\r?\n/);
      var parents = [];
      for (var i = 0; i < lines.length && excerpts.length < 5; i += 1) {
        var heading = /^(\s*)["']?([^:"']+)["']?\s*:\s*(.*)$/.exec(lines[i]);
        if (!heading) continue;
        var indent = heading[1].length;
        var key = heading[2].trim();
        while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop();
        var chain = parents.map(function (item) { return item.key; }).concat(key);
        parents.push({ key: key, indent: indent });
        var fullPath = segments.join('.');
        while (chain.length > 1 && /^(?:stat_data|variables?|variable_update_rules|rules|变量|变量规则|变量更新规则|变量结构)$/i.test(chain[0])) chain.shift();
        if (chain.join('.') !== fullPath) continue;
        var end = i + 1;
        while (end < lines.length && (!lines[end].trim() || /^\s*/.exec(lines[end])[0].length > indent)) end += 1;
        var section = lines.slice(i, end).join('\n').slice(0, 6000);
        if (section.trim().endsWith(':')) continue;
        excerpts.push(section);
        if (!sources.includes(rule.source)) sources.push(rule.source);
      }
    }
    return excerpts.length ? { text: excerpts.join('\n\n').slice(0, 12000), source: sources.join('、') } : null;
  }

  function checkEvidence(mapping, evidence, slot, ref) {
    if (!evidence) return;
    if (!modules.isObject(mapping) || !modules.isObject(mapping.fields)) throw new Error('变量规则没有给出此容器的映射');
    var paths = Object.values(mapping.fields).map(function (field) { return field && field.path; });
    if (mapping.name && mapping.name.from === 'path') paths.push(mapping.name.path);
    for (var constant of mapping.construct && mapping.construct.constants || []) {
      paths.push(constant.path);
      if (!evidence.sample && !evidence.text.includes(String(constant.value))) throw new Error('构造常量没有出现在该根变量规则中');
    }
    if (evidence.sample) modules.validateSemanticMapping(slot, mapping, ref, evidence.sample);
    if (!evidence.sample && slot === 'inventory') {
      var kind = mapping.entryKind || 'object';
      if ((kind === 'count' && !/number|integer|int\b|整数|数值|数量|计数/i.test(evidence.text))
        || (kind === 'name' && !/string|字符串|名称数组|名字数组/i.test(evidence.text))
        || (kind === 'object' && !paths.length)) throw new Error('变量规则未能确认空背包的条目形状');
    }
    var supported = function (path) {
      if (!Array.isArray(path)) return false;
      if (!evidence.sample) return path.every(function (part) { return typeof part !== 'string' || evidence.text.includes(part); });
      return Object.values(evidence.sample).some(function (entry) {
        for (var segment of path) {
          if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(entry, segment)) return false;
          entry = entry[segment];
        }
        return true;
      });
    };
    if (!paths.every(supported)) throw new Error('映射用了该根变量规则里没有的字段');
  }

  function createAdaptationLlm(hostAdapter, semanticRouter, runtimeStore, llmGateway, kit) {
    function slotCaption(slot, summary, rootRef) {
      var path = summary && summary.displayPath || rootRef || '';
      return (SLOT_LABELS[slot] || slot) + '容器' + (path ? '（' + path + '）' : '');
    }

    async function slotPayload(slot, rootRef, evidence, loadRules) {
      var chat = kit.chatKey();
      if (CONTAINER_SLOTS.indexOf(slot) < 0) throw new Error('只有容器槽需要LLM适配');
      var route = rootRef ? { rootRef: rootRef } : semanticRouter.getRoute(slot);
      if (!rootRef && route.status !== 'draft') throw new Error('请先手动选择并锁定宿主容器根');
      var summary;
      try { summary = await hostAdapter.summarizeHostRef(route.rootRef); }
      catch (error) {
        throw new Error(slotCaption(slot, null, route.rootRef) + '读取失败：' + (error.message || String(error)));
      }
      var structure = summary.structure;
      var empty = (structure.type === 'array' && structure.length === 0)
        || (structure.type === 'object' && Object.keys(structure.fields || {}).length === 0);
      if (empty) {
        if (evidence === undefined) {
          var path = JSON.parse(decodeURIComponent(route.rootRef.slice(8)));
          evidence = evidenceFor(path, summary.rootType, await (loadRules ? loadRules() : readRules(kit)));
        }
        if (!evidence && !(['tasks', 'skills'].includes(slot) && summary.rootType === 'object')) {
          throw new Error(slotCaption(slot, summary, route.rootRef) + '为空，绑定世界书中未找到该路径的条目结构。可用指定根路径和映射完成适配');
        }
      }
      if (kit.chatKey() !== chat) throw new Error('聊天已改变，请重新适配');
      var shape = modules.clone(DSL_SHAPES[slot]);
      shape.rootRef = route.rootRef;
      return {
        slot: slot,
        route: route,
        summary: summary,
        evidence: empty ? evidence : null,
        knowledge: modules.clone(KNOWLEDGE[slot]),
        dslShape: shape
      };
    }

    function payloadText(payload) {
      return [
        '【本次槽位】' + payload.slot,
        '【内置适配知识】' + JSON.stringify(payload.knowledge),
        '【DSL v1 目标形状】' + JSON.stringify(payload.dslShape),
        '【name写法】对象键就是名字时只输出 {"from":"key"}；名字位于条目内部字段时输出 {"from":"path","path":["相对字段"]}。',
        '【用户锁定根】' + JSON.stringify({ rootRef: payload.route.rootRef, displayPath: payload.summary.displayPath, rootType: payload.summary.rootType }),
        '【根内结构摘要】' + JSON.stringify(payload.summary.structure),
        payload.evidence ? '【此路径的变量定义，来源' + payload.evidence.source + '】\n' + (payload.evidence.text || JSON.stringify(modules.readerOutlineValue(payload.evidence.sample, 0, 4)).slice(0, 12000)) : '',
        '输出 version=1、slot=' + payload.slot + '，rootRef 逐字复用用户锁定值。'
      ].join('\n');
    }

    async function buildRequest(slot, ref, evidence) {
      var payload = await slotPayload(slot, ref, evidence);
      var userInput = payloadText(payload);
      return {
        slot: slot,
        rootRef: payload.route.rootRef,
        summary: payload.summary,
        evidence: payload.evidence,
        knowledge: payload.knowledge,
        dslShape: payload.dslShape,
        systemPrompt: SYSTEM_PROMPT,
        userInput: userInput,
        prompt: SYSTEM_PROMPT + '\n\n' + userInput,
        jsonSchema: schemaEnvelope('reader_mapping_' + slot, 'Reader-II ' + slot + ' 容器映射', mappingSchema(slot, payload.route.rootRef))
      };
    }

    async function buildBatchRequest() {
      var lockedSlots = CONTAINER_SLOTS.filter(function (slot) {
        return semanticRouter.getRoute(slot).status === 'draft';
      });
      if (lockedSlots.length < 2) throw new Error('批量分析至少需要两个已锁定、待分析的容器');
      var rules;
      function loadRules() { if (!rules) rules = readRules(kit); return rules; }
      var inspected = await Promise.all(lockedSlots.map(async function (slot) {
        try { return { payload: await slotPayload(slot, null, undefined, loadRules), error: null }; }
        catch (error) { return { payload: null, error: error }; }
      }));
      var failures = inspected.filter(function (item) { return item.error; });
      if (failures.length) {
        throw new Error('批量预检未通过：\n' + failures.map(function (item) {
          return '- ' + (item.error.message || String(item.error));
        }).join('\n'));
      }
      var payloads = inspected.map(function (item) { return item.payload; });
      var schemaProperties = {};
      payloads.forEach(function (payload) { schemaProperties[payload.slot] = mappingSchema(payload.slot, payload.route.rootRef); });
      var userInput = [
        '批量分析下列 ' + lockedSlots.length + ' 个已锁定容器。各槽映射相互独立。',
        '输出一个顶层 JSON 对象，只包含本次列出的槽位键：' + lockedSlots.join('、') + '。',
        payloads.map(payloadText).join('\n\n')
      ].join('\n\n');
      return {
        slots: lockedSlots.slice(),
        payloads: payloads,
        systemPrompt: SYSTEM_PROMPT,
        userInput: userInput,
        prompt: SYSTEM_PROMPT + '\n\n' + userInput,
        jsonSchema: schemaEnvelope('reader_mapping_locked_containers', 'Reader-II 已锁定容器批量映射', {
          type: 'object',
          additionalProperties: false,
          required: lockedSlots.slice(),
          properties: schemaProperties
        })
      };
    }

    async function compile(slot, ref, evidence) {
      var request = await buildRequest(slot, ref, evidence);
      var result = await llmGateway.generate({
        system: request.systemPrompt,
        userInput: request.userInput,
        jsonSchema: request.jsonSchema,
        maxChatHistory: 0,
        shouldSilence: true,
        route: 'adapt',
        generationId: 'reader-adapt-' + slot + '-' + Date.now()
      });
      var mapping = extractJson(result);
      checkEvidence(mapping, request.evidence, slot, request.rootRef);
      return mapping;
    }

    async function analyze(slot) {
      var stillCurrent = semanticRouter.bindingGuard(slot);
      var mapping = await compile(slot);
      stillCurrent();
      return semanticRouter.validateMappingDraft(slot, mapping);
    }

    async function analyzeBatch() {
      var checks = CONTAINER_SLOTS.filter(function (slot) { return semanticRouter.getRoute(slot).status === 'draft'; })
        .map(function (slot) { return semanticRouter.bindingGuard(slot); });
      var request = await buildBatchRequest();
      var result = await llmGateway.generate({
        system: request.systemPrompt,
        userInput: request.userInput,
        jsonSchema: request.jsonSchema,
        maxChatHistory: 0,
        shouldSilence: true,
        route: 'adapt',
        generationId: 'reader-adapt-all-' + Date.now()
      });
      var mappings = extractJson(result);
      checks.forEach(function (check) { check(); });
      request.payloads.forEach(function (payload) { checkEvidence(mappings[payload.slot], payload.evidence, payload.slot, payload.route.rootRef); });
      return semanticRouter.validateMappingBatchDraft(mappings, request.slots);
    }

    function getPreview(slot) {
      var runtime = runtimeStore.read();
      return modules.clone(runtime.mappingDrafts[slot] || null);
    }

    return {
      readRules: function (allowed) { return readRules(kit, allowed); },
      evidenceFor: evidenceFor,
      compile: compile,
      buildRequest: buildRequest,
      buildBatchRequest: buildBatchRequest,
      analyze: analyze,
      analyzeBatch: analyzeBatch,
      getPreview: getPreview
    };
  }

  modules.READER_ADAPTATION_SYSTEM_PROMPT = SYSTEM_PROMPT;
  modules.READER_ADAPTATION_KNOWLEDGE = KNOWLEDGE;
  modules.readerAdaptMappingsSchema = function () {
    var properties = {};
    CONTAINER_SLOTS.forEach(function (slot) { properties[slot] = mappingSchema(slot); });
    return { type: 'object', additionalProperties: false, properties: properties };
  };
  modules.createAdaptationLlm = createAdaptationLlm;
})(typeof globalThis !== 'undefined' ? globalThis : window);
