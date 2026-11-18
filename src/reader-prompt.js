(function (root) {
  'use strict';

  /*
   * 提示词与正文处理。原先靠世界书（要装提示词模板 ST-Prompt-Template 来跑里面的 EJS）和三条正则，现在都由扩展自己做：
   *
   *  · 提示词：更新规则、读者核心、变量列表三份模板在构建时编译成函数（modules.READER_PROMPT_TEMPLATES，build/prompts.mjs），
   *    每次生成前（GENERATION_AFTER_COMMANDS）渲染，经酒馆的扩展提示词注入。模板只用到五个宿主函数：
   *    getvar / getLocalVar / setLocalVar / getChatMessage / matchChatMessages，这里照提示词模板的语义实现。
   *  · 事件块 <READER_*_EVENT>：发给模型前从提示词里摘掉（CHAT_COMPLETION_PROMPT_READY / GENERATE_AFTER_COMBINE_PROMPTS）；
   *    显示时去掉。宿主卡没有在跑 MVU 时，<UpdateVariable> 也一样处理（那时它是我们让模型写的）。
   *  · 来信 <dream>…</dream>：显示时换成 [data-reader-dream-slot] 插槽，由常驻壳挂成轻信。
   *    显示侧用酒馆的 MessageFormatter 钩子；没有这个钩子的旧版酒馆，才往全局正则里放两条内置正则。
   *  · 旧组件：alpha 版装过的世界书条目、主脚本、三条正则，发现了就停用或清掉（见 retireLegacy）。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  var PROMPTS = [
    /* 位置：2 = 提示词最前面（原世界书条目的「角色定义之前」），1 = 聊天内按深度。 */
    { id: 'reader_ii_core', template: 'core', position: 2, depth: 0 },
    { id: 'reader_ii_rules', template: 'rules', position: 1, depth: 4 },
    { id: 'reader_ii_list', template: 'list', position: 1, depth: 1 }
  ];
  var EVENT_RE = /<READER_(?:FP|TASK|ACTION)_EVENT>[\s\S]*?<\/READER_(?:FP|TASK|ACTION)_EVENT>/gi;
  var UPDATE_RE = /<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi;
  var DREAM_RE = /<dream>「?((?:[^<]|<(?!dream\b|\/dream>))*?)」?<\/dream>/g;
  var DREAM_SLOT = '<div data-reader-dream-slot="1" data-preserve-html="1"><div data-reader-dream-source>$1</div></div>';
  /* 只把最近这么多楼的来信挂成信纸（与原渲染正则的最大深度相同），更早的保持文字，免得一个长聊天里挂上百个 iframe。 */
  var DREAM_DEPTH = 10;
  var BUILTIN_REGEX = [
    { id: 'c4b7e0a2-5d19-4f3e-9a68-1e2f7b3c8d51', scriptName: 'Reader-II 事件隐藏（内置）', findRegex: '/<READER_(?:FP|TASK|ACTION)_EVENT>[\\s\\S]*?<\\/READER_(?:FP|TASK|ACTION)_EVENT>/gi', replaceString: '', markdownOnly: true, promptOnly: true, substituteRegex: 0, maxDepth: null },
    { id: '6f1d9c3e-8a24-4b70-b5e7-3c9a0d4f2e86', scriptName: 'Reader-II 来信渲染（内置）', findRegex: '/<dream>「?((?:[^<]|<(?!dream\\b|\\/dream>))*?)」?<\\/dream>/g', replaceString: DREAM_SLOT, markdownOnly: true, promptOnly: false, substituteRegex: 2, maxDepth: DREAM_DEPTH }
  ];
  /* alpha 版的卡内组件（4.0.0-alpha.1 / .2 的「检查卡内组件」代装的）。 */
  var LEGACY = {
    scriptId: 'b7e4c1d2-3a9f-4e6b-8c15-2f7a9d0e4b63',
    loaderId: 'e2a95f17-6c3b-4d84-a0f2-9b1c7e5d3a48',
    regexIds: ['a321f80c-96e4-418c-a666-f7c4f7ead4e4', '266633e9-9ca9-4ef8-bf2f-77dfc5df7c49', '89b4ce2b-1667-4cdd-9716-f0df6b6200fc'],
    entries: ['[mvu_update]Reader-II变量更新规则', '[Reader-II] 通用读者核心', 'Reader-II变量列表'],
    books: /reader-ii|Reader-II/i
  };
  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };

  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ESCAPES[ch]; }); }

  function readPath(object, key) {
    var parts = String(key).split('.');
    var value = object;
    for (var index = 0; index < parts.length; index += 1) {
      if (value === null || value === undefined) return undefined;
      value = value[parts[index]];
    }
    return value;
  }

  function writePath(object, key, value) {
    var parts = String(key).split('.');
    var owner = object;
    for (var index = 0; index < parts.length - 1; index += 1) {
      var part = parts[index];
      if (part === '__proto__' || part === 'constructor' || part === 'prototype') return;
      if (!isObject(owner[part])) owner[part] = {};
      owner = owner[part];
    }
    var last = parts[parts.length - 1];
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') return;
    owner[last] = value;
  }

  function createPromptRuntime(api, env) {
    var host = env.host;
    var log = env.console || console;
    var kit = api && api.kit || modules.createHostKit(env);
    var stops = [];
    var disposed = false;
    var saveTimer = null;
    var retired = Object.create(null);

    function context() { try { return env.context() || null; } catch (error) { return null; } }
    /* 延后做的事不该拖住进程（Node 里的测试）：定时器 unref。 */
    function later(task, ms) { var timer = setTimeout(task, ms); if (timer && typeof timer.unref === 'function') timer.unref(); return timer; }
    function enabled() { try { return !disposed && !!api && typeof api.isEnabled === 'function' && api.isEnabled() === true; } catch (error) { return false; } }
    function hostHasMvu() { try { return !!(api && typeof api.hostMvu === 'function' && api.hostMvu()); } catch (error) { return false; } }

    /* ---------- 模板的宿主函数（照提示词模板 ST-Prompt-Template 的语义） ---------- */
    function chatMessages(role) {
      var ctx = context();
      var list = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
      return list.filter(function (message) {
        if (!message || message.is_system) return false;
        if (role === 'user') return message.is_user === true;
        if (role === 'assistant') return message.is_user !== true;
        return true;
      });
    }

    function pick(list, index) {
      var number = Math.trunc(Number(index));
      if (!Number.isFinite(number)) return undefined;
      return list[number < 0 ? list.length + number : number];
    }

    function locals() {
      var ctx = context() || {};
      if (ctx.chatMetadata && !isObject(ctx.chatMetadata.variables)) ctx.chatMetadata.variables = {};
      var chatVars = ctx.chatMetadata ? ctx.chatMetadata.variables : {};
      var messageVars = {};
      try { messageVars = env.getVariables({ type: 'message', message_id: 'latest' }) || {}; } catch (error) { messageVars = {}; }
      /* 最后一楼还没有变量时（宿主没有 MVU、新楼层刚到），用语义层往前找到的那一份。 */
      if (!isObject(messageVars.stat_data) && api && typeof api.readFloor === 'function') {
        try { messageVars = api.readFloor() || messageVars; } catch (error) { /* 用空的 */ }
      }
      var globals = {};
      try { globals = env.getVariables({ type: 'global' }) || {}; } catch (error) { globals = {}; }
      var cache = Object.assign({}, clone(globals), clone(chatVars), clone(messageVars));
      var dirty = false;
      return {
        getvar: function (key, options) {
          var opts = options || {};
          var value = readPath(opts.scope === 'local' ? chatVars : opts.scope === 'global' ? globals : opts.scope === 'message' ? messageVars : cache, key);
          var result = value === undefined ? opts.defaults : value;
          return opts.clone ? clone(result) : result;
        },
        getLocalVar: function (key, options) {
          var value = readPath(chatVars, key);
          return value === undefined ? (options || {}).defaults : value;
        },
        setLocalVar: function (key, value) {
          writePath(chatVars, key, clone(value));
          writePath(cache, key, clone(value));
          dirty = true;
          return value;
        },
        getChatMessage: function (index, role) {
          var message = pick(chatMessages(role), index);
          return message ? String(message.mes == null ? '' : message.mes) : '';
        },
        /* patterns：字符串、正则或它们的数组；start / end 是按角色筛过之后的下标（可用负数），默认只看最后一条。 */
        matchChatMessages: function (patterns, options) {
          var opts = options || {};
          var list = chatMessages(opts.role);
          var from = opts.start === undefined ? -1 : Math.trunc(Number(opts.start));
          var to = opts.end === undefined ? list.length : Math.trunc(Number(opts.end));
          if (from < 0) from = Math.max(0, list.length + from);
          if (to < 0) to = list.length + to;
          var text = list.slice(from, Math.max(from, to)).map(function (message) { return String(message.mes || ''); }).join('\n');
          return (Array.isArray(patterns) ? patterns : [patterns]).some(function (pattern) {
            if (pattern instanceof RegExp || (pattern && typeof pattern.test === 'function')) { pattern.lastIndex = 0; return pattern.test(text); }
            return pattern !== undefined && pattern !== null && String(pattern) !== '' && text.indexOf(String(pattern)) >= 0;
          });
        },
        console: log,
        __dirty: function () { return dirty; }
      };
    }

    function saveMetadataSoon() {
      var ctx = context();
      if (!ctx) return;
      if (typeof ctx.saveMetadataDebounced === 'function') { try { ctx.saveMetadataDebounced(); return; } catch (error) { /* 用下面的 */ } }
      if (typeof ctx.saveMetadata !== 'function') return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { try { Promise.resolve(ctx.saveMetadata()).catch(function () {}); } catch (error) { /* ignore */ } }, 300);
    }

    /* 渲染三份模板，返回 { core, rules, list }（没启用 Reader 的聊天里都是空串）。 */
    async function render() {
      var output = { core: '', rules: '', list: '' };
      var templates = modules.READER_PROMPT_TEMPLATES;
      if (!enabled() || !templates) return output;
      var bridge = locals();
      var ctx = context();
      /* 顺序同原世界书：核心在前（它会写「系统名」等聊天变量），再是更新规则与变量列表。 */
      for (var index = 0; index < PROMPTS.length; index += 1) {
        var name = PROMPTS[index].template;
        if (typeof templates[name] !== 'function') continue;
        try {
          var text = String(await templates[name](bridge, escapeHtml) || '').replace(/\n{3,}/g, '\n\n').trim();
          if (text && ctx && typeof ctx.substituteParams === 'function') text = ctx.substituteParams(text);
          output[name] = text;
        } catch (error) {
          log.error('[ReaderII] 提示词模板 ' + name + ' 渲染失败', error);
        }
      }
      if (bridge.__dirty()) saveMetadataSoon();
      return output;
    }

    function setPrompt(id, text, position, depth) {
      var ctx = context();
      if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return false;
      ctx.setExtensionPrompt(id, text || '', text ? position : -1, depth, false, 0);
      return true;
    }

    async function inject() {
      var output = await render();
      PROMPTS.forEach(function (item) { setPrompt(item.id, output[item.template], item.position, item.depth); });
      return output;
    }

    function clear() {
      PROMPTS.forEach(function (item) { setPrompt(item.id, '', item.position, item.depth); });
    }

    /* ---------- 正文处理 ---------- */
    function stripForPrompt(text) {
      var output = String(text == null ? '' : text);
      if (output.indexOf('<READER_') >= 0 || output.indexOf('<reader_') >= 0) output = output.replace(EVENT_RE, '');
      if (!hostHasMvu() && /<UpdateVariable>/i.test(output)) output = output.replace(UPDATE_RE, '');
      return output;
    }

    /* 楼层在未隐藏楼层里从后往前数是第几个（0 = 最后一楼）；临时消息（流式预览等）按 0 算。 */
    function depthOf(messageId) {
      var ctx = context();
      var list = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
      var index = Math.trunc(Number(messageId));
      if (!Number.isFinite(index) || index < 0 || index >= list.length) return 0;
      var depth = 0;
      for (var cursor = list.length - 1; cursor > index; cursor -= 1) if (list[cursor] && !list[cursor].is_system) depth += 1;
      return depth;
    }

    function formatForDisplay(text, meta) {
      if (!enabled() || typeof text !== 'string' || !text) return text;
      if (meta && (meta.isUser || meta.isReasoning)) return text;
      var output = stripForPrompt(text);
      if (output.indexOf('<dream>') >= 0 && depthOf(meta && meta.messageId) <= DREAM_DEPTH) output = output.replace(DREAM_RE, DREAM_SLOT);
      return output;
    }

    /* MessageFormatter 的钩子摘不掉，所以只登记一次、内容可换：扩展重新加载后换成新的实现。 */
    function installFormatter() {
      var ctx = context();
      var formatter = ctx && ctx.MessageFormatter;
      if (!formatter || typeof formatter.addHook !== 'function' || !formatter.stage) return false;
      var slot = host.__ReaderIIFormatHook;
      if (!slot) {
        slot = host.__ReaderIIFormatHook = { run: null };
        try {
          formatter.addHook(function (text, meta) { return typeof slot.run === 'function' ? slot.run(text, meta) : text; },
            { stage: formatter.stage.BEFORE_REGEX, order: formatter.order ? formatter.order.EARLY : 10 });
        } catch (error) {
          host.__ReaderIIFormatHook = null;
          log.warn('[ReaderII] 登记正文格式化钩子失败', error);
          return false;
        }
      }
      slot.run = formatForDisplay;
      stops.push(function () { if (slot.run === formatForDisplay) slot.run = null; });
      return true;
    }

    function regexList() {
      var ctx = context();
      var settings = ctx && ctx.extensionSettings;
      if (!settings) return null;
      if (!Array.isArray(settings.regex)) settings.regex = [];
      return settings.regex;
    }

    /* 旧版酒馆没有格式化钩子：往全局正则里放两条内置正则（已经有旧的三条或内置的就不重复放）。 */
    function installRegexFallback() {
      var list = regexList();
      if (!list) return false;
      var ids = list.map(function (item) { return item && item.id; });
      if (LEGACY.regexIds.some(function (id) { return ids.indexOf(id) >= 0; })) return true;
      var added = false;
      BUILTIN_REGEX.forEach(function (item) {
        if (ids.indexOf(item.id) >= 0) return;
        list.push({ id: item.id, scriptName: item.scriptName, findRegex: item.findRegex, replaceString: item.replaceString, trimStrings: [], placement: [2],
          disabled: false, markdownOnly: item.markdownOnly, promptOnly: item.promptOnly, runOnEdit: true, substituteRegex: item.substituteRegex, minDepth: null, maxDepth: item.maxDepth });
        added = true;
      });
      if (added) { var ctx = context(); if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced(); }
      return true;
    }

    /* ---------- 旧组件 ---------- */
    /*
     * alpha 版装在这张卡上的东西与扩展重复：世界书条目会让提示词注入两遍，主脚本会再起一套语义层。
     * 每个聊天查一次：停用旧世界书里的三个条目；停用旧主脚本与加载器（要酒馆助手）；有格式化钩子时清掉没改过的三条旧正则。
     * 都是 Reader-II 自己的组件，停用不丢数据；做了什么会提示一次。
     */
    async function retireLegacy() {
      var done = [];
      var needReload = false;
      var ctx = context();
      /* 世界书 */
      try {
        var scopes = kit.worldbookScopes();
        var active = scopes.global.concat([scopes.character_primary, scopes.chat]).concat(scopes.character_additional).filter(Boolean);
        var seen = Object.create(null);
        for (var index = 0; index < active.length; index += 1) {
          var book = String(active[index]);
          if (seen[book] || !LEGACY.books.test(book)) continue;
          seen[book] = true;
          var entries = await kit.readWorldbook(book);
          var live = entries.filter(function (entry) { return LEGACY.entries.indexOf(String(entry.name || '')) >= 0 && entry.enabled !== false; });
          if (!live.length) continue;
          await kit.updateWorldbook(book, function (list) {
            list.forEach(function (entry) { if (LEGACY.entries.indexOf(String(entry.name || '')) >= 0) entry.enabled = false; });
            return list;
          });
          done.push('停用了世界书《' + book + '》里的 ' + live.length + ' 个旧条目');
          /* 这张卡之前就在用 Reader：没有明确开关过的话，记为启用。 */
          if (api && typeof api.adoptLegacyCard === 'function') { try { await api.adoptLegacyCard(); } catch (error) { /* ignore */ } }
        }
      } catch (error) { log.warn('[ReaderII] 检查旧世界书失败', error); }
      /* 酒馆助手脚本 */
      try {
        var update = env.resolveFunction('updateScriptTreesWith');
        var getTrees = env.resolveFunction('getScriptTrees');
        if (update && getTrees) {
          var types = ['character', 'global', 'preset'];
          for (var t = 0; t < types.length; t += 1) {
            var hit = 0;
            var visit = function (nodes, change) {
              (Array.isArray(nodes) ? nodes : []).forEach(function (node) {
                if (!node) return;
                if (node.type === 'folder') { visit(node.scripts, change); return; }
                if ((node.id === LEGACY.scriptId || node.id === LEGACY.loaderId) && node.enabled !== false) { hit += 1; if (change) node.enabled = false; }
              });
            };
            var trees;
            try { trees = getTrees({ type: types[t] }); } catch (error) { trees = []; }
            visit(trees, false);
            if (!hit) continue;
            await update(function (nodes) { visit(nodes, true); return nodes; }, { type: types[t] });
            done.push('停用了旧版酒馆助手脚本（Reader-II主系统 / 加载器）');
            needReload = true;
          }
        }
      } catch (error) { log.warn('[ReaderII] 检查旧脚本失败', error); }
      /* 正则：有格式化钩子时旧的三条已经多余；没改过的清掉，改过的留着（它们与钩子不冲突）。 */
      try {
        var list = regexList();
        if (list && host.__ReaderIIFormatHook && typeof host.__ReaderIIFormatHook.run === 'function') {
          var removable = BUILTIN_REGEX.map(function (item) { return item.id; }).concat(LEGACY.regexIds);
          var before = list.length;
          for (var cursor = list.length - 1; cursor >= 0; cursor -= 1) {
            var script = list[cursor];
            if (!script || removable.indexOf(script.id) < 0) continue;
            if (/READER_\(\?:FP\|TASK\|ACTION\)_EVENT|<dream>/.test(String(script.findRegex || ''))) list.splice(cursor, 1);
          }
          if (list.length !== before) {
            done.push('清掉了 ' + (before - list.length) + ' 条已不需要的 Reader-II 正则');
            if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
          }
        }
      } catch (error) { log.warn('[ReaderII] 检查旧正则失败', error); }
      if (done.length) {
        log.info('[ReaderII] 旧版卡内组件已由扩展接管：' + done.join('；'));
        if (env.toastr && typeof env.toastr.info === 'function') {
          env.toastr.info(done.join('；') + '。' + (needReload ? '请刷新一次页面。' : ''), 'Reader-II 已接管旧版组件', { timeOut: needReload ? 12000 : 7000 });
        }
      }
      return { done: done, needReload: needReload };
    }

    function retireOnce() {
      var key = kit.chatKey();
      if (!key || retired[key] || disposed) return;
      var ctx = context();
      if (!ctx || !Array.isArray(ctx.chat) || !ctx.chat.length) return;
      retired[key] = true;
      Promise.resolve(retireLegacy()).catch(function (error) { log.warn('[ReaderII] 接管旧组件失败', error); });
    }

    /* ---------- 装配 ---------- */
    function listen(name, handler, first) {
      var ctx = context();
      var source = ctx && ctx.eventSource;
      var types = ctx && (ctx.eventTypes || ctx.event_types) || env.tavern_events || {};
      var event = types[name];
      if (!source || !event) return;
      if (first && typeof source.makeLast === 'function') source.makeLast(event, handler);
      else source.on(event, handler);
      stops.push(function () { try { source.removeListener(event, handler); } catch (error) { /* ignore */ } });
    }

    /* 生成前渲染并注入；放在别的监听之后（常驻壳要先把控制器备好，记忆要先整理好）。试算（dryRun）时不重渲染。 */
    listen('GENERATION_AFTER_COMMANDS', function (_type, _options, dryRun) {
      if (dryRun) return undefined;
      if (!enabled()) { clear(); return undefined; }
      return inject().then(function () { return undefined; }, function (error) { log.error('[ReaderII] 提示词注入失败', error); });
    }, true);
    listen('CHAT_CHANGED', function () {
      clear();
      later(retireOnce, 1500);
    });
    listen('CHAT_COMPLETION_PROMPT_READY', function (data) {
      if (!enabled() || !data || !Array.isArray(data.chat)) return;
      data.chat.forEach(function (message) {
        if (!message) return;
        if (typeof message.content === 'string') message.content = stripForPrompt(message.content);
        else if (Array.isArray(message.content)) message.content.forEach(function (part) { if (part && typeof part.text === 'string') part.text = stripForPrompt(part.text); });
      });
    });
    listen('GENERATE_AFTER_COMBINE_PROMPTS', function (data) {
      if (!enabled() || !data || typeof data.prompt !== 'string') return;
      data.prompt = stripForPrompt(data.prompt);
    });

    var formatter = installFormatter();
    if (!formatter) installRegexFallback();
    later(retireOnce, 2500);

    /* 启用状态变了：已经画出来的楼层要按新的规则重画一遍（来信插槽、事件块）。 */
    var onCoreChanged = function (event) {
      if (!event || !event.detail || event.detail.reason !== 'enabled_changed') return;
      if (!enabled()) clear();
      var ctx = context();
      if (ctx && typeof ctx.reloadCurrentChat === 'function' && formatter) {
        try { Promise.resolve(ctx.reloadCurrentChat()).catch(function () {}); } catch (error) { /* ignore */ }
      }
    };
    try {
      host.addEventListener('reader-core-changed', onCoreChanged);
      stops.push(function () { host.removeEventListener('reader-core-changed', onCoreChanged); });
    } catch (error) { /* ignore */ }

    return {
      render: render,
      inject: inject,
      clear: clear,
      stripForPrompt: stripForPrompt,
      formatForDisplay: formatForDisplay,
      retireLegacy: retireLegacy,
      usesFormatter: formatter,
      dispose: function () {
        disposed = true;
        clearTimeout(saveTimer);
        clear();
        stops.splice(0).forEach(function (stop) { try { stop(); } catch (error) { /* ignore */ } });
      }
    };
  }

  modules.createPromptRuntime = createPromptRuntime;
  modules.READER_PROMPT_SLOTS = PROMPTS;
  modules.READER_LEGACY_COMPONENTS = LEGACY;
})(typeof globalThis !== 'undefined' ? globalThis : window);
