(function (root) {
  'use strict';

  /*
   * 工具调用的文本协议（不依赖网关的原生 function calling，任何能输出文本的模型与中转都能用）：
   *
   *   <tool_call name="read">
   *   <arg name="path">wb:/某本书/某个条目</arg>
   *   </tool_call>
   *
   * 参数值原样书写，长文本、引号、换行都不需要转义；同时接受 <invoke>/<parameter> 写法与块内 JSON。
   * 没写完的块（多半被长度截断）不执行，请模型重发。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

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

  function parseToolCalls(input) {
    /* 兼容部分模型习惯的 <invoke> / <parameter> 写法。 */
    var text = String(input || '')
      .replace(/<\/?function_calls\s*>/gi, '')
      .replace(/<invoke\b/gi, '<tool_call').replace(/<\/invoke\s*>/gi, '</tool_call>')
      .replace(/<parameter\b/gi, '<arg').replace(/<\/parameter\s*>/gi, '</arg>');
    var calls = [];
    var prose = text.replace(/<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call\s*>/gi, function (block, attrs, body) {
      var call = { name: attribute(attrs, 'name'), args: {}, raw: block };
      var found = false;
      body.replace(/<arg\b([^>]*)>([\s\S]*?)<\/arg\s*>/gi, function (match, argAttrs, value) {
        var key = attribute(argAttrs, 'name');
        if (key) { call.args[key] = trimValue(value); found = true; }
        return match;
      });
      if (!found) {
        var json = body.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
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
      return '\n';
    });
    /* 没写完的工具块（多半是输出被长度截断）：不执行，交给模型重发。 */
    var truncated = false;
    var open = prose.search(/<tool_call\b/i);
    if (open >= 0) { truncated = true; prose = prose.slice(0, open); }
    prose = prose.replace(/<\/?tool_result\b[^>]*>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
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
    return '<tool_result name="' + name + '" status="' + status + '">\n' + body + '\n</tool_result>';
  }

  modules.agentProtocol = { parse: parseToolCalls, coerce: coerceArgs, serialize: serializeResult, resultBlock: resultBlock };
  modules.parseAgentToolCalls = parseToolCalls;
  modules.coerceAgentArgs = coerceArgs;
})(typeof globalThis !== 'undefined' ? globalThis : window);
