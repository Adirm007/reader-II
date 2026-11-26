(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var nextId = 0;

  // Tauri 的同源生成路由最终调用这个宿主 ABI。浏览器酒馆通过同源 XHR 进入相同的后端路由。
  function transport(env) {
    var host = env && env.host;
    if (!host) return null;
    var abi = host.__TAURITAVERN__;
    if (abi && abi.invoke && typeof abi.invoke.safeInvoke === 'function') return { abi: abi };
    if (abi || typeof host.XMLHttpRequest !== 'function') return null;
    var ctx = host.SillyTavern && typeof host.SillyTavern.getContext === 'function' && host.SillyTavern.getContext();
    return ctx && typeof ctx.getRequestHeaders === 'function' ? { ctx: ctx } : null;
  }

  function abortError() {
    var error = new Error('已取消');
    error.name = 'AbortError';
    return error;
  }

  function requestError(value, status) {
    var detail = value && (value.error && value.error.message || value.message || value.error);
    var message = typeof detail === 'string' ? detail : typeof value === 'string' ? value : '酒馆生成请求失败';
    if (/generation cancelled by user|endpoint authorization cancelled by user/i.test(message) || value && value.name === 'AbortError') return abortError();
    var error = new Error((status ? 'HTTP ' + status + '：' : '') + message.slice(0, 400));
    if (status) error.status = status;
    return error;
  }

  // safeInvoke 把 Rust CommandError 保存为 Error.cause，例如 {BadRequest: '…'}。
  function nativeError(error) {
    var cause = error && error.cause;
    var variant = cause && typeof cause === 'object' && Object.keys(cause)[0];
    if (variant === 'Cancelled') return abortError();
    var statusByVariant = { BadRequest: 400, Unauthorized: 401, NotFound: 404, Conflict: 409, TooManyRequests: 429, InternalServerError: 500 };
    return requestError(error, error && error.status || statusByVariant[variant]);
  }

  modules.hasAgentCompletionTransport = function (env) { return !!transport(env); };
  /* 只有浏览器的同源 XHR 能边收边读（onprogress）；TauriTavern 的 safeInvoke 一次性返回整份 JSON，不流式。 */
  modules.agentCompletionStreams = function (env) { var route = transport(env); return !!(route && route.ctx); };

  /*
   * 没有这两种宿主接口时同步返回 null，交给调用方选择兼容路径。每次调用最多发送一次。
   * options.collector（reader-llm-stream.js 的接收器）：流式接收。XHR 每次 onprogress 把新到的文字喂给它，
   * 结束时交出组装好的响应；响应体不是 SSE 时接收器自己按 JSON 解析。这时 timeoutMs 按「连续多久没有新数据」计。
   * Tauri 通道忽略 collector，照旧整份返回。
   */
  modules.sendAgentCompletion = function (env, body, signal, timeoutMs, options) {
    var route = transport(env);
    if (!route) return null;
    var host = env.host;
    var collector = route.ctx && options && options.collector ? options.collector : null;
    return new Promise(function (resolve, reject) {
      var settled = false, cancel = null, timer = null;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value);
      }
      function interrupt(error) {
        if (settled) return;
        finish(error);
        if (cancel) {
          try { Promise.resolve(cancel()).catch(function () {}); } catch (_) { /* 宿主可能已结束请求 */ }
        }
      }
      function onAbort() { interrupt(abortError()); }
      function arm() {
        if (!(Number(timeoutMs) > 0)) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(function () {
          var error = new Error(collector ? '模型响应超时（连续 ' + Math.round(timeoutMs / 1000) + ' 秒没有收到新数据）' : '模型响应超时');
          error.name = 'TimeoutError';
          interrupt(error);
        }, timeoutMs);
      }
      if (signal && signal.aborted) { onAbort(); return; }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      arm();

      async function sendNative() {
        var abi = route.abi;
        var dto = body.stream ? Object.assign({}, body, { stream: false }) : body;
        if (body.chat_completion_source === 'opencode') {
          var stableId = await abi.api.chat.current.handle().stableId();
          if (settled) return;
          dto = Object.assign({}, dto, { _tauritavern_stable_chat_id: stableId });
        }
        var requestId = host.crypto && typeof host.crypto.randomUUID === 'function'
          ? host.crypto.randomUUID() : 'reader-' + Date.now().toString(36) + '-' + (++nextId).toString(36);
        var locale = String(host.document && host.document.documentElement && host.document.documentElement.lang
          || host.navigator && host.navigator.language || 'en').toLowerCase();
        cancel = function () { return abi.invoke.safeInvoke('cancel_chat_completion_generation', { requestId: requestId }); };
        return abi.invoke.safeInvoke('generate_chat_completion', { requestId: requestId, dto: dto, locale: locale });
      }
      if (route.abi) {
        sendNative().then(function (data) { finish(null, data); }, function (error) {
          finish(nativeError(error));
        });
        return;
      }

      try {
        var xhr = new host.XMLHttpRequest();
        xhr.open('POST', '/api/backends/chat-completions/generate', true);
        var headers = Object.assign({ 'Content-Type': 'application/json' }, route.ctx.getRequestHeaders());
        Object.keys(headers).forEach(function (name) { xhr.setRequestHeader(name, headers[name]); });
        var cursor = 0;
        var ok = function () { return xhr.status >= 200 && xhr.status < 300; };
        /* 只把新到的那一段交给接收器；报错的响应（4xx / 5xx）不喂，等 onload 按报错处理。 */
        var feed = function () {
          var text = String(xhr.responseText || '');
          if (text.length <= cursor) return;
          var piece = text.slice(cursor);
          cursor = text.length;
          collector.write(piece);
        };
        if (collector) {
          xhr.onprogress = function () {
            if (settled || !ok()) return;
            arm();
            try { feed(); } catch (error) { interrupt(error); }
          };
        }
        xhr.onload = function () {
          var data;
          if (collector && ok()) {
            try { feed(); data = collector.finish(); } catch (error) { finish(error); return; }
            finish(null, data);
            return;
          }
          try { data = JSON.parse(xhr.responseText); } catch (_) {
            finish(xhr.status >= 200 && xhr.status < 300 ? new Error('酒馆生成接口返回了无效的 JSON') : requestError(xhr.responseText, xhr.status));
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300) finish(requestError(data, xhr.status));
          else finish(null, data);
        };
        xhr.onerror = function () { finish(new Error('酒馆生成请求网络错误')); };
        xhr.onabort = function () { finish(abortError()); };
        cancel = function () { xhr.abort(); };
        xhr.send(JSON.stringify(body));
      } catch (error) { finish(error); }
    });
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
