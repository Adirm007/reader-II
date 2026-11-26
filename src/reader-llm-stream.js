(function (root) {
  'use strict';

  /*
   * 模型流式响应（SSE）的接收与组装。纯逻辑：不发请求、不碰 DOM，网关与传输层把收到的文字一段段喂进来。
   *
   * 为什么要流式：总导演一次要想很久、写很长。非流式请求在这期间响应体一个字节都没有，
   * Cloudflare / 反代大约 100 秒收不到字节就断开（524），客户端也只能按总时长硬杀，界面上看着像卡死。
   * 流式之后，思考 token、正文 token、工具参数的增量、服务端的保活注释都算「有动静」：
   * 网关据此把超时改成空闲计时（reader-llm-gateway.js 的 raceOnce），界面实时显示收到了多少字。
   *
   * 组装器把三家的流式事件拼回与非流式响应同形状的原始 JSON，下游的 parseToolResponse、provider_stop 检查
   * 不用区分这次是不是流式：
   *   OpenAI Chat Completions  choices[].delta：content / reasoning_content 或 reasoning / refusal / tool_calls（按 index 拼 id、name、arguments，
   *                            signature、thought_signature、extra_content 这类附带字段原样保留）
   *                            → { id, model, choices: [{ index, message, finish_reason }], usage }
   *   Anthropic Messages       message_start / content_block_start / content_block_delta（text / thinking / signature / input_json）/ message_delta
   *                            → { id, type: 'message', role, model, content: [块], stop_reason, usage }
   *   Gemini generateContent   candidates[0].content.parts：text / thought / functionCall / thoughtSignature
   *                            → { candidates: [{ content: { role, parts }, finishReason }], promptFeedback, usageMetadata }
   * 酒馆后端（/api/backends/chat-completions/generate）流式时原样转发上游的 SSE，所以三种都可能出现。
   *
   * 响应体不是 SSE（上游没理会 stream，直接回了 JSON）时按完整 JSON 解析：看第一个非空白字符，SSE 不会以 { 或 [ 开头。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var EXTRA_KEYS = ['signature', 'thought_signature', 'thoughtSignature', 'extra_content'];
  /* 断流时已经吐出的正文至少有这么多字，才值得抢救（总导演把它落进草稿工作台接着写）；更短的不如从头重来。 */
  var SALVAGE_MIN = 200;

  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function str(value) { return value == null ? '' : String(value); }
  function copy(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (error) { return value; }
  }

  /* delta.content 可能是字符串，也可能是内容块数组。 */
  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(function (part) {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string' && (part.type === undefined || part.type === 'text' || part.type === 'output_text')) return part.text;
      return '';
    }).join('');
  }

  /* 去掉开头的思考块（有的模型把思考写在正文最前面）。思考还没写完时，可见正文是空的。 */
  function visible(text) {
    var source = str(text), first;
    while ((first = /^\s*<(think|thinking|think_nya)>/i.exec(source))) {
      var rest = source.slice(first[0].length);
      var end = new RegExp('<\\/' + first[1] + '\\s*>', 'i').exec(rest);
      if (!end) return '';
      source = rest.slice(end.index + end[0].length).replace(/^\s*<!--\s*<\/think>\s*-->/i, '');
    }
    return source.replace(/^\s+/, '');
  }

  function completeJson(text) {
    try { JSON.parse(text); return true; } catch (error) { return false; }
  }

  /* ---------- SSE 解码：文字流 → 事件 ---------- */

  /*
   * 按 SSE 规范切事件：空行分隔事件；data: 可以多行；: 开头的是注释（服务端的保活心跳）。
   * 不少服务端事件之间不空行：上一段 data 已经是完整的 JSON 时，新的 data: 行先把它发出去。
   * 一段文字以 \r 结尾时先留着，等下一段看是不是 \r\n。
   */
  function createSseDecoder() {
    var buffer = '', data = [], name = '', out = [];
    function dispatch() {
      if (data.length) out.push({ event: name, data: data.join('\n') });
      data = [];
      name = '';
    }
    function line(text) {
      if (text === '') { dispatch(); return; }
      if (text.charAt(0) === ':') { out.push({ comment: text.slice(1) }); return; }
      var at = text.indexOf(':');
      var field = at < 0 ? text : text.slice(0, at);
      var value = at < 0 ? '' : text.slice(at + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
      if (field === 'data') {
        if (data.length && completeJson(data.join('\n'))) dispatch();
        data.push(value);
      } else if (field === 'event') {
        if (data.length) dispatch();
        name = value;
      }
      /* id、retry 与不认识的字段：不用。 */
    }
    function push(chunk) {
      out = [];
      buffer += str(chunk);
      var start = 0;
      for (var index = 0; index < buffer.length; index += 1) {
        var code = buffer.charCodeAt(index);
        if (code !== 10 && code !== 13) continue;
        if (code === 13 && index + 1 >= buffer.length) break;
        line(buffer.slice(start, index));
        if (code === 13 && buffer.charCodeAt(index + 1) === 10) index += 1;
        start = index + 1;
      }
      buffer = buffer.slice(start);
      return out;
    }
    function end() {
      out = [];
      var rest = buffer.replace(/\r$/, '');
      buffer = '';
      if (rest) line(rest);
      dispatch();
      return out;
    }
    return { push: push, end: end };
  }

  /* ---------- 组装：事件 → 与非流式同形状的响应 ---------- */

  function createAssembler() {
    var format = '';
    var oa = { id: '', model: '', role: 'assistant', content: '', reasoning: '', reasoningKey: '', refusal: '', calls: [], finish: '', usage: null, whole: null };
    var an = { id: '', model: '', blocks: [], stop: '', stopSequence: null, usage: null };
    var gm = { parts: [], finish: '', feedback: null, usage: null, model: '' };
    var events = 0, recognized = 0, lastPayload = null, failure = null;
    var phase = '', lastTool = { name: '', chars: 0 };

    function mergeName(existing, piece) {
      if (!existing) return piece;
      if (piece === existing) return existing;
      if (piece.indexOf(existing) === 0) return piece;   /* 有的服务端每段都给完整（累积）的名字 */
      return existing + piece;
    }

    function openAiCall(item) {
      if (!isObject(item)) return;
      var fn = isObject(item.function) ? item.function : {};
      var slot = null, at = -1;
      if (typeof item.index === 'number' && item.index >= 0) { at = Math.trunc(item.index); slot = oa.calls[at] || null; }
      else if (item.id) {
        for (var index = 0; index < oa.calls.length; index += 1) {
          if (oa.calls[index] && oa.calls[index].id === String(item.id)) { slot = oa.calls[index]; break; }
        }
      } else if (!fn.name && oa.calls.length) slot = oa.calls[oa.calls.length - 1];
      if (!slot) {
        slot = { id: '', type: 'function', name: '', args: '', extra: {} };
        if (at >= 0) oa.calls[at] = slot;
        else oa.calls.push(slot);
      }
      if (item.id) slot.id = String(item.id);
      if (typeof item.type === 'string' && item.type) slot.type = item.type;
      if (typeof fn.name === 'string' && fn.name) slot.name = mergeName(slot.name, fn.name);
      if (fn.arguments !== undefined && fn.arguments !== null) slot.args += typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
      EXTRA_KEYS.forEach(function (key) { if (item[key] !== undefined) slot.extra[key] = copy(item[key]); });
      phase = 'tool';
      lastTool = { name: slot.name, chars: slot.args.length };
    }

    function addOpenAi(chunk) {
      format = format || 'openai';
      if (chunk.id && !oa.id) oa.id = String(chunk.id);
      if (chunk.model && !oa.model) oa.model = String(chunk.model);
      if (isObject(chunk.usage)) oa.usage = copy(chunk.usage);
      chunk.choices.forEach(function (choice) {
        if (!isObject(choice) || (typeof choice.index === 'number' && choice.index !== 0)) return;
        var delta = isObject(choice.delta) ? choice.delta : null;
        /* 少数服务端最后一段给的是整条 message：前面什么都没收到时才当成完整回复。 */
        if (!delta && isObject(choice.message) && !oa.content && !oa.calls.length) { oa.whole = copy(choice.message); delta = choice.message; }
        if (delta) {
          if (typeof delta.role === 'string' && delta.role) oa.role = delta.role;
          var piece = textOf(delta.content);
          if (piece) { oa.content += piece; phase = 'text'; }
          ['reasoning_content', 'reasoning'].forEach(function (key) {
            if (typeof delta[key] !== 'string' || !delta[key]) return;
            if (oa.reasoningKey && oa.reasoningKey !== key) return;   /* 两个字段给同一段思考的，只记一份 */
            oa.reasoningKey = key;
            oa.reasoning += delta[key];
            phase = 'thinking';
          });
          if (typeof delta.refusal === 'string') oa.refusal += delta.refusal;
          if (Array.isArray(delta.tool_calls)) delta.tool_calls.forEach(openAiCall);
          else if (isObject(delta.function_call)) openAiCall({ index: 0, function: delta.function_call });
        }
        if (choice.finish_reason) oa.finish = String(choice.finish_reason);
      });
    }

    function anthropicBlock(index) {
      var at = Math.max(0, Math.trunc(Number(index) || 0));
      if (!an.blocks[at]) an.blocks[at] = { type: 'text', text: '' };
      return an.blocks[at];
    }

    function addAnthropic(evt) {
      format = format || 'anthropic';
      var block;
      switch (evt.type) {
        case 'message_start':
          if (isObject(evt.message)) {
            an.id = str(evt.message.id);
            an.model = str(evt.message.model);
            if (isObject(evt.message.usage)) an.usage = copy(evt.message.usage);
          }
          break;
        case 'content_block_start':
          block = isObject(evt.content_block) ? copy(evt.content_block) : { type: 'text', text: '' };
          if (block.type === 'text') block.text = str(block.text);
          if (block.type === 'thinking') block.thinking = str(block.thinking);
          if (block.type === 'tool_use') { block.partial = ''; phase = 'tool'; lastTool = { name: str(block.name), chars: 0 }; }
          an.blocks[Math.max(0, Math.trunc(Number(evt.index) || 0))] = block;
          break;
        case 'content_block_delta':
          block = anthropicBlock(evt.index);
          var delta = isObject(evt.delta) ? evt.delta : {};
          if (delta.type === 'text_delta' || (delta.type === undefined && typeof delta.text === 'string')) { block.text = str(block.text) + str(delta.text); phase = 'text'; }
          else if (delta.type === 'thinking_delta') { block.thinking = str(block.thinking) + str(delta.thinking); phase = 'thinking'; }
          else if (delta.type === 'signature_delta') block.signature = str(block.signature) + str(delta.signature);
          else if (delta.type === 'input_json_delta') {
            block.partial = str(block.partial) + str(delta.partial_json);
            phase = 'tool';
            lastTool = { name: str(block.name), chars: block.partial.length };
          }
          break;
        case 'message_delta':
          if (isObject(evt.delta)) {
            if (evt.delta.stop_reason) an.stop = String(evt.delta.stop_reason);
            if (evt.delta.stop_sequence !== undefined) an.stopSequence = evt.delta.stop_sequence;
          }
          if (isObject(evt.usage)) an.usage = Object.assign({}, an.usage || {}, copy(evt.usage));
          break;
        default:
          break;   /* content_block_stop、message_stop、ping：只算有动静 */
      }
    }

    function addGemini(chunk) {
      format = format || 'gemini';
      if (isObject(chunk.promptFeedback)) gm.feedback = copy(chunk.promptFeedback);
      if (isObject(chunk.usageMetadata)) gm.usage = copy(chunk.usageMetadata);
      if (chunk.modelVersion) gm.model = String(chunk.modelVersion);
      var candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
      if (!isObject(candidate)) return;
      if (candidate.finishReason) gm.finish = String(candidate.finishReason);
      var parts = isObject(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
      parts.forEach(function (part) {
        if (!isObject(part)) return;
        if (typeof part.text === 'string' && !part.functionCall) {
          var thought = part.thought === true;
          var last = gm.parts[gm.parts.length - 1];
          if (last && typeof last.text === 'string' && !last.functionCall && (last.thought === true) === thought && !last.thoughtSignature) {
            last.text += part.text;
            if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
          } else gm.parts.push(copy(part));
          phase = thought ? 'thinking' : 'text';
          return;
        }
        gm.parts.push(copy(part));
        if (isObject(part.functionCall)) {
          phase = 'tool';
          lastTool = { name: str(part.functionCall.name), chars: str(JSON.stringify(part.functionCall.args || {})).length };
        }
      });
    }

    function add(payload) {
      events += 1;
      if (!isObject(payload)) return;
      lastPayload = payload;
      if (isObject(payload.error) || (typeof payload.error === 'string' && payload.error)) { recognized += 1; failure = payload.error; return; }
      if (typeof payload.type === 'string' && /^(?:message_|content_block_|ping$)/.test(payload.type)) { recognized += 1; addAnthropic(payload); return; }
      if (Array.isArray(payload.choices)) { recognized += 1; addOpenAi(payload); return; }
      if (Array.isArray(payload.candidates) || isObject(payload.promptFeedback)) { recognized += 1; addGemini(payload); return; }
      if (isObject(payload.usage) && format === 'openai') oa.usage = copy(payload.usage);
    }

    /* 已经拿到的正文、思考与有没有工具调用（断流抢救与进度显示用）。 */
    function partial() {
      var text = '', reasoning = '', tools = 0;
      if (format === 'anthropic') {
        an.blocks.forEach(function (block) {
          if (!block) return;
          if (block.type === 'text') text += str(block.text);
          else if (block.type === 'thinking') reasoning += str(block.thinking);
          else if (block.type === 'tool_use') tools += 1;
        });
      } else if (format === 'gemini') {
        gm.parts.forEach(function (part) {
          if (isObject(part.functionCall)) tools += 1;
          else if (typeof part.text === 'string') { if (part.thought === true) reasoning += part.text; else text += part.text; }
        });
      } else {
        text = oa.content;
        reasoning = oa.reasoning;
        tools = oa.calls.filter(Boolean).length;
      }
      var shown = visible(text);
      /* 写在正文开头的 <think> 也算思考。 */
      return { text: shown, reasoningChars: reasoning.length + Math.max(0, text.length - shown.length), toolCalls: tools };
    }

    function result() {
      if (format === 'anthropic') {
        var content = an.blocks.filter(Boolean).map(function (block) {
          var out = copy(block);
          if (out.type === 'tool_use') {
            var raw = str(out.partial);
            delete out.partial;
            if (raw.trim()) {
              try { out.input = JSON.parse(raw); } catch (error) { out.input = raw; }   /* 半截的 JSON 原样交下去，由解析方判为参数不合法 */
            } else if (!isObject(out.input)) out.input = {};
          }
          return out;
        });
        var message = { id: an.id, type: 'message', role: 'assistant', model: an.model, content: content, stop_reason: an.stop || null };
        if (an.stopSequence !== null) message.stop_sequence = an.stopSequence;
        if (an.usage) message.usage = an.usage;
        return message;
      }
      if (format === 'gemini') {
        var data = { candidates: [{ content: { role: 'model', parts: gm.parts.map(copy) }, finishReason: gm.finish || undefined }] };
        if (gm.feedback) data.promptFeedback = gm.feedback;
        if (gm.usage) data.usageMetadata = gm.usage;
        if (gm.model) data.modelVersion = gm.model;
        return data;
      }
      /* 一个认得的事件都没有，但最后一段本身就是一份完整的响应：直接用它。 */
      if (!recognized && isObject(lastPayload)) return copy(lastPayload);
      var msg = oa.whole && !oa.calls.length ? oa.whole : { role: oa.role || 'assistant', content: oa.content };
      if (!oa.whole) {
        if (oa.reasoning) msg[oa.reasoningKey || 'reasoning_content'] = oa.reasoning;
        if (oa.refusal) msg.refusal = oa.refusal;
        var calls = oa.calls.filter(Boolean).map(function (slot) {
          return Object.assign({ id: slot.id, type: slot.type || 'function', function: { name: slot.name, arguments: slot.args } }, slot.extra);
        });
        if (calls.length) msg.tool_calls = calls;
      }
      var out = { id: oa.id, object: 'chat.completion', model: oa.model, choices: [{ index: 0, message: msg, finish_reason: oa.finish || null }] };
      if (oa.usage) out.usage = oa.usage;
      return out;
    }

    return {
      add: add, result: result, partial: partial,
      failure: function () { return failure; },
      stats: function () { return { events: events, recognized: recognized, format: format, phase: phase, toolName: lastTool.name, toolChars: lastTool.chars }; }
    };
  }

  /* 流里的 error 对象 → Error（带上状态码，网关据此判断能不能重试）。 */
  function streamError(value) {
    var detail = isObject(value) ? (value.message || value.error || value.type || '') : value;
    var text = typeof detail === 'string' && detail ? detail : (function () { try { return JSON.stringify(value); } catch (error) { return '未知错误'; } })();
    var error = new Error('模型在流式输出途中报错：' + String(text).slice(0, 400));
    var status = isObject(value) ? Number(value.status || value.code) : NaN;
    if (Number.isFinite(status) && status >= 400 && status < 600) error.status = status;
    if (isObject(value) && typeof value.code === 'string') error.code = value.code;
    error.code = error.code || 'stream_error';
    return error;
  }

  /* ---------- 接收器：传输层把文字喂进来，最后交出整份响应 ---------- */

  /*
   * options: { onProgress(progress), throttleMs }
   * 接收器上的两个钩子由使用方在发请求前挂上：
   *   onActivity()   每收到一段字节（含保活注释）就调用：网关用它重置空闲计时器
   *   onProgress(p)  节流后的进度：{ phase: waiting|thinking|text|tool, textChars, reasoningChars, toolName, toolChars, toolCalls, bytes, events, elapsedMs, snapshot() }
   */
  function createCollector(options) {
    var opts = options || {};
    var mode = '', head = '', raw = '';
    var decoder = createSseDecoder(), asm = createAssembler();
    var bytes = 0, startedAt = Date.now(), lastAt = 0, lastEmit = 0, done = false, sawDone = false;
    var throttle = Number(opts.throttleMs) >= 0 ? Number(opts.throttleMs) : 250;

    var collector = {
      onActivity: null,
      onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
      write: write, finish: finish, partial: partialOf, stats: stats,
      received: function () { return bytes > 0; },
      mode: function () { return mode; }
    };

    function progress() {
      var p = asm.partial(), s = asm.stats();
      return {
        phase: s.phase || (bytes ? 'waiting' : ''), textChars: p.text.length, reasoningChars: p.reasoningChars,
        toolName: s.toolName, toolChars: s.toolChars, toolCalls: p.toolCalls, bytes: bytes, events: s.events,
        elapsedMs: Date.now() - startedAt, format: s.format,
        snapshot: function () { return asm.partial().text; }
      };
    }

    function emit(force) {
      if (!collector.onProgress || mode !== 'sse') return;
      var now = Date.now();
      if (!force && now - lastEmit < throttle) return;
      lastEmit = now;
      try { collector.onProgress(progress()); } catch (error) { /* 进度显示出错不影响接收 */ }
    }

    function handle(evt) {
      if (evt.comment !== undefined) return;
      var data = str(evt.data);
      if (data === '[DONE]') { sawDone = true; return; }
      if (!data.trim()) return;
      var payload;
      try { payload = JSON.parse(data); } catch (error) { return; }   /* 不是 JSON 的 data 行：不认 */
      if (evt.event === 'error' && isObject(payload) && payload.error === undefined) payload = { error: payload };
      asm.add(payload);
    }

    function write(chunk) {
      var text = str(chunk);
      if (!text || done) return;
      bytes += text.length;
      lastAt = Date.now();
      if (typeof collector.onActivity === 'function') { try { collector.onActivity(); } catch (error) { /* ignore */ } }
      if (!mode) {
        head += text;
        var lead = head.replace(/^\s+/, '');
        if (!lead) return;
        mode = lead.charAt(0) === '{' || lead.charAt(0) === '[' ? 'json' : 'sse';
        text = head;
        head = '';
      }
      if (mode === 'json') { raw += text; return; }
      decoder.push(text).forEach(handle);
      emit(false);
    }

    function finish() {
      if (done) throw new Error('接收器已经结束');
      done = true;
      if (mode === 'json') {
        var parsed;
        try { parsed = JSON.parse(raw); } catch (error) { throw new Error('模型接口返回了无效的 JSON'); }
        if (!Array.isArray(parsed)) return parsed;
        /* 不带 alt=sse 的 Gemini 流式接口回的是一整个分段数组：照样逐段组装。 */
        parsed.forEach(function (item) { asm.add(item); });
        var arrayFailure = asm.failure();
        if (arrayFailure) throw streamError(arrayFailure);
        return asm.result();
      }
      if (mode === 'sse') {
        decoder.end().forEach(handle);
        emit(true);
      }
      var failure = asm.failure();
      if (failure) throw streamError(failure);
      return asm.result();
    }

    /* 断流抢救用：已经收到的可见正文（去掉开头的思考块）与有没有工具调用。 */
    function partialOf() {
      if (mode !== 'sse') return { text: '', reasoningChars: 0, hasToolCalls: false };
      var p = asm.partial();
      return { text: p.text, reasoningChars: p.reasoningChars, hasToolCalls: p.toolCalls > 0 };
    }

    function stats() {
      var p = mode === 'sse' ? asm.partial() : { text: '', reasoningChars: 0, toolCalls: 0 };
      var s = asm.stats();
      return { mode: mode, format: s.format, bytes: bytes, events: s.events, textChars: p.text.length, reasoningChars: p.reasoningChars,
        toolCalls: p.toolCalls, toolChars: s.toolChars, done: sawDone, elapsedMs: (lastAt || Date.now()) - startedAt };
    }

    return collector;
  }

  /*
   * 读 fetch 的响应体：有 body.getReader() 与 TextDecoder 就边收边喂；没有（旧环境、测试里的假响应）就整段读完再喂。
   * 返回接收器组装好的响应。
   */
  async function readResponse(response, collector, Decoder) {
    var body = response && response.body;
    var TextDecoderCtor = Decoder || root.TextDecoder;
    if (body && typeof body.getReader === 'function' && typeof TextDecoderCtor === 'function') {
      var reader = body.getReader();
      var decoder = new TextDecoderCtor('utf-8');
      try {
        for (;;) {
          var step = await reader.read();
          if (step.done) break;
          if (step.value) collector.write(decoder.decode(step.value, { stream: true }));
        }
        collector.write(decoder.decode());
      } finally {
        try { reader.releaseLock(); } catch (error) { /* 已经结束 */ }
      }
    } else {
      collector.write(await response.text());
    }
    return collector.finish();
  }

  modules.llmStream = {
    SALVAGE_MIN: SALVAGE_MIN,
    createSseDecoder: createSseDecoder, createAssembler: createAssembler, createCollector: createCollector,
    readResponse: readResponse, visibleText: visible
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
