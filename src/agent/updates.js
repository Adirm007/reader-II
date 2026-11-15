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
