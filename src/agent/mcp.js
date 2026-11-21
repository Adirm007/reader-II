(function (root) {
  'use strict';

  /*
   * MCP（Model Context Protocol）客户端：把 MCP 服务器上的工具变成助手的工具箱。
   *
   * 三种来源：
   *   http    Streamable HTTP。浏览器直连（对方要允许跨域）；直连被拦、又连着后端伴侣时改由伴侣代发。
   *   stdio   在设备上启动的本地服务器（npx … 之类）。由后端伴侣启动并转发，所以要伴侣；TauriTavern 与手机上通常用不了。
   *   tt      TauriTavern 自带的 MCP 管理器里登记的服务器，经 window.__TAURITAVERN__.api.mcp 读目录、调用。
   *
   * 每个服务器一个工具箱 mcp/<id>，里面的工具叫 mcp_<id>_<工具名>。工具目录缓存在 IndexedDB：
   * 启动时只读缓存、不联网；联网发现只发生在用户点「添加 / 刷新 / 同步」，或助手调用 mcp_<id>_connect 的时候。
   *
   * 权限：MCP 工具算「联网」（effect: net）——不受档位限制，默认每次问，可在确认卡上选「本次对话都允许」。
   * 服务器的 trust 设成 hint 时，自称只读（readOnlyHint）的工具免问；设成 all 时这个服务器的工具都免问。
   * 服务器自报的 annotations 只是提示，不可信，所以默认不看它。
   *
   * 密钥（请求头、环境变量）不进设置，放本机 secrets 的 mcp.<id>。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var PROTOCOL = '2025-06-18';
  var KNOWN_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
  var TRUST = ['ask', 'hint', 'all'];
  var VIA = ['auto', 'direct', 'companion'];

  function slug(name) {
    var text = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
    if (!text) return '';
    return /^[a-z]/.test(text) ? text : ('s_' + text).slice(0, 24);
  }

  function stringMap(input, limit) {
    var output = {};
    if (!modules.isObject(input)) return output;
    Object.keys(input).slice(0, limit || 40).forEach(function (key) {
      if (typeof input[key] === 'string' || typeof input[key] === 'number' || typeof input[key] === 'boolean') output[String(key)] = String(input[key]);
    });
    return output;
  }

  function normalizeServer(input) {
    if (!modules.isObject(input)) return null;
    var id = /^[a-z][a-z0-9_]{0,23}$/.test(String(input.id || '')) ? String(input.id) : slug(input.id || input.name);
    /* 名字全是中文之类、拼不出 id 时，用名字的哈希。 */
    if (!id && String(input.name || input.id || '').trim()) id = 's' + modules.hashText(String(input.name || input.id).trim()).slice(0, 7);
    if (!id) return null;
    var server = {
      id: id, name: String(input.name || id).replace(/[\r\n<>]/g, ' ').trim().slice(0, 60) || id,
      enabled: input.enabled !== false,
      trust: TRUST.indexOf(input.trust) >= 0 ? input.trust : 'ask',
      via: VIA.indexOf(input.via) >= 0 ? input.via : 'auto'
    };
    if (typeof input.command === 'string' && input.command.trim()) {
      server.transport = 'stdio';
      server.command = input.command.trim().slice(0, 400);
      server.args = (Array.isArray(input.args) ? input.args : []).slice(0, 40).map(function (item) { return String(item).slice(0, 2000); });
      server.cwd = typeof input.cwd === 'string' ? input.cwd.trim().slice(0, 400) : '';
    } else if (typeof input.url === 'string' && /^https?:\/\/[^\s#]+$/i.test(input.url.trim())) {
      server.transport = 'http';
      server.url = input.url.trim().slice(0, 600);
    } else return null;
    return server;
  }

  function normalizeMcpSettings(input) {
    var source = modules.isObject(input) ? input : {};
    var seen = {};
    return {
      servers: (Array.isArray(source.servers) ? source.servers : []).map(normalizeServer).filter(function (server) {
        if (!server || seen[server.id]) return false;
        seen[server.id] = true;
        return true;
      }).slice(0, 20)
    };
  }

  /*
   * 解析用户粘贴的服务器描述。接受：
   *   { "mcpServers": { "名字": { "url": "…", "headers": {…} } } }     （Claude Desktop / Cursor 等的写法）
   *   { "名字": { "command": "npx", "args": […], "env": {…} } }
   *   { "name": "名字", "url": "…" }                                      （单个）
   * 返回 [{ server, secret: { headers, env } }]；不认识的写法直接抛错，不做「能导多少导多少」。
   */
  function parseServers(text) {
    var data;
    try { data = JSON.parse(String(text || '')); } catch (error) { throw new Error('不是合法的 JSON：' + error.message); }
    if (!modules.isObject(data)) throw new Error('要粘贴一个 JSON 对象');
    var table;
    if (modules.isObject(data.mcpServers)) table = data.mcpServers;
    else if (typeof data.url === 'string' || typeof data.command === 'string') { table = {}; table[String(data.name || data.id || 'server')] = data; }
    else table = data;
    var names = Object.keys(table);
    if (!names.length) throw new Error('里面没有服务器');
    return names.map(function (name) {
      var def = table[name];
      if (!modules.isObject(def)) throw new Error('「' + name + '」的描述不是对象');
      var kind = String(def.type || def.transport || '').toLowerCase();
      if (kind === 'sse') throw new Error('「' + name + '」是旧式的 HTTP+SSE 服务器，这里只支持 Streamable HTTP 与 stdio');
      var server = normalizeServer(Object.assign({}, def, { id: def.id || name, name: def.name || name }));
      if (!server) throw new Error('「' + name + '」需要 url（http / https，Streamable HTTP）或 command（stdio）');
      return { server: server, secret: { headers: stringMap(def.headers), env: stringMap(def.env) } };
    });
  }

  function mcpError(payload) {
    var error = new Error('MCP 错误' + (payload && payload.code !== undefined ? ' ' + payload.code : '') + '：' + String(payload && payload.message || '未知错误').slice(0, 400));
    error.mcp = true;
    return error;
  }

  /* 一条 JSON-RPC 回应里挑出某个 id 的结果（回应可能是单个对象，也可能是批量数组）。 */
  function pickResponse(payload, wantId) {
    var list = Array.isArray(payload) ? payload : [payload];
    for (var index = 0; index < list.length; index += 1) {
      var item = list[index];
      if (item && item.id === wantId && (item.result !== undefined || item.error !== undefined)) return item;
    }
    return null;
  }

  /* SSE 文本逐块喂进来，找到目标 id 的回应就返回它。 */
  function sseScanner(wantId) {
    var buffer = '';
    return function (chunk, final) {
      buffer += chunk;
      var parts = buffer.split(/\r?\n\r?\n/);
      buffer = final ? '' : parts.pop();
      for (var index = 0; index < parts.length; index += 1) {
        var data = parts[index].split(/\r?\n/).filter(function (line) { return line.indexOf('data:') === 0; }).map(function (line) { return line.slice(5).replace(/^ /, ''); }).join('\n');
        if (!data) continue;
        var parsed;
        try { parsed = JSON.parse(data); } catch (error) { continue; }
        var hit = pickResponse(parsed, wantId);
        if (hit) return hit;
      }
      return null;
    };
  }

  /* 工具结果转成给模型看的文字。图片、音频在文字协议里看不到，只留一句说明。 */
  function formatToolResult(result) {
    var source = modules.isObject(result) ? result : {};
    var parts = [];
    (Array.isArray(source.content) ? source.content : []).forEach(function (block) {
      if (!block) return;
      if (block.type === 'text') parts.push(String(block.text == null ? '' : block.text));
      else if (block.type === 'image' || block.type === 'audio') parts.push('［' + (block.type === 'image' ? '图片' : '音频') + '：' + String(block.mimeType || '') + '，约 ' + Math.round(String(block.data || '').length * 0.75) + ' 字节；这里看不到它的内容］');
      else if (block.type === 'resource' && block.resource) parts.push('［资源 ' + String(block.resource.uri || '') + '］' + (typeof block.resource.text === 'string' ? '\n' + block.resource.text : '（二进制）'));
      else if (block.type === 'resource_link') parts.push('［资源链接 ' + String(block.uri || '') + (block.name ? ' ' + block.name : '') + '］');
    });
    if (!parts.length && source.structuredContent !== undefined) {
      try { parts.push(JSON.stringify(source.structuredContent, null, 1)); } catch (error) { /* ignore */ }
    }
    var text = parts.join('\n');
    if (source.isError === true) throw new Error(text || 'MCP 工具返回了错误');
    return text || '（工具没有返回内容）';
  }

  /* JSON Schema 的顶层属性 → 工具参数表。没有属性时返回 null。 */
  function schemaParams(schema) {
    var props = modules.isObject(schema) && modules.isObject(schema.properties) ? schema.properties : null;
    if (!props) return null;
    var required = Array.isArray(schema.required) ? schema.required : [];
    var params = Object.keys(props).filter(function (key) { return key && !/["<>\r\n]/.test(key); }).slice(0, 40).map(function (key) {
      var prop = modules.isObject(props[key]) ? props[key] : {};
      var type = Array.isArray(prop.type) ? prop.type.filter(function (item) { return item !== 'null'; })[0] : prop.type;
      var mapped = type === 'string' ? 'string' : type === 'number' || type === 'integer' ? 'number' : type === 'boolean' ? 'boolean' : 'json';
      var desc = String(prop.description || prop.title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      var add = function (piece) { desc += (desc ? '；' : '') + piece; };
      if (Array.isArray(prop.enum) && prop.enum.length) add('可选：' + prop.enum.slice(0, 12).map(String).join(' | '));
      if (prop.default !== undefined) { try { add('默认 ' + JSON.stringify(prop.default)); } catch (error) { /* ignore */ } }
      if (mapped === 'json' && type) add(type === 'array' ? '数组' + (prop.items && prop.items.type ? '（元素为 ' + prop.items.type + '）' : '') : type === 'object' ? '对象' : String(type));
      return { name: key, type: mapped, required: required.indexOf(key) >= 0, desc: desc };
    });
    return params.length ? params : null;
  }

  function compactTool(tool) {
    var schema = modules.isObject(tool.inputSchema) ? tool.inputSchema : {};
    var kept = schema;
    try { if (JSON.stringify(schema).length > 24000) kept = { type: 'object', properties: schema.properties, required: schema.required }; } catch (error) { kept = {}; }
    var hints = modules.isObject(tool.annotations) ? tool.annotations : {};
    return {
      name: String(tool.name), title: String(tool.title || hints.title || '').slice(0, 120),
      description: String(tool.description || '').slice(0, 2000), inputSchema: kept,
      readOnly: hints.readOnlyHint === true, destructive: hints.destructiveHint === true,
      permission: tool.permission || ''
    };
  }

  function createMcp(env, kit, deps) {
    var registry = deps.registry, net = deps.net, secrets = deps.secrets, store = deps.store;
    var host = env.host;
    var catalogs = {};
    var clients = {};
    var registered = [];
    var tauri = { at: 0, servers: [] };
    var tauriDirectory = null, tauriCache, tauriScan;
    var tauriQueue = Promise.resolve();

    function settings() { return normalizeMcpSettings(typeof deps.settings === 'function' ? deps.settings() : null); }
    function servers() { return settings().servers; }
    function find(id) { return servers().filter(function (server) { return server.id === id; })[0] || null; }
    function companion() { return typeof deps.companion === 'function' ? deps.companion() : null; }
    function companionReady() { var client = companion(); return !!client && client.usable(); }
    function secret(id) { var value = secrets.get('mcp.' + id); return modules.isObject(value) ? value : {}; }
    function signature(server) { return server.transport + '|' + (server.transport === 'http' ? server.url : server.command + ' ' + (server.args || []).join(' ')); }
    function target(server) { return server.transport === 'http' ? server.url : server.command + (server.args && server.args.length ? ' ' + server.args.join(' ') : ''); }

    /* ---------- 一个服务器的连接 ---------- */
    function createClient(server) {
      var sessionId = '', protocol = '', ready = null, seq = 0, info = {}, started = false;
      var route = server.via === 'companion' ? 'companion' : 'direct';

      function header(response, name) { try { return response.headers.get(name); } catch (error) { return null; } }

      async function readResponse(status, type, wantId, source) {
        if (status === 202 || status === 204) return null;
        if (status === 401 || status === 403) throw new Error('MCP 服务器「' + server.name + '」拒绝访问（HTTP ' + status + '）：检查它的请求头里的密钥');
        if (status === 404 && sessionId) { var gone = new Error('会话已过期'); gone.sessionExpired = true; throw gone; }
        if (status === 404 || status === 405) throw new Error('这个地址不接受 MCP 请求（HTTP ' + status + '）。这里只支持 Streamable HTTP，地址通常以 /mcp 结尾；旧式的 /sse 服务器不支持');
        if (status >= 400) {
          var detail = '';
          try { detail = String(await source.text()).replace(/\s+/g, ' ').slice(0, 300); } catch (error) { detail = ''; }
          if (status === 400 && !sessionId && ready && /session/i.test(detail)) throw new Error('服务器要求带会话标识，但浏览器读不到它的响应头（对方没有通过 CORS 暴露 Mcp-Session-Id）。把这个服务器的连接方式改成「经伴侣」。');
          throw new Error('MCP 服务器返回 HTTP ' + status + (detail ? '：' + detail : ''));
        }
        if (wantId === undefined) return null;
        var found = null;
        if (/text\/event-stream/i.test(type)) {
          var scan = sseScanner(wantId);
          var stream = source.stream;
          if (stream && typeof stream.getReader === 'function') {
            var Decoder = host.TextDecoder || (typeof TextDecoder === 'function' ? TextDecoder : null);
            var decoder = new Decoder('utf-8');
            var reader = stream.getReader();
            for (;;) {
              var step = await reader.read();
              if (step.done) { found = scan('\n\n', true); break; }
              found = scan(decoder.decode(step.value, { stream: true }), false);
              if (found) { try { reader.cancel(); } catch (error) { /* ignore */ } break; }
            }
          } else found = scan(String(await source.text()) + '\n\n', true);
        } else {
          var payload;
          try { payload = JSON.parse(String(await source.text())); } catch (error) { throw new Error('MCP 服务器的回应不是 JSON'); }
          found = pickResponse(payload, wantId);
        }
        if (!found) throw new Error('MCP 服务器的回应里没有这次请求的结果');
        return found;
      }

      async function directPost(headers, body, wantId, timeoutMs, signal) {
        var watch = net.guard(signal, timeoutMs);
        try {
          var response;
          try {
            response = await host.fetch(server.url, { method: 'POST', headers: headers, body: body, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: watch.signal });
          } catch (error) {
            if (signal && signal.aborted) throw net.abortError();
            if (watch.timedOut()) throw new Error('MCP 服务器「' + server.name + '」超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有回应');
            var failure = new Error('浏览器连不上 MCP 服务器「' + server.name + '」：对方没有允许网页跨域访问，或地址不通。装了后端伴侣并放行后可以改由伴侣连接。');
            failure.network = true;
            throw failure;
          }
          var sid = header(response, 'mcp-session-id');
          if (sid) sessionId = sid;
          try {
            return await readResponse(response.status, String(header(response, 'content-type') || ''), wantId, { stream: response.body, text: function () { return response.text(); } });
          } catch (error) {
            if (signal && signal.aborted) throw net.abortError();
            if (watch.timedOut()) throw new Error('MCP 服务器「' + server.name + '」超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有回应');
            throw error;
          }
        } finally { watch.done(); }
      }

      async function relayPost(headers, body, wantId, timeoutMs, signal) {
        if (!companionReady()) throw new Error('MCP 服务器「' + server.name + '」要经后端伴侣连接，但现在用不了伴侣：要先在设置页「后端伴侣」里放行，并把权限档位调到「设备全权」。');
        var out = await net.request(server.url, { method: 'POST', headers: headers, body: body, routes: ['companion'], timeoutMs: timeoutMs, signal: signal, sseUntilId: wantId === undefined ? null : wantId });
        if (out.headers['mcp-session-id']) sessionId = out.headers['mcp-session-id'];
        return readResponse(out.status, out.type, wantId, { text: async function () { return out.text; } });
      }

      async function httpPost(message, options) {
        var opts = options || {};
        var headers = Object.assign({}, stringMap(secret(server.id).headers), { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        if (protocol) headers['MCP-Protocol-Version'] = protocol;
        var body = JSON.stringify(message);
        var timeoutMs = opts.timeoutMs || 60000;
        if (route === 'direct') {
          try { return await directPost(headers, body, message.id, timeoutMs, opts.signal); }
          catch (error) {
            /* 这些请求都带 application/json，会先发预检；直连失败说明请求没有真正送达，换路重发是安全的。 */
            if (!error || error.network !== true || server.via === 'direct' || !companionReady()) throw error;
            route = 'companion';
          }
        }
        return relayPost(headers, body, message.id, timeoutMs, opts.signal);
      }

      async function stdioPost(message, options) {
        var opts = options || {};
        var client = companion();
        if (!client || !client.usable()) throw new Error('「' + server.name + '」是在设备上启动的 MCP 服务器（stdio），要靠后端伴侣：先在设置页「后端伴侣」里放行，并把权限档位调到「设备全权」。TauriTavern 与手机上通常用不了这一类。');
        var timeoutMs = opts.timeoutMs || 60000;
        try {
          if (!started) {
            await client.call('mcp_start', { id: server.id, command: server.command, args: server.args || [], cwd: server.cwd || '', env: stringMap(secret(server.id).env) }, { signal: opts.signal, timeoutMs: 30000 });
            started = true;
          }
          var out = await client.call('mcp_send', { id: server.id, message: message, timeoutMs: timeoutMs }, { signal: opts.signal, timeoutMs: timeoutMs + 5000 });
          return out && out.response || null;
        } catch (error) {
          if (error && error.code === 'mcp_not_running') { started = false; var gone = new Error('MCP 服务器进程已经退出'); gone.sessionExpired = true; throw gone; }
          throw error;
        }
      }

      function post(message, options) { return server.transport === 'stdio' ? stdioPost(message, options) : httpPost(message, options); }

      async function rpc(method, params, options) {
        var message = { jsonrpc: '2.0', id: ++seq, method: method };
        if (params !== undefined) message.params = params;
        var response = await post(message, options);
        if (!response) throw new Error('MCP 服务器没有返回结果');
        if (response.error) throw mcpError(response.error);
        return response.result;
      }

      function reset() { ready = null; sessionId = ''; protocol = ''; started = false; }

      function start(options) {
        if (!ready) {
          ready = (async function () {
            var result = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'reader-ii', title: 'Reader-II 夜梦助手', version: String(deps.version || '0') } }, options);
            protocol = KNOWN_PROTOCOLS.indexOf(result && result.protocolVersion) >= 0 ? result.protocolVersion : PROTOCOL;
            info = result && modules.isObject(result.serverInfo) ? result.serverInfo : {};
            await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, options);
            return result;
          })();
          ready.catch(function () { reset(); });
        }
        return ready;
      }

      async function call(method, params, options) {
        await start(options);
        try { return await rpc(method, params, options); }
        catch (error) {
          if (!error || error.sessionExpired !== true) throw error;
          reset();
          await start(options);
          return rpc(method, params, options);
        }
      }

      return {
        info: function () { return info; },
        route: function () { return server.transport === 'stdio' ? 'companion' : route; },
        listTools: async function (options) {
          var tools = [], cursor, rounds = 0;
          do {
            var result = await call('tools/list', cursor ? { cursor: cursor } : {}, options);
            ((result && result.tools) || []).forEach(function (tool) { if (tool && typeof tool.name === 'string' && tool.name) tools.push(tool); });
            cursor = result && result.nextCursor;
            rounds += 1;
          } while (cursor && rounds < 20 && tools.length < 500);
          return tools;
        },
        callTool: function (name, args, options) { return call('tools/call', { name: name, arguments: args || {} }, options); },
        stop: async function () {
          if (server.transport === 'stdio' && started && companion() && companion().ready()) { try { await companion().call('mcp_stop', { id: server.id }); } catch (error) { /* ignore */ } }
          reset();
        }
      };
    }

    function clientFor(server) {
      var key = server.id + '|' + signature(server) + '|' + server.via;
      if (!clients[server.id] || clients[server.id].key !== key) clients[server.id] = { key: key, client: createClient(server) };
      return clients[server.id].client;
    }

    /* ---------- TauriTavern 的 MCP ---------- */
    function tauriApi() {
      var tt = host.__TAURITAVERN__;
      return tt && tt.api && tt.api.mcp ? tt.api.mcp : null;
    }

    async function readyTauri() {
      var tt = host.__TAURITAVERN__;
      if (!tt) throw new Error('这不是 TauriTavern');
      await (tt.ready || host.__TAURITAVERN_MAIN_READY__);
      var api = tauriApi();
      if (!api) throw new Error('这个版本的 TauriTavern 没有提供 MCP 接口');
      return api;
    }

    function loadTauriCache() {
      if (!tauriCache) tauriCache = store.get('kv', 'mcp:tt').then(function (saved) {
        if (saved && Array.isArray(saved.servers)) tauri = saved;
      }).catch(function () { /* 本机没有目录缓存 */ });
      return tauriCache;
    }

    // 列表、接入、停用共用顺序，较慢的发现或缓存写入不能覆盖后来点的停用。
    function queueTauri(action) {
      var next = tauriQueue.then(loadTauriCache).then(action);
      tauriQueue = next.catch(function () {});
      return next;
    }

    async function readTauriDirectory() {
      var api = await readyTauri();
      var result = await api.servers.list();
      if (!result || !Array.isArray(result.servers)) throw new Error('读取 TauriTavern 的 MCP 列表失败');
      tauriDirectory = new Map();
      result.servers.forEach(function (item) {
        if (item && item.id && item.state === 'active') tauriDirectory.set(item.id, {
          id: item.id, name: String(item.displayName || item.id).slice(0, 60), permissions: item.toolPermissions || {}
        });
      });
      sync();
      return tauriDirectory;
    }

    function scanTauri() {
      if (!tauriScan) tauriScan = queueTauri(readTauriDirectory).then(list).finally(function () { tauriScan = null; });
      return tauriScan;
    }

    async function saveTauri() {
      tauri.at = Date.now();
      sync();
      try { await store.put('kv', 'mcp:tt', tauri); } catch (error) { /* 存不下就只留在内存里 */ }
    }

    async function discoverTauri(id) {
      var item = tauriDirectory.get(id);
      if (!item) throw new Error('这项服务已经停用或删除，请在酒馆「扩展 → MCP」中查看');
      var found = await tauriApi().servers.discover(id);
      var tools = found.tools.filter(function (tool) {
        return tool && (tool.permission === 'allow' || tool.permission === 'ask') && typeof tool.nativeName === 'string';
      }).map(function (tool) {
        return compactTool(Object.assign({}, tool, { name: tool.nativeName }));
      });
      var row = { id: id, name: item.name, tools: tools, at: Date.now() };
      tauri.servers = tauri.servers.filter(function (server) { return server.id !== id; }).concat(row);
      return row;
    }

    function connectTauri(id) {
      return queueTauri(async function () {
        await readTauriDirectory();
        var row = await discoverTauri(id);
        await saveTauri();
        return row;
      });
    }

    function disconnectTauri(id) {
      return queueTauri(async function () {
        tauri.servers = tauri.servers.filter(function (server) { return server.id !== id; });
        await saveTauri();
      });
    }

    // 显式批量同步的 API；设置页只逐项接入。
    function syncTauri() {
      return queueTauri(async function () {
        var directory = await readTauriDirectory();
        for (var id of directory.keys()) await discoverTauri(id);
        tauri.servers = tauri.servers.filter(function (server) { return directory.has(server.id); });
        await saveTauri();
        return tauri;
      });
    }

    function tauriTools(server) {
      var list = server && Array.isArray(server.tools) ? server.tools : [];
      if (!tauriDirectory) return list;
      var item = tauriDirectory.get(server.id);
      if (!item) return [];
      var perms = modules.isObject(item.permissions) ? item.permissions : {};
      return list.filter(function (tool) {
        return tool && ['ask', 'allow'].includes(perms[tool.name]);
      }).map(function (tool) {
        return Object.assign({}, tool, { permission: perms[tool.name] });
      });
    }

    async function tauriCall(registrationId, nativeName, args, signal) {
      // testCall 是宿主提供给用户主动操作的入口：确认卡放行后再核对宿主的即时权限。
      await queueTauri(readTauriDirectory);
      var selected = tauri.servers.find(function (server) { return server.id === registrationId; });
      if (!selected || !tauriTools(selected).some(function (tool) { return tool.name === nativeName; }))
        throw new Error('这个工具在酒馆或 Reader-II 中已停用，请检查当前接入状态');
      var api = tauriApi();
      var outcome = await api.tools.testCall({ registrationId: registrationId, nativeName: nativeName, argumentsJson: JSON.stringify(args || {}) }, { signal: signal });
      if (outcome && outcome.outcome === 'known_response') {
        var response = outcome.response || {};
        if (response.kind === 'tool_result') {
          var text = (response.textBlocks || []).map(function (block) { return String(block.text); }).join('\n') || String(response.structuredJson || '');
          var notes = (response.diagnostics || []).map(function (item) { return item.message; }).filter(Boolean).join('；');
          if (response.isError) throw new Error(text || 'MCP 工具返回了错误');
          return (text || '（工具没有返回文字）') + (notes ? '\n（' + notes + '）' : '');
        }
        if (response.kind === 'server_error') throw mcpError({ code: response.code, message: response.message });
        throw new Error('MCP 服务器给了这里处理不了的回应（' + String(response.responseType || '') + '）：' + String(response.message || ''));
      }
      if (outcome && outcome.outcome === 'not_sent') throw new Error('请求没有发出：' + String(outcome.message || outcome.code || ''));
      throw new Error('不确定这次调用有没有被执行（' + String(outcome && outcome.message || '') + '）。不要自动重试：先向用户说明情况，由用户决定。');
    }

    /* ---------- 登记成工具箱 ---------- */
    function toolName(prefix, name, taken) {
      var base = (prefix + '_' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')).slice(0, 44) || prefix;
      var candidate = base, count = 1;
      while (taken[candidate]) { count += 1; candidate = base.slice(0, 44) + '_' + count; }
      taken[candidate] = true;
      return candidate;
    }

    function summarize(tools) {
      var names = tools.slice(0, 6).map(function (tool) { return tool.title || tool.name; }).join('、');
      return tools.length + ' 个工具' + (names ? '（' + names + (tools.length > 6 ? '…' : '') + '）' : '');
    }

    function registerTools(set, prefix, label, tools, effectOf, invoke, confirmEach) {
      var taken = {};
      tools.forEach(function (tool) {
        var params = schemaParams(tool.inputSchema);
        var whole = !params;
        registry.registerTool({
          name: toolName(prefix, tool.name, taken), toolset: set, source: 'mcp', volatile: true,
          summary: (tool.description || tool.title || tool.name).replace(/\s+/g, ' ').trim().slice(0, 700),
          params: whole ? [{ name: 'arguments', type: 'json', desc: '参数对象（JSON）；这个工具没有声明参数，通常不用填' }] : params,
          effect: function () { return effectOf(tool); },
          scope: 'external',
          confirmEach: confirmEach === true,
          irreversible: function () { return effectOf(tool) !== 'read'; },
          describe: function () { return '调用 MCP 工具：' + label + ' · ' + (tool.title || tool.name); },
          run: async function (args, ctx) {
            var payload = {};
            if (whole) payload = modules.isObject(args.arguments) ? args.arguments : {};
            else params.forEach(function (param) { if (args[param.name] !== undefined) payload[param.name] = args[param.name]; });
            return invoke(tool, payload, ctx && ctx.signal);
          }
        });
      });
    }

    function sync() {
      registered.forEach(function (name) { registry.unregisterToolset(name); });
      registered = [];
      servers().forEach(function (server) {
        if (!server.enabled) return;
        var set = 'mcp/' + server.id;
        var prefix = 'mcp_' + server.id;
        var catalog = catalogs[server.id];
        var usable = catalog && catalog.sig === signature(server) && Array.isArray(catalog.tools) && catalog.tools.length;
        registry.registerToolset({
          name: set, source: 'mcp',
          summary: 'MCP 服务器「' + server.name + '」' + (usable ? '：' + summarize(catalog.tools) : '（还没取到工具目录：打开后先调用 ' + prefix + '_connect）')
        });
        registered.push(set);
        if (!usable) {
          registry.registerTool({
            name: prefix + '_connect', toolset: set, source: 'mcp', effect: 'net', scope: 'external', volatile: true, params: [],
            summary: '连接 MCP 服务器「' + server.name + '」并取回它的工具目录。连接成功后这个工具箱里就是它的真工具。',
            describe: function () { return '连接 MCP 服务器：' + server.name + '（' + target(server).slice(0, 120) + '）'; },
            run: async function (args, ctx) {
              var found = await discover(server.id, { signal: ctx && ctx.signal });
              return '已连接「' + server.name + '」，' + found.tools.length + ' 个工具：\n' + modules.agentToolManual(registry.tools(set));
            }
          });
          return;
        }
        registerTools(set, prefix, server.name, catalog.tools, function (tool) {
          var live = find(server.id) || server;
          if (live.trust === 'all') return 'read';
          if (live.trust === 'hint' && tool.readOnly === true) return 'read';
          return 'net';
        }, async function (tool, payload, signal) {
          return formatToolResult(await clientFor(find(server.id) || server).callTool(tool.name, payload, { signal: signal, timeoutMs: 120000 }));
        });
      });
      tauri.servers.forEach(function (server) {
        var tools = tauriTools(server);
        if (!tools.length) return;
        var short = 'tt_' + modules.hashText(server.id);
        var set = 'mcp/' + short;
        registry.registerToolset({ name: set, source: 'mcp', summary: 'TauriTavern 里登记的 MCP 服务器「' + server.name + '」：' + summarize(tools) });
        registered.push(set);
        registerTools(set, 'mcp_' + short, server.name, tools, function (tool) { return tool.permission === 'allow' ? 'read' : 'net'; },
          function (tool, payload, signal) { return tauriCall(server.id, tool.name, payload, signal); }, true);
      });
    }

    /* 连接并取回工具目录；成功后写进缓存。失败时保留上一次的目录（如果地址没变），并记下错误。 */
    async function discover(id, options) {
      var server = find(id);
      if (!server) throw new Error('没有这个 MCP 服务器：' + id);
      delete clients[id];
      var client = clientFor(server);
      try {
        var tools = (await client.listTools(options)).map(compactTool);
        catalogs[id] = { sig: signature(server), at: Date.now(), tools: tools, info: client.info(), route: client.route(), error: '' };
        try { await store.put('kv', 'mcp:' + id, catalogs[id]); } catch (error) { /* 缓存写不进去不影响使用 */ }
      } catch (error) {
        if (net.isAbort(error)) throw error;
        var previous = catalogs[id] && catalogs[id].sig === signature(server) ? catalogs[id] : { sig: signature(server), at: 0, tools: [] };
        catalogs[id] = Object.assign({}, previous, { error: String(error && error.message || error).slice(0, 300) });
        sync();
        throw error;
      }
      sync();
      return catalogs[id];
    }

    /* 启动时：只读缓存，不联网。 */
    async function load() {
      var list = servers();
      for (var index = 0; index < list.length; index += 1) {
        try {
          var cached = await store.get('kv', 'mcp:' + list[index].id);
          if (cached && cached.sig === signature(list[index]) && Array.isArray(cached.tools)) catalogs[list[index].id] = cached;
        } catch (error) { /* 没有缓存 */ }
      }
      if (host.__TAURITAVERN__) {
        await loadTauriCache();
      }
      sync();
    }

    function saveServers(next) { deps.save({ servers: next }); }

    /* 添加或按 id 替换一个服务器，然后立刻连接一次。连接失败不回滚登记（用户可以改密钥后点刷新）。 */
    async function add(entry, options) {
      var server = normalizeServer(entry && entry.server);
      if (!server) throw new Error('服务器描述无效');
      if (/^tt_/.test(server.id)) server.id = ('s_' + server.id).slice(0, 24);
      var list = servers().filter(function (item) { return item.id !== server.id; });
      if (list.length >= 20) throw new Error('最多登记 20 个 MCP 服务器');
      var keep = modules.isObject(entry.secret) ? { headers: stringMap(entry.secret.headers), env: stringMap(entry.secret.env) } : {};
      secrets.set('mcp.' + server.id, Object.keys(keep.headers || {}).length || Object.keys(keep.env || {}).length ? keep : undefined);
      delete catalogs[server.id];
      saveServers(list.concat([server]));
      return discover(server.id, options);
    }

    async function remove(id) {
      var client = clients[id] && clients[id].client;
      if (client) { try { await client.stop(); } catch (error) { /* ignore */ } }
      delete clients[id];
      delete catalogs[id];
      secrets.set('mcp.' + id, undefined);
      try { await store.del('kv', 'mcp:' + id); } catch (error) { /* ignore */ }
      saveServers(servers().filter(function (item) { return item.id !== id; }));
      sync();
    }

    function update(id, patch) {
      var changed = false;
      var next = servers().map(function (item) {
        if (item.id !== id) return item;
        changed = true;
        return normalizeServer(Object.assign({}, item, modules.isObject(patch) ? patch : {}, { id: item.id })) || item;
      });
      if (!changed) throw new Error('没有这个 MCP 服务器：' + id);
      saveServers(next);
      sync();
    }

    function list() {
      var rows = servers().map(function (server) {
        var catalog = catalogs[server.id];
        var fresh = catalog && catalog.sig === signature(server);
        return {
          id: server.id, name: server.name, source: 'own', transport: server.transport, target: target(server), enabled: server.enabled, trust: server.trust, via: server.via,
          toolset: 'mcp/' + server.id, tools: fresh && catalog.tools ? catalog.tools.length : 0, toolNames: fresh && catalog.tools ? catalog.tools.map(function (tool) { return tool.name; }) : [],
          at: fresh ? catalog.at || 0 : 0, error: fresh ? catalog.error || '' : '', route: fresh ? catalog.route || '' : '',
          hasSecret: Object.keys(secret(server.id)).length > 0
        };
      });
      (Array.isArray(tauri.servers) ? tauri.servers : []).forEach(function (server) {
        if (!server || !server.id) return;
        var tools = tauriTools(server);
        var active = !tauriDirectory || tauriDirectory.has(server.id);
        rows.push({ id: server.id, name: tauriDirectory && active ? tauriDirectory.get(server.id).name : (server.name || server.id),
          source: 'tt', enabled: true, available: active, tools: tools.length, toolNames: tools.map(function (tool) { return tool.name; }), at: server.at || tauri.at });
      });
      if (tauriDirectory) tauriDirectory.forEach(function (item) {
        if (!tauri.servers.some(function (server) { return server.id === item.id; }))
          rows.push({ id: item.id, name: item.name, source: 'tt', enabled: false, available: true, tools: 0, toolNames: [] });
      });
      return rows;
    }

    function brief() {
      var rows = list().filter(function (row) { return row.enabled && row.tools; });
      if (!rows.length) return '';
      return 'MCP 服务器：' + rows.map(function (row) { return row.name + '（' + row.tools + ' 个工具）'; }).join('、');
    }

    return {
      list: list, add: add, remove: remove, update: update, refresh: discover, load: load, sync: sync, brief: brief,
      parse: parseServers, scanTauri: scanTauri, connectTauri: connectTauri, disconnectTauri: disconnectTauri,
      syncTauri: syncTauri, hasTauri: function () { return !!host.__TAURITAVERN__; }
    };
  }

  modules.normalizeMcpSettings = normalizeMcpSettings;
  modules.parseMcpServers = parseServers;
  modules.formatMcpToolResult = formatToolResult;
  modules.mcpSchemaParams = schemaParams;
  modules.createMcp = createMcp;
})(typeof globalThis !== 'undefined' ? globalThis : window);
