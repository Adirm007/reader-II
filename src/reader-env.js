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
