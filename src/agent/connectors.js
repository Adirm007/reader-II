(function (root) {
  'use strict';

  /*
   * 插件对接（connector）：探测酒馆里装着的其他插件，把它们的接口变成助手能用的东西。
   *
   *   { id, title, summary, detect() → 是否可用,
   *     brief(options) → 一段剧情 / 状态摘要（给「剧情察知」用，可省略）,
   *     tools: [工具定义]（登记到与 id 同名的工具箱，探测到才出现）, skill: 相关知识的名字 }
   *
   * 用户导入的对接是「声明式」的，不含代码：
   *   { "id": "my-plugin", "title": "…", "summary": "…", "detect": "window.MyPlugin",
   *     "brief": "MyPlugin.getSummary",
   *     "tools": [{ "name": "myplugin_get", "summary": "…", "effect": "read", "call": "MyPlugin.get",
   *                 "params": [{ "name": "id", "type": "string", "required": true }] }] }
   * call / brief / detect 都是宿主窗口上的全局路径；调用时按 params 的顺序传参。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  function lookup(host, path) {
    var parts = String(path || '').replace(/^(?:window|globalThis)\./, '').split('.').filter(Boolean);
    var owner = null, current = host;
    for (var index = 0; index < parts.length; index += 1) {
      if (/^(?:__proto__|constructor|prototype)$/.test(parts[index])) return { value: undefined };
      if (current === null || current === undefined) return { value: undefined };
      owner = current;
      try { current = current[parts[index]]; } catch (error) { return { value: undefined }; }
    }
    return { value: current, owner: owner };
  }

  function shorten(text, limit) {
    var source = String(text == null ? '' : text).trim();
    return source.length > limit ? source.slice(0, limit) + '…（已截断）' : source;
  }

  function fromManifest(host, manifest) {
    if (!modules.isObject(manifest) || !/^[a-z][a-z0-9_]{1,31}$/.test(String(manifest.id || ''))) throw new Error('对接描述的 id 只能用小写字母、数字、下划线');
    /* 对接的 id 就是工具箱的名字：不能占用内置工具箱的。 */
    if (/^(?:core|reader|memory|tavern|web|device|mcp)$/.test(manifest.id)) throw new Error('对接描述的 id 不能用 ' + manifest.id + '（这是内置工具箱的名字）');
    var id = manifest.id;
    var tools = (Array.isArray(manifest.tools) ? manifest.tools : []).slice(0, 40).map(function (item) {
      if (!item || !/^[a-z][a-z0-9_]{1,47}$/.test(String(item.name || '')) || typeof item.call !== 'string') throw new Error('对接描述里的工具需要 name 与 call');
      var params = (Array.isArray(item.params) ? item.params : []).slice(0, 12).map(function (param) {
        return { name: String(param.name), type: ['string', 'number', 'boolean', 'json'].indexOf(param.type) >= 0 ? param.type : 'string', required: param.required === true, desc: String(param.desc || '') };
      });
      return {
        name: item.name, summary: String(item.summary || item.call).slice(0, 300), params: params,
        effect: ['read', 'write', 'danger'].indexOf(item.effect) >= 0 ? item.effect : 'write',
        scope: ['chat', 'card', 'tavern'].indexOf(item.scope) >= 0 ? item.scope : 'tavern',
        irreversible: item.effect !== 'read',
        run: async function (args) {
          var target = lookup(host, item.call);
          if (typeof target.value !== 'function') throw new Error('找不到函数 ' + item.call + '（插件没加载，或接口改名了）');
          return target.value.apply(target.owner, params.map(function (param) { return args[param.name]; }));
        }
      };
    });
    return {
      id: id, title: String(manifest.title || id).slice(0, 60), summary: String(manifest.summary || '').slice(0, 200), custom: true, manifest: manifest,
      detect: function () { return lookup(host, manifest.detect).value !== undefined; },
      brief: typeof manifest.brief === 'string' ? async function () {
        var target = lookup(host, manifest.brief);
        if (typeof target.value !== 'function') return '';
        var value = await target.value.call(target.owner);
        return typeof value === 'string' ? value : JSON.stringify(value);
      } : null,
      tools: tools
    };
  }

  function builtinConnectors(env, kit) {
    var host = env.host;
    var list = [];

    list.push({
      id: 'tavernhelper', title: '酒馆助手', summary: '提供变量、世界书、正则、脚本、预设等接口；脚本在 script:/，更多函数见 tavern 工具箱',
      detect: function () { return !!host.TavernHelper; }
    });

    list.push({
      id: 'mvu', title: 'MVU 变量框架', summary: '变量在 var:/mvu.json（stat_data）；正文用 <UpdateVariable> 更新',
      detect: function () { return !!(host.Mvu && typeof host.Mvu.getMvuData === 'function'); }, skill: 'mvu'
    });

    list.push({
      id: 'lwb', title: '小白X（LittleWhiteBox）', summary: '变量存在聊天变量里（var:/chat.json）；写入请用 lwb_state_apply，让它的楼层账本与校验保持一致',
      detect: function () { return !!(host.LittleWhiteBox || host.LWB_StateV2); }, skill: 'lwb-variables',
      tools: [{
        name: 'lwb_state_apply', effect: 'write', scope: 'chat', paths: function () { return ['var:/chat.json']; },
        summary: '按小白X「变量 2.0」的 <state> 写法修改变量，例如 <state>数据.角色.金币: +10</state>。会经过它的模板与约束校验。',
        params: [{ name: 'text', type: 'string', required: true, desc: '完整的 <state>…</state> 文本' }],
        run: async function (args) {
          if (!host.LWB_StateV2 || typeof host.LWB_StateV2.applyText !== 'function') throw new Error('小白X 的变量 2.0 接口不可用：请在它的设置里开启「变量管理 2.0 (state)」');
          return host.LWB_StateV2.applyText(String(args.text));
        }
      }, {
        name: 'lwb_schema', effect: 'read', scope: 'chat', summary: '读取小白X 当前的变量模板与约束。', params: [],
        run: async function () {
          if (!host.LWB_StateV2 || typeof host.LWB_StateV2.getInputSchema !== 'function') throw new Error('当前版本的小白X 没有提供模板读取接口');
          return host.LWB_StateV2.getInputSchema();
        }
      }]
    });

    list.push({
      id: 'baibai', title: '柏宝书（记忆）', summary: '按楼层整理的剧情摘要、状态、人物、物品、计划',
      detect: function () { return !!(host.STBaiBaiBook && typeof host.STBaiBaiBook.getSnapshot === 'function'); },
      brief: async function (options) {
        var api = host.STBaiBaiBook, parts = [];
        try {
          var history = api.getInjectedHistory ? api.getInjectedHistory() : api.getHistory({});
          if (history && (history.relativeText || history.text)) parts.push(shorten(history.relativeText || history.text, options.budget));
        } catch (error) { /* 没有摘要 */ }
        try {
          var snapshot = api.getSnapshot();
          var state = snapshot && snapshot.state || {};
          if (state.time || state.location) parts.push('现在：' + [state.time, state.location].filter(Boolean).join('，'));
        } catch (error) { /* ignore */ }
        return parts.join('\n');
      },
      tools: [{
        name: 'baibai_query', effect: 'read', scope: 'chat',
        summary: '查询柏宝书。resource 可选：snapshot（整份状态）、history（某楼之前的剧情摘要）、state、protagonist、npcs、items、plans、scenes、vars、var（需 path）、floor / context（需 floor）。',
        params: [{ name: 'resource', type: 'string', required: true }, { name: 'path', type: 'string', desc: 'resource=var 时的变量路径' }, { name: 'floor', type: 'number', desc: '楼层号（从 0 起）' }, { name: 'at', type: 'string', desc: 'before 或 after' }, { name: 'before', type: 'number', desc: 'history 的截止楼层' }],
        run: async function (args) {
          var query = { resource: args.resource };
          ['path', 'floor', 'at', 'before'].forEach(function (key) { if (args[key] !== undefined) query[key] = args[key]; });
          return host.STBaiBaiBook.query(query);
        }
      }]
    });

    list.push({
      id: 'shujuku', title: '数据库（shujuku / 龙血玄黄）', summary: '表格式记忆：人物、物品、事件等表',
      detect: function () { return !!(host.AutoCardUpdaterAPI && typeof host.AutoCardUpdaterAPI.exportTableAsJson === 'function'); },
      brief: async function (options) {
        var api = host.AutoCardUpdaterAPI;
        try {
          var context = typeof api.getTableHistoryContext === 'function' ? await api.getTableHistoryContext() : '';
          if (typeof context === 'string' && context.trim()) return shorten(context, options.budget);
        } catch (error) { /* fall through */ }
        var tables = await api.exportTableAsJson();
        return shorten(typeof tables === 'string' ? tables : JSON.stringify(tables), options.budget);
      },
      tools: [{
        name: 'shujuku_tables', effect: 'read', scope: 'chat', summary: '导出数据库当前的全部表格（JSON）。', params: [],
        run: async function () { return host.AutoCardUpdaterAPI.exportTableAsJson(); }
      }, {
        name: 'shujuku_update_cell', effect: 'write', scope: 'chat', irreversible: true, summary: '修改一个单元格。',
        params: [{ name: 'table', type: 'string', required: true, desc: '表名' }, { name: 'row', type: 'number', required: true, desc: '行号' }, { name: 'column', type: 'string', required: true, desc: '列名或列号' }, { name: 'value', type: 'string', required: true }],
        run: async function (args) { return host.AutoCardUpdaterAPI.updateCell(args.table, args.row, /^\d+$/.test(args.column) ? Number(args.column) : args.column, args.value); }
      }, {
        name: 'shujuku_insert_row', effect: 'write', scope: 'chat', irreversible: true, summary: '在表里新增一行。',
        params: [{ name: 'table', type: 'string', required: true }, { name: 'data', type: 'json', required: true, desc: '{ 列名: 值 } 或按列顺序的数组' }],
        run: async function (args) { return host.AutoCardUpdaterAPI.insertRow(args.table, args.data); }
      }, {
        name: 'shujuku_delete_row', effect: 'danger', scope: 'chat', irreversible: true, summary: '删除表里的一行。',
        params: [{ name: 'table', type: 'string', required: true }, { name: 'row', type: 'number', required: true }],
        run: async function (args) { return host.AutoCardUpdaterAPI.deleteRow(args.table, args.row); }
      }]
    });

    list.push({
      id: 'ejs', title: '提示词模板（ST-Prompt-Template）', summary: '世界书 / 预设 / 正文里的 <% %> 模板；写之前先读知识 ejs-prompt-template',
      detect: function () { return !!(host.EjsTemplate && typeof host.EjsTemplate.evalTemplate === 'function'); }, skill: 'ejs-prompt-template',
      tools: [{
        name: 'ejs_render', effect: 'write', scope: 'chat', irreversible: true,
        summary: '在当前聊天环境里试渲染一段 EJS 模板，返回渲染结果或报错。模板里的 setvar 等会真的生效，所以算写入。',
        params: [{ name: 'template', type: 'string', required: true }],
        run: async function (args) {
          var api = host.EjsTemplate;
          var context = typeof api.prepareContext === 'function' ? await api.prepareContext() : {};
          return api.evalTemplate(String(args.template), context);
        }
      }]
    });

    list.push({
      id: 'tauritavern', title: 'TauriTavern 宿主', summary: '后端全文检索整段聊天',
      detect: function () { return !!host.__TAURITAVERN__; },
      tools: [{
        name: 'tt_search_chat', effect: 'read', scope: 'chat', summary: '用 TauriTavern 的后端检索当前聊天（长聊天比 grep chat:/ 快）。',
        params: [{ name: 'query', type: 'string', required: true }, { name: 'limit', type: 'number', desc: '默认 20' }],
        run: async function (args) {
          await (host.__TAURITAVERN__.ready || host.__TAURITAVERN_MAIN_READY__);
          var handle = await host.__TAURITAVERN__.api.chat.current.handle();
          var hits = await handle.searchMessages({ query: String(args.query), limit: Math.max(1, Math.min(50, Math.trunc(args.limit || 20))) });
          return (hits || []).map(function (hit) { return { floor: hit.index, role: hit.role, snippet: hit.snippet }; });
        }
      }]
    });

    list.push({
      id: 'yuzuki', title: '柚月の记忆', summary: '已探测到；它没有公开的读取接口，需要的话读 ext:/ 里它的源码再起草对接',
      detect: function () { return !!host.YuzukiMemory; }
    });

    return list;
  }

  /*
   * getCustom() → 用户导入的对接描述数组。refresh() 重新探测并同步工具箱；返回当前可用的对接。
   */
  function installConnectors(registry, env, kit, getCustom) {
    var active = [];

    function all() {
      var output = builtinConnectors(env, kit).concat(registry.connectors());
      (getCustom() || []).forEach(function (manifest) {
        try { output.push(fromManifest(env.host, manifest)); } catch (error) { env.console.warn('[ReaderII] 忽略了无效的插件对接', error); }
      });
      return output;
    }

    function refresh() {
      var next = [];
      all().forEach(function (connector) {
        var present = false;
        try { present = !!connector.detect(); } catch (error) { present = false; }
        registry.unregisterToolset(connector.id);
        if (!present) return;
        next.push(connector);
        if (connector.tools && connector.tools.length) {
          registry.registerToolset({ name: connector.id, summary: connector.title + '：' + connector.summary, source: connector.custom ? 'custom' : 'builtin' });
          connector.tools.forEach(function (tool) { registry.registerTool(Object.assign({}, tool, { toolset: connector.id })); });
        }
      });
      active = next;
      return active;
    }

    /* 剧情察知用：取第一个给得出摘要的记忆类插件。 */
    async function brief(options) {
      for (var index = 0; index < active.length; index += 1) {
        if (typeof active[index].brief !== 'function') continue;
        try {
          var text = await active[index].brief(options || { budget: 1500 });
          if (text && String(text).trim()) return { source: active[index].title, text: String(text).trim() };
        } catch (error) { /* 换下一个 */ }
      }
      return null;
    }

    return { refresh: refresh, active: function () { return active.slice(); }, brief: brief, validate: function (manifest) { return fromManifest(env.host, manifest); } };
  }

  modules.installConnectors = installConnectors;
})(typeof globalThis !== 'undefined' ? globalThis : window);
