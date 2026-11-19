(function (root) {
  'use strict';

  /*
   * 原生宿主层：没有酒馆助手时，读者要用到的那部分酒馆助手接口由这里直接对着酒馆实现。
   *
   *   createNativeHelper(env)  与酒馆助手同名同形的一小组函数：变量、楼层、生成、世界书、提示词注入。
   *                            env 的 getVariables 等（reader-env.js 的 lazy）与常驻壳给控制器的 TavernHelper 代理在找不到酒馆助手时落到这里。
   *   createNativeMvu(env)     MVU 的 getMvuData / replaceMvuData 本来就是酒馆助手的 getVariables / replaceVariables，
   *                            这里给出同样的两个函数；宿主卡没有在跑 MVU 时，再负责两件 MVU 会做的事：
   *                            新楼层沿用上一楼的变量，以及解析回复里 <UpdateVariable> 的 JSONPatch（只收 /READER/ 下的路径）。
   *
   * 存放位置与酒馆助手、MVU 完全相同（楼层变量在 chat[i].variables[swipe_id]，聊天变量在 chatMetadata.variables，
   * 全局变量在 extension_settings.variables.global），所以装上或卸掉酒馆助手，数据都接得上。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var DANGEROUS = { __proto__: true, prototype: true, constructor: true };

  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

  /* 与酒馆助手的 insertOrAssignVariables 相同：对象逐层合并，数组整体替换。 */
  function merge(target, source) {
    if (!isObject(source)) return target;
    Object.keys(source).forEach(function (key) {
      if (DANGEROUS[key]) return;
      var value = source[key];
      if (isObject(value)) {
        if (!isObject(target[key])) target[key] = {};
        merge(target[key], value);
      } else target[key] = clone(value);
    });
    return target;
  }

  function createNativeHelper(env) {
    var kit = null;
    var gateway = null;
    var running = Object.create(null);
    var saveTimer = null;

    function hostKit() { return kit || (kit = modules.createHostKit(env)); }
    function context() { try { return env.context() || null; } catch (error) { return null; } }
    function chat() { var ctx = context(); return ctx && Array.isArray(ctx.chat) ? ctx.chat : []; }

    /* ---------- 变量 ---------- */
    /* 读：'latest' 取最后一个没被隐藏的楼层（与酒馆助手相同）；写：取最后一楼。负数从末尾数。 */
    function messageAt(id, writing) {
      var list = chat();
      if (id === undefined || id === null || id === 'latest') {
        if (writing) return list[list.length - 1] || null;
        for (var index = list.length - 1; index >= 0; index -= 1) if (list[index] && !list[index].is_system) return list[index];
        return list[list.length - 1] || null;
      }
      var number = Math.trunc(Number(id));
      if (!Number.isFinite(number)) return null;
      return list[number < 0 ? list.length + number : number] || null;
    }

    /* 一楼当前这一页（swipe）的变量表。提示词模板可能把 variables 存成 { 页码: 表 } 的对象，两种都认。 */
    function slot(message, create) {
      if (!message) return null;
      var swipe = Number(message.swipe_id) || 0;
      var bag = message.variables;
      if (!Array.isArray(bag) && !isObject(bag)) {
        if (!create) return null;
        bag = message.variables = [];
      }
      if (!isObject(bag[swipe])) {
        if (!create) return null;
        bag[swipe] = {};
      }
      return bag[swipe];
    }

    function scheduleChatSave() {
      var ctx = context();
      if (!ctx) return;
      if (typeof ctx.saveChatDebounced === 'function') { try { ctx.saveChatDebounced(); return; } catch (error) { /* 用下面的 */ } }
      if (typeof ctx.saveChat !== 'function') return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { try { Promise.resolve(ctx.saveChat()).catch(function () {}); } catch (error) { /* ignore */ } }, 400);
    }

    function globalBag(create) {
      var ctx = context();
      var settings = ctx && ctx.extensionSettings;
      if (!settings) return null;
      if (!isObject(settings.variables)) { if (!create) return null; settings.variables = {}; }
      if (!isObject(settings.variables.global)) { if (!create) return null; settings.variables.global = {}; }
      return settings.variables.global;
    }

    function getVariables(option) {
      var type = option && option.type || 'chat';
      if (type === 'message') return clone(slot(messageAt(option.message_id, false), false) || {});
      if (type === 'character') {
        var ctx = context();
        var card = ctx && ctx.characters && ctx.characters[ctx.characterId];
        if (!card) throw new Error('请先打开要读取变量的角色卡');
        if (card.shallow) throw new Error('角色卡资料尚未完整加载');
        var extensions = card.data && card.data.extensions || {};
        var settings = extensions.tavern_helper;
        if (Array.isArray(settings)) settings = Object.fromEntries(settings);
        var variables = settings === undefined ? extensions.TavernHelper_characterScriptVariables : settings && settings.variables;
        if (variables !== undefined && !isObject(variables)) throw new Error('此角色卡的变量存储格式无法识别');
        return clone(variables || {});
      }
      if (type === 'chat') {
        var ctx = context();
        return clone(ctx && ctx.chatMetadata && isObject(ctx.chatMetadata.variables) ? ctx.chatMetadata.variables : {});
      }
      if (type === 'global') return clone(globalBag(false) || {});
      return {};
    }

    function replaceVariables(variables, option) {
      var type = option && option.type || 'chat';
      var value = isObject(variables) ? clone(variables) : {};
      var ctx = context();
      if (type === 'message') {
        var message = messageAt(option.message_id, true);
        if (!message) throw new Error('没有可以写入变量的楼层');
        slot(message, true);
        message.variables[Number(message.swipe_id) || 0] = value;
        scheduleChatSave();
        return;
      }
      if (type === 'chat') {
        if (!ctx || !ctx.chatMetadata) throw new Error('当前没有打开的聊天');
        ctx.chatMetadata.variables = value;
        if (typeof ctx.saveMetadataDebounced === 'function') ctx.saveMetadataDebounced();
        else if (typeof ctx.saveMetadata === 'function') { try { Promise.resolve(ctx.saveMetadata()).catch(function () {}); } catch (error) { /* ignore */ } }
        return;
      }
      if (type === 'global') {
        globalBag(true);
        ctx.extensionSettings.variables.global = value;
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        return;
      }
      if (type === 'character') throw new Error('当前已能读取角色卡变量；写入该卡片字段需要酒馆助手的 replaceVariables 接口');
      throw new Error('没有酒馆助手时不支持 ' + type + ' 类型的变量');
    }

    /* updater 可以原地改，也可以返回新的表；返回 Promise 时等它。返回最终的变量表。 */
    function updateVariablesWith(updater, option) {
      var current = getVariables(option);
      var result = updater(current);
      var finish = function (value) {
        var next = value === undefined ? current : value;
        replaceVariables(next, option);
        return next;
      };
      return result && typeof result.then === 'function' ? result.then(finish) : finish(result);
    }

    function insertOrAssignVariables(variables, option) {
      return updateVariablesWith(function (current) { return merge(current, variables); }, option);
    }

    /* ---------- 楼层 ---------- */
    function messageRecord(message, id) {
      return {
        message_id: id,
        name: String(message.name || ''),
        role: message.extra && message.extra.type === 'narrator' ? 'system' : message.is_user ? 'user' : 'assistant',
        is_hidden: message.is_system === true,
        message: String(message.mes == null ? '' : message.mes),
        data: clone(slot(message, false) || {}),
        extra: clone(message.extra || {})
      };
    }

    /* range：楼层号，或 '起-止'（含两端，可用负数）。 */
    function getChatMessages(range, options) {
      var list = chat();
      var last = list.length - 1;
      var from, to;
      var match = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(String(range));
      if (match) { from = Number(match[1]); to = Number(match[2]); }
      else { from = to = Math.trunc(Number(range)); }
      if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
      if (from < 0) from = list.length + from;
      if (to < 0) to = list.length + to;
      from = Math.max(0, from);
      to = Math.min(last, to);
      var role = options && options.role || 'all';
      var hidden = options && options.hide_state || 'all';
      var output = [];
      for (var index = from; index <= to; index += 1) {
        if (!list[index]) continue;
        var record = messageRecord(list[index], index);
        if (role !== 'all' && record.role !== role) continue;
        if (hidden === 'hidden' && !record.is_hidden) continue;
        if (hidden === 'unhidden' && record.is_hidden) continue;
        output.push(record);
      }
      return output;
    }

    function getLastMessageId() { return chat().length - 1; }

    /* ---------- 生成 ---------- */
    function llm() { return gateway || (gateway = modules.createLlmGateway(env)); }

    /* ordered_prompts 里的占位：没有酒馆助手时只认最常用的几种，世界书与对话示例不展开。 */
    function placeholder(name, config) {
      var ctx = context() || {};
      var card = ctx.characters && ctx.characters[ctx.characterId] || {};
      var data = card.data || card;
      if (name === 'user_input') return config.user_input ? [{ role: 'user', content: String(config.user_input) }] : [];
      if (name === 'char_description') return data.description ? [{ role: 'system', content: String(data.description) }] : [];
      if (name === 'char_personality') return data.personality ? [{ role: 'system', content: String(data.personality) }] : [];
      if (name === 'scenario') return data.scenario ? [{ role: 'system', content: String(data.scenario) }] : [];
      if (name === 'persona_description') {
        var persona = ctx.powerUserSettings && ctx.powerUserSettings.persona_description;
        return persona ? [{ role: 'system', content: String(persona) }] : [];
      }
      if (name === 'chat_history') {
        var limit = config.max_chat_history === 'all' || config.max_chat_history === undefined ? Infinity : Math.max(0, Number(config.max_chat_history) || 0);
        if (!limit) return [];
        return chat().filter(function (message) { return message && !message.is_system; }).slice(limit === Infinity ? 0 : -limit).map(function (message) {
          return { role: message.is_user ? 'user' : 'assistant', content: String(message.mes || '') };
        });
      }
      return [];
    }

    async function generateRaw(config) {
      var source = isObject(config) ? config : {};
      var order = Array.isArray(source.ordered_prompts) ? source.ordered_prompts : ['user_input'];
      var messages = [];
      order.forEach(function (item) {
        if (typeof item === 'string') messages = messages.concat(placeholder(item, source));
        else if (item && typeof item.content === 'string' && item.content) messages.push({ role: item.role, content: item.content });
      });
      if (!messages.length && source.user_input) messages.push({ role: 'user', content: String(source.user_input) });
      var request = { messages: messages, retries: 0, timeoutMs: 0, generationId: source.generation_id || 'reader-native' };
      var api = source.custom_api;
      if (isObject(api) && api.apiurl) {
        request.api = { apiurl: String(api.apiurl), model: String(api.model || ''), source: String(api.source || 'openai') };
        if (api.key) request.api.key = String(api.key);
        if (Number(api.max_tokens) > 0) request.maxTokens = Number(api.max_tokens);
        if (typeof api.temperature === 'number') request.temperature = api.temperature;
      } else request.api = null;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var id = String(source.generation_id || '');
      if (controller) { request.signal = controller.signal; if (id) running[id] = controller; }
      try { return await llm().chat(request); }
      finally { if (id && running[id] === controller) delete running[id]; }
    }

    function stopGenerationById(id) {
      var controller = running[String(id)];
      if (!controller) return false;
      delete running[String(id)];
      try { controller.abort(); } catch (error) { /* ignore */ }
      return true;
    }

    async function getModelList(api) {
      var ctx = context();
      var fetcher = env.host && typeof env.host.fetch === 'function' ? env.host.fetch.bind(env.host) : null;
      if (!ctx || !fetcher || typeof ctx.getRequestHeaders !== 'function') throw new Error('当前环境拉不到模型列表，请手动填写模型名');
      var response = await fetcher('/api/backends/chat-completions/status', {
        method: 'POST', cache: 'no-cache',
        headers: Object.assign({ 'Content-Type': 'application/json' }, ctx.getRequestHeaders() || {}),
        body: JSON.stringify({ reverse_proxy: String(api && api.apiurl || '').replace(/\/+$/, ''), proxy_password: String(api && api.key || ''), chat_completion_source: 'openai' })
      });
      var data = await response.json();
      var seen = Object.create(null);
      return (data && Array.isArray(data.data) ? data.data : []).map(function (model) { return String(model && (model.id || model.name) || '').trim(); })
        .filter(function (name) { if (!name || seen[name]) return false; seen[name] = true; return true; }).sort();
    }

    /* ---------- 世界书（换算与读写在 reader-host-kit.js，它在没有酒馆助手时走酒馆原生接口） ---------- */
    async function worldInfoModule() {
      var loaded = await env.hostImport('/scripts/world-info.js');
      if (!loaded || !loaded.world_info) throw new Error('这个版本的酒馆没有可用的世界书设置接口');
      return loaded;
    }

    function charFile() {
      var ctx = context();
      var card = ctx && ctx.characters && ctx.characters[ctx.characterId];
      if (!card) throw new Error('当前没有打开角色卡');
      return String(card.avatar || '').replace(/\.[^./\\]+$/, '');
    }

    /* 角色卡绑定的世界书：主世界书记在卡的 extensions.world，附加世界书记在酒馆设置的 world_info.charLore。 */
    async function rebindCharWorldbooks(_target, books) {
      var ctx = context();
      var next = isObject(books) ? books : {};
      var file = charFile();
      var wi = await worldInfoModule();
      var additional = (Array.isArray(next.additional) ? next.additional : []).map(String).filter(Boolean);
      if (!Array.isArray(wi.world_info.charLore)) wi.world_info.charLore = [];
      var record = wi.world_info.charLore.filter(function (item) { return item && item.name === file; })[0];
      if (additional.length) {
        if (record) record.extraBooks = additional;
        else wi.world_info.charLore.push({ name: file, extraBooks: additional });
      } else if (record) wi.world_info.charLore = wi.world_info.charLore.filter(function (item) { return item !== record; });
      if (next.primary !== undefined && typeof ctx.writeExtensionField === 'function') {
        var card = ctx.characters[ctx.characterId];
        var before = card && card.data && card.data.extensions && card.data.extensions.world || '';
        if (String(next.primary || '') !== String(before)) await ctx.writeExtensionField(ctx.characterId, 'world', next.primary ? String(next.primary) : '');
      }
      if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    }

    async function getCharWorldbookNames() {
      var scopes = hostKit().worldbookScopes();
      var additional = scopes.character_additional.slice();
      try {
        var wi = await worldInfoModule();
        var file = charFile();
        var record = (wi.world_info.charLore || []).filter(function (item) { return item && item.name === file; })[0];
        if (record && Array.isArray(record.extraBooks)) additional = record.extraBooks.map(String);
      } catch (error) { /* 拿不到附加世界书就只报主世界书 */ }
      return { primary: scopes.character_primary, additional: additional };
    }

    /* 全局启用的世界书：酒馆没有对外的写接口，用它自己的 /world 命令逐本开关。 */
    async function rebindGlobalWorldbooks(names) {
      var ctx = context();
      var run = ctx && (ctx.executeSlashCommandsWithOptions || ctx.executeSlashCommands);
      if (typeof run !== 'function') throw new Error('当前环境不能改全局世界书，请在酒馆的世界书面板里手动启用');
      var want = (Array.isArray(names) ? names : []).map(String);
      var current = hostKit().worldbookScopes().global;
      var quote = function (name) { return '"' + String(name).replace(/["\\|]/g, '\\$&') + '"'; };
      for (var index = 0; index < want.length; index += 1) {
        if (current.indexOf(want[index]) < 0) await run.call(ctx, '/world state=on silent=true ' + quote(want[index]));
      }
      for (var off = 0; off < current.length; off += 1) {
        if (want.indexOf(current[off]) < 0) await run.call(ctx, '/world state=off silent=true ' + quote(current[off]));
      }
    }

    /* ---------- 提示词注入（酒馆原生的扩展提示词：位置 1 = 聊天内按深度，-1 = 不注入） ---------- */
    function injectPrompts(prompts) {
      var ctx = context();
      if (!ctx || typeof ctx.setExtensionPrompt !== 'function') throw new Error('当前环境不能注入提示词');
      (Array.isArray(prompts) ? prompts : []).forEach(function (prompt) {
        if (!prompt || prompt.id === undefined) return;
        var off = prompt.position === 'none' || !prompt.content;
        var role = prompt.role === 'user' ? 1 : prompt.role === 'assistant' ? 2 : 0;
        ctx.setExtensionPrompt(String(prompt.id), off ? '' : String(prompt.content), off ? -1 : 1, Math.max(0, Number(prompt.depth) || 0), prompt.should_scan === true, role);
      });
    }

    function uninjectPrompts(ids) {
      injectPrompts((Array.isArray(ids) ? ids : []).map(function (id) { return { id: id, content: '', position: 'none' }; }));
    }

    return {
      __readerNativeHelper: true,
      getVariables: getVariables,
      replaceVariables: replaceVariables,
      updateVariablesWith: updateVariablesWith,
      insertOrAssignVariables: insertOrAssignVariables,
      getChatMessages: getChatMessages,
      getLastMessageId: getLastMessageId,
      generateRaw: generateRaw,
      stopGenerationById: stopGenerationById,
      getModelList: getModelList,
      getWorldbookNames: function () { return hostKit().worldbookNames(); },
      getGlobalWorldbookNames: function () { return hostKit().worldbookScopes().global; },
      getCharWorldbookNames: getCharWorldbookNames,
      getChatWorldbookName: function () { return hostKit().worldbookScopes().chat; },
      getWorldbook: function (name) { return hostKit().readWorldbook(name); },
      createWorldbook: async function (name, entries) {
        var created = await hostKit().createWorldbook(name);
        if (Array.isArray(entries) && entries.length) await hostKit().addWorldbookEntries(name, entries);
        return created;
      },
      createWorldbookEntries: async function (name, entries) {
        var made = await hostKit().addWorldbookEntries(name, entries);
        return { worldbook: await hostKit().readWorldbook(name), new_entries: made };
      },
      updateWorldbookWith: function (name, updater) { return hostKit().updateWorldbook(name, updater); },
      rebindCharWorldbooks: rebindCharWorldbooks,
      rebindGlobalWorldbooks: rebindGlobalWorldbooks,
      injectPrompts: injectPrompts,
      uninjectPrompts: uninjectPrompts,
      slot: slot,
      messageAt: messageAt
    };
  }

  /* ---------- JSONPatch（MVU 的写法：RFC 6902 的 replace / add / remove / move，另加 delta 与 insert） ---------- */
  function pointer(path) {
    var text = String(path == null ? '' : path);
    if (text[0] !== '/') return null;
    var segments = text.slice(1).split('/').map(function (part) { return part.replace(/~1/g, '/').replace(/~0/g, '~'); });
    return segments.some(function (part) { return DANGEROUS[part]; }) ? null : segments;
  }

  function walk(holder, segments, create) {
    var node = holder;
    for (var index = 0; index < segments.length - 1; index += 1) {
      var key = segments[index];
      if (node === null || typeof node !== 'object') return null;
      if (node[key] === undefined || node[key] === null) {
        if (!create) return null;
        node[key] = {};
      }
      node = node[key];
    }
    return node !== null && typeof node === 'object' ? node : null;
  }

  function applyOperation(data, operation) {
    if (!isObject(operation)) return false;
    var op = String(operation.op || '');
    var segments = pointer(operation.path);
    if (!segments || !segments.length) return false;
    var last = segments[segments.length - 1];
    if (op === 'move') {
      var from = pointer(operation.from);
      var owner = from && walk(data, from, false);
      if (!owner) return false;
      var moved = owner[from[from.length - 1]];
      if (moved === undefined) return false;
      if (Array.isArray(owner)) owner.splice(Number(from[from.length - 1]), 1); else delete owner[from[from.length - 1]];
      return applyOperation(data, { op: 'add', path: operation.path, value: moved });
    }
    var parent = walk(data, segments, op !== 'remove');
    if (!parent) return false;
    if (op === 'remove') {
      if (Array.isArray(parent)) { if (!/^\d+$/.test(last)) return false; parent.splice(Number(last), 1); }
      else { if (!(last in parent)) return false; delete parent[last]; }
      return true;
    }
    if (op === 'delta') {
      var amount = Number(operation.value);
      if (!Number.isFinite(amount)) return false;
      parent[last] = (Number(parent[last]) || 0) + amount;
      return true;
    }
    if (op === 'replace' || op === 'add' || op === 'insert') {
      if (operation.value === undefined) return false;
      if (Array.isArray(parent)) {
        if (last === '-') parent.push(clone(operation.value));
        else if (!/^\d+$/.test(last)) return false;
        else if (op === 'replace') parent[Number(last)] = clone(operation.value);
        else parent.splice(Number(last), 0, clone(operation.value));
      } else parent[last] = clone(operation.value);
      return true;
    }
    return false;
  }

  /* 取出回复里的 JSONPatch 数组（<UpdateVariable> 里的 <JSONPatch>；也认代码块包着的）。坏的整段跳过。 */
  function extractPatches(text) {
    var operations = [];
    String(text || '').replace(/<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi, function (_block, body) {
      body.replace(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/gi, function (_patch, json) {
        var source = json.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        try {
          var parsed = JSON.parse(source);
          if (Array.isArray(parsed)) operations = operations.concat(parsed);
        } catch (error) { /* 模型写坏了：这一段不应用 */ }
        return '';
      });
      return '';
    });
    return operations;
  }

  /* 只应用落在 prefix（如 ['READER']）之下的操作，返回成功的条数。 */
  function applyPatches(statData, operations, prefix) {
    var count = 0;
    (Array.isArray(operations) ? operations : []).forEach(function (operation) {
      var segments = operation && pointer(operation.path);
      if (!segments || segments.length <= prefix.length) return;
      for (var index = 0; index < prefix.length; index += 1) if (segments[index] !== prefix[index]) return;
      if (operation.op === 'move') {
        var from = pointer(operation.from);
        if (!from || from[0] !== prefix[0]) return;
      }
      try { if (applyOperation(statData, operation)) count += 1; } catch (error) { /* 单条失败不影响其余 */ }
    });
    return count;
  }

  function createNativeMvu(env) {
    var LATEST = { type: 'message', message_id: 'latest' };
    var EVENTS = { VARIABLE_INITIALIZED: 'reader_ii_variable_initialized', VARIABLE_UPDATE_STARTED: 'reader_ii_variable_update_started', VARIABLE_UPDATE_ENDED: 'reader_ii_variable_update_ended', BEFORE_MESSAGE_UPDATE: 'reader_ii_before_message_update' };
    var MARK = 'reader_ii_patch';

    function context() { try { return env.context() || null; } catch (error) { return null; } }
    function chat() { var ctx = context(); return ctx && Array.isArray(ctx.chat) ? ctx.chat : []; }
    function native() { return env.nativeHost(); }

    /* 宿主卡自己的 MVU 是不是在跑：它的函数来自酒馆助手的脚本 iframe，那个 iframe 被卸掉后函数还在、但已经没人处理新楼层了。 */
    function hostMvu() {
      var mvu = null;
      try { mvu = env.host.Mvu; } catch (error) { mvu = null; }
      if (!mvu || mvu.__readerNative || typeof mvu.getMvuData !== 'function') return null;
      try {
        var realm = mvu.getMvuData.constructor('return this')();
        if (realm && realm.closed === true) return null;
      } catch (error) { /* 拿不到它的窗口时按在跑算 */ }
      return mvu;
    }

    function latestIndex() {
      var list = chat();
      for (var index = list.length - 1; index >= 0; index -= 1) if (list[index] && !list[index].is_system) return index;
      return list.length - 1;
    }

    /* 最后一楼还没有变量时，往前找最近一楼的（MVU 是在收到新楼层时复制过来，这里是读的时候再找）。 */
    function getMvuData(option) {
      var data = env.getVariables(option || LATEST);
      if (isObject(data) && isObject(data.stat_data)) return data;
      if (option && option.type === 'message' && option.message_id !== undefined && option.message_id !== 'latest') return isObject(data) ? data : {};
      var list = chat();
      for (var index = latestIndex() - 1; index >= 0; index -= 1) {
        var found = list[index] && !list[index].is_system ? native().slot(list[index], false) : null;
        if (found && isObject(found.stat_data)) return Object.assign({}, isObject(data) ? data : {}, { stat_data: clone(found.stat_data) });
      }
      return isObject(data) ? data : {};
    }

    function replaceMvuData(data, option) {
      return Promise.resolve(env.replaceVariables(data, option || LATEST));
    }

    /*
     * 新回复到了、宿主卡又没有在跑 MVU 时，要不要由我们来应用回复里的 JSONPatch。
     * 返回 { signature, operations }；不用处理（不是最后一楼的角色回复、这一页已经处理过）时返回 null。
     * 真正的写入由语义层排进它自己的写入队列（reader-core.js 的 absorbNativeUpdate），与记账等写入不会互相覆盖。
     * 每一页只做一次（记在这一页变量里的 reader_ii_patch）：之后再编辑楼层，不会把 Reader 在这一楼记的账冲掉。
     */
    function plan(messageId) {
      var list = chat();
      var last = latestIndex();
      var index = messageId === undefined || messageId === null ? last : Math.trunc(Number(messageId));
      if (!Number.isFinite(index) || index !== last) return null;
      var message = list[index];
      if (!message || message.is_user || message.is_system) return null;
      var signature = modules.hashText(String(message.mes || ''));
      var own = native().slot(message, false);
      if (own && own[MARK] === signature) return null;
      return { signature: signature, operations: extractPatches(message.mes) };
    }

    /* 最后一楼自己有没有变量（没有时读到的是往前找来的）。 */
    function materialized() {
      var message = chat()[latestIndex()];
      var own = message ? native().slot(message, false) : null;
      return !!own && isObject(own.stat_data);
    }

    return {
      __readerNative: true,
      MARK: MARK,
      events: EVENTS,
      getMvuData: getMvuData,
      replaceMvuData: replaceMvuData,
      hostMvu: hostMvu,
      plan: plan,
      materialized: materialized
    };
  }

  modules.createNativeHelper = createNativeHelper;
  modules.createNativeMvu = createNativeMvu;
  modules.readerJsonPatch = { extract: extractPatches, apply: applyPatches };
})(typeof globalThis !== 'undefined' ? globalThis : window);
