(function (root) {
  'use strict';

  /*
   * 夜梦助手的工具集。
   *
   * 每个工具：{ name, tier, summary, params: [{ name, type, required, desc }], run(args, ctx) }
   * tier：
   *   read    只读，直接执行；
   *   memory  助手自己的记事本（记忆的增改、整理），除“只读模式”外直接执行；
   *   write   改动卡内数据，按写入策略需要用户点头；
   *   danger  难以恢复的操作，始终需要用户点头，且要在设置里放开。
   * 读取类工具都带分页 / 上限参数：结果过长时返回开头并说明如何继续读，而不是把整本书塞进上下文。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var DANGER_API = /^(?:delete|uninstall|replace(?:Variables|TavernRegexes|Worldbook|Preset|ScriptTrees|Scripts)|createOrReplace)/;
  var WRITE_API = /^(?:create|replace|update|delete|insert|set|load|rename|rebind|install|uninstall|reinstall|inject|uninject|trigger|register|unregister|rotate|append|import|play|pause|stop|save|add|remove|refresh|reload|generate|builtin|toggle|switch|format|substitudeMacros)/;
  var SLOT_LABELS = {
    location: '当前地点', characters: '重要角色', tasks: '任务', skills: '用户技能',
    statuses: '用户当前状态', currency: '货币（Reader FP）', inventory: '背包'
  };

  function text(value, limit) {
    var output = String(value == null ? '' : value);
    return limit && output.length > limit ? output.slice(0, limit) + '…（共 ' + output.length + ' 字）' : output;
  }

  function int(value, fallback, minimum, maximum) {
    var number = Math.trunc(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
  }

  function splitPath(path) {
    var output = [];
    String(path || '').replace(/\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|([^.\[\]]+)/g, function (match, index, quoted, plain) {
      if (index !== undefined) output.push(Number(index));
      else if (quoted !== undefined) output.push(quoted.replace(/\\(.)/g, '$1'));
      else output.push(plain);
      return match;
    });
    return output;
  }

  function safeSegments(segments) {
    return segments.every(function (segment) {
      return typeof segment === 'number' || (segment !== '__proto__' && segment !== 'prototype' && segment !== 'constructor');
    });
  }

  function readPath(value, segments) {
    var cursor = value;
    for (var index = 0; index < segments.length; index += 1) {
      if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, segments[index])) return undefined;
      cursor = cursor[segments[index]];
    }
    return cursor;
  }

  function writePath(target, segments, value) {
    var cursor = target;
    for (var index = 0; index < segments.length - 1; index += 1) {
      var key = segments[index];
      if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = typeof segments[index + 1] === 'number' ? [] : {};
      cursor = cursor[key];
    }
    cursor[segments[segments.length - 1]] = value;
  }

  function deletePath(target, segments) {
    var parent = readPath(target, segments.slice(0, -1));
    var key = segments[segments.length - 1];
    if (!parent || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, key)) return false;
    if (Array.isArray(parent) && typeof key === 'number') parent.splice(key, 1);
    else delete parent[key];
    return true;
  }

  function createAgentTools(env, kit, deps) {
    var api = function () { return deps.core ? deps.core() : null; };
    var memory = deps.memory;
    var skills = [];

    function core() {
      var value = api();
      if (!value) throw new Error('Reader-II 主系统尚未就绪');
      return value;
    }

    function helper() {
      try { return env.host && env.host.TavernHelper || root.TavernHelper || null; } catch (error) { return null; }
    }

    function entrySummary(entry) {
      var strategy = entry.strategy || {};
      return {
        uid: entry.uid,
        name: String(entry.name || ''),
        enabled: entry.enabled !== false,
        mode: strategy.type === 'constant' ? '常驻' : strategy.type === 'vectorized' ? '向量' : '关键词',
        keys: (Array.isArray(strategy.keys) ? strategy.keys : []).map(String).slice(0, 12),
        length: String(entry.content || '').length
      };
    }

    function requireBook(args) {
      var book = String(args.book || '').trim();
      if (!book) throw new Error('需要 book（世界书名）');
      var names = kit.worldbookNames();
      if (names.length && names.indexOf(book) < 0) {
        var loose = names.filter(function (name) { return name.indexOf(book) >= 0 || book.indexOf(name) >= 0; });
        if (loose.length === 1) return loose[0];
        throw new Error('没有名为「' + book + '」的世界书。现有：' + names.slice(0, 40).join('、'));
      }
      return book;
    }

    var tools = [];
    function tool(definition) { tools.push(definition); }

    /* ---------- 总览 ---------- */
    tool({
      name: 'reader_state', tier: 'read',
      summary: '查看 Reader-II 的当前状态：七个语义槽各自绑定到哪里、地点、FP 余额、主角状态与技能、任务、重要角色、背包、当前人格。',
      params: [],
      run: async function () {
        var reader = core();
        var output = { routing: {} };
        if (typeof reader.isEnabled === 'function') output.readerEnabled = reader.isEnabled();
        if (output.readerEnabled === false) output.note = '当前角色卡尚未启用 Reader-II，所列后备值来自休眠状态。可在助手「设置 → 这张卡」启用。';
        var read = async function (key, getter) {
          try { output[key] = await getter(); } catch (error) { output[key] = '读取失败：' + String(error && error.message || error).slice(0, 120); }
        };
        await read('location', function () { return reader.getLocation(); });
        await read('fp', function () { return reader.getFpBalance(); });
        await read('statuses', function () { return reader.listStatuses(); });
        await read('tasks', function () { return reader.listTaskNames(); });
        await read('skills', function () { return reader.listSkillNames(); });
        await read('characters', async function () {
          return (await reader.listImportantCharacters()).map(function (item) {
            return { name: item.name, favor: item.favor, present: item.present, identity: item.identity };
          }).slice(0, 60);
        });
        if (typeof reader.listInventory === 'function') await read('inventory', async function () {
          return (await reader.listInventory()).map(function (item) { return { name: item.name, count: item.count, quality: item.quality, type: item.type }; }).slice(0, 80);
        });
        /* 读取槽值时会发现失效的映射，最后取路由才能报告本轮复核后的状态。 */
        var routing = reader.getSemanticRouting();
        Object.keys(routing).forEach(function (slot) {
          var route = routing[slot];
          output.routing[slot] = {
            label: SLOT_LABELS[slot] || slot,
            status: route.status,
            target: route.rootRef ? modules.readerHostDisplayPath(route.rootRef) : 'Reader 后备变量'
          };
          if (route.brokenReason) output.routing[slot].reason = route.brokenReason;
        });
        var names = kit.names();
        output.card = names.char;
        output.user = names.user;
        output.persona = kit.readChatValue('dream_persona') || 'reader';
        return output;
      }
    });

    /* ---------- 聊天 ---------- */
    tool({
      name: 'chat_read', tier: 'read',
      summary: '读取正文聊天的楼层。默认读最近 6 楼；也可指定 from / to（楼层号，含 from 不含 to）。',
      params: [
        { name: 'last', type: 'number', desc: '读最近几楼（默认 6，最多 40）' },
        { name: 'from', type: 'number', desc: '起始楼层号' },
        { name: 'to', type: 'number', desc: '结束楼层号（不含）' },
        { name: 'max_chars', type: 'number', desc: '每楼最多返回多少字（默认 1200）' }
      ],
      run: async function (args) {
        var length = kit.chatLength();
        var from, to;
        if (args.from !== undefined || args.to !== undefined) {
          from = int(args.from, 0, 0, length);
          to = int(args.to, Math.min(length, from + 6), from, length);
          if (to - from > 40) to = from + 40;
        } else {
          to = length;
          from = Math.max(0, length - int(args.last, 6, 1, 40));
        }
        var cap = int(args.max_chars, 1200, 100, 20000);
        return {
          total_messages: length,
          messages: kit.readChat(from, to).map(function (message) {
            return { id: message.id, role: message.role, name: message.name, text: text(kit.cleanText(message.text), cap) };
          })
        };
      }
    });

    tool({
      name: 'chat_search', tier: 'read',
      summary: '在整个正文聊天里按字面搜索，返回命中的楼层与上下文片段。',
      params: [
        { name: 'query', type: 'string', required: true, desc: '要找的词或短句' },
        { name: 'limit', type: 'number', desc: '最多返回几条（默认 8）' }
      ],
      run: async function (args) {
        var query = String(args.query || '').trim().toLowerCase();
        if (!query) throw new Error('需要 query');
        var limit = int(args.limit, 8, 1, 30);
        var hits = [];
        var messages = kit.readChat(0, kit.chatLength());
        for (var index = messages.length - 1; index >= 0 && hits.length < limit; index -= 1) {
          var clean = kit.cleanText(messages[index].text);
          var at = clean.toLowerCase().indexOf(query);
          if (at < 0) continue;
          hits.push({ id: messages[index].id, role: messages[index].role, name: messages[index].name, snippet: clean.slice(Math.max(0, at - 80), at + query.length + 160) });
        }
        return { query: args.query, hits: hits, note: hits.length ? '' : '没有命中；可以换个词，或用 chat_read 直接翻看' };
      }
    });

    /* ---------- 变量 ---------- */
    tool({
      name: 'variables_read', tier: 'read',
      summary: '读取酒馆变量。scope：message（最新楼层变量，MVU 的 stat_data 在这里）、chat（聊天变量）、global、character。可给 path 只取一部分。',
      params: [
        { name: 'scope', type: 'string', desc: 'message | chat | global | character，默认 message' },
        { name: 'path', type: 'string', desc: '点号路径，如 stat_data.主角；留空返回顶层键' },
        { name: 'depth', type: 'number', desc: '展开层数（默认 3）' }
      ],
      run: async function (args) {
        var scope = ['message', 'chat', 'global', 'character'].indexOf(args.scope) >= 0 ? args.scope : 'message';
        var option = scope === 'message' ? { type: 'message', message_id: 'latest' } : { type: scope };
        var variables = kit.need('getVariables')(option) || {};
        var segments = splitPath(args.path);
        var value = segments.length ? readPath(variables, segments) : variables;
        if (value === undefined) return { scope: scope, path: args.path || '', exists: false, top_keys: Object.keys(variables).slice(0, 80) };
        return { scope: scope, path: args.path || '', exists: true, value: modules.readerOutlineValue(value, 0, int(args.depth, 3, 1, 8)) };
      }
    });

    tool({
      name: 'variables_write', tier: 'write',
      summary: '写入或删除一个酒馆变量。宿主 MVU 变量（stat_data 之下）请改用 host_write，它带类型检查。',
      params: [
        { name: 'scope', type: 'string', required: true, desc: 'message | chat | global | character' },
        { name: 'path', type: 'string', required: true, desc: '点号路径' },
        { name: 'value', type: 'json', desc: '要写入的值（JSON）；op=delete 时不需要' },
        { name: 'op', type: 'string', desc: 'set（默认）或 delete' }
      ],
      describe: function (args) { return (args.op === 'delete' ? '删除' : '写入') + ' ' + (args.scope || '') + ' 变量 ' + (args.path || ''); },
      run: async function (args) {
        var scope = ['message', 'chat', 'global', 'character'].indexOf(args.scope) >= 0 ? args.scope : '';
        if (!scope) throw new Error('scope 只能是 message / chat / global / character');
        var segments = splitPath(args.path);
        if (!segments.length || !safeSegments(segments)) throw new Error('path 无效');
        if (/^reader_ii_/.test(String(segments[0]))) throw new Error('reader_ii_ 开头的是 Reader-II 的内部状态，不能直接改写');
        var remove = args.op === 'delete';
        if (!remove && args.value === undefined) throw new Error('需要 value');
        var option = scope === 'message' ? { type: 'message', message_id: 'latest' } : { type: scope };
        var changed = false;
        await kit.need('updateVariablesWith')(function (variables) {
          var next = variables && typeof variables === 'object' ? variables : {};
          if (remove) changed = deletePath(next, segments);
          else { writePath(next, segments, modules.clone(args.value)); changed = true; }
          return next;
        }, option);
        var verify = readPath(kit.need('getVariables')(option) || {}, segments);
        return { ok: true, changed: changed, now: remove ? (verify === undefined ? '已不存在' : '仍然存在') : modules.readerOutlineValue(verify, 0, 2) };
      }
    });

    tool({
      name: 'host_tree', tier: 'read',
      summary: '浏览宿主角色卡的 MVU 变量（stat_data）。留空看顶层结构；给 path 看某个分支。',
      params: [
        { name: 'path', type: 'string', desc: 'stat_data 之下的点号路径，如 主角.背包' },
        { name: 'depth', type: 'number', desc: '展开层数（默认 3）' }
      ],
      run: async function (args) {
        var snapshot = await core().getSnapshot();
        var stat = snapshot && snapshot.stat_data || {};
        var segments = splitPath(String(args.path || '').replace(/^stat_data\.?/, ''));
        var value = segments.length ? readPath(stat, segments) : stat;
        if (value === undefined) return { exists: false, top_keys: Object.keys(stat) };
        return { path: 'stat_data' + (segments.length ? '.' + segments.join('.') : ''), value: modules.readerOutlineValue(value, 0, int(args.depth, 3, 1, 8)) };
      }
    });

    tool({
      name: 'host_write', tier: 'write',
      summary: '改写一个宿主 MVU 变量（带类型检查）。op：set 设为、delta 数值增减、toggle 真假切换、merge 合并对象字段、append 向数组追加、remove_value 从数组移除、remove 删除该字段。',
      params: [
        { name: 'path', type: 'string', required: true, desc: '完整路径，如 stat_data.主角.金币' },
        { name: 'op', type: 'string', required: true, desc: 'set | delta | toggle | merge | append | remove_value | remove' },
        { name: 'value', type: 'json', desc: '操作数（JSON）' }
      ],
      describe: function (args) { return '宿主变量 ' + (args.path || '') + ' 执行 ' + (args.op || 'set') + (args.value !== undefined ? ' ' + text(JSON.stringify(args.value), 120) : ''); },
      run: async function (args) {
        var path = String(args.path || '').trim();
        if (path.indexOf('stat_data') !== 0) path = 'stat_data.' + path;
        var segments = splitPath(path);
        if (segments.length < 2 || !safeSegments(segments)) throw new Error('path 无效');
        if (segments[1] === 'READER') throw new Error('READER 之下是 Reader 的后备变量：FP 用 fp_adjust，状态用 status_add');
        var result = await core().writeHostRef(segments, String(args.op || 'set'), args.value);
        return { ok: true, path: path, now: modules.readerOutlineValue(result, 0, 2) };
      }
    });

    /* ---------- Reader 语义层 ---------- */
    tool({
      name: 'fp_adjust', tier: 'write',
      summary: '增减命运点数（Reader FP；绑定了宿主货币时改的就是宿主货币）。amount 为正是发放，为负是扣除。',
      params: [
        { name: 'amount', type: 'number', required: true, desc: '变动量（非零整数）' },
        { name: 'reason', type: 'string', desc: '原因备注' }
      ],
      describe: function (args) { return (Number(args.amount) >= 0 ? '发放 ' : '扣除 ') + Math.abs(Math.trunc(Number(args.amount) || 0)) + ' FP' + (args.reason ? '（' + args.reason + '）' : ''); },
      run: async function (args) {
        var amount = Math.trunc(Number(args.amount));
        if (!Number.isFinite(amount) || amount === 0) throw new Error('amount 必须是非零整数');
        var reason = 'agent:' + text(args.reason || 'adjust', 60);
        var result = amount > 0 ? await core().creditFp(amount, reason) : await core().spendFp(Math.abs(amount), reason);
        return { ok: true, balance: result.balance };
      }
    });

    tool({
      name: 'status_add', tier: 'write',
      summary: '给主角添加一个状态效果（已有同名状态时不重复添加）。',
      params: [
        { name: 'name', type: 'string', required: true, desc: '状态名' },
        { name: 'effect', type: 'string', required: true, desc: '效果描述' },
        { name: 'duration', type: 'string', required: true, desc: '持续时间，如 “3天”“永久”' },
        { name: 'source', type: 'string', desc: '来源' }
      ],
      describe: function (args) { return '添加状态「' + (args.name || '') + '」：' + text(args.effect, 80); },
      run: async function (args) {
        var result = await core().insertStatusIfAbsent({ name: String(args.name || ''), effect: String(args.effect || ''), duration: String(args.duration || ''), source: String(args.source || '九十九夜梦') });
        return { ok: true, inserted: result.inserted === true, note: result.inserted ? '' : '已有同名状态，没有重复添加' };
      }
    });

    tool({
      name: 'adapt_variables', tier: 'write',
      summary: '自动适配当前卡的七个语义槽。已查明准确路径时可用 roots 定向绑定或修正已启用的槽；失败保留原绑定。按槽返回结果，再用 reader_state 回读。',
      params: [
        { name: 'use_llm', type: 'boolean', desc: '是否用一次模型调用做语义寻路（默认 true；false 只用结构启发式）' },
        { name: 'slots', type: 'json', desc: '只处理这些槽；省略时处理 roots 中的槽或自动发现七槽', schema: { type: 'array', items: { type: 'string', enum: Object.keys(SLOT_LABELS) }, minItems: 1 } },
        { name: 'roots', type: 'json', desc: '已核实的槽名与路径段数组，如 {"inventory":["人物","背包","道具"]}；可省略开头的 stat_data，路径段中的点号按字面处理', schema: { type: 'object', additionalProperties: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] }, minItems: 1 } } },
        { name: 'mappings', type: 'json', desc: '按槽提供已核对的容器 DSL，用于自动识别不足时；每项须在 roots 指定根，字段来自真实数据或此卡变量更新规则', schema: { type: 'object', additionalProperties: { type: 'object' } } }
      ],
      describe: function (args) {
        if (!modules.isObject(args.roots)) return '自动寻找并绑定' + (Array.isArray(args.slots) ? args.slots.map(function (slot) { return SLOT_LABELS[slot] || slot; }).join('、') : '当前卡语义槽');
        return '按指定路径绑定：' + Object.keys(args.roots).map(function (slot) {
          return (SLOT_LABELS[slot] || slot) + ' → ' + JSON.stringify(args.roots[slot]);
        }).join('，');
      },
      run: async function (args, ctx) {
        var reader = core();
        if (typeof reader.autoAdapt !== 'function') throw new Error('当前主系统版本不支持一键适配，请在 Reader Core 面板手动绑定');
        if (args.slots !== undefined && (!Array.isArray(args.slots) || !args.slots.length || args.slots.some(function (slot) { return !Object.prototype.hasOwnProperty.call(SLOT_LABELS, slot); }))) throw new Error('slots 需要非空的语义槽名数组：' + Object.keys(SLOT_LABELS).join(', '));
        if (args.roots !== undefined && (!modules.isObject(args.roots) || !Object.keys(args.roots).length)) throw new Error('roots 需要按槽名指定至少一个路径段数组');
        if (args.mappings !== undefined && (!modules.isObject(args.mappings) || Object.keys(args.mappings).some(function (slot) {
          return !args.roots || !Object.prototype.hasOwnProperty.call(args.roots, slot);
        }))) throw new Error('mappings 中的每个槽都需要一个明确的 roots 路径');
        return reader.autoAdapt({ useLlm: args.use_llm !== false, slots: args.slots, roots: args.roots, mappings: args.mappings, signal: ctx && ctx.signal, canReadRule: ctx && ctx.canReadRule });
      }
    });

    tool({
      name: 'unbind_slot', tier: 'write',
      summary: '解除一个语义槽的宿主绑定，改回 Reader 后备变量。',
      params: [{ name: 'slot', type: 'string', required: true, desc: 'location | characters | tasks | skills | statuses | currency | inventory' }],
      describe: function (args) { return '解除「' + (SLOT_LABELS[args.slot] || args.slot) + '」的宿主绑定'; },
      run: async function (args) {
        var route = await core().unbindSemanticSlot(String(args.slot || ''));
        return { ok: true, status: route.status };
      }
    });

    /* ---------- 世界书 ---------- */
    tool({
      name: 'worldbook_list', tier: 'read',
      summary: '列出世界书：全部书名，以及哪些是全局启用、当前角色卡绑定、当前聊天绑定的。',
      params: [],
      run: async function () { return kit.worldbookScopes(); }
    });

    tool({
      name: 'worldbook_entries', tier: 'read',
      summary: '列出一本世界书的条目（名称、是否启用、触发方式、关键词、长度）。改动前先用它确认真实条目名。',
      params: [
        { name: 'book', type: 'string', required: true, desc: '世界书名' },
        { name: 'filter', type: 'string', desc: '只列名称或关键词里含这个词的条目' },
        { name: 'offset', type: 'number', desc: '从第几条开始（默认 0）' },
        { name: 'limit', type: 'number', desc: '最多列几条（默认 60）' }
      ],
      run: async function (args) {
        var book = requireBook(args);
        var entries = await kit.readWorldbook(book);
        var filter = String(args.filter || '').trim().toLowerCase();
        var matched = entries.map(entrySummary).filter(function (entry) {
          return !filter || (entry.name + ' ' + entry.keys.join(' ')).toLowerCase().indexOf(filter) >= 0;
        });
        var offset = int(args.offset, 0, 0, matched.length);
        var limit = int(args.limit, 60, 1, 200);
        return { book: book, total: matched.length, offset: offset, entries: matched.slice(offset, offset + limit), more: offset + limit < matched.length ? '还有 ' + (matched.length - offset - limit) + ' 条，增大 offset 继续' : '' };
      }
    });

    tool({
      name: 'worldbook_read', tier: 'read',
      summary: '读取一个世界书条目的全文与设置。条目很长时用 offset 分段读。',
      params: [
        { name: 'book', type: 'string', required: true, desc: '世界书名' },
        { name: 'entry', type: 'string', required: true, desc: '条目名（可只写一部分）或 uid' },
        { name: 'offset', type: 'number', desc: '从正文第几个字开始（默认 0）' },
        { name: 'max_chars', type: 'number', desc: '最多返回多少字（默认 6000）' }
      ],
      run: async function (args) {
        var book = requireBook(args);
        var entries = await kit.readWorldbook(book);
        var entry = kit.findEntry(entries, args.entry);
        if (!entry) return { found: false, note: '没有这个条目', similar: entries.map(function (item) { return String(item.name || ''); }).filter(Boolean).slice(0, 40) };
        var content = String(entry.content || '');
        var offset = int(args.offset, 0, 0, content.length);
        var cap = int(args.max_chars, 6000, 200, 60000);
        var summary = entrySummary(entry);
        summary.position = entry.position;
        summary.probability = entry.probability;
        return { found: true, book: book, entry: summary, offset: offset, content: content.slice(offset, offset + cap), more: offset + cap < content.length ? '正文共 ' + content.length + ' 字，offset=' + (offset + cap) + ' 继续读' : '' };
      }
    });

    tool({
      name: 'worldbook_search', tier: 'read',
      summary: '在世界书正文里按字面搜索。不给 books 时搜索当前生效的书（全局 + 角色卡 + 聊天）。',
      params: [
        { name: 'query', type: 'string', required: true, desc: '要找的词' },
        { name: 'books', type: 'json', desc: '要搜索的书名数组（可省略）' },
        { name: 'limit', type: 'number', desc: '最多返回几条（默认 10）' }
      ],
      run: async function (args) {
        var query = String(args.query || '').trim().toLowerCase();
        if (!query) throw new Error('需要 query');
        var scopes = kit.worldbookScopes();
        var books = Array.isArray(args.books) && args.books.length ? args.books.map(String)
          : scopes.global.concat(scopes.character_primary ? [scopes.character_primary] : [], scopes.character_additional, scopes.chat ? [scopes.chat] : []);
        var seen = Object.create(null);
        var limit = int(args.limit, 10, 1, 40);
        var hits = [];
        for (var index = 0; index < books.length && hits.length < limit; index += 1) {
          var name = books[index];
          if (seen[name]) continue;
          seen[name] = true;
          var entries;
          try { entries = await kit.readWorldbook(name); } catch (error) { continue; }
          for (var entryIndex = 0; entryIndex < entries.length && hits.length < limit; entryIndex += 1) {
            var entry = entries[entryIndex];
            var haystack = String(entry.name || '') + '\n' + String(entry.content || '');
            var at = haystack.toLowerCase().indexOf(query);
            if (at < 0) continue;
            hits.push({ book: name, entry: String(entry.name || ''), uid: entry.uid, snippet: haystack.slice(Math.max(0, at - 60), at + query.length + 140) });
          }
        }
        return { query: args.query, searched: Object.keys(seen), hits: hits };
      }
    });

    tool({
      name: 'worldbook_write', tier: 'write',
      summary: '新建或修改一个世界书条目。条目已存在则只改你给出的字段；不存在则新建（需要 content）。append 是在原文末尾追加而不是替换。写完会回读确认。',
      params: [
        { name: 'book', type: 'string', required: true, desc: '世界书名' },
        { name: 'entry', type: 'string', required: true, desc: '条目名（修改已有条目时可只写一部分）' },
        { name: 'content', type: 'string', desc: '条目全文（替换原文）' },
        { name: 'append', type: 'string', desc: '追加到原文末尾的内容（与 content 二选一）' },
        { name: 'keys', type: 'json', desc: '关键词数组' },
        { name: 'constant', type: 'boolean', desc: 'true=常驻（蓝灯），false=关键词触发（绿灯）' },
        { name: 'enabled', type: 'boolean', desc: '是否启用' },
        { name: 'depth', type: 'number', desc: '设为按深度插入时的深度' },
        { name: 'order', type: 'number', desc: '插入顺序' },
        { name: 'rename', type: 'string', desc: '改名为' }
      ],
      describe: function (args) {
        return '世界书《' + (args.book || '') + '》条目「' + (args.entry || '') + '」：' + (args.content !== undefined ? '写入全文 ' + String(args.content).length + ' 字' : args.append !== undefined ? '追加 ' + String(args.append).length + ' 字' : '修改设置');
      },
      run: async function (args) {
        var book = requireBook(args);
        var target = String(args.entry || '').trim();
        if (!target) throw new Error('需要 entry（条目名）');
        var existing = kit.findEntry(await kit.readWorldbook(book), target);
        var apply = function (entry) {
          if (typeof args.content === 'string') entry.content = args.content;
          else if (typeof args.append === 'string') entry.content = String(entry.content || '') + (entry.content ? '\n' : '') + args.append;
          if (typeof args.enabled === 'boolean') entry.enabled = args.enabled;
          if (typeof args.rename === 'string' && args.rename.trim()) entry.name = args.rename.trim();
          entry.strategy = modules.isObject(entry.strategy) ? entry.strategy : { type: 'selective', keys: [] };
          if (Array.isArray(args.keys)) entry.strategy.keys = args.keys.map(String).filter(Boolean);
          if (typeof args.constant === 'boolean') entry.strategy.type = args.constant ? 'constant' : 'selective';
          if (args.depth !== undefined || args.order !== undefined) {
            entry.position = modules.isObject(entry.position) ? entry.position : { type: 'at_depth', role: 'system', depth: 4, order: 100 };
            if (args.depth !== undefined) { entry.position.type = 'at_depth'; entry.position.depth = int(args.depth, 4, 0, 999); if (!entry.position.role) entry.position.role = 'system'; }
            if (args.order !== undefined) entry.position.order = int(args.order, 100, -10000, 100000);
          }
          return entry;
        };
        var finalName;
        if (existing) {
          var uid = existing.uid;
          await kit.updateWorldbook(book, function (entries) {
            entries.forEach(function (entry) { if (entry.uid === uid) apply(entry); });
            return entries;
          });
          finalName = typeof args.rename === 'string' && args.rename.trim() ? args.rename.trim() : String(existing.name || '');
        } else {
          if (typeof args.content !== 'string' && typeof args.append !== 'string') throw new Error('没有名为「' + target + '」的条目；新建条目需要 content');
          var made = await kit.addWorldbookEntries(book, [apply({ name: target, content: '', enabled: true, strategy: { type: 'selective', keys: [] } })]);
          finalName = String(made[0] && made[0].name || target);
        }
        /* 回读确认：读得到才算写成功。 */
        var verify = kit.findEntry(await kit.readWorldbook(book), finalName);
        if (!verify) throw new Error('写入后回读不到条目「' + finalName + '」，写入可能没有生效');
        return { ok: true, action: existing ? 'updated' : 'created', book: book, entry: entrySummary(verify), verified: true };
      }
    });

    tool({
      name: 'worldbook_delete_entry', tier: 'danger',
      summary: '删除一个世界书条目（不可恢复）。删除前先用 worldbook_read 确认内容。',
      params: [
        { name: 'book', type: 'string', required: true, desc: '世界书名' },
        { name: 'entry', type: 'string', required: true, desc: '条目的完整名称或 uid' }
      ],
      describe: function (args) { return '删除世界书《' + (args.book || '') + '》的条目「' + (args.entry || '') + '」（不可恢复）'; },
      run: async function (args) {
        var book = requireBook(args);
        var entries = await kit.readWorldbook(book);
        var target = String(args.entry || '').trim();
        var exact = entries.filter(function (entry) { return String(entry.name || '') === target || String(entry.uid) === target; });
        if (exact.length !== 1) throw new Error(exact.length ? '有 ' + exact.length + ' 个同名条目，请改用 uid 指定' : '删除需要完整的条目名或 uid；没有找到「' + target + '」');
        var uid = exact[0].uid;
        await kit.updateWorldbook(book, function (list) { return list.filter(function (entry) { return entry.uid !== uid; }); });
        var left = (await kit.readWorldbook(book)).some(function (entry) { return entry.uid === uid; });
        if (left) throw new Error('删除后条目仍然存在');
        return { ok: true, deleted: String(exact[0].name || ''), book: book };
      }
    });

    tool({
      name: 'worldbook_create', tier: 'write',
      summary: '新建一本空世界书，并按 mount 决定是否挂载。',
      params: [
        { name: 'name', type: 'string', required: true, desc: '世界书名' },
        { name: 'mount', type: 'string', desc: 'global 全局启用 | character 绑到当前角色卡 | none 只创建（默认）' }
      ],
      describe: function (args) { return '新建世界书《' + (args.name || '') + '》' + (args.mount && args.mount !== 'none' ? '并挂载到 ' + args.mount : ''); },
      run: async function (args) {
        var name = String(args.name || '').trim();
        if (!name) throw new Error('需要 name');
        var created = await kit.createWorldbook(name);
        var mount = ['global', 'character'].indexOf(args.mount) >= 0 ? args.mount : 'none';
        if (mount !== 'none') await kit.mountWorldbook(name, mount);
        return { ok: true, name: name, created: created, note: created ? '' : '同名世界书已存在，没有重复创建', mounted: mount };
      }
    });

    /* ---------- 记忆 ---------- */
    var memoryView = function (record, full) {
      return {
        id: record.id, type: record.type, title: record.title,
        content: full ? record.content : text(record.content, 160),
        keys: record.keys, importance: record.importance, pinned: record.pinned,
        store: record.store === 'ocean' ? '夜之洋' : '当前聊天', owner: record.owner === 'agent' ? 'agent 助手自己的' : 'story 正文的', score: record.score
      };
    };

    tool({
      name: 'memory_search', tier: 'read',
      summary: '在记忆库里检索与一句话相关的记忆（当前聊天的记忆与《夜之洋》一起找）。用户问“还记得吗 / 上次 / 之前”时先用它。',
      params: [
        { name: 'query', type: 'string', required: true, desc: '检索词或短句' },
        { name: 'limit', type: 'number', desc: '最多返回几条（默认 6）' },
        { name: 'type', type: 'string', desc: '只找某一类：episode 剧情 | fact 设定 | bond 情感 | howto 功能' }
      ],
      run: async function (args) {
        var hits = await memory.search(String(args.query || ''), { limit: int(args.limit, 6, 1, 20), type: args.type || undefined });
        return { query: args.query, hits: hits.map(function (record) { return memoryView(record, true); }), note: hits.length ? '' : '没有相关记忆' };
      }
    });

    tool({
      name: 'memory_list', tier: 'read',
      summary: '列出记忆（最近更新的在前）。',
      params: [
        { name: 'type', type: 'string', desc: 'episode | fact | bond | howto' },
        { name: 'store', type: 'string', desc: 'chat 当前聊天 | ocean 夜之洋；留空两边都列' },
        { name: 'limit', type: 'number', desc: '最多列几条（默认 30）' }
      ],
      run: async function (args) {
        var all = await memory.list({ type: args.type || undefined, store: args.store === 'chat' || args.store === 'ocean' ? args.store : undefined });
        var limit = int(args.limit, 30, 1, 200);
        return { total: all.length, memories: all.slice(0, limit).map(function (record) { return memoryView(record, false); }) };
      }
    });

    tool({
      name: 'memory_save', tier: 'memory',
      summary: '记下一条记忆。type：episode 剧情 / fact 设定 / bond 情感 / howto 功能。store 留空就写到用户选定的位置；用户明确说“记到夜之洋 / 跨存档”用 ocean，说“只记在这个聊天”用 chat。owner 默认 agent（你自己的经历、用户偏好、做法，正文里的夜梦默认想不起来）；用户要你记的是剧情或设定、要正文也记得时用 story。',
      params: [
        { name: 'type', type: 'string', required: true, desc: 'episode | fact | bond | howto' },
        { name: 'title', type: 'string', required: true, desc: '不超过 18 字的标题' },
        { name: 'content', type: 'string', required: true, desc: '独立成文的正文（40～220 字为宜）' },
        { name: 'keys', type: 'json', desc: '2～5 个触发词（数组）' },
        { name: 'importance', type: 'number', desc: '1～5' },
        { name: 'store', type: 'string', desc: 'chat | ocean（可省略）' },
        { name: 'pinned', type: 'boolean', desc: 'true=常驻，每轮都带上' },
        { name: 'owner', type: 'string', desc: 'agent（默认）| story' }
      ],
      run: async function (args) {
        var record = await memory.add({ type: args.type, title: args.title, content: args.content, keys: args.keys, importance: args.importance, pinned: args.pinned === true, source: 'agent', owner: args.owner === 'story' ? 'story' : 'agent' },
          { store: args.store === 'ocean' || args.store === 'chat' ? args.store : undefined });
        return { ok: true, memory: memoryView(record, false) };
      }
    });

    tool({
      name: 'memory_update', tier: 'memory',
      summary: '修改一条已有记忆（给 id；只改你给出的字段）。',
      params: [
        { name: 'id', type: 'string', required: true, desc: '记忆 id（memory_search / memory_list 返回的）' },
        { name: 'title', type: 'string', desc: '新标题' },
        { name: 'content', type: 'string', desc: '新的完整正文' },
        { name: 'keys', type: 'json', desc: '新的触发词数组' },
        { name: 'importance', type: 'number', desc: '1～5' },
        { name: 'pinned', type: 'boolean', desc: '是否常驻' },
        { name: 'owner', type: 'string', desc: 'agent | story（改归属）' }
      ],
      run: async function (args) {
        var patch = {};
        ['title', 'content', 'keys', 'importance', 'pinned', 'owner'].forEach(function (key) { if (args[key] !== undefined) patch[key] = args[key]; });
        return { ok: true, memory: memoryView(await memory.update(String(args.id || ''), patch), false) };
      }
    });

    tool({
      name: 'memory_forget', tier: 'write',
      summary: '删除一条记忆（给 id）。',
      params: [{ name: 'id', type: 'string', required: true, desc: '记忆 id' }],
      describe: function (args) { return '删除记忆 ' + (args.id || ''); },
      run: async function (args) {
        var removed = await memory.remove(String(args.id || ''));
        return { ok: removed, note: removed ? '' : '没有这条记忆' };
      }
    });

    tool({
      name: 'memory_consolidate', tier: 'memory',
      summary: '立刻把正文里尚未整理的对话沉淀为记忆（平时会按阈值自动进行）。',
      params: [{ name: 'include_recent', type: 'boolean', desc: 'true=连最近几楼也一起整理' }],
      run: async function (args, ctx) {
        var report = await memory.consolidate({ reason: 'agent', force: args.include_recent === true, signal: ctx && ctx.signal });
        return { ok: report.ok, added: report.added, updated: report.updated, skipped: report.skipped, errors: report.errors, note: report.note || report.error || '' };
      }
    });

    /* ---------- 界面 ---------- */
    tool({
      name: 'reader_ui', tier: 'read', volatile: true,
      summary: '替用户打开读者的界面：lobby 大厅、gacha 命运抽卡、bookshelf 书架、gallery 相册、chess 棋局、panel 语义适配面板、memory 记忆管理。',
      params: [{ name: 'open', type: 'string', required: true, desc: 'lobby | gacha | bookshelf | gallery | chess | panel | memory' }],
      run: async function (args) {
        var target = String(args.open || '');
        if (target === 'panel') { await core().openPanel(); return { ok: true }; }
        if (target === 'memory') { if (deps.openUi) deps.openUi('memory'); return { ok: true }; }
        var shell = deps.shell ? deps.shell() : null;
        if (!shell) throw new Error('读者界面尚未就绪');
        var commands = { gacha: 'openGacha', bookshelf: 'openBookshelf', gallery: 'openDreamGallery', chess: 'openChessGame' };
        if (target === 'lobby') return { ok: !!(await shell.open('lobby')) };
        if (!commands[target]) throw new Error('open 只能是 lobby / gacha / bookshelf / gallery / chess / panel / memory');
        return { ok: (await shell.command(commands[target])) !== false };
      }
    });

    /* ---------- 酒馆助手逃生口 ---------- */
    function apiTier(name) {
      if (DANGER_API.test(name)) return 'danger';
      return WRITE_API.test(name) ? 'write' : 'read';
    }

    tool({
      name: 'tavern_api_list', tier: 'read',
      summary: '列出酒馆助手（TavernHelper）开放的函数名，可按关键词过滤。专用工具做不到的事再用它配合 tavern_api_call。',
      params: [{ name: 'filter', type: 'string', desc: '函数名里包含的关键词' }],
      run: async function (args) {
        var target = helper();
        if (!target) throw new Error('酒馆助手不可用');
        var filter = String(args.filter || '').toLowerCase();
        var names = Object.keys(target).filter(function (name) { return typeof target[name] === 'function' && (!filter || name.toLowerCase().indexOf(filter) >= 0); }).sort();
        return { total: names.length, functions: names.slice(0, 200).map(function (name) { return name + (apiTier(name) === 'read' ? '' : '（' + (apiTier(name) === 'danger' ? '危险' : '写') + '）'); }) };
      }
    });

    tool({
      name: 'tavern_api_call', tier: 'dynamic',
      summary: '按函数名调用酒馆助手的任意开放函数。args 是按顺序排列的参数数组（JSON）。有专用工具时优先用专用工具。',
      params: [
        { name: 'name', type: 'string', required: true, desc: '函数名' },
        { name: 'args', type: 'json', desc: '位置参数数组，如 ["书名"]' }
      ],
      tierOf: function (args) { return apiTier(String(args.name || '')); },
      describe: function (args) { return '调用酒馆助手 ' + (args.name || '') + '(' + text(JSON.stringify(args.args === undefined ? [] : args.args), 160) + ')'; },
      run: async function (args) {
        var target = helper();
        if (!target) throw new Error('酒馆助手不可用');
        var name = String(args.name || '');
        if (!Object.prototype.hasOwnProperty.call(target, name) || typeof target[name] !== 'function') throw new Error('酒馆助手没有开放函数 ' + name + '；用 tavern_api_list 查看可用函数');
        var list = args.args === undefined ? [] : Array.isArray(args.args) ? args.args : [args.args];
        var result = await target[name].apply(target, list);
        return result === undefined ? { ok: true } : result;
      }
    });

    tool({
      name: 'slash_run', tier: 'write',
      summary: '执行一条酒馆斜杠命令（STscript），返回管道结果。',
      params: [{ name: 'command', type: 'string', required: true, desc: '完整命令，如 /echo hi' }],
      describe: function (args) { return '执行斜杠命令 ' + text(args.command, 160); },
      run: async function (args) {
        var command = String(args.command || '').trim();
        if (command[0] !== '/') throw new Error('command 必须以 / 开头');
        var result = await kit.need('triggerSlash')(command);
        return { ok: true, result: result === undefined ? '' : result };
      }
    });

    /* ---------- 用户登记的技能 ---------- */
    function validateSkill(skill) {
      var errors = [];
      if (!modules.isObject(skill)) return ['技能不是对象'];
      if (!/^[a-z_][a-z0-9_]{1,40}$/.test(String(skill.name || ''))) errors.push('name 须为小写字母、数字、下划线');
      if (tools.some(function (item) { return item.name === skill.name; })) errors.push('name 与内置工具重名');
      if (!skill.description) errors.push('缺少 description');
      var kind = skill.invoke && skill.invoke.kind;
      if (['slash', 'api', 'reader'].indexOf(kind) < 0) errors.push('invoke.kind 只能是 slash / api / reader');
      if (kind === 'slash' && !/^\//.test(String(skill.invoke.command || ''))) errors.push('slash 技能需要以 / 开头的 command');
      if ((kind === 'api' || kind === 'reader') && !skill.invoke.target) errors.push(kind + ' 技能需要 target（函数名）');
      return errors;
    }

    function skillTool(skill) {
      var params = Array.isArray(skill.params) ? skill.params.filter(function (param) { return param && /^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(String(param.name || '')); }).slice(0, 12) : [];
      return {
        name: skill.name,
        tier: skill.tier === 'read' ? 'read' : 'write',
        summary: '【用户技能】' + text(skill.description, 200),
        params: params.map(function (param) { return { name: param.name, type: param.type === 'number' || param.type === 'boolean' || param.type === 'json' ? param.type : 'string', required: param.required === true, desc: text(param.desc, 120) }; }),
        describe: function () { return '运行用户技能 ' + skill.name; },
        run: async function (args) {
          var invoke = skill.invoke;
          if (invoke.kind === 'slash') {
            var command = String(invoke.command).replace(/\{\{(\w+)\}\}/g, function (match, key) { return args[key] == null ? '' : String(args[key]); });
            return { result: await kit.need('triggerSlash')(command) };
          }
          var values = params.map(function (param) { return args[param.name]; });
          if (invoke.kind === 'api') {
            var target = helper();
            if (!target || typeof target[invoke.target] !== 'function') throw new Error('酒馆助手没有函数 ' + invoke.target);
            return target[invoke.target].apply(target, values);
          }
          var reader = core();
          if (typeof reader[invoke.target] !== 'function') throw new Error('ReaderCore 没有方法 ' + invoke.target);
          return reader[invoke.target].apply(reader, values);
        }
      };
    }

    function registerSkill(skill) {
      var errors = validateSkill(skill);
      if (errors.length) return { ok: false, errors: errors };
      skills = skills.filter(function (item) { return item.name !== skill.name; });
      skills.push(skillTool(modules.clone(skill)));
      return { ok: true, name: skill.name };
    }

    function unregisterSkill(name) {
      var before = skills.length;
      skills = skills.filter(function (item) { return item.name !== name; });
      return before !== skills.length;
    }

    function all() { return tools.concat(skills); }

    function find(name) {
      var list = all();
      for (var index = 0; index < list.length; index += 1) if (list[index].name === name) return list[index];
      return null;
    }

    function tierFor(definition, args) {
      if (definition.tier === 'dynamic') return definition.tierOf ? definition.tierOf(args) : 'write';
      return definition.tier;
    }

    return {
      all: all,
      find: find,
      tierFor: tierFor,
      registerSkill: registerSkill,
      unregisterSkill: unregisterSkill,
      listSkills: function () { return skills.map(function (item) { return { name: item.name, summary: item.summary, tier: item.tier }; }); },
      apiTier: apiTier
    };
  }

  modules.createAgentTools = createAgentTools;
})(typeof globalThis !== 'undefined' ? globalThis : window);
