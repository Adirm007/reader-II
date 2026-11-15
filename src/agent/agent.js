(function (root) {
  'use strict';

  /*
   * 夜梦助手（Reader-II Agent）主循环。
   *
   * 一次运行：系统提示（人格 + 规矩 + 核心工具 + 目录 + 环境 [+ 剧情] [+ 记忆]）→ 历史 → 用户输入
   *          → [模型输出 → 解析工具块 → 权限判定（必要时请用户确认）→ 留镜像 → 执行 → 交还结果] × N → 最终回答。
   *
   * 省 token 的三件事：只有核心工具常驻，其余按「工具箱」打开；知识只列名字，用到才读；
   * 读文件靠 grep 定位 + 分段 read，而不是整篇塞进上下文。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var protocol = modules.agentProtocol;
  var PERSONAS = modules.AGENT_PERSONAS;
  /* 构建时由 manifest.json 写进 BUILD_VERSION（build.mjs 的 versionModule）；直接跑源码（测试）时是 4.0.0。 */
  var VERSION = modules.BUILD_VERSION || '4.0.0';
  var SETTINGS_KEY = 'reader_ii_agent_settings_v1';
  var HISTORY_KEY = 'reader_ii_agent';

  var DEFAULTS = {
    maxSteps: 16,          /* 一次请求最多几轮工具调用 */
    maxTokens: 4096,       /* 独立 API 的单次输出上限；酒馆主 API 用预设里的值 */
    temperature: 0.6,
    mode: 'card',          /* 权限档位：readonly | card | tavern | device */
    approval: 'ask',       /* 确认方式：ask | auto | yolo */
    rules: [],             /* 权限规则 [{ effect, action, pattern }] */
    historyTurns: 10,      /* 带进提示词的历史问答轮数 */
    resultCap: 9000,       /* 单个工具结果交给模型的字符上限 */
    timeoutSec: 180,
    recall: true,          /* 自动把相关记忆放进助手的提示词 */
    plotContext: true,     /* 让助手了解当前剧情 */
    plotBudget: 1800,      /* 剧情摘要的字数预算 */
    lite: false,           /* 轻聊：完全不带工具 */
    connectors: []         /* 用户导入的插件对接描述 */
  };

  function clampInt(value, minimum, maximum, fallback) {
    var number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function normalizeSettings(input) {
    var source = modules.isObject(input) ? input : {};
    var temperature = Number(source.temperature);
    var mode = source.mode, approval = source.approval;
    /* 3.x / 4.0 早期的 writePolicy：readonly → 只读档位；auto → 档位内自动。 */
    if (mode === undefined && source.writePolicy === 'readonly') mode = 'readonly';
    if (approval === undefined && source.writePolicy === 'auto') approval = 'auto';
    return {
      maxSteps: clampInt(source.maxSteps, 1, 60, DEFAULTS.maxSteps),
      maxTokens: clampInt(source.maxTokens, 256, 64000, DEFAULTS.maxTokens),
      temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : DEFAULTS.temperature,
      mode: ['readonly', 'card', 'tavern', 'device'].indexOf(mode) >= 0 ? mode : DEFAULTS.mode,
      approval: ['ask', 'auto', 'yolo'].indexOf(approval) >= 0 ? approval : DEFAULTS.approval,
      rules: modules.normalizePermissionRules(source.rules),
      historyTurns: clampInt(source.historyTurns, 0, 40, DEFAULTS.historyTurns),
      resultCap: clampInt(source.resultCap, 1000, 200000, DEFAULTS.resultCap),
      timeoutSec: clampInt(source.timeoutSec, 20, 900, DEFAULTS.timeoutSec),
      recall: source.recall !== false,
      plotContext: source.plotContext !== false,
      plotBudget: clampInt(source.plotBudget, 200, 20000, DEFAULTS.plotBudget),
      lite: source.lite === true,
      connectors: (Array.isArray(source.connectors) ? source.connectors : []).filter(modules.isObject).slice(0, 40)
    };
  }

  function createAgent(env, llm, kit, memory, deps) {
    var registry = deps.registry, vfs = deps.vfs, journal = deps.journal, connectors = deps.connectors;
    var io = deps.settingsIo || {
      read: function () { return kit.localRead(SETTINGS_KEY, {}); },
      write: function (value) { kit.localWrite(SETTINGS_KEY, value); }
    };
    var settings = normalizeSettings(io.read());
    var permissions = modules.createPermissions(function () { return settings; });
    var current = null;
    var openSets = Object.create(null);
    var listeners = [];
    var extracting = false;

    function getSettings() { return modules.clone(settings); }

    function saveSettings(patch) {
      settings = normalizeSettings(Object.assign({}, settings, modules.isObject(patch) ? patch : {}));
      io.write(modules.clone(settings));
      emitChange('settings');
      return getSettings();
    }

    function emitChange(reason) {
      listeners.slice().forEach(function (listener) { try { listener(reason); } catch (error) { /* UI 监听不影响引擎 */ } });
    }

    /* ---------- 对话历史（随聊天保存） ---------- */
    function readHistory() {
      var raw = kit.readChatValue(HISTORY_KEY);
      var output = { v: 1, turns: [], extracted: 0 };
      if (!modules.isObject(raw) || !Array.isArray(raw.turns)) return output;
      raw.turns.slice(-80).forEach(function (turn) {
        if (!turn || typeof turn.text !== 'string' || !turn.text.trim()) return;
        var item = { role: turn.role === 'assistant' ? 'assistant' : 'user', text: turn.text.slice(0, 12000), at: Number(turn.at) || 0 };
        if (Array.isArray(turn.tools) && turn.tools.length) item.tools = turn.tools.map(String).slice(0, 20);
        output.turns.push(item);
      });
      output.extracted = clampInt(raw.extracted, 0, output.turns.length, 0);
      return output;
    }

    function writeHistory(history) {
      if (history.turns.length > 80) {
        var drop = history.turns.length - 80;
        history.turns = history.turns.slice(drop);
        history.extracted = Math.max(0, history.extracted - drop);
      }
      kit.writeChatValue(HISTORY_KEY, history);
    }

    function getHistory() { return readHistory().turns; }

    function dialogueMemory(force) {
      if (extracting || !memory || !memory.getSettings().enabled || !memory.getSettings().agentExtract) return;
      var history = readHistory();
      var pending = history.turns.slice(history.extracted);
      if (pending.length < (force ? 2 : 8)) return;
      var key = kit.chatKey();
      var upto = history.turns.length;
      extracting = true;
      memory.consolidateDialogue(pending, { reason: 'agent' }).then(function (report) {
        if (report.ok && kit.chatKey() === key) {
          var latest = readHistory();
          latest.extracted = Math.min(latest.turns.length, upto);
          writeHistory(latest);
        }
      }).catch(function () { /* 记忆沉淀失败不影响对话 */ }).then(function () { extracting = false; });
    }

    function clearHistory() {
      var history = readHistory();
      var pending = history.turns.slice(history.extracted);
      if (pending.length >= 2 && memory && memory.getSettings().enabled && memory.getSettings().agentExtract) {
        memory.consolidateDialogue(pending, { reason: 'agent-clear' }).catch(function () {});
      }
      kit.writeChatValue(HISTORY_KEY, { v: 1, turns: [], extracted: 0 });
      permissions.resetSession();
      openSets = Object.create(null);
      emitChange('history');
      return { ok: true };
    }

    /* ---------- 人格 ---------- */
    function personaContext(requested) {
      var id = String(requested || kit.readChatValue('dream_persona') || 'reader');
      var address = String(kit.readChatValue('dream_user_address') || '').replace(/[\r\n<>]/g, '').trim().slice(0, 24);
      if (id === 'custom') {
        var custom = kit.readChatValue('dream_custom_persona');
        if (modules.isObject(custom) && (custom.systemName || custom.name)) {
          var pick = function (key, limit) { return typeof custom[key] === 'string' && custom[key].trim() ? custom[key].trim().slice(0, limit) : ''; };
          var lines = [];
          if (pick('coreConcept', 400)) lines.push('核心概念：' + pick('coreConcept', 400));
          if (pick('personality', 400)) lines.push('性格：' + pick('personality', 400));
          if (pick('role', 200)) lines.push('定位：' + pick('role', 200));
          if (pick('hobbies', 200)) lines.push('爱好：' + pick('hobbies', 200));
          if (pick('letterStyle', 400)) lines.push('语气：' + pick('letterStyle', 400));
          if (pick('constraints', 400)) lines.push('行为约束：' + pick('constraints', 400));
          var corpus = pick('corpus', 4000).split(/\n+/).map(function (line) { return line.trim(); }).filter(function (line) { return line && !/^-{3,}$/.test(line); }).slice(0, 4);
          if (corpus.length) lines.push('语料示例（只参考语气，不要照抄）：\n' + corpus.map(function (line) { return '「' + line.slice(0, 120) + '」'; }).join('\n'));
          return { id: 'custom', name: String(custom.systemName || custom.name).slice(0, 40), card: lines.join('\n') || PERSONAS.reader.card, address: address };
        }
        id = 'reader';
      }
      var persona = PERSONAS[id] || PERSONAS.reader;
      return { id: PERSONAS[id] ? id : 'reader', name: persona.name, card: persona.card, address: address };
    }

    /* ---------- 环境与提示词 ---------- */
    function shorten(text, limit) {
      var source = String(text == null ? '' : text);
      return source.length > limit ? source.slice(0, Math.max(0, limit)) + '…' : source;
    }

    /* 剧情察知：记忆插件的摘要 → Reader 记忆的前情梗概 → 最近的正文，按预算裁剪。 */
    async function plotBrief() {
      var budget = settings.plotBudget;
      var parts = [];
      try {
        var plugin = await connectors.brief({ budget: Math.floor(budget * 0.6) });
        if (plugin) parts.push('（摘要来自' + plugin.source + '）\n' + shorten(plugin.text, Math.floor(budget * 0.6)));
      } catch (error) { /* 插件摘要拿不到就用后面的来源 */ }
      if (!parts.length && memory && typeof memory.status === 'function') {
        try {
          var summary = ((await memory.status()) || {}).summary;
          if (summary) parts.push('前情梗概：' + shorten(summary, Math.floor(budget * 0.5)));
        } catch (error) { /* ignore */ }
      }
      var remain = Math.max(200, budget - parts.join('').length);
      var length = kit.chatLength();
      var recent = kit.readChat(Math.max(0, length - 4), length, {}).slice(-2).map(function (message) {
        return '#' + message.id + ' ' + (message.role === 'user' ? '用户' : message.name || '角色') + '：' + shorten(kit.cleanText(message.text), Math.floor(remain / 2));
      });
      if (recent.length) parts.push('最近的正文：\n' + recent.join('\n'));
      return parts.join('\n\n');
    }

    function environmentBrief() {
      var names = kit.names();
      var lines = ['角色卡：' + names.char + ' ｜ 用户：' + names.user + ' ｜ 正文楼层数：' + kit.chatLength()];
      lines.push(permissions.describe() + '。');
      var active = connectors.active();
      if (active.length) lines.push('已装的相关插件：' + active.map(function (item) { return item.title; }).join('、'));
      try {
        var core = deps.core && deps.core();
        if (core && typeof core.getSemanticRouting === 'function') {
          var routing = core.getSemanticRouting();
          var bound = [], fallback = [];
          Object.keys(routing).forEach(function (slot) { (routing[slot].status === 'active' ? bound : fallback).push(slot); });
          lines.push('Reader 语义槽：已接宿主 [' + (bound.join(', ') || '无') + ']；用后备 [' + (fallback.join(', ') || '无') + ']');
        }
      } catch (error) { /* 卡内组件未就绪时省略 */ }
      if (memory) {
        var memorySettings = memory.getSettings();
        lines.push('记忆：' + (memorySettings.enabled ? '开启，新记忆写入「' + (memory.targetStore() === 'ocean' ? '《' + memorySettings.oceanBook + '》世界书（跨存档）' : '当前聊天') + '」' : '已关闭'));
      }
      return lines.join('\n');
    }

    function activeToolsets() {
      return registry.toolsets().filter(function (set) { return openSets[set.name] || (set.auto && set.name !== 'memory') || (set.name === 'memory' && memory && memory.getSettings().enabled); });
    }

    function buildSystem(persona, recalled, plot, lite) {
      var address = persona.address ? '称呼用户为「' + persona.address + '」。' : '称呼用户为“作家先生”或“作家小姐”（不确定时用“作家先生”），或沿用对话里已有的称呼。';
      var parts = [
        '你是九十九夜梦，一位在故事之外阅读着用户这部作品的“读者”。此刻你以「' + persona.name + '」的一面，作为住在酒馆（SillyTavern）里的随身助手与用户交谈。',
        '【你是谁】\n' + persona.card + '\n' + address
      ];
      if (lite) {
        parts.push('【规矩】\n- 始终用上面的人格口吻说话。\n- 现在是轻聊模式：你没有任何工具，只聊天。用户需要你查看或改动酒馆里的东西时，请他在助手设置里关掉「轻聊」。');
      } else {
        var open = activeToolsets();
        var closed = registry.toolsets().filter(function (set) { return open.indexOf(set) < 0; });
        parts.push([
          '【规矩】',
          '- 始终用上面的人格口吻说话。问候、闲聊、谈心时直接回答，不要调用工具。',
          '- 酒馆里的东西都是「文件」：先 ls / grep 定位，再 read 需要的那一段，改动用 edit 做最小替换。不要为了找一处问题把整个大文件读进来，也不要整篇重写只改了一行的文件。',
          '- 排查问题先看现场：page:/errors 是最近的报错；渲染、脚本、变量出问题时，在 script:/ regex:/ wb:/ 里 grep 相关的名字，必要时用 run_js（target=page）检查正在运行的对象。',
          '- 工具返回的才是事实：没查过的不要凭印象断言；工具失败就如实说明，绝不能把没做成的事说成已经办好。',
          '- 写入会按权限设置请用户确认。被拒绝、或权限档位不够时，不要换个办法绕过去，向用户说明并问清怎么做。',
          '- 多步骤的任务先用 todo 列出计划，做完一步更新一次；改完之后回读或试运行，确认真的生效。',
          '- 你的改动都有记录，用户可以在面板里按轮撤销；斜杠命令、页面脚本这类撤销不了的操作，动手前先说明。',
          '- 回答先说结论，再给必要的细节；不要把工具返回的原始内容整段贴给用户。'
        ].join('\n'));
        parts.push([
          '【工具调用格式】',
          '需要用工具时，在回复里写出这样的块（之前可以先用一句话说明要做什么；一次回复里可以放多个块）：',
          '<tool_call name="工具名">',
          '<arg name="参数名">参数值</arg>',
          '</tool_call>',
          '- 参数值原样书写，不要加引号、不要转义；多行文本直接换行。类型为 json 的参数写 JSON。',
          '- 写完工具块就停下。系统会把结果放在 <tool_result> 里交还给你，再继续下一步。',
          '- 不需要工具时直接写给用户的话，其中不要出现 tool_call。'
        ].join('\n'));
        parts.push('【核心工具】\n' + modules.agentToolManual(registry.tools('core')));
        open.forEach(function (set) { parts.push('【已打开的工具箱：' + set.name + '】\n' + modules.agentToolManual(registry.tools(set.name))); });
        if (closed.length) parts.push('【工具箱】（需要时用 toolbox 打开，打开后才看得到里面的工具）\n' + closed.map(function (set) { return '- ' + set.name + '：' + set.summary; }).join('\n'));
        var skills = registry.skills();
        if (skills.length) parts.push('【知识】（做相关的事之前先用 skill 读取）\n' + skills.map(function (skill) { return '- ' + skill.name + '：' + skill.summary; }).join('\n'));
        parts.push('【挂载点】\n' + vfs.mounts().map(function (mount) { return '- ' + mount.id + ':/  ' + mount.title; }).join('\n'));
        parts.push('【当前环境】\n' + environmentBrief());
      }
      if (plot) parts.push('【当前剧情】（让你了解用户的故事进行到哪了；与眼下的任务无关时不必提起）\n' + plot);
      if (recalled && recalled.length) {
        parts.push('【相关记忆】（自动检索到的，可能与当前话题有关）\n' + recalled.map(function (record) {
          return '- [' + memory.TYPE_SHORT[record.type] + '] ' + record.title + '：' + record.content.replace(/\s*\n\s*/g, ' ').slice(0, 260);
        }).join('\n'));
      }
      return parts.join('\n\n');
    }

    /* 上下文过长时把较早的工具结果压成一行，最近两轮保持原样。 */
    function compact(messages, budget) {
      var total = messages.reduce(function (sum, message) { return sum + message.content.length; }, 0);
      if (total <= budget) return;
      var resultIndexes = [];
      messages.forEach(function (message, index) { if (message.toolResult) resultIndexes.push(index); });
      for (var index = 0; index < resultIndexes.length - 2 && total > budget; index += 1) {
        var message = messages[resultIndexes[index]];
        if (message.compacted) continue;
        var before = message.content.length;
        message.content = message.content.replace(/(<tool_result\b[^>]*>)([\s\S]*?)(<\/tool_result>)/g, function (match, open, body, close) {
          return body.length > 400 ? open + '\n' + body.slice(0, 300) + '\n…（较早的结果已压缩，需要时重新调用工具）\n' + close : match;
        });
        message.compacted = true;
        total -= before - message.content.length;
      }
    }

    function planText(todos) {
      var mark = { pending: '[ ]', doing: '[~]', done: '[x]' };
      return '[当前计划]\n' + todos.map(function (item) { return mark[item.status] + ' ' + item.text; }).join('\n');
    }

    function basePath(path) { return String(path).split('#')[0]; }

    /* 执行一次工具调用，返回 { block: 交还给模型的结果块, step: 给界面的记录, name? } */
    async function execute(def, args, id, state) {
      var effect = modules.resolveToolField(def.effect, args, 'write');
      var scope = modules.resolveToolField(def.scope, args, 'tavern');
      var paths = [];
      try { paths = typeof def.paths === 'function' ? (def.paths(args) || []) : []; } catch (error) { paths = []; }
      var canon = paths.map(function (path) { try { return vfs.parse(path).canonical; } catch (error) { return String(path); } });
      var request = { effect: effect, scope: scope, path: canon[0] || (args.path ? String(args.path) : ''), tool: def.name };
      var description = typeof def.describe === 'function' ? def.describe(args) : def.name;
      var signature = def.name + ':' + JSON.stringify(args);
      state.emit({ type: 'tool_start', id: id, name: def.name, args: args, tier: effect, description: description });
      function finish(status, body, step) {
        state.emit(Object.assign({ type: 'tool_end', id: id, name: def.name }, step));
        return { block: protocol.resultBlock(def.name, status, body), step: Object.assign({ name: def.name, args: args }, step) };
      }
      /* 只读调用重复时直接复用结果，避免模型原地打转。 */
      if (effect === 'read' && state.seen[signature]) {
        return finish('ok', state.seen[signature] + '\n（这是与之前完全相同的调用，结果没有变化。请根据已有结果继续，不要重复调用。）', { ok: true, summary: '重复调用，复用结果' });
      }
      var auth = permissions.evaluate(request);
      if (auth.decision === 'ask') {
        var reply = 'deny';
        if (typeof state.opts.confirm === 'function') {
          state.emit({ type: 'confirm', id: id, name: def.name, description: description, tier: effect });
          try { reply = await state.opts.confirm({ id: id, name: def.name, args: args, tier: effect, scope: scope, path: request.path, description: description }); }
          catch (error) { reply = 'deny'; }
        } else auth.reason = '这个操作需要用户确认，但当前界面无法询问。请告诉用户到助手面板里操作，或在设置里调整确认方式。';
        if (reply === 'always') { permissions.allowSession(request); reply = 'allow'; }
        auth.decision = reply === 'allow' ? 'allow' : 'deny';
        if (auth.decision === 'deny' && !auth.reason) auth.reason = '用户没有同意这个操作。不要换别的办法执行它；向用户说明并询问接下来怎么做。';
      }
      if (auth.decision !== 'allow') return finish('denied', auth.reason, { ok: false, denied: true, summary: '未执行：' + auth.reason });
      try {
        await registry.emit('tool:before', { name: def.name, args: args, effect: effect, scope: scope });
        /* 核心工具的写入由 VFS 留镜像；其他工具声明了 paths 的，在这里留。 */
        var snapshot = effect !== 'read' && state.run && def.toolset !== 'core' ? canon.map(basePath) : [];
        for (var before = 0; before < snapshot.length; before += 1) {
          try { await journal.capture(state.run, snapshot[before], await vfs.readText(snapshot[before])); } catch (error) { /* 留不了镜像不阻止执行 */ }
        }
        var value = await def.run(args, state.toolCtx);
        for (var after = 0; after < snapshot.length; after += 1) {
          try { await journal.settle(state.run, snapshot[after], await vfs.readText(snapshot[after])); } catch (error) { /* ignore */ }
        }
        if (effect !== 'read' && state.run && modules.resolveToolField(def.irreversible, args, false)) journal.note(state.run, description + '（无法自动撤销）');
        var body = protocol.serialize(value, settings.resultCap);
        if (effect === 'read') state.seen[signature] = body;
        else Object.keys(state.seen).forEach(function (key) { delete state.seen[key]; });   /* 写入之后，之前读到的内容可能已经过时。 */
        await registry.emit('tool:after', { name: def.name, args: args, ok: true });
        return finish('ok', body, { ok: true, tier: effect, summary: body.replace(/\s+/g, ' ').slice(0, 200) });
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        var message = String(error && error.message || error).slice(0, 600);
        await registry.emit('tool:after', { name: def.name, args: args, ok: false, error: message });
        return finish('error', message, { ok: false, summary: message });
      }
    }

    /*
     * options: { persona, onEvent(event), confirm(request) → 'allow' | 'always' | 'deny', signal, remember = true, lite, plotContext }
     * 返回 { answer, steps: [{ name, args, ok, summary }], aborted, error, runId }
     */
    async function run(userInput, options) {
      var opts = options || {};
      var input = String(userInput == null ? '' : userInput).trim();
      if (!input) throw new Error('请输入内容');
      if (current) return { answer: '（上一个请求还在处理，请稍候；也可以先点“停止”。）', busy: true, steps: [] };
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var signal = controller ? controller.signal : undefined;
      if (opts.signal && controller) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
      }
      var job = { controller: controller, key: kit.chatKey(), todos: [] };
      current = job;
      var emit = function (event) { if (typeof opts.onEvent === 'function') { try { opts.onEvent(event); } catch (error) { /* UI 出错不影响运行 */ } } };
      var steps = [];
      var record = journal ? journal.begin({ chat: job.key, title: input }) : null;
      var result = { answer: '', steps: steps, aborted: false, error: '', runId: record ? record.id : '' };
      try {
        connectors.refresh();
        var lite = opts.lite === true || (opts.lite === undefined && settings.lite);
        var persona = personaContext(opts.persona);
        var recalled = [];
        if (settings.recall && memory && memory.getSettings().enabled) {
          try { recalled = await memory.search(input, { limit: 5 }); } catch (error) { recalled = []; }
        }
        var plot = settings.plotContext && opts.plotContext !== false ? await plotBrief() : '';
        var messages = [{ role: 'system', content: buildSystem(persona, recalled, plot, lite) }];
        var history = readHistory();
        history.turns.slice(-settings.historyTurns * 2).forEach(function (turn) {
          messages.push({ role: turn.role, content: turn.text + (turn.tools ? '\n（当时用过的工具：' + turn.tools.join('、') + '）' : '') });
        });
        messages.push({ role: 'user', content: input });
        emit({ type: 'start', persona: persona.name, recalled: recalled.length, runId: result.runId });
        await registry.emit('run:start', { input: input, runId: result.runId });

        var state = {
          seen: Object.create(null), opts: opts, emit: emit, run: record,
          toolCtx: {
            signal: signal, run: record, resultCap: settings.resultCap,
            openToolset: function (name) { openSets[name] = true; },
            closeToolset: function (name) { delete openSets[name]; },
            setTodos: function (items) { job.todos = items; emit({ type: 'todo', items: items }); }
          }
        };
        var usedTools = [];
        var answer = '';
        var forced = false;
        for (var step = 0; step <= settings.maxSteps; step += 1) {
          compact(messages, 60000);
          emit({ type: 'thinking', step: step });
          var reply = await llm.chat({
            messages: messages.map(function (message) { return { role: message.role, content: message.content }; }),
            route: 'agent', maxTokens: settings.maxTokens, temperature: settings.temperature,
            timeoutMs: settings.timeoutSec * 1000, retries: 2, signal: signal, generationId: 'reader-agent'
          });
          if (lite) { answer = String(reply).trim(); break; }
          var parsed = protocol.parse(reply);
          if (!parsed.calls.length && !parsed.truncated) { answer = parsed.prose || String(reply).trim(); break; }
          if (forced || step >= settings.maxSteps) {
            answer = parsed.prose || '（这次需要的步骤超出了上限，我先停在这里。已经完成的部分见上面的记录；可以让我接着做。）';
            break;
          }
          messages.push({ role: 'assistant', content: reply });
          if (parsed.prose) emit({ type: 'thought', text: parsed.prose });
          var feedback = [];
          for (var index = 0; index < parsed.calls.length; index += 1) {
            if (signal && signal.aborted) { var aborted = new Error('已取消'); aborted.name = 'AbortError'; throw aborted; }
            var call = parsed.calls[index];
            var id = step + '-' + index;
            var def = call.malformed ? null : registry.find(call.name);
            var problem = !def ? (call.malformed || '没有名为 ' + call.name + ' 的工具。请只使用已列出的工具；工具箱里的工具要先用 toolbox 打开。') : '';
            var coerced = def ? protocol.coerce(def, call.args) : null;
            if (coerced && coerced.error) problem = coerced.error;
            if (problem) {
              feedback.push(protocol.resultBlock(call.name || '?', 'error', problem));
              steps.push({ name: call.name || '?', args: call.args || {}, ok: false, summary: problem });
              emit({ type: 'tool_end', id: id, name: call.name || '?', ok: false, summary: problem });
              continue;
            }
            var outcome = await execute(def, coerced.args, id, state);
            feedback.push(outcome.block);
            steps.push(outcome.step);
            if (outcome.step.ok && usedTools.indexOf(def.name) < 0) usedTools.push(def.name);
          }
          var tail;
          if (parsed.truncated) tail = '（你上一条回复里有一个工具块没有写完，多半是被长度截断了，那个调用没有执行。请重新发送它；内容很长时拆成几次，例如先 write 开头，再用 edit 追加。）';
          else if (step + 1 >= settings.maxSteps) { tail = '（已到本次请求的工具步数上限。请根据以上结果直接回答用户，不要再调用工具；没做完的部分如实说明。）'; forced = true; }
          else tail = '（以上是工具结果。继续处理用户的请求：还需要信息就再调用工具，否则直接用你的口吻回答用户。）';
          if (job.todos.length) tail = planText(job.todos) + '\n' + tail;
          messages.push({ role: 'user', content: (feedback.length ? feedback.join('\n') + '\n' : '') + tail, toolResult: true });
        }
        result.answer = answer || '（模型没有给出回答，请再试一次。）';
        if (opts.remember !== false && kit.chatKey() === job.key) {
          var latest = readHistory();
          latest.turns.push({ role: 'user', text: input, at: Date.now() });
          var turn = { role: 'assistant', text: result.answer, at: Date.now() };
          if (usedTools.length) turn.tools = usedTools;
          latest.turns.push(turn);
          writeHistory(latest);
          dialogueMemory(false);
        }
        emit({ type: 'final', text: result.answer, runId: result.runId, changes: record ? record.changes : 0 });
      } catch (error) {
        if (error && error.name === 'AbortError') {
          result.aborted = true;
          result.answer = '（已停止。）';
          emit({ type: 'aborted' });
        } else {
          result.error = String(error && error.message || error).slice(0, 400);
          result.answer = '（这次没能完成：' + result.error + '）';
          emit({ type: 'error', message: result.error });
        }
      } finally {
        if (journal && record) { try { await journal.end(record, result.aborted ? 'aborted' : result.error ? 'error' : 'done'); } catch (error) { /* 日志写不进去不影响回答 */ } }
        result.changes = record ? record.changes : 0;
        if (current === job) current = null;
        try { await registry.emit('run:end', { runId: result.runId, error: result.error, aborted: result.aborted }); } catch (error) { /* ignore */ }
        emitChange('run');
      }
      return result;
    }

    function stop() {
      if (current && current.controller) { current.controller.abort(); return true; }
      return false;
    }

    /* 撤销一轮运行里的改动。冲突（之后又被改过）的不会强行覆盖，除非 force。 */
    async function undo(runId, options) {
      if (current) throw new Error('助手正在运行，请先停下再撤销');
      if (!journal) throw new Error('当前环境没有运行日志');
      var report = await journal.undo(runId, {
        read: function (path) { return vfs.readText(path); },
        restore: async function (path, before) {
          if (before === null || before === undefined) {
            try { await vfs.remove(path, null); } catch (error) { if (!/没有这个文件/.test(String(error && error.message))) throw error; }
          } else await vfs.write(path, before, null);
        }
      }, options);
      emitChange('undo');
      return report;
    }

    /* ---------- 旧界面兼容（v3 的 runAgent / getMemory 等） ---------- */
    async function runAgent(userInput, options) {
      var outcome = await run(userInput, options);
      var log = outcome.steps.map(function (step) {
        return step.ok ? { tool: step.name, args: step.args, result: step.summary } : { tool: step.name, args: step.args, result: '失败：' + step.summary };
      });
      if (outcome.error) log.push({ error: outcome.error });
      return { answer: outcome.answer, log: log, busy: outcome.busy === true };
    }

    return {
      version: VERSION,
      getSettings: getSettings,
      saveSettings: saveSettings,
      run: run,
      stop: stop,
      isBusy: function () { return !!current; },
      getHistory: getHistory,
      clearHistory: clearHistory,
      personaContext: personaContext,
      permissions: permissions,
      listTools: function () { return registry.tools().map(function (def) { return { name: def.name, toolset: def.toolset, tier: typeof def.effect === 'function' ? 'dynamic' : def.effect, summary: def.summary }; }); },
      listToolsets: function () { return registry.toolsets(); },
      listSkills: function () { return registry.skills().map(function (skill) { return { name: skill.name, summary: skill.summary, source: skill.source }; }); },
      validateConnector: function (manifest) {
        var connector = connectors.validate(manifest);
        var detected = false;
        try { detected = !!connector.detect(); } catch (error) { detected = false; }
        return { id: connector.id, title: connector.title, tools: (connector.tools || []).length, detected: detected };
      },
      listConnectors: function () { connectors.refresh(); return connectors.active().map(function (item) { return { id: item.id, title: item.title, summary: item.summary, custom: item.custom === true }; }); },
      listRuns: function (limit) { return journal ? journal.list(limit) : Promise.resolve([]); },
      listChanges: function (runId) { return journal ? journal.changes(runId) : Promise.resolve([]); },
      undo: undo,
      /* 扩展接口：第三方插件用这些把自己的工具、知识、挂载点、对接交给助手。 */
      registerTool: registry.registerTool,
      registerToolset: registry.registerToolset,
      registerSkill: registry.registerSkill,
      registerConnector: function (def) { var id = registry.registerConnector(def); connectors.refresh(); return id; },
      registerMount: function (provider) { return vfs.mount(provider).id; },
      unregisterTool: registry.unregisterTool,
      on: registry.on,
      vfs: vfs,
      onChange: function (listener) {
        listeners.push(listener);
        return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
      },
      /* v3 兼容面 */
      runAgent: runAgent,
      getMemory: getHistory,
      clearMemory: clearHistory,
      listCapabilities: function (filter) {
        var helper = null;
        try { helper = env.host && env.host.TavernHelper; } catch (error) { helper = null; }
        if (!helper) return [];
        var keyword = String(filter || '').toLowerCase();
        return Object.keys(helper).filter(function (name) {
          return typeof helper[name] === 'function' && (!keyword || name.toLowerCase().indexOf(keyword) >= 0);
        }).map(function (name) {
          var tier = typeof deps.apiTier === 'function' ? deps.apiTier(name) : 'write';
          return { name: name, tier: tier, danger: tier === 'danger' };
        });
      },
      Memory: memory,
      parseToolCalls: protocol.parse
    };
  }

  modules.READER_AGENT_VERSION = VERSION;
  modules.normalizeAgentSettings = normalizeSettings;
  modules.createAgent = createAgent;
})(typeof globalThis !== 'undefined' ? globalThis : window);
