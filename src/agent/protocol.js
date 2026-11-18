(function (root) {
  'use strict';

  /*
   * 工具调用的两种协议。
   *
   * 一、原生函数调用（优先）：工具随请求声明（tools），模型的调用从响应的 tool_calls 里取，结果用 role: 'tool' 的消息交还。
   *    这里只负责把工具定义转成 JSON Schema、把参数从 JSON 文本解出来；请求由 reader-llm-gateway.js 的 chatTools 发。
   *
   * 二、文本协议（兜底，给没有原生函数调用的通道与模型）：
   *
   *   <action name="read">
   *   <param name="path">wb:/某本书/某个条目</param>
   *   </action>
   *
   * 参数值原样书写，长文本、引号、换行都不需要转义；值里本身带有结束标签时用 <![CDATA[ … ]]> 包起来。
   * 没写完的块（多半被长度截断）不执行，请模型重发。
   *
   * 标签为什么不叫 tool_call：不少模型把 <tool_call> 一类的写法训练成了专用记号，服务端见到就当原生调用处理，
   * 请求没声明 tools 时整段被丢掉，正文只剩「我这就去做」（4.0.0-alpha.2 的真机故障）。解析时旧写法照样认：
   * <tool_call>/<arg>、<invoke>/<parameter>、块内 JSON。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  var BLOCK = 'action|tool_call|invoke|use_tool';
  var PARAM = 'param|arg|parameter';
  var RESULT = 'action_result|tool_result|tool_response';
  var PARAM_OPEN_RE = new RegExp('<(' + PARAM + ')\\b([^>]*)>', 'gi');
  var RESULT_RE = new RegExp('<\\/?(?:' + RESULT + ')\\b[^>]*>', 'gi');

  /* ---------- 工具块解析 ---------- */
  function attribute(source, name) {
    var match = String(source || '').match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))'));
    return match ? (match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]) : '';
  }

  function trimValue(value) {
    var output = String(value);
    var cdata = output.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    if (cdata) return cdata[1];
    return output.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  }

  /* 逐个读参数：值以 CDATA 开头时读到它的结束记号为止（里面可以有任何结束标签），否则读到同名的结束标签。 */
  function readParams(body) {
    var args = {};
    var found = false;
    PARAM_OPEN_RE.lastIndex = 0;
    var match;
    while ((match = PARAM_OPEN_RE.exec(body))) {
      var key = attribute(match[2], 'name');
      var start = PARAM_OPEN_RE.lastIndex;
      var close = new RegExp('<\\/' + match[1] + '\\s*>', 'i');
      var rest = body.slice(start);
      var cdata = rest.match(/^\s*<!\[CDATA\[/);
      var value, end;
      if (cdata) {
        var stop = rest.indexOf(']]>', cdata[0].length);
        if (stop < 0) break;
        value = rest.slice(cdata[0].length, stop);
        var tail = rest.slice(stop + 3).match(close);
        end = start + stop + 3 + (tail ? tail.index + tail[0].length : 0);
      } else {
        var hit = rest.match(close);
        if (!hit) break;
        value = trimValue(rest.slice(0, hit.index));
        end = start + hit.index + hit[0].length;
      }
      if (key) { args[key] = value; found = true; }
      PARAM_OPEN_RE.lastIndex = end;
    }
    return found ? args : null;
  }

  /* 找出正文里的工具块。结束标签要在 CDATA 之外才算数；最后一个块没有结束标签时记为 open（没写完）。 */
  function scanBlocks(text) {
    var blocks = [];
    var opener = new RegExp('<(' + BLOCK + ')\\b([^>]*)>', 'gi');
    var match;
    while ((match = opener.exec(text))) {
      var bodyStart = opener.lastIndex;
      var closer = new RegExp('<\\/' + match[1] + '\\s*>', 'gi');
      var index = bodyStart;
      var close = null;
      while (index <= text.length) {
        closer.lastIndex = index;
        close = closer.exec(text);
        if (!close) break;
        var cdata = text.indexOf('<![CDATA[', index);
        if (cdata < 0 || cdata > close.index) break;
        var stop = text.indexOf(']]>', cdata + 9);
        if (stop < 0) { close = null; break; }
        index = stop + 3;
      }
      if (!close) { blocks.push({ start: match.index, open: true }); break; }
      var end = close.index + close[0].length;
      blocks.push({ start: match.index, end: end, attrs: match[2], body: text.slice(bodyStart, close.index), raw: text.slice(match.index, end) });
      opener.lastIndex = end;
    }
    return blocks;
  }

  function parseToolCalls(input) {
    var text = String(input || '').replace(/<\/?function_calls\s*>/gi, '');
    var calls = [];
    var prose = '';
    var cursor = 0;
    var truncated = false;
    scanBlocks(text).forEach(function (block) {
      prose += text.slice(cursor, block.start);
      /* 没写完的工具块（多半是输出被长度截断）：不执行，交给模型重发。 */
      if (block.open) { truncated = true; cursor = text.length; return; }
      cursor = block.end;
      prose += '\n';
      var call = { name: attribute(block.attrs, 'name'), args: {}, raw: block.raw };
      var params = readParams(block.body);
      if (params) call.args = params;
      else {
        var json = block.body.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        if (json[0] === '{') {
          try {
            var parsed = JSON.parse(json);
            if (modules.isObject(parsed)) {
              var inner = modules.isObject(parsed.arguments) ? parsed.arguments : modules.isObject(parsed.args) ? parsed.args : modules.isObject(parsed.parameters) ? parsed.parameters : null;
              if (!call.name && typeof (parsed.name || parsed.tool) === 'string') call.name = parsed.name || parsed.tool;
              var source = inner || (call.name && !parsed.name && !parsed.tool ? parsed : {});
              Object.keys(source).forEach(function (key) { call.args[key] = source[key]; });
              call.json = true;
            }
          } catch (error) { call.malformed = '工具块里的 JSON 无法解析'; }
        }
      }
      if (!call.name) call.malformed = '工具块缺少 name';
      calls.push(call);
    });
    prose += text.slice(cursor);
    prose = prose.replace(RESULT_RE, '').replace(/\n{3,}/g, '\n\n').trim();
    return { calls: calls, prose: prose, truncated: truncated };
  }

  /* 把原样文本的参数按工具声明的类型转换；返回 { args } 或 { error }。 */
  function coerceArgs(definition, raw) {
    var args = {};
    var params = definition.params || [];
    for (var index = 0; index < params.length; index += 1) {
      var param = params[index];
      var value = raw[param.name];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '' && param.type !== 'string')) {
        if (param.required) return { error: '缺少必填参数 ' + param.name + '（' + (param.desc || param.type) + '）' };
        continue;
      }
      if (param.type === 'number') {
        var number = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isFinite(number)) return { error: '参数 ' + param.name + ' 需要数字' };
        args[param.name] = number;
      } else if (param.type === 'boolean') {
        args[param.name] = value === true || /^(?:true|1|yes|on|是|开|开启)$/i.test(String(value).trim());
      } else if (param.type === 'json') {
        if (typeof value !== 'string') { args[param.name] = value; continue; }
        var textValue = value.trim();
        try { args[param.name] = JSON.parse(textValue); }
        catch (error) {
          /* 模型常把字符串数组写成逗号或换行分隔的清单。 */
          if (!/^[\[{]/.test(textValue)) {
            var list = textValue.split(/\s*[,，、\n]\s*/).filter(Boolean);
            args[param.name] = list.length > 1 ? list : textValue;
          } else return { error: '参数 ' + param.name + ' 需要合法的 JSON' };
        }
      } else {
        args[param.name] = typeof value === 'string' ? value : JSON.stringify(value);
        if (param.required && !String(args[param.name]).trim()) return { error: '缺少必填参数 ' + param.name };
      }
    }
    return { args: args };
  }

  function serializeResult(value, cap) {
    var body;
    if (typeof value === 'string') body = value;
    else {
      try { body = JSON.stringify(value === undefined ? { ok: true } : value, null, 1); }
      catch (error) { body = String(value); }
    }
    if (body.length <= cap) return body;
    return body.slice(0, cap) + '\n…（结果共 ' + body.length + ' 字，已截断。需要其余部分请用该工具的 offset / limit / path 等参数分段读取）';
  }

  function resultBlock(name, status, body) {
    return '<action_result name="' + name + '" status="' + status + '">\n' + body + '\n</action_result>';
  }

  /* 把一次调用写成文本协议的块（原生的对话记录改走文本协议时用）。 */
  function callBlock(name, args) {
    var source = modules.isObject(args) ? args : {};
    var lines = Object.keys(source).map(function (key) {
      var value = source[key];
      var text = typeof value === 'string' ? value : JSON.stringify(value);
      return '<param name="' + key + '">' + (/<\/(?:param|action)\s*>/i.test(text) ? '<![CDATA[' + text + ']]>' : text) + '</param>';
    });
    return '<action name="' + name + '">\n' + lines.join('\n') + (lines.length ? '\n' : '') + '</action>';
  }

  /* 写给模型看的文本协议说明。 */
  var TEXT_FORMAT = [
    '【工具调用格式】',
    '需要用工具时，在回复里写出这样的块（之前可以先用一句话说明要做什么；一次回复里可以放多个块）：',
    '<action name="工具名">',
    '<param name="参数名">参数值</param>',
    '</action>',
    '- 参数值原样书写，不要加引号、不要转义；多行文本直接换行。类型为 json 的参数写 JSON。值里本身含有 </param> 或 </action> 时，用 <![CDATA[ … ]]> 把整个值包起来。',
    '- 写完工具块就停下。系统会把结果放在 <action_result> 里交还给你，再继续下一步。',
    '- 说了要做就必须在同一条回复里写出工具块：只说「我这就去做」而不写块，等于什么都没做。',
    '- 不需要工具时直接写给用户的话，其中不要出现 action 块。'
  ].join('\n');

  /* ---------- 原生函数调用 ---------- */
  var JSON_TYPES = { string: 'string', number: 'number', boolean: 'boolean' };

  /* 工具定义 → OpenAI 的 function 声明。json 类型的参数可以用 param.schema 给出确切的结构；没给的按字符串声明（内容写 JSON 文本）。 */
  function toolSchema(def) {
    var properties = {};
    var required = [];
    (def.params || []).forEach(function (param) {
      var schema;
      if (param.type === 'json') schema = modules.isObject(param.schema) ? modules.clone(param.schema) : { type: 'string' };
      else schema = { type: JSON_TYPES[param.type] || 'string' };
      var note = param.desc || '';
      if (param.type === 'json' && !modules.isObject(param.schema)) note = (note ? note + '；' : '') + '写成 JSON 文本';
      if (note) schema.description = note;
      properties[param.name] = schema;
      if (param.required) required.push(param.name);
    });
    var effect = typeof def.effect === 'function' ? '' : def.effect === 'write' ? '［写入］' : def.effect === 'danger' ? '［危险］' : '';
    var parameters = { type: 'object', properties: properties };
    if (required.length) parameters.required = required;
    return { type: 'function', function: { name: def.name, description: (effect + String(def.summary || '')).slice(0, 1000), parameters: parameters } };
  }

  /* tool_calls[].function.arguments（JSON 文本）→ { args } 或 { error }。 */
  function nativeArgs(text) {
    if (modules.isObject(text)) return { args: text };
    var source = String(text == null ? '' : text).trim();
    if (!source) return { args: {} };
    try {
      var parsed = JSON.parse(source);
      if (modules.isObject(parsed)) return { args: parsed };
      return { error: '工具参数应当是一个 JSON 对象' };
    } catch (error) {
      return { error: '工具参数不是合法的 JSON（多半被长度截断了）。请重新调用；内容很长时拆成几次。' };
    }
  }

  /*
   * 「只说不做」：回复里没有任何调用，却是一句「我这就去做」。常见原因是工具块被上游吞掉，或模型把说明当成了执行。
   * 只在这一轮还没有调用过任何工具时判断；在向用户提问的不算（那是正常的收尾）。
   */
  var NOW_MARK = /(?:现在|这就|马上|立刻|立即|即刻|随即)[^。！？!?\n]{0,16}(?:开始|执行|动手|着手|读取|查看|检查|核对|定位|调用|处理|去做|来做|做|办|读|查)|稍等|请稍候|稍候片刻|等我一下/;
  var WILL_MARK = /(?:我会先|我将先|我先|让我先|我来先|首先我|我这就|我去|我来)[^。！？!?\n]{0,24}(?:读取|查看|检查|核对|定位|调用|处理|转换|适配|整理|搜索|检索|列出|打开|修改|写入|确认|看看|看一下|读一下|查一下)/;
  var EN_MARK = /\b(?:let me|i(?:'| wi)ll|i am going to|i'm going to|starting now|right away)\b/i;
  var REASON_MARK = /tool[\s_-]?call|call (?:the )?tool|then tool|use (?:the )?tool|function call|工具块|调用工具|工具调用|发起调用/i;

  function stalled(text, reasoning) {
    var body = String(text || '').trim();
    if (!body || body.length > 420) return false;
    if (/[？?]\s*$/.test(body)) return false;
    if (REASON_MARK.test(String(reasoning || ''))) return true;
    if (NOW_MARK.test(body) || EN_MARK.test(body)) return true;
    return body.length <= 240 && !/[？?]/.test(body) && WILL_MARK.test(body);
  }

  modules.agentProtocol = {
    parse: parseToolCalls, coerce: coerceArgs, serialize: serializeResult, resultBlock: resultBlock, callBlock: callBlock,
    toolSchema: toolSchema, nativeArgs: nativeArgs, stalled: stalled, TEXT_FORMAT: TEXT_FORMAT
  };
  modules.parseAgentToolCalls = parseToolCalls;
  modules.coerceAgentArgs = coerceArgs;
})(typeof globalThis !== 'undefined' ? globalThis : window);
