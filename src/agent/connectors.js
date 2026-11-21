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

  var PLOT_ORDER = ['baibai', 'shujuku', 'lwb', 'worldengine'];
  var RESERVED_TOOLSETS = /^(?:core|reader|memory|tavern|web|device|mcp)$/;

  function clipBrief(text, budget) {
    var source = String(text || '').trim();
    return source.length > budget ? source.slice(0, budget - 1) + '…' : source;
  }

  // The database exports merged sheets with a header row. Its history-context API
  // returns chat/isolation identifiers, not the table contents.
  function databaseBrief(tables, budget) {
    if (typeof tables === 'string') tables = JSON.parse(tables);
    var sheets = Object.keys(tables || {}).filter(function (key) { return key.startsWith('sheet_'); })
      .map(function (key) { return tables[key]; })
      .filter(function (sheet) { return sheet && Array.isArray(sheet.content) && sheet.content.length > 1; });
    function priority(sheet) { return /大纲|总结|纪要|剧情|事件/.test(sheet.name) ? 0 : 1; }
    sheets.sort(function (a, b) { return priority(a) - priority(b) || (a.orderNo || 0) - (b.orderNo || 0); });
    var parts = [], size = 0;
    for (var sheet of sheets) {
      var lines = [], rows = sheet.content, header = rows[0] || [];
      // Recent rows first when a long chronology exceeds the budget.
      for (var i = rows.length - 1; i > 0 && size < budget; i--) {
        if (!Array.isArray(rows[i])) continue;
        var line = rows[i].map(function (cell, column) {
          if (!header[column] || cell == null || !String(cell).trim()) return '';
          return header[column] + '：' + cell;
        }).filter(Boolean).join('，');
        if (line) { lines.push(line); size += line.length + 1; }
      }
      if (lines.length) parts.push('【' + String(sheet.name || '表格') + '】\n' + lines.join('\n'));
      if (size >= budget) break;
    }
    return parts.join('\n');
  }

  // LittleWhiteBox 3.x stores its finished plot summary on this chat. Its live
  // injection slot is transient and has no chat ID. Reading the stored projection
  // avoids a generation hook, an extra copy of the story, and vector/LLM calls.
  function lwbBrief(ctx, budget) {
    var settings = ctx.extensionSettings || {};
    var pluginSettings = settings.LittleWhiteBox || {};
    var owner = ctx.chatMetadata && ctx.chatMetadata.extensions && ctx.chatMetadata.extensions.LittleWhiteBox;
    if (!owner || owner.storySummaryEnabled === false || pluginSettings.storySummary && pluginSettings.storySummary.enabled === false ||
        (settings.disabledExtensions || []).some(function (name) { return /(?:^|\/)LittleWhiteBox$/i.test(name); })) return '';
    var store = owner.storySummary;
    if (!store || store.summaryInvalid || store.sourceInvalidFromFloor != null || store.sourceRollbackFromFloor != null || !store.json) return '';
    var data = store.json, parts = [], size = 0;
    function add(lines, format) {
      if (!Array.isArray(lines)) return;
      for (var i = lines.length - 1; i >= 0 && size < budget; i--) {
        if (!lines[i]) continue;
        var line = format(lines[i]);
        if (line) { parts.push(line); size += line.length + 1; }
      }
    }
    add(data.events, function (event) { return [event.timeLabel, event.title, event.summary].filter(Boolean).join(' · '); });
    add(data.facts, function (fact) { return fact.retracted ? '' : [fact.s, fact.p, fact.o].filter(Boolean).join(' '); });
    add(data.arcs, function (arc) {
      var moments = (arc.moments || []).map(function (m) { return typeof m === 'string' ? m : m && m.text; }).filter(Boolean);
      return [arc.name, moments.length ? moments.join(' → ') : arc.trajectory].filter(Boolean).join('：');
    });
    return parts.join('\n');
  }

  function worldBrief(api, budget) {
    if (typeof api.hasState === 'function' && !api.hasState()) return '';
    var state = api.loadState();
    if (!state || typeof state !== 'object') return '';
    var parts = [];
    var size = 0;
    function append(text) {
      if (!text || size >= budget) return;
      var line = clipBrief(text, budget - size);
      parts.push(line);
      size += line.length + 1;
    }
    if (state.worldDigest !== '世界正在苏醒，一切尚未可知。') append(state.worldDigest);
    // Some versions merge connection and evolution settings into loadState().
    // Summary arrays already start at the newest entry. Read only narrative text.
    for (var key of ['volumeSummaries', 'chapterSummaries', 'events', 'plotThreads', 'memories', 'factions', 'rumors']) {
      if (!Array.isArray(state[key])) continue;
      for (var entry of state[key]) {
        if (size >= budget) break;
        if (!entry) continue;
        if (typeof entry === 'string') append(entry);
        else append([entry.title || entry.name, entry.summary || entry.content || entry.text || entry.description, entry.stage, entry.goal]
          .filter(function (part) { return typeof part === 'string' && part.trim(); }).join(' · '));
      }
    }
    append(state.worldDescription);
    return parts.join('\n');
  }

  function toolParams(tool) {
    if (tool.params == null) return [];
    if (!Array.isArray(tool.params)) throw new Error('工具 ' + tool.name + ' 的 params 需要是参数列表');
    for (var param of tool.params) {
      if (!param || typeof param.name !== 'string' || !param.name.trim()) throw new Error('工具 ' + tool.name + ' 的参数缺少 name');
    }
    return tool.params;
  }

  function fromManifest(host, manifest) {
    if (!modules.isObject(manifest) || typeof manifest.id !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(manifest.id)) throw new Error('对接描述的 id 只能用小写字母、数字、下划线');
    if (typeof manifest.detect !== 'string' || !manifest.detect.trim()) throw new Error('请填写用于识别插件的接口名称（detect）');
    /* 对接的 id 就是工具箱的名字：不能占用内置工具箱的。 */
    if (RESERVED_TOOLSETS.test(manifest.id)) throw new Error('对接描述的 id 不能用 ' + manifest.id + '（这是内置工具箱的名字）');
    var id = manifest.id;
    if (manifest.tools != null && !Array.isArray(manifest.tools)) throw new Error('对接工具需要以列表提供');
    if (manifest.tools && manifest.tools.length > 40) throw new Error('每份对接最多可登记 40 个工具');
    var tools = (manifest.tools || []).map(function (item) {
      if (!item || typeof item.name !== 'string' || !/^[a-z][a-z0-9_]{1,47}$/.test(item.name) || typeof item.call !== 'string' || !item.call.trim()) throw new Error('对接描述里的工具需要 name 与 call');
      var declared = toolParams(item);
      if (declared.length > 12) throw new Error('工具 ' + item.name + ' 最多可登记 12 个参数');
      var params = declared.map(function (param) {
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
      brief: typeof manifest.brief === 'string' && manifest.brief.trim() ? async function () {
        var target = lookup(host, manifest.brief);
        if (typeof target.value !== 'function') return '';
        var value = await target.value.call(target.owner);
        if (value == null || (typeof value === 'object' && !Object.keys(value).length)) return '';
        return typeof value === 'string' ? value : JSON.stringify(value);
      } : null,
      tools: tools
    };
  }

  function builtinConnectors(env, kit) {
    var host = env.host;
    var list = [];

    list.push({
      id: 'tavernhelper', title: '酒馆助手', summary: '让夜梦查看角色变量、世界书，以及酒馆助手管理的脚本和预设。',
      detect: function () { return !!host.TavernHelper; }
    });

    list.push({
      id: 'mvu', title: 'MVU 变量框架', summary: '可查看角色卡用 MVU 记录的状态，例如好感度、物品或当前地点。',
      detect: function () { return !!(host.Mvu && typeof host.Mvu.getMvuData === 'function'); }, skill: 'mvu'
    });

    list.push({
      id: 'lwb', title: '小白X（LittleWhiteBox）', summary: '读取小白X保存的事件和剧情线，也能通过它的变量工具查看或修改角色状态。',
      detect: function () { return !!(host.LittleWhiteBox || host.LWB_StateV2 || host.xiaobaixGenerateInterceptor); }, skill: 'lwb-variables',
      brief: function (options) { return lwbBrief(kit.context() || {}, options.budget); },
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
      summaryMethods: ['STBaiBaiBook.getHistory', 'STBaiBaiBook.getInjectedHistory', 'STBaiBaiBook.getSnapshot'],
      detect: function () { var api = host.STBaiBaiBook; return !!(api && (api.getHistory || api.getInjectedHistory || api.getSnapshot)); },
      brief: async function (options) {
        var api = host.STBaiBaiBook, parts = [], text = '';
        // getInjectedHistory excludes the visible window. Reader has no raw story
        // transcript in this request, so include recent valid summaries when available.
        for (var method of ['getHistory', 'getInjectedHistory']) {
          if (typeof api[method] !== 'function') continue;
          try {
            var history = method === 'getHistory' ? await api.getHistory({}) : await api.getInjectedHistory();
            text = String(history && (history.relativeText || history.text) || '').trim();
            if (text) break;
          } catch (error) { /* 下一种只读查询 */ }
        }
        try {
          var snapshot = api.getSnapshot && await api.getSnapshot();
          var state = snapshot && snapshot.state || {};
          if (state.time || state.location) parts.push('现在：' + [state.time, state.location].filter(Boolean).join('，'));
        } catch (error) { /* ignore */ }
        var remaining = options.budget - (parts[0] || '').length - 1;
        if (text && remaining > 1) parts.push(text.length > remaining ? '…' + text.slice(1 - remaining) : text);
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
      summaryMethods: ['AutoCardUpdaterAPI.exportTableAsJson'],
      detect: function () { return !!(host.AutoCardUpdaterAPI && typeof host.AutoCardUpdaterAPI.exportTableAsJson === 'function'); },
      brief: async function (options) {
        return databaseBrief(await host.AutoCardUpdaterAPI.exportTableAsJson(), options.budget);
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
      id: 'worldengine', title: '世界引擎（World Engine）', summary: '当前聊天的后台世界状态、事件与剧情线',
      summaryMethods: ['WORLD_ENGINE_CORE.loadState'],
      detect: function () { return !!(host.WORLD_ENGINE_CORE && typeof host.WORLD_ENGINE_CORE.loadState === 'function'); },
      brief: function (options) { return worldBrief(host.WORLD_ENGINE_CORE, options.budget); }
    });

    list.push({
      id: 'ejs', title: '提示词模板（ST-Prompt-Template）', summary: '让夜梦试运行世界书或预设里的模板，帮你检查它最终会生成什么文字。',
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
      id: 'yuzuki', title: '柚月の记忆', detectionOnly: true, summary: '如所用版本提供摘要读取接口，可在下方添加剧情记忆来源。',
      detect: function () { return !!host.YuzukiMemory; }
    });

    return list;
  }

  function installConnectors(registry, env, kit, getSettings, vfs) {
    var builtins = builtinConnectors(env, kit);
    var integrated = builtins.filter(function (c) { return !c.detectionOnly; });
    var recognized = builtins.filter(function (c) { return c.detectionOnly; });
    var builtinTools = new Map();
    integrated.forEach(function (c) {
      (c.tools || []).forEach(function (tool) { builtinTools.set(tool.name, c); });
    });
    var catalog = new Map();
    var registrations = new Map();
    var extensions = new Map(), scan = null, scanIssues = null;

    async function readDescriptor(base, filename) {
      var text = await vfs.readText(base + filename);
      if (text == null) throw new Error('无法读取 ' + filename);
      var descriptor;
      try { descriptor = JSON.parse(text); } catch { throw new Error(filename + ' 的 JSON 格式有误'); }
      if (!modules.isObject(descriptor)) throw new Error(filename + ' 需要包含一个 JSON 对象');
      return descriptor;
    }

    async function discover(options) {
      if (scan) return scan;
      if (scanIssues && !(options && options.force)) return scanIssues;
      scan = (async function () {
        var directories = await vfs.list('ext:/', { limit: Infinity, refresh: true });
        var found = new Map(), errors = [];
        async function readManifest(dir) {
          if (!dir.dir || !dir.name || /[/\\]/.test(dir.name) || /^\.{1,2}$/.test(dir.name)) return;
          var base = 'ext:/' + modules.vfsEnc(dir.name) + '/';
          try {
            var data = await readDescriptor(base, 'manifest.json');
            var declaration = data.reader_ii_connector;
            if (!declaration) return;
            // 文件总是扩展根目录中的 connector.json。扫描只读声明，不运行插件提供的代码。
            var manifest = declaration === true || declaration === 'connector.json'
              ? await readDescriptor(base, 'connector.json') : declaration;
            var c = fromManifest(env.host, manifest);
            return c;
          } catch (error) { errors.push(dir.name + '：' + String(error.message || error)); }
        }
        var dirs = directories.items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
        for (var index = 0; index < dirs.length; index += 8) {
          var batch = dirs.slice(index, index + 8);
          var manifests = await Promise.all(batch.map(readManifest));
          manifests.forEach(function (c, i) {
            if (!c) return;
            if (!found.has(c.id)) found.set(c.id, c);
            else errors.push(batch[i].name + ' 使用了重复的对接标识 ' + c.id);
          });
        }
        extensions = found;
        scanIssues = errors;
        refresh();
        return errors;
      })();
      try { return await scan; } finally { scan = null; }
    }

    function validate(manifest) {
      var connector = fromManifest(env.host, manifest);
      if (integrated.concat(registry.connectors()).some(function (other) { return other.id === connector.id; })) {
        throw new Error('该插件已有对接，可在列表里直接使用。');
      }
      checkTools(connector);
      return connector;
    }

    function checkTools(connector) {
      if (connector.tools == null) return;
      if (!Array.isArray(connector.tools)) throw new Error('对接工具需要以列表提供');
      if (!connector.tools.length) return;
      var id = connector.id, owned = registrations.get(id);
      if (typeof id !== 'string' || RESERVED_TOOLSETS.test(id) || id.startsWith('mcp/')) throw new Error('请为对接选择独立的工具箱名称：' + id);
      registry.checkToolset({ name: id });
      var previous = registry.findToolset(id);
      if (previous && (!owned || previous !== owned.set || registry.tools(id).some(function (tool) { return !owned.tools.has(tool); }))) {
        throw new Error('工具箱名称 ' + id + ' 已被使用，请为对接更换 id');
      }
      var names = new Set();
      connector.tools.forEach(function (tool) {
        if (!tool || typeof tool.name !== 'string') throw new Error('对接工具需要一个工具名');
        registry.checkTool(tool);
        toolParams(tool);
        if (names.has(tool.name)) throw new Error('对接里有重复工具名 ' + tool.name + '，请修改对接');
        names.add(tool.name);
        var builtin = builtinTools.get(tool.name);
        if (builtin && builtin !== connector) throw new Error('工具名 ' + tool.name + ' 已由「' + builtin.title + '」使用，请为对接工具改名');
        var existing = registry.find(tool.name);
        if (existing && (!owned || !owned.tools.has(existing))) {
          throw new Error('工具名 ' + tool.name + ' 已由「' + existing.toolset + '」使用，请为对接工具改名');
        }
      });
    }

    function release(registration, id) {
      registration.tools.forEach(function (tool) {
        if (registry.find(tool.name) === tool) registry.unregisterTool(tool.name);
      });
      if (registry.findToolset(id) === registration.set && !registry.tools(id).length) registry.unregisterToolset(id);
      registrations.delete(id);
    }

    function installTools(row) {
      var connector = row.connector;
      var registration;
      try {
        checkTools(connector);
        if (registrations.has(connector.id)) release(registrations.get(connector.id), connector.id);
        if (!connector.tools || !connector.tools.length) return;
        registry.registerToolset({ name: connector.id, summary: connector.title + '：' + (connector.summary || ''), source: row.origin });
        registration = { set: registry.findToolset(connector.id), tools: new Set() };
        connector.tools.forEach(function (tool) {
          var name = registry.registerTool(Object.assign({}, tool, { toolset: connector.id }));
          registration.tools.add(registry.find(name));
        });
        registrations.set(connector.id, registration);
      } catch (error) {
        if (registration) release(registration, connector.id);
        else if (registrations.has(connector.id)) release(registrations.get(connector.id), connector.id);
        row.problem = String(error.message || error);
        row.enabled = false;
      }
    }

    // 一份按 id 去重的目录供设置、工具注册、剧情读取共同使用。
    function refresh() {
      var settings = getSettings(), choices = settings.connectorChoices || {};
      catalog.clear();
      function add(connector, origin, problem) {
        var key = connector.id || connector;
        if (catalog.has(key)) return;
        var present = false;
        if (!problem && typeof connector.detect !== 'function') problem = '插件对接缺少识别函数 detect';
        if (!problem) {
          try { present = !!connector.detect(); } catch (error) { problem = '检测插件时出错：' + String(error && error.message || error); }
        }
        var enabled = !problem && !connector.detectionOnly && (Object.prototype.hasOwnProperty.call(choices, connector.id)
          ? choices[connector.id] : origin === 'builtin' || origin === 'custom');
        catalog.set(key, { connector: connector, origin: origin, present: present, enabled: enabled, problem: problem || '' });
      }
      integrated.forEach(function (item) { add(item, 'builtin'); });
      registry.connectors().forEach(function (item) { add(item, 'registered'); });
      (settings.connectors || []).forEach(function (manifest, index) {
        try { add(fromManifest(env.host, manifest), 'custom'); } catch (error) {
          var id = typeof manifest.id === 'string' ? manifest.id : '';
          add({ id: id, title: String(manifest.title || id || '已保存的对接 ' + (index + 1)) }, 'custom', error.message);
        }
      });
      extensions.forEach(function (connector) { add(connector, 'extension'); });
      // A name-only preset is a fallback until the plugin provides an actual connector.
      recognized.forEach(function (item) { add(item, 'builtin'); });
      // 保留仍在使用的工具，避免前面的插件更新时抢走后面插件已登记的名字。
      registrations.forEach(function (registration, id) {
        var row = catalog.get(id);
        if (!row || !row.present || !row.enabled) release(registration, id);
      });
      catalog.forEach(function (row) { if (row.present && row.enabled) installTools(row); });
      catalog.forEach(function (row) {
        if (row.present && row.enabled || row.problem) return;
        try { checkTools(row.connector); } catch (error) { row.problem = String(error.message || error); row.enabled = false; }
      });
    }
    function entries() { return Array.from(catalog.values()); }
    async function prepare(signal) {
      refresh();
      if (scanIssues) return;
      var choices = getSettings().connectorChoices || {};
      var needsScan = Object.keys(choices).some(function (id) {
        var row = catalog.get(id);
        return choices[id] && (!row || row.connector.detectionOnly);
      });
      if (needsScan) await waitForPlugin(discover, signal);
    }
    function active() { return entries().filter(function (row) { return row.present && row.enabled; }).map(function (row) { return row.connector; }); }
    function list() {
      refresh();
      return entries().map(function (row) {
        var c = row.connector;
        return { id: c.id, title: c.title || c.id, summary: c.summary || '', origin: row.origin, present: row.present, enabled: row.enabled,
          hasBrief: typeof c.brief === 'function', tools: Array.isArray(c.tools) ? c.tools.length : 0, problem: row.problem,
          detectionOnly: c.detectionOnly === true, custom: row.origin === 'custom' && !!c.id };
      });
    }

    async function brief(sources, budget, signal) {
      var chat = kit.chatKey();
      if (!kit.names().chat) return '';
      var byId = new Map(active().filter(function (c) { return typeof c.brief === 'function'; }).map(function (c) { return [c.id, c]; }));
      var automatic = sources === 'auto';
      var ids = automatic ? new Set(PLOT_ORDER.concat(Array.from(byId.keys()))) : sources;
      var chosen = Array.from(ids, function (id) { return byId.get(id); }).filter(Boolean);
      function stale() { return (signal && signal.aborted) || kit.chatKey() !== chat; }
      async function read(c) {
        var value = await waitForPlugin(function () { return c.brief({ budget: budget, signal: signal }); }, signal);
        return { title: c.title || c.id, text: typeof value === 'string' ? value.trim().slice(0, budget) : '' };
      }
      if (automatic) {
        for (var c of chosen) {
          var result = await read(c);
          if (stale()) return '';
          if (result.text) return formatSummaries([result], budget);
        }
        return '';
      }
      var items = await Promise.all(chosen.map(read));
      if (stale()) return '';
      var seen = new Set();
      return formatSummaries(items.filter(function (item) {
        if (!item.text || seen.has(item.text)) return false;
        seen.add(item.text);
        return true;
      }), budget);
    }
    function memorySource(title, methodPath) {
      var path = String(methodPath || '').trim().replace(/\(\s*\)$/, '').replace(/^(?:window|globalThis)\./, '');
      var name = String(title || '').trim();
      if (!name) throw new Error('请给这个剧情来源起个名字');
      if (!/^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)+$/.test(path)) throw new Error('请填写插件提供的摘要接口，例如 MyMemory.getSummary');
      var method = lookup(env.host, path).value;
      if (typeof method !== 'function') throw new Error('当前酒馆找不到 ' + path + '，请确认插件已启用并核对接口名称');
      refresh();
      var previous = entries().find(function (row) {
        var c = row.connector;
        var methods = c.summaryMethods || (c.manifest && c.manifest.brief ? [c.manifest.brief] : []);
        return !row.problem && (c.brief === method || Array.isArray(methods) && methods.some(function (key) { return lookup(env.host, key).value === method; }));
      });
      if (previous) throw new Error('该摘要接口已列为「' + previous.connector.title + '」，可直接选择这个来源');
      return { id: 'memory_' + modules.hashText(path), title: name, detect: path, brief: path };
    }
    return { refresh: refresh, prepare: prepare, active: active, list: list, discover: discover, brief: brief, validate: validate, memorySource: memorySource };
  }

  // 扩展扫描和摘要读取都可能迟迟没有结果；停止对话时立即释放等待。
  function waitForPlugin(task, signal) {
    return new Promise(function (resolve) {
      var timer = setTimeout(finish, 2500);
      function finish(value) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', stop);
        resolve(value);
      }
      function stop() { finish(); }
      if (signal) {
        if (signal.aborted) { stop(); return; }
        signal.addEventListener('abort', stop, { once: true });
      }
      Promise.resolve().then(task).then(finish, stop);
    });
  }

  function formatSummaries(items, budget) {
    var sections = [], available = budget;
    items.forEach(function (item) {
      var label = '（摘要来自' + String(item.title).slice(0, 60) + '）\n';
      var cost = label.length + (sections.length ? 2 : 0);
      if (available - cost <= sections.length) return;
      available -= cost;
      sections.push({ label: label, text: item.text, limit: 0 });
    });
    // Give every source room. Short entries return their unused characters to the others.
    sections.slice().sort(function (a, b) { return a.text.length - b.text.length; }).forEach(function (item, index) {
      item.limit = Math.min(item.text.length, Math.floor(available / (sections.length - index)));
      available -= item.limit;
    });
    return sections.map(function (item) { return item.label + clipBrief(item.text, item.limit); }).join('\n\n');
  }

  modules.installConnectors = installConnectors;
})(typeof globalThis !== 'undefined' ? globalThis : window);
