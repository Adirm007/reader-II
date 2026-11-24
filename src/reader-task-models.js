(function (root) {
  'use strict';
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var TASK_KEY = 'reader_ii_task_connections_v1';
  var EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  function efforts(record, model, geminiSpec) {
    var meta = record && record.metadata || {};
    var capabilities = record && record.capabilities || {};
    if (record && (record.supports_reasoning === false || record.reasoning === false || capabilities.reasoning === false || capabilities.thinking === false)) return [];
    var offered = record && (record.supported_reasoning_efforts || record.reasoning_efforts || meta.supported_reasoning_efforts ||
      capabilities.reasoning_efforts || capabilities.reasoning && capabilities.reasoning.efforts);
    if (Array.isArray(offered)) return EFFORTS.filter(function (level) { return offered.indexOf(level) >= 0; });
    var gemini = typeof geminiSpec === 'function' ? geminiSpec(model) : null;
    if (gemini) return gemini.efforts.slice();
    var id = model.split('/').pop().toLowerCase();
    if (/^(?:gpt-5\.[45](?:-(?:mini|nano))?|gpt-5\.2)(?:-\d{4}-\d\d-\d\d)?$/.test(id)) return ['none','low','medium','high','xhigh'];
    if (/^(?:gpt-5\.[23]-codex|gpt-5\.1-codex-max)$/.test(id)) return ['low','medium','high','xhigh'];
    if (/^(?:gpt-5(?:-(?:mini|nano))?|o[134](?:-mini)?)$/.test(id)) return ['low','medium','high'];
    if (/^claude-(?:opus|sonnet)-[45]/.test(id) && !/image/.test(id)) return ['low','medium','high'];
    var parameters = record && record.supported_parameters;
    if (Array.isArray(parameters) && (parameters.includes('reasoning_effort') || parameters.includes('reasoning'))) return ['low','medium','high'];
    return [];
  }

  modules.createTaskGateway = function (d) {
    var gateway = d.gateway, cache = new Map(), textModule;
    function publicPreset(preset) {
      return preset ? { id: preset.id, name: preset.name, model: preset.model, apiurl: preset.apiurl, source: preset.source || 'openai', hasKey: !!preset.key } : null;
    }
    function getPreset(id) { return d.state().presets.find(function (item) { return item && item.id === id; }); }

    function savePreset(input) {
      input = input || {};
      var state = d.state(), id = String(input.id || ''), old = getPreset(id);
      if (id && !old) throw new Error('此独立方案已不存在');
      if (!id) {
        if (state.presets.length >= 30) throw new Error('方案表已满，请编辑已有方案');
        do { id = 'task-' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); } while (getPreset(id));
      }
      var apiurl = String(input.apiurl || '').trim().replace(/\/+$/, '');
      var model = String(input.model || '').trim(), source = String(input.source || 'openai');
      var name = String(input.name || model).trim(), key = String(input.key || '').trim();
      d.validateEndpoint({ apiurl: apiurl, model: model }, true);
      if (apiurl.length > 500 || key.length > 500 || model.length > 200 || name.length > 40 || !/^[\w-]{1,40}$/.test(source)) throw new Error('连接信息超出方案表支持的长度或格式');
      if (!key && !input.clearKey && old && old.apiurl.replace(/\/+$/, '') === apiurl) key = old.key || '';
      var preset = Object.assign({}, old, { id: id, name: name, apiurl: apiurl, model: model, source: source, key: key });
      if (old) state.presets[state.presets.findIndex(function (item) { return item.id === id; })] = preset;
      else state.presets.push(preset);
      if (!d.write(d.presetKey, state)) throw new Error('无法保存独立方案');
      return publicPreset(preset);
    }

    /*
     * 用途：agent 主助手 ｜ delegate[/id] 子代理 ｜ image、video 媒体工具
     *      ｜ director 总导演（首次编纲与结构重构，整卷只跑一两次，适合配旗舰推理模型）
     *      ｜ director_judge 场记（每轮偏移判定、预生成简报与局部微调，高频调用，适合配高性价比的模型）。
     * 两个导演用途的升档由 agent/director.js 的状态机决定，模型之间互不派发。
     */
    var DIRECTOR_KINDS = { director: '总导演', director_judge: '场记' };
    function directorKind(kind) { return Object.prototype.hasOwnProperty.call(DIRECTOR_KINDS, kind); }
    function validKind(kind) {
      if (!/^(agent|delegate(?:\/[\w-]{1,64})?|image|video|director|director_judge)$/.test(kind)) throw new Error('未知的模型用途');
    }
    function taskEffort(raw) { return EFFORTS.indexOf(raw) >= 0 ? raw : 'auto'; }
    function getConnection(kind) {
      validKind(kind);
      var stored = (d.read(TASK_KEY) || {})[kind] || {}, media = kind === 'image' || kind === 'video';
      /* 场记默认跟随总导演的连接；总导演默认跟随主助手。 */
      var selected = String(stored.selected || (kind === 'director_judge' ? 'director' : 'agent')), dedicatedId = String(stored.dedicatedId || '');
      if (selected === 'director' && kind !== 'director_judge') selected = 'agent';
      var enabled = media ? stored.enabled === true : true;
      return { selected: selected, model: String(stored.model || ''), enabled: enabled, configured: enabled, dedicatedId: dedicatedId, effort: taskEffort(stored.effort),
        dedicated: dedicatedId ? publicPreset(getPreset(dedicatedId)) : null, presets: gateway.getAgentConnection().presets };
    }
    function saveConnection(kind, input) {
      validKind(kind);
      if (kind === 'agent' || kind === 'delegate') throw new Error('此用途跟随当前助手连接');
      var table = d.read(TASK_KEY) || {}, old = getConnection(kind), config = input || {};
      var selected = config.selected || old.selected, dedicatedId = old.dedicatedId;
      if (config.dedicated) {
        var preset = savePreset(Object.assign({}, config.dedicated, { id: old.dedicated && dedicatedId || '', name: config.dedicated.name || DIRECTOR_KINDS[kind] || (kind === 'image' ? '图片生成' : kind === 'video' ? '视频生成' : '子代理') }));
        selected = dedicatedId = preset.id;
      }
      var enabled = selected !== 'off' && config.enabled !== false;
      if (selected === 'off') selected = old.selected;
      /* 导演用途还可以选酒馆当前连接、默认方案；场记另可跟随总导演。 */
      var builtin = selected === 'agent' || (directorKind(kind) && (selected === 'tavern' || selected === 'default' || (selected === 'director' && kind === 'director_judge')));
      if (enabled && !builtin && !d.usablePreset(getPreset(selected))) throw new Error('所选独立方案已不存在或配置不完整');
      var model = String(config.model === undefined ? old.model : config.model).trim();
      if (model.length > 200) throw new Error('模型名过长');
      table[kind] = { selected: selected, model: model, enabled: directorKind(kind) ? true : enabled, dedicatedId: dedicatedId };
      if (directorKind(kind)) table[kind].effort = taskEffort(config.effort === undefined ? old.effort : config.effort);
      if (!d.write(TASK_KEY, table)) throw new Error('无法保存模型连接');
      return getConnection(kind);
    }

    function target(kind, options) {
      options = options || {};
      var config = getConnection(kind), selected = options.presetId || options.selected || config.selected;
      var inherited = '';
      if (selected === 'director') {
        /* 跟随总导演：连接与模型都取它的；场记自己填了模型时仍用自己的。 */
        var parent = getConnection('director');
        selected = parent.selected;
        inherited = parent.model;
      }
      var ctx = d.context() || {}, settings = ctx.chatCompletionSettings || {};
      var current = gateway.resolveApi('agent'), main = gateway.getModelCapabilities('agent'), api;
      if (options.dedicated) {
        var draft = options.dedicated, saved = getPreset(draft.id || config.dedicatedId || selected);
        if (!saved && kind === 'agent') saved = getPreset(gateway.getAgentConnection().dedicatedId);
        var url = String(draft.apiurl || '').trim().replace(/\/+$/, '');
        d.validateEndpoint({ apiurl: url }, false);
        var key = draft.key || (!draft.clearKey && saved && saved.apiurl.replace(/\/+$/, '') === url ? saved.key : '');
        api = { apiurl: url, model: draft.model || '', source: draft.source || 'openai', key: key || '' };
      } else if (selected === 'agent') api = current;
      else if (selected === 'tavern') api = null;
      else if (selected === 'default') {
        var state = d.state();
        api = d.presetApi(state.presets.find(function (item) { return item.id === state.defaultId; }));
      } else {
        api = d.presetApi(getPreset(selected));
        if (!api) throw new Error('指定的独立方案已不存在或配置不完整');
      }
      var textCompletion = !api && ctx.mainApi === 'textgenerationwebui';
      if (textCompletion) settings = ctx.textCompletionSettings || textModule && textModule.textgenerationwebui_settings || {};
      var source = api ? api.source : textCompletion ? settings.type || ctx.mainApi : settings.chat_completion_source || main.source;
      var mainModel = textCompletion && textModule && textModule.getTextGenModel ? textModule.getTextGenModel(settings)
        : settings[(source === 'makersuite' ? 'google' : source === 'ooba' ? 'custom' : source) + '_model'] || (!current ? main.model : '');
      var model = String(options.model || config.model || inherited || (api ? api.model : mainModel) || '').trim();
      if (model.length > 200) throw new Error('模型名过长');
      var endpoint = api ? api.apiurl : source === 'custom' ? settings.custom_url || '' : settings.reverse_proxy || '';
      if (textCompletion) {
        var getServer = ctx.getTextGenServer || textModule && textModule.getTextGenServer;
        endpoint = getServer ? getServer(source) : settings.server_urls && settings.server_urls[source] || '';
      }
      var identity = [api ? 'preset' : 'main', source, endpoint, api ? api.key || '' : settings.secret_id || ''].join('|');
      var same = !!current === !!api && (!api || api.apiurl === current.apiurl && api.source === current.source && (api.key || '') === (current.key || ''));
      return { api: api && Object.assign({}, api, { model: model }), ctx: ctx, settings: settings, source: source, model: model, endpoint: endpoint,
        cacheKey: modules.hashText(identity), isCurrent: same && model === (textCompletion ? mainModel : main.model), configured: config.configured, textCompletion:textCompletion };
    }

    async function taskTarget(kind, options) {
      var t = target(kind, options);
      if (t.textCompletion && !textModule && d.env.hostImport) {
        try { textModule = await d.env.hostImport('/scripts/textgen-settings.js'); }
        catch (_) { /* getContext() exposes settings and the active server on older hosts too. */ }
        t = target(kind, options);
      }
      return t;
    }

    function describe(record) {
      var id = typeof record === 'string' ? record : record && (record.id || record.name);
      if (typeof id !== 'string' || !id.trim() || id.length > 200) return null;
      id = id.replace(/^models\//, '');
      var modes = record.output_modalities || record.architecture && record.architecture.output_modalities || [];
      var endpoints = Array.isArray(record.endpoints) ? record.endpoints : [];
      if (!modes.length) {
        if (d.imageModel(id) || d.imageChatModel(id) || /^imagen-/i.test(id) || endpoints.some(function (e) { return /\/images\/generations$/.test(e); })) modes = ['image'];
        else if (/(^|\/)(sora-|veo-)/i.test(id) || endpoints.some(function (e) { return /\/videos$/.test(e); })) modes = ['video'];
        else if (/^(audio|tts)$/i.test(record.type) || /(?:^|\/)tts-/i.test(id)) modes = ['audio'];
        else if (/embedding/i.test(record.type) || /(?:^|[-/])embed(?:ding)?s?[-/]/i.test(id)) modes = ['embeddings'];
      }
      var nonChat = /^(?:embedding|rerank|transcription|tts)$/i.test(record.type) || /(?:^|[-/])(?:rerank(?:er)?|whisper|transcribe)(?:[-/]|$)/i.test(id);
      return { id: id, contextWindow: d.metadataLimit(record) || d.catalogWindow(id) || 0, reasoningEfforts: efforts(record, id, d.geminiThinkingSpec),
        supportsTextChat: !nonChat && (!modes.length || modes.includes('text')),
        outputModalities: Array.isArray(modes) ? modes.filter(function (mode) { return ['text','image','video','audio','embeddings'].includes(mode); }) : [] };
    }
    function baseUrl(api, version) {
      var url = String(api.apiurl || '').replace(/\/+$/, '');
      return /\/v\d+(?:alpha|beta)?$/i.test(url) ? url : url + '/' + version;
    }
    async function loadModels(t, signal) {
      var fetcher = d.fetcher(), ctx = t.ctx, api = t.api;
      if (signal && signal.aborted) throw d.abortError();
      var records;
      if (t.textCompletion && fetcher && ctx.getRequestHeaders) {
        if (!t.endpoint) throw new Error('酒馆文本补全尚未选择服务器地址');
        var status = await fetcher('/api/backends/text-completions/status', { method:'POST',
          headers:Object.assign({ 'Content-Type':'application/json' }, ctx.getRequestHeaders()),
          body:JSON.stringify({ api_type:t.source, api_server:t.endpoint }), signal:signal });
        if (!status.ok) throw Object.assign(new Error('文本补全模型列表返回 HTTP ' + status.status), { status:status.status });
        records = (await status.json()).data;
      } else if (fetcher && ctx.getRequestHeaders && (api || ctx.mainApi === 'openai')) {
        var body = { chat_completion_source: t.source };
        if (api) {
          body.reverse_proxy = api.apiurl; body.proxy_password = api.key || '';
          if (t.source === 'custom') { body.custom_url = api.apiurl; body.custom_include_headers = 'Authorization: ' + JSON.stringify(api.key ? 'Bearer ' + api.key : ''); }
        } else {
          ['reverse_proxy','proxy_password','custom_url','custom_include_headers','secret_id','azure_base_url','azure_deployment_name','azure_api_version','vertexai_region'].forEach(function (key) {
            if (t.settings[key] !== undefined) body[key] = t.settings[key];
          });
        }
        var res = await fetcher('/api/backends/chat-completions/status', { method: 'POST', headers: Object.assign({ 'Content-Type':'application/json' }, ctx.getRequestHeaders()), body: JSON.stringify(body), signal: signal });
        if (res.ok) { var raw = await res.json(); records = raw.data || raw.models; }
        if (!Array.isArray(records) && !res.ok && api && !['claude','makersuite'].includes(api.source)) throw Object.assign(new Error('模型列表接口返回 HTTP ' + res.status), { status: res.status });
      }
      if ((!Array.isArray(records) || !records.length) && api && fetcher) {
        var nativeGoogle = api.source === 'makersuite', nativeClaude = api.source === 'claude';
        var endpoint = nativeGoogle || nativeClaude ? baseUrl(api, nativeGoogle ? 'v1beta' : 'v1') : api.apiurl.replace(/\/+$/, '');
        var headers = nativeGoogle ? { 'x-goog-api-key': api.key || '' } : nativeClaude ? { 'x-api-key': api.key || '', 'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' } : api.key ? { Authorization: 'Bearer ' + api.key } : {};
        var next = endpoint + '/models', seenPage = new Set();
        records = [];
        while (next && !seenPage.has(next)) {
          seenPage.add(next);
          var response = await fetcher(next, { headers: headers, signal: signal, redirect: 'error', credentials:'omit' });
          if (!response.ok) throw Object.assign(new Error('模型列表接口返回 HTTP ' + response.status), { status: response.status });
          var data = await response.json(), page = data.data || data.models;
          if (!Array.isArray(page)) throw new Error('模型列表返回格式无效');
          records = records.concat(page);
          next = nativeGoogle && data.nextPageToken ? endpoint + '/models?pageToken=' + encodeURIComponent(data.nextPageToken)
            : nativeClaude && data.has_more && data.last_id ? endpoint + '/models?after_id=' + encodeURIComponent(data.last_id) : '';
        }
      }
      if ((!Array.isArray(records) || !records.length) && !api && d.env.hostImport && ctx.mainApi === 'openai') {
        var hostModule = await d.env.hostImport('/scripts/openai.js');
        records = hostModule && hostModule.model_list;
      }
      if (!Array.isArray(records) || !records.length) throw new Error('当前连接没有返回可选模型列表，可手动填写模型');
      var seen = new Set();
      return records.map(describe).filter(function (item) {
        if (!item || seen.has(item.id)) return false;
        seen.add(item.id);
        if (t.textCompletion) item.reasoningEfforts = []; // The host's text-completions DTO has no per-model effort field.
        return true;
      });
    }

    async function listModels(kind, options) {
      var t = await taskTarget(kind, options), signal = options && options.signal;
      if (signal && signal.aborted) throw d.abortError();
      var Controller = d.env.host && d.env.host.AbortController || root.AbortController;
      var ctl = Controller ? new Controller() : null;
      var abort = function () { if (ctl) ctl.abort(); }, timedOut = false;
      if (signal) signal.addEventListener('abort', abort, { once:true });
      var timer = ctl && setTimeout(function () { timedOut = true; abort(); }, 7500);
      try { var records = await loadModels(t, ctl ? ctl.signal : signal); }
      catch (error) {
        if (signal && signal.aborted) throw d.abortError();
        if (timedOut) throw Object.assign(new Error('模型列表读取超时'), { name:'TimeoutError' });
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
      }
      cache.set(t.cacheKey, { records: records, at: Date.now() });
      return modules.clone(records);
    }
    async function resolveModel(kind, options) {
      options = options || {};
      var t = await taskTarget(kind, options);
      if (!t.api && !t.model) {
        await gateway.resolveModelCapabilities('agent', { signal: options.signal });
        t = target(kind, options);
      }
      /* cacheMs：模型信息可以缓存多久。每轮都要调用的用途（场记）给一个长的：模型列表不必每轮重拉，拉不到也不必每轮重试。 */
      var keep = Number(options.cacheMs) > 0 ? Number(options.cacheMs) : 0;
      var cached = cache.get(t.cacheKey), fresh = !!cached && Date.now() - cached.at < (keep || 30000);
      var records = options.models || (fresh && cached.records) || [];
      if (!records.length && !(keep && fresh)) {
        try { records = await listModels(kind, options); }
        catch (error) {
          if (options.signal && options.signal.aborted || error.name === 'AbortError') throw error;
          if (keep) cache.set(t.cacheKey, { records: [], at: Date.now() });
        }
      }
      var record = records.find(function (item) { return item.id === t.model; }) || describe(t.model) || {};
      var main = gateway.getModelCapabilities('agent');
      return { model:t.model, source:t.source, contextWindow: record.contextWindow || (t.isCurrent && main.contextWindow) || 32768,
        reasoningEfforts: t.textCompletion ? [] : record.reasoningEfforts || [], supportsTextChat: record.supportsTextChat !== false, outputModalities: record.outputModalities || [], isCurrent: t.isCurrent };
    }
    async function chatTask(options) {
      var kind = options.kind || 'delegate', t = await taskTarget(kind, options);
      var info = await resolveModel(kind, options), live = target(kind, options);
      if (live.cacheKey !== t.cacheKey || live.model !== t.model) throw Object.assign(new Error('派发时模型连接已更换，请重试'), { code:'model_changed' });
      if (!info.supportsTextChat || d.imageModel(info.model) || d.imageChatModel(info.model)) throw new Error('所选' + (directorKind(kind) ? '导演' : '子代理') + '模型不支持文本回复');
      /* 思考档位：调用方没指定时用这个用途自己保存的（导演两档各存各的）。 */
      var wanted = options.reasoningEffort === undefined && directorKind(kind) ? getConnection(kind).effort : options.reasoningEffort;
      return gateway.chat({ api:t.api, route:'agent', modelOverride:info.model, messages:options.messages, temperature:options.temperature,
        maxTokens:options.maxTokens, contextWindow:info.contextWindow, signal:options.signal, retries:options.retries === undefined ? 0 : options.retries, timeoutMs:options.timeoutMs,
        generationId:options.generationId || 'reader-child', checkProviderStop:true,
        reasoningEffort:info.reasoningEfforts.includes(wanted) ? wanted : 'auto' });
    }
    return { getConnectionPreset:function (id) { return publicPreset(getPreset(id)); }, saveConnectionPreset:savePreset, getTaskConnection:getConnection,
      saveTaskConnection:saveConnection, listTaskModels:listModels, resolveTaskModel:resolveModel, chatTask:chatTask,
      generateMedia: modules.createMediaGenerator(Object.assign({}, d, { target:target, baseUrl:baseUrl })) };
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
