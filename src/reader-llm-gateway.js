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
