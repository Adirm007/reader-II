(function (root) {
  'use strict';

  /*
   * Reader-II 统一 LLM 网关。
   * - 方案与路由：与大厅「独立 API」共用同一个本机键（reader-II 自己的，见 reader-env.js 的 LOCAL_KEYS；
   *   旧键 dream_independent_api_v2 的值由 createEnv 迁移过来）里的 presets / defaultId / routes。
   *   Reader Core 面板的 LLM LINK 编辑的是其中的默认方案；
   *   旧版 reader_ii_llm_settings_v1 只在 v2 尚不存在时作为迁移来源读取。
   * - 助手与语义适配的聊天补全使用自己的消息与工具声明，经当前酒馆连接或选定的独立 API 发出。
   *   普通生成与旧宿主保留 generateRaw 等既有接口。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var LEGACY_KEY = 'reader_ii_llm_settings_v1';
  var PRESET_KEY = modules.localKey('dream_independent_api_v2');
  var PANEL_PRESET_ID = 'readerii';
  var TRANSIENT = /\b(?:408|409|425|429|500|502|503|504|520|522|524|529|530)\b|timeout|timed out|超时|overloaded|temporarily|ECONNRESET|network|fetch failed|Failed to fetch|tunnel|未返回可用文本|empty/i;

  function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(function (part) {
      if (typeof part === 'string') return part;
      if (part && (part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }

  function responseText(result) {
    if (typeof result === 'string') return result;
    if (!result || typeof result !== 'object') return '';
    if (typeof result.content === 'string') return result.content;
    var blockText = contentText(result.content);
    if (blockText) return blockText;
    if (typeof result.text === 'string') return result.text;
    if (typeof result.response === 'string') return result.response;
    if (Array.isArray(result.choices) && result.choices[0]) {
      var choice = result.choices[0];
      return contentText(choice.text) || contentText(choice.message && choice.message.content);
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

    function isolatedRoute(request) {
      return (request.route === 'agent' || request.route === 'adapt') && modules.hasAgentCompletionTransport && modules.hasAgentCompletionTransport(env);
    }

    // 有些模型把思考放在正文开头；只读取标签之后的正文，保留正文里的引用与代码。
    function visibleText(value) {
      var text = String(value || '');
      var first;
      while ((first = text.match(/^\s*<(think|think_nya)>/i))) {
        var closer = new RegExp('<\\/' + first[1] + '\\s*>', 'i');
        var rest = text.slice(first[0].length);
        var end = closer.exec(rest);
        if (!end) return '';
        text = rest.slice(end.index + end[0].length).replace(/^\s*<!--\s*<\/think>\s*-->/i, '').trimStart();
      }
      return text;
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
      return responseText(data);
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
            if (isolatedRoute(request)) {
              var ctx = nativeContext();
              if (ctx && (api || ctx.mainApi === 'openai')) {
                var options = Object.assign({}, request, { timeoutMs: timeoutMs, tools: undefined, toolChoice: undefined });
                var pending = api ? backendRequest(api, messages, options) : mainRequest(messages, options);
                return pending.then(function (raw) {
                  var parsed = parseToolResponse(raw);
                  if (parsed.toolCalls.length) throw new Error('模型为文本请求返回了未声明的工具调用，本次没有执行');
                  return parsed.text;
                });
              }
            }
            if (!generateRaw) {
              /* 没有酒馆助手：独立 API 经酒馆后端代发（同源，不受跨域限制）；没有酒馆后端时才由浏览器直连。否则走酒馆原生的 generateRaw。 */
              if (api) {
                var plain = { maxTokens: request.maxTokens, temperature: request.temperature, signal: request.signal };
                var backendCtx = nativeContext();
                if (backendCtx && typeof backendCtx.getRequestHeaders === 'function' && hostFetch()) {
                  return backendRequest(api, messages, plain).then(function (data) { return parseToolResponse(data).text; });
                }
                return directChat(api, messages, request);
              }
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
          if (request.route === 'agent' || request.route === 'adapt') text = visibleText(text);
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

    /* ---------- 原生函数调用（夜梦助手用） ---------- */
    /*
     * 为什么要有这一条路：文本协议的工具块要靠模型把一段 XML 原样写进正文。可不少模型（Kimi、Qwen、DeepSeek 等）把
     * 「开始调用工具」训练成一个专用记号，服务端见到它就按原生工具调用处理；请求里没声明 tools 时，这段输出直接被丢掉，
     * 正文停在「我现在就去做」那一句（2026-11-16 的真机日志：finish_reason 是 stop，思考里写着「然后输出工具块」，正文里没有）。
     * 所以助手优先走原生函数调用：tools 随请求声明，tool_calls 从响应里取；不支持的通道与模型再退回文本协议。
     *
     * 三条通道，都不依赖酒馆助手：
     *   backend  独立 API 方案：经酒馆后端 /api/backends/chat-completions/generate 代发（同源，不受跨域限制；TauriTavern 同样实现了它）
     *   openai   酒馆主 API（聊天补全）：用酒馆自己的 sendOpenAIRequest，沿用当前连接与预设，只在请求发出前补上 tools
     *   direct   没有酒馆后端（测试、独立页面）：浏览器直连独立 API
     */
    function hostFetch() {
      try { if (env && env.host && typeof env.host.fetch === 'function') return env.host.fetch.bind(env.host); } catch (error) { /* ignore */ }
      return typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
    }

    function toolSupport(route) {
      var api = resolveApi(route);
      var ctx = nativeContext();
      if (api) {
        if (!hostFetch()) return { native: false, via: '', reason: '当前环境发不出网络请求' };
        return ctx && typeof ctx.getRequestHeaders === 'function' ? { native: true, via: 'backend', model: api.model } : { native: true, via: 'direct', model: api.model };
      }
      if (!ctx) return { native: false, via: '', reason: '没有酒馆环境' };
      var main = String(ctx.mainApi || '');
      if (main && main !== 'openai') return { native: false, via: '', reason: '酒馆主 API 是文本补全类型（' + main + '），没有原生函数调用' };
      if (!env || typeof env.hostImport !== 'function') return { native: false, via: '', reason: '当前载体不能调用酒馆的聊天补全接口' };
      return { native: true, via: 'openai', model: '' };
    }

    function unsupportedError(message) {
      var error = new Error(message);
      error.code = 'no_native_tools';
      return error;
    }

    /* 对方明确说不认 tools / function 的那类报错：换文本协议能解决，重试解决不了。 */
    function looksUnsupported(status, text) {
      if ([400, 404, 405, 415, 422, 501].indexOf(Number(status)) < 0) return false;
      return /tool|function[_ ]?call|functions?\b|not\s+support|unsupported|unknown (?:field|parameter|argument)|unrecognized|extra[_ ]?(?:fields|inputs)|additional properties|不支持|无法识别/i.test(String(text || ''));
    }

    function argumentText(value) {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value == null ? {} : value); } catch (error) { return '{}'; }
    }

    /*
     * 把各家的响应规整成 { text, toolCalls: [{ id, name, arguments(JSON 文本) }], reasoning, finish, message }。
     * message 是下一轮要原样带回去的 assistant 消息（OpenAI 形状；酒馆后端会替 Claude、Gemini 转换）。
     */
    function parseToolResponse(data) {
      var out = { text: '', toolCalls: [], reasoning: '', finish: '', message: null };
      if (!modules.isObject(data)) { out.text = typeof data === 'string' ? visibleText(data) : ''; return out; }
      var choice = Array.isArray(data.choices) ? data.choices[0] : null;
      var message = choice && modules.isObject(choice.message) ? choice.message
        : Array.isArray(data.tool_calls) || modules.isObject(data.function_call) ? data : null;
      out.finish = String(choice && choice.finish_reason || data.finish_reason || data.stop_reason || '');
      var wire = [];
      function push(id, name, args, extra) {
        if (!name) return;
        var call = { id: String(id || 'call_' + (++sequence).toString(36) + Date.now().toString(36)), name: String(name), arguments: argumentText(args) };
        out.toolCalls.push(call);
        wire.push(Object.assign({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }, extra || {}));
      }
      if (message) {
        out.text = contentText(message.content);
        out.reasoning = String(message.reasoning_content || message.reasoning || '');
        (Array.isArray(message.tool_calls) ? message.tool_calls : []).forEach(function (item) {
          if (!item) return;
          var fn = modules.isObject(item.function) ? item.function : item;
          var extra = {};
          /* Gemini 的思考签名等附带字段要原样带回，否则下一轮会被拒。 */
          ['signature', 'thought_signature', 'thoughtSignature', 'extra_content'].forEach(function (key) { if (item[key] !== undefined) extra[key] = item[key]; });
          push(item.id, fn.name, fn.arguments, extra);
        });
        /* 更早的 function_call 写法（一次只有一个）。 */
        if (!out.toolCalls.length && modules.isObject(message.function_call)) push('', message.function_call.name, message.function_call.arguments);
      }
      /* Claude：content 是块数组，tool_use 块就是调用。 */
      var blocks = Array.isArray(data.content) ? data.content : null;
      if (blocks && !out.toolCalls.length) {
        if (!out.text) out.text = contentText(blocks);
        blocks.forEach(function (block) { if (block && block.type === 'tool_use') push(block.id, block.name, block.input); });
      }
      /* Gemini：酒馆后端同时给出 choices 与 responseContent；functionCall 在 parts 里。 */
      var candidate = Array.isArray(data.candidates) && data.candidates[0] && data.candidates[0].content;
      var parts = modules.isObject(data.responseContent) && Array.isArray(data.responseContent.parts) ? data.responseContent.parts
        : candidate && Array.isArray(candidate.parts) ? candidate.parts : null;
      if (parts && !out.toolCalls.length) {
        if (!out.text) out.text = parts.filter(function (part) { return part && typeof part.text === 'string' && !part.thought; }).map(function (part) { return part.text; }).join('');
        parts.forEach(function (part) {
          if (!part || !modules.isObject(part.functionCall)) return;
          var signature = part.thoughtSignature || part.thought_signature || part.functionCall.thoughtSignature;
          push('', part.functionCall.name, part.functionCall.args, signature ? { signature: signature } : null);
        });
      }
      if (!out.text && !out.toolCalls.length) out.text = responseText(data);
      out.text = visibleText(out.text);
      out.message = { role: 'assistant', content: out.text };
      if (wire.length) out.message.tool_calls = wire;
      /* 思考型模型在同一轮的多步调用里要把思考原样带回（DeepSeek、Kimi 等）；对方没给这个字段时不带，免得严格的接口拒收。 */
      if (wire.length && message && typeof message.reasoning_content === 'string' && message.reasoning_content) out.message.reasoning_content = message.reasoning_content;
      return out;
    }

    function wireMessages(input) {
      var output = [];
      (Array.isArray(input) ? input : []).forEach(function (item) {
        if (!item || typeof item.role !== 'string') return;
        var role = ['system', 'assistant', 'tool'].indexOf(item.role) >= 0 ? item.role : 'user';
        var message = { role: role, content: typeof item.content === 'string' ? item.content : contentText(item.content) };
        if (role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length) {
          message.tool_calls = modules.clone(item.tool_calls);
          if (typeof item.reasoning_content === 'string' && item.reasoning_content) message.reasoning_content = item.reasoning_content;
        } else if (role === 'tool') {
          message.tool_call_id = String(item.tool_call_id || '');
        } else if (!message.content.trim()) return;
        output.push(message);
      });
      return output;
    }

    async function readFailure(response) {
      var text = '';
      try { text = String(await response.text()); } catch (error) { text = ''; }
      var detail = text;
      try {
        var parsed = JSON.parse(text);
        detail = String(parsed && (parsed.error && (parsed.error.message || parsed.error) || parsed.message) || text);
      } catch (error) { /* 不是 JSON 就原样给出 */ }
      return detail.replace(/\s+/g, ' ').slice(0, 400);
    }

    function requestBody(api, messages, request) {
      var body = { model: api.model, messages: messages, stream: false };
      if (Number(request.maxTokens) > 0) body.max_tokens = Math.trunc(Number(request.maxTokens));
      if (typeof request.temperature === 'number' && Number.isFinite(request.temperature)) body.temperature = request.temperature;
      if (Array.isArray(request.tools) && request.tools.length) {
        body.tools = request.tools;
        body.tool_choice = request.toolChoice || 'auto';
      }
      return body;
    }

    /* 独立 API 经酒馆后端代发：与酒馆助手的 custom_api 同一种写法（reverse_proxy + proxy_password）。 */
    async function backendRequest(api, messages, request) {
      var ctx = nativeContext();
      var fetcher = hostFetch();
      var source = String(api.source || 'openai');
      var body = Object.assign(requestBody(api, messages, request), {
        type: 'quiet', chat_completion_source: source, reverse_proxy: api.apiurl, proxy_password: api.key || '', include_reasoning: true
      });
      if (source === 'custom') {
        body.custom_url = api.apiurl;
        if (api.key) body.custom_include_headers = 'Authorization: ' + JSON.stringify('Bearer ' + api.key);
      }
      if (request.jsonSchema) body.json_schema = modules.clone(request.jsonSchema);
      return sendBackendBody(ctx, fetcher, body, request, '独立 API');
    }

    async function sendBackendBody(ctx, fetcher, body, request, label) {
      var data;
      if (isolatedRoute(request)) {
        try { data = await modules.sendAgentCompletion(env, body, request.signal, request.timeoutMs); }
        catch (error) {
          if (body.tools && looksUnsupported(error && error.status, error && error.message)) throw unsupportedError('当前连接不接受原生函数调用');
          throw error;
        }
      } else {
        data = await fetchBackendBody(ctx, fetcher, body, request.signal, label);
      }
      if (data && data.quota_error) throw new Error(label + ' 配额不足');
      if (data && data.error) {
        var message = String(modules.isObject(data.error) ? data.error.message || JSON.stringify(data.error) : data.message || data.response || '接口报错').slice(0, 400);
        if (body.tools && looksUnsupported(400, message)) throw unsupportedError('这个接口不接受原生函数调用（' + message + '）');
        throw new Error(label + ' 报错：' + message);
      }
      return data;
    }

    async function fetchBackendBody(ctx, fetcher, body, signal, label) {
      var headers = Object.assign({ 'Content-Type': 'application/json' }, ctx.getRequestHeaders() || {});
      var response = await fetcher('/api/backends/chat-completions/generate', { method: 'POST', headers: headers, body: JSON.stringify(body), signal: signal, cache: 'no-cache' });
      if (!response.ok) {
        var detail = await readFailure(response);
        if (body.tools && looksUnsupported(response.status, detail)) throw unsupportedError('这个接口不接受原生函数调用（HTTP ' + response.status + '：' + detail + '）');
        throw new Error(label + ' 返回 HTTP ' + response.status + '：' + detail);
      }
      /* 展示用预设可以改写 Response 实例的 json()，把调用消费为正文；助手需要同一次响应的协议数据。 */
      return body.tools ? JSON.parse(await response.text()) : response.json();
    }

    async function directRequest(api, messages, request) {
      var fetcher = hostFetch();
      if (!fetcher) throw new Error('当前环境不能直连独立 API');
      var headers = { 'Content-Type': 'application/json' };
      if (api.key) headers.Authorization = 'Bearer ' + api.key;
      var body = requestBody(api, messages, request);
      var response = await fetcher(String(api.apiurl).replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(body), signal: request.signal });
      if (!response.ok) {
        var detail = await readFailure(response);
        if (body.tools && looksUnsupported(response.status, detail)) throw unsupportedError('这个接口不接受原生函数调用（HTTP ' + response.status + '：' + detail + '）');
        throw new Error('独立 API 返回 HTTP ' + response.status + '：' + detail);
      }
      return body.tools ? JSON.parse(await response.text()) : response.json();
    }

    /* 优先用宿主构建连接参数并单独发送。旧版宿主沿用其生成接口，只在自己的请求中声明工具。 */
    var openaiModule = null;
    async function mainRequest(messages, request) {
      var ctx = nativeContext();
      if (!ctx) throw unsupportedError('拿不到酒馆的连接设置');
      if (!openaiModule) openaiModule = env.hostImport('/scripts/openai.js').catch(function (error) { openaiModule = null; throw error; });
      var api;
      try { api = await openaiModule; } catch (error) { throw unsupportedError('载入酒馆的聊天补全模块失败：' + String(error && error.message || error).slice(0, 160)); }
      if (!api) throw unsupportedError('这个版本的酒馆没有可用的聊天补全接口');
      var types = ctx.eventTypes || ctx.event_types || {};
      var eventName = types.CHAT_COMPLETION_SETTINGS_READY || 'chat_completion_settings_ready';
      function setAgentTools(data) {
        data.stream = false;
        data.include_reasoning = true;
        if (Array.isArray(request.tools) && request.tools.length) {
          data.tools = request.tools;
          data.tool_choice = request.toolChoice || 'auto';
        } else {
          delete data.tools;
          delete data.tool_choice;
        }
        delete data.functions;
        delete data.function_call;
      }
      var settings = ctx.chatCompletionSettings || api.oai_settings;
      var isolated = isolatedRoute(request);
      var canPrepare = typeof api.createGenerationParameters === 'function' && typeof api.getChatCompletionModel === 'function';
      if (canPrepare) {
        var fetcher = hostFetch();
        var model = api.getChatCompletionModel(settings);
        var prepared = await api.createGenerationParameters(settings, model, 'quiet', messages, { allowToolCalls: false, jsonSchema: request.jsonSchema || null });
        var body = prepared.generate_data;
        setAgentTools(body);
        if (request.jsonSchema) body.json_schema = modules.clone(request.jsonSchema);
        if (!isolated && ctx.eventSource && ctx.eventSource.emit) await ctx.eventSource.emit(eventName, body);
        body.stream = false;
        var completion = await sendBackendBody(ctx, fetcher, body, request, '酒馆主 API');
        var choice = completion && completion.choices && completion.choices[0];
        var stopReason = completion && completion.stop_reason || choice && choice.finish_reason;
        if (['refusal', 'content_filter', 'max_tokens', 'length', 'model_context_window_exceeded'].indexOf(stopReason) !== -1) {
          var stopped = new Error('模型已停止生成（' + stopReason + '），本批工具未执行。');
          stopped.code = 'provider_stop';
          throw stopped;
        }
        return completion;
      }
      if (!ctx.eventSource || typeof api.sendOpenAIRequest !== 'function') throw unsupportedError('这个版本的酒馆没有可用的聊天补全接口');
      var first = messages[0];
      var injected = false;
      var inject = function (data) {
        if (injected || !data || !Array.isArray(data.messages) || data.messages[0] !== first) return;
        injected = true;
        data.messages = messages;
        setAgentTools(data);
      };
      ctx.eventSource.on(eventName, inject);
      try {
        var data = await api.sendOpenAIRequest('quiet', messages, request.signal);
        if (!injected && Array.isArray(request.tools) && request.tools.length) throw unsupportedError('酒馆没有给出补充请求参数的机会，工具没能带上');
        return data;
      } catch (error) {
        if (error && (error.code === 'no_native_tools' || error.name === 'AbortError')) throw error;
        var message = String(error && error.message || error);
        if (looksUnsupported(400, message)) throw unsupportedError('当前连接不接受原生函数调用（' + message.slice(0, 300) + '）');
        throw error;
      } finally {
        try { ctx.eventSource.removeListener(eventName, inject); } catch (error) { /* ignore */ }
      }
    }

    /*
     * 带工具的一次请求。request:
     *   messages  OpenAI 形状，可含 assistant.tool_calls 与 role: 'tool'
     *   tools     [{ type: 'function', function: { name, description, parameters } }]；toolChoice: 'auto' | 'required' | 'none'
     *   route  maxTokens  temperature  timeoutMs  retries  signal
     * 返回 parseToolResponse 的结果，另带 via（走了哪条通道）。通道或接口不支持时抛 code === 'no_native_tools' 的错误。
     */
    async function chatTools(input) {
      var request = modules.isObject(input) ? input : {};
      var messages = wireMessages(request.messages);
      if (!messages.length) throw new Error('Reader LLM 调用缺少消息');
      var support = toolSupport(request.route);
      if (!support.native) throw unsupportedError(support.reason || '当前通道没有原生函数调用');
      var api = resolveApi(request.route);
      var retries = Math.max(0, Math.min(5, request.retries === undefined ? 2 : Math.trunc(Number(request.retries) || 0)));
      var timeoutMs = Math.max(0, Number(request.timeoutMs === undefined ? 180000 : request.timeoutMs) || 0);
      var lastError = null;
      for (var attempt = 0; attempt <= retries; attempt += 1) {
        if (request.signal && request.signal.aborted) throw abortError();
        try {
          var data = await raceOnce(function () {
            if (support.via === 'backend') return backendRequest(api, messages, Object.assign({ timeoutMs: timeoutMs }, request));
            if (support.via === 'direct') return directRequest(api, messages, request);
            return mainRequest(messages, Object.assign({ timeoutMs: timeoutMs }, request));
          }, '', timeoutMs, request.signal);
          var parsed = parseToolResponse(data);
          if (!parsed.text.trim() && !parsed.toolCalls.length && !/^(?:tool_calls|function_call|tool_use)$/.test(parsed.finish)) throw new Error('LLM 未返回可用文本');
          parsed.via = support.via;
          return parsed;
        } catch (error) {
          lastError = error;
          if (error && (error.name === 'AbortError' || error.code === 'no_native_tools')) throw error;
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
      if (isolatedRoute(request) && !request.usePreset && nativeContext()) {
        return chat(Object.assign({}, request, { api: api, messages: [
          { role: 'system', content: system }, { role: 'user', content: userInput }
        ] }));
      }
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
      chatTools: chatTools,
      toolSupport: toolSupport,
      parseToolResponse: parseToolResponse,
      visibleText: visibleText,
      stop: stop,
      responseText: responseText
    };
  }

  modules.normalizeReaderLlmSettings = normalizeSettings;
  modules.createLlmGateway = createLlmGateway;
})(typeof globalThis !== 'undefined' ? globalThis : window);
