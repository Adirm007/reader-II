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
    '你是 Reader-II 宿主容器结构编译器。',
    '你的唯一任务是把用户已锁定的宿主 MVU 容器翻译为 Reader-II DSL v1。',
    '映射是纯 JSON 数据，不是代码；相对路径使用路径段数组。',
    '用户锁定的 rootRef 必须逐字保留，映射不得越出该根。',
    '严格按请求的 JSON Schema 输出，不附加解释或 Markdown。'
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
      fieldsRequired = ['favor', 'present', 'identity'];
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
      rootRef: { type: 'string', enum: [rootRef] },
      containerKind: { type: 'string', enum: ['object', 'array'] },
      name: {
        type: 'object',
        additionalProperties: false,
        required: ['from'],
        properties: { from: { type: 'string', enum: slot === 'inventory' ? ['key', 'path', 'value'] : ['key', 'path'] }, path: pathSchema() }
      },
      fields: { type: 'object', additionalProperties: false, required: fieldsRequired, properties: fieldsProperties }
    };
    var required = ['version', 'slot', 'rootRef', 'containerKind', 'name', 'fields'];
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

  function createAdaptationLlm(hostAdapter, semanticRouter, runtimeStore, llmGateway) {
    function slotCaption(slot, summary, rootRef) {
      var path = summary && summary.displayPath || rootRef || '';
      return (SLOT_LABELS[slot] || slot) + '容器' + (path ? '（' + path + '）' : '');
    }

    async function slotPayload(slot) {
      if (CONTAINER_SLOTS.indexOf(slot) < 0) throw new Error('只有容器槽需要LLM适配');
      var route = semanticRouter.getRoute(slot);
      if (route.status !== 'draft') throw new Error('请先手动选择并锁定宿主容器根');
      var summary;
      try { summary = await hostAdapter.summarizeHostRef(route.rootRef); }
      catch (error) {
        throw new Error(slotCaption(slot, null, route.rootRef) + '读取失败：' + (error.message || String(error)));
      }
      var structure = summary.structure;
      var empty = (structure.type === 'array' && structure.length === 0)
        || (structure.type === 'object' && Object.keys(structure.fields || {}).length === 0);
      if (empty) {
        throw new Error(slotCaption(slot, summary, route.rootRef) + '为空，没有可分析样例；请等该容器出现至少一条真实数据后重试，或取消锁定它再批量分析其他容器');
      }
      var shape = modules.clone(DSL_SHAPES[slot]);
      shape.rootRef = route.rootRef;
      return {
        slot: slot,
        route: route,
        summary: summary,
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
        '输出 version=1、slot=' + payload.slot + '，rootRef 逐字复用用户锁定值。'
      ].join('\n');
    }

    async function buildRequest(slot) {
      var payload = await slotPayload(slot);
      var userInput = payloadText(payload);
      return {
        slot: slot,
        rootRef: payload.route.rootRef,
        summary: payload.summary,
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
      var inspected = await Promise.all(lockedSlots.map(async function (slot) {
        try { return { payload: await slotPayload(slot), error: null }; }
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

    async function analyze(slot) {
      var request = await buildRequest(slot);
      var result = await llmGateway.generate({
        system: request.systemPrompt,
        userInput: request.userInput,
        jsonSchema: request.jsonSchema,
        maxChatHistory: 0,
        shouldSilence: true,
        route: 'adapt',
        generationId: 'reader-adapt-' + slot + '-' + Date.now()
      });
      return semanticRouter.validateMappingDraft(slot, extractJson(result));
    }

    async function analyzeBatch() {
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
      return semanticRouter.validateMappingBatchDraft(extractJson(result), request.slots);
    }

    function getPreview(slot) {
      var runtime = runtimeStore.read();
      return modules.clone(runtime.mappingDrafts[slot] || null);
    }

    return {
      buildRequest: buildRequest,
      buildBatchRequest: buildBatchRequest,
      analyze: analyze,
      analyzeBatch: analyzeBatch,
      getPreview: getPreview
    };
  }

  modules.READER_ADAPTATION_SYSTEM_PROMPT = SYSTEM_PROMPT;
  modules.READER_ADAPTATION_KNOWLEDGE = KNOWLEDGE;
  modules.createAdaptationLlm = createAdaptationLlm;
})(typeof globalThis !== 'undefined' ? globalThis : window);
