(function (root) {
  'use strict';

  /*
   * 联网的公共层：密钥、主机信任、请求的几条路、网页转文字、抓取缓存。web 工具箱、MCP、GitHub 都走这里。
   *
   * 请求的几条路（按顺序试，前一条走不通才换下一条）：
   *   direct     浏览器直连。对方允许跨域才行（api.github.com、raw.githubusercontent.com、jsDelivr、多数公开 API）。
   *   companion  后端伴侣代发。没有跨域限制；要用户装了伴侣并放行。
   *   visit      酒馆自带的 /api/search/visit（原生酒馆都有，不用装任何东西）。只能 GET、不带自定义请求头，
   *              不访问 IP、localhost 与非标准端口。
   *   proxy      用户在设置里填的阅读代理（例如 https://r.jina.ai/{url}）。只能 GET；地址会交给那个服务，所以默认是空的。
   * 带认证头的请求不会走 visit / proxy；会改东西的请求（非 GET）默认只走 direct，除非调用方说明可以安全地换路。
   *
   * 主机信任：免问名单里的主机，加上用户在对话里亲口给过的网址的主机。其余主机第一次访问要问（effect: net）。
   * 原因：卡里、网页里的文字可能诱导她把聊天内容拼进网址发出去，「发往哪里」得让用户看一眼。
   *
   * 密钥（GitHub 令牌、MCP 请求头、伴侣令牌）只放这台设备的 localStorage，不进酒馆的 settings.json，
   * 也不出现在任何挂载点与工具结果里。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var SECRETS_KEY = 'reader_ii_secrets_v1';
  var DEFAULT_HOSTS = ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com', 'cdn.jsdelivr.net', 'docs.sillytavern.app'];
  var MAX_TEXT = 3000000;
  var PAGE_TTL = 15 * 60000;
  var PAGE_KEEP = 40;
  var ROUTE_LABEL = { direct: '浏览器直连', companion: '后端伴侣', visit: '酒馆后端', proxy: '阅读代理' };
  var BINARY_TYPE = /^(?:image|audio|video|font)\/|^application\/(?:octet-stream|zip|pdf|gzip|x-tar|x-7z-compressed|x-msdownload|wasm|msword|vnd\.)/;
  var TEXT_TYPE = /^text\/|(?:^|[\/+.-])(?:json|xml|javascript|yaml|csv|html|markdown)(?:$|[;\s+])/;

  /* 按 Content-Type 判断是不是二进制。application/vnd.github.raw+json、image/svg+xml 这类带 +json / +xml 的是文本。 */
  function isBinaryType(type) {
    var value = String(type || '').toLowerCase();
    return !TEXT_TYPE.test(value) && BINARY_TYPE.test(value);
  }

  function createSecrets(env) {
    var memory = {};
    function storage() { try { return env && env.storage || null; } catch (error) { return null; } }
    function readAll() {
      var store = storage();
      if (!store) return memory;
      try {
        var value = JSON.parse(store.getItem(SECRETS_KEY) || '{}');
        return modules.isObject(value) ? value : {};
      } catch (error) { return {}; }
    }
    function writeAll(value) {
      var store = storage();
      memory = value;
      if (!store) return false;
      try {
        if (Object.keys(value).length) store.setItem(SECRETS_KEY, JSON.stringify(value));
        else store.removeItem(SECRETS_KEY);
        return true;
      } catch (error) { return false; }
    }
    return {
      get: function (name) { return readAll()[name]; },
      set: function (name, value) {
        var all = Object.assign({}, readAll());
        if (value === undefined || value === null || value === '') delete all[name];
        else all[name] = value;
        writeAll(all);
      },
      /* 给界面看的：只露头尾。 */
      mask: function (text) {
        var source = String(text || '');
        if (!source) return '';
        return source.length <= 10 ? '••••' : source.slice(0, 4) + '…' + source.slice(-4);
      }
    };
  }

  function cleanHost(value) {
    var text = String(value || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[\/?#].*$/, '').replace(/^[^@]*@/, '');
    return /^(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/.test(text) || /^\[[0-9a-f:.]+\](?::\d+)?$/.test(text) ? text : '';
  }

  function normalizeWebSettings(input) {
    var source = modules.isObject(input) ? input : {};
    var list = Array.isArray(source.allowHosts) ? source.allowHosts : typeof source.allowHosts === 'string' ? source.allowHosts.split(/[\s,，;；]+/) : DEFAULT_HOSTS;
    var seen = {};
    var hosts = list.map(cleanHost).filter(function (host) {
      if (!host || seen[host]) return false;
      seen[host] = true;
      return true;
    }).slice(0, 200);
    var proxy = typeof source.proxy === 'string' ? source.proxy.trim().slice(0, 300) : '';
    if (proxy && (!/\{(?:url|enc)\}/.test(proxy) || !/^(?:https?:\/\/|\/)/.test(proxy))) proxy = '';
    return { allowHosts: hosts, proxy: proxy, visit: source.visit !== false };
  }

  function decodeEntities(text) {
    var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (match, code) {
      if (code[0] === '#') {
        var point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        try { return Number.isFinite(point) ? String.fromCodePoint(point) : match; } catch (error) { return match; }
      }
      var hit = named[code.toLowerCase()];
      return hit === undefined ? match : hit;
    });
  }

  function tidy(text) {
    return String(text).replace(/\r/g, '').replace(/[ \t\xa0]+\n/g, '\n').replace(/\n[ \t]+(?=\n)/g, '\n').replace(/[ \t\xa0]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* 没有 DOMParser 的环境（Node 测试）用的粗略转换。 */
  function htmlToTextPlain(html) {
    var source = String(html);
    var title = (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    var text = source
      .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<h([1-6])\b[^>]*>/gi, function (match, level) { return '\n\n' + '#'.repeat(Number(level)) + ' '; })
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|section|article|h[1-6]|ul|ol|table|tr|pre|blockquote)\s*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '');
    return { title: tidy(decodeEntities(title)), text: tidy(decodeEntities(text)) };
  }

  function createNet(env, kit, deps) {
    var host = env.host;
    var secrets = deps.secrets;
    var pages = new Map();
    var visitMissing = false;

    function settings() { return normalizeWebSettings(typeof deps.settings === 'function' ? deps.settings() : null); }

    function parse(url, base) {
      var Url = host && host.URL || (typeof URL === 'function' ? URL : null);
      if (!Url) return null;
      try { return base ? new Url(String(url), base) : new Url(String(url)); } catch (error) { return null; }
    }

    function hostOf(url) {
      var parsed = parse(url);
      return parsed ? String(parsed.host).toLowerCase() : '';
    }

    /* 用户亲口提到的主机：完整的网址，或「域名/…」这样的写法。 */
    function mentionedHosts(text) {
      var hosts = {};
      var source = String(text || '');
      source.replace(/https?:\/\/[^\s<>"'`，。；、）)】」]+/gi, function (match) {
        var parsed = parse(match);
        if (parsed) { hosts[String(parsed.host).toLowerCase()] = true; hosts[String(parsed.hostname).toLowerCase()] = true; }
        return match;
      });
      source.replace(/(?:^|[\s(（「“"'：:])((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?\//gi, function (match, name) {
        hosts[name.toLowerCase()] = true;
        return match;
      });
      return hosts;
    }

    function listed(parsed, list) {
      var full = String(parsed.host).toLowerCase(), name = String(parsed.hostname).toLowerCase();
      return list.some(function (entry) {
        if (entry.indexOf('*.') === 0) return name.length > entry.length - 1 && name.slice(-(entry.length - 1)) === entry.slice(1);
        return entry === full || entry === name;
      });
    }

    /* 这个网址不用问就能访问吗：在免问名单里，或者主机是用户自己给的。 */
    function trusted(url, userText) {
      var parsed = parse(url);
      if (!parsed || !/^https?:$/.test(parsed.protocol)) return false;
      if (listed(parsed, settings().allowHosts)) return true;
      var said = mentionedHosts(userText);
      return said[String(parsed.host).toLowerCase()] === true || said[String(parsed.hostname).toLowerCase()] === true;
    }

    function abortError() {
      var error = new Error('已取消');
      error.name = 'AbortError';
      return error;
    }

    function isAbort(error) { return !!error && error.name === 'AbortError'; }

    /* 给一次请求套上超时，并跟随调用方的取消信号。 */
    function guard(signal, ms) {
      if (typeof AbortController !== 'function') return { signal: signal, timedOut: function () { return false; }, done: function () {} };
      var controller = new AbortController();
      var timed = false;
      var timer = setTimeout(function () { timed = true; controller.abort(); }, ms);
      var forward = function () { controller.abort(); };
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', forward, { once: true });
      }
      return {
        signal: controller.signal,
        timedOut: function () { return timed; },
        done: function () { clearTimeout(timer); if (signal) { try { signal.removeEventListener('abort', forward); } catch (error) { /* ignore */ } } }
      };
    }

    async function pack(response, url) {
      var type = '';
      var headers = {};
      try { type = String(response.headers.get('content-type') || ''); } catch (error) { type = ''; }
      try { response.headers.forEach(function (value, key) { headers[String(key).toLowerCase()] = String(value); }); } catch (error) { if (type) headers['content-type'] = type; }
      var binary = isBinaryType(type);
      var text = binary ? '' : String(await response.text());
      return {
        status: response.status, ok: response.status >= 200 && response.status < 300, headers: headers, type: type,
        text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text, truncated: text.length > MAX_TEXT, binary: binary, url: response.url || url
      };
    }

    function plainHeaders(headers) {
      return !headers || Object.keys(headers).every(function (key) { return /^accept$/i.test(key); });
    }

    function tavernHeaders() {
      var ctx = kit.context();
      var extra = {};
      try { extra = ctx && typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() || {} : {}; } catch (error) { extra = {}; }
      return Object.assign({}, extra, { 'Content-Type': 'application/json' });
    }

    var ROUTES = {
      direct: async function (url, method, opts) {
        var limit = opts.timeoutMs || 30000;
        var watch = guard(opts.signal, limit);
        try {
          var init = { method: method, headers: opts.headers || {}, credentials: 'omit', redirect: 'follow', cache: 'no-store', referrerPolicy: 'no-referrer', signal: watch.signal };
          if (opts.body !== undefined && opts.body !== null) init.body = opts.body;
          return await pack(await host.fetch(url, init), url);
        } catch (error) {
          if (opts.signal && opts.signal.aborted) throw abortError();
          if (watch.timedOut()) throw new Error('超过 ' + Math.round(limit / 1000) + ' 秒没有回应');
          throw new Error('连不上，或对方不允许网页跨域读取');
        } finally { watch.done(); }
      },

      companion: async function (url, method, opts) {
        var client = typeof deps.companion === 'function' ? deps.companion() : null;
        if (!client || !client.usable()) return null;   /* 没放行，或不是「设备全权」档位：这条路不走 */
        var out = await client.call('http', {
          url: url, method: method, headers: opts.headers || {}, body: opts.body === undefined || opts.body === null ? null : String(opts.body),
          timeoutMs: opts.timeoutMs || 30000, sseUntilId: opts.sseUntilId === undefined ? null : opts.sseUntilId
        }, { signal: opts.signal, timeoutMs: (opts.timeoutMs || 30000) + 5000 });
        var headers = out.headers || {};
        return { status: out.status, ok: out.status >= 200 && out.status < 300, headers: headers, type: String(headers['content-type'] || ''), text: out.binary ? '' : String(out.text || ''), truncated: out.truncated === true, binary: out.binary === true, url: out.url || url };
      },

      visit: async function (url, method, opts) {
        if (method !== 'GET' || visitMissing || settings().visit === false || !plainHeaders(opts.headers)) return null;
        var parsed = parse(url);
        /* 酒馆后端的规矩：不访问 IP、localhost 与非标准端口。先在这里筛掉，免得白发一次请求。 */
        if (!parsed || parsed.port || /^(?:\d+\.){3}\d+$/.test(parsed.hostname) || /^\[/.test(parsed.hostname) || parsed.hostname === 'localhost' || /\.localhost$/.test(parsed.hostname)) return null;
        var ctx = kit.context();
        if (!ctx || typeof ctx.getRequestHeaders !== 'function') return null;
        var watch = guard(opts.signal, opts.timeoutMs || 30000);
        try {
          var response = await host.fetch('/api/search/visit', { method: 'POST', headers: tavernHeaders(), body: JSON.stringify({ url: url, html: false }), signal: watch.signal });
          if (response.status === 404 || response.status === 405) { visitMissing = true; return null; }
          if (response.status === 400) throw new Error('酒馆后端不肯访问这个地址');
          if (!response.ok) throw new Error('酒馆所在的网络取不回这个页面（对方报错或超时）');
          var out = await pack(response, url);
          out.status = 200; out.ok = true; out.url = url;
          return out;
        } catch (error) {
          if (opts.signal && opts.signal.aborted) throw abortError();
          if (watch.timedOut()) throw new Error('超时');
          throw error;
        } finally { watch.done(); }
      },

      proxy: async function (url, method, opts) {
        var template = settings().proxy;
        if (!template || method !== 'GET' || !plainHeaders(opts.headers)) return null;
        var target = template.replace(/\{enc\}/g, function () { return encodeURIComponent(url); }).replace(/\{url\}/g, function () { return url; });
        var same = target[0] === '/';
        var watch = guard(opts.signal, opts.timeoutMs || 30000);
        try {
          var response = await host.fetch(target, same ? { method: 'GET', headers: tavernHeaders(), signal: watch.signal } : { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', signal: watch.signal });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          var out = await pack(response, url);
          out.url = url;
          return out;
        } catch (error) {
          if (opts.signal && opts.signal.aborted) throw abortError();
          if (watch.timedOut()) throw new Error('超时');
          throw new Error(String(error && error.message || error));
        } finally { watch.done(); }
      }
    };

    /*
     * options: { method, headers, body, signal, timeoutMs, routes: ['direct', …], sseUntilId }
     * 返回 { status, ok, headers（键是小写）, type, text, binary, truncated, url, via }。HTTP 错误码不抛错，由调用方看 status。
     */
    async function request(url, options) {
      var opts = options || {};
      var method = String(opts.method || 'GET').toUpperCase();
      var parsed = parse(url);
      if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new Error('只能访问 http / https 地址：' + String(url).slice(0, 200));
      var order = Array.isArray(opts.routes) && opts.routes.length ? opts.routes : method === 'GET' || method === 'HEAD' ? ['direct', 'companion', 'visit', 'proxy'] : ['direct'];
      var tried = [];
      for (var index = 0; index < order.length; index += 1) {
        var name = order[index];
        if (!ROUTES[name]) continue;
        try {
          var out = await ROUTES[name](parsed.href, method, opts);
          if (out) { out.via = name; return out; }
        } catch (error) {
          if (isAbort(error)) throw error;
          tried.push(ROUTE_LABEL[name] + '：' + String(error && error.message || error).slice(0, 160));
        }
      }
      var advice = order.length > 1
        ? '。可以换的路：装上后端伴侣并放行；或请用户在助手设置的「联网」里填一个阅读代理'
        : '';
      throw new Error('访问不了 ' + parsed.href.slice(0, 200) + '（' + (tried.join('；') || '没有可用的路') + '）' + advice);
    }

    /* ---------- 网页转文字 ---------- */
    var BLOCK = { p: 1, div: 1, section: 1, article: 1, main: 1, ul: 1, ol: 1, table: 1, blockquote: 1, figure: 1, details: 1, dl: 1, header: 1, footer: 1, aside: 1, nav: 1, form: 1, fieldset: 1, address: 1 };
    var DROP = 'script,style,noscript,template,svg,iframe,canvas,button,input,select,textarea,link,meta,object,embed,audio,video';

    function htmlToText(html, base) {
      var Parser = host && host.DOMParser;
      if (typeof Parser !== 'function') return htmlToTextPlain(html);
      var doc;
      try { doc = new Parser().parseFromString(String(html), 'text/html'); } catch (error) { return htmlToTextPlain(html); }
      if (!doc || !doc.body) return htmlToTextPlain(html);
      var title = String(doc.title || '').trim();
      Array.prototype.forEach.call(doc.querySelectorAll(DROP), function (node) { node.remove(); });
      var body = doc.body;
      var total = String(body.textContent || '').length;
      var main = doc.querySelector('main, article, [role="main"], .markdown-body, #content, #main-content');
      var rootNode = body;
      if (main && String(main.textContent || '').length > Math.max(400, total * 0.3)) rootNode = main;
      else Array.prototype.forEach.call(body.querySelectorAll('nav, footer, aside'), function (node) { node.remove(); });

      var out = [];
      function absolute(href) {
        var parsed = parse(href, base);
        return parsed ? parsed.href : href;
      }
      function walk(node, pre) {
        if (node.nodeType === 3) { out.push(pre ? node.nodeValue : String(node.nodeValue).replace(/\s+/g, ' ')); return; }
        if (node.nodeType !== 1) return;
        var tag = String(node.tagName || '').toLowerCase();
        var each = function (flag) { Array.prototype.forEach.call(node.childNodes, function (child) { walk(child, flag); }); };
        if (/^h[1-6]$/.test(tag)) { out.push('\n\n' + '#'.repeat(Number(tag[1])) + ' '); each(false); out.push('\n\n'); return; }
        if (tag === 'br') { out.push('\n'); return; }
        if (tag === 'hr') { out.push('\n\n---\n\n'); return; }
        if (tag === 'li') { out.push('\n- '); each(pre); return; }
        if (tag === 'pre') { out.push('\n\n```\n' + String(node.textContent || '').replace(/\n+$/, '') + '\n```\n\n'); return; }
        if (tag === 'code' && !pre) { out.push('`' + String(node.textContent || '') + '`'); return; }
        if (tag === 'a') {
          var href = String(node.getAttribute('href') || '');
          var start = out.length;
          each(pre);
          var label = out.splice(start).join('').replace(/\s+/g, ' ').trim();
          if (!label) return;
          if (!href || /^(?:#|javascript:|data:|mailto:)/i.test(href)) out.push(label);
          else out.push('[' + label + '](' + absolute(href) + ')');
          return;
        }
        if (tag === 'img') {
          var alt = String(node.getAttribute('alt') || '').trim();
          if (alt) out.push('[图：' + alt + ']');
          return;
        }
        if (tag === 'tr') { out.push('\n'); each(pre); return; }
        if (tag === 'td' || tag === 'th') { each(pre); out.push(' | '); return; }
        if (BLOCK[tag]) { out.push('\n\n'); each(pre); out.push('\n\n'); return; }
        each(pre);
      }
      walk(rootNode, false);
      return { title: title, text: tidy(out.join('')) };
    }

    /* ---------- 抓取缓存（web:/ 挂载点读的就是它） ---------- */
    function keyFor(url, raw) {
      var parsed = parse(url);
      var slug = parsed ? (parsed.hostname + parsed.pathname).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) : 'page';
      return (slug || 'page') + '-' + modules.hashText(String(url) + (raw ? '#raw' : '')).slice(0, 5);
    }

    function remember(entry) {
      pages.delete(entry.key);
      pages.set(entry.key, entry);
      while (pages.size > PAGE_KEEP) pages.delete(pages.keys().next().value);
    }

    /* 抓一个网址并转成文字。返回 { key, url, finalUrl, title, text, type, via, at }。 */
    async function page(url, options) {
      var opts = options || {};
      var parsed = parse(url);
      if (!parsed) throw new Error('这不是一个完整的网址：' + String(url).slice(0, 200));
      parsed.hash = '';
      var target = parsed.href;
      var key = keyFor(target, opts.raw);
      var cached = pages.get(key);
      if (cached && !opts.refresh && Date.now() - cached.at < PAGE_TTL) return cached;
      var out = await request(target, {
        headers: { Accept: 'text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5' },
        signal: opts.signal, timeoutMs: opts.timeoutMs || 30000
      });
      if (out.status >= 400) throw new Error('对方返回 HTTP ' + out.status + (out.text ? '：' + out.text.replace(/\s+/g, ' ').slice(0, 200) : ''));
      if (out.binary) throw new Error('这个地址返回的是二进制内容（' + (out.type || '未知类型') + '），不能当文字读');
      var title = '', text = out.text;
      if (!opts.raw) {
        if (/html/i.test(out.type) || /^\s*<(?:!doctype|html)\b/i.test(text)) {
          var converted = htmlToText(text, out.url || target);
          title = converted.title;
          text = converted.text;
        } else if (/json/i.test(out.type)) {
          try { text = JSON.stringify(JSON.parse(text), null, 1); } catch (error) { /* 不是合法 JSON 就原样给 */ }
        }
      }
      var entry = { key: key, url: target, finalUrl: out.url || target, title: title, text: text, type: out.type, via: out.via, at: Date.now(), raw: opts.raw === true, truncated: out.truncated === true };
      remember(entry);
      return entry;
    }

    return {
      request: request, page: page, htmlToText: htmlToText,
      parse: parse, hostOf: hostOf, trusted: trusted, mentionedHosts: mentionedHosts,
      settings: settings, isAbort: isAbort, abortError: abortError, guard: guard, tavernHeaders: tavernHeaders,
      routeLabel: function (name) { return ROUTE_LABEL[name] || name; },
      pages: function () { return Array.from(pages.values()); },
      getPage: function (key) { return pages.get(key) || null; },
      dropPage: function (key) { return pages.delete(key); },
      secrets: secrets
    };
  }

  modules.WEB_DEFAULT_HOSTS = DEFAULT_HOSTS.slice();
  modules.normalizeWebSettings = normalizeWebSettings;
  modules.createSecrets = createSecrets;
  modules.createNet = createNet;
})(typeof globalThis !== 'undefined' ? globalThis : window);
