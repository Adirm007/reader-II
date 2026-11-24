(function (root) {
  'use strict';

  /*
   * 内核公用件：夜梦助手的主循环（agent.js）与后台运行器（director.js）共用的一小组纯函数。
   * 都不碰酒馆、不记状态（createSizer 的缓存归调用方持有），所以两边各跑各的，互不占锁。
   *
   *   clampInt / effortLevel            设置规整
   *   tokenEstimate / messageSize       本地 token 估算（不同模型的分词器不同，这里只求稳定、偏保守）
   *   createSizer                       一轮运行里的请求体积估算：消息只增不改，量过的不再重量
   *   prefixLength / clipToTokens       按 token 预算截取文本
   *   reportedWindow / applyWindow      上游报出的真实窗口、输入与输出的预算划分
   *   extractJson                       从模型回复里取出 JSON 对象（认围栏、前后夹带的说明、字符串里的裸换行）
   *   chatOwner                         当前聊天的稳定身份（卡的 avatar 或群 id + 聊天 id）
   *   mapLimit                          限并发、保顺序地跑一批异步任务
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  function clampInt(value, minimum, maximum, fallback) {
    var number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function effortLevel(raw) {
    return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(raw) ? raw : 'auto';
  }

  /*
   * 本地估算覆盖原生工具描述、调用参数和消息边界。对 CJK 和符号单独计数，发送前留余量；上游实际报满时再按更紧预算压缩。
   * 这是主循环里最热的一段（每一轮都要量整段上下文），所以按字符码分类，不逐字跑正则。
   */
  function tokenEstimate(value) {
    var text = typeof value === 'string' ? value : JSON.stringify(value || '');
    var total = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code > 127) total += 1.4;
      else if (code < 33) total += 0.32;
      else if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) total += 0.31;
      else total += 0.6;
    }
    return Math.ceil(total);
  }

  function messageSize(message) {
    return 8 + tokenEstimate(message.content || '') + (message.tool_calls ? tokenEstimate(message.tool_calls) : 0)
      + (message.reasoning_content ? tokenEstimate(message.reasoning_content) : 0) + (message.tool_call_id ? tokenEstimate(message.tool_call_id) : 0);
  }

  /*
   * 一轮运行里的体积估算。往来消息只在末尾追加，前面的极少变动（系统提示每轮重建但多半一字未改，
   * 最后一条工具结果偶尔补一句说明）：按消息对象记下量过的结果，内容对得上就直接取。
   * 工具声明同理：可用的工具没变就不重新序列化、重新量。结果与逐条重算逐位相同。
   */
  function createSizer() {
    var sizes = typeof WeakMap === 'function' ? new WeakMap() : null;
    var toolMark = null, toolSize = 0;

    function message(item) {
      var hit = sizes && sizes.get(item);
      if (hit && hit.content === item.content && hit.calls === item.tool_calls && hit.reasoning === item.reasoning_content && hit.callId === item.tool_call_id) return hit.size;
      var size = messageSize(item);
      if (sizes) sizes.set(item, { content: item.content, calls: item.tool_calls, reasoning: item.reasoning_content, callId: item.tool_call_id, size: size });
      return size;
    }

    /* defs 是工具定义的列表；schema(def) 把它转成请求里的声明。按定义对象的身份判断「没变」。 */
    function tools(defs, schema) {
      var same = toolMark && toolMark.length === defs.length;
      for (var index = 0; same && index < defs.length; index += 1) same = toolMark[index] === defs[index];
      if (!same) {
        toolMark = defs.slice();
        toolSize = defs.length ? tokenEstimate(defs.map(schema)) : 0;
      }
      return toolSize;
    }

    return {
      message: message, tools: tools,
      messages: function (list, base) {
        var total = base || 0;
        for (var index = 0; index < list.length; index += 1) total += message(list[index]);
        return total;
      }
    };
  }

  /* text 的多长一段前缀不超过 tokens；不会把一个代理对拆开。 */
  function prefixLength(text, tokens) {
    var upper = Math.min(text.length, Math.max(0, Math.ceil(tokens / 0.3) + 1));
    if (tokenEstimate(text.slice(0, upper)) <= tokens) return upper;
    var left = 0, right = upper;
    while (left + 1 < right) {
      var middle = Math.floor((left + right) / 2);
      if (tokenEstimate(text.slice(0, middle)) <= tokens) left = middle;
      else right = middle;
    }
    if (left && /[\uD800-\uDBFF]/.test(text.charAt(left - 1))) left--;
    return left;
  }

  /* 按 token 预算截取：tail 为 true 时留结尾（最近的正文更要紧），否则留开头。被截掉时加省略号。 */
  function clipToTokens(text, tokens, tail) {
    var source = String(text == null ? '' : text);
    if (tokens <= 0) return '';
    if (tokenEstimate(source) <= tokens) return source;
    if (!tail) return source.slice(0, prefixLength(source, Math.max(1, tokens - 2))) + '…';
    /* 留结尾：把字符串倒过来量前缀，等价于量后缀。 */
    var reversed = source.split('').reverse().join('');
    var keep = prefixLength(reversed, Math.max(1, tokens - 2));
    var start = source.length - keep;
    if (start > 0 && start < source.length && /[\uDC00-\uDFFF]/.test(source.charAt(start))) start += 1;
    return '…' + source.slice(start);
  }

  function reportedWindow(error) {
    var match = /(?:maximum context length(?: is| of|:)?|context (?:window|limit)(?: size)?(?: is| of|:)?|maximum number of tokens allowed\s*\(?)\s*([\d,]{3,})\b/i.exec(error)
      || /tokens?\s*>\s*([\d,]{3,})\s*(?:maximum|max|tokens?)/i.exec(error);
    var value = match ? Number(match[1].replace(/,/g, '')) : 0;
    return value >= 512 && value <= 100000000 ? value : 0;
  }

  function applyWindow(route, windowSize, origin, maxOutput) {
    var output = Math.min(maxOutput, Math.max(1, Math.floor(windowSize / 3)));
    route.window = windowSize;
    route.source = origin;
    route.input = Math.max(1, windowSize - output - Math.max(64, Math.ceil(windowSize * 0.04)));
    route.options.contextWindow = windowSize;
    route.options.maxTokens = output;
    return route;
  }

  /* ---------- 从模型回复里取 JSON ---------- */

  /* 从 start（一个 { 的位置）起找到配平的 }；字符串里的括号不算。没配平返回 -1。 */
  function balancedEnd(text, start) {
    var depth = 0, inString = false, escaped = false;
    for (var index = start; index < text.length; index += 1) {
      var ch = text.charAt(index);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return index;
        if (depth < 0) return -1;
      }
    }
    return -1;
  }

  /*
   * 模型写 JSON 时最常见的两种毛病：长字符串里直接换行（合法 JSON 里必须写成 \n），以及列表、对象末尾多一个逗号。
   * 逐字符走一遍，只在字符串内转义控制字符、只在字符串外去掉收尾逗号，不碰别的。
   */
  function repairJson(text) {
    var output = '', inString = false, escaped = false;
    for (var index = 0; index < text.length; index += 1) {
      var ch = text.charAt(index);
      if (inString) {
        if (escaped) { escaped = false; output += ch; continue; }
        if (ch === '\\') { escaped = true; output += ch; continue; }
        if (ch === '"') { inString = false; output += ch; continue; }
        if (ch === '\n') { output += '\\n'; continue; }
        if (ch === '\r') { continue; }
        if (ch === '\t') { output += '\\t'; continue; }
        if (ch.charCodeAt(0) < 32) { continue; }
        output += ch;
        continue;
      }
      if (ch === '"') { inString = true; output += ch; continue; }
      if (ch === ',') {
        var rest = text.slice(index + 1).match(/^\s*([}\]])/);
        if (rest) continue;
      }
      output += ch;
    }
    return output;
  }

  function tryParse(text) {
    try { return { ok: true, value: JSON.parse(text) }; } catch (error) { /* 再试修补过的 */ }
    try { return { ok: true, value: JSON.parse(repairJson(text)) }; } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  }

  /*
   * 返回 { ok: true, value, source } 或 { ok: false, error }。只认对象（顶层是 {…}）。
   * 先看 ```json 围栏里的，再看正文里第一个能配平并解析的 {…}；都不行时取「第一个 { 到最后一个 }」再试一次
   * （回复被截断、少了收尾括号时，这一步多半也救不回来，调用方按失败处理）。
   */
  function extractJson(text) {
    var source = String(text == null ? '' : text);
    var candidates = [];
    var fence = /```(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/g, match;
    while ((match = fence.exec(source))) candidates.push(match[1]);
    candidates.push(source);
    var lastError = '回复里没有 JSON 对象';
    for (var c = 0; c < candidates.length; c += 1) {
      var body = candidates[c];
      var from = body.indexOf('{'), tries = 0;
      while (from >= 0 && tries < 12) {
        tries += 1;
        var end = balancedEnd(body, from);
        if (end > from) {
          var parsed = tryParse(body.slice(from, end + 1));
          if (parsed.ok && modules.isObject(parsed.value)) return { ok: true, value: parsed.value, source: body.slice(from, end + 1) };
          if (!parsed.ok) lastError = parsed.error;
        }
        from = body.indexOf('{', from + 1);
      }
      var first = body.indexOf('{'), last = body.lastIndexOf('}');
      if (first >= 0 && last > first) {
        var loose = tryParse(body.slice(first, last + 1));
        if (loose.ok && modules.isObject(loose.value)) return { ok: true, value: loose.value, source: body.slice(first, last + 1) };
        if (!loose.ok) lastError = loose.error;
      }
    }
    return { ok: false, error: lastError };
  }

  /*
   * 当前聊天的稳定身份。kit.chatKey() 里用的 characterId 是角色列表的下标，导入、删除角色卡之后会变，
   * 只适合在一次页面会话里判断「还是不是同一个聊天」；要落盘的东西（助手对话、导演的分卷状态）用这里的 key：
   * 卡用头像文件名、群用群 id，再加酒馆的聊天 id。与 store.js 里助手多对话的归属写法一致。
   * 没有打开聊天时 key 是空串。
   */
  function chatOwner(ctx) {
    var context = ctx || {};
    var chat = typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : context.chatId;
    var group = context.groupId != null && context.groupId !== '';
    var card = context.characters && context.characters[context.characterId];
    var noCharacter = context.characterId == null || context.characterId === '' || String(context.characterId) === '-1';
    if (chat == null || chat === '' || (!group && noCharacter)) return { key: '', owner: '', chat: '', label: '无卡', group: false };
    var owner = group ? 'group:' + context.groupId : 'card:' + (card && card.avatar || context.characterId);
    var name = group ? ((context.groups || []).find(function (item) { return String(item.id) === String(context.groupId); }) || {}).name || '群聊 ' + context.groupId
      : card && card.name || context.name2 || '角色卡';
    return { key: JSON.stringify([owner, String(chat)]), owner: owner, chat: String(chat), label: String(name) + ' / ' + chat, group: group };
  }

  /* 限并发地跑完一批任务，结果按输入的顺序给出；任何一个抛错就整体抛错（其余已经开始的各自跑完）。 */
  function mapLimit(items, limit, worker) {
    var list = Array.prototype.slice.call(items || []);
    var width = Math.max(1, Math.min(list.length, Math.trunc(Number(limit)) || 1));
    var results = new Array(list.length);
    var next = 0;
    function lane() {
      if (next >= list.length) return Promise.resolve();
      var index = next;
      next += 1;
      return Promise.resolve().then(function () { return worker(list[index], index); }).then(function (value) {
        results[index] = value;
        return lane();
      });
    }
    var lanes = [];
    for (var index = 0; index < width; index += 1) lanes.push(lane());
    return Promise.all(lanes).then(function () { return results; });
  }

  modules.agentKernel = {
    clampInt: clampInt, effortLevel: effortLevel,
    tokenEstimate: tokenEstimate, messageSize: messageSize, createSizer: createSizer,
    prefixLength: prefixLength, clipToTokens: clipToTokens,
    reportedWindow: reportedWindow, applyWindow: applyWindow,
    extractJson: extractJson, repairJson: repairJson,
    chatOwner: chatOwner, mapLimit: mapLimit
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
