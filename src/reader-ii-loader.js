(function (root) {
  'use strict';

  /*
   * Reader-II 夜梦助手加载器（酒馆助手脚本；构建产物 dist/reader-ii.loader.json，可选）。
   * 给「没装 Reader-II 酒馆扩展、聊天里也没有 Reader-II 卡内组件」的情况：从 CDN 把扩展包 dist/reader-ii.ext.js
   * （与扩展同一份，交接 0.3）加载进酒馆页面，夜梦助手与记忆就能在任意聊天里用。
   * 装了扩展（index.js 写下 __ReaderIIBase）、或卡内组件（reader-core.js）已经在加载时，只等它就绪，不重复加载。
   * 地址与加载方式和 reader-core.js 的 ensureReaderII 相同。停用本脚本不会卸下已经加载的扩展包，刷新页面后才不再加载。
   */
  var EXT_BASE = 'https://cdn.jsdelivr.net/gh/Adirm007/reader-II@main/';
  var WAIT_MS = 20000;
  var loading = null;
  var cancels = [];
  var stopped = false;

  function get(target, name) {
    try { return target[name]; } catch (error) { return undefined; }
  }

  function sameOrigin(win) {
    try { return !!win && !!win.document; } catch (error) { return false; }
  }

  /* 酒馆主窗口：往上找最外层、同源、有 SillyTavern.getContext 的那一层（脚本 iframe 自己也可能带着 SillyTavern）。 */
  function findHost() {
    var current = root;
    var found = null;
    for (var depth = 0; current && depth < 6; depth += 1) {
      try {
        if (sameOrigin(current) && current.SillyTavern && typeof current.SillyTavern.getContext === 'function') found = current;
      } catch (error) { /* 跨域的上层 */ }
      var parent = get(current, 'parent');
      if (!parent || parent === current) break;
      current = parent;
    }
    if (found) return found;
    var direct = get(root, 'parent');
    return direct && direct !== root && sameOrigin(direct) ? direct : root;
  }

  var host = findHost();

  function currentReaderII() {
    var api = get(host, 'ReaderII');
    return api && api.ready === true && api.agent && typeof api.agent.open === 'function' ? api : null;
  }

  function extensionInstalled() {
    return !!get(host, '__ReaderIIBase') && get(host, '__ReaderIICdn') !== true;
  }

  function ensureReaderII() {
    var existing = currentReaderII();
    if (existing) return Promise.resolve(existing);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var settled = false;
      var poll = null;
      var timer = null;
      function finish(error) {
        if (settled) return;
        var api = currentReaderII();
        if (!error && !api) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        try { host.removeEventListener('reader-ii:ready', check); } catch (removeError) { /* ignore */ }
        if (error) reject(error);
        else resolve(api);
      }
      function check() { finish(null); }
      cancels.push(function () { finish(new Error('夜梦助手加载器已停用')); });
      try { host.addEventListener('reader-ii:ready', check); } catch (listenError) { /* 轮询兜底 */ }
      poll = setInterval(check, 250);
      timer = setTimeout(function () {
        finish(new Error('夜梦助手加载超时：请检查网络，或安装 Reader-II 酒馆扩展'));
      }, WAIT_MS);
      if (extensionInstalled()) return;
      var doc = get(host, 'document');
      if (!doc || !doc.head || typeof doc.createElement !== 'function') {
        finish(new Error('无法访问酒馆页面，夜梦助手加载失败'));
        return;
      }
      if (typeof doc.querySelector === 'function' && doc.querySelector('script[data-reader-ii]')) return;
      var base = String(root.__READER_II_EXT_BASE__ || EXT_BASE);
      try {
        host.__ReaderIICdn = true;
        if (!host.__ReaderIIBase) host.__ReaderIIBase = base;
      } catch (markError) { /* ignore */ }
      var script = doc.createElement('script');
      script.src = base + 'dist/reader-ii.ext.js';
      script.setAttribute('data-reader-ii', 'cdn');
      script.onerror = function () {
        try { if (script.parentNode) script.parentNode.removeChild(script); } catch (removeError) { /* ignore */ }
        finish(new Error('夜梦助手扩展包加载失败：' + script.src));
      };
      doc.head.appendChild(script);
    });
    loading.then(function () { loading = null; }, function () { loading = null; });
    return loading;
  }

  function warn(error, toast) {
    try { root.console.warn('[ReaderII 加载器]', error); } catch (logError) { /* ignore */ }
    if (!toast) return;
    var toastr = get(root, 'toastr') || get(host, 'toastr');
    if (toastr && typeof toastr.warning === 'function') toastr.warning(error && error.message ? error.message : String(error), '夜梦助手');
  }

  function open(tab) {
    return ensureReaderII().then(function (api) {
      api.agent.open(tab);
      return true;
    }, function (error) {
      warn(error, !stopped);
      return false;
    });
  }

  var eventOn = get(root, 'eventOn');
  var getButtonEvent = get(root, 'getButtonEvent');
  if (typeof eventOn === 'function' && typeof getButtonEvent === 'function') {
    eventOn(getButtonEvent('夜梦助手'), function () { return open('chat'); });
    eventOn(getButtonEvent('记忆'), function () { return open('memory'); });
  }

  /* 一启动就在后台加载：记忆注入要扩展包在才工作。启动时的失败只记日志，点按钮时再重试并提示。 */
  if (!currentReaderII()) ensureReaderII().catch(function (error) { if (!stopped) warn(error, false); });

  try {
    root.addEventListener('pagehide', function () {
      stopped = true;
      cancels.splice(0).forEach(function (cancel) { cancel(); });
    });
  } catch (error) { /* 没有 pagehide 时不清理也无妨：计时器都会自己结束 */ }
})(typeof globalThis !== 'undefined' ? globalThis : window);
