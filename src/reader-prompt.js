(function (root) {
  'use strict';

  /*
   * 提示词与正文处理。原先靠世界书（要装提示词模板 ST-Prompt-Template 来跑里面的 EJS）和三条正则，现在都由扩展自己做：
   *
   *  · 提示词：更新规则、读者核心、变量列表三份模板在构建时编译成函数（modules.READER_PROMPT_TEMPLATES，build/prompts.mjs），
   *    每次正文生成时渲染为临时世界书条目，预设漏掉位置时在最终请求中补全。模板只用到五个宿主函数：
   *    getvar / getLocalVar / setLocalVar / getChatMessage / matchChatMessages，这里照提示词模板的语义实现。
   *  · 事件块 <READER_*_EVENT>：发给模型前从提示词里摘掉（CHAT_COMPLETION_PROMPT_READY / GENERATE_AFTER_COMBINE_PROMPTS）；
   *    显示时去掉。宿主卡没有在跑 MVU 时，<UpdateVariable> 也一样处理（那时它是我们让模型写的）。
   *  · 来信 <dream>…</dream>：显示时换成 [data-reader-dream-slot] 插槽，由常驻壳挂成轻信。
   *    显示侧用酒馆的 MessageFormatter 钩子；没有这个钩子的旧版酒馆，才往全局正则里放两条内置正则。
   *  · 旧组件：alpha 版装过的世界书条目、主脚本、三条正则，发现了就停用或清掉（见 retireLegacy）。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  var PROMPTS = [
    /* 这里是旧版扩展提示词的编号；世界书位置由 reader-prompt-placement.js 保存。 */
    { id: 'reader_ii_core', template: 'core', position: 2, depth: 0 },
    { id: 'reader_ii_rules', template: 'rules', position: 1, depth: 4 },
    { id: 'reader_ii_list', template: 'list', position: 1, depth: 1 }
  ];
  /*
   * 可选槽位：分卷导演的《本轮导演简报》。它不是模板渲染出来的，而是由导演（agent/director.js）登记的提供者给出一段现成的文本；
   * 也不随「这张卡」的开关走——卡没启用 Reader-II、或与原版读者共存时，只要导演在执导，这一槽照样注入。
   * 文本在交到这里之前已经解析过主角名、失活了其余宏，所以世界书通道与最终请求的兜底拿到的是同一份，比对得上。
   */
  var DIRECTOR_SLOT = { id: 'reader_ii_director', template: 'director', position: 1, depth: 1 };
  var SLOTS = PROMPTS.concat([DIRECTOR_SLOT]);
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
    var placement = modules.readerPromptPlacement;
    var turn = null;
    var directorProvider = null;
    var directorTouched = false;   /* 旧式扩展提示词里放过导演简报：清理时才需要动它 */

    function context() { try { return env.context() || null; } catch (error) { return null; } }
    /* 延后做的事不该拖住进程（Node 里的测试）：定时器 unref。 */
    function later(task, ms) { var timer = setTimeout(task, ms); if (timer && typeof timer.unref === 'function') timer.unref(); return timer; }
    function enabled() { try { return !disposed && !!api && typeof api.isEnabled === 'function' && api.isEnabled() === true; } catch (error) { return false; } }
    /* 导演槽位自己的开关：提供者说它在这个聊天里执导、且有东西可注入。 */
    function directorOn() {
      if (disposed || !directorProvider) return false;
      try { return directorProvider.active() === true; } catch (error) { return false; }
    }
    /* 这一轮正文有没有我们要管的东西：读者的三段模板，或导演简报。 */
    function engaged() { return enabled() || directorOn(); }
    function slotOn(key) { return key === 'director' ? directorOn() : enabled(); }
    function coexisting() { try { return !!(api && typeof api.isCoexisting === 'function' && api.isCoexisting() === true); } catch (error) { return false; } }
    function hostHasMvu() { try { return !!(api && typeof api.hostMvu === 'function' && api.hostMvu()); } catch (error) { return false; } }

    /* ---------- 模板的宿主函数（照提示词模板 ST-Prompt-Template 的语义） ---------- */
    function chatMessages(role, generationType) {
      var ctx = context();
      var list = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
      if (generationType === 'swipe') list = list.slice(0, -1);
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

    function locals(generationType) {
      var ctx = context() || {};
      if (ctx.chatMetadata && !isObject(ctx.chatMetadata.variables)) ctx.chatMetadata.variables = {};
      var chatVars = ctx.chatMetadata ? ctx.chatMetadata.variables : {};
      var messageVars = {};
      try {
        if (generationType === 'swipe') {
          // Swipe keeps the rejected answer in ctx.chat, but the host excludes it from this request.
          for (var at = ctx.chat.length - 2; at >= 0; at -= 1) {
            if (!ctx.chat[at] || ctx.chat[at].is_system) continue;
            var candidate = env.getVariables({ type: 'message', message_id: at }) || {};
            if (isObject(candidate.stat_data)) { messageVars = Object.assign({}, candidate, messageVars); break; }
            if (!Object.keys(messageVars).length) messageVars = candidate;
          }
        } else {
          messageVars = env.getVariables({ type: 'message', message_id: 'latest' }) || {};
        }
      } catch (error) { messageVars = {}; }
      /* 最后一楼还没有变量时（宿主没有 MVU、新楼层刚到），用语义层往前找到的那一份。 */
      if (generationType !== 'swipe' && !isObject(messageVars.stat_data) && api && typeof api.readFloor === 'function') {
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
        getMessageVar: function (key, options) {
          var opts = options || {};
          var value = readPath(messageVars, key);
          var result = value === undefined ? opts.defaults : value;
          return opts.clone ? clone(result) : result;
        },
        setMessageVar: function (_key, value) { return value; },
        setLocalVar: function (key, value) {
          writePath(chatVars, key, clone(value));
          writePath(cache, key, clone(value));
          dirty = true;
          return value;
        },
        getChatMessage: function (index, role) {
          var message = pick(chatMessages(role, generationType), index);
          return message ? String(message.mes == null ? '' : message.mes) : '';
        },
        lastUserMessage: (function () {
          var msg = pick(chatMessages('user', generationType), -1);
          return msg ? String(msg.mes == null ? '' : msg.mes) : '';
        })(),
        lastCharMessage: (function () {
          var msg = pick(chatMessages('assistant', generationType), -1);
          return msg ? String(msg.mes == null ? '' : msg.mes) : '';
        })(),
        lastMessageId: Array.isArray(ctx.chat) ? ctx.chat.length - 1 : -1,
        /* patterns：字符串、正则或它们的数组；start / end 是按角色筛过之后的下标（可用负数），默认只看最后一条。 */
        matchChatMessages: function (patterns, options) {
          var opts = options || {};
          var list = chatMessages(opts.role, generationType);
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

    /* 渲染三份模板，返回 { core, rules, list }（没启用 Reader 的聊天里都是空串）；导演在执导时另带 director。 */
    async function render(generationType) {
      var output = { core: '', rules: '', list: '' };
      await renderStory(output, generationType);
      if (directorOn()) {
        try {
          var brief = String(await directorProvider.brief(generationType) || '').trim();
          if (brief && directorOn()) output.director = brief;
        } catch (error) {
          log.error('[ReaderII] 导演简报读取失败', error);
        }
      }
      return output;
    }

    async function renderStory(output, generationType) {
      var templates = modules.READER_PROMPT_TEMPLATES;
      if (!enabled() || !templates) return output;
      var bridge = locals(generationType);
      // 同一代正文中的人格与外貌取自同一份档案。
      var profiles = new Map();
      function profile(id) {
        if (!profiles.has(id)) {
          var agent = host.ReaderII && host.ReaderII.agent;
          profiles.set(id, agent && agent.personaContext(id));
        }
        return profiles.get(id);
      }
      bridge.getPersonaPrompt = function (id) {
        var current = profile(id);
        var value = current && current.override;
        return value ? '\n' + value + '\n' : '';
      };
      bridge.getAppearancePrompt = function (id) {
        var current = profile(id);
        return current && current.appearance && current.appearance.prompt;
      };
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

    function setPrompt(id, text, position, depth, role) {
      var ctx = context();
      if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return false;
      ctx.setExtensionPrompt(id, text || '', text ? position : -1, depth, false, role || 0);
      return true;
    }

    function legacyInject(config, output) {
      var ctx = context() || {};
      var canPlaceInChat = ctx.mainApi === 'openai' && (hasEvent('GENERATE_AFTER_DATA') || hasEvent('CHAT_COMPLETION_SETTINGS_READY'));
      function legacyPosition(p) { return p.position === 4 ? 1 : p.position === 0 ? 2 : 0; }
      PROMPTS.forEach(function (item) {
        var p = config[item.template];
        // The old extension-prompt API has no example, author's-note or after-character slot.
        var defer = canPlaceInChat && p.position !== 0 && p.position !== 4;
        setPrompt(item.id, p.enabled && p.position !== 7 && !defer ? output[item.template] : '', legacyPosition(p), p.depth, p.role);
      });
      /* 导演简报：有内容才放；之前放过的，这次没有内容也要清掉。别的时候不碰这个编号。 */
      var d = config[DIRECTOR_SLOT.template];
      var brief = d && d.enabled && d.position !== 7 && !(canPlaceInChat && d.position !== 0 && d.position !== 4) ? output[DIRECTOR_SLOT.template] || '' : '';
      if (d && (brief || directorTouched)) {
        setPrompt(DIRECTOR_SLOT.id, brief, legacyPosition(d), d.depth, d.role);
        directorTouched = !!brief;
      }
    }

    async function inject() {
      var output = await render();
      if (!hasEvent('WORLDINFO_ENTRIES_LOADED')) legacyInject(placement.placements(context()), output);
      return output;
    }

    function clear() {
      if (turn) turn.listeners.forEach(function (remove) { remove(); });
      turn = null;
      clearExtensionPrompts();
    }

    function clearExtensionPrompts() {
      PROMPTS.forEach(function (item) { setPrompt(item.id, '', item.position, item.depth); });
      if (directorTouched) {
        setPrompt(DIRECTOR_SLOT.id, '', DIRECTOR_SLOT.position, DIRECTOR_SLOT.depth);
        directorTouched = false;
      }
    }

    /*
     * 读者这一侧让位（这张卡停用了 Reader-II，或检测到原版读者而进入共存）。
     * 导演是助手的子能力，不随读者的开关走：没有导演在执导时整轮作废（与原来相同）；
     * 导演还在执导时只撤掉读者的三段，这一轮的导演简报照常注入。
     */
    function yieldStory() {
      if (!directorOn()) { clear(); return; }
      PROMPTS.forEach(function (item) { setPrompt(item.id, '', item.position, item.depth); });
      /* 已经渲染好的内容里可能带着读者的三段：丢掉，下一步按现在的开关重新渲染。 */
      if (turn) turn.pending = turn.output = null;
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

    /* 旧版酒馆没有格式化钩子：往全局正则里放两条内置正则（已经有旧的三条或内置的就不重复放；共存时不放，避免劫持原版 <dream>）。 */
    function installRegexFallback() {
      if (coexisting()) return false;
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

    function syncBuiltinRegexForCoexist() {
      var list = regexList();
      if (!list) return;
      var wantDisabled = coexisting();
      var ids = BUILTIN_REGEX.map(function (item) { return item.id; });
      var changed = false;
      list.forEach(function (rule) {
        if (!rule || ids.indexOf(rule.id) < 0) return;
        if (!!rule.disabled !== wantDisabled) { rule.disabled = wantDisabled; changed = true; }
      });
      if (changed) { var ctx = context(); if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced(); }
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
      if (coexisting()) return;
      var key = kit.chatKey();
      if (!key || retired[key] || disposed) return;
      var ctx = context();
      if (!ctx || !Array.isArray(ctx.chat) || !ctx.chat.length) return;
      retired[key] = true;
      Promise.resolve(retireLegacy()).catch(function (error) { log.warn('[ReaderII] 接管旧组件失败', error); });
    }

    function eventType(name) {
      var ctx = context();
      var types = ctx && (ctx.eventTypes || ctx.event_types) || env.tavern_events || {};
      return types[name];
    }
    function hasEvent(name) { return !!(context() && context().eventSource && eventType(name)); }
    function subscribe(name, handler, last) {
      var ctx = context();
      var source = ctx && ctx.eventSource;
      var event = eventType(name);
      if (!source || !event) return;
      if (last && typeof source.makeLast === 'function') source.makeLast(event, handler);
      else source.on(event, handler);
      return function () { source.removeListener(event, handler); };
    }
    function listen(name, handler, last) {
      var remove = subscribe(name, handler, last);
      if (remove) stops.push(remove);
    }

    function isStory(type) { return !type || ['normal', 'regenerate', 'swipe', 'continue', 'group_chat', 'group'].indexOf(type) >= 0; }
    function current(t) { return t && t === turn && !t.auxiliary.length && engaged() && t.key === kit.chatKey(); }

    // Cache only inside this generation. ST deletes the old floor / adds the new user message
    // between GENERATION_AFTER_COMMANDS and the actual world-info scan.
    async function contents(t) {
      if (!t.pending) {
        var request = render(t.type).then(function (out) {
          if (t.pending === request) t.output = out;
          return out;
        });
        t.pending = request;
      }
      return t.pending;
    }

    // A preset can await Generate('quiet') or a token-count preview inside a story hook.
    // Neither request owns the story templates. ST previews finish at GENERATE_AFTER_DATA
    // without raising ENDED, and the stop button can emit ENDED for a nested quiet request.
    function pauseForAuxiliary(type, dryRun, started) {
      if (!turn || (!dryRun && isStory(type))) return false;
      var frames = turn.auxiliary;
      var top = frames[frames.length - 1];
      if (!started && top && top.started && top.type === type && top.dryRun === !!dryRun) {
        top.started = false;
      } else {
        if (turn.legacy && !frames.length) clearExtensionPrompts();
        frames.push({ type: type, dryRun: !!dryRun, started: started });
      }
      return true;
    }

    function resumeAfterAuxiliary(t) {
      t.auxiliary.pop();
      if (current(t) && t.legacy && t.output) legacyInject(t.config, t.output);
    }

    function finishLegacyPreview(dryRun) {
      if (!turn || !dryRun || hasEvent('GENERATE_AFTER_DATA')) return;
      var frame = turn.auxiliary[turn.auxiliary.length - 1];
      if (frame && frame.dryRun) resumeAfterAuxiliary(turn);
    }

    async function refreshLegacy() {
      var t = turn;
      if (!current(t) || !t.legacy) return;
      t.pending = t.output = null;
      var output = await contents(t);
      if (current(t) && t.output === output) legacyInject(t.config, output);
    }

    // Activated entries contain ST's own macro-expanded text. The prompt builder then
    // applies WORLD_INFO regex (including per-preset scripts) at the entry's depth.
    var regexEngine;
    listen('WORLD_INFO_ACTIVATED', async function (entries) {
      var t = turn;
      if (!current(t) || !Array.isArray(entries)) return;
      var own = entries.filter(function (entry) { return entry && entry.world === placement.world; });
      if (!own.length) return;
      if (!regexEngine && typeof env.hostImport === 'function') {
        regexEngine = env.hostImport('/scripts/extensions/regex/engine.js').catch(function () { return null; });
      }
      var engine = await regexEngine;
      if (!current(t)) return;
      var disabled = ((context() || {}).extensionSettings || {}).disabledExtensions || [];
      var rules = !disabled.includes('regex') && engine && typeof engine.getRegexScripts === 'function' && engine.regex_placement
        ? engine.getRegexScripts({ allowedOnly: true }).filter(function (rule) {
          return !rule.disabled && rule.promptOnly && Array.isArray(rule.placement) && rule.placement.includes(engine.regex_placement.WORLD_INFO);
        }) : [];
      t.worldEntries = {};
      own.forEach(function (entry) {
        var section = (placement.slots || placement.sections).find(function (item) { return item.uid === entry.uid; });
        if (!section) return;
        var depth = entry.position === 4 ? entry.depth : null;
        var applicable = rules.filter(function (rule) {
          return depth == null || !((rule.minDepth != null && depth < rule.minDepth)
            || (rule.maxDepth != null && rule.maxDepth >= 0 && depth > rule.maxDepth));
        });
        var dynamic = applicable.some(function (rule) { return regexUsesMacros(rule, entry.content); });
        t.worldEntries[section.key] = { entry: entry, engine: engine, rules: applicable, dynamic: dynamic };
      });
    });

    function regexUsesMacros(rule, text) {
      var replacement = String(rule.replaceString || '').replace(/{{match}}/gi, '$0');
      return (Number(rule.substituteRegex) > 0 && String(rule.findRegex).includes('{{')) || replacement.includes('{{')
        || (rule.trimStrings || []).some(function (s) { return String(s).includes('{{'); })
        || (text.includes('{{') && /\$(?:\d+|<)/.test(replacement));
    }

    function applyWithoutMacros(found) {
      var engine = found.engine;
      if (typeof engine.runRegexScript !== 'function') return null;
      var text = found.entry.content;
      for (var i = 0; i < found.rules.length; i += 1) {
        var rule = found.rules[i];
        if (!regexUsesMacros(rule, text)) {
          text = engine.runRegexScript(rule, text);
          continue;
        }
        if (Number(rule.substituteRegex) > 0 && String(rule.findRegex).includes('{{')) return null;
        // Use ST's regex parser and execution limits, with a literal replacement confined
        // to this probe. A preset's unrelated macro regex must not silence this section.
        var marker = 'ReaderII_regex_probe';
        while (text.includes(marker)) marker += '_';
        var probe = Object.assign({}, rule, { replaceString: marker, trimStrings: [] });
        if (engine.runRegexScript(probe, text) !== text) return null;
      }
      return text;
    }

    function worldText(t, key, original) {
      var found = t.worldEntries && t.worldEntries[key];
      if (!found) return original;
      if (found.text !== undefined) return found.text;
      // Replaying a regex containing macros could write a variable twice or reroll a value.
      // Retain the native output; only restore a version that was actually observed.
      var entry = found.entry, engine = found.engine;
      found.text = entry.content;
      if (engine && typeof engine.getRegexedString === 'function' && engine.regex_placement) {
        try {
          found.text = found.dynamic ? applyWithoutMacros(found) : engine.getRegexedString(entry.content, engine.regex_placement.WORLD_INFO, {
            depth: entry.position === 4 ? entry.depth : null, isMarkdown: false, isPrompt: true
          });
        } catch (error) { if (found.dynamic) found.text = null; log.warn('[ReaderII] 无法取得世界书正则处理后的文本', error); }
      }
      return found.text;
    }

    function cleanHistory(text) {
      // Reader instructions themselves contain sample event and UpdateVariable blocks.
      // Clean old events around any attached template, leaving its instructions intact.
      if (turn && turn.worldEntries) Object.values(turn.worldEntries).forEach(function (found) {
        if (found.dynamic && found.entry.content && text.includes(found.entry.content)) found.text = found.entry.content;
      });
      if (!/<(?:READER_(?:FP|TASK|ACTION)_EVENT|UpdateVariable)>/i.test(text)) return text;
      var templates = turn && turn.output;
      var chunks = [text];
      var unknown = false;
      if (templates) Object.keys(templates).forEach(function (key) {
        var block = templates[key];
        if (block && !text.includes(block)) block = worldText(turn, key, block);
        if (block === null) unknown = true;
        if (!block) return;
        chunks = chunks.flatMap(function (chunk) {
          if (typeof chunk !== 'string' || !chunk.includes(block)) return [chunk];
          var pieces = chunk.split(block);
          return pieces.flatMap(function (piece, i) { return i ? [{ text: block }, piece] : [piece]; });
        });
      });
      // If a dynamic script changed a template, only discard events attested by chat history.
      if (unknown && !turn.historyEvents) {
        turn.historyEvents = new Set();
        ((context() || {}).chat || []).forEach(function (message) {
          var body = String(message && message.mes || '');
          (body.match(EVENT_RE) || []).concat(body.match(UPDATE_RE) || []).forEach(function (tag) { turn.historyEvents.add(tag); });
        });
      }
      function historical(match) { return turn.historyEvents.has(match) ? '' : match; }
      return chunks.map(function (chunk) {
        if (typeof chunk !== 'string') return chunk.text;
        if (!unknown) return stripForPrompt(chunk);
        var cleaned = chunk.replace(EVENT_RE, historical);
        return hostHasMvu() ? cleaned : cleaned.replace(UPDATE_RE, historical);
      }).join('');
    }
    function messageText(msg) {
      if (!msg) return '';
      if (typeof msg.content === 'string') return msg.content;
      if (!Array.isArray(msg.content)) return '';
      return msg.content.filter(function (part) { return part && typeof part.text === 'string'; }).map(function (part) { return part.text; }).join('\n');
    }
    function normalized(text) { return text.replace(/\s+/g, ' ').trim(); }
    function containsBlock(delivered, block) {
      return delivered.includes(normalized(block)) || delivered.includes(normalized(JSON.stringify(block).slice(1, -1)));
    }
    function absent(t, output, text) {
      var delivered = normalized(text);
      return SLOTS.map(function (slot) {
        var block = output[slot.template];
        var p = t.config[slot.template];
        /* 各槽位看各自的开关：这一轮中途停用了 Reader、而导演还在执导时，不把读者的三段补回去（反过来也一样）。 */
        if (!block || !p || !p.enabled || p.position === 7 || !slotOn(slot.template)) return null;
        var found = t.worldEntries && t.worldEntries[slot.template];
        if (found && found.dynamic && found.entry.content && containsBlock(delivered, found.entry.content)) found.text = found.entry.content;
        if (containsBlock(delivered, block)) return null;
        var processed = worldText(t, slot.template, block);
        if (!processed || (processed !== block && containsBlock(delivered, processed))) return null;
        return { p: p, text: processed };
      }).filter(Boolean);
    }

    function insertionIndex(messages, p) {
      if (p.position === 0) return 0;
      var firstExample = -1, lastExample = -1, history = [];
      var end = messages.length;
      // Keep a trailing assistant prefill as the final message.
      if (end && messages[end - 1].role === 'assistant' && !messages[end - 1].tool_calls) end -= 1;
      for (var i = 0; i < end; i += 1) {
        var msg = messages[i];
        if (msg && /^example_(?:user|assistant)$/i.test(msg.name || '')) {
          if (firstExample < 0) firstExample = i;
          lastExample = i;
        } else if (msg && (msg.role === 'user' || msg.role === 'assistant') && !msg.tool_calls && !msg.function_call) {
          history.push(i);
        }
      }
      if (p.position === 5 && firstExample >= 0) return firstExample;
      if (p.position === 6 && lastExample >= 0) return lastExample + 1;
      var first = history.length ? history[0] : end;
      if (p.position === 1 || p.position === 5 || p.position === 6) return firstExample >= 0 ? Math.min(first, firstExample) : first;
      var depth = p.depth;
      if (p.position === 2 || p.position === 3) {
        var metadata = (context() || {}).chatMetadata || {};
        var note = metadata.note_prompt;
        if (note) for (var n = 0; n < end; n += 1) {
          if (messageText(messages[n]).includes(note) && messages[n].role !== 'tool' && !messages[n].tool_calls) return n + (p.position === 3 ? 1 : 0);
        }
        depth = metadata.note_depth == null ? 4 : Number(metadata.note_depth);
      }
      return depth > 0 && history.length ? history[Math.max(0, history.length - depth)] : end;
    }

    function ensureChat(t, output, messages) {
      var missing = absent(t, output, messages.map(messageText).join('\n'));
      var groups = new Map();
      missing.forEach(function (item) {
        var index = insertionIndex(messages, item.p);
        if (!groups.has(index)) groups.set(index, []);
        groups.get(index).push(item);
      });
      Array.from(groups.keys()).sort(function (a, b) { return b - a; }).forEach(function (index) {
        var rows = groups.get(index).sort(function (a, b) { return a.p.order - b.p.order; }).map(function (item) {
          return { role: item.p.position === 4 ? ['system', 'user', 'assistant'][item.p.role] : 'system', content: item.text };
        });
        messages.splice(index, 0, ...rows);
      });
    }

    async function ensureRequest(data, field, dryRun) {
      var t = turn;
      if (!current(t) || !data || dryRun || !isStory(data.type) || (data.type && t.type && data.type !== t.type)) return;
      var value = data[field];
      if (!Array.isArray(value) && typeof value !== 'string') return;
      var output = await contents(t);
      if (!current(t)) return;
      if (Array.isArray(value)) ensureChat(t, output, value);
      else {
        // A flattened text-completion prompt no longer has role/depth anchors. Keep its
        // generation suffix intact if a preset discarded a world-info slot.
        var missing = absent(t, output, value).sort(function (a, b) { return a.p.order - b.p.order; });
        if (missing.length) {
          // NovelAI Erato requires this pair at the very start of its input.
          var eratoStart = '<|startoftext|><|reserved_special_token81|>';
          var offset = field === 'input' && value.startsWith(eratoStart) ? eratoStart.length : 0;
          // ST may already have wrapped the story in the selected instruct template's system turn.
          var power = (context() || {}).powerUserSettings;
          var instruct = power && power.instruct;
          if (instruct && instruct.enabled && typeof instruct.story_string_prefix === 'string' && instruct.story_string_prefix) {
            var storyPrefix = instruct.story_string_prefix.replace(/{{name}}/gi, 'System') + (instruct.wrap ? '\n' : '');
            if (value.startsWith(storyPrefix, offset)) offset += storyPrefix.length;
          }
          var insert = missing.map(function (item) { return item.text; }).join('\n\n');
          data[field] = value.slice(0, offset) + insert + '\n\n' + value.slice(offset);
        }
      }
    }

    function onGenerateData(data, dryRun) {
      var t = turn;
      if (t && t.auxiliary.length) {
        var frame = t.auxiliary[t.auxiliary.length - 1];
        if (frame.dryRun === !!dryRun) {
          if (!dryRun) t.auxiliaryEnds += 1;
          resumeAfterAuxiliary(t);
        }
        return;
      }
      // ST sends NovelAI's input directly, while Kobold, TextGen and chat assembly use prompt.
      var field = data && data.prompt == null && typeof data.input === 'string' ? 'input' : 'prompt';
      if (current(t) && !dryRun && data && (!data.type || data.type === t.type)) {
        t.auxiliaryEnds = 0;
        t.submitted = typeof data[field] === 'string' || !hasEvent('CHAT_COMPLETION_SETTINGS_READY');
      }
      return ensureRequest(data, field, dryRun);
    }
    function onSettingsReady(data) {
      // generateRaw / assistant side calls can fire this event while a story is running.
      // ST stamps the request type on the outgoing payload (raw/connection tests use quiet).
      if (data && typeof data.type === 'string') {
        if (turn && turn.type === data.type) {
          // A quiet request can fail before either its data or its UI end event. The typed
          // send is unambiguous: a token-count dry run never sends a provider request.
          turn.auxiliary.length = 0;
          turn.auxiliaryEnds = 0;
          turn.submitted = true;
        }
        return ensureRequest(data, 'messages', false);
      }
    }
    listen('GENERATION_STARTED', function (type, _options, dryRun) { pauseForAuxiliary(type, dryRun, true); });
    listen('GENERATION_AFTER_COMMANDS', async function (type, _options, dryRun) {
      if (pauseForAuxiliary(type, dryRun, false) || dryRun) return;
      clear();
      if (!isStory(type) || !engaged()) return;
      var t = turn = { key: kit.chatKey(), type: type || 'normal', config: placement.placements(context()),
        listeners: [], auxiliary: [], auxiliaryEnds: 0, legacy: !hasEvent('WORLDINFO_ENTRIES_LOADED') };
      // A newly selected preset can install its own makeLast handlers after startup.
      t.listeners = [subscribe('GENERATE_AFTER_DATA', onGenerateData, true),
        subscribe('CHAT_COMPLETION_SETTINGS_READY', onSettingsReady, true)].filter(Boolean);
      if (t.legacy) {
        var chat = (context() || {}).chat || [];
        var awaitingDeletion = type === 'regenerate' && hasEvent('MESSAGE_DELETED') && chat.length && !chat[chat.length - 1].is_user;
        if (!awaitingDeletion) await refreshLegacy();
      }
    }, true);
    // ST writes the user's input or deletes the rejected answer after AFTER_COMMANDS.
    // Older hosts take their extension-prompt snapshot after these message events.
    listen('MESSAGE_SENT', refreshLegacy);
    listen('MESSAGE_DELETED', refreshLegacy);
    listen('WORLDINFO_ENTRIES_LOADED', async function (data) {
      var t = turn;
      if (!current(t) || !data || !Array.isArray(data.characterLore)) return;
      var out = await contents(t);
      if (!current(t)) return;
      placement.entries(t.config, out).forEach(function (entry) {
        entry.triggers = [t.type === 'group_chat' || t.type === 'group' ? 'normal' : t.type];
        if (!data.characterLore.some(function (old) { return old.world === entry.world && old.uid === entry.uid; })) data.characterLore.push(entry);
      });
    });
    listen('GENERATION_ENDED', function () {
      if (turn && !turn.submitted && turn.auxiliaryEnds) { turn.auxiliaryEnds -= 1; return; }
      if (turn && turn.auxiliary.length) { resumeAfterAuxiliary(turn); return; }
      clear();
    });
    listen('GENERATION_STOPPED', clear);
    listen('CHAT_CHANGED', function () {
      clear();
      later(retireOnce, 1500);
    });
    listen('CHAT_COMPLETION_PROMPT_READY', function (data) {
      if (!data || !Array.isArray(data.chat)) return;
      /* 事件块的清理只属于读者；导演单独执导时（卡没启用 Reader）只做最后的防吞槽兜底。 */
      var story = enabled();
      if (!story && !directorOn()) return;
      finishLegacyPreview(data.dryRun);
      if (story) data.chat.forEach(function (message) {
        if (!message || message.role === 'tool' || message.role === 'function') return;
        if (typeof message.content === 'string') message.content = cleanHistory(message.content);
        else if (Array.isArray(message.content)) message.content.forEach(function (part) { if (part && typeof part.text === 'string') part.text = cleanHistory(part.text); });
      });
      if (!hasEvent('GENERATE_AFTER_DATA') && !hasEvent('CHAT_COMPLETION_SETTINGS_READY')) return ensureRequest(data, 'chat', data.dryRun);
    });
    listen('GENERATE_AFTER_COMBINE_PROMPTS', function (data) {
      if (!data || typeof data.prompt !== 'string') return;
      var story = enabled();
      if (!story && !directorOn()) return;
      finishLegacyPreview(data.dryRun);
      if (story) data.prompt = cleanHistory(data.prompt);
      if (!hasEvent('GENERATE_AFTER_DATA')) return ensureRequest(data, 'prompt', data.dryRun);
    });

    var formatter = installFormatter();
    if (!formatter) installRegexFallback();
    later(retireOnce, 2500);

    /* 启用状态变了：已经画出来的楼层要按新的规则重画一遍（来信插槽、事件块）。 */
    var onCoreChanged = function (event) {
      if (!event || !event.detail || event.detail.reason !== 'enabled_changed') return;
      if (!enabled()) yieldStory();
      if (!formatter) {
        if (!coexisting()) installRegexFallback();
        syncBuiltinRegexForCoexist();
      }
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
      yieldStory: yieldStory,
      /*
       * 登记可选槽位的提供者。目前只有 'director'：{ active() → 布尔（同步、便宜）, brief(generationType) → 文本或 Promise }。
       * 传 null 取消登记。返回是否登记成功。
       */
      registerSlot: function (name, provider) {
        if (name !== DIRECTOR_SLOT.template) return false;
        var valid = provider && typeof provider.active === 'function' && typeof provider.brief === 'function';
        directorProvider = valid ? provider : null;
        if (!valid && directorTouched) {
          setPrompt(DIRECTOR_SLOT.id, '', DIRECTOR_SLOT.position, DIRECTOR_SLOT.depth);
          directorTouched = false;
        }
        return !!valid;
      },
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
