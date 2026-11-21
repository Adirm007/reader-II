(function (root) {
  'use strict';
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var LIMIT = 128 * 1024 * 1024;
  var types = { image: /^image\/(png|jpeg|webp|gif)$/i, video: /^video\/(mp4|webm|ogg|quicktime)$/i };

  function inline(kind, mime, encoded) {
    if (!types[kind].test(mime) || typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(LIMIT / 3) * 4 || !/^[a-zA-Z0-9+/]+=*$/.test(encoded)) throw new Error('生成的媒体格式或大小不受支持');
    return { url:'data:' + mime.toLowerCase() + ';base64,' + encoded };
  }
  async function asMedia(response, kind, fallback, signal) {
    var mime = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (!mime || mime === 'application/octet-stream') mime = fallback;
    if (!types[kind].test(mime)) throw new Error('媒体地址返回了意外的内容类型 ' + mime);
    if (Number(response.headers.get('content-length')) > LIMIT) throw new Error('媒体超过 128 MiB，无法保存到对话');
    var pieces = [], length = 0;
    var reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (reader) {
      try {
        for (;;) {
          var next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > LIMIT || signal.aborted) {
            await reader.cancel();
            throw new Error(signal.aborted ? '已取消下载' : '媒体超过 128 MiB，无法保存到对话');
          }
          pieces.push(next.value);
        }
      } finally { reader.releaseLock(); }
    } else {
      var buffer = await response.arrayBuffer(); length = buffer.byteLength;
      if (length > LIMIT) throw new Error('媒体超过 128 MiB，无法保存到对话');
      pieces.push(new Uint8Array(buffer));
    }
    if (!length) throw new Error('媒体文件为空');
    var blob = new Blob(pieces, { type:mime });
    if (typeof FileReader === 'function') {
      return new Promise(function (resolve, reject) {
        var fileReader = new FileReader();
        function abort() { fileReader.abort(); }
        fileReader.onload = function () { resolve({ url:fileReader.result }); };
        fileReader.onerror = function () { reject(fileReader.error); };
        fileReader.onabort = function () { reject(new Error('已取消下载')); };
        fileReader.onloadend = function () { signal.removeEventListener('abort', abort); };
        signal.addEventListener('abort', abort, { once:true });
        fileReader.readAsDataURL(blob);
        if (signal.aborted) abort();
      });
    }
    var bytes = new Uint8Array(await blob.arrayBuffer()), encoded = [];
    // Multiples of three keep intermediate chunks free of padding.
    for (var offset = 0; offset < bytes.length; offset += 24576) encoded.push(btoa(String.fromCharCode.apply(null, bytes.subarray(offset, offset + 24576))));
    return { url:'data:' + mime + ';base64,' + encoded.join('') };
  }
  function httpUrl(value, base) {
    var url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('接口返回了无效媒体地址');
    return url;
  }

  modules.createMediaGenerator = function (d) {
    return async function generateMedia(kind, prompt, options) {
      if (kind !== 'image' && kind !== 'video') throw new Error('未知的媒体类型');
      options = options || {};
      var t = d.target(kind, options), google = t.source === 'makersuite' || t.source === 'vertexai';
      var mediaApi = t.api || (google && t.endpoint ? { apiurl:t.endpoint, model:t.model, source:t.source, key:t.settings.proxy_password || '' } : null);
      if (!t.configured) throw new Error('请先在设置中启用' + (kind === 'image' ? '图片' : '视频') + '生成');
      if (!t.model) throw new Error('请指定媒体模型');
      prompt = String(prompt || '').trim();
      if (!prompt) throw new Error('缺少媒体生成提示词');
      var signal = options.signal, controller = new AbortController(), timedOut = false;
      if (signal && signal.aborted) throw d.abortError();
      var abort = function () { controller.abort(); };
      if (signal) signal.addEventListener('abort', abort, { once:true });
      var timeout = Number(options.timeoutMs) || (kind === 'video' ? 900000 : 180000);
      var timer = setTimeout(function () { timedOut = true; abort(); }, Math.max(1, timeout));
      var endpoint = t.endpoint && httpUrl(t.endpoint).href.replace(/\/+$/, '');
      var auth = mediaApi && mediaApi.key ? (t.source === 'makersuite' ? { 'x-goog-api-key':mediaApi.key } : { Authorization:'Bearer ' + mediaApi.key }) : {};
      var fetcher = d.fetcher();
      var result = { text:'', images:[], videos:[] };

      async function request(url, init) {
        var response = await fetcher(url, Object.assign({ signal:controller.signal, credentials:'omit', redirect:'error' }, init));
        if (!t.api && t.source === 'custom' && (response.status === 401 || response.status === 403)) {
          throw Object.assign(new Error('当前自定义媒体端点拒绝授权。如密钥只存在酒馆密钥库，请选择带密钥的独立方案'), { status:response.status });
        }
        if (!response.ok) throw Object.assign(new Error('媒体接口返回 HTTP ' + response.status + '：' + await d.readFailure(response)), { status:response.status });
        return response;
      }
      async function post(url, body, headers, local) {
        var response = await request(url, { method:'POST', headers:Object.assign({ 'Content-Type':'application/json' }, headers),
          credentials:local ? 'same-origin' : 'omit', body:JSON.stringify(body) });
        return response.json();
      }
      async function download(url, media, mime) {
        var parsed = httpUrl(url, endpoint || undefined);
        var own = endpoint && parsed.origin === new URL(endpoint).origin;
        var headers = own ? auth : {};
        // The Fetch standard strips Authorization on cross-origin redirects. Google uses a custom
        // header which browsers would forward; use its documented key query on the original file URL.
        if (own && headers['x-goog-api-key']) {
          parsed.searchParams.set('key', headers['x-goog-api-key']);
          headers = Object.assign({}, headers); delete headers['x-goog-api-key'];
        }
        var follow = Object.keys(headers).every(function (key) { return key.toLowerCase() === 'authorization'; });
        var response = await request(parsed.href, { headers:headers, redirect:follow ? 'follow' : 'error', referrerPolicy:'no-referrer' });
        return asMedia(response, media, mime, controller.signal);
      }
      async function persistImages(reply) {
        if (!reply.images || !reply.images.length) throw new Error('模型没有返回图片' + (reply.text ? '：' + reply.text.slice(0,160) : ''));
        result.text = reply.text || '';
        for (var item of reply.images) {
          if (item.url.startsWith('data:')) {
            var comma = item.url.indexOf(',');
            result.images.push(inline('image', item.url.slice(5, item.url.indexOf(';')), item.url.slice(comma + 1)));
          } else result.images.push(await download(item.url, 'image', 'image/png'));
        }
        return result;
      }
      async function poll(url, job, done) {
        var delayMs = 0, transientFailures = 0;
        while (!done(job)) {
          if (delayMs) await d.delay(delayMs, controller.signal);
          try {
            job = await (await request(url, { headers:auth })).json();
            transientFailures = 0;
          } catch (error) {
            if (controller.signal.aborted || ![429,500,502,503,504].includes(error.status) || ++transientFailures > 3) throw error;
          }
          delayMs = delayMs ? Math.min(8000, delayMs * 1.5) : 2000;
        }
        return job;
      }
      try {
        if (!fetcher) throw new Error('当前环境无法访问媒体接口');
        if (!t.api && endpoint) {
          if (t.source === 'custom' && t.settings.custom_include_headers) {
            var rawHeaders = String(t.settings.custom_include_headers);
            var parsedHeaders;
            try { parsedHeaders = JSON.parse(rawHeaders); }
            catch (_) {
              var lib = d.env.hostImport && await d.env.hostImport('/lib.js');
              if (!lib || !lib.yaml) throw new Error('当前宿主无法读取自定义端点的请求头，请配置独立方案');
              parsedHeaders = lib.yaml.parse(rawHeaders);
            }
            if (Array.isArray(parsedHeaders)) parsedHeaders = Object.assign.apply(Object, [{}].concat(parsedHeaders));
            Object.entries(parsedHeaders || {}).forEach(function (entry) {
              // Match the browser's forbidden request-header policy; private host cookies never belong on this connection.
              if (/^(?:cookie|host|origin|referer|proxy-|sec-|content-length$)/i.test(entry[0])) return;
              auth[entry[0]] = String(entry[1]);
            });
          } else if (t.source !== 'custom' && t.settings.proxy_password) {
            auth = t.source === 'makersuite' ? { 'x-goog-api-key':t.settings.proxy_password } : { Authorization:'Bearer ' + t.settings.proxy_password };
          }
        }
        if (kind === 'image') {
          var requestOpts = { route:'agent', api:t.api, modelOverride:t.model, messages:[{ role:'user',content:prompt }],
            imageMode:options.imageMode, retries:0, timeoutMs:timeout, signal:controller.signal };
          var chatImage = options.imageMode === 'chat' || d.imageChatModel(t.model);
          if (t.source === 'makersuite' && mediaApi) {
            var googleBase = d.baseUrl(mediaApi, 'v1beta');
            var method = /^imagen-/i.test(t.model) ? ':predict' : ':generateContent';
            var googleBody = method === ':predict' ? { instances:[{ prompt:prompt }], parameters:{ sampleCount:1 } }
              : { contents:[{ role:'user', parts:[{ text:prompt }] }], generationConfig:{ responseModalities:['TEXT','IMAGE'] } };
            var raw = await post(googleBase + '/models/' + encodeURIComponent(t.model) + method, googleBody, auth);
            if (method === ':predict') {
              var predictions = raw.predictions || [];
              predictions.forEach(function (prediction) { result.images.push(inline('image', prediction.mimeType || 'image/png', prediction.bytesBase64Encoded)); });
              if (!result.images.length) throw new Error('Imagen 没有返回图片');
              return result;
            }
            return await persistImages(d.parseReply(raw));
          }
          if (google && !t.api && /^imagen-/i.test(t.model) && !endpoint) {
            var imagen = await post('/api/google/generate-image', { api:t.source, model:t.model, prompt:prompt }, t.ctx.getRequestHeaders(), true);
            result.images.push(inline('image', 'image/jpeg', imagen.image)); return result;
          }
          if (chatImage || google) {
            requestOpts.imageMode = 'chat';
            return await persistImages(await d.gateway.chatReply(requestOpts));
          }
          if (!t.api && endpoint && (t.source === 'custom' || t.source === 'openai')) {
            var generated = await post(endpoint + '/images/generations', { model:t.model, prompt:prompt, n:1 }, auth);
            return await persistImages(d.parseReply(generated));
          }
          return await persistImages(await d.requestImages(t.api, requestOpts.messages, requestOpts));
        }
        var seconds = options.seconds == null ? undefined : Number(options.seconds), size = options.size || undefined;
        if (seconds !== undefined && (!Number.isSafeInteger(seconds) || seconds <= 0)) throw new Error('视频时长必须是正整数');
        if (!t.api && !endpoint && t.ctx.getRequestHeaders && (t.source === 'openai' || google)) {
          var hostData = await post(google ? '/api/google/generate-video' : '/api/openai/generate-video',
            { api:t.source, prompt:prompt, model:t.model, seconds:seconds && (google ? seconds : String(seconds)), size:size, aspect_ratio:options.aspectRatio }, t.ctx.getRequestHeaders(), true);
          result.videos.push(inline('video', 'video/mp4', google ? hostData.video : hostData.data));
          return result;
        }
        if (!endpoint) throw new Error('请为视频选择独立方案，或选择酒馆的官方视频连接');
        if (google) {
          if (t.source === 'vertexai') throw new Error('此 Vertex 视频连接请通过酒馆主连接使用，或配置 Google AI Studio Veo 接口');
          var base = d.baseUrl({ apiurl:endpoint }, 'v1beta');
          var started = await post(base + '/models/' + encodeURIComponent(t.model) + ':predictLongRunning',
            { instances:[{ prompt:prompt }], parameters:{ durationSeconds:seconds, aspectRatio:options.aspectRatio } }, auth);
          if (!started.name || !/^(?:[\w.-]+\/)*operations\/[\w.-]+$/.test(started.name) || started.name.split('/').some(function (s) { return s === '..' || s === '.'; })) throw new Error('Veo 没有返回有效的任务编号');
          var operation = await poll(base + '/' + started.name, started, function (job) { return job.done === true || !!job.error; });
          if (operation.error) throw new Error('Veo 生成失败：' + String(operation.error.message || '服务端报错').slice(0,280));
          var output = operation.response || {}, sample = (output.generateVideoResponse && output.generateVideoResponse.generatedSamples || output.generatedVideos || [])[0];
          var video = sample && sample.video;
          if (!video) throw new Error('Veo 未返回视频');
          result.videos.push(video.uri ? await download(video.uri, 'video', 'video/mp4') : inline('video', video.mimeType || 'video/mp4', video.bytesBase64Encoded || video.videoBytes));
        } else {
          if (!['openai','custom'].includes(t.source)) throw new Error('此连接没有支持的视频生成协议');
          var job = await post(endpoint + '/videos', { model:t.model, prompt:prompt, seconds:seconds && String(seconds), size:size }, auth);
          if (!job.id || !/^[\w.-]+$/.test(job.id) || /^\.{1,2}$/.test(job.id)) throw new Error('视频接口未返回有效的任务编号');
          var jobUrl = endpoint + '/videos/' + encodeURIComponent(job.id);
          var finished = await poll(jobUrl, job, function (status) { return !!status.error || ['completed','failed','cancelled','canceled','expired'].includes(status.status); });
          if (finished.status !== 'completed' || finished.error) throw new Error('视频生成失败：' + String(finished.error && finished.error.message || finished.status).slice(0,280));
          result.videos.push(await download(jobUrl + '/content', 'video', 'video/mp4'));
        }
        return result;
      } catch (error) {
        if (timedOut) throw Object.assign(new Error('媒体生成超时'), { name:'TimeoutError' });
        if (signal && signal.aborted) throw d.abortError();
        throw error;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
      }
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
