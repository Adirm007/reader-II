(function (root) {
  'use strict';

  /*
   * 常驻壳 host.ReaderShell（交接 7.D；参照上游 core-runtime.mjs。上游把它叫 ReaderCore，通用版里那是语义层，见交接 4.2）。
   *  · 控制器：酒馆主文档里一个隐藏的 iframe，大厅、菜单、悬浮信封都归它管。壳给它注入酒馆助手代理、SillyTavern、
   *    酒馆助手的几个全局函数与语义层 ReaderCore；聊天切换时整个重建；生成前（GENERATION_AFTER_COMMANDS）先确保它就绪。
   *  · 轻信：正则只留 [data-reader-dream-slot] 插槽，这里把它挂成轻信 iframe（递归进同源的嵌套 iframe），
   *    并在 iframe 上写 data-reader-message-id；轻信自己找 host.ReaderShell 登记，壳把控制器的设置推给它们。
   *  · 启动时清掉旧版留在酒馆主文档里的节点。不接管旧完整版信封（上游的 adoptLegacyFrame 一族、replaceRuntime 等都不要）。
   * 资源包 modules.READER_ASSETS_GZIP 由构建生成：gzip + base64 的 JSON {version, css, body, controller, letterViews, letterScript}。
   * 本文件会进主脚本：不能出现酒馆宏的写法，也不能出现结束 script 标签的写法（构建会查）。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  var FRAME_ID = 'reader-ii-controller';
  /* 旧版留下的节点：上游 retireLegacyMenu 的那份列表，加上更早的启动按钮。 */
  var LEGACY_IDS = [
    'dfb', 'dfo', 'dfc', 'dream-hb', 'dream-p-toast', 'dlb-overlay', 'dlb-style', 'cp-overlay', 'cp-style',
    'cpl-overlay', 'cpl-style', 'dgl-overlay', 'dgl-style-v2', 'chess-overlay', 'chess-styles', 'bs-overlay',
    'bs-detail-ov', 'bs-styles', 'dream-addon-style-v3', 'dream-ink-native-v1', 'dream-theme-fix',
    'reader-template-system-overlay', 'reader-template-system-style', 'reader-core-launcher'
  ];
  var CHANGE_EVENTS = [
    'CHAT_CHANGED', 'MESSAGE_SENT', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_RECEIVED',
    'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'GENERATION_ENDED'
  ];
  var CONTROLLER_GLOBALS = ['eventOn', 'eventMakeFirst', 'eventEmit', 'tavern_events', 'getCurrentMessageId', 'getAllVariables'];
  var SLOT = '[data-reader-dream-slot]';
  var SOURCE = '[data-reader-dream-source]';
  var MOUNTED = 'data-reader-mounted';
  var LETTER_FRAME = 'data-reader-dream-frame';
  var MESSAGE_ID = 'data-reader-message-id';
  var SCAN_DELAY_MS = 30;
  /* 流式输出时每来一段字，酒馆都会重画整楼，插槽也跟着换新。插槽要稳定这么久才挂，免得每段字都建一个 iframe。 */
  var STABLE_MS = 250;
  /* 生成前最多等控制器这么久：控制器起不来时不能把生成一直卡住。 */
  var PREPARE_TIMEOUT_MS = 10000;
  var MAX_DEPTH = 6;
  var USER_MACRO = new RegExp('<' + 'user>|\\{\\{' + 'user\\}\\}', 'gi');
  var CHAR_MACRO = new RegExp('<' + '(?:bot|char)>|\\{\\{' + 'char\\}\\}', 'gi');
  var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var SCRIPT_OPEN = '<scr' + 'ipt>';
  var SCRIPT_CLOSE = '</scr' + 'ipt>';

  /* 轻信页自己量高度、写回自己的 iframe（逻辑同旧 reader-render-mount）：壳重启或卸载后照常工作，也不用壳替每封信留观察器。
   * 不取 documentElement.scrollHeight——它不小于视口，信折起来时 iframe 就缩不回去了。 */
  function letterResize() {
    var frame = window.frameElement, pending = false;
    if (!frame) return;
    function measure() {
      pending = false;
      var body = document.body, html = document.documentElement;
      var height = Math.max(body ? body.scrollHeight : 0, body ? body.offsetHeight : 0, html ? html.offsetHeight : 0, 1);
      var next = Math.ceil(height) + 'px';
      if (frame.style.height !== next) frame.style.height = next;
    }
    function schedule() {
      if (pending) return;
      pending = true;
      if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(measure);
      else setTimeout(measure, 16);
    }
    if (typeof ResizeObserver === 'function') {
      var sizes = new ResizeObserver(schedule);
      sizes.observe(document.documentElement);
      if (document.body) sizes.observe(document.body);
    }
    if (typeof MutationObserver === 'function') {
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    window.addEventListener('load', schedule);
    window.addEventListener('resize', schedule);
    schedule();
  }
  var LETTER_RESIZE = '(' + letterResize.toString() + ')();';

  function safeGet(owner, name) {
    try { return owner ? owner[name] : undefined; } catch (error) { return undefined; }
  }

  function createShell(api, env, options) {
    var config = options || {};
    var host = env.host;
    var doc = env.document;
    var kit = api && api.kit || (typeof modules.createHostKit === 'function' ? modules.createHostKit(env) : null);
    var log = env.console || console;
    var inert = !doc || typeof doc.createElement !== 'function' || typeof doc.querySelectorAll !== 'function' || !doc.body;
    var state = { stopped: false, generation: 0, key: '', frame: null, ready: null, letters: new Set(), stops: [], listeners: [] };
    var resolveReady = null;
    var assetsPromise = null;
    var assetsVersion = '';
    var observed = new WeakSet();
    var records = [];
    var mounting = new WeakSet();
    var firstSeen = new WeakMap();
    var pendingDocs = [];
    var scanTimer = null;
    var scanDue = 0;

    /* ---------- 宿主信息 ---------- */
    function context() {
      try { return env.context() || null; } catch (error) { return null; }
    }

    function chatKey() {
      if (kit && typeof kit.chatKey === 'function') return kit.chatKey();
      var ctx = context();
      if (!ctx) return '';
      var chat = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
      return String(ctx.characterId == null ? '' : ctx.characterId) + '|' + String(chat == null ? '' : chat);
    }

    /* 酒馆宏：上游 macroText。控制器脚本用 script 模式（值写成能放进任何 JS 字符串字面量的转义），其余按 HTML 转义。 */
    function macroText(text, script) {
      var ctx = context() || {};
      function escaped(value) {
        if (script) {
          return JSON.stringify(String(value)).slice(1, -1)
            .replace(/'/g, '\\u0027').replace(/`/g, '\\u0060').replace(/\$/g, '\\u0024');
        }
        return String(value).replace(/[&<>"']/g, function (character) { return HTML_ESCAPES[character]; });
      }
      return String(text == null ? '' : text)
        .replace(USER_MACRO, function () { return escaped(ctx.name1 || '作家'); })
        .replace(CHAR_MACRO, function () { return escaped(ctx.name2 || '九十九夜梦'); });
    }

    /* 酒馆助手的全局在脚本 iframe 里，原样取（上游 globalThis[name] || win[name]）；不 bind，lodash 的 _ 绑了就丢了它的方法。 */
    function rawGlobal(name) {
      var value = safeGet(root, name);
      return value !== undefined ? value : safeGet(host, name);
    }

    /* 控制器找函数的顺序：酒馆助手 → 酒馆主窗口 → 原生实现（reader-native-host.js，没装酒馆助手时用）。 */
    function helperProxy() {
      return new Proxy({}, {
        get: function (_target, name) {
          var owners = [safeGet(root, 'TavernHelper'), safeGet(host, 'TavernHelper'), root, host];
          for (var index = 0; index < owners.length; index += 1) {
            var owner = owners[index];
            var value = safeGet(owner, name);
            if (value !== undefined) return typeof value === 'function' ? value.bind(owner) : value;
          }
          var fallback = typeof env.nativeHost === 'function' ? env.nativeHost() : null;
          return fallback ? safeGet(fallback, name) : undefined;
        }
      });
    }

    /*
     * 控制器用的几个全局函数。酒馆助手只把它们给自己的脚本 iframe；扩展里由我们直接对着酒馆的事件源实现，
     * 并记下这一个控制器订过的监听，控制器销毁时一并摘掉（酒馆助手是在 iframe 卸载时替脚本摘）。
     */
    function controllerGlobals(listeners) {
      function source() { var ctx = context(); return ctx && ctx.eventSource || null; }
      function subscribe(method) {
        return function (event, listener) {
          var target = source();
          if (!target || typeof target[method] !== 'function' || typeof listener !== 'function') return { stop: function () {} };
          target[method](event, listener);
          var record = { event: event, listener: listener };
          listeners.push(record);
          return { stop: function () {
            var at = listeners.indexOf(record);
            if (at >= 0) listeners.splice(at, 1);
            try { target.removeListener(event, listener); } catch (error) { /* ignore */ }
          } };
        };
      }
      return {
        eventOn: subscribe('on'),
        eventMakeFirst: subscribe('makeFirst'),
        eventEmit: function (event) {
          var target = source();
          return target ? target.emit.apply(target, arguments) : undefined;
        },
        tavern_events: env.tavern_events || {},
        getCurrentMessageId: latestMessageId,
        getAllVariables: function () {
          var read = function (type) { try { return env.getVariables({ type: type }) || {}; } catch (error) { return {}; } };
          return Object.assign({}, read('global'), read('chat'));
        }
      };
    }

    function releaseListeners(listeners) {
      var ctx = context();
      var target = ctx && ctx.eventSource;
      (listeners || []).splice(0).forEach(function (record) {
        try { if (target) target.removeListener(record.event, record.listener); } catch (error) { /* ignore */ }
      });
    }

    /* 这个聊天用不用 Reader（reader-core.js 的 isEnabled）。没有这个接口的宿主（旧测试）按启用算。 */
    function enabled() {
      try { return !api || typeof api.isEnabled !== 'function' || api.isEnabled() === true; } catch (error) { return false; }
    }

    function latestMessageId() {
      var ctx = context();
      if (ctx && Array.isArray(ctx.chat)) return ctx.chat.length - 1;
      try {
        var getLast = env.resolveFunction && env.resolveFunction('getLastMessageId');
        var last = getLast ? getLast() : null;
        if (Number.isInteger(last)) return last;
      } catch (error) { /* 退到 DOM */ }
      var max = -1;
      if (!inert) {
        var messages = doc.querySelectorAll('.mes[mesid]');
        for (var index = 0; index < messages.length; index += 1) max = Math.max(max, Number(messages[index].getAttribute('mesid')) || 0);
      }
      return max;
    }

    /* ---------- 资源包 ---------- */
    function checkAssets(value) {
      var current = value && value.letterViews && value.letterViews.current;
      var complete = value && typeof value.controller === 'string' && typeof value.body === 'string' && typeof value.css === 'string'
        && typeof value.letterScript === 'string' && current && typeof current.html === 'string' && typeof current.css === 'string';
      if (!complete) throw new Error('控制器资源包不完整');
      return value;
    }

    function loadAssets() {
      if (assetsPromise) return assetsPromise;
      assetsPromise = (async function () {
        var packed = modules.READER_ASSETS_GZIP;
        if (typeof packed !== 'string' || !packed) throw new Error('缺少控制器资源包（reader-assets 模块），请重新导入完整的脚本');
        var Decompression = root.DecompressionStream;
        if (typeof Decompression !== 'function') throw new Error('当前浏览器不支持 gzip 解压，读者界面无法启动');
        var binary = root.atob(packed);
        var bytes = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        var stream = new root.Blob([bytes]).stream().pipeThrough(new Decompression('gzip'));
        var assets = checkAssets(JSON.parse(await new root.Response(stream).text()));
        assetsVersion = String(assets.version || '');
        return assets;
      })();
      assetsPromise.catch(function (error) { log.error('[ReaderShell] 资源包解不开', error); });
      return assetsPromise;
    }

    /* ---------- 控制器 ---------- */
    function controllerApp() {
      try { return state.frame && state.frame.contentWindow && state.frame.contentWindow.ReaderController || null; }
      catch (error) { return null; }
    }

    function currentSettings() {
      var app = controllerApp();
      if (!app || typeof app.settings !== 'function') return null;
      try { return app.settings() || null; } catch (error) { return null; }
    }

    function refreshEnvelope() {
      var app = controllerApp();
      try { if (app && typeof app.refreshEnvelope === 'function') app.refreshEnvelope(); } catch (error) { /* 控制器自己会报 */ }
    }

    function finishReady(app) {
      var resolve = resolveReady;
      resolveReady = null;
      if (resolve) resolve(app);
    }

    function disposeController() {
      state.generation += 1;
      var frame = state.frame;
      state.frame = null;
      if (frame) {
        try {
          var app = frame.contentWindow && frame.contentWindow.ReaderController;
          if (app && typeof app.dispose === 'function') app.dispose();
        } catch (error) { log.warn('[ReaderShell] 清理界面', error); }
        try { frame.remove(); } catch (error) { /* ignore */ }
      }
      releaseListeners(state.listeners);
      finishReady(null);
      state.ready = null;
    }

    function ensure() {
      if (state.stopped || inert || !enabled()) return Promise.resolve(null);
      if (state.ready) return state.ready;
      var generation = ++state.generation;
      var ready = new Promise(function (resolve) { resolveReady = resolve; });
      state.ready = ready;
      loadAssets().then(function (assets) {
        if (state.stopped || generation !== state.generation) return;
        var frame = doc.createElement('iframe');
        frame.id = FRAME_ID;
        frame.title = '读者常驻控制器';
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;left:-4px;top:-4px;width:1px;height:1px;opacity:0;pointer-events:none;border:0;margin:0;padding:0';
        state.frame = frame;
        frame.addEventListener('load', function () { controllerLoaded(frame, generation, assets); }, { once: true });
        frame.srcdoc = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'
          + assets.css + '</style></head><body>' + macroText(assets.body, false) + '</body></html>';
        doc.body.appendChild(frame);
      }, function () {
        if (generation !== state.generation) return;
        finishReady(null);
        state.ready = null;
      });
      return ready;
    }

    function controllerLoaded(frame, generation, assets) {
      if (state.stopped || state.frame !== frame || generation !== state.generation) return;
      try {
        var target = frame.contentWindow;
        target.__readerRuntimeGeneration = generation;
        target.__readerHostApi = shell;
        target.ReaderCore = api;
        target.TavernHelper = helperProxy();
        target.SillyTavern = safeGet(host, 'SillyTavern');
        target.Mvu = rawGlobal('Mvu');
        target._ = rawGlobal('_');
        /* 脚本载体（酒馆助手的脚本 iframe）里这几个全局现成就有；扩展里用我们自己的实现。 */
        var shims = controllerGlobals(state.listeners);
        CONTROLLER_GLOBALS.forEach(function (name) {
          var given = env.carrier === 'script' ? rawGlobal(name) : undefined;
          target[name] = given !== undefined ? given : shims[name];
        });
        var script = frame.contentDocument.createElement('script');
        script.textContent = macroText(assets.controller, true);
        frame.contentDocument.body.appendChild(script);
        var app = target.ReaderController;
        if (!app) throw new Error('读者控制器未能启动');
        finishReady(app);
        /* 壳重启后，已经挂着的轻信要重新登记：它们登记过一次就不再听 reader:ready 了。 */
        reconnectLetters();
        notifyLetters();
        doc.dispatchEvent(new (host.Event || root.Event)('reader:ready'));
      } catch (error) {
        log.error('[ReaderShell] 常驻界面启动失败', error);
        try {
          frame.contentWindow.__readerControllerAlive = false;
          if (typeof frame.contentWindow.__readerCleanup === 'function') frame.contentWindow.__readerCleanup();
        } catch (cleanupError) { /* ignore */ }
        try { frame.remove(); } catch (removeError) { /* ignore */ }
        if (state.frame === frame) state.frame = null;
        finishReady(null);
        state.ready = null;
      }
    }

    /* ---------- 轻信登记 ---------- */
    function isLive(frame) {
      try { return !!frame && frame.isConnected && !!frame.ownerDocument && !!frame.ownerDocument.defaultView; }
      catch (error) { return false; }
    }

    function pruneLetters() {
      state.letters.forEach(function (letter) { if (!isLive(letter.frame)) state.letters.delete(letter); });
    }

    function refreshLetter(letter, settings) {
      try { if (typeof letter.refresh === 'function') letter.refresh(settings); }
      catch (error) { state.letters.delete(letter); }
    }

    /* 控制器没就绪时不推设置：空设置会让轻信先切到旧版视图再切回来。 */
    function notifyLetters() {
      if (state.stopped) return;
      pruneLetters();
      var settings = currentSettings();
      if (settings) state.letters.forEach(function (letter) { refreshLetter(letter, settings); });
      refreshEnvelope();
    }

    function registerLetter(letter) {
      if (state.stopped || inert || !letter || !isLive(letter.frame)) return function () {};
      state.letters.add(letter);
      var settings = currentSettings();
      if (settings) refreshLetter(letter, settings);
      refreshEnvelope();
      return function () { if (state.letters.delete(letter)) refreshEnvelope(); };
    }

    function getLetters(messageId) {
      var ctx = context();
      var chat = ctx && ctx.chat;
      var live = [];
      state.letters.forEach(function (letter) {
        if (!isLive(letter.frame)) return;
        var message = chat ? chat[Number(letter.messageId)] : null;
        var swipe = message && message.swipe_id != null ? message.swipe_id : 0;
        if (letter.swipeId != null && String(letter.swipeId) !== String(swipe)) return;
        try { if (typeof letter.isCurrent === 'function' && !letter.isCurrent()) return; } catch (error) { return; }
        live.push(letter);
      });
      if (messageId == null) messageId = latestMessageId();
      return live.filter(function (letter) { return String(letter.messageId) === String(messageId); })
        .sort(function (left, right) {
          var position = left.frame.compareDocumentPosition ? left.frame.compareDocumentPosition(right.frame) : 0;
          return position & 4 ? -1 : position & 2 ? 1 : 0;
        })
        .reduce(function (list, letter) {
          try { list.push(Object.assign({}, letter.read(), { frame: letter.frame })); } catch (error) { /* 读不了的信跳过 */ }
          return list;
        }, []);
    }

    /* ---------- 轻信挂载 ---------- */
    /* 一个文档里的 iframe（同源的才有 contentDocument）；控制器不算。 */
    function eachChildFrame(document, visit) {
      if (!document || typeof document.querySelectorAll !== 'function') return;
      var frames = document.querySelectorAll('iframe');
      for (var index = 0; index < frames.length; index += 1) {
        var frame = frames[index];
        if (frame === state.frame || frame.id === FRAME_ID) continue;
        var inner = null;
        try { inner = frame.contentDocument; } catch (error) { inner = null; }
        if (inner) visit(frame, inner);
      }
    }

    function forEachFrame(document, visit, depth) {
      if (depth > MAX_DEPTH) return;
      eachChildFrame(document, function (frame, inner) {
        visit(frame, inner);
        if (!frame.hasAttribute(LETTER_FRAME)) forEachFrame(inner, visit, depth + 1);
      });
    }

    function reconnectLetters() {
      forEachFrame(doc, function (frame) {
        try {
          var letter = frame.contentWindow && frame.contentWindow.ReaderLetter;
          if (letter && typeof letter.connect === 'function') letter.connect();
        } catch (error) { /* 跨域或已卸载 */ }
      }, 0);
    }

    /* 楼层号：插槽所在的 .mes[mesid]；嵌在正文美化的 iframe 里时，一层层往上找它所在的 iframe。 */
    function messageIdOf(node) {
      var current = node;
      for (var depth = 0; current && depth <= MAX_DEPTH; depth += 1) {
        try {
          var message = typeof current.closest === 'function' ? current.closest('.mes[mesid]') : null;
          if (message) return message.getAttribute('mesid');
          var view = current.ownerDocument && current.ownerDocument.defaultView;
          if (!view || view === host) return null;
          if (typeof view.getCurrentMessageId === 'function') {
            var id = view.getCurrentMessageId();
            if (id != null && id !== '') return String(id);
          }
          current = view.frameElement;
        } catch (error) { return null; }
      }
      return null;
    }

    function letterPage(assets, sourceHtml, ownerDocument) {
      var view = assets.letterViews.current;
      var template = ownerDocument.createElement('template');
      template.innerHTML = macroText(view.html, false);
      var body = template.content.querySelector('.text-body-royal');
      if (!body) throw new Error('轻信视图缺少正文位置（.text-body-royal）');
      body.innerHTML = sourceHtml;
      return '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<style id="reader-letter-style">' + view.css + '</style></head><body>' + template.innerHTML
        + SCRIPT_OPEN + LETTER_RESIZE + SCRIPT_CLOSE + SCRIPT_OPEN + assets.letterScript + SCRIPT_CLOSE + '</body></html>';
    }

    async function mountSlot(slot) {
      var mark = slot.getAttribute(MOUNTED);
      if (state.stopped || inert || mark === '1' || mark === 'failed' || mounting.has(slot)) return false;
      mounting.add(slot);
      slot.setAttribute(MOUNTED, 'loading');
      var source = slot.querySelector(SOURCE);
      var sourceHtml = source ? source.innerHTML : '';
      try {
        var assets = await loadAssets();
        /* 停了就留着 loading：下一个壳会把它当成没挂过的插槽。 */
        if (state.stopped || !slot.isConnected) return false;
        var ownerDocument = slot.ownerDocument;
        var frame = ownerDocument.createElement('iframe');
        frame.setAttribute(LETTER_FRAME, '1');
        var messageId = messageIdOf(slot);
        if (messageId != null) frame.setAttribute(MESSAGE_ID, messageId);
        frame.setAttribute('title', '夜梦的来信');
        frame.setAttribute('scrolling', 'no');
        frame.style.cssText = 'display:block;width:100%;height:1px;border:0;background:transparent;overflow:hidden';
        frame.srcdoc = letterPage(assets, sourceHtml, ownerDocument);
        slot.replaceChildren(frame);
        slot.setAttribute(MOUNTED, '1');
        return true;
      } catch (error) {
        slot.setAttribute(MOUNTED, 'failed');
        log.warn('[ReaderShell] 轻信挂载失败，已保留原文', error);
        return false;
      } finally {
        mounting.delete(slot);
      }
    }

    function observeDocument(document) {
      if (observed.has(document)) return;
      observed.add(document);
      var record = { document: document, observer: null, onLoad: null };
      if (typeof root.MutationObserver === 'function' && document.documentElement) {
        record.observer = new root.MutationObserver(function () { scheduleScan(document); });
        record.observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      /* iframe 的 load 不冒泡，但会经过捕获阶段：每个文档挂一个就能接住它里面所有 iframe 换页。 */
      record.onLoad = function (event) {
        var frame = event.target;
        if (!frame || frame.tagName !== 'IFRAME' || frame === state.frame || frame.hasAttribute(LETTER_FRAME)) return;
        try { if (frame.contentDocument) scheduleScan(frame.contentDocument, 0); } catch (error) { /* 跨域 */ }
      };
      document.addEventListener('load', record.onLoad, true);
      records.push(record);
    }

    function releaseRecord(record) {
      try { if (record.observer) record.observer.disconnect(); } catch (error) { /* ignore */ }
      try { record.document.removeEventListener('load', record.onLoad, true); } catch (error) { /* ignore */ }
    }

    /* 被移走的 iframe 的文档没有 defaultView 了，丢掉它的观察器。 */
    function pruneRecords() {
      records = records.filter(function (record) {
        var alive = false;
        try { alive = !!record.document.defaultView; } catch (error) { alive = false; }
        if (!alive) releaseRecord(record);
        return alive;
      });
    }

    function scanDocument(document, force, depth) {
      if (state.stopped || inert || !enabled() || !document || depth > MAX_DEPTH || typeof document.querySelectorAll !== 'function') return 0;
      observeDocument(document);
      var count = 0;
      var now = Date.now();
      var slots = document.querySelectorAll(SLOT);
      for (var index = 0; index < slots.length; index += 1) {
        var slot = slots[index];
        var mark = slot.getAttribute(MOUNTED);
        /* loading 却不在本壳的挂载中：外层渲染复制出来的陈旧占位，或上一个壳没挂完，重新挂。 */
        if (mark === '1' || mark === 'failed' || mounting.has(slot)) continue;
        if (!force) {
          var seen = firstSeen.get(slot);
          if (seen === undefined) { seen = now; firstSeen.set(slot, now); }
          if (now - seen < STABLE_MS) { scheduleScan(document, STABLE_MS - (now - seen)); continue; }
        }
        count += 1;
        mountSlot(slot);
      }
      eachChildFrame(document, function (frame, inner) {
        if (!frame.hasAttribute(LETTER_FRAME)) count += scanDocument(inner, force, depth + 1);
      });
      return count;
    }

    function scheduleScan(document, delay) {
      if (state.stopped || inert || !document) return;
      if (pendingDocs.indexOf(document) < 0) pendingDocs.push(document);
      var due = Date.now() + (delay == null ? SCAN_DELAY_MS : Math.max(0, delay));
      if (scanTimer !== null && scanDue <= due) return;
      clearTimeout(scanTimer);
      scanDue = due;
      scanTimer = setTimeout(flushScans, Math.max(0, due - Date.now()));
    }

    function flushScans() {
      scanTimer = null;
      pruneRecords();
      pendingDocs.splice(0).forEach(function (document) {
        try { scanDocument(document, false, 0); } catch (error) { log.warn('[ReaderShell] 扫描插槽失败', error); }
      });
    }

    /* 对外的 scan：立刻挂当前所有插槽（不等稳定），返回开始挂载的个数。 */
    function scanAll() {
      if (state.stopped || inert) return 0;
      pruneRecords();
      return scanDocument(doc, true, 0);
    }

    /* ---------- 聊天切换与生命周期 ---------- */
    /* 控制器按「聊天 + 这个聊天用不用 Reader」重建：换聊天、或在这张卡上开关 Reader 时都换一个。 */
    function stateKey() { return chatKey() + (enabled() ? '' : '|off'); }

    function changed() {
      if (state.stopped || inert) return;
      var next = stateKey();
      if (next === state.key) { notifyLetters(); return; }
      disposeController();
      state.key = next;
      /* 只丢已经不在页面上的信：新聊天的信可能在 CHAT_CHANGED 之前就挂好并登记了。 */
      pruneLetters();
      ensure();
    }

    function onTavernEvent() {
      changed();
      scheduleScan(doc);
    }

    function listen(name, handler) {
      try {
        if (kit && typeof kit.on === 'function') return kit.on(name, handler);
        var events = env.tavern_events || {};
        return events[name] && typeof env.eventOn === 'function' ? env.eventOn(events[name], handler) : null;
      } catch (error) { return null; }
    }

    function withTimeout(promise, ms) {
      var timer = null;
      var timeout = new Promise(function (resolve) { timer = setTimeout(resolve, ms); });
      return Promise.race([promise, timeout]).then(function (value) { clearTimeout(timer); return value; });
    }

    function retireLegacy() {
      var previous = safeGet(host, 'ReaderShell');
      if (previous && previous !== shell && typeof previous.stop === 'function') {
        try { previous.stop(); } catch (error) { log.warn('[ReaderShell] 停止上一个壳', error); }
      }
      try {
        if (host.__dhb) { host.clearInterval(host.__dhb); host.__dhb = null; }
      } catch (error) { /* ignore */ }
      var stale = doc.getElementById(FRAME_ID);
      if (stale) {
        try {
          var app = stale.contentWindow && stale.contentWindow.ReaderController;
          if (app && typeof app.dispose === 'function') app.dispose();
        } catch (error) { /* 上一个控制器已坏 */ }
        stale.remove();
      }
      LEGACY_IDS.forEach(function (id) {
        var node = doc.getElementById(id);
        if (node) node.remove();
      });
    }

    function stop() {
      if (state.stopped) return;
      state.stopped = true;
      disposeController();
      state.stops.splice(0).forEach(function (dispose) { try { dispose(); } catch (error) { /* ignore */ } });
      records.splice(0).forEach(releaseRecord);
      clearTimeout(scanTimer);
      scanTimer = null;
      pendingDocs.length = 0;
      state.letters.clear();
      try { if (host.ReaderShell === shell) delete host.ReaderShell; } catch (error) { /* ignore */ }
    }

    var shell = {
      __reader_shell_api: true,
      get runtimeVersion() { return assetsVersion || String(modules.VERSION || ''); },
      canOwnEnvelope: true,
      getLatestMessageId: latestMessageId,
      macroText: macroText,
      open: async function (page) {
        var key = state.key, generation = state.generation;
        var app = await ensure();
        if (!app || state.stopped || key !== state.key || generation !== state.generation && controllerApp() !== app) return false;
        return app.open(page == null ? 'lobby' : page);
      },
      close: function () {
        var app = controllerApp();
        return app && typeof app.close === 'function' ? app.close() : undefined;
      },
      command: async function (name) {
        var args = Array.prototype.slice.call(arguments, 1);
        var app = await ensure();
        if (!app || state.stopped || stateKey() !== state.key || controllerApp() !== app) return false;
        return app.command.apply(app, [name].concat(args));
      },
      settings: function () { return currentSettings() || {}; },
      registerLetter: registerLetter,
      getLetters: getLetters,
      notifyLetters: notifyLetters,
      refresh: notifyLetters,
      scan: scanAll,
      get ready() { return ensure(); },
      get isAlive() { return !state.stopped; },
      stop: stop
    };

    if (inert) {
      log.warn('[ReaderShell] 拿不到酒馆页面，轻信与读者菜单不会出现');
      try { host.ReaderShell = shell; } catch (error) { /* ignore */ }
      return shell;
    }

    retireLegacy();
    state.key = stateKey();
    host.ReaderShell = shell;

    var subscribed = false;
    CHANGE_EVENTS.forEach(function (name) {
      var handle = listen(name, onTavernEvent);
      if (!handle) return;
      subscribed = true;
      if (typeof handle.stop === 'function') state.stops.push(function () { handle.stop(); });
    });
    if (!subscribed) {
      /* 没有酒馆事件可听（预览页）：至少接住显式的聊天切换。 */
      doc.addEventListener('reader:chat-changed', onTavernEvent);
      state.stops.push(function () { doc.removeEventListener('reader:chat-changed', onTavernEvent); });
    }

    /* 酒馆在拼世界书与 EJS 提示词之前会等这个原生事件：第一次发送不能抢在控制器的提示词缓存之前。 */
    var ctx = context();
    var source = ctx && ctx.eventSource;
    var nativeEvents = ctx && (ctx.eventTypes || ctx.event_types) || env.tavern_events || {};
    if (source && typeof source.makeFirst === 'function' && typeof source.removeListener === 'function' && nativeEvents.GENERATION_AFTER_COMMANDS) {
      var prepare = function (_type, _options, dryRun) {
        if (state.stopped || dryRun) return undefined;
        changed();
        return withTimeout(ensure(), config.prepareTimeout || PREPARE_TIMEOUT_MS).then(function () { return undefined; });
      };
      source.makeFirst(nativeEvents.GENERATION_AFTER_COMMANDS, prepare);
      state.stops.push(function () { source.removeListener(nativeEvents.GENERATION_AFTER_COMMANDS, prepare); });
    }

    /* 在这张卡上开关 Reader（reader-core.js 的 setEnabled）：控制器跟着建或拆。 */
    var onCoreChanged = function (event) {
      if (event && event.detail && event.detail.reason === 'enabled_changed') onTavernEvent();
    };
    try {
      host.addEventListener('reader-core-changed', onCoreChanged);
      state.stops.push(function () { host.removeEventListener('reader-core-changed', onCoreChanged); });
    } catch (error) { /* ignore */ }

    ensure();
    scheduleScan(doc, 0);
    return shell;
  }

  modules.createShell = createShell;
})(typeof globalThis !== 'undefined' ? globalThis : window);
