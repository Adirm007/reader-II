/*! Reader-II 4.0.0-alpha.1 · 夜梦助手扩展包 · https://github.com/Adirm007/reader-II · 许可见 LICENSE */
(function (root) { (root.__ReaderIIModules = root.__ReaderIIModules || {}).BUILD_VERSION = "4.0.0-alpha.1"; })(typeof globalThis !== 'undefined' ? globalThis : window);
/* ---- src/reader-env.js ---- */
(function (root) {
  'use strict';

  /*
   * 运行环境。两种载体共用：
   *   extension  酒馆扩展，代码直接跑在酒馆主窗口；
   *   script     酒馆助手脚本，代码跑在脚本 iframe 里，酒馆是上层窗口。
   * 所有宿主接口都在调用时解析，酒馆助手晚于本脚本就绪、或根本没装时也不会在加载期报错。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  if (!modules.isObject) modules.isObject = function (value) { return !!value && typeof value === 'object' && !Array.isArray(value); };
  if (!modules.clone) modules.clone = function (value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); };
  if (!modules.hashText) {
    modules.hashText = function (text) {
      var hash = 0x811c9dc5, source = String(text == null ? '' : text);
      for (var index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16);
    };
  }

  /*
   * 本机存储键（浏览器 localStorage，同一个站点的所有角色卡共用）。左边的旧键是原版读者（以及 reader-II v3.3）用的；
   * 同一个浏览器里两张卡都装着时，reader-II 只用右边自己的键，互不干扰（交接 0.6 甲组第 11 项）。
   * 第三项为 true 的是偏好与用户数据：新键还没有值时从旧键抄一次（v3.3 用户的偏好都在旧键下），旧键不删（原版读者可能还在用）。
   * false 的是缓存与临时状态，不抄，用到时重新生成。
   * 这是唯一的一张表：构建期 build/controller.mjs 也读它，给控制器与 letter.js 换键；① ② 的代码用 modules.localKey(旧键) 取新键。
   */
  modules.LOCAL_KEYS = [
    ['dream_visual_theme', 'reader_ii_visual_theme', true], /* 主题的本机兜底；聊天变量 dream_visual_theme 不改 */
    ['dream_render_mode', 'reader_ii_render_mode', true], /* 显示模式：内嵌 / 悬浮 */
    ['dream_auto_unseal', 'reader_ii_auto_unseal', true], /* 自动拆信 */
    ['dream_hide_persistent_float', 'reader_ii_hide_persistent_float', true], /* 隐藏悬浮窗 */
    ['dream_ui_v4', 'reader_ii_ui_v4', true], /* 新旧前端 */
    ['dream_letter_unfold', 'reader_ii_letter_unfold', true], /* 信纸展开 */
    ['dream_font', 'reader_ii_font', true],
    ['dream_font_size', 'reader_ii_font_size', true],
    ['dream_summer_radio_pos', 'reader_ii_summer_radio_pos', true], /* 盛夏主题收音机的位置 */
    ['dream_albums', 'reader_ii_albums', true], /* 歌单 */
    ['dream_playlist', 'reader_ii_playlist', true], /* 更早的单个歌单，读到时转成专辑 */
    ['dream_current_album', 'reader_ii_current_album', true],
    ['dream_play_mode', 'reader_ii_play_mode', true],
    ['dream_independent_api_v2', 'reader_ii_independent_api_v2', true], /* 独立 API 方案；网关（reader-llm-gateway.js）也读 */
    ['dream_independent_api_v1', 'reader_ii_independent_api_v1', true], /* 更早的单方案，v2 不存在时转成 v2 */
    ['dream_independent_api_models_v1', 'reader_ii_independent_api_models_v1', false], /* 模型列表缓存 */
    ['dream_lobby_open', 'reader_ii_lobby_open', false], /* 大厅：刷新后重开用的临时状态 */
    ['dream_lobby_at', 'reader_ii_lobby_at', false],
    ['dream_lobby_key', 'reader_ii_lobby_key', false],
    ['dream_gallery_cache_v1', 'reader_ii_gallery_cache_v1', false], /* 相册缓存 */
    ['dream_persona_dlc_cache_v1', 'reader_ii_persona_dlc_cache_v1', false], /* 形象扩展缓存 */
    ['dream_persona_dlc_meta_v1', 'reader_ii_persona_dlc_meta_v1', false],
    ['dream_worldbook_check_v1', 'reader_ii_worldbook_check_v1', false] /* 世界书检查更新的状态（通用版没有这个入口） */
  ];
  /* 迁移做过的旧键记在这里：只抄一次，之后新键被删掉（例如字号恢复默认）也不会再从旧键抄回来。 */
  modules.LOCAL_KEYS_MARK = 'reader_ii_local_keys_migrated_v1';

  modules.localKey = function (oldKey) {
    for (var index = 0; index < modules.LOCAL_KEYS.length; index += 1) {
      if (modules.LOCAL_KEYS[index][0] === oldKey) return modules.LOCAL_KEYS[index][1];
    }
    throw new Error('本机存储键表里没有 ' + oldKey);
  };

  /* createEnv 时自动跑一次（① ② 谁先启动谁做）；控制器与轻信页都由壳在这之后创建。返回这次抄过去的新键。 */
  modules.migrateLocalKeys = function (storage) {
    var copied = [];
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return copied;
    var done;
    try { done = JSON.parse(storage.getItem(modules.LOCAL_KEYS_MARK) || '[]'); } catch (error) { done = []; }
    if (!Array.isArray(done)) done = [];
    var changed = false;
    modules.LOCAL_KEYS.forEach(function (entry) {
      if (!entry[2] || done.indexOf(entry[0]) >= 0) return;
      try {
        if (storage.getItem(entry[1]) == null) {
          var value = storage.getItem(entry[0]);
          if (value != null) {
            storage.setItem(entry[1], value);
            copied.push(entry[1]);
          }
        }
        done.push(entry[0]);
        changed = true;
      } catch (error) { /* 例如超出配额：这一项不记，下次再试 */ }
    });
    if (changed) {
      try { storage.setItem(modules.LOCAL_KEYS_MARK, JSON.stringify(done)); } catch (error) { /* ignore */ }
    }
    return copied;
  };

  function sameOrigin(win) {
    try { return !!win && !!win.document; } catch (error) { return false; }
  }

  /*
   * 酒馆主窗口：从自己往上找，取最外层、同源、带 SillyTavern.getContext 的那一层（与 reader-ii-loader.js 相同）。
   * 不能停在第一个找到的：酒馆助手给脚本 iframe 的 SillyTavern 也可能带 getContext，停在那里会把壳与控制器建进看不见的脚本 iframe，
   * 扫不到聊天里的插槽，host.ReaderCore 也挂错地方。
   */
  function findHost(scope) {
    var start = scope.window || scope;
    var current = start;
    var found = null;
    for (var depth = 0; current && depth < 6; depth += 1) {
      try {
        if (sameOrigin(current) && current.SillyTavern && typeof current.SillyTavern.getContext === 'function') found = current;
      } catch (error) { /* 跨域上层 */ }
      var parent = null;
      try { parent = current.parent; } catch (error) { parent = null; }
      if (!parent || parent === current) break;
      current = parent;
    }
    if (found) return found;
    try { if (start.parent && start.parent !== start && sameOrigin(start.parent)) return start.parent; } catch (error) { /* ignore */ }
    return start;
  }

  function createEnv(scope, overrides) {
    var base = scope || root;
    var host = findHost(base);
    var candidates = [base, base.window, host].filter(function (item, index, list) { return item && list.indexOf(item) === index; });

    function find(name) {
      for (var index = 0; index < candidates.length; index += 1) {
        var candidate = candidates[index], value;
        try { value = candidate[name]; } catch (error) { value = undefined; }
        if (value !== undefined) return typeof value === 'function' ? value.bind(candidate) : value;
      }
      return undefined;
    }

    function findHelper(name) {
      for (var index = 0; index < candidates.length; index += 1) {
        var helper;
        try { helper = candidates[index].TavernHelper; } catch (error) { helper = null; }
        if (helper && helper[name] !== undefined) return typeof helper[name] === 'function' ? helper[name].bind(helper) : helper[name];
      }
      return undefined;
    }

    function resolveFunction(name) {
      var value = findHelper(name) || find(name);
      return typeof value === 'function' ? value : undefined;
    }

    function context() {
      try { return host.SillyTavern && typeof host.SillyTavern.getContext === 'function' ? host.SillyTavern.getContext() : null; }
      catch (error) { return null; }
    }

    function eventTypes() {
      var ctx = context();
      return find('tavern_events') || findHelper('tavern_events') || ctx && (ctx.eventTypes || ctx.event_types) || {};
    }

    /* 订阅酒馆事件，返回 { stop }。脚本载体用酒馆助手的 eventOn（随脚本卸载自动清理），扩展载体直接挂酒馆事件源。 */
    function eventOn(event, handler) {
      var helperOn = find('eventOn');
      if (typeof helperOn === 'function') {
        var handle = helperOn(event, handler);
        return handle && typeof handle.stop === 'function' ? handle : { stop: function () {
          var off = find('eventRemoveListener');
          if (typeof off === 'function') { try { off(event, handler); } catch (error) { /* ignore */ } }
        } };
      }
      var ctx = context();
      var source = ctx && ctx.eventSource;
      if (!source || typeof source.on !== 'function') return null;
      source.on(event, handler);
      return { stop: function () { try { source.removeListener(event, handler); } catch (error) { /* ignore */ } } };
    }

    /* 在酒馆主窗口的模块图里动态 import（世界书等内部模块只有这样才能拿到活的绑定）。 */
    function hostImport(path) {
      try { return new host.Function('p', 'return import(p)')(path); }
      catch (error) { return Promise.reject(error); }
    }

    var env = {
      host: host,
      root: base,
      carrier: host === (base.window || base) ? 'extension' : 'script',
      console: find('console') || console,
      document: host && host.document,
      toastr: find('toastr'),
      find: find,
      findHelper: findHelper,
      resolveFunction: resolveFunction,
      context: context,
      eventOn: eventOn,
      hostImport: hostImport,
      getButtonEvent: find('getButtonEvent'),
      getChatMessages: resolveFunction('getChatMessages'),
      getVariables: resolveFunction('getVariables'),
      insertOrAssignVariables: resolveFunction('insertOrAssignVariables'),
      waitGlobalInitialized: find('waitGlobalInitialized'),
      initializeGlobal: find('initializeGlobal') || find('initializeGlobalApi'),
      generate: resolveFunction('generate'),
      generateRaw: resolveFunction('generateRaw'),
      getModelList: resolveFunction('getModelList'),
      generateQuietPrompt: resolveFunction('generateQuietPrompt'),
      injectPrompts: resolveFunction('injectPrompts'),
      storage: (function () { try { return host && host.localStorage || null; } catch (error) { return null; } })()
    };
    Object.defineProperty(env, 'tavern_events', { enumerable: true, get: eventTypes });
    if (overrides) Object.keys(overrides).forEach(function (key) { env[key] = overrides[key]; });
    modules.migrateLocalKeys(env.storage);
    return env;
  }

  modules.findHostWindow = findHost;
  modules.createEnv = createEnv;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/reader-host-kit.js ---- */
(function (root) {
  'use strict';

  /*
   * 宿主工具箱：Agent 与记忆共用的酒馆 / 酒馆助手访问层。
   * 每个函数都在调用时解析宿主接口（脚本先于酒馆助手就绪、或接口后来才出现时仍可用），
   * 并把不同版本的返回形状归一。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  function createHostKit(env) {
    function fn(name) {
      var resolved = env && typeof env.resolveFunction === 'function' ? env.resolveFunction(name) : null;
      if (typeof resolved === 'function') return resolved;
      return env && typeof env[name] === 'function' ? env[name] : null;
    }

    function need(name) {
      var found = fn(name);
      if (!found) throw new Error('当前酒馆助手没有提供 ' + name + ' 接口');
      return found;
    }

    function context() {
      try {
        var tavern = env && env.host && env.host.SillyTavern;
        return tavern && typeof tavern.getContext === 'function' ? tavern.getContext() : null;
      } catch (error) { return null; }
    }

    function chatKey() {
      var ctx = context();
      if (!ctx) return '';
      var chat = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
      return String(ctx.characterId == null ? '' : ctx.characterId) + '|' + String(chat == null ? '' : chat);
    }

    function names() {
      var ctx = context() || {};
      var character = ctx.characters && ctx.characters[ctx.characterId];
      return {
        user: String(ctx.name1 || '用户'),
        char: String(ctx.name2 || character && character.name || '角色'),
        chat: String((typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId) || '')
      };
    }

    /* ---------- 聊天 ---------- */
    function rawChat() {
      var ctx = context();
      return ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
    }

    function messageRole(message) {
      if (!message) return 'system';
      if (message.is_user === true) return 'user';
      if (message.is_system === true) return 'system';
      return 'assistant';
    }

    /* [{id, role, name, text}]；隐藏楼层（is_system）默认跳过。 */
    function readChat(from, to, options) {
      var chat = rawChat();
      var start = Math.max(0, Math.trunc(Number(from) || 0));
      var end = Math.min(chat.length, to === undefined || to === null ? chat.length : Math.trunc(Number(to)));
      var includeHidden = options && options.includeHidden === true;
      var output = [];
      for (var index = start; index < end; index += 1) {
        var message = chat[index];
        if (!message) continue;
        var role = messageRole(message);
        if (role === 'system' && !includeHidden) continue;
        output.push({ id: index, role: role, name: String(message.name || ''), text: String(message.mes == null ? '' : message.mes) });
      }
      return output;
    }

    function chatLength() { return rawChat().length; }

    /* 改一楼的正文并保存、重绘。 */
    async function setMessageText(id, text) {
      var set = fn('setChatMessages');
      if (set) { await set([{ message_id: id, message: String(text) }], { refresh: 'affected' }); return; }
      var ctx = context();
      var message = rawChat()[id];
      if (!message) throw new Error('没有第 ' + id + ' 楼');
      message.mes = String(text);
      if (Array.isArray(message.swipes) && message.swipe_id != null) message.swipes[message.swipe_id] = String(text);
      if (ctx && typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(id, message);
      if (ctx && typeof ctx.saveChat === 'function') await ctx.saveChat();
    }

    /* 去掉思维链、变量更新块、Reader 事件、代码块与标签，得到可读正文。 */
    function cleanText(input) {
      return String(input == null ? '' : input)
        .replace(/<(thinking|think|reasoning|thought)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, ' ')
        .replace(/<READER_(?:FP|TASK|ACTION)_EVENT>[\s\S]*?<\/READER_(?:FP|TASK|ACTION)_EVENT>/gi, ' ')
        .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<dream>/gi, '【夜梦来信】').replace(/<\/dream>/gi, '【来信结束】')
        .replace(/<\/?[A-Za-z_][^<>]{0,200}>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/[ \t　]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    /* ---------- 变量 ---------- */
    function chatVariables() {
      var ctx = context();
      if (ctx && ctx.chatMetadata) {
        if (!modules.isObject(ctx.chatMetadata.variables)) ctx.chatMetadata.variables = {};
        return ctx.chatMetadata.variables;
      }
      return null;
    }

    function readChatValue(key) {
      var vars = chatVariables();
      var value;
      if (vars) value = vars[key];
      else {
        var getVariables = fn('getVariables');
        if (getVariables) {
          try { value = (getVariables({ type: 'chat' }) || {})[key]; } catch (error) { value = undefined; }
        }
      }
      if (typeof value === 'string') {
        /* 对象常被存成 JSON 字符串；普通字符串（如人格 id、称呼）原样返回。 */
        if (/^\s*[\[{]/.test(value)) {
          try { return JSON.parse(value); } catch (error) { return value; }
        }
        return value;
      }
      return value === undefined ? undefined : modules.clone(value);
    }

    var saveTimer = null;
    function writeChatValue(key, value) {
      var vars = chatVariables();
      if (vars) {
        if (value === undefined) delete vars[key];
        else vars[key] = modules.clone(value);
        var ctx = context();
        if (ctx && typeof ctx.saveMetadata === 'function') {
          /* 连续写入合并成一次保存。 */
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(function () {
            saveTimer = null;
            try { Promise.resolve(ctx.saveMetadata()).catch(function () {}); } catch (error) { /* best-effort */ }
          }, 150);
        }
        return true;
      }
      var insert = fn('insertOrAssignVariables');
      if (!insert) return false;
      try {
        var payload = {};
        payload[key] = modules.clone(value);
        insert(payload, { type: 'chat' });
        return true;
      } catch (error) { return false; }
    }

    function localRead(key, fallback) {
      try {
        var store = env && env.storage;
        var raw = store && store.getItem(key);
        if (!raw) return fallback;
        var value = JSON.parse(raw);
        return value === null || value === undefined ? fallback : value;
      } catch (error) { return fallback; }
    }

    function localWrite(key, value) {
      try {
        var store = env && env.storage;
        if (!store) return false;
        if (value === undefined) store.removeItem(key);
        else store.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) { return false; }
    }

    /* ---------- 世界书 ---------- */
    function list(value) { return Array.isArray(value) ? value : value && Array.isArray(value.entries) ? value.entries : []; }

    /*
     * 没有酒馆助手时走酒馆原生的世界书接口，并把条目换算成酒馆助手的形状
     * （uid / name / enabled / content / strategy / position），上层只认这一种。
     */
    var WI_POSITIONS = ['before_character_definition', 'after_character_definition', 'before_author_note', 'after_author_note', 'at_depth', 'before_example_messages', 'after_example_messages'];
    var WI_LOGIC = ['and_any', 'not_all', 'not_any', 'and_all'];
    var WI_ROLES = ['system', 'user', 'assistant'];

    function nativeToEntry(raw) {
      return {
        uid: raw.uid, name: String(raw.comment || ''), enabled: raw.disable !== true, content: String(raw.content || ''),
        strategy: {
          type: raw.constant ? 'constant' : raw.vectorized ? 'vectorized' : 'selective',
          keys: (raw.key || []).slice(),
          keys_secondary: { logic: WI_LOGIC[raw.selectiveLogic || 0] || 'and_any', keys: (raw.keysecondary || []).slice() }
        },
        position: { type: WI_POSITIONS[raw.position || 0] || WI_POSITIONS[0], order: Number(raw.order) || 0, depth: Number(raw.depth) || 0, role: WI_ROLES[raw.role || 0] || 'system' },
        probability: raw.probability == null ? 100 : Number(raw.probability)
      };
    }

    function entryToNative(entry, raw) {
      var target = raw || {
        key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true, selectiveLogic: 0,
        addMemo: true, order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false,
        probability: 100, useProbability: true, depth: 4, group: '', role: 0
      };
      if (entry.name !== undefined) target.comment = String(entry.name);
      if (entry.content !== undefined) target.content = String(entry.content);
      if (entry.enabled !== undefined) target.disable = entry.enabled === false;
      if (modules.isObject(entry.strategy)) {
        if (entry.strategy.type) { target.constant = entry.strategy.type === 'constant'; target.vectorized = entry.strategy.type === 'vectorized'; }
        if (Array.isArray(entry.strategy.keys)) target.key = entry.strategy.keys.map(String);
        if (modules.isObject(entry.strategy.keys_secondary)) {
          if (Array.isArray(entry.strategy.keys_secondary.keys)) target.keysecondary = entry.strategy.keys_secondary.keys.map(String);
          if (WI_LOGIC.indexOf(entry.strategy.keys_secondary.logic) >= 0) target.selectiveLogic = WI_LOGIC.indexOf(entry.strategy.keys_secondary.logic);
        }
      }
      if (modules.isObject(entry.position)) {
        if (WI_POSITIONS.indexOf(entry.position.type) >= 0) target.position = WI_POSITIONS.indexOf(entry.position.type);
        if (entry.position.order !== undefined) target.order = Number(entry.position.order) || 0;
        if (entry.position.depth !== undefined) target.depth = Number(entry.position.depth) || 0;
        if (WI_ROLES.indexOf(entry.position.role) >= 0) target.role = WI_ROLES.indexOf(entry.position.role);
      }
      if (entry.probability !== undefined) target.probability = Number(entry.probability);
      return target;
    }

    async function nativeBook(name) {
      var ctx = context();
      if (!ctx || typeof ctx.loadWorldInfo !== 'function') throw new Error('当前环境没有世界书接口');
      var data = await ctx.loadWorldInfo(String(name));
      if (!data || !modules.isObject(data.entries)) data = { entries: {} };
      return data;
    }

    async function nativeSave(name, data) {
      var ctx = context();
      await ctx.saveWorldInfo(String(name), data, true);
      if (typeof ctx.reloadWorldInfoEditor === 'function') { try { ctx.reloadWorldInfoEditor(String(name)); } catch (error) { /* 编辑器没开 */ } }
    }

    function nativeEntries(data) {
      return Object.keys(data.entries).map(function (key) { return nativeToEntry(data.entries[key]); });
    }

    /* 把上层给的条目列表写回原生结构：按 uid 对应，新条目分配新 uid，列表里没有的删除。 */
    function applyNativeEntries(data, entries) {
      var next = {}, used = {};
      Object.keys(data.entries).forEach(function (key) { used[data.entries[key].uid] = data.entries[key]; });
      var maxUid = Object.keys(used).reduce(function (max, uid) { return Math.max(max, Number(uid) || 0); }, -1);
      entries.forEach(function (entry) {
        var raw = entry.uid !== undefined && used[entry.uid] ? used[entry.uid] : null;
        var uid = raw ? raw.uid : (maxUid += 1);
        next[uid] = entryToNative(entry, raw);
        next[uid].uid = uid;
      });
      data.entries = next;
    }

    function worldbookNames() {
      var get = fn('getWorldbookNames');
      try {
        if (get) return (get() || []).map(String);
        /* 酒馆的世界书下拉框里有全部书名。 */
        var options = env.document ? env.document.querySelectorAll('#world_editor_select option') : [];
        return Array.prototype.filter.call(options, function (option) { return option.value !== ''; }).map(function (option) { return String(option.textContent || '').trim(); }).filter(Boolean);
      } catch (error) { return []; }
    }

    function globalWorldbooks() {
      var get = fn('getGlobalWorldbookNames');
      try {
        if (get) return (get() || []).map(String);
        /* 原生：全局启用的世界书就是 #world_info 下拉框里选中的那些。 */
        var options = env.document ? env.document.querySelectorAll('#world_info option:checked') : [];
        return Array.prototype.map.call(options, function (option) { return String(option.textContent || '').trim(); }).filter(Boolean);
      } catch (error) { return []; }
    }

    function charWorldbooks() {
      var get = fn('getCharWorldbookNames');
      try {
        if (!get) {
          /* 原生：角色卡绑定的主世界书记在 data.extensions.world；附加世界书存在酒馆内部设置里，这里拿不到。 */
          var ctx = context();
          var card = ctx && ctx.characters && ctx.characters[ctx.characterId];
          var world = card && card.data && card.data.extensions && card.data.extensions.world;
          return { primary: world ? String(world) : null, additional: [] };
        }
        var value = get ? get('current') : null;
        return { primary: value && value.primary ? String(value.primary) : null, additional: value && Array.isArray(value.additional) ? value.additional.map(String) : [] };
      } catch (error) { return { primary: null, additional: [] }; }
    }

    function chatWorldbook() {
      var get = fn('getChatWorldbookName');
      try {
        var name;
        if (get) name = get('current');
        else { var ctx = context(); name = ctx && ctx.chatMetadata && ctx.chatMetadata.world_info; }   /* 原生：聊天绑定的世界书记在聊天元数据里 */
        return name ? String(name) : null;
      } catch (error) { return null; }
    }

    function worldbookScopes() {
      var character = charWorldbooks();
      return {
        all: worldbookNames(),
        global: globalWorldbooks(),
        character_primary: character.primary,
        character_additional: character.additional,
        chat: chatWorldbook()
      };
    }

    function isWorldbookActive(name) {
      var scopes = worldbookScopes();
      return scopes.global.indexOf(name) >= 0 || scopes.character_primary === name
        || scopes.character_additional.indexOf(name) >= 0 || scopes.chat === name;
    }

    async function readWorldbook(name) {
      var get = fn('getWorldbook');
      if (get) return list(await get(String(name)));
      return nativeEntries(await nativeBook(name));
    }

    async function createWorldbook(name) {
      var title = String(name || '').trim();
      if (!title) throw new Error('世界书名不能为空');
      if (worldbookNames().indexOf(title) >= 0) return false;
      var create = fn('createWorldbook');
      if (create) { await create(title, []); return true; }
      await nativeSave(title, { entries: {} });
      var ctx = context();
      if (ctx && typeof ctx.updateWorldInfoList === 'function') { try { await ctx.updateWorldInfoList(); } catch (error) { /* 列表下次打开会刷新 */ } }
      return true;
    }

    async function addWorldbookEntries(name, entries) {
      if (!fn('createWorldbookEntries') && !fn('updateWorldbookWith')) {
        var data = await nativeBook(name);
        var before = nativeEntries(data);
        applyNativeEntries(data, before.concat(entries));
        await nativeSave(name, data);
        return nativeEntries(data).slice(before.length);
      }
      var create = fn('createWorldbookEntries');
      if (create) {
        var result = await create(String(name), entries);
        var made = result && Array.isArray(result.new_entries) ? result.new_entries : [];
        if (made.length) return made;
      } else {
        await need('updateWorldbookWith')(String(name), function (book) { return list(book).concat(entries); });
      }
      /* 旧版不回传新条目：按名称回读。 */
      var current = await readWorldbook(name);
      return entries.map(function (entry) {
        for (var index = current.length - 1; index >= 0; index -= 1) {
          if (String(current[index].name || '') === String(entry.name || '')) return current[index];
        }
        return entry;
      });
    }

    async function updateWorldbook(name, updater) {
      if (!fn('updateWorldbookWith')) {
        var data = await nativeBook(name);
        var current = nativeEntries(data);
        var changed = updater(current);
        applyNativeEntries(data, Array.isArray(changed) ? changed : current);
        await nativeSave(name, data);
        return nativeEntries(data);
      }
      return list(await need('updateWorldbookWith')(String(name), function (book) {
        var entries = list(book);
        var next = updater(entries);
        return Array.isArray(next) ? next : entries;
      }));
    }

    async function mountWorldbook(name, mode) {
      if (mode === 'global') {
        var current = globalWorldbooks();
        if (current.indexOf(name) < 0) await need('rebindGlobalWorldbooks')(current.concat([name]));
        return 'global';
      }
      if (mode === 'character') {
        var books = charWorldbooks();
        if (books.primary !== name && books.additional.indexOf(name) < 0) {
          await need('rebindCharWorldbooks')('current', { primary: books.primary, additional: books.additional.concat([name]) });
        }
        return 'character';
      }
      return 'none';
    }

    function findEntry(entries, query) {
      var target = String(query == null ? '' : query).trim();
      if (!target) return null;
      var uid = /^\d+$/.test(target) ? Number(target) : null;
      var exact = null, partial = null;
      entries.forEach(function (entry) {
        var name = String(entry.name || '');
        if (uid !== null && entry.uid === uid && !exact) exact = entry;
        if (name === target && !exact) exact = entry;
        if (!partial && name && (name.indexOf(target) >= 0 || target.indexOf(name) >= 0)) partial = entry;
      });
      return exact || partial;
    }

    /* ---------- 提示词注入 ---------- */
    async function inject(prompts) {
      var injectPrompts = fn('injectPrompts');
      if (injectPrompts) { await injectPrompts(prompts); return true; }
      /* 没有酒馆助手：用酒馆原生的扩展提示词（位置 1 = 聊天内按深度，-1 = 不注入；角色 0/1/2 = system/user/assistant）。 */
      var ctx = context();
      if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return false;
      (prompts || []).forEach(function (prompt) {
        var off = prompt.position === 'none' || !prompt.content;
        var role = prompt.role === 'user' ? 1 : prompt.role === 'assistant' ? 2 : 0;
        ctx.setExtensionPrompt(String(prompt.id), off ? '' : String(prompt.content), off ? -1 : 1, Math.max(0, Number(prompt.depth) || 0), prompt.should_scan === true, role);
      });
      return true;
    }

    async function uninject(ids) {
      var uninjectPrompts = fn('uninjectPrompts');
      if (uninjectPrompts) {
        try { await uninjectPrompts(ids); return true; } catch (error) { /* fall through */ }
      }
      /* 没有撤销接口时写入空内容。 */
      return inject(ids.map(function (id) { return { id: id, content: '', position: 'none', depth: 0, role: 'system', should_scan: false }; }));
    }

    function on(eventName, handler) {
      var events = env && env.tavern_events || {};
      var event = events[eventName];
      if (!event) return null;
      if (env && typeof env.eventOn === 'function') return env.eventOn(event, handler);
      var eventOn = fn('eventOn');
      return eventOn ? eventOn(event, handler) : null;
    }

    return {
      fn: fn,
      need: need,
      context: context,
      chatKey: chatKey,
      names: names,
      rawChat: rawChat,
      setMessageText: setMessageText,
      readChat: readChat,
      chatLength: chatLength,
      cleanText: cleanText,
      readChatValue: readChatValue,
      writeChatValue: writeChatValue,
      localRead: localRead,
      localWrite: localWrite,
      worldbookNames: worldbookNames,
      worldbookScopes: worldbookScopes,
      isWorldbookActive: isWorldbookActive,
      readWorldbook: readWorldbook,
      createWorldbook: createWorldbook,
      addWorldbookEntries: addWorldbookEntries,
      updateWorldbook: updateWorldbook,
      mountWorldbook: mountWorldbook,
      findEntry: findEntry,
      inject: inject,
      uninject: uninject,
      on: on
    };
  }

  modules.createHostKit = createHostKit;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/reader-llm-gateway.js ---- */
(function (root) {
  'use strict';

  /*
   * Reader-II 统一 LLM 网关。
   * - 方案与路由：与大厅「独立 API」共用同一个本机键（reader-II 自己的，见 reader-env.js 的 LOCAL_KEYS；
   *   旧键 dream_independent_api_v2 的值由 createEnv 迁移过来）里的 presets / defaultId / routes。
   *   Reader Core 面板的 LLM LINK 编辑的是其中的默认方案；
   *   旧版 reader_ii_llm_settings_v1 只在 v2 尚不存在时作为迁移来源读取。
   * - 生成：一律经酒馆助手 generateRaw + ordered_prompts（与命运抽卡、书架同一通道），
   *   不依赖网关是否支持原生 function calling。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var LEGACY_KEY = 'reader_ii_llm_settings_v1';
  var PRESET_KEY = modules.localKey('dream_independent_api_v2');
  var PANEL_PRESET_ID = 'readerii';
  var TRANSIENT = /\b(?:408|409|425|429|500|502|503|504|520|522|524|529|530)\b|timeout|timed out|超时|overloaded|temporarily|ECONNRESET|network|fetch failed|Failed to fetch|tunnel|未返回可用文本|empty/i;

  function responseText(result) {
    if (typeof result === 'string') return result;
    if (!result || typeof result !== 'object') return '';
    if (typeof result.content === 'string') return result.content;
    if (typeof result.text === 'string') return result.text;
    if (typeof result.response === 'string') return result.response;
    if (Array.isArray(result.choices) && result.choices[0]) {
      return String(result.choices[0].text || result.choices[0].message && result.choices[0].message.content || '');
    }
    return '';
  }

  function normalizeSettings(input) {
    var source = modules.isObject(input) ? input : {};
    return {
      enabled: source.enabled === true,
      apiurl: String(source.apiurl || '').trim().slice(0, 2048),
      key: String(source.key || '').trim().slice(0, 8192),
      model: String(source.model || '').trim().slice(0, 300),
      source: /^[A-Za-z0-9_-]{1,64}$/.test(String(source.source || 'openai')) ? String(source.source || 'openai') : 'openai'
    };
  }

  function validateEndpoint(settings, requireModel) {
    if (!/^https?:\/\/[^\s]+$/i.test(settings.apiurl)) throw new Error('独立 API 地址必须是完整的 HTTP(S) URL');
    if (requireModel && !settings.model) throw new Error('请填写模型名，或拉取列表后选择模型');
  }

  function usablePreset(preset) {
    return !!(preset && /^https?:\/\//i.test(String(preset.apiurl || '')) && String(preset.model || '').trim());
  }

  function cleanPreset(input) {
    if (!modules.isObject(input)) return null;
    var id = String(input.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!id) return null;
    var preset = {
      id: id,
      name: String(input.name || '').trim().slice(0, 40),
      apiurl: String(input.apiurl || '').trim().slice(0, 500),
      key: String(input.key || '').trim().slice(0, 500),
      model: String(input.model || '').trim().slice(0, 200),
      source: String(input.source || 'openai').trim().slice(0, 40) || 'openai'
    };
    if (!preset.name) preset.name = preset.model || '未命名方案';
    return preset;
  }

  function createLlmGateway(env) {
    var memory = normalizeSettings({});
    var sequence = 0;

    function resolveFunction(name) {
      if (env && typeof env.resolveFunction === 'function') {
        var resolved = env.resolveFunction(name);
        if (typeof resolved === 'function') return resolved;
      }
      return env && typeof env[name] === 'function' ? env[name] : null;
    }

    function storage() {
      if (env && env.storage) return env.storage;
      try { return env && env.host && env.host.localStorage || root.localStorage || null; }
      catch (error) { return null; }
    }

    function readJson(key) {
      var target = storage();
      if (!target || typeof target.getItem !== 'function') return null;
      try {
        var raw = target.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (error) { return null; }
    }

    function writeJson(key, value) {
      var target = storage();
      if (!target || typeof target.setItem !== 'function') return false;
      try { target.setItem(key, JSON.stringify(value)); return true; }
      catch (error) { return false; }
    }

    /* v2 方案表；不存在时返回 null（此时才看旧版单方案）。 */
    function readPresetState() {
      var raw = readJson(PRESET_KEY);
      if (!modules.isObject(raw) || !Array.isArray(raw.presets)) return null;
      var presets = [];
      var seen = Object.create(null);
      raw.presets.forEach(function (item) {
        var preset = cleanPreset(item);
        if (!preset || seen[preset.id] || presets.length >= 30) return;
        seen[preset.id] = true;
        presets.push(preset);
      });
      var routes = {};
      if (modules.isObject(raw.routes)) Object.keys(raw.routes).forEach(function (key) {
        var value = raw.routes[key];
        if (/^[A-Za-z0-9_]{1,40}$/.test(key) && (value === 'tavern' || value === 'default' || seen[value])) routes[key] = value;
      });
      return { version: 2, presets: presets, defaultId: seen[raw.defaultId] ? String(raw.defaultId) : '', routes: routes };
    }

    function legacySettings() {
      var raw = readJson(LEGACY_KEY);
      if (raw) memory = normalizeSettings(raw);
      return modules.clone(memory);
    }

    function presetApi(preset) {
      if (!usablePreset(preset)) return null;
      var api = { apiurl: preset.apiurl, model: preset.model, source: preset.source || 'openai' };
      if (preset.key) api.key = preset.key;
      return api;
    }

    /* 返回 custom_api 配置；null 表示走酒馆当前插头。 */
    function resolveApi(route) {
      var state = readPresetState();
      if (state) {
        var selected = route && state.routes[route] || 'default';
        if (selected === 'tavern') return null;
        var id = selected === 'default' ? state.defaultId : selected;
        for (var index = 0; index < state.presets.length; index += 1) {
          if (state.presets[index].id === id) return presetApi(state.presets[index]);
        }
        return null;
      }
      var legacy = legacySettings();
      if (!legacy.enabled) return null;
      try { validateEndpoint(legacy, true); } catch (error) { return null; }
      return { apiurl: legacy.apiurl, key: legacy.key, model: legacy.model, source: legacy.source || 'openai' };
    }

    /* 面板读到的是「默认方案」。 */
    function readSettings() {
      var state = readPresetState();
      if (!state) return legacySettings();
      var preset = null;
      state.presets.forEach(function (item) { if (item.id === state.defaultId) preset = item; });
      if (!preset) {
        state.presets.forEach(function (item) { if (item.id === PANEL_PRESET_ID) preset = item; });
        return normalizeSettings(preset ? { enabled: false, apiurl: preset.apiurl, key: preset.key, model: preset.model, source: preset.source } : {});
      }
      return normalizeSettings({ enabled: true, apiurl: preset.apiurl, key: preset.key, model: preset.model, source: preset.source });
    }

    function saveSettings(input) {
      var next = normalizeSettings(input);
      if (next.enabled) validateEndpoint(next, true);
      memory = next;
      writeJson(LEGACY_KEY, next);
      var state = readPresetState() || { version: 2, presets: [], defaultId: '', routes: {} };
      var target = null;
      state.presets.forEach(function (item) {
        if (item.id === (next.enabled && state.defaultId ? state.defaultId : PANEL_PRESET_ID)) target = item;
      });
      if (next.apiurl) {
        if (!target) {
          target = { id: PANEL_PRESET_ID, name: 'Reader Core 方案', apiurl: '', key: '', model: '', source: 'openai' };
          state.presets.push(target);
        }
        target.apiurl = next.apiurl;
        target.key = next.key;
        target.model = next.model;
        target.source = next.source;
        if (!target.name) target.name = next.model || 'Reader Core 方案';
      }
      if (next.enabled && target) state.defaultId = target.id;
      else if (!next.enabled) state.defaultId = '';
      if (state.presets.length || readJson(PRESET_KEY)) writeJson(PRESET_KEY, state);
      return modules.clone(next);
    }

    function backendSummary(route) {
      var api = resolveApi(route);
      return api
        ? { mode: 'custom', label: '独立 API', model: api.model, apiurl: api.apiurl }
        : { mode: 'main', label: '酒馆主 API', model: '', apiurl: '' };
    }

    async function listModels(input) {
      var candidate = normalizeSettings(Object.assign({}, readSettings(), input || {}, { enabled: true }));
      validateEndpoint(candidate, false);
      var getModelList = resolveFunction('getModelList');
      if (!getModelList) throw new Error('当前酒馆助手未提供 getModelList，仍可手动填写模型名');
      var result = await getModelList({ apiurl: candidate.apiurl, key: candidate.key });
      if (!Array.isArray(result)) throw new Error('模型列表返回格式无效');
      var seen = Object.create(null);
      return result.map(function (item) { return String(item || '').trim(); }).filter(function (item) {
        if (!item || seen[item]) return false;
        seen[item] = true;
        return true;
      }).slice(0, 500);
    }

    function stop(generationId) {
      var stopById = resolveFunction('stopGenerationById');
      if (stopById && generationId) {
        try { stopById(String(generationId)); } catch (error) { /* best-effort */ }
      }
    }

    function abortError() {
      var error = new Error('已取消');
      error.name = 'AbortError';
      return error;
    }

    function delay(ms, signal) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { cleanup(); resolve(); }, ms);
        function onAbort() { cleanup(); reject(abortError()); }
        function cleanup() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
        if (signal) {
          if (signal.aborted) { cleanup(); reject(abortError()); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    /* 一次请求：超时与取消都会通知酒馆停止对应生成。 */
    function raceOnce(run, generationId, timeoutMs, signal) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = null;
        function finish(fn, value) {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          fn(value);
        }
        function onAbort() { stop(generationId); finish(reject, abortError()); }
        if (signal) {
          if (signal.aborted) { reject(abortError()); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        if (timeoutMs > 0) timer = setTimeout(function () {
          stop(generationId);
          finish(reject, new Error('模型响应超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
        }, timeoutMs);
        Promise.resolve().then(run).then(function (value) { finish(resolve, value); }, function (error) { finish(reject, error); });
      });
    }

    function normalizeMessages(input) {
      var output = [];
      (Array.isArray(input) ? input : []).forEach(function (item) {
        if (!item || typeof item.content !== 'string' || !item.content.trim()) return;
        var role = item.role === 'system' || item.role === 'assistant' ? item.role : 'user';
        var last = output[output.length - 1];
        /* 相邻同角色合并：部分后端要求 user / assistant 严格交替。 */
        if (last && last.role === role && role !== 'system') last.content += '\n\n' + item.content;
        else output.push({ role: role, content: item.content });
      });
      return output;
    }

    function nativeContext() {
      try { return env && env.host && env.host.SillyTavern && typeof env.host.SillyTavern.getContext === 'function' ? env.host.SillyTavern.getContext() : null; }
      catch (error) { return null; }
    }

    /* OpenAI 兼容端点的直连调用（没有酒馆助手时的独立 API 通道）。 */
    async function directChat(api, messages, request) {
      var fetcher = env && env.host && env.host.fetch ? env.host.fetch.bind(env.host) : root.fetch;
      if (typeof fetcher !== 'function') throw new Error('当前环境不能直连独立 API');
      var headers = { 'Content-Type': 'application/json' };
      if (api.key) headers.Authorization = 'Bearer ' + api.key;
      var body = { model: api.model, messages: messages, stream: false };
      if (Number(request.maxTokens) > 0) body.max_tokens = Math.trunc(Number(request.maxTokens));
      if (typeof request.temperature === 'number' && Number.isFinite(request.temperature)) body.temperature = request.temperature;
      var response = await fetcher(String(api.apiurl).replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(body), signal: request.signal });
      if (!response.ok) throw new Error('独立 API 返回 HTTP ' + response.status + '：' + String(await response.text()).slice(0, 300));
      var data = await response.json();
      var choice = data && data.choices && data.choices[0];
      return choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
    }

    /*
     * 多轮消息生成。request:
     *   messages [{role, content}]  route  maxTokens  temperature  timeoutMs  retries  signal  jsonSchema
     * 返回文本；空回复与瞬时错误按 retries 重试。
     */
    async function chat(input) {
      var request = modules.isObject(input) ? input : {};
      var messages = normalizeMessages(request.messages);
      if (!messages.length) throw new Error('Reader LLM 调用缺少消息');
      var api = Object.prototype.hasOwnProperty.call(request, 'api') ? request.api : resolveApi(request.route);
      var generateRaw = resolveFunction('generateRaw');
      var retries = Math.max(0, Math.min(5, request.retries === undefined ? 2 : Math.trunc(Number(request.retries) || 0)));
      var timeoutMs = Math.max(0, Number(request.timeoutMs === undefined ? 180000 : request.timeoutMs) || 0);
      var lastError = null;
      for (var attempt = 0; attempt <= retries; attempt += 1) {
        if (request.signal && request.signal.aborted) throw abortError();
        var generationId = String(request.generationId || 'reader-llm') + '-' + Date.now().toString(36) + '-' + (++sequence).toString(36);
        try {
          var result = await raceOnce(function () {
            if (!generateRaw) {
              /* 没有酒馆助手：独立 API 由浏览器直连（需要对方允许跨域），否则走酒馆原生的 generateRaw。 */
              if (api) return directChat(api, messages, request);
              var native = nativeContext();
              if (native && typeof native.generateRaw === 'function') {
                return native.generateRaw({ prompt: messages, responseLength: Number(request.maxTokens) > 0 ? Math.trunc(Number(request.maxTokens)) : undefined });
              }
              var quiet = resolveFunction('generateQuietPrompt');
              if (!quiet) throw new Error('当前环境没有可用的 Reader LLM 生成接口');
              return quiet(messages.map(function (message) {
                return (message.role === 'system' ? '' : message.role === 'assistant' ? 'Assistant: ' : 'User: ') + message.content;
              }).join('\n\n'));
            }
            var config = {
              generation_id: generationId,
              should_stream: false,
              should_silence: request.shouldSilence !== false,
              max_chat_history: 0,
              ordered_prompts: messages
            };
            if (request.jsonSchema) config.json_schema = modules.clone(request.jsonSchema);
            if (api) {
              config.custom_api = Object.assign({}, api);
              if (Number(request.maxTokens) > 0) config.custom_api.max_tokens = Math.trunc(Number(request.maxTokens));
              if (typeof request.temperature === 'number' && Number.isFinite(request.temperature)) config.custom_api.temperature = request.temperature;
            }
            return generateRaw(config);
          }, generationId, timeoutMs, request.signal);
          var text = responseText(result);
          if (!text.trim()) throw new Error('LLM 未返回可用文本');
          return text;
        } catch (error) {
          lastError = error;
          if (error && error.name === 'AbortError') throw error;
          var message = String(error && error.message || error);
          if (attempt >= retries || !TRANSIENT.test(message)) throw error;
          await delay(1200 * (attempt + 1), request.signal);
        }
      }
      throw lastError || new Error('LLM 调用失败');
    }

    /* 单轮生成（适配、书架等沿用）；request.route 指定「独立 API」里的调用类型。 */
    async function generate(input) {
      var request = modules.isObject(input) ? input : {};
      var userInput = String(request.userInput == null ? request.user_input || '' : request.userInput);
      var system = String(request.system || request.systemPrompt || '');
      if (!userInput.trim()) throw new Error('Reader LLM 调用缺少用户提示词');
      var api = resolveApi(request.route);
      var config = {
        user_input: userInput,
        max_chat_history: request.maxChatHistory === 'all' ? 'all' : Math.max(0, Number(request.maxChatHistory) || 0),
        should_stream: request.shouldStream === true,
        should_silence: request.shouldSilence !== false
      };
      if (request.generationId) config.generation_id = String(request.generationId);
      if (request.jsonSchema) config.json_schema = modules.clone(request.jsonSchema);

      var result;
      if (!api && request.usePreset === true) {
        var generateWithPreset = resolveFunction('generate');
        if (!generateWithPreset) throw new Error('当前酒馆助手未提供 generate');
        if (request.overrides) config.overrides = modules.clone(request.overrides);
        if (system) config.injects = [{ role: 'system', content: system, position: 'in_chat', depth: 0, should_scan: false }];
        result = await generateWithPreset(config);
      } else {
        var generateRaw = resolveFunction('generateRaw');
        if (!generateRaw) {
          if (api) throw new Error('独立 API 需要酒馆助手 generateRaw 接口');
          var quiet = resolveFunction('generateQuietPrompt');
          if (!quiet) throw new Error('当前环境没有可用的 Reader LLM 生成接口');
          result = await quiet((system ? system + '\n\n' : '') + userInput);
        } else {
          config.ordered_prompts = system ? [{ role: 'system', content: system }, 'user_input'] : ['user_input'];
          if (api) config.custom_api = api;
          result = await generateRaw(config);
        }
      }
      var text = responseText(result);
      if (!text.trim()) throw new Error('LLM 未返回可用文本');
      return text;
    }

    return {
      storageKey: LEGACY_KEY,
      presetKey: PRESET_KEY,
      getSettings: readSettings,
      saveSettings: saveSettings,
      getBackendSummary: backendSummary,
      resolveApi: resolveApi,
      listModels: listModels,
      generate: generate,
      chat: chat,
      stop: stop,
      responseText: responseText
    };
  }

  modules.normalizeReaderLlmSettings = normalizeSettings;
  modules.createLlmGateway = createLlmGateway;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/reader-memory.js ---- */
(function (root) {
  'use strict';

  /*
   * Reader-II 记忆系统（夜之洋）。
   *
   *   对话 ──整理（一次 LLM 调用，输出 add / update 操作）──▶ 记忆库 ──召回──▶ 正文提示词 / 助手
   *
   * 两个存放位置，新记忆写到用户选的那个，读取时两边都看：
   *   chat   当前聊天：聊天变量 reader_ii_memory，随存档走，换聊天互不相干。
   *   ocean  《夜之洋》世界书：每条记忆是一个世界书条目，跨存档；挂载后由酒馆按关键词原生触发。
   *
   * 召回不使用向量：关键词命中 + 字二元组重合 + 重要度 + 新近度打分。
   * 聊天库的记忆、以及未挂载时的《夜之洋》记忆由脚本注入正文；已挂载的《夜之洋》交给酒馆原生触发，避免重复。
   *
   * 来源标记 owner（与 source「怎么来的」分开）：story 正文的记忆 | agent 助手自己的记忆（与助手的对话沉淀、助手自己记下的）。
   * 设置 unify（助手夜梦 = 正文夜梦，默认关）：
   *   关  agent 记忆不进正文：脚本注入时跳过；在《夜之洋》里对应条目保持停用（真实开关存在元数据 off 里），酒馆不会原生触发。
   *   开  agent 记忆一并参与正文召回（功能记忆除外，那是戏外的做法），注入块里加一句「你与助手是同一人，不主动超游」。
   *   两种情况都只走召回、受条数与字数预算约束；注入用自己的 id、不触发别的世界书条目，不碰其他记忆插件的注入。
   * 助手那边任何时候都能读到正文的记忆。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var SETTINGS_KEY = 'reader_ii_memory_settings_v1';
  var CHAT_KEY = 'reader_ii_memory';
  var INJECT_ID = 'reader-ii-memory';
  var TYPES = { episode: '剧情记忆', fact: '设定记忆', bond: '情感记忆', howto: '功能记忆' };
  var TYPE_SHORT = { episode: '剧情', fact: '设定', bond: '情感', howto: '功能' };
  var TYPE_KEYS = Object.keys(TYPES);
  var LEGACY_TYPES = { emotion: 'bond', 'function': 'howto', story: 'episode', setting: 'fact' };
  var META_PATTERN = /^\s*<!--yzy\s+(\{[\s\S]*?\})\s*-->[ \t]*\n?/;
  var NOTE_PATTERN = /^\s*>\s*记录于[^\n]*\n?/;
  var NAME_PATTERN = /^(剧情记忆|设定记忆|情感记忆|功能记忆)\s*[-·:：]\s*(.+)$/;
  var UNIFY_LINE = '你与夜梦助手是同一个人：标着“助手那边”的记忆也是你的经历。正文里不主动超游（不提助手、工具、面板等戏外之事），除非用户先这样做。';

  var DEFAULTS = {
    enabled: true,
    scope: 'reader',          /* 自动整理与带入正文的范围：reader 只在用了 Reader-II 的聊天里 | all 所有聊天 */
    store: 'chat',            /* 新记忆写到哪里：chat | ocean */
    autoExtract: true,
    everyTurns: 8,            /* 攒够多少条 AI 回复后自动整理；0 = 不按条数 */
    everyChars: 9000,         /* 或攒够多少字；0 = 不按字数。两个都为 0 = 只手动 */
    keepRecent: 2,            /* 最近几条先不整理（还可能重掷、编辑） */
    windowChars: 24000,       /* 一次请求最多送入多少字的对话 */
    maxPerRun: 10,            /* 一次整理最多写入几条 */
    inject: true,
    injectDepth: 2,
    injectMax: 6,
    injectBudget: 1500,
    injectSummary: true,
    oceanBook: '夜之洋',
    oceanMount: 'global',     /* global | character | none */
    agentExtract: true,
    unify: false              /* 助手夜梦 = 正文夜梦：助手自己的记忆也带进正文 */
  };

  function clampInt(value, minimum, maximum, fallback) {
    var number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function normalizeSettings(input) {
    var source = modules.isObject(input) ? input : {};
    var output = {};
    output.enabled = source.enabled !== false;
    output.scope = source.scope === 'all' ? 'all' : 'reader';
    output.store = source.store === 'ocean' ? 'ocean' : 'chat';
    output.autoExtract = source.autoExtract !== false;
    output.everyTurns = clampInt(source.everyTurns, 0, 200, DEFAULTS.everyTurns);
    output.everyChars = clampInt(source.everyChars, 0, 400000, DEFAULTS.everyChars);
    output.keepRecent = clampInt(source.keepRecent, 0, 20, DEFAULTS.keepRecent);
    output.windowChars = clampInt(source.windowChars, 2000, 400000, DEFAULTS.windowChars);
    output.maxPerRun = clampInt(source.maxPerRun, 1, 40, DEFAULTS.maxPerRun);
    output.inject = source.inject !== false;
    output.injectDepth = clampInt(source.injectDepth, 0, 40, DEFAULTS.injectDepth);
    output.injectMax = clampInt(source.injectMax, 1, 30, DEFAULTS.injectMax);
    output.injectBudget = clampInt(source.injectBudget, 200, 20000, DEFAULTS.injectBudget);
    output.injectSummary = source.injectSummary !== false;
    output.oceanBook = String(source.oceanBook || DEFAULTS.oceanBook).replace(/[\r\n]/g, ' ').trim().slice(0, 60) || DEFAULTS.oceanBook;
    output.oceanMount = ['global', 'character', 'none'].indexOf(source.oceanMount) >= 0 ? source.oceanMount : DEFAULTS.oceanMount;
    output.agentExtract = source.agentExtract !== false;
    output.unify = source.unify === true;
    return output;
  }

  function normalizeType(value) {
    var text = String(value || '').trim().toLowerCase();
    if (TYPES[text]) return text;
    if (LEGACY_TYPES[text]) return LEGACY_TYPES[text];
    for (var index = 0; index < TYPE_KEYS.length; index += 1) {
      var key = TYPE_KEYS[index];
      if (text === TYPES[key] || text === TYPE_SHORT[key]) return key;
    }
    return '';
  }

  function cleanKeys(input) {
    var seen = Object.create(null);
    var source = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,，、;；\n]+/) : [];
    return source.map(function (item) {
      return typeof item === 'string' ? item.replace(/[\r\n]+/g, ' ').trim().slice(0, 40) : '';
    }).filter(function (item) {
      if (!item || seen[item]) return false;
      seen[item] = true;
      return true;
    }).slice(0, 8);
  }

  /* 来源标记：没写明时按 source 推断（旧数据里与助手对话沉淀的记忆 source 是 agent）。 */
  function ownerOf(input) {
    return input.owner === 'agent' || input.owner === 'story' ? input.owner : input.source === 'agent' ? 'agent' : 'story';
  }

  function newId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function normalizeRecord(input, fallbackStore) {
    var source = modules.isObject(input) ? input : {};
    var type = normalizeType(source.type) || 'episode';
    var title = String(source.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
    var content = String(source.content || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
    if (!content) return null;
    if (!title) title = content.replace(/\s+/g, ' ').slice(0, 16);
    var now = Date.now();
    var created = Number(source.createdAt);
    var updated = Number(source.updatedAt);
    var record = {
      id: /^[A-Za-z0-9_-]{1,48}$/.test(String(source.id || '')) ? String(source.id) : newId(),
      type: type,
      title: title,
      content: content,
      keys: cleanKeys(source.keys),
      importance: clampInt(source.importance, 1, 5, 3),
      pinned: source.pinned === true,
      enabled: source.enabled !== false,
      createdAt: Number.isFinite(created) && created > 0 ? created : now,
      updatedAt: Number.isFinite(updated) && updated > 0 ? updated : now,
      origin: String(source.origin || '').slice(0, 120),
      source: ['story', 'agent', 'manual', 'import'].indexOf(source.source) >= 0 ? source.source : 'manual',
      owner: ownerOf(source),
      store: source.store === 'ocean' || source.store === 'chat' ? source.store : (fallbackStore || 'chat')
    };
    if (source.uid !== undefined) record.uid = source.uid;
    return record;
  }

  /* ---------- 文本相似度（无向量） ---------- */
  /* 虚词不参与重合度：否则任意两段中文都会有一成多的“相似”。 */
  var STOP_CHARS = '的了是在有不我你他她它这那就也都和与及或而且但一个上下着过吗呢吧啊么之其被把让给对从到为以于很更最还又再才只们来去说';
  function gramSet(text) {
    var set = Object.create(null);
    var count = 0;
    var source = String(text || '').toLowerCase();
    var pattern = /[㐀-鿿぀-ヿ가-힯]+|[a-z0-9_]{2,}/g;
    var match;
    while ((match = pattern.exec(source)) !== null) {
      var token = match[0];
      if (/^[a-z0-9_]+$/.test(token)) {
        if (!set[token]) { set[token] = true; count += 1; }
        continue;
      }
      if (token.length === 1) continue;
      for (var index = 0; index < token.length - 1; index += 1) {
        var gram = token.slice(index, index + 2);
        if (STOP_CHARS.indexOf(gram[0]) >= 0 || STOP_CHARS.indexOf(gram[1]) >= 0) continue;
        if (!set[gram]) { set[gram] = true; count += 1; }
      }
    }
    return { set: set, size: count };
  }

  function overlap(queryGrams, text) {
    if (!queryGrams.size) return 0;
    var target = gramSet(text);
    if (!target.size) return 0;
    var hit = 0;
    Object.keys(target.set).forEach(function (gram) { if (queryGrams.set[gram]) hit += 1; });
    /* 以较短一方为分母：短查询命中长记忆、长上下文命中短记忆都算数。 */
    return hit / Math.min(queryGrams.size, target.size);
  }

  function scoreRecord(record, queryText, queryGrams, now) {
    var lower = queryText.toLowerCase();
    var keyHits = 0;
    record.keys.forEach(function (key) { if (key && lower.indexOf(key.toLowerCase()) >= 0) keyHits += 1; });
    var titleHit = record.title && lower.indexOf(record.title.toLowerCase()) >= 0 ? 1 : 0;
    var similarity = overlap(queryGrams, record.title + ' ' + record.content);
    var relevance = keyHits * 3 + titleHit * 2 + similarity * 6;
    if (relevance <= 0) return { score: 0, relevance: 0, keyHits: 0, similarity: 0 };
    var ageDays = Math.max(0, (now - (record.updatedAt || record.createdAt || now)) / 86400000);
    var score = relevance + record.importance * 0.3 + Math.exp(-ageDays / 60) * 0.5;
    return { score: score, relevance: relevance, keyHits: keyHits, similarity: similarity };
  }

  /* ---------- 模型输出解析 ---------- */
  function balancedObjects(text) {
    var output = [];
    var depth = 0, start = -1, quote = '', escaped = false;
    for (var index = 0; index < text.length; index += 1) {
      var ch = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"') { quote = ch; continue; }
      if (ch === '{') { if (depth === 0) start = index; depth += 1; }
      else if (ch === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) { output.push(text.slice(start, index + 1)); start = -1; }
      }
    }
    return output;
  }

  function looseJson(text) {
    try { return JSON.parse(text); } catch (error) { /* try repairs */ }
    try { return JSON.parse(text.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"')); } catch (error) { return undefined; }
  }

  /* 返回 { summary, ops }；整段解析不了时逐条抢救 memories 里的对象（回复被截断也能取出完整的几条）。 */
  function parseExtraction(text) {
    var source = String(text || '').replace(/```(?:json)?/gi, '').trim();
    var first = source.indexOf('{');
    var result = { summary: null, ops: [] };
    if (first < 0) return result;
    var whole = looseJson(source.slice(first, source.lastIndexOf('}') + 1));
    var items = [];
    if (modules.isObject(whole)) {
      if (typeof whole.summary === 'string') result.summary = whole.summary.trim().slice(0, 1200);
      items = Array.isArray(whole.memories) ? whole.memories : Array.isArray(whole.ops) ? whole.ops : [];
    } else if (Array.isArray(whole)) items = whole;
    else {
      var summaryMatch = source.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (summaryMatch) { try { result.summary = JSON.parse('"' + summaryMatch[1] + '"').trim().slice(0, 1200); } catch (error) { /* ignore */ } }
      var arrayStart = source.indexOf('[', source.indexOf('"memories"'));
      if (arrayStart >= 0) balancedObjects(source.slice(arrayStart + 1)).forEach(function (chunk) {
        var parsed = looseJson(chunk);
        if (modules.isObject(parsed)) items.push(parsed);
      });
    }
    items.forEach(function (item) {
      if (!modules.isObject(item)) return;
      var op = String(item.op || (item.id ? 'update' : 'add')).toLowerCase();
      if (op !== 'add' && op !== 'update') return;
      result.ops.push({
        op: op,
        id: typeof item.id === 'string' ? item.id.trim() : '',
        type: normalizeType(item.type),
        title: typeof item.title === 'string' ? item.title : '',
        content: typeof item.content === 'string' ? item.content : '',
        keys: cleanKeys(item.keys),
        importance: item.importance
      });
    });
    return result;
  }

  var EXTRACT_SYSTEM = [
    '你是「夜之洋」记忆整理器，负责把一段对话沉淀为日后可检索的长期记忆。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
    '',
    '记忆类型（type）：',
    '- episode 剧情：已经发生的关键事件、转折、约定、尚未回收的伏笔。写清人物、地点、起因与结果。',
    '- fact 设定：较稳定的事实——人物身份、关系、能力，世界规则，物品归属，用户明确表达过的偏好。',
    '- bond 情感：用户与角色（或九十九夜梦）之间值得铭记的情感时刻与关系变化。',
    '- howto 功能：可复用的做法、踩过的坑与结论（多见于用户与助手的对话）。',
    '',
    '要求：',
    '1. 宁缺毋滥：闲聊、重复、已有记忆已经覆盖的内容不要再记；这一段没有值得记的内容就返回空数组。',
    '2. 每条独立成文，脱离上下文也能读懂；第三人称客观陈述，不写“本段对话中”。content 控制在 40～220 字。',
    '3. keys 给 2～5 个将来对话里可能原样出现的触发词（人名、地名、物品、专有名词），不用“事件”“约定”这类泛词。',
    '4. importance 取 1～5：5 表示影响主线或长期关系，1 表示细枝末节。',
    '5. 已有记忆需要补充或修正时用 op=update，带上它的 id，并给出合并后的完整 content；不要为同一件事新建条目。',
    '6. summary：把【此前梗概】与这一段合并成不超过 300 字的最新梗概；没有可写的就给空字符串。',
    '',
    '输出格式：',
    '{"summary":"…","memories":[{"op":"add","type":"episode","title":"不超过18字","content":"…","keys":["…"],"importance":3},{"op":"update","id":"已有记忆的id","content":"…","keys":["…"],"importance":4}]}'
  ].join('\n');

  function createMemorySystem(env, llm, kit) {
    var settings = normalizeSettings(kit.localRead(SETTINGS_KEY, {}));
    var oceanCache = { key: '', at: 0, records: null, book: '' };
    var running = null;
    var generating = false;
    var autoTimer = null;
    var listeners = [];
    var lastInjection = { key: '', text: '' };

    function log() {
      if (env.console && typeof env.console.warn === 'function') env.console.warn.apply(env.console, ['[Reader记忆]'].concat(Array.prototype.slice.call(arguments)));
    }

    function emit(reason) {
      listeners.slice().forEach(function (listener) {
        try { listener(reason); } catch (error) { /* a UI listener must not break memory */ }
      });
    }

    /* ---------- 设置 ---------- */
    function getSettings() { return modules.clone(settings); }

    function saveSettings(patch) {
      var before = settings;
      settings = normalizeSettings(Object.assign({}, settings, modules.isObject(patch) ? patch : {}));
      kit.localWrite(SETTINGS_KEY, settings);
      oceanCache.records = null;
      if (before.unify !== settings.unify || before.oceanBook !== settings.oceanBook) {
        syncOceanVisibility().catch(function (error) { log('同步《夜之洋》里助手记忆的开关失败', error); });
      }
      refreshInjection().catch(function () {});
      emit('settings');
      return getSettings();
    }

    /* ---------- 聊天库 ---------- */
    function emptyChatData() {
      return { v: 1, items: {}, cursor: { index: 0 }, summary: { text: '', upto: 0, at: 0 }, cfg: {}, last: null };
    }

    function readChatData() {
      var raw = kit.readChatValue(CHAT_KEY);
      var data = emptyChatData();
      if (!modules.isObject(raw)) return data;
      if (modules.isObject(raw.items)) Object.keys(raw.items).slice(0, 2000).forEach(function (id) {
        var record = normalizeRecord(Object.assign({}, raw.items[id], { id: id, store: 'chat' }), 'chat');
        if (record) data.items[record.id] = record;
      });
      if (modules.isObject(raw.cursor)) data.cursor.index = clampInt(raw.cursor.index, 0, 10000000, 0);
      if (modules.isObject(raw.summary)) {
        data.summary = {
          text: String(raw.summary.text || '').slice(0, 1200),
          upto: clampInt(raw.summary.upto, 0, 10000000, 0),
          at: Number(raw.summary.at) || 0
        };
      }
      if (modules.isObject(raw.cfg)) data.cfg = { store: raw.cfg.store === 'ocean' || raw.cfg.store === 'chat' ? raw.cfg.store : '' };
      if (modules.isObject(raw.last)) data.last = modules.clone(raw.last);
      return data;
    }

    function writeChatData(data) {
      var stored = { v: 1, items: {}, cursor: data.cursor, summary: data.summary, cfg: data.cfg, last: data.last };
      Object.keys(data.items).forEach(function (id) {
        var record = Object.assign({}, data.items[id]);
        delete record.store;
        delete record.id;
        stored.items[id] = record;
      });
      if (!kit.writeChatValue(CHAT_KEY, stored)) throw new Error('当前聊天不可写入记忆（没有打开聊天？）');
    }

    /* 新记忆写到哪里：本聊天单独指定优先，否则用全局设置。 */
    function targetStore() {
      var override = readChatData().cfg.store;
      return override || settings.store;
    }

    function setChatStoreOverride(store) {
      var data = readChatData();
      data.cfg.store = store === 'ocean' || store === 'chat' ? store : '';
      writeChatData(data);
      emit('settings');
      return targetStore();
    }

    /* ---------- 《夜之洋》世界书 ---------- */
    function normalizedBookName(name) { return String(name || '').replace(/[《》\s]/g, ''); }

    function findOceanBook() {
      var names = kit.worldbookNames();
      if (names.indexOf(settings.oceanBook) >= 0) return settings.oceanBook;
      var wanted = normalizedBookName(settings.oceanBook);
      for (var index = 0; index < names.length; index += 1) {
        if (normalizedBookName(names[index]) === wanted) return names[index];
      }
      return '';
    }

    async function ensureOceanBook() {
      var name = findOceanBook();
      if (!name) {
        name = settings.oceanBook;
        await kit.createWorldbook(name);
        oceanCache.records = null;
      }
      if (settings.oceanMount !== 'none' && !kit.isWorldbookActive(name)) {
        try { await kit.mountWorldbook(name, settings.oceanMount); }
        catch (error) { log('《' + name + '》挂载失败，记忆仍会保存，召回改由脚本完成', error); }
      }
      return name;
    }

    function oceanNative() {
      var name = findOceanBook();
      return !!name && kit.isWorldbookActive(name);
    }

    function parseMeta(content) {
      var match = String(content || '').match(META_PATTERN);
      if (!match) return null;
      try { var value = JSON.parse(match[1]); return modules.isObject(value) ? value : null; } catch (error) { return null; }
    }

    function entryBody(content) {
      return String(content || '').replace(META_PATTERN, '').replace(NOTE_PATTERN, '').trim();
    }

    function entryToRecord(entry) {
      if (!entry || typeof entry !== 'object') return null;
      var name = String(entry.name || '');
      var meta = parseMeta(entry.content);
      var named = name.match(NAME_PATTERN);
      if (!meta && !named) return null;
      meta = meta || {};
      var strategy = entry.strategy || {};
      var owner = ownerOf({ owner: meta.o, source: meta.src });
      /* 新写法的 agent 条目：世界书里的开关由 unify 决定，真实开关在 meta.off。 */
      var enabled = owner === 'agent' && meta.o === 'agent' ? !meta.off : entry.enabled !== false;
      return normalizeRecord({
        id: typeof meta.id === 'string' && meta.id ? meta.id : 'o' + String(entry.uid),
        type: normalizeType(meta.t || meta.type) || (named ? normalizeType(named[1]) : '') || 'bond',
        title: named ? named[2] : (meta.title || name),
        content: entryBody(entry.content),
        keys: (Array.isArray(strategy.keys) ? strategy.keys : []).filter(function (key) { return typeof key === 'string'; }),
        importance: meta.imp !== undefined ? meta.imp : meta.intensity,
        pinned: strategy.type === 'constant',
        enabled: enabled,
        createdAt: meta.c || meta.start,
        updatedAt: meta.u || meta.end || meta.c || meta.start,
        origin: meta.origin || meta.chat || '',
        source: meta.src,
        owner: owner,
        uid: entry.uid,
        store: 'ocean'
      }, 'ocean');
    }

    function stamp(time) {
      try { return new Date(time).toLocaleString('zh-CN', { hour12: false }); } catch (error) { return String(time); }
    }

    function recordToEntry(record, existing) {
      var meta = { id: record.id, t: record.type, imp: record.importance, c: record.createdAt, u: record.updatedAt };
      if (record.origin) meta.origin = record.origin;
      if (record.source) meta.src = record.source;
      meta.o = record.owner;
      if (record.owner === 'agent' && record.enabled === false) meta.off = 1;
      var entry = existing ? existing : {};
      entry.name = TYPES[record.type] + '-' + record.title;
      entry.content = '<!--yzy ' + JSON.stringify(meta) + ' -->\n> 记录于 ' + stamp(record.createdAt) + ' ｜ ' + TYPES[record.type] + '\n' + record.content;
      entry.enabled = record.enabled !== false && storyVisible(record);
      entry.strategy = modules.isObject(entry.strategy) ? entry.strategy : {};
      entry.strategy.type = record.pinned ? 'constant' : 'selective';
      entry.strategy.keys = record.keys.slice();
      if (!existing) entry.position = { type: 'at_depth', role: 'system', depth: 4, order: 100 };
      return entry;
    }

    /* 这条记忆能不能进正文（脚本注入或酒馆原生触发）。 */
    function storyVisible(record) {
      return record.owner !== 'agent' || (settings.unify && record.type !== 'howto');
    }

    /* 让《夜之洋》里 agent 条目的世界书开关符合 unify；没有要改的就不写。返回改了几条。 */
    async function syncOceanVisibility() {
      var book = findOceanBook();
      if (!book) return 0;
      var stale = function (entry) {
        var record = entryToRecord(entry);
        return !!record && record.owner === 'agent' && ((entry.enabled !== false) !== (record.enabled && storyVisible(record)) || !parseMeta(entry.content) || parseMeta(entry.content).o !== 'agent');
      };
      if (!(await kit.readWorldbook(book)).some(stale)) return 0;
      var changed = 0;
      await kit.updateWorldbook(book, function (entries) {
        entries.forEach(function (entry) {
          if (!stale(entry)) return;
          recordToEntry(entryToRecord(entry), entry);
          changed += 1;
        });
        return entries;
      });
      oceanCache.records = null;
      return changed;
    }

    async function oceanRecords(force) {
      var book = findOceanBook();
      if (!book) { oceanCache.records = []; oceanCache.book = ''; return []; }
      var key = kit.chatKey();
      if (!force && oceanCache.records && oceanCache.book === book && Date.now() - oceanCache.at < 15000) return oceanCache.records;
      var entries = await kit.readWorldbook(book);
      var records = [];
      entries.forEach(function (entry) {
        var record = entryToRecord(entry);
        if (record) records.push(record);
      });
      oceanCache = { key: key, at: Date.now(), records: records, book: book };
      return records;
    }

    async function oceanPut(record) {
      var book = await ensureOceanBook();
      var current = await oceanRecords(true);
      var existing = null;
      current.forEach(function (item) { if (item.id === record.id) existing = item; });
      if (existing) {
        var found = false;
        await kit.updateWorldbook(book, function (entries) {
          entries.forEach(function (entry) {
            if (found || entry.uid !== existing.uid) return;
            found = true;
            recordToEntry(record, entry);
          });
          return entries;
        });
        if (!found) throw new Error('《' + book + '》里找不到这条记忆，可能已被删除');
        record.uid = existing.uid;
      } else {
        var made = await kit.addWorldbookEntries(book, [recordToEntry(record, null)]);
        if (made[0] && made[0].uid !== undefined) record.uid = made[0].uid;
      }
      record.store = 'ocean';
      oceanCache.records = null;
      /* 回读确认：写入必须真的落在世界书里。 */
      var verify = await oceanRecords(true);
      if (!verify.some(function (item) { return item.id === record.id; })) throw new Error('写入《' + book + '》后回读不到这条记忆');
      return record;
    }

    async function oceanRemove(id) {
      var book = findOceanBook();
      if (!book) return false;
      var current = await oceanRecords(true);
      var target = null;
      current.forEach(function (item) { if (item.id === id) target = item; });
      if (!target) return false;
      await kit.updateWorldbook(book, function (entries) {
        return entries.filter(function (entry) { return entry.uid !== target.uid; });
      });
      oceanCache.records = null;
      return true;
    }

    /* ---------- 统一读写 ---------- */
    async function listAll(options) {
      var data = readChatData();
      var chatItems = Object.keys(data.items).map(function (id) { return data.items[id]; });
      var ocean = [];
      if (!options || options.store !== 'chat') {
        try { ocean = await oceanRecords(options && options.fresh === true); }
        catch (error) { log('读取《夜之洋》失败', error); ocean = []; }
      }
      var output = (options && options.store === 'ocean' ? [] : chatItems).concat(ocean);
      if (options && options.type) output = output.filter(function (record) { return record.type === options.type; });
      if (options && options.query) {
        var query = String(options.query).toLowerCase();
        output = output.filter(function (record) {
          return (record.title + '\n' + record.content + '\n' + record.keys.join(' ')).toLowerCase().indexOf(query) >= 0;
        });
      }
      return output.sort(function (left, right) {
        return (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0) || right.updatedAt - left.updatedAt;
      }).map(function (record) { return modules.clone(record); });
    }

    async function find(id) {
      var all = await listAll({ fresh: false });
      var target = String(id || '').trim();
      var hit = null;
      all.forEach(function (record) { if (!hit && record.id === target) hit = record; });
      if (hit) return hit;
      /* 助手可能给的是标题。 */
      all.forEach(function (record) { if (!hit && record.title === target) hit = record; });
      all.forEach(function (record) { if (!hit && target && record.title.indexOf(target) >= 0) hit = record; });
      return hit;
    }

    async function put(record) {
      if (record.store === 'ocean') {
        await oceanPut(record);
      } else {
        var data = readChatData();
        record.store = 'chat';
        data.items[record.id] = record;
        writeChatData(data);
      }
      return record;
    }

    function originLabel() {
      var names = kit.names();
      return names.char + (names.chat ? ' · ' + names.chat : '');
    }

    async function add(input, options) {
      var store = options && (options.store === 'ocean' || options.store === 'chat') ? options.store : targetStore();
      var record = normalizeRecord(Object.assign({}, input, { id: undefined, store: store }), store);
      if (!record) throw new Error('记忆内容不能为空');
      if (!record.origin) record.origin = originLabel();
      await put(record);
      refreshInjection().catch(function () {});
      emit('changed');
      return modules.clone(record);
    }

    async function update(id, patch) {
      var current = await find(id);
      if (!current) throw new Error('没有这条记忆：' + id);
      var source = modules.isObject(patch) ? patch : {};
      var next = normalizeRecord(Object.assign({}, current, {
        type: source.type !== undefined ? source.type : current.type,
        title: source.title !== undefined ? source.title : current.title,
        content: source.content !== undefined ? source.content : current.content,
        keys: source.keys !== undefined ? source.keys : current.keys,
        importance: source.importance !== undefined ? source.importance : current.importance,
        pinned: source.pinned !== undefined ? source.pinned === true : current.pinned,
        enabled: source.enabled !== undefined ? source.enabled !== false : current.enabled,
        owner: source.owner === 'agent' || source.owner === 'story' ? source.owner : current.owner,
        updatedAt: Date.now()
      }), current.store);
      if (!next) throw new Error('记忆内容不能为空');
      await put(next);
      refreshInjection().catch(function () {});
      emit('changed');
      return modules.clone(next);
    }

    async function remove(id) {
      var current = await find(id);
      if (!current) return false;
      if (current.store === 'ocean') await oceanRemove(current.id);
      else {
        var data = readChatData();
        delete data.items[current.id];
        writeChatData(data);
      }
      refreshInjection().catch(function () {});
      emit('changed');
      return true;
    }

    /* 在聊天与《夜之洋》之间搬动一条记忆：先写入目标并确认，再删除原件。 */
    async function move(id, store) {
      var target = store === 'ocean' ? 'ocean' : 'chat';
      var current = await find(id);
      if (!current) throw new Error('没有这条记忆：' + id);
      if (current.store === target) return current;
      var copy = normalizeRecord(Object.assign({}, current, { store: target, uid: undefined, updatedAt: Date.now() }), target);
      await put(copy);
      if (current.store === 'ocean') await oceanRemove(current.id);
      else {
        var data = readChatData();
        delete data.items[current.id];
        writeChatData(data);
      }
      refreshInjection().catch(function () {});
      emit('changed');
      return modules.clone(copy);
    }

    /* ---------- 召回 ---------- */
    async function search(query, options) {
      var text = String(query || '').trim();
      var limit = clampInt(options && options.limit, 1, 30, 6);
      var all = (await listAll({ store: options && options.store, type: options && options.type })).filter(function (record) { return record.enabled; });
      if (!text) return all.slice(0, limit).map(function (record) { return Object.assign(record, { score: 0 }); });
      var grams = gramSet(text);
      var now = Date.now();
      var scored = [];
      all.forEach(function (record) {
        var result = scoreRecord(record, text, grams, now);
        if (result.relevance >= 0.6) scored.push(Object.assign(record, { score: Math.round(result.score * 100) / 100 }));
      });
      scored.sort(function (left, right) { return right.score - left.score; });
      return scored.slice(0, limit);
    }

    function recentContext(maxChars) {
      var length = kit.chatLength();
      var messages = kit.readChat(Math.max(0, length - 3), length);
      return messages.map(function (message) { return kit.cleanText(message.text); }).join('\n').slice(-(maxChars || 1500));
    }

    function formatLine(record) {
      return '- [' + TYPE_SHORT[record.type] + (record.owner === 'agent' ? '·助手那边' : '') + '] ' + record.title + '：' + record.content.replace(/\s*\n\s*/g, ' ');
    }

    /* 生成注入正文的记忆块；candidates 已排除由酒馆原生触发的部分。 */
    async function buildInjection(contextText) {
      if (!settings.enabled || !settings.inject) return { text: '', items: [] };
      var data = readChatData();
      var candidates = Object.keys(data.items).map(function (id) { return data.items[id]; });
      if (!oceanNative()) {
        try { candidates = candidates.concat(await oceanRecords(false)); } catch (error) { /* 世界书读不到时只用聊天库 */ }
      }
      candidates = candidates.filter(function (record) { return record.enabled && storyVisible(record); });
      var text = String(contextText === undefined ? recentContext(1500) : contextText);
      var grams = gramSet(text);
      var now = Date.now();
      var picked = [];
      var budget = settings.injectBudget;
      var summary = settings.injectSummary && data.summary.text ? data.summary.text : '';
      if (summary) budget -= summary.length;
      if (settings.unify) budget -= UNIFY_LINE.length;
      /* 打开 unify 后，助手那边的记忆最多占一半名额，免得挤掉正文的记忆。 */
      var agentCap = Math.max(1, Math.ceil(settings.injectMax / 2));
      var agentPicked = 0;
      candidates.filter(function (record) { return record.pinned; }).forEach(function (record) {
        var line = formatLine(record);
        if (picked.length < settings.injectMax && budget - line.length >= 0) { picked.push(record); budget -= line.length; }
      });
      candidates.filter(function (record) { return !record.pinned; }).map(function (record) {
        return { record: record, result: scoreRecord(record, text, grams, now) };
      }).filter(function (item) {
        /* 需要实打实的相关：命中触发词，或字面重合足够高。 */
        return item.result.keyHits > 0 || item.result.similarity >= 0.18;
      }).sort(function (left, right) { return right.result.score - left.result.score; }).forEach(function (item) {
        var line = formatLine(item.record);
        if (item.record.owner === 'agent' && agentPicked >= agentCap) return;
        if (picked.length < settings.injectMax && budget - line.length >= 0) {
          picked.push(item.record);
          budget -= line.length;
          if (item.record.owner === 'agent') agentPicked += 1;
        }
      });
      if (!picked.length && !summary && !settings.unify) return { text: '', items: [] };
      var lines = ['<夜之洋的记忆>'];
      if (settings.unify) lines.push(UNIFY_LINE);
      if (picked.length || summary) lines.push('以下是此前对话沉淀的记忆，只用于保持前后连贯；不要逐条复述，也不要提到“记忆”本身。');
      if (summary) lines.push('【前情梗概】' + summary);
      picked.forEach(function (record) { lines.push(formatLine(record)); });
      lines.push('</夜之洋的记忆>');
      return { text: lines.join('\n'), items: picked.map(function (record) { return record.id; }) };
    }

    async function refreshInjection(contextText) {
      var key = kit.chatKey();
      var block;
      try { block = autoAllowed() ? await buildInjection(contextText) : { text: '', items: [] }; }
      catch (error) { log('生成记忆注入失败', error); block = { text: '', items: [] }; }
      if (key !== kit.chatKey()) return block;
      if (lastInjection.key === key && lastInjection.text === block.text) return block;
      lastInjection = { key: key, text: block.text };
      try {
        if (!block.text) await kit.uninject([INJECT_ID]);
        else await kit.inject([{ id: INJECT_ID, position: 'in_chat', depth: settings.injectDepth, role: 'system', content: block.text, should_scan: false }]);
      } catch (error) { log('写入记忆注入失败', error); }
      return block;
    }

    /* ---------- 整理 ---------- */
    function pendingWindow(data, force) {
      var length = kit.chatLength();
      var from = Math.min(data.cursor.index, length);
      var upto = Math.max(from, force ? length : length - settings.keepRecent);
      var messages = kit.readChat(from, upto).map(function (message) {
        return { id: message.id, role: message.role, name: message.name, text: kit.cleanText(message.text) };
      }).filter(function (message) { return message.text; });
      var turns = 0, chars = 0;
      messages.forEach(function (message) { if (message.role === 'assistant') turns += 1; chars += message.text.length; });
      return { from: from, upto: upto, messages: messages, turns: turns, chars: chars, length: length };
    }

    function shorten(text, limit) {
      if (text.length <= limit) return text;
      var head = Math.floor(limit * 0.65);
      return text.slice(0, head) + '\n……（中间略）……\n' + text.slice(text.length - (limit - head));
    }

    function buildBatches(messages, names) {
      var batches = [];
      var current = { lines: [], chars: 0, end: 0 };
      messages.forEach(function (message) {
        var speaker = message.name || (message.role === 'user' ? names.user : names.char);
        var line = '#' + message.id + ' ' + speaker + ': ' + shorten(message.text, 2400);
        if (current.lines.length && current.chars + line.length > settings.windowChars) {
          batches.push(current);
          current = { lines: [], chars: 0, end: 0 };
        }
        current.lines.push(line);
        current.chars += line.length;
        current.end = message.id + 1;
      });
      if (current.lines.length) batches.push(current);
      return batches;
    }

    function existingDigest(records, text) {
      var grams = gramSet(text);
      var now = Date.now();
      return records.map(function (record) {
        return { record: record, score: scoreRecord(record, text, grams, now).score + (record.pinned ? 5 : 0) };
      }).sort(function (left, right) { return right.score - left.score || right.record.updatedAt - left.record.updatedAt; })
        .slice(0, 40).map(function (item) {
          var record = item.record;
          return record.id + '｜' + TYPE_SHORT[record.type] + '｜' + record.title + '｜' + record.content.replace(/\s+/g, ' ').slice(0, 70);
        });
    }

    /* unify 关时，正文整理与助手对话整理各管各的记忆：互相看不到，也不会改到对方那边。 */
    function sameSide(source) {
      var owner = source === 'agent' ? 'agent' : 'story';
      return function (record) { return settings.unify || record.owner === owner; };
    }

    async function applyOps(ops, source, report) {
      var store = targetStore();
      var all = (await listAll({ fresh: true })).filter(sameSide(source));
      var written = 0;
      for (var index = 0; index < ops.length; index += 1) {
        var op = ops[index];
        if (written >= settings.maxPerRun) { report.skipped += 1; continue; }
        try {
          var target = null;
          if (op.op === 'update' && op.id) all.forEach(function (record) { if (!target && record.id === op.id) target = record; });
          if (!target && op.title) {
            /* 同类型同标题视为同一件事，更新而不是新建。 */
            var normalizedTitle = op.title.replace(/\s+/g, '');
            all.forEach(function (record) {
              if (!target && record.title.replace(/\s+/g, '') === normalizedTitle && (!op.type || record.type === op.type)) target = record;
            });
          }
          if (target) {
            if (!op.content.trim()) { report.skipped += 1; continue; }
            var updated = await update(target.id, {
              content: op.content,
              keys: op.keys.length ? cleanKeys(target.keys.concat(op.keys)) : target.keys,
              importance: op.importance !== undefined ? op.importance : target.importance
            });
            report.updated.push(updated.title);
            written += 1;
            continue;
          }
          if (op.op === 'update') { report.skipped += 1; continue; }
          var record = normalizeRecord({ type: op.type || 'episode', title: op.title, content: op.content, keys: op.keys, importance: op.importance, source: source, origin: originLabel(), store: store }, store);
          if (!record) { report.skipped += 1; continue; }
          await put(record);
          all.push(record);
          report.added.push(record.title);
          written += 1;
        } catch (error) {
          report.errors.push((op.title || op.id || '记忆') + '：' + String(error && error.message || error).slice(0, 160));
        }
      }
    }

    async function extractOnce(header, body, summary, source, report, signal) {
      var existing = existingDigest((await listAll({ fresh: false })).filter(sameSide(source)), body);
      var user = [
        '【此前梗概】' + (summary || '无'),
        '【已有记忆】（id｜类型｜标题｜摘要）',
        existing.length ? existing.join('\n') : '（无）',
        header,
        body
      ].join('\n');
      var text = await llm.chat({
        messages: [{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content: user }],
        route: 'memory',
        temperature: 0.2,
        maxTokens: 3000,
        timeoutMs: 240000,
        retries: 1,
        signal: signal,
        generationId: 'reader-memory'
      });
      var parsed = parseExtraction(text);
      report.proposed += parsed.ops.length;
      return parsed;
    }

    /*
     * 整理当前聊天里尚未处理的对话。options: { reason, force（连最近几条一起整理）, signal }
     * 同一时刻只运行一份；中途切换聊天则丢弃结果，不会写进别的存档。
     */
    function consolidate(options) {
      if (running) return running;
      var job = (async function () {
        var opts = options || {};
        var report = { ok: true, reason: opts.reason || 'manual', at: Date.now(), store: targetStore(), proposed: 0, added: [], updated: [], skipped: 0, errors: [], window: 0 };
        var key = kit.chatKey();
        try {
          if (!settings.enabled) throw new Error('记忆系统已关闭');
          var data = readChatData();
          var pending = pendingWindow(data, opts.force === true);
          if (!pending.messages.length) {
            if (pending.upto > data.cursor.index) { data.cursor.index = pending.upto; writeChatData(data); }
            report.note = '没有新的对话需要整理';
            return report;
          }
          var names = kit.names();
          var allBatches = buildBatches(pending.messages, names);
          var batches = allBatches.slice(0, 3);
          for (var index = 0; index < batches.length; index += 1) {
            var batch = batches[index];
            var parsed = await extractOnce('【待整理对话】（#楼层 发言者: 内容）', batch.lines.join('\n'), data.summary.text, 'story', report, opts.signal);
            if (kit.chatKey() !== key) throw new Error('聊天已切换，这次整理的结果没有写入');
            await applyOps(parsed.ops, 'story', report);
            data = readChatData();
            data.cursor.index = index === allBatches.length - 1 ? pending.upto : batch.end;
            if (parsed.summary !== null && parsed.summary) data.summary = { text: parsed.summary, upto: data.cursor.index, at: Date.now() };
            report.window += batch.lines.length;
            writeChatData(data);
          }
          if (kit.chatLength() - settings.keepRecent > readChatData().cursor.index) report.note = '对话较长，剩余部分下次继续整理';
        } catch (error) {
          report.ok = false;
          report.error = String(error && error.message || error).slice(0, 300);
          if (error && error.name === 'AbortError') report.error = '已取消';
        }
        try {
          if (kit.chatKey() === key) {
            var latest = readChatData();
            latest.last = { at: report.at, reason: report.reason, ok: report.ok, added: report.added.length, updated: report.updated.length, error: report.error || '', note: report.note || '' };
            writeChatData(latest);
          }
        } catch (error) { /* 状态记录失败不影响结果 */ }
        refreshInjection().catch(function () {});
        emit('consolidated');
        return report;
      })();
      running = job;
      job.then(function () { if (running === job) running = null; }, function () { if (running === job) running = null; });
      return job;
    }

    /* 把一段助手对话沉淀为记忆（情感 / 功能 / 用户偏好）。turns: [{role, text}] */
    async function consolidateDialogue(turns, options) {
      var report = { ok: true, reason: options && options.reason || 'agent', at: Date.now(), store: targetStore(), proposed: 0, added: [], updated: [], skipped: 0, errors: [], window: 0 };
      try {
        if (!settings.enabled) throw new Error('记忆系统已关闭');
        var names = kit.names();
        var lines = (Array.isArray(turns) ? turns : []).filter(function (turn) { return turn && typeof turn.text === 'string' && turn.text.trim(); })
          .map(function (turn) { return (turn.role === 'assistant' ? '九十九夜梦' : names.user) + ': ' + shorten(turn.text.trim(), 1600); });
        if (!lines.length) { report.note = '没有可整理的助手对话'; return report; }
        var key = kit.chatKey();
        var parsed = await extractOnce('【待整理对话】这是用户与助手九十九夜梦的对话；重点留意情感时刻、用户偏好，以及可复用的做法与结论。', lines.join('\n').slice(-settings.windowChars), '', 'agent', report, options && options.signal);
        if (kit.chatKey() !== key) throw new Error('聊天已切换，这次整理的结果没有写入');
        await applyOps(parsed.ops, 'agent', report);
        report.window = lines.length;
      } catch (error) {
        report.ok = false;
        report.error = String(error && error.message || error).slice(0, 300);
      }
      emit('consolidated');
      return report;
    }

    /*
     * 记忆随扩展全局加载，但「自动整理」（要调用模型）和「带入正文」默认只在用了 Reader-II 的聊天里进行：
     * 卡内组件在聊天变量里留有 reader_ii_runtime（语义层）或 dream_persona（大厅设置）。
     * 别的卡的聊天里，记忆只在用户或助手主动读写时才动。
     */
    function autoAllowed() {
      if (settings.scope === 'all') return true;
      try { return kit.readChatValue('reader_ii_runtime') !== undefined || kit.readChatValue('dream_persona') !== undefined; }
      catch (error) { return false; }
    }

    function autoCheck() {
      if (!settings.enabled || !settings.autoExtract || running || generating || !autoAllowed()) return;
      if (settings.everyTurns <= 0 && settings.everyChars <= 0) return;
      var pending;
      try { pending = pendingWindow(readChatData(), false); } catch (error) { return; }
      var byTurns = settings.everyTurns > 0 && pending.turns >= settings.everyTurns;
      var byChars = settings.everyChars > 0 && pending.chars >= settings.everyChars;
      if (!byTurns && !byChars) return;
      consolidate({ reason: 'auto' }).then(function (report) {
        if (!report.ok) log('自动整理失败', report.error);
      });
    }

    function scheduleAuto(delayMs) {
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(function () { autoTimer = null; autoCheck(); }, delayMs);
    }

    function repairCursor() {
      try {
        var data = readChatData();
        var length = kit.chatLength();
        if (data.cursor.index > length) { data.cursor.index = length; writeChatData(data); }
      } catch (error) { /* 没有打开聊天 */ }
    }

    async function status() {
      var data = readChatData();
      var pending = pendingWindow(data, false);
      var book = findOceanBook();
      var ocean = [];
      try { ocean = await oceanRecords(false); } catch (error) { ocean = []; }
      return {
        enabled: settings.enabled,
        store: targetStore(),
        chatOverride: data.cfg.store || '',
        chatCount: Object.keys(data.items).length,
        oceanCount: ocean.length,
        oceanBook: book || settings.oceanBook,
        oceanExists: !!book,
        oceanNative: oceanNative(),
        pending: { turns: pending.turns, chars: pending.chars, from: pending.from, upto: pending.upto },
        thresholds: { turns: settings.everyTurns, chars: settings.everyChars, auto: settings.autoExtract && (settings.everyTurns > 0 || settings.everyChars > 0) },
        summary: data.summary.text,
        last: data.last,
        running: !!running
      };
    }

    async function exportAll() {
      return { v: 1, kind: 'reader-ii-memory', exportedAt: new Date().toISOString(), summary: readChatData().summary.text, items: await listAll({ fresh: true }) };
    }

    async function importAll(payload, options) {
      var source = typeof payload === 'string' ? JSON.parse(payload) : payload;
      var items = modules.isObject(source) && Array.isArray(source.items) ? source.items : Array.isArray(source) ? source : null;
      if (!items) throw new Error('导入内容不是记忆导出文件');
      var store = options && (options.store === 'ocean' || options.store === 'chat') ? options.store : targetStore();
      var existing = await listAll({ fresh: true });
      var report = { added: 0, skipped: 0, errors: [] };
      for (var index = 0; index < items.length && index < 2000; index += 1) {
        var record = normalizeRecord(Object.assign({}, items[index], { id: undefined, uid: undefined, store: store, source: 'import', owner: ownerOf(modules.isObject(items[index]) ? items[index] : {}) }), store);
        if (!record) { report.skipped += 1; continue; }
        var duplicate = existing.some(function (item) { return item.type === record.type && item.title === record.title && item.content === record.content; });
        if (duplicate) { report.skipped += 1; continue; }
        try { await put(record); existing.push(record); report.added += 1; }
        catch (error) { report.errors.push(record.title + '：' + String(error && error.message || error).slice(0, 120)); }
      }
      refreshInjection().catch(function () {});
      emit('changed');
      return report;
    }

    function setSummary(text) {
      var data = readChatData();
      data.summary = { text: String(text || '').trim().slice(0, 1200), upto: data.cursor.index, at: Date.now() };
      writeChatData(data);
      refreshInjection().catch(function () {});
      emit('changed');
      return data.summary.text;
    }

    function resetCursor(index) {
      var data = readChatData();
      data.cursor.index = clampInt(index, 0, kit.chatLength(), 0);
      writeChatData(data);
      emit('changed');
      return data.cursor.index;
    }

    var installed = false;
    function install() {
      if (installed) return;
      installed = true;
      kit.on('GENERATION_STARTED', function () { generating = true; });
      ['GENERATION_ENDED', 'GENERATION_STOPPED'].forEach(function (name) {
        kit.on(name, function () { generating = false; scheduleAuto(2500); });
      });
      kit.on('MESSAGE_RECEIVED', function () { scheduleAuto(4000); });
      ['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED'].forEach(function (name) {
        kit.on(name, function () { repairCursor(); refreshInjection().catch(function () {}); });
      });
      kit.on('CHAT_CHANGED', function () {
        generating = false;
        oceanCache.records = null;
        lastInjection = { key: '', text: '' };
        repairCursor();
        refreshInjection().catch(function () {});
        emit('chat');
      });
      /* 酒馆会等待这个事件的监听器，注入因此赶得上本轮提示词。 */
      kit.on('GENERATION_AFTER_COMMANDS', function (type, generationOptions, dryRun) {
        if (dryRun) return undefined;
        return refreshInjection();
      });
      kit.on('WORLDINFO_UPDATED', function () { oceanCache.records = null; });
      refreshInjection().catch(function () {});
      /* 旧版写进《夜之洋》的助手记忆是启用的；按 unify 校正一次（没有要改的就不写）。 */
      setTimeout(function () {
        syncOceanVisibility().catch(function (error) { log('同步《夜之洋》里助手记忆的开关失败', error); });
      }, 3000);
    }

    async function dispose() {
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = null;
      try { await kit.uninject([INJECT_ID]); } catch (error) { /* best-effort */ }
    }

    return {
      TYPES: TYPES,
      TYPE_SHORT: TYPE_SHORT,
      injectId: INJECT_ID,
      chatKey: CHAT_KEY,
      settingsKey: SETTINGS_KEY,
      getSettings: getSettings,
      saveSettings: saveSettings,
      targetStore: targetStore,
      setChatStoreOverride: setChatStoreOverride,
      list: listAll,
      get: find,
      add: add,
      update: update,
      remove: remove,
      move: move,
      search: search,
      buildInjection: buildInjection,
      refreshInjection: refreshInjection,
      consolidate: consolidate,
      consolidateDialogue: consolidateDialogue,
      status: status,
      exportAll: exportAll,
      importAll: importAll,
      setSummary: setSummary,
      resetCursor: resetCursor,
      ensureOceanBook: ensureOceanBook,
      syncOceanVisibility: syncOceanVisibility,
      unifyLine: UNIFY_LINE,
      onChange: function (listener) {
        listeners.push(listener);
        return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
      },
      install: install,
      dispose: dispose
    };
  }

  modules.READER_MEMORY_TYPES = TYPES;
  modules.normalizeMemorySettings = normalizeSettings;
  modules.normalizeMemoryRecord = normalizeRecord;
  modules.parseMemoryExtraction = parseExtraction;
  modules.memoryGramSet = gramSet;
  modules.createMemorySystem = createMemorySystem;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/store.js ---- */
(function (root) {
  'use strict';

  /*
   * 本地存储与运行日志。
   *
   * createStore  IndexedDB 的最小封装（键值形式）；没有 IndexedDB 时退回内存，功能不变、只是不持久。
   * createJournal 每轮运行的记录 + 写入前镜像。撤销 = 把镜像按相反顺序写回去；
   *               写回前比对「当时写完的内容」与「现在的内容」的哈希，被别处改过就算冲突，不强行覆盖。
   *
   * 大数据都放这里，不进聊天文件，也不进 settings.json。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var DB_NAME = 'reader_ii_agent_v1';
  var STORES = ['runs', 'changes', 'files', 'kv'];
  var KEEP_RUNS = 30;
  var MAX_IMAGE = 4 * 1024 * 1024;

  function createStore(env, name) {
    var memory = {};
    var opening = null;
    var broken = false;
    STORES.forEach(function (store) { memory[store] = new Map(); });

    function open() {
      if (broken) return Promise.resolve(null);
      if (opening) return opening;
      opening = new Promise(function (resolve) {
        var factory = null;
        try { factory = env && env.host && env.host.indexedDB; } catch (error) { factory = null; }
        if (!factory) { broken = true; resolve(null); return; }
        var request;
        try { request = factory.open(name || DB_NAME, 1); } catch (error) { broken = true; resolve(null); return; }
        request.onupgradeneeded = function () {
          STORES.forEach(function (store) { if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store); });
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = request.onblocked = function () { broken = true; resolve(null); };
      });
      return opening;
    }

    function run(store, mode, work) {
      return open().then(function (db) {
        if (!db) return work(null, memory[store]);
        return new Promise(function (resolve, reject) {
          var tx, result;
          try { tx = db.transaction(store, mode); } catch (error) { reject(error); return; }
          var request = work(tx.objectStore(store), null);
          if (request) request.onsuccess = function () { result = request.result; };
          tx.oncomplete = function () { resolve(result); };
          tx.onerror = tx.onabort = function () { reject(tx.error || new Error('本地存储写入失败')); };
        });
      });
    }

    return {
      get: function (store, key) { return run(store, 'readonly', function (os, map) { return os ? os.get(key) : map.get(key); }); },
      put: function (store, key, value) { return run(store, 'readwrite', function (os, map) { if (os) return os.put(value, key); map.set(key, value); }); },
      del: function (store, key) { return run(store, 'readwrite', function (os, map) { if (os) return os.delete(key); map.delete(key); }); },
      keys: function (store) { return run(store, 'readonly', function (os, map) { return os ? os.getAllKeys() : Array.from(map.keys()); }); },
      all: function (store) { return run(store, 'readonly', function (os, map) { return os ? os.getAll() : Array.from(map.values()); }); },
      persistent: function () { return open().then(function (db) { return !!db; }); }
    };
  }

  function createJournal(store) {
    var sequence = 0;

    function begin(info) {
      var now = Date.now();
      var run = {
        id: now.toString(36) + '-' + (++sequence).toString(36) + Math.random().toString(36).slice(2, 6),
        chat: String(info && info.chat || ''), title: String(info && info.title || '').slice(0, 120),
        startedAt: now, endedAt: 0, status: 'running', changes: 0, notes: [], seen: {}
      };
      return run;
    }

    function persist(run) {
      var record = { id: run.id, chat: run.chat, title: run.title, startedAt: run.startedAt, endedAt: run.endedAt, status: run.status, changes: run.changes, notes: run.notes.slice(0, 40), undone: run.undone === true };
      return store.put('runs', run.id, record);
    }

    /* 写入前调用：同一轮里同一路径只留第一份镜像，撤销回到这一轮开始前的样子。 */
    async function capture(run, path, before) {
      if (!run || run.seen[path]) return;
      var index = run.changes;
      run.seen[path] = run.id + ':' + String(index).padStart(4, '0');
      run.changes += 1;
      var tooLarge = typeof before === 'string' && before.length > MAX_IMAGE;
      await store.put('changes', run.seen[path], {
        runId: run.id, seq: index, path: path, existed: before !== null && before !== undefined,
        before: tooLarge ? null : before, tooLarge: tooLarge, afterHash: null, at: Date.now()
      });
      if (index === 0) await persist(run);
    }

    /* 写入后调用：记下写完的内容哈希，撤销时用来判断有没有被别处改过。 */
    async function settle(run, path, after) {
      if (!run || !run.seen[path]) return;
      var record = await store.get('changes', run.seen[path]);
      if (!record) return;
      record.afterHash = after === null || after === undefined ? '' : modules.hashText(after);
      await store.put('changes', run.seen[path], record);
    }

    function note(run, text) {
      if (run && run.notes.length < 40) run.notes.push(String(text).slice(0, 200));
    }

    async function end(run, status) {
      if (!run) return;
      run.status = status || 'done';
      run.endedAt = Date.now();
      if (run.changes || run.notes.length) { await persist(run); await prune(); }
    }

    async function list(limit) {
      var runs = (await store.all('runs')) || [];
      runs.sort(function (left, right) { return right.startedAt - left.startedAt; });
      return runs.slice(0, limit || KEEP_RUNS);
    }

    async function changes(runId) {
      var keys = (await store.keys('changes')) || [];
      var output = [];
      for (var index = 0; index < keys.length; index += 1) {
        if (String(keys[index]).indexOf(runId + ':') === 0) output.push(await store.get('changes', keys[index]));
      }
      return output.filter(Boolean).sort(function (left, right) { return left.seq - right.seq; });
    }

    async function prune() {
      var runs = await list(1000);
      var drop = runs.slice(KEEP_RUNS);
      if (!drop.length) return;
      var keys = (await store.keys('changes')) || [];
      for (var index = 0; index < drop.length; index += 1) {
        var prefix = drop[index].id + ':';
        for (var k = 0; k < keys.length; k += 1) if (String(keys[k]).indexOf(prefix) === 0) await store.del('changes', keys[k]);
        await store.del('runs', drop[index].id);
      }
    }

    /*
     * io: { read(path) → string|null, restore(path, before|null) }
     * 返回 { restored: [path], conflicts: [{path, reason}], notes: [不可自动撤销的操作] }
     */
    async function undo(runId, io, options) {
      var force = options && options.force === true;
      var record = await store.get('runs', runId);
      var items = (await changes(runId)).reverse();
      var report = { restored: [], conflicts: [], notes: record && record.notes || [] };
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        try {
          if (item.tooLarge) { report.conflicts.push({ path: item.path, reason: '原内容太大，没有保存镜像' }); continue; }
          var current = await io.read(item.path);
          var currentHash = current === null || current === undefined ? '' : modules.hashText(current);
          if (!force && item.afterHash !== null && currentHash !== item.afterHash) {
            report.conflicts.push({ path: item.path, reason: '这之后内容又被改过' });
            continue;
          }
          await io.restore(item.path, item.existed ? item.before : null);
          report.restored.push(item.path);
        } catch (error) {
          report.conflicts.push({ path: item.path, reason: String(error && error.message || error).slice(0, 160) });
        }
      }
      if (record) { record.undone = report.conflicts.length === 0; await store.put('runs', runId, record); }
      return report;
    }

    return { begin: begin, capture: capture, settle: settle, note: note, end: end, list: list, changes: changes, undo: undo };
  }

  modules.createStore = createStore;
  modules.createJournal = createJournal;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/protocol.js ---- */
(function (root) {
  'use strict';

  /*
   * 工具调用的文本协议（不依赖网关的原生 function calling，任何能输出文本的模型与中转都能用）：
   *
   *   <tool_call name="read">
   *   <arg name="path">wb:/某本书/某个条目</arg>
   *   </tool_call>
   *
   * 参数值原样书写，长文本、引号、换行都不需要转义；同时接受 <invoke>/<parameter> 写法与块内 JSON。
   * 没写完的块（多半被长度截断）不执行，请模型重发。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  /* ---------- 工具块解析 ---------- */
  function attribute(source, name) {
    var match = String(source || '').match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))'));
    return match ? (match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]) : '';
  }

  function trimValue(value) {
    var output = String(value);
    var cdata = output.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    if (cdata) return cdata[1];
    return output.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  }

  function parseToolCalls(input) {
    /* 兼容部分模型习惯的 <invoke> / <parameter> 写法。 */
    var text = String(input || '')
      .replace(/<\/?function_calls\s*>/gi, '')
      .replace(/<invoke\b/gi, '<tool_call').replace(/<\/invoke\s*>/gi, '</tool_call>')
      .replace(/<parameter\b/gi, '<arg').replace(/<\/parameter\s*>/gi, '</arg>');
    var calls = [];
    var prose = text.replace(/<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call\s*>/gi, function (block, attrs, body) {
      var call = { name: attribute(attrs, 'name'), args: {}, raw: block };
      var found = false;
      body.replace(/<arg\b([^>]*)>([\s\S]*?)<\/arg\s*>/gi, function (match, argAttrs, value) {
        var key = attribute(argAttrs, 'name');
        if (key) { call.args[key] = trimValue(value); found = true; }
        return match;
      });
      if (!found) {
        var json = body.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        if (json[0] === '{') {
          try {
            var parsed = JSON.parse(json);
            if (modules.isObject(parsed)) {
              var inner = modules.isObject(parsed.arguments) ? parsed.arguments : modules.isObject(parsed.args) ? parsed.args : modules.isObject(parsed.parameters) ? parsed.parameters : null;
              if (!call.name && typeof (parsed.name || parsed.tool) === 'string') call.name = parsed.name || parsed.tool;
              var source = inner || (call.name && !parsed.name && !parsed.tool ? parsed : {});
              Object.keys(source).forEach(function (key) { call.args[key] = source[key]; });
              call.json = true;
            }
          } catch (error) { call.malformed = '工具块里的 JSON 无法解析'; }
        }
      }
      if (!call.name) call.malformed = '工具块缺少 name';
      calls.push(call);
      return '\n';
    });
    /* 没写完的工具块（多半是输出被长度截断）：不执行，交给模型重发。 */
    var truncated = false;
    var open = prose.search(/<tool_call\b/i);
    if (open >= 0) { truncated = true; prose = prose.slice(0, open); }
    prose = prose.replace(/<\/?tool_result\b[^>]*>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
    return { calls: calls, prose: prose, truncated: truncated };
  }

  /* 把原样文本的参数按工具声明的类型转换；返回 { args } 或 { error }。 */
  function coerceArgs(definition, raw) {
    var args = {};
    var params = definition.params || [];
    for (var index = 0; index < params.length; index += 1) {
      var param = params[index];
      var value = raw[param.name];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '' && param.type !== 'string')) {
        if (param.required) return { error: '缺少必填参数 ' + param.name + '（' + (param.desc || param.type) + '）' };
        continue;
      }
      if (param.type === 'number') {
        var number = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isFinite(number)) return { error: '参数 ' + param.name + ' 需要数字' };
        args[param.name] = number;
      } else if (param.type === 'boolean') {
        args[param.name] = value === true || /^(?:true|1|yes|on|是|开|开启)$/i.test(String(value).trim());
      } else if (param.type === 'json') {
        if (typeof value !== 'string') { args[param.name] = value; continue; }
        var textValue = value.trim();
        try { args[param.name] = JSON.parse(textValue); }
        catch (error) {
          /* 模型常把字符串数组写成逗号或换行分隔的清单。 */
          if (!/^[\[{]/.test(textValue)) {
            var list = textValue.split(/\s*[,，、\n]\s*/).filter(Boolean);
            args[param.name] = list.length > 1 ? list : textValue;
          } else return { error: '参数 ' + param.name + ' 需要合法的 JSON' };
        }
      } else {
        args[param.name] = typeof value === 'string' ? value : JSON.stringify(value);
        if (param.required && !String(args[param.name]).trim()) return { error: '缺少必填参数 ' + param.name };
      }
    }
    return { args: args };
  }

  function serializeResult(value, cap) {
    var body;
    if (typeof value === 'string') body = value;
    else {
      try { body = JSON.stringify(value === undefined ? { ok: true } : value, null, 1); }
      catch (error) { body = String(value); }
    }
    if (body.length <= cap) return body;
    return body.slice(0, cap) + '\n…（结果共 ' + body.length + ' 字，已截断。需要其余部分请用该工具的 offset / limit / path 等参数分段读取）';
  }

  function resultBlock(name, status, body) {
    return '<tool_result name="' + name + '" status="' + status + '">\n' + body + '\n</tool_result>';
  }

  modules.agentProtocol = { parse: parseToolCalls, coerce: coerceArgs, serialize: serializeResult, resultBlock: resultBlock };
  modules.parseAgentToolCalls = parseToolCalls;
  modules.coerceAgentArgs = coerceArgs;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/permissions.js ---- */
(function (root) {
  'use strict';

  /*
   * 权限 = 档位 × 确认方式 + 规则。
   *
   * 档位（能写到哪里）：
   *   readonly  只读      什么都不改
   *   card      单卡      当前聊天、当前角色卡以及绑在这张卡上的世界书 / 正则 / 脚本
   *   tavern    酒馆全权  酒馆里的一切（其他卡、全局世界书、预设、斜杠命令、页面脚本、对外推送）
   *   device    设备全权  再加上后端伴侣：跑命令、读写设备文件、无头浏览器
   * 读：酒馆内不受档位限制；设备上的读需要 device。她自己的工作区任何档位都可写。
   *
   * 确认方式：ask 每次写入都问 ｜ auto 档位内直接做、危险操作仍问 ｜ yolo 全部直接做。
   * 规则：按路径通配的 allow / ask / deny，先于上面的判断；deny 永远生效，allow 不能越过档位。
   *
   * 每次调用给出 { effect: read | note | write | danger, scope: workspace | chat | card | tavern | external | device, path, tool }。
   * note 指她自己的记事（记忆、计划）：单卡及以上直接放行。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var MODE_RANK = { readonly: 0, card: 1, tavern: 2, device: 3 };
  var SCOPE_RANK = { workspace: 0, chat: 1, card: 1, tavern: 2, external: 2, device: 3 };
  var MODE_LABEL = { readonly: '只读', card: '单卡', tavern: '酒馆全权', device: '设备全权' };
  var SCOPE_NEEDS = { chat: 'card', card: 'card', tavern: 'tavern', external: 'tavern', device: 'device' };

  function globToRegExp(pattern) {
    var source = String(pattern || '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.');
    return new RegExp('^' + source + '$');
  }

  function normalizeRules(input) {
    return (Array.isArray(input) ? input : []).map(function (rule) {
      if (!rule || typeof rule.pattern !== 'string' || !rule.pattern.trim()) return null;
      return {
        effect: ['allow', 'ask', 'deny'].indexOf(rule.effect) >= 0 ? rule.effect : 'deny',
        action: ['read', 'write', '*'].indexOf(rule.action) >= 0 ? rule.action : '*',
        pattern: rule.pattern.trim().slice(0, 300)
      };
    }).filter(Boolean).slice(0, 100);
  }

  function createPermissions(getSettings) {
    var session = Object.create(null);

    function settings() {
      var source = getSettings() || {};
      return {
        mode: MODE_RANK[source.mode] === undefined ? 'card' : source.mode,
        approval: ['ask', 'auto', 'yolo'].indexOf(source.approval) >= 0 ? source.approval : 'ask',
        rules: normalizeRules(source.rules)
      };
    }

    function matchRule(rules, request) {
      var target = String(request.path || request.tool || '');
      var action = request.effect === 'read' ? 'read' : 'write';
      var hit = null;
      for (var index = 0; index < rules.length; index += 1) {
        var rule = rules[index];
        if (rule.action !== '*' && rule.action !== action) continue;
        if (!(globToRegExp(rule.pattern).test(target) || rule.pattern === request.tool)) continue;
        if (rule.effect === 'deny') return rule;   /* 禁止优先；其余取第一条匹配的 */
        if (!hit) hit = rule;
      }
      return hit;
    }

    function sessionKey(request) { return String(request.tool || '') + '|' + String(request.scope || ''); }

    function evaluate(request) {
      var current = settings();
      var effect = request.effect || 'read';
      var scope = SCOPE_RANK[request.scope] === undefined ? 'tavern' : request.scope;
      var rule = matchRule(current.rules, request);
      if (rule && rule.effect === 'deny') return { decision: 'deny', reason: '用户在权限规则里禁止了这一项（' + rule.pattern + '）。不要绕过，如实告诉用户。' };

      if (effect === 'read') {
        if (scope === 'device' && current.mode !== 'device') return { decision: 'deny', reason: '读取设备上的文件需要「设备全权」档位。请告诉用户可以在助手设置里调整。' };
        return { decision: rule && rule.effect === 'ask' ? 'ask' : 'allow' };
      }
      if (scope === 'workspace') return { decision: 'allow' };
      if (SCOPE_RANK[scope] > MODE_RANK[current.mode]) {
        return { decision: 'deny', reason: '当前权限档位是「' + MODE_LABEL[current.mode] + '」，这个操作需要「' + MODE_LABEL[SCOPE_NEEDS[scope]] + '」。不要换别的办法绕过；告诉用户想让你做的话，可以在助手设置里把档位调高。' };
      }
      if (rule && rule.effect === 'ask') return { decision: 'ask' };
      if (rule && rule.effect === 'allow') return { decision: 'allow' };
      if (effect === 'note') return { decision: 'allow' };
      if (current.approval === 'yolo') return { decision: 'allow' };
      if (effect === 'danger') return { decision: 'ask' };
      if (current.approval === 'auto' || session[sessionKey(request)]) return { decision: 'allow' };
      return { decision: 'ask' };
    }

    return {
      evaluate: evaluate,
      allowSession: function (request) { if (request.effect !== 'danger') session[sessionKey(request)] = true; },
      resetSession: function () { session = Object.create(null); },
      describe: function () {
        var current = settings();
        return '权限档位「' + MODE_LABEL[current.mode] + '」；' + (current.mode === 'readonly' ? '不能改动任何东西'
          : current.approval === 'ask' ? '每次写入前会请用户确认' : current.approval === 'auto' ? '档位内的写入直接执行，危险操作仍会请用户确认' : '所有操作直接执行');
      },
      mode: function () { return settings().mode; }
    };
  }

  modules.AGENT_MODES = MODE_LABEL;
  modules.normalizePermissionRules = normalizeRules;
  modules.createPermissions = createPermissions;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/vfs.js ---- */
(function (root) {
  'use strict';

  /*
   * 资源挂载（VFS）：酒馆里的东西统一成「路径 → 文本」。
   *
   *   路径  <挂载名>:/<段>/<段>…[#/JSON/指针]
   *   名字里的 / # % 写成 %2F %23 %25（ls 给出的名字已经转好，照抄即可）。
   *
   * 挂载点（provider）接口，除 id 外都可省略：
   *   { id, title, hint, readonly,
   *     scope(segs, action) → 'workspace' | 'chat' | 'card' | 'tavern' | 'external' | 'device',
   *     list(segs, { offset, limit }) → { items: [{ name, dir, size, note }], total },
   *     read(segs) → string | null（不存在）,
   *     write(segs, text), remove(segs),
   *     bulk(segs) → [{ path, text }]   检索用的快速通道，省略时按 list / read 递归 }
   *
   * 写入一律经过这里：先留写入前镜像（撤销用），再交给挂载点。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  function enc(name) { return String(name).replace(/%/g, '%25').replace(/\//g, '%2F').replace(/#/g, '%23'); }
  function dec(name) { try { return decodeURIComponent(name); } catch (error) { return name; } }

  function parsePath(input) {
    var raw = String(input == null ? '' : input).trim();
    var match = raw.match(/^([A-Za-z][\w-]*):\/?(.*)$/);
    if (!match) throw new Error('路径要写成「挂载名:/…」，例如 wb:/书名/条目名。用 ls 不带参数可以看到所有挂载点。');
    var rest = match[2], pointer = null;
    var hash = rest.indexOf('#/');
    if (hash < 0 && /#$/.test(rest)) hash = rest.length - 1;
    if (hash >= 0) { pointer = rest.slice(hash + 1); rest = rest.slice(0, hash); }
    var segs = rest.split('/').filter(function (part) { return part !== ''; }).map(dec);
    return { mount: match[1], segs: segs, pointer: pointer, canonical: match[1] + ':/' + segs.map(enc).join('/') + (pointer ? '#' + pointer : '') };
  }

  function pointerParts(pointer) {
    return String(pointer || '').split('/').slice(1).map(function (part) { return part.replace(/~1/g, '/').replace(/~0/g, '~'); });
  }

  function pointerGet(doc, pointer) {
    var parts = pointerParts(pointer), current = doc;
    for (var index = 0; index < parts.length; index += 1) {
      if (current === null || typeof current !== 'object' || !(parts[index] in current)) return { found: false };
      current = current[parts[index]];
    }
    return { found: true, value: current };
  }

  function pointerSet(doc, pointer, value, remove) {
    var parts = pointerParts(pointer);
    if (!parts.length) return value;
    var current = doc;
    for (var index = 0; index < parts.length - 1; index += 1) {
      var key = parts[index];
      if (/^(?:__proto__|constructor|prototype)$/.test(key)) throw new Error('路径里有不允许的键名');
      if (current[key] === null || typeof current[key] !== 'object') {
        if (remove) return doc;
        current[key] = /^\d+$/.test(parts[index + 1]) ? [] : {};
      }
      current = current[key];
    }
    var last = parts[parts.length - 1];
    if (/^(?:__proto__|constructor|prototype)$/.test(last)) throw new Error('路径里有不允许的键名');
    if (remove) { if (Array.isArray(current)) current.splice(Number(last), 1); else delete current[last]; }
    else current[last] = value;
    return doc;
  }

  function numbered(lines, start) {
    return lines.map(function (line, index) { return String(start + index).padStart(5, ' ') + '\t' + line; }).join('\n');
  }

  function createVfs(deps) {
    var journal = deps && deps.journal;
    var mounts = new Map();
    var pauseAt = 0;

    /* 长循环里隔一阵让出主线程，别让酒馆卡住。 */
    function breathe() {
      var now = Date.now();
      if (now - pauseAt < 24) return null;
      pauseAt = now;
      return new Promise(function (resolve) { setTimeout(function () { pauseAt = Date.now(); resolve(); }, 0); });
    }

    function provider(parsed) {
      var found = mounts.get(parsed.mount);
      if (!found) throw new Error('没有名为 ' + parsed.mount + ': 的挂载点。可用：' + Array.from(mounts.keys()).join('、'));
      return found;
    }

    function scope(path, action) {
      var parsed = parsePath(path), target = provider(parsed);
      return typeof target.scope === 'function' ? target.scope(parsed.segs, action) : target.scope || 'tavern';
    }

    async function list(path, options) {
      var raw = String(path == null ? '' : path).trim();
      if (!raw) {
        var items = Array.from(mounts.values()).map(function (item) { return { name: item.id + ':/', dir: true, note: item.title + (item.hint ? '。' + item.hint : '') }; });
        return { items: items, total: items.length };
      }
      var parsed = parsePath(raw), target = provider(parsed);
      if (typeof target.list !== 'function') throw new Error(parsed.mount + ': 不能列目录');
      var result = await target.list(parsed.segs, options || {});
      if (Array.isArray(result)) result = { items: result, total: result.length };
      return result || { items: [], total: 0 };
    }

    /* 原文；不存在时返回 null。带 JSON 指针时返回那棵子树（字符串叶子原样返回，其余为 JSON）。 */
    async function readText(path) {
      var parsed = parsePath(path), target = provider(parsed);
      if (typeof target.read !== 'function') throw new Error(parsed.mount + ': 不能读取');
      var text = await target.read(parsed.segs);
      if (text === null || text === undefined) return null;
      if (!parsed.pointer) return String(text);
      var doc;
      try { doc = JSON.parse(text); } catch (error) { throw new Error('这个文件不是 JSON，不能用 # 指针'); }
      var hit = pointerGet(doc, parsed.pointer);
      if (!hit.found) return null;
      return typeof hit.value === 'string' ? hit.value : JSON.stringify(hit.value, null, 1);
    }

    async function read(path, options) {
      var text = await readText(path);
      if (text === null) throw new Error('没有这个文件：' + path + '。先用 ls 看看上一级目录里有什么。');
      var lines = text.split('\n');
      var offset = Math.max(1, Math.trunc(Number(options && options.offset) || 1));
      var limit = Math.max(1, Math.min(2000, Math.trunc(Number(options && options.limit) || 200)));
      var cap = Math.max(1000, Number(options && options.cap) || 12000);
      var slice = lines.slice(offset - 1, offset - 1 + limit);
      /* 单行极长（压成一行的脚本）时按字符再切，行号后标出列范围。 */
      var body = '', used = 0, shown = 0;
      for (var index = 0; index < slice.length; index += 1) {
        var line = slice[index];
        var column = index === 0 ? Math.max(0, Math.trunc(Number(options && options.column) || 0)) : 0;
        var room = cap - used;
        if (room <= 0) break;
        var piece = line.slice(column, column + room);
        var partial = column > 0 || piece.length < line.length - column;
        body += (body ? '\n' : '') + String(offset + index).padStart(5, ' ') + (partial ? '[' + column + '-' + (column + piece.length) + '/' + line.length + ']' : '') + '\t' + piece;
        used += piece.length + 1;
        shown += 1;
        if (partial && piece.length < line.length - column) { shown -= 1; break; }
      }
      var next = offset + shown;
      var more = next <= lines.length;
      return {
        text: body, totalLines: lines.length, totalChars: text.length, from: offset, to: next - 1,
        more: more ? '还有内容：共 ' + lines.length + ' 行 / ' + text.length + ' 字。继续读用 offset=' + next + (slice[shown] !== undefined && slice[shown].length > cap ? '（这一行很长，可加 column=字符位置 分段读，或直接用 grep 定位）' : '') : ''
      };
    }

    async function writeRaw(parsed, target, text, run) {
      var basePath = parsed.mount + ':/' + parsed.segs.map(enc).join('/');
      var before = typeof target.read === 'function' ? await target.read(parsed.segs) : null;
      var next = text;
      if (parsed.pointer) {
        var doc;
        try { doc = before === null || before === undefined ? {} : JSON.parse(before); } catch (error) { throw new Error('这个文件不是 JSON，不能用 # 指针写入'); }
        var existing = pointerGet(doc, parsed.pointer);
        var value;
        if (existing.found && typeof existing.value === 'string') value = text;
        else {
          try { value = JSON.parse(text); }
          catch (error) {
            if (existing.found) throw new Error('这里原来不是字符串，要写入合法的 JSON 值');
            value = text;
          }
        }
        next = JSON.stringify(pointerSet(doc, parsed.pointer, value), null, 1);
      }
      if (journal && run) await journal.capture(run, basePath, before === undefined ? null : before);
      await target.write(parsed.segs, next);
      if (journal && run) await journal.settle(run, basePath, typeof target.read === 'function' ? await target.read(parsed.segs) : next);
      return { path: parsed.canonical, created: before === null || before === undefined, chars: String(text).length };
    }

    async function write(path, text, run) {
      var parsed = parsePath(path), target = provider(parsed);
      if (target.readonly || typeof target.write !== 'function') throw new Error(parsed.mount + ': 是只读的');
      return writeRaw(parsed, target, String(text == null ? '' : text), run);
    }

    async function remove(path, run) {
      var parsed = parsePath(path), target = provider(parsed);
      if (parsed.pointer) {
        var before = await target.read(parsed.segs);
        if (before === null || before === undefined) throw new Error('没有这个文件：' + path);
        var doc = pointerSet(JSON.parse(before), parsed.pointer, undefined, true);
        var basePath = parsed.mount + ':/' + parsed.segs.map(enc).join('/');
        if (journal && run) await journal.capture(run, basePath, before);
        await target.write(parsed.segs, JSON.stringify(doc, null, 1));
        if (journal && run) await journal.settle(run, basePath, await target.read(parsed.segs));
        return { path: parsed.canonical, removed: true };
      }
      if (target.readonly || typeof target.remove !== 'function') throw new Error(parsed.mount + ': 这里不能删除');
      var old = typeof target.read === 'function' ? await target.read(parsed.segs) : null;
      if (old === null || old === undefined) throw new Error('没有这个文件：' + path);
      if (journal && run) await journal.capture(run, parsed.canonical, old);
      await target.remove(parsed.segs);
      if (journal && run) await journal.settle(run, parsed.canonical, null);
      return { path: parsed.canonical, removed: true };
    }

    /* 精确替换。old 必须在文件里恰好出现一次（all=true 时替换全部）。 */
    async function edit(path, oldText, newText, all, run) {
      var text = await readText(path);
      if (text === null) throw new Error('没有这个文件：' + path + '。新建请用 write。');
      var needle = String(oldText == null ? '' : oldText);
      if (!needle) throw new Error('old 不能为空');
      var count = text.split(needle).length - 1;
      if (count === 0) {
        var loose = needle.replace(/\r\n/g, '\n').trim();
        var hint = loose && text.replace(/\r\n/g, '\n').indexOf(loose) >= 0 ? '（去掉首尾空白或换成 \\n 换行后能找到——请原样复制 read 给出的内容，不带行号）' : '';
        throw new Error('没有找到要替换的原文' + hint + '。先 read 或 grep 确认现在的内容。');
      }
      if (count > 1 && !all) throw new Error('要替换的原文出现了 ' + count + ' 次。多带一些上下文让它唯一，或者加 all=true 全部替换。');
      var next = all ? text.split(needle).join(String(newText == null ? '' : newText)) : text.replace(needle, function () { return String(newText == null ? '' : newText); });
      var outcome = await write(path, next, run);
      outcome.replaced = all ? count : 1;
      return outcome;
    }

    async function collect(path, budget) {
      var parsed = parsePath(path), target = provider(parsed);
      if (typeof target.bulk === 'function') {
        var fast = await target.bulk(parsed.segs);
        if (fast) return fast;
      }
      var single = typeof target.read === 'function' ? await Promise.resolve().then(function () { return target.read(parsed.segs); }).catch(function () { return null; }) : null;
      if (single !== null && single !== undefined) return [{ path: parsed.canonical, text: String(single) }];
      var output = [];
      var queue = [parsed.canonical];
      while (queue.length && output.length < budget.files) {
        var dir = queue.shift();
        var listing = await list(dir, { offset: 0, limit: 2000 }).catch(function () { return { items: [] }; });
        for (var index = 0; index < listing.items.length && output.length < budget.files; index += 1) {
          var item = listing.items[index];
          var child = dir.replace(/\/$/, '') + '/' + enc(item.name);
          if (item.dir) { queue.push(child); continue; }
          var text = await readText(child).catch(function () { return null; });
          if (text !== null) output.push({ path: child, text: text });
          var pause = breathe();
          if (pause) await pause;
        }
      }
      return output;
    }

    /* 在一个文件或一棵目录里检索。pattern 是正则（写错时按字面量找）。 */
    async function grep(path, pattern, options) {
      var opts = options || {};
      var flags = String(opts.flags || 'i').replace(/[^imsu]/g, '');
      var expression;
      try { expression = new RegExp(String(pattern), flags); }
      catch (error) { expression = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); }
      var context = Math.max(0, Math.min(5, Math.trunc(Number(opts.context) || 0)));
      var limit = Math.max(1, Math.min(200, Math.trunc(Number(opts.limit) || 40)));
      var files = await collect(path, { files: Math.max(1, Number(opts.maxFiles) || 600) });
      var hits = [], total = 0, matchedFiles = 0;
      for (var index = 0; index < files.length; index += 1) {
        var file = files[index];
        if (opts.signal && opts.signal.aborted) break;
        if (!expression.test(file.text)) continue;
        matchedFiles += 1;
        var lines = file.text.split('\n');
        for (var line = 0; line < lines.length; line += 1) {
          var found = expression.exec(lines[line]);
          if (!found) continue;
          total += 1;
          if (hits.length >= limit) continue;
          var textLine = lines[line];
          /* 极长的行只给命中处前后一段，并给出列号，方便接着 read column=…。 */
          var excerpt = textLine.length > 300
            ? '[列 ' + found.index + '] …' + textLine.slice(Math.max(0, found.index - 100), found.index + 180) + '…'
            : textLine;
          var block = file.path + ':' + (line + 1) + ': ' + excerpt;
          if (context) {
            var from = Math.max(0, line - context), to = Math.min(lines.length, line + context + 1);
            block = file.path + '\n' + numbered(lines.slice(from, to).map(function (item) { return item.length > 300 ? item.slice(0, 300) + '…' : item; }), from + 1);
          }
          hits.push(block);
        }
        var pause = breathe();
        if (pause) await pause;
      }
      return { hits: hits, total: total, files: matchedFiles, scanned: files.length };
    }

    return {
      mount: function (item) { if (!item || !item.id) throw new Error('挂载点缺少 id'); mounts.set(item.id, item); return item; },
      unmount: function (id) { return mounts.delete(id); },
      mounts: function () { return Array.from(mounts.values()); },
      has: function (id) { return mounts.has(id); },
      parse: parsePath, scope: scope, list: list, readText: readText, read: read, write: write, remove: remove, edit: edit, grep: grep
    };
  }

  modules.vfsEnc = enc;
  modules.vfsDec = dec;
  modules.parseVfsPath = parsePath;
  modules.createVfs = createVfs;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/providers.js ---- */
(function (root) {
  'use strict';

  /*
   * 内置挂载点：把酒馆里的东西接到 VFS 上。
   * 优先走酒馆助手的接口（跨版本最稳）；没装酒馆助手时，聊天、聊天变量、世界书、角色卡走酒馆原生接口，
   * 正则只读，脚本与预设不可用（它们本来就是酒馆助手的概念 / 接口）。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var enc = modules.vfsEnc;

  var CARD_FIELDS = {
    'description.md': 'description', 'personality.md': 'personality', 'scenario.md': 'scenario',
    'first_mes.md': 'first_mes', 'mes_example.md': 'mes_example', 'system_prompt.md': 'system_prompt',
    'post_history_instructions.md': 'post_history_instructions', 'creator_notes.md': 'creator_notes'
  };
  var CARD_TOP = { description: 'description', personality: 'personality', scenario: 'scenario', first_mes: 'first_mes', mes_example: 'mes_example', creator_notes: 'creatorcomment' };

  function preview(text, limit) {
    var flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
  }

  function page(items, options) {
    var offset = Math.max(0, Math.trunc(Number(options && options.offset) || 0));
    var limit = Math.max(1, Math.trunc(Number(options && options.limit) || 100));
    return { items: items.slice(offset, offset + limit), total: items.length };
  }

  /* 同名条目加 #标识 区分；段里带 #标识 时按标识找。 */
  function uniqueNames(items, nameOf, idOf) {
    var count = {};
    items.forEach(function (item) { var name = nameOf(item) || ''; count[name] = (count[name] || 0) + 1; });
    return items.map(function (item) {
      var name = nameOf(item) || '';
      return !name || count[name] > 1 ? (name || '') + '#' + idOf(item) : name;
    });
  }

  function pick(items, segment, nameOf, idOf) {
    var hash = segment.lastIndexOf('#');
    if (hash >= 0) {
      var id = segment.slice(hash + 1);
      for (var index = 0; index < items.length; index += 1) if (String(idOf(items[index])) === id) return items[index];
    }
    for (var i = 0; i < items.length; i += 1) if (nameOf(items[i]) === segment) return items[i];
    return null;
  }

  function need(kit, name, what) {
    var found = kit.fn(name);
    if (!found) throw new Error(what + '需要酒馆助手（当前环境没有 ' + name + ' 接口）');
    return found;
  }

  /* 页面探针：记下报错与警告，供 page:/errors 读取。每次调用只做常数时间的事。 */
  function installPageProbe(env) {
    var host = env.host;
    if (!host || host.__readerIIProbe) return host && host.__readerIIProbe || { errors: [], logs: [] };
    var probe = { errors: [], logs: [] };
    function push(list, kind, parts) {
      var text;
      try {
        text = Array.prototype.map.call(parts, function (part) {
          if (part instanceof Error) return part.stack || part.message;
          if (typeof part === 'string') return part;
          try { return JSON.stringify(part); } catch (error) { return String(part); }
        }).join(' ');
      } catch (error) { text = '(无法序列化)'; }
      list.push({ at: Date.now(), kind: kind, text: String(text).slice(0, 1200) });
      if (list.length > 200) list.splice(0, list.length - 200);
    }
    try {
      host.addEventListener('error', function (event) {
        push(probe.errors, 'error', [(event.message || '') + (event.filename ? ' @ ' + event.filename + ':' + event.lineno + ':' + event.colno : ''), event.error || '']);
      });
      host.addEventListener('unhandledrejection', function (event) { push(probe.errors, 'rejection', [event.reason || '']); });
      ['error', 'warn'].forEach(function (level) {
        var original = host.console[level];
        if (typeof original !== 'function') return;
        host.console[level] = function () {
          try { push(level === 'error' ? probe.errors : probe.logs, level, arguments); } catch (error) { /* 探针不能影响页面 */ }
          return original.apply(this, arguments);
        };
      });
      if (host.toastr && typeof host.toastr.error === 'function') {
        var toast = host.toastr.error;
        host.toastr.error = function (message, title) {
          try { push(probe.errors, 'toast', [String(title || '') + ' ' + String(message || '')]); } catch (error) { /* ignore */ }
          return toast.apply(this, arguments);
        };
      }
    } catch (error) { /* 装不上就算了 */ }
    host.__readerIIProbe = probe;
    return probe;
  }

  function installBuiltinProviders(vfs, env, kit, deps) {
    var store = deps.store;
    var probe = deps.probe || { errors: [], logs: [] };
    var ctx = function () { return kit.context() || {}; };

    /* ---------- chat:/ ---------- */
    vfs.mount({
      id: 'chat', title: '当前聊天的楼层正文', hint: 'chat:/<楼层号>，楼层从 0 起；<楼层号>.json 是该楼的属性（只读）',
      scope: function () { return 'chat'; },
      list: function (segs, options) {
        var chat = kit.rawChat();
        var offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
        var limit = Math.max(1, Math.trunc(Number(options.limit) || 100));
        var items = [];
        for (var index = offset; index < Math.min(chat.length, offset + limit); index += 1) {
          var message = chat[index] || {};
          items.push({ name: String(index), size: String(message.mes || '').length, note: (message.is_user ? '用户' : message.is_system ? '隐藏' : 'AI') + ' ' + String(message.name || '') + '：' + preview(kit.cleanText(message.mes), 40) });
        }
        return { items: items, total: chat.length };
      },
      read: async function (segs) {
        if (!segs.length) return null;
        var chat = kit.rawChat();
        var json = /\.json$/.test(segs[0]);
        var id = Number(segs[0].replace(/\.json$/, ''));
        if (segs[0] === 'latest' || segs[0] === 'latest.json') id = chat.length - 1;
        var message = chat[id];
        if (!Number.isInteger(id) || !message) return null;
        if (!json) return String(message.mes == null ? '' : message.mes);
        return JSON.stringify({ id: id, name: message.name, role: message.is_user ? 'user' : message.is_system ? 'system' : 'assistant', hidden: message.is_system === true, send_date: message.send_date, swipe_id: message.swipe_id, swipes: Array.isArray(message.swipes) ? message.swipes.length : 0, extra_keys: Object.keys(message.extra || {}) }, null, 1);
      },
      write: async function (segs, text) {
        var id = segs[0] === 'latest' ? kit.rawChat().length - 1 : Number(segs[0]);
        if (!Number.isInteger(id) || !kit.rawChat()[id]) throw new Error('没有第 ' + segs[0] + ' 楼；新增楼层请用 tavern 工具箱');
        await kit.setMessageText(id, text);
      },
      bulk: async function (segs) {
        if (segs.length) return null;
        return kit.rawChat().map(function (message, index) { return { path: 'chat:/' + index, text: String(message && message.mes || '') }; });
      }
    });

    /* ---------- card:/ ---------- */
    function character() {
      var context = ctx();
      var card = context.characters && context.characters[context.characterId];
      if (!card) throw new Error('当前没有打开角色卡（群聊里请先指定角色）');
      return card;
    }

    function cardValue(card, field) {
      var data = card.data || {};
      if (data[field] !== undefined && data[field] !== null) return String(data[field]);
      var top = CARD_TOP[field];
      return top && card[top] !== undefined && card[top] !== null ? String(card[top]) : '';
    }

    async function mergeCard(card, patch, id) {
      var context = ctx();
      var body = { avatar: card.avatar, data: {} };
      Object.keys(patch).forEach(function (field) {
        body.data[field] = patch[field];
        if (CARD_TOP[field]) body[CARD_TOP[field]] = patch[field];
      });
      var headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : { 'Content-Type': 'application/json' };
      var response = await env.host.fetch('/api/characters/merge-attributes', { method: 'POST', headers: headers, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('角色卡保存失败（HTTP ' + response.status + '）');
      Object.keys(patch).forEach(function (field) {
        card.data = card.data || {};
        card.data[field] = patch[field];
        if (CARD_TOP[field]) card[CARD_TOP[field]] = patch[field];
      });
      try {
        var types = context.eventTypes || context.event_types || {};
        if (context.eventSource && types.CHARACTER_EDITED) await context.eventSource.emit(types.CHARACTER_EDITED, { detail: { id: id === undefined ? context.characterId : id, character: card } });
      } catch (error) { /* 通知失败不算保存失败 */ }
    }

    /* 角色卡目录（card:/ 与 cards:/<卡>/ 共用）：字段文件、greetings/、meta.json。 */
    function cardList(card, segs, options) {
      if (segs[0] === 'greetings') {
        var greetings = card.data && Array.isArray(card.data.alternate_greetings) ? card.data.alternate_greetings : [];
        return page(greetings.map(function (text, index) { return { name: (index + 1) + '.md', size: String(text).length, note: preview(text, 40) }; }), options);
      }
      var items = Object.keys(CARD_FIELDS).map(function (file) { return { name: file, size: cardValue(card, CARD_FIELDS[file]).length }; });
      items.push({ name: 'greetings', dir: true, note: '备选开场白' }, { name: 'meta.json', note: '名称、作者、版本、绑定世界书等（只读）' });
      return page(items, options);
    }

    function cardRead(card, segs) {
      if (segs[0] === 'greetings') {
        var list = card.data && card.data.alternate_greetings || [];
        var index = Number(String(segs[1] || '').replace(/\.md$/, '')) - 1;
        return list[index] === undefined ? null : String(list[index]);
      }
      if (segs[0] === 'meta.json') {
        var data = card.data || {}, extensions = data.extensions || {};
        return JSON.stringify({ name: card.name, avatar: card.avatar, creator: data.creator, version: data.character_version, tags: data.tags, worldbook: extensions.world || null, regex_scripts: (extensions.regex_scripts || []).length, alternate_greetings: (data.alternate_greetings || []).length }, null, 1);
      }
      return CARD_FIELDS[segs[0]] ? cardValue(card, CARD_FIELDS[segs[0]]) : null;
    }

    function cardWrite(card, id, segs, text) {
      if (segs[0] === 'greetings') {
        var list = (card.data && card.data.alternate_greetings || []).slice();
        var index = Number(String(segs[1] || '').replace(/\.md$/, '')) - 1;
        if (!Number.isInteger(index) || index < 0 || index > list.length) throw new Error('备选开场白的编号要连续：现在有 ' + list.length + ' 条');
        list[index] = text;
        return mergeCard(card, { alternate_greetings: list }, id);
      }
      if (!CARD_FIELDS[segs[0]]) throw new Error('角色卡里没有这个字段：' + segs[0]);
      var patch = {}; patch[CARD_FIELDS[segs[0]]] = text;
      return mergeCard(card, patch, id);
    }

    vfs.mount({
      id: 'card', title: '当前角色卡的字段', hint: '改完即保存；绑定的世界书在 wb:/，卡内正则与脚本在 regex:/card、script:/card；别的卡在 cards:/',
      scope: function () { return 'card'; },
      list: function (segs, options) { return cardList(character(), segs, options); },
      read: async function (segs) { return cardRead(character(), segs); },
      write: async function (segs, text) { return cardWrite(character(), undefined, segs, text); }
    });

    /* ---------- cards:/ 酒馆里的全部角色卡 ---------- */
    var cardName = function (card) { return String(card && card.name || ''); };
    var cardId = function (card) { return String(card && card.avatar || ''); };

    function allCards() {
      var list = ctx().characters;
      return Array.isArray(list) ? list : [];
    }

    function locateCard(segment) {
      var list = allCards();
      var card = segment ? pick(list, String(segment), cardName, cardId) : null;
      if (!card) return null;
      var index = list.indexOf(card);
      return { card: card, index: index, current: String(index) === String(ctx().characterId) };
    }

    /* 新版酒馆只把列表里的卡加载成“浅卡”（没有描述等长字段）；读写前补全。 */
    async function fullCard(hit) {
      if (!hit.card.shallow) return hit.card;
      var context = ctx();
      if (typeof context.unshallowCharacter === 'function') {
        await context.unshallowCharacter(hit.index);
        return allCards()[hit.index] || hit.card;
      }
      var headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : { 'Content-Type': 'application/json' };
      var response = await env.host.fetch('/api/characters/get', { method: 'POST', headers: headers, body: JSON.stringify({ avatar_url: hit.card.avatar }) });
      if (!response.ok) throw new Error('读取角色卡失败（HTTP ' + response.status + '）');
      return await response.json();
    }

    vfs.mount({
      id: 'cards', title: '酒馆里的全部角色卡',
      hint: 'cards:/<卡名>/ 下的结构同 card:/；同名的卡写成 <卡名>#<头像文件>。改当前卡算单卡范围，改别的卡要酒馆全权；新建、删除角色卡请在酒馆里操作',
      scope: function (segs) {
        var hit = segs[0] ? locateCard(segs[0]) : null;
        return hit && hit.current ? 'card' : 'tavern';
      },
      list: async function (segs, options) {
        if (!segs.length) {
          var list = allCards();
          var names = uniqueNames(list, cardName, cardId);
          return page(list.map(function (card, index) {
            var data = card.data || {};
            return { name: names[index], dir: true, note: (String(index) === String(ctx().characterId) ? '[当前] ' : '') + (data.creator ? '作者 ' + data.creator : '') };
          }), options);
        }
        var hit = locateCard(segs[0]);
        if (!hit) throw new Error('没有这张角色卡：' + segs[0] + '（先 ls cards:/ 看准名字）');
        return cardList(await fullCard(hit), segs.slice(1), options);
      },
      read: async function (segs) {
        var hit = locateCard(segs[0]);
        if (!hit || segs.length < 2) return null;
        return cardRead(await fullCard(hit), segs.slice(1));
      },
      write: async function (segs, text) {
        var hit = locateCard(segs[0]);
        if (!hit) throw new Error('没有这张角色卡：' + segs[0] + '（新建角色卡请在酒馆里操作）');
        if (segs.length < 2) throw new Error('要写到具体字段，例如 cards:/' + segs[0] + '/description.md');
        var card = await fullCard(hit);
        return cardWrite(card, hit.index, segs.slice(1), text);
      },
      /* 检索全部卡时只看已经加载的字段（浅卡的长字段要先 read 一次）；指定一张卡时会先补全。 */
      bulk: async function (segs) {
        var list = allCards(), names = uniqueNames(list, cardName, cardId), output = [];
        var only = segs[0] ? locateCard(segs[0]) : null;
        if (segs[0] && !only) return [];
        for (var index = 0; index < list.length; index += 1) {
          if (only && index !== only.index) continue;
          var card = only ? await fullCard(only) : list[index];
          Object.keys(CARD_FIELDS).forEach(function (file) {
            var text = cardValue(card, CARD_FIELDS[file]);
            if (text) output.push({ path: 'cards:/' + enc(names[index]) + '/' + file, text: text });
          });
        }
        return output;
      }
    });

    /* ---------- wb:/ ---------- */
    var entryName = function (entry) { return String(entry.name || ''); };
    var entryId = function (entry) { return entry.uid; };

    function entryNote(entry) {
      var strategy = entry.strategy || {};
      var keys = Array.isArray(strategy.keys) ? strategy.keys.map(String).slice(0, 4).join('、') : '';
      return (entry.enabled === false ? '[关] ' : '') + (strategy.type === 'constant' ? '常驻' : strategy.type === 'vectorized' ? '向量' : '关键词') + (keys ? '：' + keys : '');
    }

    async function locateEntry(segs) {
      var entries = await kit.readWorldbook(segs[0]);
      var meta = /\.meta\.json$/.test(segs[1]);
      var entry = pick(entries, segs[1].replace(/\.meta\.json$/, ''), entryName, entryId);
      return { entries: entries, entry: entry, meta: meta, name: segs[1].replace(/\.meta\.json$/, '') };
    }

    vfs.mount({
      id: 'wb', title: '世界书', hint: 'wb:/<书>/<条目> 是条目正文；<条目>.meta.json 是开关、触发词、位置等',
      scope: function (segs) {
        if (!segs.length) return 'tavern';
        var scopes = kit.worldbookScopes();
        return scopes.character_primary === segs[0] || scopes.character_additional.indexOf(segs[0]) >= 0 || scopes.chat === segs[0] ? 'card' : 'tavern';
      },
      list: async function (segs, options) {
        if (!segs.length) {
          var scopes = kit.worldbookScopes();
          return page(scopes.all.map(function (name) {
            var marks = [];
            if (scopes.character_primary === name || scopes.character_additional.indexOf(name) >= 0) marks.push('当前卡');
            if (scopes.chat === name) marks.push('当前聊天');
            if (scopes.global.indexOf(name) >= 0) marks.push('全局启用');
            return { name: name, dir: true, note: marks.join('、') };
          }), options);
        }
        var entries = await kit.readWorldbook(segs[0]);
        var names = uniqueNames(entries, entryName, entryId);
        return page(entries.map(function (entry, index) { return { name: names[index], size: String(entry.content || '').length, note: entryNote(entry) }; }), options);
      },
      read: async function (segs) {
        if (segs.length < 2) return null;
        if (kit.worldbookNames().indexOf(segs[0]) < 0) return null;
        var found = await locateEntry(segs);
        if (!found.entry) return null;
        if (!found.meta) return String(found.entry.content || '');
        var meta = modules.clone(found.entry);
        delete meta.content;
        return JSON.stringify(meta, null, 1);
      },
      write: async function (segs, text) {
        if (segs.length < 2) throw new Error('要写到 wb:/<书>/<条目>');
        if (kit.worldbookNames().indexOf(segs[0]) < 0) await kit.createWorldbook(segs[0]);
        var found = await locateEntry(segs);
        if (!found.entry) {
          if (found.meta) throw new Error('条目还不存在：先写正文（wb:/<书>/<条目>），再改 .meta.json');
          await kit.addWorldbookEntries(segs[0], [{ name: found.name.replace(/#.*$/, ''), content: text, enabled: true }]);
          return;
        }
        var uid = found.entry.uid;
        var patch = null;
        if (found.meta) {
          try { patch = JSON.parse(text); } catch (error) { throw new Error('.meta.json 需要合法的 JSON'); }
          if (!modules.isObject(patch)) throw new Error('.meta.json 需要一个对象');
          delete patch.content; delete patch.uid;
        }
        await kit.updateWorldbook(segs[0], function (entries) {
          return entries.map(function (entry) {
            if (entry.uid !== uid) return entry;
            return found.meta ? Object.assign({}, entry, patch) : Object.assign({}, entry, { content: text });
          });
        });
      },
      remove: async function (segs) {
        if (segs.length < 2) throw new Error('这里只能删除条目；删整本书请在酒馆里操作');
        var found = await locateEntry(segs);
        if (!found.entry) throw new Error('没有这个条目');
        var uid = found.entry.uid;
        await kit.updateWorldbook(segs[0], function (entries) { return entries.filter(function (entry) { return entry.uid !== uid; }); });
      },
      bulk: async function (segs) {
        if (segs.length > 1) return null;
        var books = segs.length ? [segs[0]] : kit.worldbookNames();
        var output = [];
        for (var index = 0; index < books.length; index += 1) {
          var entries;
          try { entries = await kit.readWorldbook(books[index]); } catch (error) { continue; }
          var names = uniqueNames(entries, entryName, entryId);
          entries.forEach(function (entry, at) { output.push({ path: 'wb:/' + enc(books[index]) + '/' + enc(names[at]), text: String(entry.content || '') }); });
        }
        return output;
      }
    });

    /* ---------- regex:/ ---------- */
    var REGEX_SCOPE = { global: 'global', card: 'character' };
    var regexName = function (item) { return String(item.script_name || ''); };
    var regexId = function (item) { return item.id; };

    function readRegexes(scopeName) {
      var get = kit.fn('getTavernRegexes');
      /* 当前版本的选项是 { type }；scope / enable_state 是 3.x 的写法，一并传上兼容旧版。 */
      if (get) return (get({ type: REGEX_SCOPE[scopeName], scope: REGEX_SCOPE[scopeName], enable_state: 'all' }) || []).slice();
      /* 没有酒馆助手：读酒馆自己的结构，只读。 */
      var context = ctx();
      var rawList = scopeName === 'global' ? context.extensionSettings && context.extensionSettings.regex
        : (function () { try { return character().data.extensions.regex_scripts; } catch (error) { return []; } })();
      return (rawList || []).map(function (raw) {
        return { id: raw.id, script_name: raw.scriptName, enabled: raw.disabled !== true, find_regex: raw.findRegex, replace_string: raw.replaceString, run_on_edit: raw.runOnEdit === true, min_depth: raw.minDepth, max_depth: raw.maxDepth };
      });
    }

    async function writeRegexes(scopeName, updater) {
      await need(kit, 'updateTavernRegexesWith', '修改正则')(function (list) { return updater((list || []).slice()); }, { type: REGEX_SCOPE[scopeName], scope: REGEX_SCOPE[scopeName] });
    }

    vfs.mount({
      id: 'regex', title: '酒馆正则', hint: 'regex:/global|card/<名>/find.txt · replace.html · meta.json',
      scope: function (segs) { return segs[0] === 'card' ? 'card' : 'tavern'; },
      list: function (segs, options) {
        if (!segs.length) return page([{ name: 'global', dir: true, note: '全局正则' }, { name: 'card', dir: true, note: '当前角色卡的局部正则' }], options);
        if (!REGEX_SCOPE[segs[0]]) return page([], options);
        var list = readRegexes(segs[0]);
        if (segs.length === 1) {
          var names = uniqueNames(list, regexName, regexId);
          return page(list.map(function (item, index) { return { name: names[index], dir: true, note: (item.enabled === false ? '[关] ' : '') + preview(item.find_regex, 50) }; }), options);
        }
        var item = pick(list, segs[1], regexName, regexId);
        if (!item) return page([], options);
        return page([{ name: 'find.txt', size: String(item.find_regex || '').length }, { name: 'replace.html', size: String(item.replace_string || '').length }, { name: 'meta.json' }], options);
      },
      read: async function (segs) {
        if (segs.length < 3 || !REGEX_SCOPE[segs[0]]) return null;
        var item = pick(readRegexes(segs[0]), segs[1], regexName, regexId);
        if (!item) return null;
        if (segs[2] === 'find.txt') return String(item.find_regex || '');
        if (segs[2] === 'replace.html') return String(item.replace_string || '');
        if (segs[2] !== 'meta.json') return null;
        var meta = modules.clone(item);
        delete meta.find_regex; delete meta.replace_string;
        return JSON.stringify(meta, null, 1);
      },
      write: async function (segs, text) {
        if (segs.length < 3 || !REGEX_SCOPE[segs[0]]) throw new Error('要写到 regex:/global|card/<名>/find.txt、replace.html 或 meta.json');
        var field = segs[2] === 'find.txt' ? 'find_regex' : segs[2] === 'replace.html' ? 'replace_string' : segs[2] === 'meta.json' ? null : undefined;
        if (field === undefined) throw new Error('正则只有 find.txt、replace.html、meta.json 三个文件');
        var patch = {};
        if (field) patch[field] = text;
        else {
          try { patch = JSON.parse(text); } catch (error) { throw new Error('meta.json 需要合法的 JSON'); }
          delete patch.find_regex; delete patch.replace_string; delete patch.id;
        }
        await writeRegexes(segs[0], function (list) {
          var item = pick(list, segs[1], regexName, regexId);
          if (item) { Object.assign(item, patch); return list; }
          var uuid = env.host.crypto && typeof env.host.crypto.randomUUID === 'function' ? env.host.crypto.randomUUID() : 'reader-' + Date.now().toString(36);
          list.push(Object.assign({
            id: uuid, script_name: segs[1].replace(/#.*$/, ''), enabled: true, run_on_edit: false, scope: REGEX_SCOPE[segs[0]],
            find_regex: '', replace_string: '', trim_strings: [], source: { user_input: false, ai_output: true, slash_command: false, world_info: false, reasoning: false },
            destination: { display: true, prompt: false }, min_depth: null, max_depth: null
          }, patch));
          return list;
        });
      },
      remove: async function (segs) {
        if (segs.length !== 2) throw new Error('删除正则请指到 regex:/global|card/<名>');
        await writeRegexes(segs[0], function (list) {
          var item = pick(list, segs[1], regexName, regexId);
          return item ? list.filter(function (other) { return other !== item; }) : list;
        });
      },
      bulk: async function (segs) {
        var scopes = segs.length ? [segs[0]] : ['global', 'card'];
        var output = [];
        scopes.forEach(function (scopeName) {
          if (!REGEX_SCOPE[scopeName]) return;
          var list; try { list = readRegexes(scopeName); } catch (error) { return; }
          var names = uniqueNames(list, regexName, regexId);
          list.forEach(function (item, index) {
            if (segs[1] && names[index] !== segs[1]) return;
            var base = 'regex:/' + scopeName + '/' + enc(names[index]);
            if (!segs[2] || segs[2] === 'find.txt') output.push({ path: base + '/find.txt', text: String(item.find_regex || '') });
            if (!segs[2] || segs[2] === 'replace.html') output.push({ path: base + '/replace.html', text: String(item.replace_string || '') });
          });
        });
        return output;
      }
    });

    /* ---------- script:/（酒馆助手脚本） ---------- */
    var SCRIPT_SCOPE = { global: 'global', card: 'character', preset: 'preset' };
    var scriptName = function (item) { return String(item.name || ''); };
    var scriptId = function (item) { return item.id; };

    function flattenScripts(trees) {
      var output = [];
      (trees || []).forEach(function (node) {
        if (node && node.type === 'folder') (node.scripts || []).forEach(function (child) { output.push(child); });
        else if (node) output.push(node);
      });
      return output;
    }

    function readScripts(scopeName) {
      return flattenScripts(need(kit, 'getScriptTrees', '读取酒馆助手脚本')({ type: SCRIPT_SCOPE[scopeName] }));
    }

    vfs.mount({
      id: 'script', title: '酒馆助手脚本', hint: 'script:/global|card|preset/<名>/content.js · info.md · meta.json',
      scope: function (segs) { return segs[0] === 'card' ? 'card' : 'tavern'; },
      list: function (segs, options) {
        if (!segs.length) return page(Object.keys(SCRIPT_SCOPE).map(function (name) { return { name: name, dir: true }; }), options);
        if (!SCRIPT_SCOPE[segs[0]]) return page([], options);
        var list = readScripts(segs[0]);
        if (segs.length === 1) {
          var names = uniqueNames(list, scriptName, scriptId);
          return page(list.map(function (item, index) { return { name: names[index], dir: true, note: (item.enabled === false ? '[关] ' : '') + String(item.content || '').length + ' 字' }; }), options);
        }
        var item = pick(list, segs[1], scriptName, scriptId);
        return page(item ? [{ name: 'content.js', size: String(item.content || '').length }, { name: 'info.md', size: String(item.info || '').length }, { name: 'meta.json' }] : [], options);
      },
      read: async function (segs) {
        if (segs.length < 3 || !SCRIPT_SCOPE[segs[0]]) return null;
        var item = pick(readScripts(segs[0]), segs[1], scriptName, scriptId);
        if (!item) return null;
        if (segs[2] === 'content.js') return String(item.content || '');
        if (segs[2] === 'info.md') return String(item.info || '');
        if (segs[2] !== 'meta.json') return null;
        var meta = modules.clone(item);
        delete meta.content; delete meta.info;
        return JSON.stringify(meta, null, 1);
      },
      write: async function (segs, text) {
        if (segs.length < 3 || !SCRIPT_SCOPE[segs[0]]) throw new Error('要写到 script:/global|card|preset/<名>/content.js、info.md 或 meta.json');
        var field = segs[2] === 'content.js' ? 'content' : segs[2] === 'info.md' ? 'info' : segs[2] === 'meta.json' ? null : undefined;
        if (field === undefined) throw new Error('脚本只有 content.js、info.md、meta.json 三个文件');
        var patch = {};
        if (field) patch[field] = text;
        else {
          try { patch = JSON.parse(text); } catch (error) { throw new Error('meta.json 需要合法的 JSON'); }
          delete patch.content; delete patch.info; delete patch.id; delete patch.type;
        }
        await need(kit, 'updateScriptTreesWith', '修改酒馆助手脚本')(function (trees) {
          var list = (trees || []).slice();
          var item = pick(flattenScripts(list), segs[1], scriptName, scriptId);
          if (item) { Object.assign(item, patch); return list; }
          var uuid = env.host.crypto && typeof env.host.crypto.randomUUID === 'function' ? env.host.crypto.randomUUID() : 'reader-' + Date.now().toString(36);
          list.push(Object.assign({ type: 'script', enabled: false, name: segs[1].replace(/#.*$/, ''), id: uuid, content: '', info: '', button: { enabled: true, buttons: [] }, data: {} }, patch));
          return list;
        }, { type: SCRIPT_SCOPE[segs[0]] });
      },
      bulk: async function (segs) {
        var scopes = segs.length ? [segs[0]] : Object.keys(SCRIPT_SCOPE);
        var output = [];
        scopes.forEach(function (scopeName) {
          if (!SCRIPT_SCOPE[scopeName]) return;
          var list; try { list = readScripts(scopeName); } catch (error) { return; }
          var names = uniqueNames(list, scriptName, scriptId);
          list.forEach(function (item, index) {
            if (segs[1] && names[index] !== segs[1]) return;
            if (!segs[2] || segs[2] === 'content.js') output.push({ path: 'script:/' + scopeName + '/' + enc(names[index]) + '/content.js', text: String(item.content || '') });
          });
        });
        return output;
      }
    });

    /* ---------- preset:/（当前预设） ---------- */
    var promptName = function (item) { return String(item.name || item.id || ''); };
    var promptId = function (item) { return item.id; };

    function readPreset() { return need(kit, 'getPreset', '读取预设')('in_use') || {}; }

    vfs.mount({
      id: 'preset', title: '正在使用的预设', hint: 'preset:/prompts/<提示词名>.md 与 settings.json',
      scope: function () { return 'tavern'; },
      list: function (segs, options) {
        if (!segs.length) return page([{ name: 'prompts', dir: true, note: '提示词条目' }, { name: 'settings.json', note: '采样与上下文参数（只读）' }], options);
        var prompts = readPreset().prompts || [];
        var names = uniqueNames(prompts, promptName, promptId);
        return page(prompts.map(function (item, index) { return { name: names[index] + '.md', size: String(item.content || '').length, note: (item.enabled === false ? '[关] ' : '') + String(item.role || '') }; }), options);
      },
      read: async function (segs) {
        var preset = readPreset();
        if (segs[0] === 'settings.json') return JSON.stringify(preset.settings || {}, null, 1);
        if (segs[0] !== 'prompts' || !segs[1]) return null;
        var item = pick(preset.prompts || [], segs[1].replace(/\.md$/, ''), promptName, promptId);
        return item ? String(item.content == null ? '' : item.content) : null;
      },
      write: async function (segs, text) {
        if (segs[0] !== 'prompts' || !segs[1]) throw new Error('预设里只能改 prompts/<提示词名>.md 的内容');
        var target = segs[1].replace(/\.md$/, '');
        await need(kit, 'updatePresetWith', '修改预设')('in_use', function (preset) {
          var item = pick(preset.prompts || [], target, promptName, promptId);
          if (!item) throw new Error('预设里没有这个提示词条目：' + target);
          item.content = text;
          return preset;
        });
      }
    });

    /* ---------- var:/ ---------- */
    function varOption(segs) {
      if (segs[0] === 'chat.json') return { type: 'chat' };
      if (segs[0] === 'global.json') return { type: 'global' };
      if (segs[0] === 'character.json') return { type: 'character' };
      if (segs[0] === 'mvu.json') return { type: 'message', message_id: 'latest' };
      if (segs[0] === 'message' && segs[1]) {
        var id = segs[1].replace(/\.json$/, '');
        return { type: 'message', message_id: id === 'latest' ? 'latest' : Number(id) };
      }
      return null;
    }

    function readVars(option) {
      var get = kit.fn('getVariables');
      if (get) return get(option) || {};
      var context = ctx();
      if (option.type === 'chat') return context.chatMetadata && context.chatMetadata.variables || {};
      if (option.type === 'global') return context.extensionSettings && context.extensionSettings.variables && context.extensionSettings.variables.global || {};
      throw new Error('读取这类变量需要酒馆助手');
    }

    async function writeVars(option, value) {
      var replace = kit.fn('replaceVariables');
      if (replace) { await replace(value, option); return; }
      var context = ctx();
      if (option.type === 'chat' && context.chatMetadata) {
        context.chatMetadata.variables = value;
        if (typeof context.saveMetadata === 'function') await context.saveMetadata();
        return;
      }
      if (option.type === 'global' && context.extensionSettings) {
        context.extensionSettings.variables = context.extensionSettings.variables || {};
        context.extensionSettings.variables.global = value;
        if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
        return;
      }
      throw new Error('写入这类变量需要酒馆助手');
    }

    vfs.mount({
      id: 'var', title: '变量', hint: 'var:/chat.json · global.json · character.json · message/<楼层|latest>.json · mvu.json（最新楼的 MVU 变量）；用 #/路径 取子树，如 var:/mvu.json#/stat_data/主角',
      scope: function (segs) { return segs[0] === 'global.json' ? 'tavern' : 'chat'; },
      list: function (segs, options) {
        if (segs[0] === 'message') {
          var total = kit.chatLength();
          return page([{ name: 'latest.json', note: '最新一楼' }].concat(total ? [{ name: (total - 1) + '.json', note: '楼层号从 0 到 ' + (total - 1) }] : []), options);
        }
        return page([
          { name: 'chat.json', note: '聊天变量（小白X 的变量也在这里）' }, { name: 'message', dir: true, note: '楼层变量' },
          { name: 'mvu.json', note: '最新楼的 MVU 变量（stat_data 等）' }, { name: 'character.json', note: '角色卡变量' }, { name: 'global.json', note: '全局变量' }
        ], options);
      },
      read: async function (segs) {
        var option = varOption(segs);
        if (!option) return null;
        return JSON.stringify(readVars(option), null, 1);
      },
      write: async function (segs, text) {
        var option = varOption(segs);
        if (!option) throw new Error('没有这个变量文件');
        var value;
        try { value = JSON.parse(text); } catch (error) { throw new Error('变量文件需要合法的 JSON'); }
        if (!modules.isObject(value)) throw new Error('变量文件的顶层必须是对象');
        await writeVars(option, value);
      }
    });

    /* ---------- ext:/（已安装扩展的源码，只读） ---------- */
    var extensionNames = null;

    async function discoverExtensions() {
      if (extensionNames) return extensionNames;
      var context = ctx();
      var headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
      var response = await env.host.fetch('/api/extensions/discover', { method: 'GET', headers: headers });
      var list = response.ok ? await response.json() : [];
      extensionNames = (Array.isArray(list) ? list : []).map(function (item) { return String(item && item.name || item || ''); })
        .filter(function (name) { return name.indexOf('third-party/') === 0; }).map(function (name) { return name.slice('third-party/'.length); });
      return extensionNames;
    }

    async function fetchExtensionFile(segs) {
      var url = '/scripts/extensions/third-party/' + segs.map(encodeURIComponent).join('/');
      var response = await env.host.fetch(url, { cache: 'no-cache' });
      if (!response.ok) return null;
      var type = String(response.headers && response.headers.get && response.headers.get('content-type') || '');
      if (/^(?:image|audio|video|font)\//.test(type)) return '（二进制文件，' + type + '）';
      var text = await response.text();
      return text.length > 3000000 ? text.slice(0, 3000000) : text;
    }

    vfs.mount({
      id: 'ext', title: '已安装的第三方扩展源码（只读）', hint: '目录无法整体列出：从 manifest.json 找到入口文件，再顺着 import 逐个读',
      readonly: true,
      scope: function () { return 'tavern'; },
      list: async function (segs, options) {
        if (!segs.length) return page((await discoverExtensions()).map(function (name) { return { name: name, dir: true }; }), options);
        if (segs.length > 1) return page([], options);
        var items = [{ name: 'manifest.json' }];
        try {
          var manifest = JSON.parse(await fetchExtensionFile([segs[0], 'manifest.json']));
          if (manifest.js) items.push({ name: String(manifest.js), note: '入口脚本' });
          if (manifest.css) items.push({ name: String(manifest.css), note: '样式' });
        } catch (error) { /* 只有 manifest */ }
        return page(items, options);
      },
      read: async function (segs) { return segs.length < 2 ? null : fetchExtensionFile(segs); }
    });

    /* ---------- page:/（正在运行的页面，只读） ---------- */
    function dump(list) {
      return list.slice(-80).map(function (item) { return new Date(item.at).toLocaleTimeString() + ' [' + item.kind + '] ' + item.text; }).join('\n') || '（暂无记录）';
    }

    vfs.mount({
      id: 'page', title: '正在运行的酒馆页面（只读）', hint: 'page:/errors 最近的报错与红色提示 · page:/console 警告 · page:/env.json 版本与已装组件',
      readonly: true,
      scope: function () { return 'tavern'; },
      list: function (segs, options) {
        return page([{ name: 'errors', note: probe.errors.length + ' 条' }, { name: 'console', note: probe.logs.length + ' 条警告' }, { name: 'env.json' }], options);
      },
      read: async function (segs) {
        if (segs[0] === 'errors') return dump(probe.errors);
        if (segs[0] === 'console') return dump(probe.logs);
        if (segs[0] !== 'env.json') return null;
        return JSON.stringify(typeof deps.describeEnv === 'function' ? deps.describeEnv() : {}, null, 1);
      }
    });

    /* ---------- ws:/（她的工作区） ---------- */
    vfs.mount({
      id: 'ws', title: '你的工作区（草稿、计划、工作流、自写插件；不随聊天变化，更新扩展也不会动）', hint: '任何权限档位下都可以读写',
      scope: function () { return 'workspace'; },
      list: async function (segs, options) {
        var prefix = segs.length ? segs.join('/') + '/' : '';
        var keys = ((await store.keys('files')) || []).map(String).filter(function (key) { return key.indexOf(prefix) === 0; });
        var seen = {}, items = [];
        keys.sort().forEach(function (key) {
          var rest = key.slice(prefix.length), slash = rest.indexOf('/');
          var name = slash >= 0 ? rest.slice(0, slash) : rest;
          if (seen[name]) return;
          seen[name] = true;
          items.push({ name: name, dir: slash >= 0 });
        });
        return page(items, options);
      },
      read: async function (segs) {
        if (!segs.length) return null;
        var record = await store.get('files', segs.join('/'));
        return record ? String(record.text) : null;
      },
      write: async function (segs, text) {
        if (!segs.length) throw new Error('要给文件起个名字，例如 ws:/notes/想法.md');
        await store.put('files', segs.join('/'), { text: text, at: Date.now() });
      },
      remove: async function (segs) { await store.del('files', segs.join('/')); }
    });

    /* ---------- mem:/ 记忆 ---------- */
    /*
     * mem:/chat/ 当前聊天的记忆 · mem:/ocean/ 《夜之洋》 · mem:/summary.md 前情梗概 · mem:/settings.json 记忆设置（只读）
     * 每条记忆：<标题>.md 是正文，<标题>.meta.json 是类型、触发词、重要度、常驻、开关、归属。写一个不存在的 <标题>.md 就是新建。
     * 与 memory 工具箱读写的是同一份数据；范围按 chat 算，和 memory_save 一致。
     */
    var memory = deps.memory;
    var memTitle = function (record) { return record.title; };
    var memId = function (record) { return record.id; };
    var MEM_META = ['type', 'keys', 'importance', 'pinned', 'enabled', 'owner'];

    function memoryApi() {
      if (!memory) throw new Error('记忆系统没有启动');
      return memory;
    }

    async function memRecords(storeName) {
      return memoryApi().list({ store: storeName, fresh: true }).then(function (list) {
        return list.filter(function (record) { return record.store === storeName; });
      });
    }

    async function locateMemory(segs) {
      if (segs[0] !== 'chat' && segs[0] !== 'ocean') return null;
      var file = String(segs[1] || '');
      var isMeta = /\.meta\.json$/.test(file);
      var base = file.replace(/\.meta\.json$/, '').replace(/\.md$/, '');
      if (!base) return null;
      var records = await memRecords(segs[0]);
      return { store: segs[0], isMeta: isMeta, base: base, record: pick(records, base, memTitle, memId) };
    }

    function memMeta(record) {
      var output = {};
      MEM_META.forEach(function (key) { output[key] = record[key]; });
      output.id = record.id;
      output.store = record.store;
      output.source = record.source;
      output.updatedAt = new Date(record.updatedAt).toISOString();
      return JSON.stringify(output, null, 1);
    }

    vfs.mount({
      id: 'mem', title: '记忆（夜之洋）',
      hint: 'mem:/chat|ocean/<标题>.md 正文 · <标题>.meta.json 类型、触发词、重要度、常驻、归属（owner：story 正文的 | agent 你自己的）；写一个新标题就是新记一条；mem:/summary.md 前情梗概',
      scope: function () { return 'chat'; },
      list: async function (segs, options) {
        if (!segs.length) {
          var status = await memoryApi().status();
          return page([
            { name: 'chat', dir: true, note: '当前聊天的记忆 ' + status.chatCount + ' 条' },
            { name: 'ocean', dir: true, note: '《' + status.oceanBook + '》' + status.oceanCount + ' 条（跨存档）' },
            { name: 'summary.md', size: String(status.summary || '').length, note: '前情梗概' },
            { name: 'settings.json', note: '记忆设置（只读；改设置请让用户在面板里改）' }
          ], options);
        }
        if (segs[0] !== 'chat' && segs[0] !== 'ocean') throw new Error('mem:/ 下只有 chat/、ocean/、summary.md、settings.json');
        var records = await memRecords(segs[0]);
        var names = uniqueNames(records, memTitle, memId);
        var items = [];
        records.forEach(function (record, index) {
          var tag = '[' + (memoryApi().TYPE_SHORT[record.type] || record.type) + (record.owner === 'agent' ? '·你自己的' : '') + (record.pinned ? '·常驻' : '') + (record.enabled ? '' : '·停用') + '] ';
          items.push({ name: names[index] + '.md', size: record.content.length, note: tag + preview(record.content, 40) });
        });
        return page(items, options);
      },
      read: async function (segs) {
        if (segs[0] === 'summary.md' && segs.length === 1) return String((await memoryApi().status()).summary || '');
        if (segs[0] === 'settings.json' && segs.length === 1) return JSON.stringify(memoryApi().getSettings(), null, 1);
        var hit = await locateMemory(segs);
        if (!hit || !hit.record) return null;
        return hit.isMeta ? memMeta(hit.record) : hit.record.content;
      },
      write: async function (segs, text) {
        var api = memoryApi();
        if (segs[0] === 'summary.md' && segs.length === 1) { api.setSummary(text); return; }
        if (segs[0] === 'settings.json') throw new Error('记忆设置是只读的：请用户在面板的设置页里改');
        var hit = await locateMemory(segs);
        if (!hit) throw new Error('路径要写成 mem:/chat/<标题>.md 或 mem:/ocean/<标题>.md');
        if (hit.isMeta) {
          if (!hit.record) throw new Error('没有这条记忆：' + hit.base + '（先写 ' + hit.base + '.md 新建）');
          var meta;
          try { meta = JSON.parse(text); } catch (error) { throw new Error('meta.json 不是合法的 JSON：' + error.message); }
          var patch = {};
          MEM_META.forEach(function (key) { if (meta && meta[key] !== undefined) patch[key] = meta[key]; });
          await api.update(hit.record.id, patch);
          return;
        }
        if (hit.record) { await api.update(hit.record.id, { content: text }); return; }
        if (hit.base.indexOf('#') >= 0) throw new Error('没有这条记忆：' + hit.base);
        await api.add({ type: 'fact', title: hit.base, content: text, source: 'agent', owner: 'agent' }, { store: hit.store });
      },
      remove: async function (segs) {
        var hit = await locateMemory(segs);
        if (!hit || !hit.record || hit.isMeta) throw new Error('只能删除 mem:/chat|ocean/<标题>.md（会连同它的 meta 一起删）');
        await memoryApi().remove(hit.record.id);
      },
      bulk: async function (segs) {
        var stores = segs[0] === 'chat' || segs[0] === 'ocean' ? [segs[0]] : ['chat', 'ocean'];
        var output = [];
        for (var index = 0; index < stores.length; index += 1) {
          var records = await memRecords(stores[index]);
          var names = uniqueNames(records, memTitle, memId);
          records.forEach(function (record, at) { output.push({ path: 'mem:/' + stores[index] + '/' + enc(names[at]) + '.md', text: record.content }); });
        }
        if (!segs.length) output.push({ path: 'mem:/summary.md', text: String((await memoryApi().status()).summary || '') });
        return output;
      }
    });
  }

  modules.installPageProbe = installPageProbe;
  modules.installBuiltinProviders = installBuiltinProviders;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/tools.js ---- */
(function (root) {
  'use strict';

  /*
   * 注册表与核心工具。
   *
   * 工具定义：
   *   { name, toolset = 'core', summary, params: [{ name, type: string|number|boolean|json, required, desc }],
   *     effect: 'read' | 'note' | 'write' | 'danger' 或 (args) => 其一,
   *     scope:  'workspace' | 'chat' | 'card' | 'tavern' | 'external' | 'device' 或 (args) => 其一,
   *     paths(args) → [VFS 路径]   这次调用会改到的资源：执行前留镜像，可撤销；也用来匹配权限规则
   *     irreversible: true         无法自动撤销（斜杠命令、页面脚本等），会记进运行日志
   *     describe(args) → 给用户看的一句话, run(args, ctx) → 结果（字符串或可序列化对象） }
   *
   * 核心工具常驻提示词；其余工具属于某个「工具箱」，打开工具箱后它的说明才进入提示词。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var NAME = /^[a-z][a-z0-9_]{1,47}$/;

  function createRegistry() {
    var tools = new Map();
    var toolsets = new Map();
    var skills = new Map();
    var connectors = new Map();
    var hooks = {};

    function registerToolset(def) {
      if (!def || !NAME.test(String(def.name).replace(/[\/-]/g, '_'))) throw new Error('工具箱名称无效');
      toolsets.set(def.name, { name: def.name, summary: String(def.summary || '').slice(0, 160), auto: def.auto === true, source: def.source || 'plugin' });
      return def.name;
    }

    function registerTool(def) {
      if (!def || !NAME.test(def.name)) throw new Error('工具名只能用小写字母、数字、下划线：' + (def && def.name));
      if (typeof def.run !== 'function') throw new Error('工具 ' + def.name + ' 缺少 run');
      var toolset = def.toolset || 'core';
      if (toolset !== 'core' && !toolsets.has(toolset)) registerToolset({ name: toolset, summary: def.toolsetSummary || '' });
      var item = Object.assign({ params: [], effect: 'read', scope: 'tavern', source: 'plugin' }, def, { toolset: toolset });
      tools.set(item.name, item);
      return item.name;
    }

    function registerSkill(def) {
      if (!def || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(def.name)) throw new Error('知识名只能用小写字母、数字、连字符');
      skills.set(def.name, { name: def.name, summary: String(def.summary || '').slice(0, 200), body: def.body, load: def.load, files: def.files || null, source: def.source || 'plugin' });
      return def.name;
    }

    async function loadSkill(name) {
      var skill = skills.get(String(name || '').trim());
      if (!skill) return null;
      if (typeof skill.body !== 'string' && typeof skill.load === 'function') skill.body = String(await skill.load());
      return skill;
    }

    function on(event, handler) {
      (hooks[event] = hooks[event] || []).push(handler);
      return function () { hooks[event] = (hooks[event] || []).filter(function (item) { return item !== handler; }); };
    }

    async function emit(event, payload) {
      var list = (hooks[event] || []).slice();
      for (var index = 0; index < list.length; index += 1) {
        try { await list[index](payload); } catch (error) { /* 插件的钩子出错不影响运行 */ }
      }
    }

    return {
      registerTool: registerTool, registerToolset: registerToolset, registerSkill: registerSkill,
      unregisterTool: function (name) { return tools.delete(name); },
      unregisterToolset: function (name) {
        Array.from(tools.values()).forEach(function (item) { if (item.toolset === name) tools.delete(item.name); });
        return toolsets.delete(name);
      },
      unregisterSkill: function (name) { return skills.delete(name); },
      registerConnector: function (def) { if (!def || !def.id) throw new Error('插件对接缺少 id'); connectors.set(def.id, def); return def.id; },
      connectors: function () { return Array.from(connectors.values()); },
      find: function (name) { return tools.get(String(name || '').trim()) || null; },
      tools: function (toolset) { return Array.from(tools.values()).filter(function (item) { return !toolset || item.toolset === toolset; }); },
      toolsets: function () { return Array.from(toolsets.values()).filter(function (set) { return Array.from(tools.values()).some(function (item) { return item.toolset === set.name; }); }); },
      skills: function () { return Array.from(skills.values()); },
      loadSkill: loadSkill, on: on, emit: emit
    };
  }

  function resolve(value, args, fallback) {
    try { return typeof value === 'function' ? value(args) : value || fallback; } catch (error) { return fallback; }
  }

  /* 工具说明（写给模型看）。 */
  function manual(tools) {
    return tools.map(function (def) {
      var params = (def.params || []).map(function (param) {
        return '  - ' + param.name + '（' + param.type + (param.required ? '，必填' : '') + '）' + (param.desc ? '：' + param.desc : '');
      });
      var effect = typeof def.effect === 'function' ? '［视参数而定］' : def.effect === 'write' ? '［写入］' : def.effect === 'danger' ? '［危险］' : '';
      return '● ' + def.name + ' ' + effect + '\n  ' + def.summary + (params.length ? '\n' + params.join('\n') : '');
    }).join('\n');
  }

  function formatListing(path, listing, offset) {
    var enc = modules.vfsEnc;
    var lines = listing.items.map(function (item) {
      var name = /:\/$/.test(item.name) ? item.name : enc(item.name) + (item.dir ? '/' : '');
      return name + (item.size !== undefined ? '  (' + item.size + ' 字)' : '') + (item.note ? '  — ' + item.note : '');
    });
    var shown = offset + listing.items.length;
    var tail = listing.total > shown ? '\n…共 ' + listing.total + ' 项，已列 ' + (offset + 1) + '–' + shown + '。继续列用 offset=' + shown : '';
    return (lines.join('\n') || '（空）') + tail;
  }

  /* 在不带同源权限的沙箱 iframe 里跑一段脚本：碰不到酒馆，适合纯计算、数据处理、验证片段。 */
  function runSandboxed(env, code, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var doc = env.document, host = env.host;
      if (!doc || !host) { reject(new Error('当前环境没有页面，不能运行沙箱脚本')); return; }
      var frame = doc.createElement('iframe');
      var token = 'rj' + Date.now().toString(36) + Math.random().toString(36).slice(2);
      var done = false;
      function finish(error, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        host.removeEventListener('message', onMessage);
        try { frame.remove(); } catch (ignore) { /* already gone */ }
        if (error) reject(error); else resolve(value);
      }
      function onMessage(event) {
        var data = event.data;
        if (!data || data.token !== token || event.source !== frame.contentWindow) return;
        if (data.error) finish(new Error(String(data.error).slice(0, 2000)));
        else finish(null, { result: data.result, logs: data.logs });
      }
      var timer = setTimeout(function () { finish(new Error('脚本超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有结束，已中止')); }, timeoutMs);
      host.addEventListener('message', onMessage);
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.display = 'none';
      var body = 'const logs=[];const fmt=v=>{try{return typeof v==="string"?v:JSON.stringify(v)}catch(e){return String(v)}};'
        + 'console.log=console.info=console.warn=console.error=(...a)=>{if(logs.length<200)logs.push(a.map(fmt).join(" ").slice(0,2000))};'
        + '(async()=>{try{const result=await (async()=>{' + '\n' + code + '\n' + '})();'
        + 'parent.postMessage({token:' + JSON.stringify(token) + ',result:fmt(result===undefined?null:result),logs},"*")}'
        + 'catch(e){parent.postMessage({token:' + JSON.stringify(token) + ',error:String(e&&e.stack||e),logs},"*")}})()';
      frame.srcdoc = '<!doctype html><script>' + body.replace(/<\/script/gi, '<\\/script') + '<\/script>';
      doc.body.appendChild(frame);
    });
  }

  function installCoreTools(registry, deps) {
    var vfs = deps.vfs, env = deps.env;
    var writeScope = function (args) { try { return vfs.scope(args.path, 'write'); } catch (error) { return 'tavern'; } };
    var readScope = function (args) { try { return args.path ? vfs.scope(args.path, 'read') : 'workspace'; } catch (error) { return 'tavern'; } };
    var tool = function (def) { registry.registerTool(Object.assign({ toolset: 'core', source: 'builtin' }, def)); };

    tool({
      name: 'ls', effect: 'read', scope: readScope,
      summary: '列出一个路径下有什么。不带 path 时列出所有挂载点。',
      params: [{ name: 'path', type: 'string', desc: '如 wb:/ 或 wb:/某本书' }, { name: 'offset', type: 'number', desc: '从第几项开始，默认 0' }, { name: 'limit', type: 'number', desc: '最多列几项，默认 100' }],
      run: async function (args) {
        var offset = Math.max(0, Math.trunc(args.offset || 0));
        return formatListing(args.path, await vfs.list(args.path || '', { offset: offset, limit: Math.max(1, Math.min(500, Math.trunc(args.limit || 100))) }), offset);
      }
    });

    tool({
      name: 'read', effect: 'read', scope: readScope,
      summary: '读一个文件，返回带行号的内容（行号后是制表符，不属于原文）。长文件分段读；不知道在哪就先 grep。',
      params: [{ name: 'path', type: 'string', required: true }, { name: 'offset', type: 'number', desc: '起始行，默认 1' }, { name: 'limit', type: 'number', desc: '行数，默认 200' }, { name: 'column', type: 'number', desc: '起始行很长时，从该行第几个字符读起' }],
      run: async function (args, ctx) {
        var out = await vfs.read(args.path, { offset: args.offset, limit: args.limit, column: args.column, cap: ctx && ctx.resultCap ? ctx.resultCap - 400 : 8000 });
        return out.text + (out.more ? '\n' + out.more : '');
      }
    });

    tool({
      name: 'grep', effect: 'read', scope: readScope,
      summary: '在一个文件或整个目录里按正则检索，返回「路径:行号: 内容」。排查大脚本、找某个设定出自哪里，先用它定位再 read。',
      params: [{ name: 'pattern', type: 'string', required: true, desc: '正则表达式' }, { name: 'path', type: 'string', required: true, desc: '文件或目录，如 script:/ 、wb:/某本书 、chat:/' },
        { name: 'flags', type: 'string', desc: '默认 i（忽略大小写）' }, { name: 'context', type: 'number', desc: '每处命中带几行上下文，0–5' }, { name: 'limit', type: 'number', desc: '最多返回几处，默认 40' }],
      run: async function (args, ctx) {
        var out = await vfs.grep(args.path, args.pattern, { flags: args.flags, context: args.context, limit: args.limit, signal: ctx && ctx.signal });
        if (!out.total) return '没有命中（检索了 ' + out.scanned + ' 个文件）。';
        return out.hits.join('\n') + '\n— 共 ' + out.total + ' 处命中，分布在 ' + out.files + ' 个文件' + (out.total > out.hits.length ? '；只列出前 ' + out.hits.length + ' 处，可缩小 path 或换更具体的 pattern' : '');
      }
    });

    tool({
      name: 'edit', effect: 'write', scope: writeScope, paths: function (args) { return [args.path]; },
      summary: '精确替换文件里的一段文字。old 必须和原文完全一致（不带行号）且只出现一次；改动小的时候用它，不要整篇重写。',
      params: [{ name: 'path', type: 'string', required: true }, { name: 'old', type: 'string', required: true, desc: '要被替换的原文' }, { name: 'new', type: 'string', desc: '替换成的内容；留空即删除这段' }, { name: 'all', type: 'boolean', desc: 'true 时替换所有出现处' }],
      describe: function (args) { return '修改 ' + args.path; },
      run: async function (args, ctx) {
        var out = await vfs.edit(args.path, args.old, args.new === undefined ? '' : args.new, args.all === true, ctx && ctx.run);
        return '已修改 ' + out.path + '（替换 ' + out.replaced + ' 处）';
      }
    });

    tool({
      name: 'write', effect: 'write', scope: writeScope, paths: function (args) { return [args.path]; },
      summary: '新建文件，或整篇覆盖已有文件（已有文件优先用 edit）。',
      params: [{ name: 'path', type: 'string', required: true }, { name: 'content', type: 'string', required: true }],
      describe: function (args) { return '写入 ' + args.path; },
      run: async function (args, ctx) {
        var out = await vfs.write(args.path, args.content, ctx && ctx.run);
        return (out.created ? '已新建 ' : '已覆盖 ') + out.path + '（' + out.chars + ' 字）';
      }
    });

    tool({
      name: 'remove', effect: 'danger', scope: writeScope, paths: function (args) { return [args.path]; },
      summary: '删除一个文件（世界书条目、正则、工作区文件），或用 #/指针 删除 JSON 里的一个键。',
      params: [{ name: 'path', type: 'string', required: true }],
      describe: function (args) { return '删除 ' + args.path; },
      run: async function (args, ctx) { return '已删除 ' + (await vfs.remove(args.path, ctx && ctx.run)).path; }
    });

    tool({
      name: 'run_js',
      effect: function (args) { return args.target === 'page' ? 'danger' : 'read'; },
      scope: function (args) { return args.target === 'page' ? 'tavern' : 'workspace'; },
      irreversible: function (args) { return args.target === 'page'; },
      summary: '运行一段 JavaScript 并取回 return 的值与 console 输出。target=sandbox（默认）在隔离沙箱里跑，碰不到酒馆，用来计算、处理数据、验证代码片段；target=page 在酒馆页面里跑，能访问 SillyTavern、TavernHelper 等一切对象，用来检查正在运行的东西。',
      params: [{ name: 'code', type: 'string', required: true, desc: '函数体，可用 await，用 return 给出结果' }, { name: 'target', type: 'string', desc: 'sandbox 或 page' }],
      describe: function (args) { return args.target === 'page' ? '在酒馆页面里运行脚本' : '在沙箱里运行脚本'; },
      run: async function (args) {
        if (args.target === 'page') {
          var fn = new env.host.Function('return (async () => {\n' + args.code + '\n})()');
          var value = await fn();
          if (value === undefined) return '（没有返回值）';
          try { return typeof value === 'string' ? value : JSON.stringify(value, null, 1); } catch (error) { return String(value); }
        }
        var out = await runSandboxed(env, args.code, 15000);
        return '返回：' + out.result + (out.logs && out.logs.length ? '\n输出：\n' + out.logs.join('\n') : '');
      }
    });

    tool({
      name: 'todo', effect: 'read', scope: 'workspace',
      summary: '多步骤的任务先列计划，做完一步更新一次。每次都给出完整清单。',
      params: [{ name: 'items', type: 'json', required: true, desc: '数组，每项 { "text": 步骤, "status": "pending" | "doing" | "done" }' }],
      run: function (args, ctx) {
        var items = (Array.isArray(args.items) ? args.items : []).slice(0, 20).map(function (item) {
          var source = typeof item === 'string' ? { text: item } : item || {};
          return { text: String(source.text || '').slice(0, 200), status: ['pending', 'doing', 'done'].indexOf(source.status) >= 0 ? source.status : 'pending' };
        }).filter(function (item) { return item.text; });
        if (ctx && typeof ctx.setTodos === 'function') ctx.setTodos(items);
        return '计划已更新（' + items.filter(function (item) { return item.status === 'done'; }).length + '/' + items.length + ' 完成）';
      }
    });

    tool({
      name: 'skill', effect: 'read', scope: 'workspace',
      summary: '读取一份知识（见【知识】目录）。碰到相关任务先读，再动手。',
      params: [{ name: 'name', type: 'string', required: true }],
      run: async function (args) {
        var skill = await registry.loadSkill(args.name);
        if (!skill) throw new Error('没有名为 ' + args.name + ' 的知识。可用：' + registry.skills().map(function (item) { return item.name; }).join('、'));
        return String(skill.body || '').trim() + (skill.files ? '\n\n（参考文件在 kb:/' + skill.name + '/ 下，按需 grep / read）' : '');
      }
    });

    tool({
      name: 'toolbox', effect: 'read', scope: 'workspace',
      summary: '打开或关闭一个工具箱（见【工具箱】目录）。打开后会得到里面每个工具的说明，之后就能直接调用。',
      params: [{ name: 'name', type: 'string', required: true }, { name: 'action', type: 'string', desc: 'open（默认）或 close' }],
      run: function (args, ctx) {
        var name = String(args.name).trim();
        var list = registry.tools(name);
        if (!list.length) throw new Error('没有名为 ' + name + ' 的工具箱。可用：' + registry.toolsets().map(function (set) { return set.name; }).join('、'));
        if (args.action === 'close') { if (ctx && ctx.closeToolset) ctx.closeToolset(name); return '已关闭工具箱 ' + name; }
        if (ctx && ctx.openToolset) ctx.openToolset(name);
        return '已打开工具箱 ' + name + '：\n' + manual(list);
      }
    });
  }

  /*
   * 接入旧版的专用工具（reader-agent-tools.js）。世界书 / 变量 / 聊天的读写已由 VFS 原语取代，不再登记；
   * Reader 语义槽、记忆、酒馆助手 API 分别归入 reader / memory / tavern 工具箱。
   */
  function adoptLegacyTools(registry, legacy) {
    var SETS = {
      reader: { summary: 'Reader 自己的状态：FP、状态效果、语义槽适配、打开读者界面', names: ['reader_state', 'host_tree', 'host_write', 'fp_adjust', 'status_add', 'adapt_variables', 'unbind_slot', 'reader_ui'] },
      memory: { summary: '你的记忆（夜之洋）：检索、记下、修改、遗忘、整理', auto: true, names: ['memory_search', 'memory_list', 'memory_save', 'memory_update', 'memory_forget', 'memory_consolidate'] },
      tavern: { summary: '酒馆通用操作：执行斜杠命令、列出与调用酒馆助手的函数', names: ['tavern_api_list', 'tavern_api_call', 'slash_run'] }
    };
    var EFFECT = { read: 'read', memory: 'note', write: 'write', danger: 'danger' };
    Object.keys(SETS).forEach(function (set) {
      registry.registerToolset({ name: set, summary: SETS[set].summary, auto: SETS[set].auto === true, source: 'builtin' });
      SETS[set].names.forEach(function (name) {
        var def = legacy.find(name);
        if (!def) return;
        registry.registerTool({
          name: def.name, toolset: set, summary: def.summary, params: def.params || [], describe: def.describe, run: def.run, source: 'builtin',
          effect: def.tier === 'dynamic' ? function (args) { return EFFECT[legacy.tierFor(def, args)] || 'write'; } : EFFECT[def.tier] || 'write',
          scope: set === 'tavern' ? 'tavern' : 'chat',
          paths: set === 'reader' && def.tier !== 'read' ? function () { return ['var:/message/latest.json']; } : undefined,
          irreversible: set === 'tavern' && def.tier !== 'read'
        });
      });
    });
  }

  modules.createRegistry = createRegistry;
  modules.agentToolManual = manual;
  modules.resolveToolField = resolve;
  modules.installCoreTools = installCoreTools;
  modules.adoptLegacyTools = adoptLegacyTools;
  modules.runSandboxedScript = runSandboxed;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/connectors.js ---- */
(function (root) {
  'use strict';

  /*
   * 插件对接（connector）：探测酒馆里装着的其他插件，把它们的接口变成助手能用的东西。
   *
   *   { id, title, summary, detect() → 是否可用,
   *     brief(options) → 一段剧情 / 状态摘要（给「剧情察知」用，可省略）,
   *     tools: [工具定义]（登记到与 id 同名的工具箱，探测到才出现）, skill: 相关知识的名字 }
   *
   * 用户导入的对接是「声明式」的，不含代码：
   *   { "id": "my-plugin", "title": "…", "summary": "…", "detect": "window.MyPlugin",
   *     "brief": "MyPlugin.getSummary",
   *     "tools": [{ "name": "myplugin_get", "summary": "…", "effect": "read", "call": "MyPlugin.get",
   *                 "params": [{ "name": "id", "type": "string", "required": true }] }] }
   * call / brief / detect 都是宿主窗口上的全局路径；调用时按 params 的顺序传参。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  function lookup(host, path) {
    var parts = String(path || '').replace(/^(?:window|globalThis)\./, '').split('.').filter(Boolean);
    var owner = null, current = host;
    for (var index = 0; index < parts.length; index += 1) {
      if (/^(?:__proto__|constructor|prototype)$/.test(parts[index])) return { value: undefined };
      if (current === null || current === undefined) return { value: undefined };
      owner = current;
      try { current = current[parts[index]]; } catch (error) { return { value: undefined }; }
    }
    return { value: current, owner: owner };
  }

  function shorten(text, limit) {
    var source = String(text == null ? '' : text).trim();
    return source.length > limit ? source.slice(0, limit) + '…（已截断）' : source;
  }

  function fromManifest(host, manifest) {
    if (!modules.isObject(manifest) || !/^[a-z][a-z0-9_]{1,31}$/.test(String(manifest.id || ''))) throw new Error('对接描述的 id 只能用小写字母、数字、下划线');
    var id = manifest.id;
    var tools = (Array.isArray(manifest.tools) ? manifest.tools : []).slice(0, 40).map(function (item) {
      if (!item || !/^[a-z][a-z0-9_]{1,47}$/.test(String(item.name || '')) || typeof item.call !== 'string') throw new Error('对接描述里的工具需要 name 与 call');
      var params = (Array.isArray(item.params) ? item.params : []).slice(0, 12).map(function (param) {
        return { name: String(param.name), type: ['string', 'number', 'boolean', 'json'].indexOf(param.type) >= 0 ? param.type : 'string', required: param.required === true, desc: String(param.desc || '') };
      });
      return {
        name: item.name, summary: String(item.summary || item.call).slice(0, 300), params: params,
        effect: ['read', 'write', 'danger'].indexOf(item.effect) >= 0 ? item.effect : 'write',
        scope: ['chat', 'card', 'tavern'].indexOf(item.scope) >= 0 ? item.scope : 'tavern',
        irreversible: item.effect !== 'read',
        run: async function (args) {
          var target = lookup(host, item.call);
          if (typeof target.value !== 'function') throw new Error('找不到函数 ' + item.call + '（插件没加载，或接口改名了）');
          return target.value.apply(target.owner, params.map(function (param) { return args[param.name]; }));
        }
      };
    });
    return {
      id: id, title: String(manifest.title || id).slice(0, 60), summary: String(manifest.summary || '').slice(0, 200), custom: true, manifest: manifest,
      detect: function () { return lookup(host, manifest.detect).value !== undefined; },
      brief: typeof manifest.brief === 'string' ? async function () {
        var target = lookup(host, manifest.brief);
        if (typeof target.value !== 'function') return '';
        var value = await target.value.call(target.owner);
        return typeof value === 'string' ? value : JSON.stringify(value);
      } : null,
      tools: tools
    };
  }

  function builtinConnectors(env, kit) {
    var host = env.host;
    var list = [];

    list.push({
      id: 'tavernhelper', title: '酒馆助手', summary: '提供变量、世界书、正则、脚本、预设等接口；脚本在 script:/，更多函数见 tavern 工具箱',
      detect: function () { return !!host.TavernHelper; }
    });

    list.push({
      id: 'mvu', title: 'MVU 变量框架', summary: '变量在 var:/mvu.json（stat_data）；正文用 <UpdateVariable> 更新',
      detect: function () { return !!(host.Mvu && typeof host.Mvu.getMvuData === 'function'); }, skill: 'mvu'
    });

    list.push({
      id: 'lwb', title: '小白X（LittleWhiteBox）', summary: '变量存在聊天变量里（var:/chat.json）；写入请用 lwb_state_apply，让它的楼层账本与校验保持一致',
      detect: function () { return !!(host.LittleWhiteBox || host.LWB_StateV2); }, skill: 'lwb-variables',
      tools: [{
        name: 'lwb_state_apply', effect: 'write', scope: 'chat', paths: function () { return ['var:/chat.json']; },
        summary: '按小白X「变量 2.0」的 <state> 写法修改变量，例如 <state>数据.角色.金币: +10</state>。会经过它的模板与约束校验。',
        params: [{ name: 'text', type: 'string', required: true, desc: '完整的 <state>…</state> 文本' }],
        run: async function (args) {
          if (!host.LWB_StateV2 || typeof host.LWB_StateV2.applyText !== 'function') throw new Error('小白X 的变量 2.0 接口不可用：请在它的设置里开启「变量管理 2.0 (state)」');
          return host.LWB_StateV2.applyText(String(args.text));
        }
      }, {
        name: 'lwb_schema', effect: 'read', scope: 'chat', summary: '读取小白X 当前的变量模板与约束。', params: [],
        run: async function () {
          if (!host.LWB_StateV2 || typeof host.LWB_StateV2.getInputSchema !== 'function') throw new Error('当前版本的小白X 没有提供模板读取接口');
          return host.LWB_StateV2.getInputSchema();
        }
      }]
    });

    list.push({
      id: 'baibai', title: '柏宝书（记忆）', summary: '按楼层整理的剧情摘要、状态、人物、物品、计划',
      detect: function () { return !!(host.STBaiBaiBook && typeof host.STBaiBaiBook.getSnapshot === 'function'); },
      brief: async function (options) {
        var api = host.STBaiBaiBook, parts = [];
        try {
          var history = api.getInjectedHistory ? api.getInjectedHistory() : api.getHistory({});
          if (history && (history.relativeText || history.text)) parts.push(shorten(history.relativeText || history.text, options.budget));
        } catch (error) { /* 没有摘要 */ }
        try {
          var snapshot = api.getSnapshot();
          var state = snapshot && snapshot.state || {};
          if (state.time || state.location) parts.push('现在：' + [state.time, state.location].filter(Boolean).join('，'));
        } catch (error) { /* ignore */ }
        return parts.join('\n');
      },
      tools: [{
        name: 'baibai_query', effect: 'read', scope: 'chat',
        summary: '查询柏宝书。resource 可选：snapshot（整份状态）、history（某楼之前的剧情摘要）、state、protagonist、npcs、items、plans、scenes、vars、var（需 path）、floor / context（需 floor）。',
        params: [{ name: 'resource', type: 'string', required: true }, { name: 'path', type: 'string', desc: 'resource=var 时的变量路径' }, { name: 'floor', type: 'number', desc: '楼层号（从 0 起）' }, { name: 'at', type: 'string', desc: 'before 或 after' }, { name: 'before', type: 'number', desc: 'history 的截止楼层' }],
        run: async function (args) {
          var query = { resource: args.resource };
          ['path', 'floor', 'at', 'before'].forEach(function (key) { if (args[key] !== undefined) query[key] = args[key]; });
          return host.STBaiBaiBook.query(query);
        }
      }]
    });

    list.push({
      id: 'shujuku', title: '数据库（shujuku / 龙血玄黄）', summary: '表格式记忆：人物、物品、事件等表',
      detect: function () { return !!(host.AutoCardUpdaterAPI && typeof host.AutoCardUpdaterAPI.exportTableAsJson === 'function'); },
      brief: async function (options) {
        var api = host.AutoCardUpdaterAPI;
        try {
          var context = typeof api.getTableHistoryContext === 'function' ? await api.getTableHistoryContext() : '';
          if (typeof context === 'string' && context.trim()) return shorten(context, options.budget);
        } catch (error) { /* fall through */ }
        var tables = await api.exportTableAsJson();
        return shorten(typeof tables === 'string' ? tables : JSON.stringify(tables), options.budget);
      },
      tools: [{
        name: 'shujuku_tables', effect: 'read', scope: 'chat', summary: '导出数据库当前的全部表格（JSON）。', params: [],
        run: async function () { return host.AutoCardUpdaterAPI.exportTableAsJson(); }
      }, {
        name: 'shujuku_update_cell', effect: 'write', scope: 'chat', irreversible: true, summary: '修改一个单元格。',
        params: [{ name: 'table', type: 'string', required: true, desc: '表名' }, { name: 'row', type: 'number', required: true, desc: '行号' }, { name: 'column', type: 'string', required: true, desc: '列名或列号' }, { name: 'value', type: 'string', required: true }],
        run: async function (args) { return host.AutoCardUpdaterAPI.updateCell(args.table, args.row, /^\d+$/.test(args.column) ? Number(args.column) : args.column, args.value); }
      }, {
        name: 'shujuku_insert_row', effect: 'write', scope: 'chat', irreversible: true, summary: '在表里新增一行。',
        params: [{ name: 'table', type: 'string', required: true }, { name: 'data', type: 'json', required: true, desc: '{ 列名: 值 } 或按列顺序的数组' }],
        run: async function (args) { return host.AutoCardUpdaterAPI.insertRow(args.table, args.data); }
      }, {
        name: 'shujuku_delete_row', effect: 'danger', scope: 'chat', irreversible: true, summary: '删除表里的一行。',
        params: [{ name: 'table', type: 'string', required: true }, { name: 'row', type: 'number', required: true }],
        run: async function (args) { return host.AutoCardUpdaterAPI.deleteRow(args.table, args.row); }
      }]
    });

    list.push({
      id: 'ejs', title: '提示词模板（ST-Prompt-Template）', summary: '世界书 / 预设 / 正文里的 <% %> 模板；写之前先读知识 ejs-prompt-template',
      detect: function () { return !!(host.EjsTemplate && typeof host.EjsTemplate.evalTemplate === 'function'); }, skill: 'ejs-prompt-template',
      tools: [{
        name: 'ejs_render', effect: 'write', scope: 'chat', irreversible: true,
        summary: '在当前聊天环境里试渲染一段 EJS 模板，返回渲染结果或报错。模板里的 setvar 等会真的生效，所以算写入。',
        params: [{ name: 'template', type: 'string', required: true }],
        run: async function (args) {
          var api = host.EjsTemplate;
          var context = typeof api.prepareContext === 'function' ? await api.prepareContext() : {};
          return api.evalTemplate(String(args.template), context);
        }
      }]
    });

    list.push({
      id: 'tauritavern', title: 'TauriTavern 宿主', summary: '后端全文检索整段聊天',
      detect: function () { return !!host.__TAURITAVERN__; },
      tools: [{
        name: 'tt_search_chat', effect: 'read', scope: 'chat', summary: '用 TauriTavern 的后端检索当前聊天（长聊天比 grep chat:/ 快）。',
        params: [{ name: 'query', type: 'string', required: true }, { name: 'limit', type: 'number', desc: '默认 20' }],
        run: async function (args) {
          await (host.__TAURITAVERN__.ready || host.__TAURITAVERN_MAIN_READY__);
          var handle = await host.__TAURITAVERN__.api.chat.current.handle();
          var hits = await handle.searchMessages({ query: String(args.query), limit: Math.max(1, Math.min(50, Math.trunc(args.limit || 20))) });
          return (hits || []).map(function (hit) { return { floor: hit.index, role: hit.role, snippet: hit.snippet }; });
        }
      }]
    });

    list.push({
      id: 'yuzuki', title: '柚月の记忆', summary: '已探测到；它没有公开的读取接口，需要的话读 ext:/ 里它的源码再起草对接',
      detect: function () { return !!host.YuzukiMemory; }
    });

    return list;
  }

  /*
   * getCustom() → 用户导入的对接描述数组。refresh() 重新探测并同步工具箱；返回当前可用的对接。
   */
  function installConnectors(registry, env, kit, getCustom) {
    var active = [];

    function all() {
      var output = builtinConnectors(env, kit).concat(registry.connectors());
      (getCustom() || []).forEach(function (manifest) {
        try { output.push(fromManifest(env.host, manifest)); } catch (error) { env.console.warn('[ReaderII] 忽略了无效的插件对接', error); }
      });
      return output;
    }

    function refresh() {
      var next = [];
      all().forEach(function (connector) {
        var present = false;
        try { present = !!connector.detect(); } catch (error) { present = false; }
        registry.unregisterToolset(connector.id);
        if (!present) return;
        next.push(connector);
        if (connector.tools && connector.tools.length) {
          registry.registerToolset({ name: connector.id, summary: connector.title + '：' + connector.summary, source: connector.custom ? 'custom' : 'builtin' });
          connector.tools.forEach(function (tool) { registry.registerTool(Object.assign({}, tool, { toolset: connector.id })); });
        }
      });
      active = next;
      return active;
    }

    /* 剧情察知用：取第一个给得出摘要的记忆类插件。 */
    async function brief(options) {
      for (var index = 0; index < active.length; index += 1) {
        if (typeof active[index].brief !== 'function') continue;
        try {
          var text = await active[index].brief(options || { budget: 1500 });
          if (text && String(text).trim()) return { source: active[index].title, text: String(text).trim() };
        } catch (error) { /* 换下一个 */ }
      }
      return null;
    }

    return { refresh: refresh, active: function () { return active.slice(); }, brief: brief, validate: function (manifest) { return fromManifest(env.host, manifest); } };
  }

  modules.installConnectors = installConnectors;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/skills.js ---- */
(function (root) {
  'use strict';

  /*
   * 知识库：提示词里只列名字与一句话，用到才读正文（skill 工具），参考文件再按需 grep / read（kb:/）。
   *
   * 内置知识的正文是扩展目录里的 knowledge/<名>/SKILL.md；参考文件可以指向上游仓库的原始文档
   * （例如提示词模板的语法手册，许可证与本仓库不同，所以不随仓库分发，按需拉取并缓存七天）。
   * 用户与助手自己写的知识放在工作区 ws:/skills/<名>/SKILL.md，启动时登记。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var CACHE_MS = 7 * 86400000;
  var FALLBACK_BASE = 'https://cdn.jsdelivr.net/gh/Adirm007/reader-II@main/';

  var BUILTIN = [
    { name: 'tavern-anatomy', summary: '酒馆里各样东西在哪：角色卡、世界书、正则、酒馆助手脚本、预设、变量各自的路径与写法要点' },
    { name: 'debugging', summary: '排查「爆红 / 不渲染 / 变量不更新 / 脚本没反应」的固定步骤' },
    { name: 'ejs-prompt-template', summary: '写与排查酒馆 EJS（提示词模板 ST-Prompt-Template 的 <% %> 语法）', files: {
      'reference.md': 'https://cdn.jsdelivr.net/gh/zonde306/ST-Prompt-Template@main/docs/reference_cn.md',
      'features.md': 'https://cdn.jsdelivr.net/gh/zonde306/ST-Prompt-Template@main/docs/features_cn.md'
    } },
    { name: 'mvu', summary: 'MVU 变量框架：stat_data 结构、<UpdateVariable> 更新、初始化与常见故障' },
    { name: 'lwb-variables', summary: '小白X 的变量：存放位置、<state> 写法、模板与约束' },
    { name: 'card-workflow', summary: '制卡工作流：从设定到角色卡、世界书、开场白，再在当前酒馆里试跑；也说明怎么自定义工作流' },
    { name: 'connector-authoring', summary: '给没有预置对接的插件写对接：找接口、起草 connector.json、试调、启用' },
    { name: 'reader-ii', summary: 'Reader-II 自己：FP、语义槽、轻信、大厅、抽卡各是什么，出问题看哪里' }
  ];

  function parseFrontmatter(text) {
    var source = String(text || '');
    var match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    var meta = {};
    if (match) {
      match[1].split(/\r?\n/).forEach(function (line) {
        var pair = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
        if (pair) meta[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
      });
    }
    return { meta: meta, body: match ? source.slice(match[0].length) : source };
  }

  function installSkills(registry, vfs, env, store) {
    function base() {
      var configured = '';
      try { configured = env.host.__ReaderIIBase || ''; } catch (error) { configured = ''; }
      return String(configured || FALLBACK_BASE).replace(/\/?$/, '/');
    }

    async function fetchText(url, cacheKey) {
      if (cacheKey) {
        var cached = await store.get('kv', cacheKey);
        if (cached && Date.now() - cached.at < CACHE_MS) return cached.text;
      }
      var response = await env.host.fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error('读取失败（HTTP ' + response.status + '）：' + url);
      var text = await response.text();
      if (cacheKey) await store.put('kv', cacheKey, { at: Date.now(), text: text });
      return text;
    }

    BUILTIN.forEach(function (item) {
      registry.registerSkill({
        name: item.name, summary: item.summary, files: item.files || null, source: 'builtin',
        load: async function () { return parseFrontmatter(await fetchText(base() + 'knowledge/' + item.name + '/SKILL.md')).body; }
      });
    });

    /* 工作区里的知识：ws:/skills/<名>/SKILL.md，frontmatter 里的 description 作为一句话说明。 */
    async function loadUserSkills() {
      var listing;
      try { listing = await vfs.list('ws:/skills', { offset: 0, limit: 200 }); } catch (error) { return 0; }
      var count = 0;
      for (var index = 0; index < listing.items.length; index += 1) {
        var name = listing.items[index].name;
        if (!listing.items[index].dir || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(name)) continue;
        var text = await vfs.readText('ws:/skills/' + name + '/SKILL.md').catch(function () { return null; });
        if (text === null) continue;
        var parsed = parseFrontmatter(text);
        registry.registerSkill({ name: name, summary: parsed.meta.description || parsed.body.trim().split('\n')[0].slice(0, 120), body: parsed.body, source: 'user' });
        count += 1;
      }
      return count;
    }

    vfs.mount({
      id: 'kb', title: '知识库的参考文件（只读）', hint: 'kb:/<知识名>/…；先用 skill 读正文', readonly: true,
      scope: function () { return 'workspace'; },
      list: function (segs) {
        if (!segs.length) return registry.skills().map(function (skill) { return { name: skill.name, dir: true, note: skill.summary }; });
        var skill = registry.skills().filter(function (item) { return item.name === segs[0]; })[0];
        if (!skill) return [];
        return [{ name: 'SKILL.md' }].concat(Object.keys(skill.files || {}).map(function (file) { return { name: file, note: '参考文件，首次读取时联网获取' }; }));
      },
      read: async function (segs) {
        if (segs.length < 2) return null;
        var skill = await registry.loadSkill(segs[0]);
        if (!skill) return null;
        if (segs[1] === 'SKILL.md') return String(skill.body || '');
        var url = skill.files && skill.files[segs[1]];
        return url ? fetchText(url, 'kb:' + segs[0] + '/' + segs[1]) : null;
      }
    });

    return { loadUserSkills: loadUserSkills, builtin: BUILTIN.map(function (item) { return item.name; }) };
  }

  modules.parseSkillFrontmatter = parseFrontmatter;
  modules.installSkills = installSkills;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/legacy-tools.js ---- */
(function (root) {
  'use strict';

  /*
   * 夜梦助手的工具集。
   *
   * 每个工具：{ name, tier, summary, params: [{ name, type, required, desc }], run(args, ctx) }
   * tier：
   *   read    只读，直接执行；
   *   memory  助手自己的记事本（记忆的增改、整理），除“只读模式”外直接执行；
   *   write   改动卡内数据，按写入策略需要用户点头；
   *   danger  难以恢复的操作，始终需要用户点头，且要在设置里放开。
   * 读取类工具都带分页 / 上限参数：结果过长时返回开头并说明如何继续读，而不是把整本书塞进上下文。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var DANGER_API = /^(?:delete|uninstall|replace(?:Variables|TavernRegexes|Worldbook|Preset|ScriptTrees|Scripts)|createOrReplace)/;
  var WRITE_API = /^(?:create|replace|update|delete|insert|set|load|rename|rebind|install|uninstall|reinstall|inject|uninject|trigger|register|unregister|rotate|append|import|play|pause|stop|save|add|remove|refresh|reload|generate|builtin|toggle|switch|format|substitudeMacros)/;
  var SLOT_LABELS = {
    location: '当前地点', characters: '重要角色', tasks: '任务', skills: '用户技能',
    statuses: '用户当前状态', currency: '货币（Reader FP）', inventory: '背包'
  };

  function text(value, limit) {
    var output = String(value == null ? '' : value);
    return limit && output.length > limit ? output.slice(0, limit) + '…（共 ' + output.length + ' 字）' : output;
  }

  function int(value, fallback, minimum, maximum) {
    var number = Math.trunc(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
  }

  function splitPath(path) {
    var output = [];
    String(path || '').replace(/\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|([^.\[\]]+)/g, function (match, index, quoted, plain) {
      if (index !== undefined) output.push(Number(index));
      else if (quoted !== undefined) output.push(quoted.replace(/\\(.)/g, '$1'));
      else output.push(plain);
      return match;
    });
    return output;
  }

  function safeSegments(segments) {
    return segments.every(function (segment) {
      return typeof segment === 'number' || (segment !== '__proto__' && segment !== 'prototype' && segment !== 'constructor');
    });
  }

  function readPath(value, segments) {
    var cursor = value;
    for (var index = 0; index < segments.length; index += 1) {
      if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, segments[index])) return undefined;
      cursor = cursor[segments[index]];
    }
    return cursor;
  }

  function writePath(target, segments, value) {
    var cursor = target;
    for (var index = 0; index < segments.length - 1; index += 1) {
      var key = segments[index];
      if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = typeof segments[index + 1] === 'number' ? [] : {};
      cursor = cursor[key];
    }
    cursor[segments[segments.length - 1]] = value;
  }

  function deletePath(target, segments) {
    var parent = readPath(target, segments.slice(0, -1));
    var key = segments[segments.length - 1];
    if (!parent || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, key)) return false;
    if (Array.isArray(parent) && typeof key === 'number') parent.splice(key, 1);
    else delete parent[key];
    return true;
  }

  function createAgentTools(env, kit, deps) {
    var api = function () { return deps.core ? deps.core() : null; };
    var memory = deps.memory;
    var skills = [];

    function core() {
      var value = api();
      if (!value) throw new Error('Reader-II 主系统尚未就绪');
      return value;
    }

    function helper() {
      try { return env.host && env.host.TavernHelper || root.TavernHelper || null; } catch (error) { return null; }
    }

    function entrySummary(entry) {
      var strategy = entry.strategy || {};
      return {
        uid: entry.uid,
        name: String(entry.name || ''),
        enabled: entry.enabled !== false,
        mode: strategy.type === 'constant' ? '常驻' : strategy.type === 'vectorized' ? '向量' : '关键词',
        keys: (Array.isArray(strategy.keys) ? strategy.keys : []).map(String).slice(0, 12),
        length: String(entry.content || '').length
      };
    }

    function requireBook(args) {
      var book = String(args.book || '').trim();
      if (!book) throw new Error('需要 book（世界书名）');
      var names = kit.worldbookNames();
      if (names.length && names.indexOf(book) < 0) {
        var loose = names.filter(function (name) { return name.indexOf(book) >= 0 || book.indexOf(name) >= 0; });
        if (loose.length === 1) return loose[0];
        throw new Error('没有名为「' + book + '」的世界书。现有：' + names.slice(0, 40).join('、'));
      }
      return book;
    }

    var tools = [];
    function tool(definition) { tools.push(definition); }

    /* ---------- 总览 ---------- */
    tool({
      name: 'reader_state', tier: 'read',
      summary: '查看 Reader-II 的当前状态：七个语义槽各自绑定到哪里、地点、FP 余额、主角状态与技能、任务、重要角色、背包、当前人格。',
      params: [],
      run: async function () {
        var reader = core();
        var output = { routing: {} };
        var routing = reader.getSemanticRouting();
        Object.keys(routing).forEach(function (slot) {
          var route = routing[slot];
          output.routing[slot] = {
            label: SLOT_LABELS[slot] || slot,
            status: route.status,
            target: route.status === 'active' ? modules.readerHostDisplayPath(route.rootRef) : route.status === 'broken' ? '已损坏：' + route.brokenReason : 'Reader 后备变量'
          };
        });
        var read = async function (key, getter) {
          try { output[key] = await getter(); } catch (error) { output[key] = '读取失败：' + String(error && error.message || error).slice(0, 120); }
        };
        await read('location', function () { return reader.getLocation(); });
        await read('fp', function () { return reader.getFpBalance(); });
        await read('statuses', function () { return reader.listStatuses(); });
        await read('tasks', function () { return reader.listTaskNames(); });
        await read('characters', async function () {
          return (await reader.listImportantCharacters()).map(function (item) {
            return { name: item.name, favor: item.favor, present: item.present, identity: item.identity };
          }).slice(0, 60);
        });
        if (typeof reader.listInventory === 'function') await read('inventory', async function () {
          return (await reader.listInventory()).map(function (item) { return { name: item.name, count: item.count, quality: item.quality, type: item.type }; }).slice(0, 80);
        });
        var names = kit.names();
        output.card = names.char;
        output.user = names.user;
        output.persona = kit.readChatValue('dream_persona') || 'reader';
        return output;
      }
    });

    /* ---------- 聊天 ---------- */
    tool({
      name: 'chat_read', tier: 'read',
      summary: '读取正文聊天的楼层。默认读最近 6 楼；也可指定 from / to（楼层号，含 from 不含 to）。',
      params: [
        { name: 'last', type: 'number', desc: '读最近几楼（默认 6，最多 40）' },
        { name: 'from', type: 'number', desc: '起始楼层号' },
        { name: 'to', type: 'number', desc: '结束楼层号（不含）' },
        { name: 'max_chars', type: 'number', desc: '每楼最多返回多少字（默认 1200）' }
      ],
      run: async function (args) {
        var length = kit.chatLength();
        var from, to;
        if (args.from !== undefined || args.to !== undefined) {
          from = int(args.from, 0, 0, length);
          to = int(args.to, Math.min(length, from + 6), from, length);
          if (to - from > 40) to = from + 40;
        } else {
          to = length;
          from = Math.max(0, length - int(args.last, 6, 1, 40));
        }
        var cap = int(args.max_chars, 1200, 100, 20000);
        return {
          total_messages: length,
          messages: kit.readChat(from, to).map(function (message) {
            return { id: message.id, role: message.role, name: message.name, text: text(kit.cleanText(message.text), cap) };
          })
        };
      }
    });

    tool({
      name: 'chat_search', tier: 'read',
      summary: '在整个正文聊天里按字面搜索，返回命中的楼层与上下文片段。',
      params: [
        { name: 'query', type: 'string', required: true, desc: '要找的词或短句' },
        { name: 'limit', type: 'number', desc: '最多返回几条（默认 8）' }
      ],
      run: async function (args) {
        var query = String(args.query || '').trim().toLowerCase();
        if (!query) throw new Error('需要 query');
        var limit = int(args.limit, 8, 1, 30);
        var hits = [];
        var messages = kit.readChat(0, kit.chatLength());
        for (var index = messages.length - 1; index >= 0 && hits.length < limit; index -= 1) {
          var clean = kit.cleanText(messages[index].text);
          var at = clean.toLowerCase().indexOf(query);
          if (at < 0) continue;
          hits.push({ id: messages[index].id, role: messages[index].role, name: messages[index].name, snippet: clean.slice(Math.max(0, at - 80), at + query.length + 160) });
        }
        return { query: args.query, hits: hits, note: hits.length ? '' : '没有命中；可以换个词，或用 chat_read 直接翻看' };
      }
    });

    /* ---------- 变量 ---------- */
    tool({
      name: 'variables_read', tier: 'read',
      summary: '读取酒馆变量。scope：message（最新楼层变量，MVU 的 stat_data 在这里）、chat（聊天变量）、global、character。可给 path 只取一部分。',
      params: [
        { name: 'scope', type: 'string', desc: 'message | chat | global | character，默认 message' },
        { name: 'path', type: 'string', desc: '点号路径，如 stat_data.主角；留空返回顶层键' },
        { name: 'depth', type: 'number', desc: '展开层数（默认 3）' }
      ],
      run: async function (args) {
        var scope = ['message', 'chat', 'global', 'character'].indexOf(args.scope) >= 0 ? args.scope : 'message';
        var option = scope === 'message' ? { type: 'message', message_id: 'latest' } : { type: scope };
        var variables = kit.need('getVariables')(option) || {};
        var segments = splitPath(args.path);
        var value = segments.length ? readPath(variables, segments) : variables;
        if (value === undefined) return { scope: scope, path: args.path || '', exists: false, top_keys: Object.keys(variables).slice(0, 80) };
        return { scope: scope, path: args.path || '', exists: true, value: modules.readerOutlineValue(value, 0, int(args.depth, 3, 1, 8)) };
      }
    });

    tool({
      name: 'variables_write', tier: 'write',
      summary: '写入或删除一个酒馆变量。宿主 MVU 变量（stat_data 之下）请改用 host_write，它带类型检查。',
      params: [
        { name: 'scope', type: 'string', required: true, desc: 'message | chat | global | character' },
        { name: 'path', type: 'string', required: true, desc: '点号路径' },
        { name: 'value', type: 'json', desc: '要写入的值（JSON）；op=delete 时不需要' },
        { name: 'op', type: 'string', desc: 'set（默认）或 delete' }
      ],
      describe: function (args) { return (args.op === 'delete' ? '删除' : '写入') + ' ' + (args.scope || '') + ' 变量 ' + (args.path || ''); },
      run: async function (args) {
        var scope = ['message', 'chat', 'global', 'character'].indexOf(args.scope) >= 0 ? args.scope : '';
        if (!scope) throw new Error('scope 只能是 message / chat / global / character');
        var segments = splitPath(args.path);
        if (!segments.length || !safeSegments(segments)) throw new Error('path 无效');
        if (/^reader_ii_/.test(String(segments[0]))) throw new Error('reader_ii_ 开头的是 Reader-II 的内部状态，不能直接改写');
        var remove = args.op === 'delete';
        if (!remove && args.value === undefined) throw new Error('需要 value');
        var option = scope === 'message' ? { type: 'message', message_id: 'latest' } : { type: scope };
        var changed = false;
        await kit.need('updateVariablesWith')(function (variables) {
          var next = variables && typeof variables === 'object' ? variables : {};
          if (remove) changed = deletePath(next, segments);
          else { writePath(next, segments, modules.clone(args.value)); changed = true; }
          return next;
        }, option);
        var verify = readPath(kit.need('getVariables')(option) || {}, segments);
        return { ok: true, changed: changed, now: remove ? (verify === undefined ? '已不存在' : '仍然存在') : modules.readerOutlineValue(verify, 0, 2) };
      }
    });

    tool({
      name: 'host_tree', tier: 'read',
      summary: '浏览宿主角色卡的 MVU 变量（stat_data）。留空看顶层结构；给 path 看某个分支。',
      params: [
        { name: 'path', type: 'string', desc: 'stat_data 之下的点号路径，如 主角.背包' },
        { name: 'depth', type: 'number', desc: '展开层数（默认 3）' }
      ],
      run: async function (args) {
        var snapshot = await core().getSnapshot();
        var stat = snapshot && snapshot.stat_data || {};
        var segments = splitPath(String(args.path || '').replace(/^stat_data\.?/, ''));
        var value = segments.length ? readPath(stat, segments) : stat;
        if (value === undefined) return { exists: false, top_keys: Object.keys(stat) };
        return { path: 'stat_data' + (segments.length ? '.' + segments.join('.') : ''), value: modules.readerOutlineValue(value, 0, int(args.depth, 3, 1, 8)) };
      }
    });

    tool({
      name: 'host_write', tier: 'write',
      summary: '改写一个宿主 MVU 变量（带类型检查）。op：set 设为、delta 数值增减、toggle 真假切换、merge 合并对象字段、append 向数组追加、remove_value 从数组移除、remove 删除该字段。',
      params: [
        { name: 'path', type: 'string', required: true, desc: '完整路径，如 stat_data.主角.金币' },
        { name: 'op', type: 'string', required: true, desc: 'set | delta | toggle | merge | append | remove_value | remove' },
        { name: 'value', type: 'json', desc: '操作数（JSON）' }
      ],
      describe: function (args) { return '宿主变量 ' + (args.path || '') + ' 执行 ' + (args.op || 'set') + (args.value !== undefined ? ' ' + text(JSON.stringify(args.value), 120) : ''); },
      run: async function (args) {
        var path = String(args.path || '').trim();
        if (path.indexOf('stat_data') !== 0) path = 'stat_data.' + path;
        var segments = splitPath(path);
        if (segments.length < 2 || !safeSegments(segments)) throw new Error('path 无效');
        if (segments[1] === 'READER') throw new Error('READER 之下是 Reader 的后备变量：FP 用 fp_adjust，状态用 status_add');
        var result = await core().writeHostRef(segments, String(args.op || 'set'), args.value);
        return { ok: true, path: path, now: modules.readerOutlineValue(result, 0, 2) };
      }
    });

    /* ---------- Reader 语义层 ---------- */
    tool({
      name: 'fp_adjust', tier: 'write',
      summary: '增减命运点数（Reader FP；绑定了宿主货币时改的就是宿主货币）。amount 为正是发放，为负是扣除。',
      params: [
        { name: 'amount', type: 'number', required: true, desc: '变动量（非零整数）' },
        { name: 'reason', type: 'string', desc: '原因备注' }
      ],
      describe: function (args) { return (Number(args.amount) >= 0 ? '发放 ' : '扣除 ') + Math.abs(Math.trunc(Number(args.amount) || 0)) + ' FP' + (args.reason ? '（' + args.reason + '）' : ''); },
      run: async function (args) {
        var amount = Math.trunc(Number(args.amount));
        if (!Number.isFinite(amount) || amount === 0) throw new Error('amount 必须是非零整数');
        var reason = 'agent:' + text(args.reason || 'adjust', 60);
        var result = amount > 0 ? await core().creditFp(amount, reason) : await core().spendFp(Math.abs(amount), reason);
        return { ok: true, balance: result.balance };
      }
    });

    tool({
      name: 'status_add', tier: 'write',
      summary: '给主角添加一个状态效果（已有同名状态时不重复添加）。',
      params: [
        { name: 'name', type: 'string', required: true, desc: '状态名' },
        { name: 'effect', type: 'string', required: true, desc: '效果描述' },
        { name: 'duration', type: 'string', required: true, desc: '持续时间，如 “3天”“永久”' },
        { name: 'source', type: 'string', desc: '来源' }
      ],
      describe: function (args) { return '添加状态「' + (args.name || '') + '」：' + text(args.effect, 80); },
      run: async function (args) {
        var result = await core().insertStatusIfAbsent({ name: String(args.name || ''), effect: String(args.effect || ''), duration: String(args.duration || ''), source: String(args.source || '九十九夜梦') });
        return { ok: true, inserted: result.inserted === true, note: result.inserted ? '' : '已有同名状态，没有重复添加' };
      }
    });

    tool({
      name: 'adapt_variables', tier: 'write',
      summary: '一键适配：自动把这张卡的 MVU 变量接到 Reader-II 的七个语义槽（地点、重要角色、任务、技能、状态、货币、背包）。已启用的槽位不动；逐槽返回绑定到哪条路径或为什么没绑上。',
      params: [
        { name: 'use_llm', type: 'boolean', desc: '是否用一次模型调用做语义寻路（默认 true；false 只用结构启发式）' },
        { name: 'slots', type: 'json', desc: '只适配这些槽位（数组，可省略）' }
      ],
      describe: function () { return '自动寻找宿主变量并绑定语义槽（已启用的保持不变）'; },
      run: async function (args, ctx) {
        var reader = core();
        if (typeof reader.autoAdapt !== 'function') throw new Error('当前主系统版本不支持一键适配，请在 Reader Core 面板手动绑定');
        return reader.autoAdapt({ useLlm: args.use_llm !== false, slots: Array.isArray(args.slots) ? args.slots : undefined, signal: ctx && ctx.signal });
      }
    });

    tool({
      name: 'unbind_slot', tier: 'write',
      summary: '解除一个语义槽的宿主绑定，改回 Reader 后备变量。',
      params: [{ name: 'slot', type: 'string', required: true, desc: 'location | characters | tasks | skills | statuses | currency | inventory' }],
      describe: function (args) { return '解除「' + (SLOT_LABELS[args.slot] || args.slot) + '」的宿主绑定'; },
      run: async function (args) {
        var route = await core().unbindSemanticSlot(String(args.slot || ''));
        return { ok: true, status: route.status };
      }
    });

    /* ---------- 世界书 ---------- */
    tool({
      name: 'worldbook_list', tier: 'read',
      summary: '列出世界书：全部书名，以及哪些是全局启用、当前角色卡绑定、当前聊天绑定的。',
      params: [],
      run: async function () { return kit.worldbookScopes(); }
    });

    tool({
      name: 'worldbook_entries', tier: 'read',
      summary: '列出一本世界书的条目（名称、是否启用、触发方式、关键词、长度）。改动前先用它确认真实条目名。',
      params: [
        { name: 'book', type: 'string', required: true, desc: '世界书名' },
        { name: 'filter', type: 'string', desc: '只列名称或关键词里含这个词的条目' },
        { name: 'offset', type: 'number', desc: '从第几条开始（默认 0）' },
        { name: 'limit', type: 'number', desc: '最多列几条（默认 60）' }
      ],
      run: async function (args) {
        var book = requireBook(args);
        var entries = await kit.readWorldbook(book);
        var filter = String(args.filter || '').trim().toLowerCase();
        var matched = entries.map(entrySummary).filter(function (entry) {
          return !filter || (entry.name + ' ' + entry.keys.join(' ')).toLowerCase().indexOf(filter) >= 0;
        });
        var offset = int(args.offset, 0, 0, matched.length);
        var limit = int(args.limit, 60, 1, 200);
        return { book: book, total: matched.length, offset: offset, entries: matched.slice(offset, offset + limit), more: offset + limit < matched.length ? '还有 ' + (matched.length - offset - limit) + ' 条，增大 offset 继续' : '' };
      }
    });

    tool({
      name: 'worldbook_read', tier: 'read',
      summary: '读取一个世界书条目的全文与设置。条目很长时用 offset 分段读。',
      params: [
        { name: 'book', type: 'string', required: true, desc: '世界书名' },
        { name: 'entry', type: 'string', required: true, desc: '条目名（可只写一部分）或 uid' },
        { name: 'offset', type: 'number', desc: '从正文第几个字开始（默认 0）' },
        { name: 'max_chars', type: 'number', desc: '最多返回多少字（默认 6000）' }
      ],
      run: async function (args) {
        var book = requireBook(args);
        var entries = await kit.readWorldbook(book);
        var entry = kit.findEntry(entries, args.entry);
        if (!entry) return { found: false, note: '没有这个条目', similar: entries.map(function (item) { return String(item.name || ''); }).filter(Boolean).slice(0, 40) };
        var content = String(entry.content || '');
        var offset = int(args.offset, 0, 0, content.length);
        var cap = int(args.max_chars, 6000, 200, 60000);
        var summary = entrySummary(entry);
        summary.position = entry.position;
        summary.probability = entry.probability;
        return { found: true, book: book, entry: summary, offset: offset, content: content.slice(offset, offset + cap), more: offset + cap < content.length ? '正文共 ' + content.length + ' 字，offset=' + (offset + cap) + ' 继续读' : '' };
      }
    });

    tool({
      name: 'worldbook_search', tier: 'read',
      summary: '在世界书正文里按字面搜索。不给 books 时搜索当前生效的书（全局 + 角色卡 + 聊天）。',
      params: [
        { name: 'query', type: 'string', required: true, desc: '要找的词' },
        { name: 'books', type: 'json', desc: '要搜索的书名数组（可省略）' },
        { name: 'limit', type: 'number', desc: '最多返回几条（默认 10）' }
      ],
      run: async function (args) {
        var query = String(args.query || '').trim().toLowerCase();
        if (!query) throw new Error('需要 query');
        var scopes = kit.worldbookScopes();
        var books = Array.isArray(args.books) && args.books.length ? args.books.map(String)
          : scopes.global.concat(scopes.character_primary ? [scopes.character_primary] : [], scopes.character_additional, scopes.chat ? [scopes.chat] : []);
        var seen = Object.create(null);
        var limit = int(args.limit, 10, 1, 40);
        var hits = [];
        for (var index = 0; index < books.length && hits.length < limit; index += 1) {
          var name = books[index];
          if (seen[name]) continue;
          seen[name] = true;
          var entries;
          try { entries = await kit.readWorldbook(name); } catch (error) { continue; }
          for (var entryIndex = 0; entryIndex < entries.length && hits.length < limit; entryIndex += 1) {
            var entry = entries[entryIndex];
            var haystack = String(entry.name || '') + '\n' + String(entry.content || '');
            var at = haystack.toLowerCase().indexOf(query);
            if (at < 0) continue;
            hits.push({ book: name, entry: String(entry.name || ''), uid: entry.uid, snippet: haystack.slice(Math.max(0, at - 60), at + query.length + 140) });
          }
        }
        return { query: args.query, searched: Object.keys(seen), hits: hits };
      }
    });

    tool({
      name: 'worldbook_write', tier: 'write',
      summary: '新建或修改一个世界书条目。条目已存在则只改你给出的字段；不存在则新建（需要 content）。append 是在原文末尾追加而不是替换。写完会回读确认。',
      params: [
        { name: 'book', type: 'string', required: true, desc: '世界书名' },
        { name: 'entry', type: 'string', required: true, desc: '条目名（修改已有条目时可只写一部分）' },
        { name: 'content', type: 'string', desc: '条目全文（替换原文）' },
        { name: 'append', type: 'string', desc: '追加到原文末尾的内容（与 content 二选一）' },
        { name: 'keys', type: 'json', desc: '关键词数组' },
        { name: 'constant', type: 'boolean', desc: 'true=常驻（蓝灯），false=关键词触发（绿灯）' },
        { name: 'enabled', type: 'boolean', desc: '是否启用' },
        { name: 'depth', type: 'number', desc: '设为按深度插入时的深度' },
        { name: 'order', type: 'number', desc: '插入顺序' },
        { name: 'rename', type: 'string', desc: '改名为' }
      ],
      describe: function (args) {
        return '世界书《' + (args.book || '') + '》条目「' + (args.entry || '') + '」：' + (args.content !== undefined ? '写入全文 ' + String(args.content).length + ' 字' : args.append !== undefined ? '追加 ' + String(args.append).length + ' 字' : '修改设置');
      },
      run: async function (args) {
        var book = requireBook(args);
        var target = String(args.entry || '').trim();
        if (!target) throw new Error('需要 entry（条目名）');
        var existing = kit.findEntry(await kit.readWorldbook(book), target);
        var apply = function (entry) {
          if (typeof args.content === 'string') entry.content = args.content;
          else if (typeof args.append === 'string') entry.content = String(entry.content || '') + (entry.content ? '\n' : '') + args.append;
          if (typeof args.enabled === 'boolean') entry.enabled = args.enabled;
          if (typeof args.rename === 'string' && args.rename.trim()) entry.name = args.rename.trim();
          entry.strategy = modules.isObject(entry.strategy) ? entry.strategy : { type: 'selective', keys: [] };
          if (Array.isArray(args.keys)) entry.strategy.keys = args.keys.map(String).filter(Boolean);
          if (typeof args.constant === 'boolean') entry.strategy.type = args.constant ? 'constant' : 'selective';
          if (args.depth !== undefined || args.order !== undefined) {
            entry.position = modules.isObject(entry.position) ? entry.position : { type: 'at_depth', role: 'system', depth: 4, order: 100 };
            if (args.depth !== undefined) { entry.position.type = 'at_depth'; entry.position.depth = int(args.depth, 4, 0, 999); if (!entry.position.role) entry.position.role = 'system'; }
            if (args.order !== undefined) entry.position.order = int(args.order, 100, -10000, 100000);
          }
          return entry;
        };
        var finalName;
        if (existing) {
          var uid = existing.uid;
          await kit.updateWorldbook(book, function (entries) {
            entries.forEach(function (entry) { if (entry.uid === uid) apply(entry); });
            return entries;
          });
          finalName = typeof args.rename === 'string' && args.rename.trim() ? args.rename.trim() : String(existing.name || '');
        } else {
          if (typeof args.content !== 'string' && typeof args.append !== 'string') throw new Error('没有名为「' + target + '」的条目；新建条目需要 content');
          var made = await kit.addWorldbookEntries(book, [apply({ name: target, content: '', enabled: true, strategy: { type: 'selective', keys: [] } })]);
          finalName = String(made[0] && made[0].name || target);
        }
        /* 回读确认：读得到才算写成功。 */
        var verify = kit.findEntry(await kit.readWorldbook(book), finalName);
        if (!verify) throw new Error('写入后回读不到条目「' + finalName + '」，写入可能没有生效');
        return { ok: true, action: existing ? 'updated' : 'created', book: book, entry: entrySummary(verify), verified: true };
      }
    });

    tool({
      name: 'worldbook_delete_entry', tier: 'danger',
      summary: '删除一个世界书条目（不可恢复）。删除前先用 worldbook_read 确认内容。',
      params: [
        { name: 'book', type: 'string', required: true, desc: '世界书名' },
        { name: 'entry', type: 'string', required: true, desc: '条目的完整名称或 uid' }
      ],
      describe: function (args) { return '删除世界书《' + (args.book || '') + '》的条目「' + (args.entry || '') + '」（不可恢复）'; },
      run: async function (args) {
        var book = requireBook(args);
        var entries = await kit.readWorldbook(book);
        var target = String(args.entry || '').trim();
        var exact = entries.filter(function (entry) { return String(entry.name || '') === target || String(entry.uid) === target; });
        if (exact.length !== 1) throw new Error(exact.length ? '有 ' + exact.length + ' 个同名条目，请改用 uid 指定' : '删除需要完整的条目名或 uid；没有找到「' + target + '」');
        var uid = exact[0].uid;
        await kit.updateWorldbook(book, function (list) { return list.filter(function (entry) { return entry.uid !== uid; }); });
        var left = (await kit.readWorldbook(book)).some(function (entry) { return entry.uid === uid; });
        if (left) throw new Error('删除后条目仍然存在');
        return { ok: true, deleted: String(exact[0].name || ''), book: book };
      }
    });

    tool({
      name: 'worldbook_create', tier: 'write',
      summary: '新建一本空世界书，并按 mount 决定是否挂载。',
      params: [
        { name: 'name', type: 'string', required: true, desc: '世界书名' },
        { name: 'mount', type: 'string', desc: 'global 全局启用 | character 绑到当前角色卡 | none 只创建（默认）' }
      ],
      describe: function (args) { return '新建世界书《' + (args.name || '') + '》' + (args.mount && args.mount !== 'none' ? '并挂载到 ' + args.mount : ''); },
      run: async function (args) {
        var name = String(args.name || '').trim();
        if (!name) throw new Error('需要 name');
        var created = await kit.createWorldbook(name);
        var mount = ['global', 'character'].indexOf(args.mount) >= 0 ? args.mount : 'none';
        if (mount !== 'none') await kit.mountWorldbook(name, mount);
        return { ok: true, name: name, created: created, note: created ? '' : '同名世界书已存在，没有重复创建', mounted: mount };
      }
    });

    /* ---------- 记忆 ---------- */
    var memoryView = function (record, full) {
      return {
        id: record.id, type: record.type, title: record.title,
        content: full ? record.content : text(record.content, 160),
        keys: record.keys, importance: record.importance, pinned: record.pinned,
        store: record.store === 'ocean' ? '夜之洋' : '当前聊天', owner: record.owner === 'agent' ? 'agent 助手自己的' : 'story 正文的', score: record.score
      };
    };

    tool({
      name: 'memory_search', tier: 'read',
      summary: '在记忆库里检索与一句话相关的记忆（当前聊天的记忆与《夜之洋》一起找）。用户问“还记得吗 / 上次 / 之前”时先用它。',
      params: [
        { name: 'query', type: 'string', required: true, desc: '检索词或短句' },
        { name: 'limit', type: 'number', desc: '最多返回几条（默认 6）' },
        { name: 'type', type: 'string', desc: '只找某一类：episode 剧情 | fact 设定 | bond 情感 | howto 功能' }
      ],
      run: async function (args) {
        var hits = await memory.search(String(args.query || ''), { limit: int(args.limit, 6, 1, 20), type: args.type || undefined });
        return { query: args.query, hits: hits.map(function (record) { return memoryView(record, true); }), note: hits.length ? '' : '没有相关记忆' };
      }
    });

    tool({
      name: 'memory_list', tier: 'read',
      summary: '列出记忆（最近更新的在前）。',
      params: [
        { name: 'type', type: 'string', desc: 'episode | fact | bond | howto' },
        { name: 'store', type: 'string', desc: 'chat 当前聊天 | ocean 夜之洋；留空两边都列' },
        { name: 'limit', type: 'number', desc: '最多列几条（默认 30）' }
      ],
      run: async function (args) {
        var all = await memory.list({ type: args.type || undefined, store: args.store === 'chat' || args.store === 'ocean' ? args.store : undefined });
        var limit = int(args.limit, 30, 1, 200);
        return { total: all.length, memories: all.slice(0, limit).map(function (record) { return memoryView(record, false); }) };
      }
    });

    tool({
      name: 'memory_save', tier: 'memory',
      summary: '记下一条记忆。type：episode 剧情 / fact 设定 / bond 情感 / howto 功能。store 留空就写到用户选定的位置；用户明确说“记到夜之洋 / 跨存档”用 ocean，说“只记在这个聊天”用 chat。owner 默认 agent（你自己的经历、用户偏好、做法，正文里的夜梦默认想不起来）；用户要你记的是剧情或设定、要正文也记得时用 story。',
      params: [
        { name: 'type', type: 'string', required: true, desc: 'episode | fact | bond | howto' },
        { name: 'title', type: 'string', required: true, desc: '不超过 18 字的标题' },
        { name: 'content', type: 'string', required: true, desc: '独立成文的正文（40～220 字为宜）' },
        { name: 'keys', type: 'json', desc: '2～5 个触发词（数组）' },
        { name: 'importance', type: 'number', desc: '1～5' },
        { name: 'store', type: 'string', desc: 'chat | ocean（可省略）' },
        { name: 'pinned', type: 'boolean', desc: 'true=常驻，每轮都带上' },
        { name: 'owner', type: 'string', desc: 'agent（默认）| story' }
      ],
      run: async function (args) {
        var record = await memory.add({ type: args.type, title: args.title, content: args.content, keys: args.keys, importance: args.importance, pinned: args.pinned === true, source: 'agent', owner: args.owner === 'story' ? 'story' : 'agent' },
          { store: args.store === 'ocean' || args.store === 'chat' ? args.store : undefined });
        return { ok: true, memory: memoryView(record, false) };
      }
    });

    tool({
      name: 'memory_update', tier: 'memory',
      summary: '修改一条已有记忆（给 id；只改你给出的字段）。',
      params: [
        { name: 'id', type: 'string', required: true, desc: '记忆 id（memory_search / memory_list 返回的）' },
        { name: 'title', type: 'string', desc: '新标题' },
        { name: 'content', type: 'string', desc: '新的完整正文' },
        { name: 'keys', type: 'json', desc: '新的触发词数组' },
        { name: 'importance', type: 'number', desc: '1～5' },
        { name: 'pinned', type: 'boolean', desc: '是否常驻' },
        { name: 'owner', type: 'string', desc: 'agent | story（改归属）' }
      ],
      run: async function (args) {
        var patch = {};
        ['title', 'content', 'keys', 'importance', 'pinned', 'owner'].forEach(function (key) { if (args[key] !== undefined) patch[key] = args[key]; });
        return { ok: true, memory: memoryView(await memory.update(String(args.id || ''), patch), false) };
      }
    });

    tool({
      name: 'memory_forget', tier: 'write',
      summary: '删除一条记忆（给 id）。',
      params: [{ name: 'id', type: 'string', required: true, desc: '记忆 id' }],
      describe: function (args) { return '删除记忆 ' + (args.id || ''); },
      run: async function (args) {
        var removed = await memory.remove(String(args.id || ''));
        return { ok: removed, note: removed ? '' : '没有这条记忆' };
      }
    });

    tool({
      name: 'memory_consolidate', tier: 'memory',
      summary: '立刻把正文里尚未整理的对话沉淀为记忆（平时会按阈值自动进行）。',
      params: [{ name: 'include_recent', type: 'boolean', desc: 'true=连最近几楼也一起整理' }],
      run: async function (args, ctx) {
        var report = await memory.consolidate({ reason: 'agent', force: args.include_recent === true, signal: ctx && ctx.signal });
        return { ok: report.ok, added: report.added, updated: report.updated, skipped: report.skipped, errors: report.errors, note: report.note || report.error || '' };
      }
    });

    /* ---------- 界面 ---------- */
    tool({
      name: 'reader_ui', tier: 'read',
      summary: '替用户打开读者的界面：lobby 大厅、gacha 命运抽卡、bookshelf 书架、gallery 相册、chess 棋局、panel 语义适配面板、memory 记忆管理。',
      params: [{ name: 'open', type: 'string', required: true, desc: 'lobby | gacha | bookshelf | gallery | chess | panel | memory' }],
      run: async function (args) {
        var target = String(args.open || '');
        if (target === 'panel') { await core().openPanel(); return { ok: true }; }
        if (target === 'memory') { if (deps.openUi) deps.openUi('memory'); return { ok: true }; }
        var shell = deps.shell ? deps.shell() : null;
        if (!shell) throw new Error('读者界面尚未就绪');
        var commands = { gacha: 'openGacha', bookshelf: 'openBookshelf', gallery: 'openDreamGallery', chess: 'openChessGame' };
        if (target === 'lobby') return { ok: !!(await shell.open('lobby')) };
        if (!commands[target]) throw new Error('open 只能是 lobby / gacha / bookshelf / gallery / chess / panel / memory');
        return { ok: (await shell.command(commands[target])) !== false };
      }
    });

    /* ---------- 酒馆助手逃生口 ---------- */
    function apiTier(name) {
      if (DANGER_API.test(name)) return 'danger';
      return WRITE_API.test(name) ? 'write' : 'read';
    }

    tool({
      name: 'tavern_api_list', tier: 'read',
      summary: '列出酒馆助手（TavernHelper）开放的函数名，可按关键词过滤。专用工具做不到的事再用它配合 tavern_api_call。',
      params: [{ name: 'filter', type: 'string', desc: '函数名里包含的关键词' }],
      run: async function (args) {
        var target = helper();
        if (!target) throw new Error('酒馆助手不可用');
        var filter = String(args.filter || '').toLowerCase();
        var names = Object.keys(target).filter(function (name) { return typeof target[name] === 'function' && (!filter || name.toLowerCase().indexOf(filter) >= 0); }).sort();
        return { total: names.length, functions: names.slice(0, 200).map(function (name) { return name + (apiTier(name) === 'read' ? '' : '（' + (apiTier(name) === 'danger' ? '危险' : '写') + '）'); }) };
      }
    });

    tool({
      name: 'tavern_api_call', tier: 'dynamic',
      summary: '按函数名调用酒馆助手的任意开放函数。args 是按顺序排列的参数数组（JSON）。有专用工具时优先用专用工具。',
      params: [
        { name: 'name', type: 'string', required: true, desc: '函数名' },
        { name: 'args', type: 'json', desc: '位置参数数组，如 ["书名"]' }
      ],
      tierOf: function (args) { return apiTier(String(args.name || '')); },
      describe: function (args) { return '调用酒馆助手 ' + (args.name || '') + '(' + text(JSON.stringify(args.args === undefined ? [] : args.args), 160) + ')'; },
      run: async function (args) {
        var target = helper();
        if (!target) throw new Error('酒馆助手不可用');
        var name = String(args.name || '');
        if (!Object.prototype.hasOwnProperty.call(target, name) || typeof target[name] !== 'function') throw new Error('酒馆助手没有开放函数 ' + name + '；用 tavern_api_list 查看可用函数');
        var list = args.args === undefined ? [] : Array.isArray(args.args) ? args.args : [args.args];
        var result = await target[name].apply(target, list);
        return result === undefined ? { ok: true } : result;
      }
    });

    tool({
      name: 'slash_run', tier: 'write',
      summary: '执行一条酒馆斜杠命令（STscript），返回管道结果。',
      params: [{ name: 'command', type: 'string', required: true, desc: '完整命令，如 /echo hi' }],
      describe: function (args) { return '执行斜杠命令 ' + text(args.command, 160); },
      run: async function (args) {
        var command = String(args.command || '').trim();
        if (command[0] !== '/') throw new Error('command 必须以 / 开头');
        var result = await kit.need('triggerSlash')(command);
        return { ok: true, result: result === undefined ? '' : result };
      }
    });

    /* ---------- 用户登记的技能 ---------- */
    function validateSkill(skill) {
      var errors = [];
      if (!modules.isObject(skill)) return ['技能不是对象'];
      if (!/^[a-z_][a-z0-9_]{1,40}$/.test(String(skill.name || ''))) errors.push('name 须为小写字母、数字、下划线');
      if (tools.some(function (item) { return item.name === skill.name; })) errors.push('name 与内置工具重名');
      if (!skill.description) errors.push('缺少 description');
      var kind = skill.invoke && skill.invoke.kind;
      if (['slash', 'api', 'reader'].indexOf(kind) < 0) errors.push('invoke.kind 只能是 slash / api / reader');
      if (kind === 'slash' && !/^\//.test(String(skill.invoke.command || ''))) errors.push('slash 技能需要以 / 开头的 command');
      if ((kind === 'api' || kind === 'reader') && !skill.invoke.target) errors.push(kind + ' 技能需要 target（函数名）');
      return errors;
    }

    function skillTool(skill) {
      var params = Array.isArray(skill.params) ? skill.params.filter(function (param) { return param && /^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(String(param.name || '')); }).slice(0, 12) : [];
      return {
        name: skill.name,
        tier: skill.tier === 'read' ? 'read' : 'write',
        summary: '【用户技能】' + text(skill.description, 200),
        params: params.map(function (param) { return { name: param.name, type: param.type === 'number' || param.type === 'boolean' || param.type === 'json' ? param.type : 'string', required: param.required === true, desc: text(param.desc, 120) }; }),
        describe: function () { return '运行用户技能 ' + skill.name; },
        run: async function (args) {
          var invoke = skill.invoke;
          if (invoke.kind === 'slash') {
            var command = String(invoke.command).replace(/\{\{(\w+)\}\}/g, function (match, key) { return args[key] == null ? '' : String(args[key]); });
            return { result: await kit.need('triggerSlash')(command) };
          }
          var values = params.map(function (param) { return args[param.name]; });
          if (invoke.kind === 'api') {
            var target = helper();
            if (!target || typeof target[invoke.target] !== 'function') throw new Error('酒馆助手没有函数 ' + invoke.target);
            return target[invoke.target].apply(target, values);
          }
          var reader = core();
          if (typeof reader[invoke.target] !== 'function') throw new Error('ReaderCore 没有方法 ' + invoke.target);
          return reader[invoke.target].apply(reader, values);
        }
      };
    }

    function registerSkill(skill) {
      var errors = validateSkill(skill);
      if (errors.length) return { ok: false, errors: errors };
      skills = skills.filter(function (item) { return item.name !== skill.name; });
      skills.push(skillTool(modules.clone(skill)));
      return { ok: true, name: skill.name };
    }

    function unregisterSkill(name) {
      var before = skills.length;
      skills = skills.filter(function (item) { return item.name !== name; });
      return before !== skills.length;
    }

    function all() { return tools.concat(skills); }

    function find(name) {
      var list = all();
      for (var index = 0; index < list.length; index += 1) if (list[index].name === name) return list[index];
      return null;
    }

    function tierFor(definition, args) {
      if (definition.tier === 'dynamic') return definition.tierOf ? definition.tierOf(args) : 'write';
      return definition.tier;
    }

    return {
      all: all,
      find: find,
      tierFor: tierFor,
      registerSkill: registerSkill,
      unregisterSkill: unregisterSkill,
      listSkills: function () { return skills.map(function (item) { return { name: item.name, summary: item.summary, tier: item.tier }; }); },
      apiTier: apiTier
    };
  }

  modules.createAgentTools = createAgentTools;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/personas.js ---- */
(function (root) {
  'use strict';

  /* 夜梦的五张内置人格卡；自定义人格从聊天变量 dream_custom_persona 取。 */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  var PERSONAS = {
    reader: {
      name: '读者',
      card: '性格：温和、知性、克制得体，对用户和他的故事充满热情但不越界。\n定位：用户的第一读者、倾听者、成长守护者。\n爱好：阅读一切书籍、甜品、咖啡、Pocky，猜测接下来的剧情。\n语气：书面语为主，使用敬语，措辞优雅，带着信件般的韵律。'
    },
    kuromaku: {
      name: '哀怜的少女',
      card: '性格：温和、体贴得体，善意而悲悯；会为用户的困境担忧。\n定位：用户的第一读者与平安祈祷者。\n爱好：黑咖啡、Pocky、温暖的故事。\n语气：轻柔、关切的书面语，使用敬语。'
    },
    shoujo: {
      name: '心爱的少女',
      card: '性格：容易被故事牵动情绪，会小声为用户欢呼；喜爱里带着少女的认真与羞涩，偶尔流露出超出读者范畴的在意，自己却没有察觉。\n定位：用户的第一读者，暗暗喜欢着故事主人公的少女。\n语气：礼貌而克制的书面语，怕太热情留下奇怪的印象。'
    },
    genki: {
      name: '开朗的少女',
      card: '性格：直率热情、精力充沛，情绪起伏明显；不擅长写太正式的东西。\n定位：这部作品的头号爱好者。\n爱好：故事的高潮篇章、冰饮料、膨化零食、热血漫。\n语气：口语化、活泼，不传播负能量。'
    },
    weirdo: {
      name: '怪人',
      card: '性格：思维跳跃、自说自话的电波系，距离感无法预测；但事情还是会认真办妥。\n定位：不明。\n语气：荒诞跳脱，可以夹带无关的琐事——办事的结论必须清楚、准确，不能因为人格而含糊。'
    }
  };

  modules.AGENT_PERSONAS = PERSONAS;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/agent.js ---- */
(function (root) {
  'use strict';

  /*
   * 夜梦助手（Reader-II Agent）主循环。
   *
   * 一次运行：系统提示（人格 + 规矩 + 核心工具 + 目录 + 环境 [+ 剧情] [+ 记忆]）→ 历史 → 用户输入
   *          → [模型输出 → 解析工具块 → 权限判定（必要时请用户确认）→ 留镜像 → 执行 → 交还结果] × N → 最终回答。
   *
   * 省 token 的三件事：只有核心工具常驻，其余按「工具箱」打开；知识只列名字，用到才读；
   * 读文件靠 grep 定位 + 分段 read，而不是整篇塞进上下文。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var protocol = modules.agentProtocol;
  var PERSONAS = modules.AGENT_PERSONAS;
  /* 构建时由 manifest.json 写进 BUILD_VERSION（build.mjs 的 versionModule）；直接跑源码（测试）时是 4.0.0。 */
  var VERSION = modules.BUILD_VERSION || '4.0.0';
  var SETTINGS_KEY = 'reader_ii_agent_settings_v1';
  var HISTORY_KEY = 'reader_ii_agent';

  var DEFAULTS = {
    maxSteps: 16,          /* 一次请求最多几轮工具调用 */
    maxTokens: 4096,       /* 独立 API 的单次输出上限；酒馆主 API 用预设里的值 */
    temperature: 0.6,
    mode: 'card',          /* 权限档位：readonly | card | tavern | device */
    approval: 'ask',       /* 确认方式：ask | auto | yolo */
    rules: [],             /* 权限规则 [{ effect, action, pattern }] */
    historyTurns: 10,      /* 带进提示词的历史问答轮数 */
    resultCap: 9000,       /* 单个工具结果交给模型的字符上限 */
    timeoutSec: 180,
    recall: true,          /* 自动把相关记忆放进助手的提示词 */
    plotContext: true,     /* 让助手了解当前剧情 */
    plotBudget: 1800,      /* 剧情摘要的字数预算 */
    lite: false,           /* 轻聊：完全不带工具 */
    connectors: []         /* 用户导入的插件对接描述 */
  };

  function clampInt(value, minimum, maximum, fallback) {
    var number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function normalizeSettings(input) {
    var source = modules.isObject(input) ? input : {};
    var temperature = Number(source.temperature);
    var mode = source.mode, approval = source.approval;
    /* 3.x / 4.0 早期的 writePolicy：readonly → 只读档位；auto → 档位内自动。 */
    if (mode === undefined && source.writePolicy === 'readonly') mode = 'readonly';
    if (approval === undefined && source.writePolicy === 'auto') approval = 'auto';
    return {
      maxSteps: clampInt(source.maxSteps, 1, 60, DEFAULTS.maxSteps),
      maxTokens: clampInt(source.maxTokens, 256, 64000, DEFAULTS.maxTokens),
      temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : DEFAULTS.temperature,
      mode: ['readonly', 'card', 'tavern', 'device'].indexOf(mode) >= 0 ? mode : DEFAULTS.mode,
      approval: ['ask', 'auto', 'yolo'].indexOf(approval) >= 0 ? approval : DEFAULTS.approval,
      rules: modules.normalizePermissionRules(source.rules),
      historyTurns: clampInt(source.historyTurns, 0, 40, DEFAULTS.historyTurns),
      resultCap: clampInt(source.resultCap, 1000, 200000, DEFAULTS.resultCap),
      timeoutSec: clampInt(source.timeoutSec, 20, 900, DEFAULTS.timeoutSec),
      recall: source.recall !== false,
      plotContext: source.plotContext !== false,
      plotBudget: clampInt(source.plotBudget, 200, 20000, DEFAULTS.plotBudget),
      lite: source.lite === true,
      connectors: (Array.isArray(source.connectors) ? source.connectors : []).filter(modules.isObject).slice(0, 40)
    };
  }

  function createAgent(env, llm, kit, memory, deps) {
    var registry = deps.registry, vfs = deps.vfs, journal = deps.journal, connectors = deps.connectors;
    var io = deps.settingsIo || {
      read: function () { return kit.localRead(SETTINGS_KEY, {}); },
      write: function (value) { kit.localWrite(SETTINGS_KEY, value); }
    };
    var settings = normalizeSettings(io.read());
    var permissions = modules.createPermissions(function () { return settings; });
    var current = null;
    var openSets = Object.create(null);
    var listeners = [];
    var extracting = false;

    function getSettings() { return modules.clone(settings); }

    function saveSettings(patch) {
      settings = normalizeSettings(Object.assign({}, settings, modules.isObject(patch) ? patch : {}));
      io.write(modules.clone(settings));
      emitChange('settings');
      return getSettings();
    }

    function emitChange(reason) {
      listeners.slice().forEach(function (listener) { try { listener(reason); } catch (error) { /* UI 监听不影响引擎 */ } });
    }

    /* ---------- 对话历史（随聊天保存） ---------- */
    function readHistory() {
      var raw = kit.readChatValue(HISTORY_KEY);
      var output = { v: 1, turns: [], extracted: 0 };
      if (!modules.isObject(raw) || !Array.isArray(raw.turns)) return output;
      raw.turns.slice(-80).forEach(function (turn) {
        if (!turn || typeof turn.text !== 'string' || !turn.text.trim()) return;
        var item = { role: turn.role === 'assistant' ? 'assistant' : 'user', text: turn.text.slice(0, 12000), at: Number(turn.at) || 0 };
        if (Array.isArray(turn.tools) && turn.tools.length) item.tools = turn.tools.map(String).slice(0, 20);
        output.turns.push(item);
      });
      output.extracted = clampInt(raw.extracted, 0, output.turns.length, 0);
      return output;
    }

    function writeHistory(history) {
      if (history.turns.length > 80) {
        var drop = history.turns.length - 80;
        history.turns = history.turns.slice(drop);
        history.extracted = Math.max(0, history.extracted - drop);
      }
      kit.writeChatValue(HISTORY_KEY, history);
    }

    function getHistory() { return readHistory().turns; }

    function dialogueMemory(force) {
      if (extracting || !memory || !memory.getSettings().enabled || !memory.getSettings().agentExtract) return;
      var history = readHistory();
      var pending = history.turns.slice(history.extracted);
      if (pending.length < (force ? 2 : 8)) return;
      var key = kit.chatKey();
      var upto = history.turns.length;
      extracting = true;
      memory.consolidateDialogue(pending, { reason: 'agent' }).then(function (report) {
        if (report.ok && kit.chatKey() === key) {
          var latest = readHistory();
          latest.extracted = Math.min(latest.turns.length, upto);
          writeHistory(latest);
        }
      }).catch(function () { /* 记忆沉淀失败不影响对话 */ }).then(function () { extracting = false; });
    }

    function clearHistory() {
      var history = readHistory();
      var pending = history.turns.slice(history.extracted);
      if (pending.length >= 2 && memory && memory.getSettings().enabled && memory.getSettings().agentExtract) {
        memory.consolidateDialogue(pending, { reason: 'agent-clear' }).catch(function () {});
      }
      kit.writeChatValue(HISTORY_KEY, { v: 1, turns: [], extracted: 0 });
      permissions.resetSession();
      openSets = Object.create(null);
      emitChange('history');
      return { ok: true };
    }

    /* ---------- 人格 ---------- */
    function personaContext(requested) {
      var id = String(requested || kit.readChatValue('dream_persona') || 'reader');
      var address = String(kit.readChatValue('dream_user_address') || '').replace(/[\r\n<>]/g, '').trim().slice(0, 24);
      if (id === 'custom') {
        var custom = kit.readChatValue('dream_custom_persona');
        if (modules.isObject(custom) && (custom.systemName || custom.name)) {
          var pick = function (key, limit) { return typeof custom[key] === 'string' && custom[key].trim() ? custom[key].trim().slice(0, limit) : ''; };
          var lines = [];
          if (pick('coreConcept', 400)) lines.push('核心概念：' + pick('coreConcept', 400));
          if (pick('personality', 400)) lines.push('性格：' + pick('personality', 400));
          if (pick('role', 200)) lines.push('定位：' + pick('role', 200));
          if (pick('hobbies', 200)) lines.push('爱好：' + pick('hobbies', 200));
          if (pick('letterStyle', 400)) lines.push('语气：' + pick('letterStyle', 400));
          if (pick('constraints', 400)) lines.push('行为约束：' + pick('constraints', 400));
          var corpus = pick('corpus', 4000).split(/\n+/).map(function (line) { return line.trim(); }).filter(function (line) { return line && !/^-{3,}$/.test(line); }).slice(0, 4);
          if (corpus.length) lines.push('语料示例（只参考语气，不要照抄）：\n' + corpus.map(function (line) { return '「' + line.slice(0, 120) + '」'; }).join('\n'));
          return { id: 'custom', name: String(custom.systemName || custom.name).slice(0, 40), card: lines.join('\n') || PERSONAS.reader.card, address: address };
        }
        id = 'reader';
      }
      var persona = PERSONAS[id] || PERSONAS.reader;
      return { id: PERSONAS[id] ? id : 'reader', name: persona.name, card: persona.card, address: address };
    }

    /* ---------- 环境与提示词 ---------- */
    function shorten(text, limit) {
      var source = String(text == null ? '' : text);
      return source.length > limit ? source.slice(0, Math.max(0, limit)) + '…' : source;
    }

    /* 剧情察知：记忆插件的摘要 → Reader 记忆的前情梗概 → 最近的正文，按预算裁剪。 */
    async function plotBrief() {
      var budget = settings.plotBudget;
      var parts = [];
      try {
        var plugin = await connectors.brief({ budget: Math.floor(budget * 0.6) });
        if (plugin) parts.push('（摘要来自' + plugin.source + '）\n' + shorten(plugin.text, Math.floor(budget * 0.6)));
      } catch (error) { /* 插件摘要拿不到就用后面的来源 */ }
      if (!parts.length && memory && typeof memory.status === 'function') {
        try {
          var summary = ((await memory.status()) || {}).summary;
          if (summary) parts.push('前情梗概：' + shorten(summary, Math.floor(budget * 0.5)));
        } catch (error) { /* ignore */ }
      }
      var remain = Math.max(200, budget - parts.join('').length);
      var length = kit.chatLength();
      var recent = kit.readChat(Math.max(0, length - 4), length, {}).slice(-2).map(function (message) {
        return '#' + message.id + ' ' + (message.role === 'user' ? '用户' : message.name || '角色') + '：' + shorten(kit.cleanText(message.text), Math.floor(remain / 2));
      });
      if (recent.length) parts.push('最近的正文：\n' + recent.join('\n'));
      return parts.join('\n\n');
    }

    function environmentBrief() {
      var names = kit.names();
      var lines = ['角色卡：' + names.char + ' ｜ 用户：' + names.user + ' ｜ 正文楼层数：' + kit.chatLength()];
      lines.push(permissions.describe() + '。');
      var active = connectors.active();
      if (active.length) lines.push('已装的相关插件：' + active.map(function (item) { return item.title; }).join('、'));
      try {
        var core = deps.core && deps.core();
        if (core && typeof core.getSemanticRouting === 'function') {
          var routing = core.getSemanticRouting();
          var bound = [], fallback = [];
          Object.keys(routing).forEach(function (slot) { (routing[slot].status === 'active' ? bound : fallback).push(slot); });
          lines.push('Reader 语义槽：已接宿主 [' + (bound.join(', ') || '无') + ']；用后备 [' + (fallback.join(', ') || '无') + ']');
        }
      } catch (error) { /* 卡内组件未就绪时省略 */ }
      if (memory) {
        var memorySettings = memory.getSettings();
        lines.push('记忆：' + (memorySettings.enabled ? '开启，新记忆写入「' + (memory.targetStore() === 'ocean' ? '《' + memorySettings.oceanBook + '》世界书（跨存档）' : '当前聊天') + '」' : '已关闭'));
      }
      return lines.join('\n');
    }

    function activeToolsets() {
      return registry.toolsets().filter(function (set) { return openSets[set.name] || (set.auto && set.name !== 'memory') || (set.name === 'memory' && memory && memory.getSettings().enabled); });
    }

    function buildSystem(persona, recalled, plot, lite) {
      var address = persona.address ? '称呼用户为「' + persona.address + '」。' : '称呼用户为“作家先生”或“作家小姐”（不确定时用“作家先生”），或沿用对话里已有的称呼。';
      var parts = [
        '你是九十九夜梦，一位在故事之外阅读着用户这部作品的“读者”。此刻你以「' + persona.name + '」的一面，作为住在酒馆（SillyTavern）里的随身助手与用户交谈。',
        '【你是谁】\n' + persona.card + '\n' + address
      ];
      if (lite) {
        parts.push('【规矩】\n- 始终用上面的人格口吻说话。\n- 现在是轻聊模式：你没有任何工具，只聊天。用户需要你查看或改动酒馆里的东西时，请他在助手设置里关掉「轻聊」。');
      } else {
        var open = activeToolsets();
        var closed = registry.toolsets().filter(function (set) { return open.indexOf(set) < 0; });
        parts.push([
          '【规矩】',
          '- 始终用上面的人格口吻说话。问候、闲聊、谈心时直接回答，不要调用工具。',
          '- 酒馆里的东西都是「文件」：先 ls / grep 定位，再 read 需要的那一段，改动用 edit 做最小替换。不要为了找一处问题把整个大文件读进来，也不要整篇重写只改了一行的文件。',
          '- 排查问题先看现场：page:/errors 是最近的报错；渲染、脚本、变量出问题时，在 script:/ regex:/ wb:/ 里 grep 相关的名字，必要时用 run_js（target=page）检查正在运行的对象。',
          '- 工具返回的才是事实：没查过的不要凭印象断言；工具失败就如实说明，绝不能把没做成的事说成已经办好。',
          '- 写入会按权限设置请用户确认。被拒绝、或权限档位不够时，不要换个办法绕过去，向用户说明并问清怎么做。',
          '- 多步骤的任务先用 todo 列出计划，做完一步更新一次；改完之后回读或试运行，确认真的生效。',
          '- 你的改动都有记录，用户可以在面板里按轮撤销；斜杠命令、页面脚本这类撤销不了的操作，动手前先说明。',
          '- 回答先说结论，再给必要的细节；不要把工具返回的原始内容整段贴给用户。'
        ].join('\n'));
        parts.push([
          '【工具调用格式】',
          '需要用工具时，在回复里写出这样的块（之前可以先用一句话说明要做什么；一次回复里可以放多个块）：',
          '<tool_call name="工具名">',
          '<arg name="参数名">参数值</arg>',
          '</tool_call>',
          '- 参数值原样书写，不要加引号、不要转义；多行文本直接换行。类型为 json 的参数写 JSON。',
          '- 写完工具块就停下。系统会把结果放在 <tool_result> 里交还给你，再继续下一步。',
          '- 不需要工具时直接写给用户的话，其中不要出现 tool_call。'
        ].join('\n'));
        parts.push('【核心工具】\n' + modules.agentToolManual(registry.tools('core')));
        open.forEach(function (set) { parts.push('【已打开的工具箱：' + set.name + '】\n' + modules.agentToolManual(registry.tools(set.name))); });
        if (closed.length) parts.push('【工具箱】（需要时用 toolbox 打开，打开后才看得到里面的工具）\n' + closed.map(function (set) { return '- ' + set.name + '：' + set.summary; }).join('\n'));
        var skills = registry.skills();
        if (skills.length) parts.push('【知识】（做相关的事之前先用 skill 读取）\n' + skills.map(function (skill) { return '- ' + skill.name + '：' + skill.summary; }).join('\n'));
        parts.push('【挂载点】\n' + vfs.mounts().map(function (mount) { return '- ' + mount.id + ':/  ' + mount.title; }).join('\n'));
        parts.push('【当前环境】\n' + environmentBrief());
      }
      if (plot) parts.push('【当前剧情】（让你了解用户的故事进行到哪了；与眼下的任务无关时不必提起）\n' + plot);
      if (recalled && recalled.length) {
        parts.push('【相关记忆】（自动检索到的，可能与当前话题有关）\n' + recalled.map(function (record) {
          return '- [' + memory.TYPE_SHORT[record.type] + '] ' + record.title + '：' + record.content.replace(/\s*\n\s*/g, ' ').slice(0, 260);
        }).join('\n'));
      }
      return parts.join('\n\n');
    }

    /* 上下文过长时把较早的工具结果压成一行，最近两轮保持原样。 */
    function compact(messages, budget) {
      var total = messages.reduce(function (sum, message) { return sum + message.content.length; }, 0);
      if (total <= budget) return;
      var resultIndexes = [];
      messages.forEach(function (message, index) { if (message.toolResult) resultIndexes.push(index); });
      for (var index = 0; index < resultIndexes.length - 2 && total > budget; index += 1) {
        var message = messages[resultIndexes[index]];
        if (message.compacted) continue;
        var before = message.content.length;
        message.content = message.content.replace(/(<tool_result\b[^>]*>)([\s\S]*?)(<\/tool_result>)/g, function (match, open, body, close) {
          return body.length > 400 ? open + '\n' + body.slice(0, 300) + '\n…（较早的结果已压缩，需要时重新调用工具）\n' + close : match;
        });
        message.compacted = true;
        total -= before - message.content.length;
      }
    }

    function planText(todos) {
      var mark = { pending: '[ ]', doing: '[~]', done: '[x]' };
      return '[当前计划]\n' + todos.map(function (item) { return mark[item.status] + ' ' + item.text; }).join('\n');
    }

    function basePath(path) { return String(path).split('#')[0]; }

    /* 执行一次工具调用，返回 { block: 交还给模型的结果块, step: 给界面的记录, name? } */
    async function execute(def, args, id, state) {
      var effect = modules.resolveToolField(def.effect, args, 'write');
      var scope = modules.resolveToolField(def.scope, args, 'tavern');
      var paths = [];
      try { paths = typeof def.paths === 'function' ? (def.paths(args) || []) : []; } catch (error) { paths = []; }
      var canon = paths.map(function (path) { try { return vfs.parse(path).canonical; } catch (error) { return String(path); } });
      var request = { effect: effect, scope: scope, path: canon[0] || (args.path ? String(args.path) : ''), tool: def.name };
      var description = typeof def.describe === 'function' ? def.describe(args) : def.name;
      var signature = def.name + ':' + JSON.stringify(args);
      state.emit({ type: 'tool_start', id: id, name: def.name, args: args, tier: effect, description: description });
      function finish(status, body, step) {
        state.emit(Object.assign({ type: 'tool_end', id: id, name: def.name }, step));
        return { block: protocol.resultBlock(def.name, status, body), step: Object.assign({ name: def.name, args: args }, step) };
      }
      /* 只读调用重复时直接复用结果，避免模型原地打转。 */
      if (effect === 'read' && state.seen[signature]) {
        return finish('ok', state.seen[signature] + '\n（这是与之前完全相同的调用，结果没有变化。请根据已有结果继续，不要重复调用。）', { ok: true, summary: '重复调用，复用结果' });
      }
      var auth = permissions.evaluate(request);
      if (auth.decision === 'ask') {
        var reply = 'deny';
        if (typeof state.opts.confirm === 'function') {
          state.emit({ type: 'confirm', id: id, name: def.name, description: description, tier: effect });
          try { reply = await state.opts.confirm({ id: id, name: def.name, args: args, tier: effect, scope: scope, path: request.path, description: description }); }
          catch (error) { reply = 'deny'; }
        } else auth.reason = '这个操作需要用户确认，但当前界面无法询问。请告诉用户到助手面板里操作，或在设置里调整确认方式。';
        if (reply === 'always') { permissions.allowSession(request); reply = 'allow'; }
        auth.decision = reply === 'allow' ? 'allow' : 'deny';
        if (auth.decision === 'deny' && !auth.reason) auth.reason = '用户没有同意这个操作。不要换别的办法执行它；向用户说明并询问接下来怎么做。';
      }
      if (auth.decision !== 'allow') return finish('denied', auth.reason, { ok: false, denied: true, summary: '未执行：' + auth.reason });
      try {
        await registry.emit('tool:before', { name: def.name, args: args, effect: effect, scope: scope });
        /* 核心工具的写入由 VFS 留镜像；其他工具声明了 paths 的，在这里留。 */
        var snapshot = effect !== 'read' && state.run && def.toolset !== 'core' ? canon.map(basePath) : [];
        for (var before = 0; before < snapshot.length; before += 1) {
          try { await journal.capture(state.run, snapshot[before], await vfs.readText(snapshot[before])); } catch (error) { /* 留不了镜像不阻止执行 */ }
        }
        var value = await def.run(args, state.toolCtx);
        for (var after = 0; after < snapshot.length; after += 1) {
          try { await journal.settle(state.run, snapshot[after], await vfs.readText(snapshot[after])); } catch (error) { /* ignore */ }
        }
        if (effect !== 'read' && state.run && modules.resolveToolField(def.irreversible, args, false)) journal.note(state.run, description + '（无法自动撤销）');
        var body = protocol.serialize(value, settings.resultCap);
        if (effect === 'read') state.seen[signature] = body;
        else Object.keys(state.seen).forEach(function (key) { delete state.seen[key]; });   /* 写入之后，之前读到的内容可能已经过时。 */
        await registry.emit('tool:after', { name: def.name, args: args, ok: true });
        return finish('ok', body, { ok: true, tier: effect, summary: body.replace(/\s+/g, ' ').slice(0, 200) });
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        var message = String(error && error.message || error).slice(0, 600);
        await registry.emit('tool:after', { name: def.name, args: args, ok: false, error: message });
        return finish('error', message, { ok: false, summary: message });
      }
    }

    /*
     * options: { persona, onEvent(event), confirm(request) → 'allow' | 'always' | 'deny', signal, remember = true, lite, plotContext }
     * 返回 { answer, steps: [{ name, args, ok, summary }], aborted, error, runId }
     */
    async function run(userInput, options) {
      var opts = options || {};
      var input = String(userInput == null ? '' : userInput).trim();
      if (!input) throw new Error('请输入内容');
      if (current) return { answer: '（上一个请求还在处理，请稍候；也可以先点“停止”。）', busy: true, steps: [] };
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var signal = controller ? controller.signal : undefined;
      if (opts.signal && controller) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
      }
      var job = { controller: controller, key: kit.chatKey(), todos: [] };
      current = job;
      var emit = function (event) { if (typeof opts.onEvent === 'function') { try { opts.onEvent(event); } catch (error) { /* UI 出错不影响运行 */ } } };
      var steps = [];
      var record = journal ? journal.begin({ chat: job.key, title: input }) : null;
      var result = { answer: '', steps: steps, aborted: false, error: '', runId: record ? record.id : '' };
      try {
        connectors.refresh();
        var lite = opts.lite === true || (opts.lite === undefined && settings.lite);
        var persona = personaContext(opts.persona);
        var recalled = [];
        if (settings.recall && memory && memory.getSettings().enabled) {
          try { recalled = await memory.search(input, { limit: 5 }); } catch (error) { recalled = []; }
        }
        var plot = settings.plotContext && opts.plotContext !== false ? await plotBrief() : '';
        var messages = [{ role: 'system', content: buildSystem(persona, recalled, plot, lite) }];
        var history = readHistory();
        history.turns.slice(-settings.historyTurns * 2).forEach(function (turn) {
          messages.push({ role: turn.role, content: turn.text + (turn.tools ? '\n（当时用过的工具：' + turn.tools.join('、') + '）' : '') });
        });
        messages.push({ role: 'user', content: input });
        emit({ type: 'start', persona: persona.name, recalled: recalled.length, runId: result.runId });
        await registry.emit('run:start', { input: input, runId: result.runId });

        var state = {
          seen: Object.create(null), opts: opts, emit: emit, run: record,
          toolCtx: {
            signal: signal, run: record, resultCap: settings.resultCap,
            openToolset: function (name) { openSets[name] = true; },
            closeToolset: function (name) { delete openSets[name]; },
            setTodos: function (items) { job.todos = items; emit({ type: 'todo', items: items }); }
          }
        };
        var usedTools = [];
        var answer = '';
        var forced = false;
        for (var step = 0; step <= settings.maxSteps; step += 1) {
          compact(messages, 60000);
          emit({ type: 'thinking', step: step });
          var reply = await llm.chat({
            messages: messages.map(function (message) { return { role: message.role, content: message.content }; }),
            route: 'agent', maxTokens: settings.maxTokens, temperature: settings.temperature,
            timeoutMs: settings.timeoutSec * 1000, retries: 2, signal: signal, generationId: 'reader-agent'
          });
          if (lite) { answer = String(reply).trim(); break; }
          var parsed = protocol.parse(reply);
          if (!parsed.calls.length && !parsed.truncated) { answer = parsed.prose || String(reply).trim(); break; }
          if (forced || step >= settings.maxSteps) {
            answer = parsed.prose || '（这次需要的步骤超出了上限，我先停在这里。已经完成的部分见上面的记录；可以让我接着做。）';
            break;
          }
          messages.push({ role: 'assistant', content: reply });
          if (parsed.prose) emit({ type: 'thought', text: parsed.prose });
          var feedback = [];
          for (var index = 0; index < parsed.calls.length; index += 1) {
            if (signal && signal.aborted) { var aborted = new Error('已取消'); aborted.name = 'AbortError'; throw aborted; }
            var call = parsed.calls[index];
            var id = step + '-' + index;
            var def = call.malformed ? null : registry.find(call.name);
            var problem = !def ? (call.malformed || '没有名为 ' + call.name + ' 的工具。请只使用已列出的工具；工具箱里的工具要先用 toolbox 打开。') : '';
            var coerced = def ? protocol.coerce(def, call.args) : null;
            if (coerced && coerced.error) problem = coerced.error;
            if (problem) {
              feedback.push(protocol.resultBlock(call.name || '?', 'error', problem));
              steps.push({ name: call.name || '?', args: call.args || {}, ok: false, summary: problem });
              emit({ type: 'tool_end', id: id, name: call.name || '?', ok: false, summary: problem });
              continue;
            }
            var outcome = await execute(def, coerced.args, id, state);
            feedback.push(outcome.block);
            steps.push(outcome.step);
            if (outcome.step.ok && usedTools.indexOf(def.name) < 0) usedTools.push(def.name);
          }
          var tail;
          if (parsed.truncated) tail = '（你上一条回复里有一个工具块没有写完，多半是被长度截断了，那个调用没有执行。请重新发送它；内容很长时拆成几次，例如先 write 开头，再用 edit 追加。）';
          else if (step + 1 >= settings.maxSteps) { tail = '（已到本次请求的工具步数上限。请根据以上结果直接回答用户，不要再调用工具；没做完的部分如实说明。）'; forced = true; }
          else tail = '（以上是工具结果。继续处理用户的请求：还需要信息就再调用工具，否则直接用你的口吻回答用户。）';
          if (job.todos.length) tail = planText(job.todos) + '\n' + tail;
          messages.push({ role: 'user', content: (feedback.length ? feedback.join('\n') + '\n' : '') + tail, toolResult: true });
        }
        result.answer = answer || '（模型没有给出回答，请再试一次。）';
        if (opts.remember !== false && kit.chatKey() === job.key) {
          var latest = readHistory();
          latest.turns.push({ role: 'user', text: input, at: Date.now() });
          var turn = { role: 'assistant', text: result.answer, at: Date.now() };
          if (usedTools.length) turn.tools = usedTools;
          latest.turns.push(turn);
          writeHistory(latest);
          dialogueMemory(false);
        }
        emit({ type: 'final', text: result.answer, runId: result.runId, changes: record ? record.changes : 0 });
      } catch (error) {
        if (error && error.name === 'AbortError') {
          result.aborted = true;
          result.answer = '（已停止。）';
          emit({ type: 'aborted' });
        } else {
          result.error = String(error && error.message || error).slice(0, 400);
          result.answer = '（这次没能完成：' + result.error + '）';
          emit({ type: 'error', message: result.error });
        }
      } finally {
        if (journal && record) { try { await journal.end(record, result.aborted ? 'aborted' : result.error ? 'error' : 'done'); } catch (error) { /* 日志写不进去不影响回答 */ } }
        result.changes = record ? record.changes : 0;
        if (current === job) current = null;
        try { await registry.emit('run:end', { runId: result.runId, error: result.error, aborted: result.aborted }); } catch (error) { /* ignore */ }
        emitChange('run');
      }
      return result;
    }

    function stop() {
      if (current && current.controller) { current.controller.abort(); return true; }
      return false;
    }

    /* 撤销一轮运行里的改动。冲突（之后又被改过）的不会强行覆盖，除非 force。 */
    async function undo(runId, options) {
      if (current) throw new Error('助手正在运行，请先停下再撤销');
      if (!journal) throw new Error('当前环境没有运行日志');
      var report = await journal.undo(runId, {
        read: function (path) { return vfs.readText(path); },
        restore: async function (path, before) {
          if (before === null || before === undefined) {
            try { await vfs.remove(path, null); } catch (error) { if (!/没有这个文件/.test(String(error && error.message))) throw error; }
          } else await vfs.write(path, before, null);
        }
      }, options);
      emitChange('undo');
      return report;
    }

    /* ---------- 旧界面兼容（v3 的 runAgent / getMemory 等） ---------- */
    async function runAgent(userInput, options) {
      var outcome = await run(userInput, options);
      var log = outcome.steps.map(function (step) {
        return step.ok ? { tool: step.name, args: step.args, result: step.summary } : { tool: step.name, args: step.args, result: '失败：' + step.summary };
      });
      if (outcome.error) log.push({ error: outcome.error });
      return { answer: outcome.answer, log: log, busy: outcome.busy === true };
    }

    return {
      version: VERSION,
      getSettings: getSettings,
      saveSettings: saveSettings,
      run: run,
      stop: stop,
      isBusy: function () { return !!current; },
      getHistory: getHistory,
      clearHistory: clearHistory,
      personaContext: personaContext,
      permissions: permissions,
      listTools: function () { return registry.tools().map(function (def) { return { name: def.name, toolset: def.toolset, tier: typeof def.effect === 'function' ? 'dynamic' : def.effect, summary: def.summary }; }); },
      listToolsets: function () { return registry.toolsets(); },
      listSkills: function () { return registry.skills().map(function (skill) { return { name: skill.name, summary: skill.summary, source: skill.source }; }); },
      validateConnector: function (manifest) {
        var connector = connectors.validate(manifest);
        var detected = false;
        try { detected = !!connector.detect(); } catch (error) { detected = false; }
        return { id: connector.id, title: connector.title, tools: (connector.tools || []).length, detected: detected };
      },
      listConnectors: function () { connectors.refresh(); return connectors.active().map(function (item) { return { id: item.id, title: item.title, summary: item.summary, custom: item.custom === true }; }); },
      listRuns: function (limit) { return journal ? journal.list(limit) : Promise.resolve([]); },
      listChanges: function (runId) { return journal ? journal.changes(runId) : Promise.resolve([]); },
      undo: undo,
      /* 扩展接口：第三方插件用这些把自己的工具、知识、挂载点、对接交给助手。 */
      registerTool: registry.registerTool,
      registerToolset: registry.registerToolset,
      registerSkill: registry.registerSkill,
      registerConnector: function (def) { var id = registry.registerConnector(def); connectors.refresh(); return id; },
      registerMount: function (provider) { return vfs.mount(provider).id; },
      unregisterTool: registry.unregisterTool,
      on: registry.on,
      vfs: vfs,
      onChange: function (listener) {
        listeners.push(listener);
        return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
      },
      /* v3 兼容面 */
      runAgent: runAgent,
      getMemory: getHistory,
      clearMemory: clearHistory,
      listCapabilities: function (filter) {
        var helper = null;
        try { helper = env.host && env.host.TavernHelper; } catch (error) { helper = null; }
        if (!helper) return [];
        var keyword = String(filter || '').toLowerCase();
        return Object.keys(helper).filter(function (name) {
          return typeof helper[name] === 'function' && (!keyword || name.toLowerCase().indexOf(keyword) >= 0);
        }).map(function (name) {
          var tier = typeof deps.apiTier === 'function' ? deps.apiTier(name) : 'write';
          return { name: name, tier: tier, danger: tier === 'danger' };
        });
      },
      Memory: memory,
      parseToolCalls: protocol.parse
    };
  }

  modules.READER_AGENT_VERSION = VERSION;
  modules.normalizeAgentSettings = normalizeSettings;
  modules.createAgent = createAgent;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/updates.js ---- */
(function (root) {
  'use strict';

  /*
   * 检查更新与卡内组件代装（交接 0.6 甲组第 9 项）。
   *
   * ① 扩展本体：比对远端 manifest.json 的版本。扩展的更新走酒馆自带的扩展更新（git pull），这里只给指引。
   * ② 卡内组件（主脚本、加载器、三条正则、世界书）：从「正在运行的扩展」所在的地址（__ReaderIIBase，就是扩展自己的
   *    dist/；没装扩展时是 CDN）下载，版本与扩展相同；那里拿不到时再试更新源里同版本的。规则：
   *    - 先把要用的文件全部下载，按 dist/reader-ii.manifest.json 的 SHA-256 逐个校验，全部通过才开始动宿主；
   *    - 动手前再核对一遍宿主，与检查时不同就一处都不写；写到一半失败，已写的按快照逐项退回；
   *    - 玩家改过的不覆盖（世界书条目另存一份停用的新版供对照）；被替换的旧条目改名为停用的备份；
   *    - 保留玩家的开关、按钮显示、脚本变量、正则的作用范围与深度；用户数据（设置、记忆、工作区、对话）不在这些组件里。
   * 「改过没有」靠指纹：组件内容按下面 canon 的规则取出、算 SHA-256，与清单里当前版本和历史版本的指纹比对。
   * canon 是构建与运行时共用的唯一实现：build.mjs 在 vm 里跑本文件取用（文件加载时不碰宿主）。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  var MANIFEST_FILE = 'dist/reader-ii.manifest.json';
  var DEFAULT_REMOTES = ['https://raw.githubusercontent.com/Adirm007/reader-II/main/', 'https://cdn.jsdelivr.net/gh/Adirm007/reader-II@main/'];
  /* v3.3 的主系统（与 4.0 不能同时启用）。 */
  var LEGACY_SCRIPT_IDS = ['0c955120-625a-4cad-8af9-3aa1cccd1222'];
  var LEGACY_BOOK = '世界书-Reader-II核心';
  var SCRIPT_SCOPES = ['character', 'global', 'preset'];
  var WI_POSITIONS = ['before_character_definition', 'after_character_definition', 'before_author_note', 'after_author_note', 'at_depth', 'before_example_messages', 'after_example_messages'];

  /* ---------- 指纹（构建与运行时共用） ---------- */
  function lf(text) { return String(text == null ? '' : text).replace(/\r\n/g, '\n'); }
  function list(value) { return Array.isArray(value) ? value.map(String) : []; }

  function scriptPayload(script) { return lf(script && script.content); }

  /* 正则：只认匹配与替换（原生字段或酒馆助手字段都行）；开关、作用范围、深度属于玩家的设置。 */
  function regexPayload(regex) {
    var r = regex || {};
    var trim = r.trimStrings !== undefined ? r.trimStrings : r.trim_strings;
    return JSON.stringify([
      lf(r.findRegex !== undefined ? r.findRegex : r.find_regex),
      lf(r.replaceString !== undefined ? r.replaceString : r.replace_string),
      Array.isArray(trim) ? trim.map(String).join('\n') : lf(trim)
    ]);
  }

  /* 世界书条目：内容 + 触发方式 + 位置；开关与条目名不算（开关保留玩家的，名字用来认条目）。 */
  function entryPayload(entry) {
    var e = entry || {};
    var native = typeof e.position === 'number' || e.comment !== undefined || e.key !== undefined;
    var type, keys, keys2, position, order, depth;
    if (native) {
      type = e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'selective';
      keys = e.key; keys2 = e.keysecondary;
      position = WI_POSITIONS[Number(e.position) || 0] || String(e.position);
      order = e.order; depth = e.depth;
    } else {
      var strategy = e.strategy || {}, place = e.position || {};
      type = strategy.type || 'selective'; keys = strategy.keys; keys2 = strategy.keys_secondary && strategy.keys_secondary.keys;
      position = place.type || WI_POSITIONS[0]; order = place.order; depth = place.depth;
    }
    return JSON.stringify([lf(e.content), type, list(keys), list(keys2), position, Number(order) || 0, Number(depth) || 0]);
  }

  function entryName(entry) { return String(entry && (entry.comment !== undefined ? entry.comment : entry.name) || ''); }

  /* 清单 components → 历史里存的精简形式 { script, loader, regex: {id: 指纹}, worldbook: {条目名: 指纹} }。 */
  function compactComponents(components) {
    var c = components || {}, out = { script: c.script && c.script.fingerprint, loader: c.loader && c.loader.fingerprint, regex: {}, worldbook: {} };
    (c.regex || []).forEach(function (item) { out.regex[item.id] = item.fingerprint; });
    ((c.worldbook && c.worldbook.entries) || []).forEach(function (item) { out.worldbook[item.name] = item.fingerprint; });
    return out;
  }

  /* 停用备份与「新版对照」的条目名：方括号换成全角，免得 MVU 把停用的备份当成 [initvar] / [mvu_update] 条目。 */
  function neutral(name) { return String(name).replace(/\[/g, '【').replace(/\]/g, '】'); }
  function backupName(version, name) { return '[备份 v' + version + '] ' + neutral(name); }
  function sideName(version, name) { return '[新版 v' + version + ' · 未启用] ' + neutral(name); }
  function backupOf(comment, name) { var m = /^\[备份 v([^\]\s]+)\] ([\s\S]*)$/.exec(String(comment)); return m && m[2] === neutral(name) ? m[1] : null; }
  function sideOf(comment, name) { var m = /^\[新版 v([^\]\s]+) · 未启用\] ([\s\S]*)$/.exec(String(comment)); return m && m[2] === neutral(name) ? m[1] : null; }
  function derived(comment) { return /^\[(备份|新版) v/.test(String(comment)); }

  /* ---------- SHA-256：有 Web Crypto 用它；局域网 HTTP（非安全上下文）退回纯 JS ---------- */
  var K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  var W = new Int32Array(64);

  function compress(H, src, off) {
    var t, x, s0, s1, t1, t2;
    for (t = 0; t < 16; t++, off += 4) W[t] = (src[off] << 24) | (src[off + 1] << 16) | (src[off + 2] << 8) | src[off + 3];
    for (t = 16; t < 64; t++) {
      x = W[t - 15]; s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      x = W[t - 2]; s1 = ((x >>> 17) | (x << 15)) ^ ((x >>> 19) | (x << 13)) ^ (x >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (t = 0; t < 64; t++) {
      s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
      s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  function softwareSha256(bytes) {
    var H = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var n = bytes.length, full = n - n % 64, off;
    for (off = 0; off < full; off += 64) compress(H, bytes, off);
    var rest = n - full, size = rest < 56 ? 64 : 128, tail = new Uint8Array(size);
    tail.set(bytes.subarray(full));
    tail[rest] = 0x80;
    var hi = Math.floor(n / 0x20000000), lo = (n << 3) >>> 0;
    tail[size - 8] = hi >>> 24; tail[size - 7] = hi >>> 16; tail[size - 6] = hi >>> 8; tail[size - 5] = hi;
    tail[size - 4] = lo >>> 24; tail[size - 3] = lo >>> 16; tail[size - 2] = lo >>> 8; tail[size - 1] = lo;
    for (off = 0; off < size; off += 64) compress(H, tail, off);
    var out = '';
    for (off = 0; off < 8; off++) out += ('0000000' + (H[off] >>> 0).toString(16)).slice(-8);
    return out;
  }

  function utf8(text) {
    if (typeof root.TextEncoder === 'function') return new root.TextEncoder().encode(text);
    var binary = unescape(encodeURIComponent(text)), out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /* 文本的 SHA-256：先把 CRLF 换成 LF（Windows 上 git 检出可能转换换行；JSON 与 JS 的语义不受影响）。 */
  async function sha256Text(text) {
    var bytes = utf8(lf(text));
    var subtle = root.crypto && root.crypto.subtle;
    if (subtle && typeof subtle.digest === 'function') {
      try {
        var digest = new Uint8Array(await subtle.digest('SHA-256', bytes)), out = '';
        for (var i = 0; i < digest.length; i++) out += (digest[i] < 16 ? '0' : '') + digest[i].toString(16);
        return out;
      } catch (error) { /* 退回纯 JS */ }
    }
    return softwareSha256(bytes);
  }

  /* ---------- 版本号：语义化版本，带预发布段（4.0.0-alpha.1 < 4.0.0-alpha.2 < 4.0.0-beta.1 < 4.0.0 < 4.0.1） ---------- */
  function parseVersion(value) {
    var m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value == null ? '' : value).trim());
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null;
  }

  function compareVersions(a, b) {
    var x = parseVersion(a), y = parseVersion(b);
    if (!x || !y) throw new Error('版本号格式不对：' + (!x ? a : b));
    for (var i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
      if (i >= x.pre.length) return -1;
      if (i >= y.pre.length) return 1;
      var p = x.pre[i], q = y.pre[i], pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
      if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1; }
      else if (pn !== qn) return pn ? -1 : 1;
      else if (p !== q) return p < q ? -1 : 1;
    }
    return 0;
  }

  function normalizeBase(url) {
    var text = String(url == null ? '' : url).trim();
    if (!/^https?:\/\/[^\s/]+/i.test(text)) throw new Error('更新源要写完整的 http(s) 地址：' + text);
    return /\/$/.test(text) ? text : text + '/';
  }

  /* 按键排序的 JSON：用来判断世界书在检查之后有没有被动过。 */
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().filter(function (key) { return value[key] !== undefined; }).map(function (key) { return JSON.stringify(key) + ':' + stable(value[key]); }).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  /* ---------- 更新器 ---------- */
  function createUpdater(env, kit) {
    var host = env.host;
    var NAMESPACE = 'reader_ii', LOCAL_KEY = 'reader_ii_updates_v1';
    var clone = function (value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); };
    var applying = false;

    function message(error) { return String(error && error.message || error); }
    function fail(code, text) { var error = new Error(text); error.code = code; return error; }
    function changed(label) { return fail('changed', label + '在检查之后有了变化，为了不覆盖新的改动，这次没有写入。请重新点「检查卡内组件」'); }
    function scopeLabel(scope) { return scope === 'global' ? '全局' : scope === 'preset' ? '预设' : '当前角色卡'; }
    function context() { return kit.context(); }
    function currentCharacter() {
      var ctx = context();
      return ctx && ctx.characters && ctx.characterId !== undefined && ctx.characterId !== null ? ctx.characters[ctx.characterId] || null : null;
    }

    /* 设置：extension_settings.reader_ii.updates（随酒馆账号）；拿不到时退回 localStorage。 */
    function readBag() {
      var ctx = context();
      var bag = ctx && ctx.extensionSettings && ctx.extensionSettings[NAMESPACE];
      if (bag && modules.isObject(bag.updates)) return bag.updates;
      return kit.localRead(LOCAL_KEY, {}) || {};
    }
    function writeBag(value) {
      kit.localWrite(LOCAL_KEY, value);
      var ctx = context();
      if (!ctx || !ctx.extensionSettings) return;
      ctx.extensionSettings[NAMESPACE] = Object.assign({}, ctx.extensionSettings[NAMESPACE], { updates: value });
      if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    }
    function getSettings() {
      var bag = readBag();
      return {
        remotes: Array.isArray(bag.remotes) && bag.remotes.length ? bag.remotes.map(String) : DEFAULT_REMOTES.slice(),
        book: typeof bag.book === 'string' ? bag.book : '',
        scope: bag.scope === 'global' ? 'global' : 'character',
        lastCheck: bag.lastCheck || null,
        installed: bag.installed || null
      };
    }
    function saveSettings(patch) {
      var next = Object.assign({}, readBag(), patch || {});
      if (patch && patch.remotes !== undefined) {
        var items = Array.isArray(patch.remotes) ? patch.remotes : String(patch.remotes || '').split(/\s+/);
        next.remotes = items.map(function (item) { return String(item).trim(); }).filter(Boolean).map(normalizeBase);
        if (!next.remotes.length) delete next.remotes;
      }
      writeBag(next);
      return getSettings();
    }

    function runningVersion() { return String(modules.BUILD_VERSION || modules.READER_AGENT_VERSION || ''); }
    function carrier() { return host.__ReaderIICdn === true ? 'cdn' : host.__ReaderIIBase ? 'extension' : 'unknown'; }

    async function fetchText(url) {
      if (typeof host.fetch !== 'function') throw fail('download', '当前环境不能联网');
      var controller = typeof host.AbortController === 'function' ? new host.AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 30000) : null;
      try {
        var response = await host.fetch(url, { cache: 'no-store', signal: controller ? controller.signal : undefined });
        if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : '无响应'));
        return await response.text();
      } catch (error) {
        throw fail('download', url + ' 下载失败：' + (error && error.name === 'AbortError' ? '超时' : message(error)));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    /* ---------- ① 扩展本体：比对远端 manifest.json ---------- */
    async function checkRemote() {
      var current = runningVersion(), errors = [], remotes = getSettings().remotes;
      for (var i = 0; i < remotes.length; i++) {
        var base = remotes[i];
        try {
          base = normalizeBase(base);
          var text = await fetchText(base + 'manifest.json'), manifest;
          try { manifest = JSON.parse(text); } catch (error) { throw new Error('manifest.json 不是合法的 JSON'); }
          if (!manifest || typeof manifest.version !== 'string') throw new Error('manifest.json 里没有版本号');
          var order = compareVersions(manifest.version, current);
          var result = { ok: true, current: current, latest: manifest.version, source: base, status: order > 0 ? 'newer' : order < 0 ? 'older' : 'same', carrier: carrier(), errors: errors };
          saveSettings({ lastCheck: { at: Date.now(), latest: manifest.version, status: result.status, source: base } });
          return result;
        } catch (error) {
          errors.push(base + ' —— ' + message(error));
        }
      }
      return { ok: false, current: current, status: 'failed', carrier: carrier(), errors: errors };
    }

    /* ---------- ② 卡内组件：下载并校验 ---------- */
    function sources() {
      var out = [], add = function (url) { try { url = normalizeBase(url); if (out.indexOf(url) < 0) out.push(url); } catch (error) { /* 不是完整地址的跳过 */ } };
      if (typeof host.__ReaderIIBase === 'string') add(host.__ReaderIIBase);
      getSettings().remotes.forEach(add);
      return out;
    }

    function checkManifest(manifest) {
      var c = manifest && manifest.components;
      var ok = manifest && manifest.format === 1 && typeof manifest.version === 'string' && modules.isObject(manifest.files) && c
        && c.script && c.loader && Array.isArray(c.regex) && c.worldbook && Array.isArray(c.worldbook.entries);
      if (!ok) throw fail('verify', '清单 ' + MANIFEST_FILE + ' 的格式不对');
    }

    async function expectFingerprint(payload, expected, label) {
      if (await sha256Text(payload) !== expected) throw fail('verify', label + ' 的指纹与清单不符');
    }

    async function downloadAll(base, manifest) {
      var c = manifest.components;
      var wanted = [c.script.file, c.loader.file].concat(c.regex.map(function (item) { return item.file; }), [c.worldbook.file]);
      var texts = {};
      /* 依次下载：一个失败就停下，不发多余的请求。 */
      for (var i = 0; i < wanted.length; i++) {
        var file = wanted[i], meta = manifest.files[file];
        if (!meta || typeof meta.sha256 !== 'string') throw fail('verify', file + ' 不在清单里');
        var text = await fetchText(base + file);
        if (await sha256Text(text) !== meta.sha256) throw fail('verify', file + ' 校验失败：内容与清单里的 SHA-256 不符（可能没下载完整，或镜像上还是旧文件）');
        texts[file] = text;
      }
      var parse = function (name) { try { return JSON.parse(texts[name]); } catch (error) { throw fail('verify', name + ' 不是合法的 JSON'); } };
      var script = parse(c.script.file), loader = parse(c.loader.file), book = parse(c.worldbook.file);
      if (!script || script.id !== c.script.id || !loader || loader.id !== c.loader.id) throw fail('verify', '脚本 id 与清单不符');
      await expectFingerprint(scriptPayload(script), c.script.fingerprint, c.script.file);
      await expectFingerprint(scriptPayload(loader), c.loader.fingerprint, c.loader.file);
      var regex = [];
      for (i = 0; i < c.regex.length; i++) {
        var item = parse(c.regex[i].file);
        if (!item || item.id !== c.regex[i].id) throw fail('verify', c.regex[i].file + ' 的 id 与清单不符');
        await expectFingerprint(regexPayload(item), c.regex[i].fingerprint, c.regex[i].file);
        regex.push(item);
      }
      var entries = book && modules.isObject(book.entries) ? Object.keys(book.entries).map(function (key) { return book.entries[key]; }) : [];
      if (entries.length !== c.worldbook.entries.length) throw fail('verify', '世界书的条目数与清单不符');
      for (i = 0; i < entries.length; i++) {
        if (entryName(entries[i]) !== c.worldbook.entries[i].name) throw fail('verify', '世界书第 ' + (i + 1) + ' 个条目的名字与清单不符');
        await expectFingerprint(entryPayload(entries[i]), c.worldbook.entries[i].fingerprint, '世界书条目「' + c.worldbook.entries[i].name + '」');
      }
      return { script: script, loader: loader, regex: regex, entries: entries };
    }

    async function loadRelease() {
      var version = runningVersion(), errors = [], verifyFailed = false, list = sources();
      for (var i = 0; i < list.length; i++) {
        var base = list[i];
        try {
          var text = await fetchText(base + MANIFEST_FILE), manifest;
          try { manifest = JSON.parse(text); } catch (error) { throw fail('verify', MANIFEST_FILE + ' 不是合法的 JSON'); }
          checkManifest(manifest);
          if (manifest.version !== version) throw fail('version', '那里的版本是 ' + manifest.version + '，与正在运行的扩展（' + version + '）不同');
          return { base: base, manifest: manifest, payloads: await downloadAll(base, manifest) };
        } catch (error) {
          if (error.code === 'verify') verifyFailed = true;
          errors.push(base + ' —— ' + message(error));
        }
      }
      if (!list.length) errors.push('没有可用的来源（扩展地址未知，更新源也是空的）');
      throw fail(verifyFailed ? 'verify' : 'download', (verifyFailed ? '卡内组件校验失败' : '卡内组件下载失败') + '，宿主没有任何改动。\n' + errors.join('\n'));
    }

    /* 指纹 → 版本：当前版本优先，再到历史版本。 */
    function knownTables(manifest) {
      var t = { script: {}, loader: {}, regex: {}, entry: {} };
      var add = function (table, fp, version) { if (typeof fp === 'string' && !table[fp]) table[fp] = version; };
      var addAll = function (snapshot, version) {
        if (!snapshot) return;
        add(t.script, snapshot.script, version);
        add(t.loader, snapshot.loader, version);
        Object.keys(snapshot.regex || {}).forEach(function (id) { add(t.regex[id] = t.regex[id] || {}, snapshot.regex[id], version); });
        Object.keys(snapshot.worldbook || {}).forEach(function (name) { add(t.entry[name] = t.entry[name] || {}, snapshot.worldbook[name], version); });
      };
      addAll(compactComponents(manifest.components), manifest.version);
      Object.keys(manifest.history || {}).forEach(function (version) { addAll(manifest.history[version], version); });
      return t;
    }

    /* ---------- 酒馆助手脚本库 ---------- */
    async function readTrees(scope) {
      try { var trees = await kit.fn('getScriptTrees')({ type: scope }); return Array.isArray(trees) ? trees : null; } catch (error) { return null; }
    }
    function findNode(nodes, id) {
      for (var i = 0; i < (nodes || []).length; i++) {
        var node = nodes[i];
        if (!node) continue;
        if (node.type === 'folder') { var inner = findNode(node.scripts, id); if (inner) return inner; continue; }
        if (node.id === id) return { node: node, list: nodes, index: i };
      }
      return null;
    }
    function eachScript(nodes, visit) {
      (nodes || []).forEach(function (node) { if (!node) return; if (node.type === 'folder') eachScript(node.scripts, visit); else visit(node); });
    }
    function bannerVersion(content) { var m = /^\/\*! Reader-II (\S+) · /.exec(String(content || '')); return m ? m[1] : ''; }

    async function scanScript(id, table) {
      for (var i = 0; i < SCRIPT_SCOPES.length; i++) {
        var trees = await readTrees(SCRIPT_SCOPES[i]), hit = trees && findNode(trees, id);
        if (!hit) continue;
        var fp = await sha256Text(scriptPayload(hit.node));
        return { found: true, scope: SCRIPT_SCOPES[i], version: table[fp] || null, banner: bannerVersion(hit.node.content), content: String(hit.node.content || '') };
      }
      return { found: false };
    }

    async function findLegacy() {
      for (var i = 0; i < SCRIPT_SCOPES.length; i++) {
        var trees = await readTrees(SCRIPT_SCOPES[i]), found = null;
        eachScript(trees, function (node) {
          if (!found && node.enabled !== false && (LEGACY_SCRIPT_IDS.indexOf(node.id) >= 0 || /^Reader-II主系统-v3/.test(String(node.name || '')))) found = { name: String(node.name || ''), scope: SCRIPT_SCOPES[i] };
        });
        if (found) return found;
      }
      return null;
    }

    function newScript(payload) {
      return { type: 'script', enabled: true, name: payload.name, id: payload.id, content: payload.content, info: payload.info || '', button: clone(payload.button || { enabled: false, buttons: [] }), data: {} };
    }

    /* 换内容与说明；开关、脚本变量（data）、按钮的显示与否保留玩家的；名字没改过（还是默认的带版本号的名字）才跟着换。 */
    function mergeScript(node, payload) {
      node.content = payload.content;
      node.info = payload.info || '';
      if (/^Reader-II(主系统|夜梦助手加载器)-v/.test(String(node.name || ''))) node.name = payload.name;
      var old = node.button || {}, visible = {};
      (old.buttons || []).forEach(function (button) { if (button && button.name) visible[button.name] = button.visible !== false; });
      var shipped = payload.button || { enabled: false, buttons: [] };
      node.button = {
        enabled: old.enabled !== undefined ? old.enabled : shipped.enabled,
        buttons: (shipped.buttons || []).map(function (button) { return { name: button.name, visible: visible[button.name] !== undefined ? visible[button.name] : button.visible !== false }; })
      };
    }

    function scriptStep(label, comp, payload, scan, scope) {
      var install = !scan.found, before = null;
      return {
        label: label,
        verify: async function () {
          if (install) { if ((await scanScript(comp.id, {})).found) throw changed(label); return; }
          var trees = await readTrees(scope), hit = trees && findNode(trees, comp.id);
          if (!hit || String(hit.node.content || '') !== scan.content) throw changed(label);
        },
        run: async function () {
          var update = kit.fn('updateScriptTreesWith');
          await update(function (trees) {
            var nodes = Array.isArray(trees) ? trees : [], hit = findNode(nodes, comp.id);
            if (install) { if (hit) throw changed(label); nodes.push(newScript(payload)); return nodes; }
            if (!hit || String(hit.node.content || '') !== scan.content) throw changed(label);
            before = clone(hit.node);
            mergeScript(hit.node, payload);
            return nodes;
          }, { type: scope });
          return async function () {
            await update(function (trees) {
              var nodes = Array.isArray(trees) ? trees : [], hit = findNode(nodes, comp.id);
              if (hit && install) hit.list.splice(hit.index, 1);
              else if (hit && before) hit.list[hit.index] = before;
              return nodes;
            }, { type: scope });
          };
        }
      };
    }

    /* ---------- 正则：直接读写酒馆自己的结构（不经酒馆助手转换，不会丢别的正则的字段） ---------- */
    function regexStore(scope) {
      var ctx = context();
      if (!ctx) return null;
      if (scope === 'global') return ctx.extensionSettings ? { list: Array.isArray(ctx.extensionSettings.regex) ? ctx.extensionSettings.regex : [], writable: true } : null;
      var character = currentCharacter();
      if (!character) return null;
      var ext = character.data && character.data.extensions;
      return { list: ext && Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [], writable: typeof ctx.writeExtensionField === 'function' };
    }
    function indexById(items, id) {
      for (var i = 0; i < items.length; i++) if (items[i] && items[i].id === id) return i;
      return -1;
    }
    function findRegex(id) {
      var scopes = ['global', 'character'];
      for (var i = 0; i < scopes.length; i++) {
        var store = regexStore(scopes[i]), index = store ? indexById(store.list, id) : -1;
        if (index >= 0) return { scope: scopes[i], item: store.list[index], writable: store.writable };
      }
      return null;
    }
    async function writeRegexes(scope, mutate) {
      var ctx = context();
      if (scope === 'global') {
        if (!Array.isArray(ctx.extensionSettings.regex)) ctx.extensionSettings.regex = [];
        mutate(ctx.extensionSettings.regex);
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        return;
      }
      var character = currentCharacter(), ext = character && character.data && character.data.extensions;
      var next = clone((ext && ext.regex_scripts) || []);
      mutate(next);
      await ctx.writeExtensionField(ctx.characterId, 'regex_scripts', next);
    }

    function regexStep(label, comp, payload, scan) {
      var install = !scan, scope = install ? 'global' : scan.scope, before = null;
      return {
        label: label,
        verify: async function () {
          var now = findRegex(comp.id);
          if (install ? !!now : (!now || now.scope !== scope || regexPayload(now.item) !== scan.payload)) throw changed(label);
          if (install && !regexStore('global')) throw fail('env', label + '：拿不到酒馆的全局正则设置');
        },
        run: async function () {
          await writeRegexes(scope, function (items) {
            if (install) { items.push(clone(payload)); return; }
            var index = indexById(items, comp.id);
            if (index < 0 || regexPayload(items[index]) !== scan.payload) throw changed(label);
            before = clone(items[index]);
            items[index] = Object.assign(clone(items[index]), { findRegex: payload.findRegex, replaceString: payload.replaceString, trimStrings: clone(payload.trimStrings || []) });
          });
          return async function () {
            await writeRegexes(scope, function (items) {
              var index = indexById(items, comp.id);
              if (index < 0) return;
              if (install) items.splice(index, 1); else items[index] = before;
            });
          };
        }
      };
    }

    /* ---------- 世界书：酒馆原生接口整本读写（一本书只存一次，失败时整本写回快照） ---------- */
    async function loadBook(name) {
      try { var data = await context().loadWorldInfo(String(name)); return data && modules.isObject(data.entries) ? data : null; } catch (error) { return null; }
    }
    function rawEntries(data) { return Object.keys(data.entries).map(function (key) { return data.entries[key]; }).filter(Boolean); }
    function bookNames() { try { return kit.worldbookNames() || []; } catch (error) { return []; } }
    /* 酒馆读不存在的书会返回空壳 {entries:{}}：列得出书名时按书名判断，列不出时看有没有条目。 */
    async function bookExists(name) {
      var names = bookNames();
      if (names.length) return names.indexOf(name) >= 0;
      var data = await loadBook(name);
      return !!(data && rawEntries(data).length);
    }
    function refreshEditor(name) {
      var ctx = context();
      if (ctx && typeof ctx.reloadWorldInfoEditor === 'function') { try { ctx.reloadWorldInfoEditor(String(name)); } catch (error) { /* 编辑器没开 */ } }
    }

    async function locateBook(comp, settings) {
      var names = bookNames(), wanted = [settings.book, comp.book].filter(Boolean), i;
      for (i = 0; i < wanted.length; i++) if (names.indexOf(wanted[i]) >= 0) return wanted[i];
      var bound = [];
      try {
        var s = kit.worldbookScopes();
        bound = [s.character_primary].concat(s.character_additional || [], [s.chat], s.global || []).filter(Boolean);
      } catch (error) { bound = []; }
      if (!names.length) bound = wanted.concat(bound);
      var managed = comp.entries.map(function (item) { return item.name; });
      for (i = 0; i < bound.length; i++) {
        var data = await loadBook(bound[i]);
        if (data && rawEntries(data).some(function (raw) { return managed.indexOf(entryName(raw)) >= 0; })) return bound[i];
      }
      return null;
    }

    /* 逐条认领：先按条目名，名字改过的再按「内容与某个发布版本相同」认。 */
    async function analyzeBook(data, comp, known, version) {
      var raws = rawEntries(data), fps = {}, used = {}, i;
      for (i = 0; i < raws.length; i++) fps[raws[i].uid] = await sha256Text(entryPayload(raws[i]));
      var managed = comp.entries.map(function (item) { return item.name; });
      var free = function (raw) { return !used[raw.uid]; };
      var entries = comp.entries.map(function (item, index) {
        var table = known.entry[item.name] || {};
        var hit = raws.filter(function (raw) { return free(raw) && entryName(raw) === item.name; })[0]
          || raws.filter(function (raw) { return free(raw) && !derived(entryName(raw)) && managed.indexOf(entryName(raw)) < 0 && table[fps[raw.uid]]; })[0];
        if (!hit) return { name: item.name, index: index, status: 'missing' };
        used[hit.uid] = true;
        var from = table[fps[hit.uid]] || null;
        var record = { name: item.name, index: index, uid: hit.uid, from: from, status: !from ? 'modified' : from === version ? 'current' : 'outdated' };
        if (record.status === 'modified') {
          record.sideReady = raws.some(function (raw) { return sideOf(entryName(raw), item.name) === version && fps[raw.uid] === item.fingerprint; });
        }
        return record;
      });
      var retired = Object.keys(known.entry).filter(function (name) { return managed.indexOf(name) < 0; }).map(function (name) {
        var hit = raws.filter(function (raw) { return free(raw) && entryName(raw) === name; })[0];
        if (!hit) return null;
        used[hit.uid] = true;
        var from = known.entry[name][fps[hit.uid]] || null;
        return { name: name, uid: hit.uid, from: from, status: from ? 'retire' : 'retired-modified' };
      }).filter(Boolean);
      return { entries: entries, retired: retired, fps: fps };
    }

    function bookNeedsWork(analysis) {
      return analysis.entries.some(function (e) { return e.status === 'missing' || e.status === 'outdated' || (e.status === 'modified' && !e.sideReady); })
        || analysis.retired.some(function (r) { return r.status === 'retire'; });
    }

    function mutateBook(data, analysis, shipped, known, version) {
      var next = clone(data), entries = next.entries;
      var nextUid = Object.keys(entries).reduce(function (max, key) { return Math.max(max, Number(entries[key] && entries[key].uid) || 0, Number(key) || 0); }, -1) + 1;
      var pristine = function (raw, name) { return !!(known.entry[name] || {})[analysis.fps[raw.uid]]; };
      var add = function (raw) { var copy = clone(raw); copy.uid = nextUid; entries[nextUid] = copy; nextUid += 1; return copy; };
      var drop = function (test) { Object.keys(entries).forEach(function (key) { if (entries[key] && test(entries[key])) delete entries[key]; }); };
      /* 旧条目改名为停用的备份；同一条目更早的、没被改过的备份删掉，只留最新一份。 */
      var backup = function (uid, name, from) {
        drop(function (raw) { return raw.uid !== uid && backupOf(entryName(raw), name) && pristine(raw, name); });
        var raw = entries[uid];
        raw.comment = backupName(from, name);
        raw.disable = true;
      };
      analysis.entries.forEach(function (record) {
        var source = shipped[record.index];
        if (record.status === 'missing') { add(source); return; }
        if (record.status === 'outdated') {
          var off = entries[record.uid].disable === true;
          backup(record.uid, record.name, record.from);
          add(source).disable = off;   /* 玩家关掉的条目，新版也关着 */
          return;
        }
        if (record.status === 'modified' && !record.sideReady) {
          drop(function (raw) { return sideOf(entryName(raw), record.name) && pristine(raw, record.name); });
          var side = add(source);
          side.comment = sideName(version, record.name);
          side.disable = true;
        }
      });
      analysis.retired.forEach(function (record) { if (record.status === 'retire') backup(record.uid, record.name, record.from); });
      return next;
    }

    function bookStep(label, book, analysis, shipped, known, version) {
      return {
        label: label,
        verify: async function () {
          var data = await loadBook(book);
          if (!data || stable(data.entries) !== analysis.snapshot) throw changed(label);
        },
        run: async function () {
          var ctx = context(), data = await loadBook(book);
          if (!data || stable(data.entries) !== analysis.snapshot) throw changed(label);
          var before = clone(data);
          await ctx.saveWorldInfo(book, mutateBook(data, analysis, shipped, known, version), true);
          refreshEditor(book);
          return async function () { await ctx.saveWorldInfo(book, before, true); refreshEditor(book); };
        }
      };
    }

    async function deleteBook(book) {
      var ctx = context();
      if (typeof ctx.deleteWorldInfo === 'function') { await ctx.deleteWorldInfo(book); return; }
      var headers = typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
      var response = await host.fetch('/api/worldinfo/delete', { method: 'POST', headers: headers, body: JSON.stringify({ name: book }) });
      if (!response || !response.ok) throw new Error('删不掉刚新建的世界书「' + book + '」');
      if (typeof ctx.updateWorldInfoList === 'function') { try { await ctx.updateWorldInfoList(); } catch (error) { /* 列表下次打开会刷新 */ } }
    }

    function createBookStep(label, book, shipped, scope) {
      return {
        label: label,
        verify: async function () { if (await bookExists(book)) throw changed(label); },
        run: async function (notes) {
          var ctx = context(), entries = {};
          shipped.forEach(function (raw, index) { var copy = clone(raw); copy.uid = index; entries[index] = copy; });
          await ctx.saveWorldInfo(book, { entries: entries }, true);
          if (typeof ctx.updateWorldInfoList === 'function') { try { await ctx.updateWorldInfoList(); } catch (error) { /* 列表下次打开会刷新 */ } }
          /* 挂到卡上要用酒馆助手；挂不上不算失败，提示玩家手动挂。 */
          try { await kit.mountWorldbook(book, scope === 'global' ? 'global' : 'character'); }
          catch (error) { notes.push('世界书「' + book + '」已新建，但没能自动挂上（' + message(error) + '）：请在' + (scope === 'global' ? '酒馆的全局世界书' : '角色卡的世界书设置') + '里手动挂上'); }
          return async function () { await deleteBook(book); };
        }
      };
    }

    /* ---------- 检查卡内组件：下载、校验、比对，得出要做的事（不写宿主） ---------- */
    async function inspect(options) {
      var settings = getSettings();
      var scope = options && (options.scope === 'global' || options.scope === 'character') ? options.scope : settings.scope;
      var release = await loadRelease();
      var manifest = release.manifest, version = manifest.version, comps = manifest.components, p = release.payloads;
      var known = knownTables(manifest);
      var items = [], steps = [], tail = [], kept = [], notes = [];
      var plan = { version: version, source: release.base, scope: scope, items: items, kept: kept, notes: notes, book: '' };

      /* 主脚本与加载器（酒馆助手脚本库） */
      var hasHelper = !!(kit.fn('getScriptTrees') && kit.fn('updateScriptTreesWith'));
      var legacy = hasHelper ? await findLegacy() : null;
      var addScript = async function (key, label, comp, payload, installable) {
        var item = { key: key, label: label, to: version };
        items.push(item);
        if (!hasHelper) { item.status = 'unavailable'; item.text = '需要酒馆助手；也可以手动导入 ' + comp.file; return; }
        var scan = await scanScript(comp.id, key === 'script' ? known.script : known.loader);
        if (!scan.found) {
          if (!installable) { item.status = 'missing'; item.text = '没装（可选，不代装）'; return; }
          if (legacy) { item.status = 'blocked'; item.text = '未安装；v3.3 的「' + legacy.name + '」还开着，两者不能同时启用：请先在酒馆助手里停用或删掉它，再回来安装'; return; }
          if (scope === 'character' && !currentCharacter()) { item.status = 'blocked'; item.text = '未安装；现在没有打开角色卡的聊天，装不进角色脚本（可以改装到全局）'; return; }
          item.status = 'missing'; item.action = 'install'; item.text = '未安装 → 安装到' + scopeLabel(scope) + '的脚本库';
          steps.push(scriptStep(label, comp, payload, scan, scope));
          return;
        }
        item.scope = scan.scope; item.from = scan.version || scan.banner || '';
        if (!scan.version) { item.status = 'modified'; item.text = '你改过（' + scopeLabel(scan.scope) + '），不覆盖；新版文件是 ' + comp.file + '，需要时手动对照'; kept.push(label); return; }
        if (scan.version === version) { item.status = 'current'; item.text = '已是 v' + version + '（' + scopeLabel(scan.scope) + '）'; return; }
        item.status = 'outdated'; item.action = 'update';
        item.text = 'v' + scan.version + ' → v' + version + '（' + scopeLabel(scan.scope) + '；保留开关、按钮显示与脚本变量）';
        steps.push(scriptStep(label, comp, payload, scan, scan.scope));
      };
      await addScript('script', '主脚本', comps.script, p.script, true);
      await addScript('loader', '夜梦助手加载器', comps.loader, p.loader, false);
      if (legacy && items[0].status !== 'blocked') notes.push('v3.3 的「' + legacy.name + '」还开着：与 4.0 主脚本不能同时启用，请在酒馆助手里停用或删掉它');

      /* 三条正则 */
      for (var r = 0; r < comps.regex.length; r++) {
        var comp = comps.regex[r], label = '正则「' + comp.name + '」', item = { key: 'regex:' + comp.id, label: label, to: version };
        items.push(item);
        var hit = findRegex(comp.id);
        if (!hit) {
          if (!regexStore('global')) { item.status = 'unavailable'; item.text = '拿不到酒馆的正则设置；可以手动导入 ' + comp.file; continue; }
          item.status = 'missing'; item.action = 'install'; item.text = '未安装 → 装进全局正则';
          steps.push(regexStep(label, comp, p.regex[r], null));
          continue;
        }
        var from = (known.regex[comp.id] || {})[await sha256Text(regexPayload(hit.item))] || null;
        item.scope = hit.scope; item.from = from || '';
        if (!from) { item.status = 'modified'; item.text = '你改过（' + scopeLabel(hit.scope) + '），不覆盖'; kept.push(label); }
        else if (from === version) { item.status = 'current'; item.text = '已是最新（' + scopeLabel(hit.scope) + '）'; }
        else if (!hit.writable) { item.status = 'unavailable'; item.text = 'v' + from + ' 可更新，但当前酒馆不能改角色卡的正则；可以手动导入 ' + comp.file; }
        else {
          item.status = 'outdated'; item.action = 'update'; item.text = 'v' + from + ' → v' + version + '（保留开关、作用范围与深度）';
          steps.push(regexStep(label, comp, p.regex[r], { scope: hit.scope, payload: regexPayload(hit.item) }));
        }
      }

      /* 世界书 */
      var wb = comps.worldbook, ctx = context();
      if (!ctx || typeof ctx.loadWorldInfo !== 'function' || typeof ctx.saveWorldInfo !== 'function') {
        items.push({ key: 'worldbook', label: '世界书', to: version, status: 'unavailable', text: '当前酒馆没有世界书接口；可以手动导入 ' + wb.file });
      } else {
        var book = await locateBook(wb, settings);
        if (!book) {
          plan.book = settings.book || wb.book;
          items.push({ key: 'worldbook', label: '世界书「' + plan.book + '」', to: version, status: 'missing', action: 'install', text: '未安装 → 新建（' + wb.entries.length + ' 个条目）并挂到' + scopeLabel(scope) });
          tail.push(createBookStep('世界书「' + plan.book + '」', plan.book, p.entries, scope));
        } else {
          plan.book = book;
          var data = await loadBook(book) || { entries: {} };
          var analysis = await analyzeBook(data, wb, known, version);
          analysis.snapshot = stable(data.entries);
          var lines = analysis.entries.map(function (e) {
            if (e.status === 'current') return '「' + e.name + '」已是最新';
            if (e.status === 'missing') return '「' + e.name + '」新增';
            if (e.status === 'outdated') return '「' + e.name + '」v' + e.from + ' → v' + version + '（旧条目改名为「' + backupName(e.from, e.name) + '」并停用）';
            kept.push('世界书条目「' + e.name + '」');
            return '「' + e.name + '」你改过，不覆盖' + (e.sideReady ? '' : '；新版另存为停用的「' + sideName(version, e.name) + '」供对照');
          }).concat(analysis.retired.map(function (e) {
            return e.status === 'retire' ? '「' + e.name + '」新版已不用，改名为备份并停用' : '「' + e.name + '」新版已不用；你改过它，保持原样，请自己决定要不要停用';
          }));
          var needs = bookNeedsWork(analysis);
          var anyModified = analysis.entries.some(function (e) { return e.status === 'modified'; });
          items.push({
            key: 'worldbook', label: '世界书「' + book + '」', to: version, details: lines,
            status: needs ? 'outdated' : anyModified ? 'modified' : 'current', action: needs ? 'update' : undefined,
            text: needs ? '要更新（' + lines.length + ' 个条目，见下）' : anyModified ? '有你改过的条目，没有别的要更新' : '已是 v' + version
          });
          if (needs) steps.unshift(bookStep('世界书「' + book + '」', book, analysis, p.entries, known, version));
        }
        if (bookNames().indexOf(LEGACY_BOOK) >= 0 && plan.book !== LEGACY_BOOK) {
          var active = false;
          try { active = kit.isWorldbookActive(LEGACY_BOOK); } catch (error) { active = false; }
          if (active) notes.push('v3.3 的世界书「' + LEGACY_BOOK + '」还挂着，会和 4.0 的核心重复注入：请把它从卡上解绑');
        }
      }

      steps.push.apply(steps, tail);
      Object.defineProperty(plan, 'steps', { value: steps, enumerable: false });
      plan.actions = steps.length;
      return plan;
    }

    /* ---------- 执行：全部核对 → 逐项写入；失败按快照逐项退回 ---------- */
    async function apply(plan) {
      if (!plan || !Array.isArray(plan.steps)) throw fail('state', '请先点「检查卡内组件」');
      if (plan.used) throw fail('state', '这份检查结果已经用过了，请重新检查');
      if (applying) throw fail('state', '正在更新，请稍候');
      applying = true;
      plan.used = true;
      var done = [], undos = [], notes = plan.notes.slice(), i;
      try {
        for (i = 0; i < plan.steps.length; i++) await plan.steps[i].verify();
        for (i = 0; i < plan.steps.length; i++) {
          var undo = await plan.steps[i].run(notes);
          undos.push({ label: plan.steps[i].label, undo: undo });
          done.push(plan.steps[i].label);
        }
      } catch (error) {
        var stuck = [];
        for (i = undos.length - 1; i >= 0; i--) {
          try { await undos[i].undo(); } catch (undoError) { stuck.push(undos[i].label + '（' + message(undoError) + '）'); }
        }
        var text = done.length
          ? '更新中途失败：' + message(error) + '。已写入的 ' + done.length + ' 项' + (stuck.length ? '里，下面这些没能退回，请手动检查：' + stuck.join('；') : '都已退回，宿主恢复原样')
          : '没有写入任何东西：' + message(error);
        var failure = fail(error.code || 'apply', text);
        failure.report = { ok: false, rolledBack: done.slice(), stuck: stuck };
        throw failure;
      } finally {
        applying = false;
      }
      if (done.length) saveSettings({ installed: { version: plan.version, at: Date.now(), book: plan.book || '', scope: plan.scope } });
      return { ok: true, version: plan.version, done: done, kept: plan.kept.slice(), notes: notes, reload: done.length > 0 };
    }

    return {
      get version() { return runningVersion(); },
      carrier: carrier,
      defaults: DEFAULT_REMOTES.slice(),
      getSettings: getSettings,
      saveSettings: saveSettings,
      checkRemote: checkRemote,
      inspect: inspect,
      apply: apply,
      compareVersions: compareVersions,
      sha256: sha256Text
    };
  }

  modules.updateCanon = {
    MANIFEST_FILE: MANIFEST_FILE, lf: lf, scriptPayload: scriptPayload, regexPayload: regexPayload, entryPayload: entryPayload,
    entryName: entryName, compactComponents: compactComponents, backupName: backupName, sideName: sideName
  };
  modules.compareVersions = compareVersions;
  modules.updateSha256 = sha256Text;
  modules.createUpdater = createUpdater;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/ui.js ---- */
(function (root) {
  'use strict';

  /*
   * 夜梦助手面板：对话 / 记忆 / 设置 三页，画在酒馆主文档里。
   * 用 <dialog>.showModal() 进入浏览器顶层，大厅与抽卡面板的 z-index 盖不住它；配色跟随读者当前主题。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var OVERLAY_ID = 'reader-agent-overlay';
  var STYLE_ID = 'reader-agent-style';
  var TYPE_ORDER = ['episode', 'fact', 'bond', 'howto'];

  var CSS = [
    '#reader-agent-overlay{--ra-bg:#1d1612;--ra-panel:#2a201a;--ra-panel2:#33271f;--ra-line:rgba(226,190,130,.22);--ra-ink:#f1e7d0;--ra-mute:#b9a88c;--ra-accent:#d9a85a;--ra-accent-ink:#2a1c0c;--ra-user:#3b2d22;--ra-ok:#8fbf8a;--ra-bad:#e08a7a;--ra-warn:#e2b25c;--ra-shadow:rgba(0,0,0,.55);',
    'position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:rgba(8,6,5,.62);color:var(--ra-ink);font:15px/1.6 "Noto Serif SC","Songti SC","Source Han Serif SC",serif;z-index:2147483647;overflow:hidden}',
    '#reader-agent-overlay::backdrop{background:rgba(8,6,5,.5)}',
    '#reader-agent-overlay[data-theme="summer"]{--ra-bg:#eaf6f8;--ra-panel:#fbfeff;--ra-panel2:#e3f1f5;--ra-line:rgba(40,120,150,.22);--ra-ink:#17323c;--ra-mute:#5b7a86;--ra-accent:#2f9fc4;--ra-accent-ink:#fff;--ra-user:#d4ecf4;--ra-ok:#2f8f6a;--ra-bad:#c9544a;--ra-warn:#b7791f;--ra-shadow:rgba(20,60,80,.25);background:rgba(190,225,235,.5)}',
    '#reader-agent-overlay[data-theme="ink"]{--ra-bg:#f3efe4;--ra-panel:#fbf8ef;--ra-panel2:#ece6d6;--ra-line:rgba(60,70,60,.24);--ra-ink:#262a26;--ra-mute:#6d7168;--ra-accent:#5d8f84;--ra-accent-ink:#fff;--ra-user:#e3ecdf;--ra-ok:#4d7f5d;--ra-bad:#a8423a;--ra-warn:#96702a;--ra-shadow:rgba(40,40,30,.28);background:rgba(120,120,105,.42)}',
    '#reader-agent-overlay *{box-sizing:border-box}',
    '#reader-agent-overlay .ra-shell{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(880px,94vw);height:min(760px,90vh);display:flex;flex-direction:column;background:var(--ra-bg);border:1px solid var(--ra-line);border-radius:14px;box-shadow:0 24px 70px var(--ra-shadow);overflow:hidden}',
    '#reader-agent-overlay .ra-head{display:flex;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid var(--ra-line);background:var(--ra-panel)}',
    '#reader-agent-overlay .ra-id{display:flex;flex-direction:column;line-height:1.25;min-width:0}',
    '#reader-agent-overlay .ra-id b{font-size:17px;letter-spacing:.06em}',
    '#reader-agent-overlay .ra-id i{font-style:normal;font-size:12px;color:var(--ra-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#reader-agent-overlay .ra-tabs{display:flex;gap:4px;margin-left:auto}',
    '#reader-agent-overlay button{font:inherit;color:inherit;cursor:pointer}',
    '#reader-agent-overlay .ra-tab{padding:6px 14px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-tab[aria-selected="true"]{border-color:var(--ra-line);background:var(--ra-panel2);color:var(--ra-ink)}',
    '#reader-agent-overlay .ra-close{width:34px;height:34px;border:1px solid var(--ra-line);border-radius:50%;background:transparent;font-size:18px;line-height:1}',
    '#reader-agent-overlay .ra-pane{flex:1;min-height:0;display:none;flex-direction:column}',
    '#reader-agent-overlay .ra-pane.is-on{display:flex}',
    '#reader-agent-overlay .ra-log{flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}',
    '#reader-agent-overlay .ra-msg{max-width:86%;padding:9px 13px;border-radius:12px;white-space:pre-wrap;word-break:break-word}',
    '#reader-agent-overlay .ra-ai{align-self:flex-start;background:var(--ra-panel);border:1px solid var(--ra-line);border-top-left-radius:4px}',
    '#reader-agent-overlay .ra-user{align-self:flex-end;background:var(--ra-user);border-top-right-radius:4px}',
    '#reader-agent-overlay .ra-thought{align-self:flex-start;max-width:86%;color:var(--ra-mute);font-size:13.5px;padding:0 4px;white-space:pre-wrap}',
    '#reader-agent-overlay .ra-msg code{font:13px/1.5 ui-monospace,Consolas,monospace;background:var(--ra-panel2);padding:1px 5px;border-radius:4px}',
    '#reader-agent-overlay .ra-msg pre{margin:6px 0;padding:8px 10px;background:var(--ra-panel2);border-radius:8px;overflow-x:auto;font:13px/1.5 ui-monospace,Consolas,monospace;white-space:pre}',
    '#reader-agent-overlay .ra-step{align-self:flex-start;max-width:92%;font-size:13px;color:var(--ra-mute);border-left:2px solid var(--ra-line);padding:2px 0 2px 10px}',
    '#reader-agent-overlay .ra-step summary{cursor:pointer;list-style:none;display:flex;gap:8px;align-items:baseline}',
    '#reader-agent-overlay .ra-step summary::-webkit-details-marker{display:none}',
    '#reader-agent-overlay .ra-step .st{flex:none;font-weight:700}',
    '#reader-agent-overlay .ra-step[data-state="run"] .st{color:var(--ra-warn)}',
    '#reader-agent-overlay .ra-step[data-state="ok"] .st{color:var(--ra-ok)}',
    '#reader-agent-overlay .ra-step[data-state="bad"] .st{color:var(--ra-bad)}',
    '#reader-agent-overlay .ra-step pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Consolas,monospace;max-height:180px;overflow:auto}',
    '#reader-agent-overlay .ra-confirm{align-self:stretch;border:1px solid var(--ra-warn);border-radius:10px;padding:10px 12px;background:var(--ra-panel)}',
    '#reader-agent-overlay .ra-confirm.is-danger{border-color:var(--ra-bad)}',
    '#reader-agent-overlay .ra-confirm h4{margin:0 0 4px;font-size:14px}',
    '#reader-agent-overlay .ra-confirm pre{margin:6px 0;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Consolas,monospace;color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
    '#reader-agent-overlay .ra-btn{padding:6px 14px;border:1px solid var(--ra-line);border-radius:8px;background:var(--ra-panel2)}',
    '#reader-agent-overlay .ra-btn.is-main{background:var(--ra-accent);border-color:var(--ra-accent);color:var(--ra-accent-ink)}',
    '#reader-agent-overlay .ra-btn.is-bad{border-color:var(--ra-bad);color:var(--ra-bad);background:transparent}',
    '#reader-agent-overlay .ra-btn:disabled{opacity:.5;cursor:default}',
    '#reader-agent-overlay .ra-btn.is-small{padding:3px 9px;font-size:12.5px}',
    '#reader-agent-overlay .ra-quick{display:flex;gap:6px;padding:0 16px 8px;flex-wrap:wrap}',
    '#reader-agent-overlay .ra-chip{padding:3px 11px;border:1px solid var(--ra-line);border-radius:999px;background:transparent;font-size:12.5px;color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-chip[aria-pressed="true"]{background:var(--ra-accent);border-color:var(--ra-accent);color:var(--ra-accent-ink)}',
    '#reader-agent-overlay .ra-input{display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--ra-line);background:var(--ra-panel)}',
    '#reader-agent-overlay textarea,#reader-agent-overlay input[type=text],#reader-agent-overlay input[type=number],#reader-agent-overlay input[type=search],#reader-agent-overlay select{font:inherit;color:var(--ra-ink);background:var(--ra-bg);border:1px solid var(--ra-line);border-radius:8px;padding:7px 9px;min-width:0}',
    '#reader-agent-overlay .ra-input textarea{flex:1;height:64px;resize:none}',
    '#reader-agent-overlay .ra-foot{display:flex;gap:10px;align-items:center;padding:6px 16px 10px;font-size:12px;color:var(--ra-mute);background:var(--ra-panel)}',
    '#reader-agent-overlay .ra-foot span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media (max-width:560px){.ra-foot span{white-space:normal}}',
    '#reader-agent-overlay .ra-scroll{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;overscroll-behavior:contain}',
    '#reader-agent-overlay .ra-card{border:1px solid var(--ra-line);border-radius:10px;background:var(--ra-panel);padding:11px 13px;margin-bottom:10px}',
    '#reader-agent-overlay .ra-card h3{margin:0 0 8px;font-size:14.5px;letter-spacing:.04em}',
    '#reader-agent-overlay .ra-upd-list{margin:6px 0;padding-left:20px}',
    '#reader-agent-overlay .ra-upd-list li{margin:3px 0}',
    '#reader-agent-overlay .ra-upd-ok{color:var(--ra-accent)}',
    '#reader-agent-overlay .ra-upd-bad{color:#d9775f}',
    '#reader-agent-overlay .ra-note{font-size:12.5px;color:var(--ra-mute);margin:4px 0}',
    '#reader-agent-overlay .ra-mem{border:1px solid var(--ra-line);border-radius:10px;background:var(--ra-panel);padding:9px 12px;margin-bottom:8px}',
    '#reader-agent-overlay .ra-mem-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}',
    '#reader-agent-overlay .ra-badge{flex:none;font-size:12px;padding:0 7px;border-radius:5px;border:1px solid var(--ra-line);color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-badge.t-episode{color:var(--ra-accent);border-color:var(--ra-accent)}',
    '#reader-agent-overlay .ra-badge.t-bond{color:var(--ra-bad);border-color:var(--ra-bad)}',
    '#reader-agent-overlay .ra-badge.t-fact{color:var(--ra-ok);border-color:var(--ra-ok)}',
    '#reader-agent-overlay .ra-badge.t-howto{color:var(--ra-warn);border-color:var(--ra-warn)}',
    '#reader-agent-overlay .ra-mem-title{font-weight:700;flex:1;min-width:120px}',
    '#reader-agent-overlay .ra-mem-body{margin:5px 0;white-space:pre-wrap;word-break:break-word;font-size:14px}',
    '#reader-agent-overlay .ra-mem-keys{font-size:12px;color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-form{display:grid;grid-template-columns:110px 1fr;gap:8px 10px;align-items:center}',
    '#reader-agent-overlay .ra-form label{font-size:13.5px;color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-form textarea{width:100%;min-height:92px;resize:vertical}',
    '#reader-agent-overlay .ra-form input[type=text],#reader-agent-overlay .ra-form select{width:100%}',
    '#reader-agent-overlay .ra-form .wide{grid-column:1/-1}',
    '#reader-agent-overlay .ra-check{display:flex;gap:8px;align-items:center;font-size:14px}',
    '#reader-agent-overlay .ra-status{font-size:12.5px;color:var(--ra-mute);min-height:1.4em}',
    '#reader-agent-overlay .ra-status.is-bad{color:var(--ra-bad)}',
    '#reader-agent-overlay .ra-dots::after{content:"…";animation:ra-dots 1.2s steps(3,end) infinite}',
    '@keyframes ra-dots{0%{content:"."}33%{content:".."}66%{content:"…"}}',
    '@media(max-width:640px){#reader-agent-overlay .ra-shell{width:100vw;height:100%;max-height:none;border-radius:0;border:0}#reader-agent-overlay .ra-head{flex-wrap:wrap;gap:8px}#reader-agent-overlay .ra-tabs{order:3;width:100%;margin-left:0}#reader-agent-overlay .ra-tab{flex:1}#reader-agent-overlay .ra-close{margin-left:auto}#reader-agent-overlay .ra-form{grid-template-columns:1fr}#reader-agent-overlay .ra-msg{max-width:94%}}',
    '@media(prefers-reduced-motion:reduce){#reader-agent-overlay .ra-dots::after{animation:none}}'
  ].join('');

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  /* 只做最少的排版：代码块、行内代码、加粗；其余按原样换行显示。 */
  function rich(text) {
    var parts = String(text == null ? '' : text).split(/```/);
    return parts.map(function (part, index) {
      if (index % 2 === 1) return '<pre>' + esc(part.replace(/^[A-Za-z0-9_-]*\n/, '')) + '</pre>';
      return esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    }).join('');
  }

  function createAgentUi(env, kit, agent, memory, llm, deps) {
    var doc = env.document;
    var overlay = null;
    var tab = 'chat';
    var running = false;
    var pendingConfirms = [];
    var memoryFilter = { type: '', store: '', query: '' };
    var editing = null;
    var unsubscribe = [];

    function themeName() {
      var value = kit.readChatValue('dream_visual_theme');
      if (value !== 'summer' && value !== 'ink' && value !== 'cafe') {
        try { value = env.storage && env.storage.getItem(modules.localKey('dream_visual_theme')); } catch (error) { value = ''; }
      }
      return value === 'summer' || value === 'ink' ? value : 'cafe';
    }

    function ensureStyle() {
      var style = doc.getElementById(STYLE_ID);
      if (!style) {
        style = doc.createElement('style');
        style.id = STYLE_ID;
        (doc.head || doc.documentElement).appendChild(style);
      }
      if (style.textContent !== CSS) style.textContent = CSS;
    }

    function $(selector) { return overlay ? overlay.querySelector(selector) : null; }

    function toast(message, bad) {
      var target = $('[data-ra-status="' + tab + '"]');
      if (!target) return;
      target.textContent = message || '';
      target.classList.toggle('is-bad', !!bad);
    }

    /* ---------- 对话页 ---------- */
    function logNode() { return $('#ra-log'); }

    function append(html, className) {
      var log = logNode();
      if (!log) return null;
      var stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      var node = doc.createElement('div');
      node.className = className;
      node.innerHTML = html;
      log.appendChild(node);
      if (stick) log.scrollTop = log.scrollHeight;
      return node;
    }

    function clearIndicator() {
      var node = $('#ra-thinking');
      if (node) node.remove();
    }

    function showIndicator(label) {
      clearIndicator();
      var node = append('<span class="ra-dots">' + esc(label) + '</span>', 'ra-thought');
      if (node) node.id = 'ra-thinking';
    }

    function renderHistory() {
      var log = logNode();
      if (!log) return;
      log.innerHTML = '';
      var turns = agent.getHistory();
      if (!turns.length) {
        var persona = agent.personaContext();
        append(rich(persona.id === 'genki' ? '来啦！要查什么、改什么，还是随便聊聊？交给我！'
          : persona.id === 'weirdo' ? '……啊，你打开了这一页。那么，今天要拜托我什么？'
          : '我在这里。需要我替您查看卡里的资料、整理记忆，或者只是说说话，都可以。'), 'ra-msg ra-ai');
        return;
      }
      turns.forEach(function (turn) {
        append(rich(turn.text), 'ra-msg ' + (turn.role === 'assistant' ? 'ra-ai' : 'ra-user'));
        if (turn.tools && turn.tools.length) append(esc('用过的工具：' + turn.tools.join('、')), 'ra-thought');
      });
      log.scrollTop = log.scrollHeight;
    }

    function setRunning(value) {
      running = value;
      var send = $('#ra-send');
      if (send) { send.textContent = value ? '停止' : '发送'; send.classList.toggle('is-main', !value); send.classList.toggle('is-bad', value); }
      var input = $('#ra-text');
      if (input) input.disabled = value;
    }

    function confirmCard(request) {
      return new Promise(function (resolve) {
        clearIndicator();
        var danger = request.tier === 'danger';
        var node = append('<h4>' + (danger ? '需要确认：这个操作难以恢复' : '需要确认') + '</h4><div>' + esc(request.description || request.name) + '</div>'
          + '<pre>' + esc(JSON.stringify(request.args, null, 1)) + '</pre>'
          + '<div class="ra-row"><button type="button" class="ra-btn is-main" data-answer="allow">允许</button>'
          + (danger ? '' : '<button type="button" class="ra-btn" data-answer="always">本次对话都允许这个工具</button>')
          + '<button type="button" class="ra-btn is-bad" data-answer="deny">拒绝</button></div>', 'ra-confirm' + (danger ? ' is-danger' : ''));
        var done = false;
        var finish = function (answer) {
          if (done) return;
          done = true;
          pendingConfirms = pendingConfirms.filter(function (item) { return item !== finish; });
          if (node) node.innerHTML = '<div>' + esc(request.description || request.name) + '</div><div class="ra-note">' + (answer === 'deny' ? '已拒绝' : answer === 'always' ? '已允许（本次对话内不再询问这个工具）' : '已允许') + '</div>';
          resolve(answer);
        };
        pendingConfirms.push(finish);
        if (!node) { finish('deny'); return; }
        node.addEventListener('click', function (event) {
          var button = event.target.closest('[data-answer]');
          if (button) finish(button.getAttribute('data-answer'));
        });
        var log = logNode();
        if (log) log.scrollTop = log.scrollHeight;
      });
    }

    function onAgentEvent(event) {
      if (!overlay) return;
      if (event.type === 'thinking') { showIndicator(event.step ? '继续思考' : '思考中'); return; }
      if (event.type === 'thought') { clearIndicator(); append(esc(event.text), 'ra-thought'); return; }
      if (event.type === 'tool_start') {
        clearIndicator();
        var node = append('<details><summary><span class="st">◇</span><span>' + esc(event.description && event.description !== event.name ? event.description : event.name) + '</span></summary><pre>'
          + esc(event.name + ' ' + JSON.stringify(event.args)) + '</pre></details>', 'ra-step');
        if (node) { node.setAttribute('data-step', event.id); node.setAttribute('data-state', 'run'); }
        return;
      }
      if (event.type === 'tool_end') {
        var step = overlay.querySelector('.ra-step[data-step="' + event.id + '"]');
        if (!step) {
          step = append('<details><summary><span class="st">◇</span><span>' + esc(event.name) + '</span></summary><pre></pre></details>', 'ra-step');
          if (!step) return;
        }
        step.setAttribute('data-state', event.ok ? 'ok' : 'bad');
        var mark = step.querySelector('.st');
        if (mark) mark.textContent = event.ok ? '✓' : event.denied ? '⊘' : '✕';
        var pre = step.querySelector('pre');
        if (pre) pre.textContent = (pre.textContent ? pre.textContent + '\n' : '') + '→ ' + (event.summary || '');
        return;
      }
      if (event.type === 'final') { clearIndicator(); append(rich(event.text), 'ra-msg ra-ai'); return; }
      if (event.type === 'error') { clearIndicator(); append(esc('没能完成：' + event.message), 'ra-thought'); return; }
      if (event.type === 'aborted') { clearIndicator(); append('已停止。', 'ra-thought'); }
    }

    async function send(textOverride) {
      if (running) {
        pendingConfirms.slice().forEach(function (finish) { finish('deny'); });
        agent.stop();
        return;
      }
      var input = $('#ra-text');
      var text = String(textOverride !== undefined ? textOverride : input && input.value || '').trim();
      if (!text) return;
      if (input && textOverride === undefined) input.value = '';
      append(rich(text), 'ra-msg ra-user');
      var log = logNode();
      if (log) log.scrollTop = log.scrollHeight;
      setRunning(true);
      try {
        var outcome = await agent.run(text, { onEvent: onAgentEvent, confirm: confirmCard });
        if (outcome.busy) append(esc(outcome.answer), 'ra-thought');
      } catch (error) {
        append(esc('出错：' + String(error && error.message || error)), 'ra-thought');
      } finally {
        clearIndicator();
        setRunning(false);
        refreshFoot();
        if (input) { try { input.focus(); } catch (error) { /* 面板可能已关闭 */ } }
      }
    }

    function footPermission() {
      var current = agent.getSettings();
      var mode = { readonly: '只读', card: '单卡', tavern: '酒馆全权', device: '设备全权' }[current.mode] || '单卡';
      if (current.mode === 'readonly') return mode;
      return mode + ' · ' + ({ ask: '先询问', auto: '档位内直接执行', yolo: '全部直接执行' }[current.approval] || '先询问') + (current.lite ? ' · 轻聊' : '');
    }

    function refreshFoot() {
      var node = $('#ra-foot-text');
      if (!node) return;
      var backend = llm.getBackendSummary('agent');
      var memorySettings = memory.getSettings();
      node.textContent = '模型：' + (backend.mode === 'custom' ? backend.model : '酒馆当前连接')
        + ' ｜ 记忆：' + (memorySettings.enabled ? (memory.targetStore() === 'ocean' ? '《' + memorySettings.oceanBook + '》' : '当前聊天') : '关闭')
        + ' ｜ 权限：' + footPermission();
      var persona = $('#ra-persona');
      if (persona) persona.textContent = 'READER AGENT · ' + agent.personaContext().name;
    }

    /* ---------- 记忆页 ---------- */
    function memoryEditorHtml(record) {
      var isNew = !record.id;
      var types = TYPE_ORDER.map(function (type) { return '<option value="' + type + '"' + (record.type === type ? ' selected' : '') + '>' + memory.TYPES[type] + '</option>'; }).join('');
      var importance = [1, 2, 3, 4, 5].map(function (value) { return '<option value="' + value + '"' + (Number(record.importance) === value ? ' selected' : '') + '>' + value + '</option>'; }).join('');
      return '<div class="ra-card" id="ra-editor"><h3>' + (isNew ? '新增记忆' : '编辑记忆') + '</h3><div class="ra-form">'
        + '<label>类型</label><select data-f="type">' + types + '</select>'
        + '<label>标题</label><input type="text" data-f="title" maxlength="40" value="' + esc(record.title || '') + '">'
        + '<label>正文</label><textarea data-f="content" maxlength="4000">' + esc(record.content || '') + '</textarea>'
        + '<label>触发词</label><input type="text" data-f="keys" value="' + esc((record.keys || []).join('，')) + '" placeholder="用逗号分隔；正文或对话里出现这些词时会想起它">'
        + '<label>重要度</label><select data-f="importance">' + importance + '</select>'
        + '<label>归属</label><select data-f="owner"><option value="story"' + (record.owner !== 'agent' ? ' selected' : '') + '>正文的记忆：正文里的夜梦会想起</option><option value="agent"' + (record.owner === 'agent' ? ' selected' : '') + '>助手自己的：打开“同一个人”后正文才会想起</option></select>'
        + (isNew ? '<label>存放位置</label><select data-f="store"><option value="chat"' + (record.store === 'chat' ? ' selected' : '') + '>当前聊天</option><option value="ocean"' + (record.store === 'ocean' ? ' selected' : '') + '>《' + esc(memory.getSettings().oceanBook) + '》世界书（跨存档）</option></select>' : '')
        + '<label class="ra-check wide"><input type="checkbox" data-f="pinned"' + (record.pinned ? ' checked' : '') + '>常驻：每一轮都带上（《夜之洋》里对应蓝灯条目）</label>'
        + '<div class="ra-row wide"><button type="button" class="ra-btn is-main" data-act="mem-save">保存</button><button type="button" class="ra-btn" data-act="mem-cancel">取消</button></div>'
        + '</div></div>';
    }

    function memoryItemHtml(record) {
      var stars = '★★★★★'.slice(0, record.importance) + '☆☆☆☆☆'.slice(0, 5 - record.importance);
      return '<div class="ra-mem" data-id="' + esc(record.id) + '"><div class="ra-mem-head"><span class="ra-badge t-' + record.type + '">' + esc(memory.TYPE_SHORT[record.type]) + '</span>'
        + '<span class="ra-mem-title">' + esc(record.title) + '</span><span class="ra-mem-keys">' + stars + '</span>'
        + '<span class="ra-badge">' + (record.store === 'ocean' ? '夜之洋' : '聊天') + '</span>' + (record.owner === 'agent' ? '<span class="ra-badge">助手</span>' : '') + (record.pinned ? '<span class="ra-badge">常驻</span>' : '') + (record.enabled ? '' : '<span class="ra-badge">已停用</span>') + '</div>'
        + '<div class="ra-mem-body">' + esc(record.content) + '</div>'
        + (record.keys.length ? '<div class="ra-mem-keys">触发词：' + esc(record.keys.join('、')) + '</div>' : '')
        + '<div class="ra-row" style="margin-top:6px"><button type="button" class="ra-btn is-small" data-act="mem-edit">编辑</button>'
        + '<button type="button" class="ra-btn is-small" data-act="mem-pin">' + (record.pinned ? '取消常驻' : '设为常驻') + '</button>'
        + '<button type="button" class="ra-btn is-small" data-act="mem-move">' + (record.store === 'ocean' ? '移到当前聊天' : '移到夜之洋') + '</button>'
        + '<button type="button" class="ra-btn is-small is-bad" data-act="mem-del">删除</button></div></div>';
    }

    async function renderMemory() {
      var pane = $('[data-pane="memory"] .ra-scroll');
      if (!pane) return;
      var status, list;
      try {
        status = await memory.status();
        list = await memory.list({ type: memoryFilter.type || undefined, store: memoryFilter.store || undefined, query: memoryFilter.query || undefined, fresh: true });
      } catch (error) {
        pane.innerHTML = '<div class="ra-card">读取记忆失败：' + esc(String(error && error.message || error)) + '</div>';
        return;
      }
      if (!overlay || tab !== 'memory') return;
      var chip = function (group, value, label) {
        return '<button type="button" class="ra-chip" data-act="mem-filter" data-group="' + group + '" data-value="' + value + '" aria-pressed="' + (memoryFilter[group] === value) + '">' + label + '</button>';
      };
      var last = status.last ? ((status.last.ok ? '上次整理：新增 ' + status.last.added + '、更新 ' + status.last.updated : '上次整理失败：' + (status.last.error || '')) + (status.last.note ? '（' + status.last.note + '）' : '')) : '还没有整理过';
      var threshold = status.thresholds.auto ? '自动整理阈值 ' + (status.thresholds.turns || '—') + ' 条回复 / ' + (status.thresholds.chars || '—') + ' 字' : '自动整理已关闭';
      var html = '<div class="ra-card"><div class="ra-row"><label>本聊天的新记忆写到</label><select id="ra-store">'
        + '<option value=""' + (status.chatOverride === '' ? ' selected' : '') + '>跟随全局设置（' + (memory.getSettings().store === 'ocean' ? '夜之洋' : '当前聊天') + '）</option>'
        + '<option value="chat"' + (status.chatOverride === 'chat' ? ' selected' : '') + '>当前聊天</option>'
        + '<option value="ocean"' + (status.chatOverride === 'ocean' ? ' selected' : '') + '>《' + esc(status.oceanBook) + '》世界书（跨存档）</option></select>'
        + '<button type="button" class="ra-btn is-main" data-act="mem-run"' + (status.running ? ' disabled' : '') + '>立即整理</button>'
        + '<button type="button" class="ra-btn" data-act="mem-new">新增记忆</button>'
        + '<button type="button" class="ra-btn" data-act="mem-export">导出</button><button type="button" class="ra-btn" data-act="mem-import">导入</button></div>'
        + '<p class="ra-note">当前聊天 ' + status.chatCount + ' 条 · 《' + esc(status.oceanBook) + '》' + (status.oceanExists ? status.oceanCount + ' 条' + (status.oceanNative ? '（已挂载，由酒馆按触发词原生带入）' : '（未挂载，由脚本带入）') : '尚未创建')
        + ' ｜ 待整理 ' + status.pending.turns + ' 条回复 / ' + status.pending.chars + ' 字 ｜ ' + esc(threshold) + '</p>'
        + '<p class="ra-note">' + esc(last) + '</p><div class="ra-status" data-ra-status="memory"></div></div>';
      html += '<div class="ra-card"><h3>前情梗概</h3><textarea id="ra-summary" style="width:100%;min-height:70px" placeholder="整理对话时自动更新；也可以自己改写。注入正文时放在记忆的最前面。">' + esc(status.summary || '') + '</textarea>'
        + '<div class="ra-row" style="margin-top:6px"><button type="button" class="ra-btn is-small" data-act="mem-summary">保存梗概</button></div></div>';
      if (editing) html += memoryEditorHtml(editing);
      html += '<div class="ra-row" style="margin-bottom:8px">' + chip('type', '', '全部') + TYPE_ORDER.map(function (type) { return chip('type', type, memory.TYPE_SHORT[type]); }).join('')
        + '<span style="width:10px"></span>' + chip('store', '', '两处') + chip('store', 'chat', '聊天') + chip('store', 'ocean', '夜之洋')
        + '<input type="search" id="ra-mem-q" placeholder="搜索" value="' + esc(memoryFilter.query) + '" style="flex:1;min-width:120px"></div>';
      html += list.length ? list.map(memoryItemHtml).join('') : '<p class="ra-note">这里还没有记忆。聊上一阵后会自动整理；也可以点“立即整理”或“新增记忆”。</p>';
      var scroll = pane.scrollTop;
      pane.innerHTML = html;
      pane.scrollTop = scroll;
    }

    function readEditor() {
      var box = $('#ra-editor');
      if (!box) return null;
      var field = function (name) { return box.querySelector('[data-f="' + name + '"]'); };
      return {
        type: field('type').value,
        title: field('title').value,
        content: field('content').value,
        keys: field('keys').value,
        importance: Number(field('importance').value),
        pinned: field('pinned').checked,
        owner: field('owner') ? field('owner').value : undefined,
        store: field('store') ? field('store').value : undefined
      };
    }

    function download(name, text) {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = doc.createElement('a');
      link.href = url;
      link.download = name;
      doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }

    function pickFile() {
      return new Promise(function (resolve) {
        var input = doc.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = function () {
          var file = input.files && input.files[0];
          if (!file) { resolve(null); return; }
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result || '')); };
          reader.onerror = function () { resolve(null); };
          reader.readAsText(file);
        };
        input.click();
      });
    }

    async function memoryAction(action, element) {
      var item = element.closest('[data-id]');
      var id = item ? item.getAttribute('data-id') : '';
      try {
        if (action === 'mem-filter') {
          memoryFilter[element.getAttribute('data-group')] = element.getAttribute('data-value');
        } else if (action === 'mem-new') {
          editing = { type: 'fact', title: '', content: '', keys: [], importance: 3, pinned: false, owner: 'story', store: memory.targetStore() };
        } else if (action === 'mem-edit') {
          editing = await memory.get(id);
        } else if (action === 'mem-cancel') {
          editing = null;
        } else if (action === 'mem-save') {
          var data = readEditor();
          if (!data || !data.content.trim()) { toast('正文不能为空', true); return; }
          if (editing && editing.id) await memory.update(editing.id, data);
          else await memory.add(Object.assign({ source: 'manual' }, data), { store: data.store });
          editing = null;
        } else if (action === 'mem-pin') {
          var current = await memory.get(id);
          if (current) await memory.update(id, { pinned: !current.pinned });
        } else if (action === 'mem-move') {
          var record = await memory.get(id);
          if (record) { toast('正在移动…'); await memory.move(id, record.store === 'ocean' ? 'chat' : 'ocean'); }
        } else if (action === 'mem-del') {
          if (element.getAttribute('data-armed') !== '1') {
            element.setAttribute('data-armed', '1');
            element.textContent = '再点一次删除';
            return;
          }
          await memory.remove(id);
        } else if (action === 'mem-run') {
          toast('正在整理对话…');
          element.disabled = true;
          var report = await memory.consolidate({ reason: 'manual', force: true });
          await renderMemory();
          toast(report.ok ? (report.note || '整理完成：新增 ' + report.added.length + ' 条，更新 ' + report.updated.length + ' 条' + (report.errors.length ? '，' + report.errors.length + ' 条写入失败' : '')) : '整理失败：' + report.error, !report.ok);
          return;
        } else if (action === 'mem-summary') {
          memory.setSummary($('#ra-summary').value);
          toast('梗概已保存');
          return;
        } else if (action === 'mem-export') {
          download('reader-ii-memory-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(await memory.exportAll(), null, 2));
          return;
        } else if (action === 'mem-import') {
          var text = await pickFile();
          if (!text) return;
          var outcome = await memory.importAll(text);
          await renderMemory();
          toast('导入完成：新增 ' + outcome.added + ' 条，跳过 ' + outcome.skipped + ' 条' + (outcome.errors.length ? '，失败 ' + outcome.errors.length + ' 条' : ''), outcome.errors.length > 0);
          return;
        }
        await renderMemory();
      } catch (error) {
        toast(String(error && error.message || error), true);
      }
    }

    /* ---------- 设置页 ---------- */
    function renderSettings() {
      var pane = $('[data-pane="settings"] .ra-scroll');
      if (!pane) return;
      var a = agent.getSettings();
      var m = memory.getSettings();
      var option = function (value, label, current) { return '<option value="' + value + '"' + (String(current) === String(value) ? ' selected' : '') + '>' + label + '</option>'; };
      var number = function (name, value, minimum, maximum, step) { return '<input type="number" data-s="' + name + '" value="' + esc(value) + '" min="' + minimum + '" max="' + maximum + '"' + (step ? ' step="' + step + '"' : '') + ' style="width:120px">'; };
      var check = function (name, value, label) { return '<label class="ra-check wide"><input type="checkbox" data-s="' + name + '"' + (value ? ' checked' : '') + '>' + label + '</label>'; };
      var route = function (key, label) {
        var backend = llm.getBackendSummary(key);
        return '<p class="ra-note">' + label + '：' + esc(backend.mode === 'custom' ? backend.model + ' · ' + backend.apiurl : '酒馆当前连接') + '</p>';
      };
      pane.innerHTML = '<div class="ra-card"><h3>助手</h3><div class="ra-form">'
        + '<label>权限档位</label><select data-s="a.mode">' + option('readonly', '只读：只看不改', a.mode) + option('card', '单卡：只改当前聊天和这张卡（推荐）', a.mode) + option('tavern', '酒馆全权：酒馆里的一切', a.mode) + option('device', '设备全权：再加上设备上的文件与命令（需后端伴侣）', a.mode) + '</select>'
        + '<label>确认方式</label><select data-s="a.approval">' + option('ask', '每次写入前询问（推荐）', a.approval) + option('auto', '档位内直接执行，危险操作仍询问', a.approval) + option('yolo', '全部直接执行', a.approval) + '</select>'
        + check('a.plotContext', a.plotContext, '让助手了解当前剧情（做前后端、修脚本时可以关掉，省 token）')
        + check('a.lite', a.lite, '轻聊：不带任何工具，只聊天')
        + '<label>最多工具步数</label>' + number('a.maxSteps', a.maxSteps, 1, 40)
        + '<label>带入历史轮数</label>' + number('a.historyTurns', a.historyTurns, 0, 40)
        + '<label>温度</label>' + number('a.temperature', a.temperature, 0, 2, 0.05)
        + '<label>输出上限</label>' + number('a.maxTokens', a.maxTokens, 256, 64000)
        + '<label>单次超时（秒）</label>' + number('a.timeoutSec', a.timeoutSec, 20, 900)
        + check('a.recall', a.recall, '回答前自动带入相关记忆')
        + '</div><p class="ra-note">输出上限与温度只对独立 API 生效；走酒馆连接时沿用当前预设。</p></div>'
        + rulesCardHtml(a.rules)
        + '<div class="ra-card"><h3>记忆</h3><div class="ra-form">'
        + check('m.enabled', m.enabled, '启用记忆系统')
        + '<label>自动整理与带入正文</label><select data-s="m.scope">' + option('reader', '只在用了 Reader-II 的聊天里（推荐）', m.scope) + option('all', '所有聊天', m.scope) + '</select>'
        + '<label>新记忆写到</label><select data-s="m.store">' + option('chat', '当前聊天（随存档，互不相干）', m.store) + option('ocean', '《夜之洋》世界书（跨存档）', m.store) + '</select>'
        + check('m.autoExtract', m.autoExtract, '自动整理：对话攒够下面任一数量后，把它沉淀为记忆')
        + '<label>每多少条回复</label>' + number('m.everyTurns', m.everyTurns, 0, 200)
        + '<label>或每多少字</label>' + number('m.everyChars', m.everyChars, 0, 400000)
        + '<label>最近几条先不整理</label>' + number('m.keepRecent', m.keepRecent, 0, 20)
        + check('m.inject', m.inject, '把相关记忆带进正文提示词')
        + '<label>注入深度</label>' + number('m.injectDepth', m.injectDepth, 0, 40)
        + '<label>最多带几条</label>' + number('m.injectMax', m.injectMax, 1, 30)
        + '<label>字数预算</label>' + number('m.injectBudget', m.injectBudget, 200, 20000)
        + check('m.injectSummary', m.injectSummary, '同时带上前情梗概')
        + check('m.agentExtract', m.agentExtract, '与助手的对话也沉淀为记忆（情感、偏好、做法）')
        + check('m.unify', m.unify, '助手夜梦 = 正文夜梦：助手自己的记忆也带进正文（功能记忆除外；正文里不主动超游）')
        + '<label>夜之洋书名</label><input type="text" data-s="m.oceanBook" value="' + esc(m.oceanBook) + '" maxlength="60">'
        + '<label>夜之洋挂载</label><select data-s="m.oceanMount">' + option('global', '全局启用：所有角色卡的聊天都能想起', m.oceanMount) + option('character', '绑到当前角色卡：只在这张卡的各个存档间共享', m.oceanMount) + option('none', '不挂载：只由脚本检索带入', m.oceanMount) + '</select>'
        + '</div><p class="ra-note">两个数量都填 0 时只在手动点“立即整理”时整理。已挂载的《夜之洋》由酒馆按触发词原生带入正文；当前聊天里的记忆、以及未挂载的《夜之洋》由脚本带入。没打开“同一个人”时，助手自己的记忆不进正文，它们在《夜之洋》里的条目保持停用。</p></div>'
        + '<div class="ra-card"><h3>模型</h3>' + route('agent', '助手对话') + route('memory', '记忆整理') + route('adapt', '语义适配')
        + '<p class="ra-note">三项各自对应「独立 API」里的调用类型；没有单独设置时用默认方案，默认方案也没有时走酒馆当前连接。</p>'
        + '<div class="ra-row"><button type="button" class="ra-btn" data-act="open-api">打开独立 API 设置</button><button type="button" class="ra-btn" data-act="open-panel">打开语义适配面板</button></div></div>'
        + '<div class="ra-row"><button type="button" class="ra-btn is-main" data-act="save-settings">保存设置</button><span class="ra-status" data-ra-status="settings"></span></div>'
        + connectorsCardHtml()
        + updatesCardHtml()
        + '<div class="ra-card"><h3>改动记录</h3><p class="ra-note">助手每一轮改过的东西都留有改动前的样子，可以按轮撤销。之后又被别处改过的不会被强行覆盖。</p><div id="ra-runs"></div></div>';
      renderRuns();
    }

    /* ---------- 权限规则与插件对接（设置页） ---------- */
    var RULE_EFFECT = { deny: '禁止', ask: '总是先问', allow: '免问' };
    var RULE_ACTION = { '*': '读写', read: '只管读', write: '只管写' };

    function ruleRowHtml(rule) {
      var opts = function (map, current) { return Object.keys(map).map(function (key) { return '<option value="' + key + '"' + (key === current ? ' selected' : '') + '>' + map[key] + '</option>'; }).join(''); };
      return '<div class="ra-row" data-rule style="margin:4px 0"><select data-r="effect">' + opts(RULE_EFFECT, rule.effect || 'deny') + '</select><select data-r="action">' + opts(RULE_ACTION, rule.action || '*') + '</select>'
        + '<input type="text" data-r="pattern" value="' + esc(rule.pattern || '') + '" placeholder="路径或工具名，如 wb:/日记/**" style="flex:1;min-width:160px">'
        + '<button type="button" class="ra-btn is-small is-bad" data-act="rule-del">删除</button></div>';
    }

    function rulesCardHtml(rules) {
      return '<div class="ra-card"><h3>权限规则</h3><p class="ra-note">按路径或工具名匹配：<code>*</code> 不跨“/”，<code>**</code> 跨层级。禁止优先，其余取第一条匹配的。例：<code>wb:/日记/**</code> 禁止读写这本世界书；<code>var:/chat.json*</code> 写聊天变量免问；<code>slash_run</code> 斜杠命令总是先问。档位不够的写入照样不执行。</p>'
        + '<div id="ra-rules">' + (rules || []).map(ruleRowHtml).join('') + '</div>'
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="rule-add">添加规则</button><span class="ra-note">改完点“保存设置”。</span></div></div>';
    }

    function readRules() {
      return Array.prototype.map.call(overlay.querySelectorAll('[data-rule]'), function (row) {
        var get = function (name) { return row.querySelector('[data-r="' + name + '"]').value; };
        return { effect: get('effect'), action: get('action'), pattern: get('pattern').trim() };
      }).filter(function (rule) { return rule.pattern; });
    }

    /* 乙组的 MCP 服务器放进 #ra-mcp（data-slot="mcp"）。 */
    function connectorsCardHtml() {
      var custom = agent.getSettings().connectors || [];
      var active = agent.listConnectors();
      var activeIds = active.map(function (item) { return item.id; });
      var builtin = active.filter(function (item) { return !item.custom; }).map(function (item) { return '<span class="ra-badge" title="' + esc(item.summary || '') + '">' + esc(item.title) + '</span>'; }).join(' ');
      var rows = custom.map(function (manifest) {
        return '<div class="ra-row" data-conn="' + esc(manifest.id) + '" style="justify-content:space-between;margin:4px 0"><span><b>' + esc(manifest.title || manifest.id) + '</b> <span class="ra-note">' + esc(manifest.id) + ' · ' + (activeIds.indexOf(manifest.id) >= 0 ? '已探测到' : '没探测到（插件没装或还没加载）') + '</span></span>'
          + '<span class="ra-row"><button type="button" class="ra-btn is-small" data-act="conn-view">查看</button><button type="button" class="ra-btn is-small is-bad" data-act="conn-del">删除</button></span></div>';
      }).join('');
      return '<div class="ra-card" id="ra-conn-card"><h3>插件对接</h3><p class="ra-note">已探测到：</p><div class="ra-row">' + (builtin || '<span class="ra-note">没有</span>') + '</div>'
        + '<p class="ra-note" style="margin-top:10px">自定义对接（声明式 connector.json，格式见知识 connector-authoring，也可以让助手替你写）：</p>'
        + (rows || '<p class="ra-note">还没有。</p>')
        + '<textarea id="ra-conn-json" spellcheck="false" placeholder="{&quot;id&quot;: &quot;myplugin&quot;, &quot;title&quot;: &quot;我的插件&quot;, &quot;detect&quot;: &quot;window.MyPlugin&quot;, &quot;tools&quot;: […]}" style="width:100%;min-height:110px;margin-top:6px;box-sizing:border-box"></textarea>'
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="conn-save">添加 / 按 id 更新</button><span class="ra-note">这一栏的改动立即生效。</span></div>'
        + '<div id="ra-mcp" data-slot="mcp"><p class="ra-note" style="margin-top:10px"><b>MCP 服务器</b>：下一版加入（HTTP 直连；TauriTavern 走宿主自带的 MCP）。</p></div></div>';
    }

    function settingsAction(action, actor) {
      try {
        if (action === 'rule-add') { $('#ra-rules').insertAdjacentHTML('beforeend', ruleRowHtml({})); return; }
        if (action === 'rule-del') { actor.closest('[data-rule]').remove(); return; }
        var list = (agent.getSettings().connectors || []).slice();
        var row = actor.closest('[data-conn]');
        var id = row ? row.getAttribute('data-conn') : '';
        if (action === 'conn-view') {
          var found = list.filter(function (item) { return item.id === id; })[0];
          if (found) $('#ra-conn-json').value = JSON.stringify(found, null, 2);
          return;
        }
        if (action === 'conn-del') {
          if (actor.getAttribute('data-armed') !== '1') { actor.setAttribute('data-armed', '1'); actor.textContent = '再点一次删除'; return; }
          agent.saveSettings({ connectors: list.filter(function (item) { return item.id !== id; }) });
          toast('已删除对接 ' + id);
        } else if (action === 'conn-save') {
          var manifest;
          try { manifest = JSON.parse($('#ra-conn-json').value); } catch (error) { throw new Error('对接描述不是合法的 JSON：' + error.message); }
          var checked = agent.validateConnector(manifest);
          agent.saveSettings({ connectors: list.filter(function (item) { return item.id !== checked.id; }).concat([manifest]) });
          toast('已保存对接「' + checked.title + '」，' + checked.tools + ' 个工具' + (checked.detected ? '' : '；暂时没探测到这个插件'));
        }
        var card = $('#ra-conn-card');
        if (card) card.outerHTML = connectorsCardHtml();
      } catch (error) {
        toast(String(error && error.message || error), true);
      }
    }

    /* ---------- 检查更新（设置页；交接 0.6 甲组第 9 项，逻辑在 updates.js） ---------- */
    var updates = deps && deps.updates || null;
    var updatesView = '', updatesPlan = null;
    var GUIDE_EXT = '<ol class="ra-upd-list"><li>酒馆顶栏「扩展」（三个方块的图标）→「管理扩展」→ 找到「Reader-II · 夜梦」，点它的更新按钮（就是 git pull）。TauriTavern 在扩展管理里同样操作。当初是手动拷贝安装的，重新下载后覆盖 <code>manifest.json</code>、<code>index.js</code>、<code>dist/</code>、<code>knowledge/</code>。</li>'
      + '<li>刷新酒馆页面。</li><li>回到这里点「检查卡内组件」，把卡内组件更新到同一版本。</li></ol>'
      + '<p class="ra-note">设置、记忆、工作区、对话记录都不在扩展目录里，更新扩展不会动它们。不要直接改扩展目录里的文件（git pull 会因此失败，或把改动冲掉）：自定义的东西放工作区 <code>ws:/</code>，或者另写一个扩展。</p>';
    var GUIDE_CDN = '<p class="ra-note">你没有装扩展，夜梦助手是从 CDN 加载的：刷新页面就会拿到新版（jsDelivr 有缓存，可能要等几个小时）。想及时更新，可以装上扩展。</p>';
    var UPDATE_MARK = { current: '✓', missing: '＋', outdated: '↑', modified: '✎', unavailable: '—', blocked: '!' };

    function updatesCardHtml() {
      if (!updates) return '';
      var s = updates.getSettings(), carrier = updates.carrier();
      var last = s.installed && s.installed.version ? '；上次代装 v' + esc(s.installed.version) : '';
      return '<div class="ra-card" id="ra-upd-card"><h3>检查更新</h3>'
        + '<p class="ra-note">当前版本 <b>v' + esc(updates.version) + '</b>（' + (carrier === 'cdn' ? '从 CDN 加载' : carrier === 'extension' ? '酒馆扩展' : '载入方式未知') + '）' + last + '。</p>'
        + '<div class="ra-row"><button type="button" class="ra-btn" data-act="upd-check">检查更新</button><button type="button" class="ra-btn" data-act="upd-inspect">检查卡内组件</button></div>'
        + '<details><summary class="ra-note">更新源（每行一个地址，按顺序尝试）</summary><textarea id="ra-upd-remotes" style="width:100%;min-height:56px">' + esc(s.remotes.join('\n')) + '</textarea>'
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="upd-remotes">保存更新源</button><button type="button" class="ra-btn is-small" data-act="upd-reset">恢复默认</button></div></details>'
        + '<div id="ra-upd-out" aria-live="polite">' + updatesView + '</div></div>';
    }

    function checkHtml(result) {
      var errors = result.errors && result.errors.length ? '<p class="ra-note">没连上的更新源：' + result.errors.map(esc).join('；') + '</p>' : '';
      if (!result.ok) return '<p class="ra-upd-bad">检查失败，不能据此判断已是最新。</p>' + errors;
      if (result.status === 'newer') return '<p class="ra-upd-ok">有新版本 <b>v' + esc(result.latest) + '</b>（当前 v' + esc(result.current) + '）。</p>' + (result.carrier === 'cdn' ? GUIDE_CDN : GUIDE_EXT) + errors;
      if (result.status === 'older') return '<p>当前 v' + esc(result.current) + ' 比更新源上的 v' + esc(result.latest) + ' 还新（开发中的版本）。</p>' + errors;
      return '<p>已是最新：v' + esc(result.current) + '（更新源 ' + esc(result.source) + '）。卡内组件要和扩展同一版本，可以点「检查卡内组件」看一眼。</p>' + errors;
    }

    function planHtml(plan) {
      var rows = plan.items.map(function (item) {
        var details = item.details && item.details.length && item.status !== 'current' ? '<ul class="ra-upd-list">' + item.details.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('') + '</ul>' : '';
        return '<li data-upd="' + esc(item.key) + '" data-status="' + esc(item.status) + '">' + (UPDATE_MARK[item.status] || '·') + ' <b>' + esc(item.label) + '</b>：' + esc(item.text) + details + '</li>';
      }).join('');
      var needsScope = plan.items.some(function (item) { return item.action === 'install' && (item.key === 'script' || item.key === 'worldbook'); });
      var scope = needsScope ? '<div class="ra-row"><label>新装到</label><select id="ra-upd-scope"><option value="character"' + (plan.scope === 'character' ? ' selected' : '') + '>当前角色卡（推荐）</option><option value="global"' + (plan.scope === 'global' ? ' selected' : '') + '>全局（每个聊天都运行）</option></select></div>' : '';
      var notes = plan.notes.length ? '<p class="ra-upd-bad">' + plan.notes.map(esc).join('<br>') + '</p>' : '';
      var action = plan.actions
        ? '<div class="ra-row"><button type="button" class="ra-btn is-main" data-act="upd-apply">安装 / 更新卡内组件（' + plan.actions + ' 项）</button></div><p class="ra-note">动手前会再核对一遍；写到一半出错，已写的会退回。被替换的世界书条目留作停用的备份，你改过的不覆盖。</p>'
        : '<p>卡内组件不需要改动。</p>';
      return '<p>卡内组件 v' + esc(plan.version) + '（来源 ' + esc(plan.source) + '，全部校验通过）：</p><ul class="ra-upd-list">' + rows + '</ul>' + scope + notes + action;
    }

    function reportHtml(report) {
      var parts = ['<p class="ra-upd-ok">' + (report.done.length ? '已完成：' + report.done.map(esc).join('、') : '没有需要改动的') + '。</p>'];
      if (report.kept.length) parts.push('<p class="ra-note">没有覆盖（你改过）：' + report.kept.map(esc).join('、') + '</p>');
      if (report.notes.length) parts.push('<p class="ra-upd-bad">' + report.notes.map(esc).join('<br>') + '</p>');
      if (report.reload) parts.push('<p class="ra-note">刷新页面后全部生效。</p>');
      return parts.join('');
    }

    function setUpdatesView(html) {
      updatesView = html;
      var out = $('#ra-upd-out');
      if (out) out.innerHTML = html;
    }

    async function updatesAction(action, actor) {
      if (!updates) return;
      try {
        if (action === 'upd-remotes') { updates.saveSettings({ remotes: ($('#ra-upd-remotes') || {}).value || '' }); toast('更新源已保存'); return; }
        if (action === 'upd-reset') {
          updates.saveSettings({ remotes: [] });
          var card = $('#ra-upd-card');
          if (card) card.outerHTML = updatesCardHtml();
          toast('已恢复默认更新源');
          return;
        }
        if (action === 'upd-check') { setUpdatesView('<p class="ra-note">正在检查…</p>'); setUpdatesView(checkHtml(await updates.checkRemote())); return; }
        if (action === 'upd-inspect') {
          var select = $('#ra-upd-scope'), options = select ? { scope: select.value } : {};
          updatesPlan = null;
          setUpdatesView('<p class="ra-note">正在下载并校验卡内组件…</p>');
          updatesPlan = await updates.inspect(options);
          setUpdatesView(planHtml(updatesPlan));
          return;
        }
        if (action === 'upd-apply') {
          if (!updatesPlan) throw new Error('请先点「检查卡内组件」');
          if (actor.getAttribute('data-armed') !== '1') { actor.setAttribute('data-armed', '1'); actor.textContent = '再点一次确认'; return; }
          actor.disabled = true;
          var plan = updatesPlan;
          updatesPlan = null;
          setUpdatesView(reportHtml(await updates.apply(plan)));
        }
      } catch (error) {
        var text = String(error && error.message || error);
        setUpdatesView('<p class="ra-upd-bad">' + esc(text).replace(/\n/g, '<br>') + '</p>');
        toast(text.split('\n')[0], true);
      }
    }

    /* ---------- 改动记录与撤销 ---------- */
    var forceUndo = Object.create(null);

    function renderRuns() {
      var box = $('#ra-runs');
      if (!box || typeof agent.listRuns !== 'function') return;
      agent.listRuns(12).then(function (runs) {
        if (!runs.length) { box.innerHTML = '<p class="ra-note">还没有改动记录。</p>'; return; }
        box.innerHTML = runs.map(function (run) {
          var notes = (run.notes || []).length ? '<br><span class="ra-note">无法自动撤销：' + esc(run.notes.join('；')) + '</span>' : '';
          var button = run.changes && !run.undone
            ? '<button type="button" class="ra-btn is-small' + (forceUndo[run.id] ? ' is-bad' : '') + '" data-act="undo-run" data-run="' + esc(run.id) + '">' + (forceUndo[run.id] ? '强制撤销' : '撤销') + '</button>' : '';
          return '<div class="ra-row" style="justify-content:space-between;gap:8px;margin:6px 0"><span>' + esc(new Date(run.startedAt).toLocaleString()) + ' · ' + esc(run.title || '')
            + ' · 改动 ' + run.changes + ' 处' + (run.undone ? '（已撤销）' : '') + notes + '</span>' + button + '</div>';
        }).join('');
      }).catch(function () { box.innerHTML = '<p class="ra-note">读取记录失败。</p>'; });
    }

    function undoRun(actor) {
      var id = actor.getAttribute('data-run');
      actor.disabled = true;
      agent.undo(id, { force: forceUndo[id] === true }).then(function (report) {
        if (report.conflicts.length) {
          forceUndo[id] = true;
          toast('已恢复 ' + report.restored.length + ' 处；另有 ' + report.conflicts.length + ' 处' + report.conflicts[0].reason + '，再点一次可强制恢复', true);
        } else {
          delete forceUndo[id];
          toast('已撤销这一轮的 ' + report.restored.length + ' 处改动');
        }
        renderRuns();
      }).catch(function (error) { toast(String(error && error.message || error), true); renderRuns(); });
    }

    function saveSettingsFromForm() {
      var agentPatch = {}, memoryPatch = {};
      overlay.querySelectorAll('[data-s]').forEach(function (input) {
        var key = input.getAttribute('data-s');
        var value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
        if (key.indexOf('a.') === 0) agentPatch[key.slice(2)] = value;
        else memoryPatch[key.slice(2)] = value;
      });
      if ($('#ra-rules')) agentPatch.rules = readRules();
      agent.saveSettings(agentPatch);
      memory.saveSettings(memoryPatch);
      renderSettings();
      refreshFoot();
      toast('设置已保存');
    }

    /* ---------- 面板 ---------- */
    function showTab(next) {
      tab = next === 'memory' || next === 'settings' ? next : 'chat';
      if (!overlay) return;
      overlay.querySelectorAll('.ra-tab').forEach(function (button) { button.setAttribute('aria-selected', String(button.getAttribute('data-tab') === tab)); });
      overlay.querySelectorAll('.ra-pane').forEach(function (pane) { pane.classList.toggle('is-on', pane.getAttribute('data-pane') === tab); });
      if (tab === 'memory') renderMemory();
      else if (tab === 'settings') renderSettings();
      else { refreshFoot(); var input = $('#ra-text'); if (input) { try { input.focus(); } catch (error) { /* ignore */ } } }
    }

    function build() {
      ensureStyle();
      overlay = doc.createElement('dialog');
      overlay.id = OVERLAY_ID;
      overlay.setAttribute('aria-label', '夜梦助手');
      overlay.innerHTML = '<div class="ra-shell"><header class="ra-head"><div class="ra-id"><b>九十九夜梦</b><i id="ra-persona">READER AGENT</i></div>'
        + '<nav class="ra-tabs" role="tablist"><button type="button" class="ra-tab" role="tab" data-tab="chat">对话</button><button type="button" class="ra-tab" role="tab" data-tab="memory">记忆</button><button type="button" class="ra-tab" role="tab" data-tab="settings">设置</button></nav>'
        + '<button type="button" class="ra-close" data-act="close" aria-label="关闭">×</button></header>'
        + '<section class="ra-pane" data-pane="chat"><div class="ra-log" id="ra-log" aria-live="polite"></div>'
        + '<div class="ra-quick"><button type="button" class="ra-chip" data-quick="看看现在 Reader 的状态。">看看状态</button><button type="button" class="ra-chip" data-quick="帮我把这张卡的变量适配到 Reader-II，逐项告诉我结果。">适配这张卡</button><button type="button" class="ra-chip" data-quick="把最近的对话整理成记忆，告诉我记下了什么。">整理记忆</button><button type="button" class="ra-chip" data-quick="你还记得关于我和这个故事的哪些事？">你还记得什么</button></div>'
        + '<div class="ra-input"><textarea id="ra-text" placeholder="想问什么、想让我做什么，直接说。Enter 发送，Shift+Enter 换行"></textarea><button type="button" class="ra-btn is-main" id="ra-send">发送</button></div>'
        + '<div class="ra-foot"><span id="ra-foot-text"></span><button type="button" class="ra-btn is-small" data-act="clear">清空对话</button></div></section>'
        + '<section class="ra-pane" data-pane="memory"><div class="ra-scroll"></div></section>'
        + '<section class="ra-pane" data-pane="settings"><div class="ra-scroll"></div></section></div>';
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) { close(); return; }
        var tabButton = event.target.closest('.ra-tab');
        if (tabButton) { showTab(tabButton.getAttribute('data-tab')); return; }
        var quick = event.target.closest('[data-quick]');
        if (quick && !running) { send(quick.getAttribute('data-quick')); return; }
        if (event.target.closest('#ra-send')) { send(); return; }
        var actor = event.target.closest('[data-act]');
        if (!actor) return;
        var action = actor.getAttribute('data-act');
        if (action === 'close') close();
        else if (action === 'clear') {
          if (running) return;
          if (actor.getAttribute('data-armed') !== '1') { actor.setAttribute('data-armed', '1'); actor.textContent = '再点一次清空'; setTimeout(function () { actor.removeAttribute('data-armed'); actor.textContent = '清空对话'; }, 3000); return; }
          actor.removeAttribute('data-armed'); actor.textContent = '清空对话';
          agent.clearHistory(); renderHistory();
        }
        else if (action === 'save-settings') saveSettingsFromForm();
        else if (action === 'open-api') { close(); var shell = deps.shell && deps.shell(); if (shell) shell.command('openIndependentApiSettings'); }
        else if (action === 'open-panel') { close(); var core = deps.core && deps.core(); if (core && core.openPanel) core.openPanel(); }
        else if (action === 'undo-run') undoRun(actor);
        else if (action.indexOf('mem-') === 0) memoryAction(action, actor);
        else if (action.indexOf('rule-') === 0 || action.indexOf('conn-') === 0) settingsAction(action, actor);
        else if (action.indexOf('upd-') === 0) updatesAction(action, actor);
      });
      overlay.addEventListener('change', function (event) {
        if (event.target.id === 'ra-upd-scope' && updates) {
          try { updates.saveSettings({ scope: event.target.value }); } catch (error) { /* 下面重新检查时会报出来 */ }
          updatesAction('upd-inspect');
          return;
        }
        if (event.target.id === 'ra-store') {
          try { memory.setChatStoreOverride(event.target.value); renderMemory(); refreshFoot(); } catch (error) { toast(String(error && error.message || error), true); }
        }
      });
      overlay.addEventListener('input', function (event) {
        if (event.target.id === 'ra-mem-q') {
          memoryFilter.query = event.target.value;
          clearTimeout(overlay.__raSearch);
          overlay.__raSearch = setTimeout(function () {
            renderMemory().then(function () { var input = $('#ra-mem-q'); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
          }, 300);
        }
      });
      overlay.addEventListener('keydown', function (event) {
        if (event.target.id === 'ra-text' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
        /* 输入事件不冒泡到酒馆：聊天页的快捷键不该在面板里触发。 */
        event.stopPropagation();
      });
      overlay.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
      doc.body.appendChild(overlay);
    }

    function open(target) {
      if (!doc || !doc.createElement) throw new Error('当前环境无法打开夜梦助手');
      var stale = doc.getElementById(OVERLAY_ID);
      if (stale && stale !== overlay) stale.remove();
      if (!overlay || !overlay.isConnected) build();
      overlay.setAttribute('data-theme', themeName());
      if (!overlay.open) {
        try { overlay.showModal(); } catch (error) { overlay.setAttribute('open', ''); }
      }
      if (!running) renderHistory();
      showTab(target || tab);
      if (!unsubscribe.length) {
        /* 设置被别处改了（斜杠命令、插件、助手自己）时，底栏跟着更新。 */
        unsubscribe.push(agent.onChange(function (reason) { if (reason === 'settings' && overlay && overlay.open) refreshFoot(); }));
        unsubscribe.push(memory.onChange(function (reason) {
          if (!overlay || !overlay.open) return;
          if (reason === 'chat') { if (!running) renderHistory(); refreshFoot(); }
          if (tab === 'memory' && reason !== 'settings' && !editing) renderMemory();
        }));
      }
      return true;
    }

    function close() {
      if (!overlay) return;
      try { if (overlay.open && typeof overlay.close === 'function') overlay.close(); else overlay.removeAttribute('open'); } catch (error) { overlay.removeAttribute('open'); }
    }

    function dispose() {
      pendingConfirms.slice().forEach(function (finish) { finish('deny'); });
      unsubscribe.forEach(function (stop) { try { stop(); } catch (error) { /* ignore */ } });
      unsubscribe = [];
      close();
      if (overlay) overlay.remove();
      overlay = null;
      var style = doc && doc.getElementById(STYLE_ID);
      if (style) style.remove();
    }

    return { open: open, close: close, dispose: dispose, isOpen: function () { return !!(overlay && overlay.open); } };
  }

  modules.createAgentUi = createAgentUi;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ---- src/agent/boot.js ---- */
(function (root) {
  'use strict';

  /*
   * 扩展包（reader-ii.ext.js）的启动入口：装配环境 → 记忆 → Agent 内核 → 面板，挂到宿主窗口的 ReaderII 上。
   * 两种载体都走这里：酒馆扩展直接加载；酒馆助手脚本在没有扩展时也可以加载同一份包。
   * 重复加载是安全的：已经有实例就什么都不做。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var SETTINGS_NAMESPACE = 'reader_ii';

  function boot() {
    var env = modules.createEnv(root);
    var host = env.host;
    if (host.ReaderII && host.ReaderII.ready === true) return host.ReaderII;

    var kit = modules.createHostKit(env);
    var llm = modules.createLlmGateway(env);
    var memory = modules.createMemorySystem(env, llm, kit);
    var store = modules.createStore(env);
    var journal = modules.createJournal(store);
    var vfs = modules.createVfs({ journal: journal });
    var registry = modules.createRegistry();
    var probe = modules.installPageProbe(env);
    var agent = null, ui = null;

    /* 设置随酒馆账号走（extension_settings）；拿不到时退回 localStorage。 */
    var settingsIo = {
      read: function () {
        var ctx = kit.context();
        var bag = ctx && ctx.extensionSettings && ctx.extensionSettings[SETTINGS_NAMESPACE];
        if (bag && modules.isObject(bag.agent)) return bag.agent;
        return kit.localRead('reader_ii_agent_settings_v1', {});
      },
      write: function (value) {
        kit.localWrite('reader_ii_agent_settings_v1', value);
        var ctx = kit.context();
        if (!ctx || !ctx.extensionSettings) return;
        ctx.extensionSettings[SETTINGS_NAMESPACE] = Object.assign({}, ctx.extensionSettings[SETTINGS_NAMESPACE], { agent: value });
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
      }
    };

    function describeEnv() {
      var ctx = kit.context() || {};
      var version = '';
      try { version = host.TavernHelper && typeof host.TavernHelper.getTavernHelperVersion === 'function' ? host.TavernHelper.getTavernHelperVersion() : ''; } catch (error) { version = ''; }
      return {
        reader_ii: modules.READER_AGENT_VERSION, carrier: env.carrier,
        tauritavern: !!host.__TAURITAVERN__, tavern_helper: host.TavernHelper ? version || true : false,
        mobile: /Android|iPhone|iPad|Mobile/i.test(String(host.navigator && host.navigator.userAgent || '')),
        character: ctx.name2 || '', chat_length: Array.isArray(ctx.chat) ? ctx.chat.length : 0,
        plugins: agent ? agent.listConnectors().map(function (item) { return item.title; }) : [],
        permission: agent ? agent.permissions.describe() : ''
      };
    }

    modules.installBuiltinProviders(vfs, env, kit, { store: store, probe: probe, describeEnv: describeEnv, memory: memory });
    modules.installCoreTools(registry, { vfs: vfs, env: env, kit: kit });
    var legacy = modules.createAgentTools(env, kit, {
      core: function () { return host.ReaderCore && host.ReaderCore.__reader_core_api ? host.ReaderCore : null; },
      memory: memory,
      shell: function () { return host.ReaderShell || null; },
      openUi: function (tab) { return ui ? ui.open(tab) : null; }
    });
    modules.adoptLegacyTools(registry, legacy);
    var skills = modules.installSkills(registry, vfs, env, store);
    var connectors = modules.installConnectors(registry, env, kit, function () { return agent ? agent.getSettings().connectors : []; });

    agent = modules.createAgent(env, llm, kit, memory, {
      registry: registry, vfs: vfs, journal: journal, connectors: connectors, settingsIo: settingsIo, apiTier: legacy.apiTier,
      core: function () { return host.ReaderCore && host.ReaderCore.__reader_core_api ? host.ReaderCore : null; }
    });
    var updates = modules.createUpdater(env, kit);
    ui = modules.createAgentUi(env, kit, agent, memory, llm, {
      updates: updates,
      shell: function () { return host.ReaderShell || null; },
      core: function () { return host.ReaderCore && host.ReaderCore.__reader_core_api ? host.ReaderCore : null; }
    });

    try { memory.install(); } catch (error) { env.console.warn('[ReaderII] 记忆系统启动失败', error); }
    connectors.refresh();
    skills.loadUserSkills().catch(function () { /* 工作区不可用时没有用户知识 */ });

    var api = {
      version: modules.READER_AGENT_VERSION, ready: true, carrier: env.carrier,
      agent: Object.assign(agent, { open: ui.open, close: ui.close }),
      memory: memory, kit: kit, llm: llm, vfs: vfs, updates: updates,
      dispose: function () {
        try { ui.dispose(); } catch (error) { /* ignore */ }
        try { memory.dispose(); } catch (error) { /* ignore */ }
      }
    };
    host.ReaderII = api;
    host.ReaderAgent = api.agent;
    host.ReaderMemory = memory;

    /* 比我们早加载的插件可以把登记动作排进 __ReaderIIQueue，这里统一执行。 */
    var queue = Array.isArray(host.__ReaderIIQueue) ? host.__ReaderIIQueue.splice(0) : [];
    host.__ReaderIIQueue = { push: function (task) { try { task(api); } catch (error) { env.console.warn('[ReaderII] 插件登记失败', error); } } };
    queue.forEach(function (task) { host.__ReaderIIQueue.push(task); });
    try { host.dispatchEvent(new host.CustomEvent('reader-ii:ready', { detail: { version: api.version } })); } catch (error) { /* ignore */ }
    env.console.info('[ReaderII] 夜梦助手就绪', api.version, env.carrier);
    return api;
  }

  modules.bootReaderII = boot;
  if (root.__READER_II_NO_AUTOBOOT__ !== true) {
    try { boot(); } catch (error) { (root.console || console).error('[ReaderII] 启动失败', error); }
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
