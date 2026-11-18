(function (root) {
  'use strict';

  /*
   * 检查更新：比对更新源上 manifest.json 的版本。扩展的更新走酒馆自带的扩展更新（git pull），这里只负责告诉用户有没有新版。
   *
   * 4.1 起 Reader-II 只有扩展这一个组件：语义层、读者界面、提示词都在扩展包里，不再有要另外代装的酒馆助手脚本、
   * 世界书与正则（alpha 版的「检查卡内组件 / 安装卡内组件」因此取消；旧组件由 reader-prompt.js 的 retireLegacy 接管）。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var DEFAULT_REMOTES = ['https://raw.githubusercontent.com/Adirm007/reader-II/main/', 'https://cdn.jsdelivr.net/gh/Adirm007/reader-II@main/'];

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

  function createUpdater(env, kit) {
    var host = env.host;
    var NAMESPACE = 'reader_ii', LOCAL_KEY = 'reader_ii_updates_v1';

    function message(error) { return String(error && error.message || error); }
    function context() { return kit.context(); }

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
        lastCheck: bag.lastCheck || null
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

    async function fetchText(url) {
      if (typeof host.fetch !== 'function') throw new Error('当前环境不能联网');
      var controller = typeof host.AbortController === 'function' ? new host.AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 30000) : null;
      try {
        var response = await host.fetch(url, { cache: 'no-store', signal: controller ? controller.signal : undefined });
        if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : '无响应'));
        return await response.text();
      } catch (error) {
        throw new Error(url + ' 下载失败：' + (error && error.name === 'AbortError' ? '超时' : message(error)));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    /* 按顺序请求更新源，第一个成功的为准。全部失败时 ok 为 false：不能据此判断已是最新。 */
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
          var result = { ok: true, current: current, latest: manifest.version, source: base, status: order > 0 ? 'newer' : order < 0 ? 'older' : 'same', errors: errors };
          saveSettings({ lastCheck: { at: Date.now(), latest: manifest.version, status: result.status, source: base } });
          return result;
        } catch (error) {
          errors.push(base + ' —— ' + message(error));
        }
      }
      return { ok: false, current: current, status: 'failed', errors: errors };
    }

    return {
      version: runningVersion,
      compareVersions: compareVersions,
      getSettings: getSettings,
      saveSettings: saveSettings,
      checkRemote: checkRemote,
      defaults: { remotes: DEFAULT_REMOTES.slice() }
    };
  }

  modules.createUpdater = createUpdater;
  modules.compareReaderVersions = compareVersions;
})(typeof globalThis !== 'undefined' ? globalThis : window);
