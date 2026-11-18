(function (root) {
  'use strict';

  /*
   * 注册表与核心工具。
   *
   * 工具定义：
   *   { name, toolset = 'core', summary, params: [{ name, type: string|number|boolean|json, required, desc }],
   *     effect: 'read' | 'note' | 'write' | 'danger' | 'net' 或 (args, ctx) => 其一（net = 联网，见 permissions.js）,
   *     scope:  'workspace' | 'chat' | 'card' | 'tavern' | 'external' | 'device' 或 (args, ctx) => 其一,
   *     paths(args) → [VFS 路径]   这次调用会改到的资源：执行前留镜像，可撤销；也用来匹配权限规则
   *     target(args) → 字符串      没有 VFS 路径的工具给权限规则匹配用（网址、cmd:命令 等）
   *     sessionKey(args) → 字符串  「本次对话都允许」按它记（默认按 工具名 + 范围）；alwaysLabel(args) 是那个按钮上的字
   *     irreversible: true         无法自动撤销（斜杠命令、页面脚本等），会记进运行日志
   *     describe(args) → 给用户看的一句话, run(args, ctx) → 结果（字符串或可序列化对象） }
   *
   * 核心工具常驻提示词；其余工具属于某个「工具箱」，打开工具箱后它的说明才进入提示词。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var NAME = /^[a-z][a-z0-9_]{1,47}$/;

  function createRegistry() {
    var tools = new Map();
    var toolsets = new Map();
    var skills = new Map();
    var connectors = new Map();
    var hooks = {};

    function registerToolset(def) {
      if (!def || !NAME.test(String(def.name).replace(/[\/-]/g, '_'))) throw new Error('工具箱名称无效');
      toolsets.set(def.name, { name: def.name, summary: String(def.summary || '').slice(0, 160), auto: def.auto === true, source: def.source || 'plugin' });
      return def.name;
    }

    function registerTool(def) {
      if (!def || !NAME.test(def.name)) throw new Error('工具名只能用小写字母、数字、下划线：' + (def && def.name));
      if (typeof def.run !== 'function') throw new Error('工具 ' + def.name + ' 缺少 run');
      var toolset = def.toolset || 'core';
      if (toolset !== 'core' && !toolsets.has(toolset)) registerToolset({ name: toolset, summary: def.toolsetSummary || '' });
      var item = Object.assign({ params: [], effect: 'read', scope: 'tavern', source: 'plugin' }, def, { toolset: toolset });
      tools.set(item.name, item);
      return item.name;
    }

    function registerSkill(def) {
      if (!def || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(def.name)) throw new Error('知识名只能用小写字母、数字、连字符');
      skills.set(def.name, { name: def.name, summary: String(def.summary || '').slice(0, 200), body: def.body, load: def.load, files: def.files || null, source: def.source || 'plugin' });
      return def.name;
    }

    async function loadSkill(name) {
      var skill = skills.get(String(name || '').trim());
      if (!skill) return null;
      if (typeof skill.body !== 'string' && typeof skill.load === 'function') skill.body = String(await skill.load());
      return skill;
    }

    function on(event, handler) {
      (hooks[event] = hooks[event] || []).push(handler);
      return function () { hooks[event] = (hooks[event] || []).filter(function (item) { return item !== handler; }); };
    }

    async function emit(event, payload) {
      var list = (hooks[event] || []).slice();
      for (var index = 0; index < list.length; index += 1) {
        try { await list[index](payload); } catch (error) { /* 插件的钩子出错不影响运行 */ }
      }
    }

    return {
      registerTool: registerTool, registerToolset: registerToolset, registerSkill: registerSkill,
      unregisterTool: function (name) { return tools.delete(name); },
      unregisterToolset: function (name) {
        Array.from(tools.values()).forEach(function (item) { if (item.toolset === name) tools.delete(item.name); });
        return toolsets.delete(name);
      },
      unregisterSkill: function (name) { return skills.delete(name); },
      registerConnector: function (def) { if (!def || !def.id) throw new Error('插件对接缺少 id'); connectors.set(def.id, def); return def.id; },
      connectors: function () { return Array.from(connectors.values()); },
      find: function (name) { return tools.get(String(name || '').trim()) || null; },
      tools: function (toolset) { return Array.from(tools.values()).filter(function (item) { return !toolset || item.toolset === toolset; }); },
      toolsets: function () { return Array.from(toolsets.values()).filter(function (set) { return Array.from(tools.values()).some(function (item) { return item.toolset === set.name; }); }); },
      skills: function () { return Array.from(skills.values()); },
      loadSkill: loadSkill, on: on, emit: emit
    };
  }

  function resolve(value, args, fallback, ctx) {
    try { return typeof value === 'function' ? value(args, ctx) : value || fallback; } catch (error) { return fallback; }
  }

  /* 工具说明（写给模型看）。 */
  function manual(tools) {
    return tools.map(function (def) {
      var params = (def.params || []).map(function (param) {
        return '  - ' + param.name + '（' + param.type + (param.required ? '，必填' : '') + '）' + (param.desc ? '：' + param.desc : '');
      });
      var effect = typeof def.effect === 'function' ? '［视参数而定］' : def.effect === 'write' ? '［写入］' : def.effect === 'danger' ? '［危险］' : '';
      return '● ' + def.name + ' ' + effect + '\n  ' + def.summary + (params.length ? '\n' + params.join('\n') : '');
    }).join('\n');
  }

  function formatListing(path, listing, offset) {
    var enc = modules.vfsEnc;
    var lines = listing.items.map(function (item) {
      var name = /:\/$/.test(item.name) ? item.name : enc(item.name) + (item.dir ? '/' : '');
      return name + (item.size !== undefined ? '  (' + item.size + ' 字)' : '') + (item.note ? '  — ' + item.note : '');
    });
    var shown = offset + listing.items.length;
    var tail = listing.total > shown ? '\n…共 ' + listing.total + ' 项，已列 ' + (offset + 1) + '–' + shown + '。继续列用 offset=' + shown : '';
    return (lines.join('\n') || '（空）') + tail;
  }

  /*
   * 沙箱里实际执行脚本的函数。它会被 toString() 之后放进沙箱（Worker 或 iframe）里运行，所以不能引用外面的任何变量。
   */
  function sandboxRunner(send, body) {
    var logs = [];
    var fmt = function (value) { try { return typeof value === 'string' ? value : JSON.stringify(value); } catch (error) { return String(value); } };
    console.log = console.info = console.warn = console.error = function () {
      if (logs.length < 200) logs.push(Array.prototype.map.call(arguments, fmt).join(' ').slice(0, 2000));
    };
    (async function () {
      try {
        var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        var result = await new AsyncFunction(body)();
        send({ result: fmt(result === undefined ? null : result), logs: logs });
      } catch (error) {
        send({ error: String(error && error.stack || error), logs: logs });
      }
    })();
  }

  /*
   * 在不带同源权限的沙箱 iframe 里跑一段脚本：碰不到酒馆，适合纯计算、数据处理、验证片段。
   * 沙箱也不能联网：页面带 CSP（default-src 'none'），脚本放进 Worker 里跑——Worker 继承这份 CSP，发不出请求，也没有 location 可跳转。
   * 这样「联网要先问」不会被一段沙箱脚本绕过去。Worker 起不来的浏览器退回在 iframe 里直接跑（CSP 仍拦着 fetch / XHR / WebSocket）。
   */
  function runSandboxed(env, code, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var doc = env.document, host = env.host;
      if (!doc || !host) { reject(new Error('当前环境没有页面，不能运行沙箱脚本')); return; }
      var frame = doc.createElement('iframe');
      var token = 'rj' + Date.now().toString(36) + Math.random().toString(36).slice(2);
      var done = false;
      function finish(error, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        host.removeEventListener('message', onMessage);
        try { frame.remove(); } catch (ignore) { /* already gone */ }
        if (error) reject(error); else resolve(value);
      }
      function onMessage(event) {
        var data = event.data;
        if (!data || data.token !== token || event.source !== frame.contentWindow) return;
        if (data.error) finish(new Error(String(data.error).slice(0, 2000)));
        else finish(null, { result: data.result, logs: data.logs });
      }
      var timer = setTimeout(function () { finish(new Error('脚本超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有结束，已中止')); }, timeoutMs);
      host.addEventListener('message', onMessage);
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.display = 'none';
      var runner = '(' + sandboxRunner.toString() + ')';
      var source = JSON.stringify(String(code));
      var worker = runner + '(function(m){postMessage(m)},' + source + ');';
      var body = 'var token=' + JSON.stringify(token) + ';var reply=function(m){m.token=token;parent.postMessage(m,"*")};'
        + 'var direct=function(){' + runner + '(reply,' + source + ')};'
        + 'try{var got=false;var w=new Worker(URL.createObjectURL(new Blob([' + JSON.stringify(worker) + '],{type:"text/javascript"})));'
        + 'w.onmessage=function(e){got=true;reply(e.data)};w.onerror=function(){if(!got){got=true;try{w.terminate()}catch(x){}direct()}}}catch(e){direct()}';
      frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\' blob:; worker-src blob:; child-src blob:">'
        + '<script>' + body.replace(/<\/script/gi, '<\\/script') + '<\/script>';
      doc.body.appendChild(frame);
    });
  }

  function installCoreTools(registry, deps) {
    var vfs = deps.vfs, env = deps.env;
    var writeScope = function (args) { try { return vfs.scope(args.path, 'write'); } catch (error) { return 'tavern'; } };
    var readScope = function (args) { try { return args.path ? vfs.scope(args.path, 'read') : 'workspace'; } catch (error) { return 'tavern'; } };
    var tool = function (def) { registry.registerTool(Object.assign({ toolset: 'core', source: 'builtin' }, def)); };

    tool({
      name: 'ls', effect: 'read', scope: readScope,
      summary: '列出一个路径下有什么。不带 path 时列出所有挂载点。',
      params: [{ name: 'path', type: 'string', desc: '如 wb:/ 或 wb:/某本书' }, { name: 'offset', type: 'number', desc: '从第几项开始，默认 0' }, { name: 'limit', type: 'number', desc: '最多列几项，默认 100' }],
      run: async function (args) {
        var offset = Math.max(0, Math.trunc(args.offset || 0));
        return formatListing(args.path, await vfs.list(args.path || '', { offset: offset, limit: Math.max(1, Math.min(500, Math.trunc(args.limit || 100))) }), offset);
      }
    });

    tool({
      name: 'read', effect: 'read', scope: readScope,
      summary: '读一个文件，返回带行号的内容（行号后是制表符，不属于原文）。长文件分段读；不知道在哪就先 grep。',
      params: [{ name: 'path', type: 'string', required: true }, { name: 'offset', type: 'number', desc: '起始行，默认 1' }, { name: 'limit', type: 'number', desc: '行数，默认 200' }, { name: 'column', type: 'number', desc: '起始行很长时，从该行第几个字符读起' }],
      run: async function (args, ctx) {
        var out = await vfs.read(args.path, { offset: args.offset, limit: args.limit, column: args.column, cap: ctx && ctx.resultCap ? ctx.resultCap - 400 : 8000 });
        return out.text + (out.more ? '\n' + out.more : '');
      }
    });

    tool({
      name: 'grep', effect: 'read', scope: readScope,
      summary: '在一个文件或整个目录里按正则检索，返回「路径:行号: 内容」。排查大脚本、找某个设定出自哪里，先用它定位再 read。',
      params: [{ name: 'pattern', type: 'string', required: true, desc: '正则表达式' }, { name: 'path', type: 'string', required: true, desc: '文件或目录，如 script:/ 、wb:/某本书 、chat:/' },
        { name: 'flags', type: 'string', desc: '默认 i（忽略大小写）' }, { name: 'context', type: 'number', desc: '每处命中带几行上下文，0–5' }, { name: 'limit', type: 'number', desc: '最多返回几处，默认 40' }],
      run: async function (args, ctx) {
        var out = await vfs.grep(args.path, args.pattern, { flags: args.flags, context: args.context, limit: args.limit, signal: ctx && ctx.signal });
        if (!out.total) return '没有命中（检索了 ' + out.scanned + ' 个文件）。';
        return out.hits.join('\n') + '\n— 共 ' + out.total + ' 处命中，分布在 ' + out.files + ' 个文件' + (out.total > out.hits.length ? '；只列出前 ' + out.hits.length + ' 处，可缩小 path 或换更具体的 pattern' : '');
      }
    });

    tool({
      name: 'edit', effect: 'write', scope: writeScope, paths: function (args) { return [args.path]; },
      summary: '精确替换文件里的一段文字。old 必须和原文完全一致（不带行号）且只出现一次；改动小的时候用它，不要整篇重写。',
      params: [{ name: 'path', type: 'string', required: true }, { name: 'old', type: 'string', required: true, desc: '要被替换的原文' }, { name: 'new', type: 'string', desc: '替换成的内容；留空即删除这段' }, { name: 'all', type: 'boolean', desc: 'true 时替换所有出现处' }],
      describe: function (args) { return '修改 ' + args.path; },
      run: async function (args, ctx) {
        var out = await vfs.edit(args.path, args.old, args.new === undefined ? '' : args.new, args.all === true, ctx && ctx.run);
        return '已修改 ' + out.path + '（替换 ' + out.replaced + ' 处）';
      }
    });

    tool({
      name: 'write', effect: 'write', scope: writeScope, paths: function (args) { return [args.path]; },
      summary: '新建文件，或整篇覆盖已有文件（已有文件优先用 edit）。',
      params: [{ name: 'path', type: 'string', required: true }, { name: 'content', type: 'string', required: true }],
      describe: function (args) { return '写入 ' + args.path; },
      run: async function (args, ctx) {
        var out = await vfs.write(args.path, args.content, ctx && ctx.run);
        return (out.created ? '已新建 ' : '已覆盖 ') + out.path + '（' + out.chars + ' 字）';
      }
    });

    tool({
      name: 'remove', effect: 'danger', scope: writeScope, paths: function (args) { return [args.path]; },
      summary: '删除一个文件（世界书条目、正则、工作区文件），或用 #/指针 删除 JSON 里的一个键。',
      params: [{ name: 'path', type: 'string', required: true }],
      describe: function (args) { return '删除 ' + args.path; },
      run: async function (args, ctx) { return '已删除 ' + (await vfs.remove(args.path, ctx && ctx.run)).path; }
    });

    tool({
      name: 'run_js',
      effect: function (args) { return args.target === 'page' ? 'danger' : 'read'; },
      scope: function (args) { return args.target === 'page' ? 'tavern' : 'workspace'; },
      irreversible: function (args) { return args.target === 'page'; },
      summary: '运行一段 JavaScript 并取回 return 的值与 console 输出。target=sandbox（默认）在隔离沙箱里跑，碰不到酒馆、不能联网、没有 DOM，用来计算、处理数据、验证代码片段；target=page 在酒馆页面里跑，能访问 SillyTavern、TavernHelper 等一切对象，用来检查正在运行的东西。',
      params: [{ name: 'code', type: 'string', required: true, desc: '函数体，可用 await，用 return 给出结果' }, { name: 'target', type: 'string', desc: 'sandbox 或 page' }],
      describe: function (args) { return args.target === 'page' ? '在酒馆页面里运行脚本' : '在沙箱里运行脚本'; },
      run: async function (args) {
        if (args.target === 'page') {
          var fn = new env.host.Function('return (async () => {\n' + args.code + '\n})()');
          var value = await fn();
          if (value === undefined) return '（没有返回值）';
          try { return typeof value === 'string' ? value : JSON.stringify(value, null, 1); } catch (error) { return String(value); }
        }
        var out = await runSandboxed(env, args.code, 15000);
        return '返回：' + out.result + (out.logs && out.logs.length ? '\n输出：\n' + out.logs.join('\n') : '');
      }
    });

    tool({
      name: 'todo', effect: 'read', scope: 'workspace',
      summary: '多步骤的任务先列计划，做完一步更新一次。每次都给出完整清单。',
      params: [{
        name: 'items', type: 'json', required: true, desc: '数组，每项 { "text": 步骤, "status": "pending" | "doing" | "done" }',
        schema: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'doing', 'done'] } }, required: ['text'] } }
      }],
      run: function (args, ctx) {
        var items = (Array.isArray(args.items) ? args.items : []).slice(0, 20).map(function (item) {
          var source = typeof item === 'string' ? { text: item } : item || {};
          return { text: String(source.text || '').slice(0, 200), status: ['pending', 'doing', 'done'].indexOf(source.status) >= 0 ? source.status : 'pending' };
        }).filter(function (item) { return item.text; });
        if (ctx && typeof ctx.setTodos === 'function') ctx.setTodos(items);
        return '计划已更新（' + items.filter(function (item) { return item.status === 'done'; }).length + '/' + items.length + ' 完成）';
      }
    });

    tool({
      name: 'skill', effect: 'read', scope: 'workspace',
      summary: '读取一份知识（见【知识】目录）。碰到相关任务先读，再动手。',
      params: [{ name: 'name', type: 'string', required: true }],
      run: async function (args) {
        var skill = await registry.loadSkill(args.name);
        if (!skill) throw new Error('没有名为 ' + args.name + ' 的知识。可用：' + registry.skills().map(function (item) { return item.name; }).join('、'));
        return String(skill.body || '').trim() + (skill.files ? '\n\n（参考文件在 kb:/' + skill.name + '/ 下，按需 grep / read）' : '');
      }
    });

    tool({
      name: 'toolbox', effect: 'read', scope: 'workspace',
      summary: '打开或关闭一个工具箱（见【工具箱】目录）。打开后会得到里面每个工具的说明，之后就能直接调用。',
      params: [{ name: 'name', type: 'string', required: true }, { name: 'action', type: 'string', desc: 'open（默认）或 close' }],
      run: function (args, ctx) {
        var name = String(args.name).trim();
        var list = registry.tools(name);
        if (!list.length) throw new Error('没有名为 ' + name + ' 的工具箱。可用：' + registry.toolsets().map(function (set) { return set.name; }).join('、'));
        if (args.action === 'close') { if (ctx && ctx.closeToolset) ctx.closeToolset(name); return '已关闭工具箱 ' + name; }
        if (ctx && ctx.openToolset) ctx.openToolset(name);
        return '已打开工具箱 ' + name + '：\n' + manual(list);
      }
    });
  }

  /*
   * 接入旧版的专用工具（reader-agent-tools.js）。世界书 / 变量 / 聊天的读写已由 VFS 原语取代，不再登记；
   * Reader 语义槽、记忆、酒馆助手 API 分别归入 reader / memory / tavern 工具箱。
   */
  function adoptLegacyTools(registry, legacy) {
    var SETS = {
      reader: { summary: 'Reader 自己的状态：FP、状态效果、语义槽适配、打开读者界面', names: ['reader_state', 'host_tree', 'host_write', 'fp_adjust', 'status_add', 'adapt_variables', 'unbind_slot', 'reader_ui'] },
      memory: { summary: '你的记忆（夜之洋）：检索、记下、修改、遗忘、整理', auto: true, names: ['memory_search', 'memory_list', 'memory_save', 'memory_update', 'memory_forget', 'memory_consolidate'] },
      tavern: { summary: '酒馆通用操作：执行斜杠命令、列出与调用酒馆助手的函数', names: ['tavern_api_list', 'tavern_api_call', 'slash_run'] }
    };
    var EFFECT = { read: 'read', memory: 'note', write: 'write', danger: 'danger' };
    Object.keys(SETS).forEach(function (set) {
      registry.registerToolset({ name: set, summary: SETS[set].summary, auto: SETS[set].auto === true, source: 'builtin' });
      SETS[set].names.forEach(function (name) {
        var def = legacy.find(name);
        if (!def) return;
        registry.registerTool({
          name: def.name, toolset: set, summary: def.summary, params: def.params || [], describe: def.describe, run: def.run, source: 'builtin',
          effect: def.tier === 'dynamic' ? function (args) { return EFFECT[legacy.tierFor(def, args)] || 'write'; } : EFFECT[def.tier] || 'write',
          scope: set === 'tavern' ? 'tavern' : 'chat',
          paths: set === 'reader' && def.tier !== 'read' ? function () { return ['var:/message/latest.json']; } : undefined,
          irreversible: set === 'tavern' && def.tier !== 'read'
        });
      });
    });
  }

  modules.createRegistry = createRegistry;
  modules.agentToolManual = manual;
  modules.resolveToolField = resolve;
  modules.installCoreTools = installCoreTools;
  modules.adoptLegacyTools = adoptLegacyTools;
  modules.runSandboxedScript = runSandboxed;
})(typeof globalThis !== 'undefined' ? globalThis : window);
