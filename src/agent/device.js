(function (root) {
  'use strict';

  /*
   * 后端伴侣（companion/）的前端这一半：连接与放行、device 工具箱、dev:/ 挂载点。
   *
   * 伴侣是可选的。它有两种装法，对前端来说只是地址不同：
   *   酒馆后端插件   /api/plugins/reader-ii（与酒馆同源，走酒馆自己的登录与 CSRF）
   *   独立运行       http://127.0.0.1:8790 之类（用户在设置里填）
   *
   * 放行：前端发起配对请求 → 伴侣给一个 4 位配对码 → 用户到「设备本机」的管理页（另一个端口，页面里的脚本够不到）
   * 核对配对码并点放行 → 前端拿到令牌。令牌有期限（用户在管理页上选），存在本机 secrets 里。
   * 没放行、过期、被撤销时，所有操作都会被伴侣拒绝。这道门在伴侣那边，前端只是照做。
   *
   * 没有伴侣时（TauriTavern、手机、没装）：device 工具箱与 dev:/ 仍然登记着，调用时给出一句明白的说明，不报别的错。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var PLUGIN_BASE = '/api/plugins/reader-ii';
  var API_VERSION = 1;
  var NEED_GRANT = '后端伴侣还没有放行，或放行已经到期。请告诉用户：打开助手设置里的「后端伴侣」，点「申请放行」，再到装着伴侣的那台设备上的管理页里批准。在那之前不要再试设备上的操作。';

  function normalizeCompanionSettings(input) {
    var source = modules.isObject(input) ? input : {};
    var url = typeof source.url === 'string' ? source.url.trim().replace(/\/+$/, '').slice(0, 200) : '';
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) url = '';
    return { url: url };
  }

  function createCompanionClient(env, kit, deps) {
    var host = env.host, net = deps.net, secrets = deps.secrets;
    var state = { info: null, grant: null, checkedAt: 0, error: '', checking: null, base: '' };

    function base() { return normalizeCompanionSettings(typeof deps.settings === 'function' ? deps.settings() : null).url || PLUGIN_BASE; }
    function saved() {
      var value = secrets.get('companion');
      return modules.isObject(value) && value.base === base() && value.token ? value : null;
    }

    function missingText() {
      var tauri = !!host.__TAURITAVERN__;
      var mobile = /Android|iPhone|iPad|Mobile/i.test(String(host.navigator && host.navigator.userAgent || ''));
      return '这里没有连接后端伴侣，所以不能在设备上跑命令、读写设备文件或开无头浏览器。'
        + (tauri ? 'TauriTavern 装不了酒馆后端插件；电脑上可以单独运行伴侣（node companion/standalone.mjs），再把地址填进助手设置的「后端伴侣」。'
          : mobile ? '手机上要在 Termux 里给酒馆装上伴侣插件才行，不强求；做前后端这类事建议在电脑上。'
            : '安装办法见 Reader-II 的 README「后端伴侣」一节：把 companion 装进酒馆的 plugins/ 并打开 enableServerPlugins，然后在助手设置的「后端伴侣」里申请放行。')
        + '如实告诉用户，不要换别的办法硬做。';
    }

    async function http(method, path, body, options) {
      var opts = options || {};
      var target = base();
      var same = target[0] === '/';
      var headers = same ? net.tavernHeaders() : { 'Content-Type': 'application/json' };
      var grant = saved();
      if (opts.token !== false && grant) headers['X-Reader-II-Token'] = grant.token;
      var limit = opts.timeoutMs || 15000;
      var watch = net.guard(opts.signal, limit);
      try {
        var init = { method: method, headers: headers, cache: 'no-store', signal: watch.signal };
        if (!same) { init.credentials = 'omit'; init.mode = 'cors'; }
        if (body !== undefined) init.body = JSON.stringify(body);
        var response = await host.fetch(target + path, init);
        var data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        return { status: response.status, data: data };
      } catch (error) {
        if (opts.signal && opts.signal.aborted) throw net.abortError();
        throw new Error(watch.timedOut() ? '后端伴侣超过 ' + Math.round(limit / 1000) + ' 秒没有回应' : '连不上后端伴侣（' + target + '）');
      } finally { watch.done(); }
    }

    function snapshot() {
      return {
        base: base(), found: !!state.info, granted: !!(state.info && state.grant), error: state.error,
        info: state.info ? modules.clone(state.info) : null, grant: state.grant ? modules.clone(state.grant) : null, saved: !!saved()
      };
    }

    /* 看一眼伴侣在不在、令牌还有没有效。一分钟内不重复问。 */
    function status(force) {
      if (state.base !== base()) { state.info = null; state.grant = null; state.checkedAt = 0; state.base = base(); }
      if (!force && state.checkedAt && Date.now() - state.checkedAt < 60000) return Promise.resolve(snapshot());
      if (state.checking) return state.checking;
      state.checking = (async function () {
        try {
          var out = await http('GET', '/status', undefined, { timeoutMs: 8000 });
          var data = out.data;
          if (out.status !== 200 || !modules.isObject(data) || data.name !== 'reader-ii-companion') {
            state.info = null; state.grant = null; state.error = '没有检测到后端伴侣';
          } else if (data.api !== API_VERSION) {
            state.info = null; state.grant = null; state.error = '伴侣与扩展的版本对不上（伴侣的接口版本是 ' + data.api + '）：请把两边更新到同一版本';
          } else {
            state.info = data; state.grant = modules.isObject(data.grant) ? data.grant : null; state.error = '';
          }
        } catch (error) {
          state.info = null; state.grant = null; state.error = String(error && error.message || error);
        }
        state.checkedAt = Date.now();
        state.checking = null;
        return snapshot();
      })();
      return state.checking;
    }

    /* 调伴侣的一个操作。失败时抛出带说明的错误（原样交给模型）。 */
    async function call(op, payload, options) {
      if (!state.info || state.base !== base()) await status(true);
      if (!state.info) throw new Error(missingText());
      var out = await http('POST', '/op/' + op, payload || {}, options);
      var data = out.data || {};
      if (out.status === 401 || data.code === 'no_grant') { state.grant = null; throw new Error(NEED_GRANT); }
      if (data.ok !== true) {
        var error = new Error(String(data.error || '后端伴侣出错（HTTP ' + out.status + '）').slice(0, 3000));
        error.code = data.code || '';
        throw error;
      }
      return data.result;
    }

    function sleep(ms, signal) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(resolve, ms);
        if (signal) signal.addEventListener('abort', function () { clearTimeout(timer); reject(net.abortError()); }, { once: true });
      });
    }

    /*
     * 申请放行。onUpdate({ stage: 'waiting', code, adminUrl }) 让界面显示配对码；
     * 用户在设备本机的管理页批准后返回 snapshot()。
     */
    async function pair(onUpdate, signal) {
      await status(true);
      if (!state.info) throw new Error(state.error || '没有检测到后端伴侣');
      var asked = await http('POST', '/pair', { client: 'Reader-II ' + String(deps.version || ''), ua: String(host.navigator && host.navigator.userAgent || '').slice(0, 160) }, { token: false, signal: signal });
      if (!asked.data || asked.data.ok !== true) throw new Error(String(asked.data && asked.data.error || '伴侣没有接受配对请求'));
      if (typeof onUpdate === 'function') onUpdate({ stage: 'waiting', code: asked.data.code, adminUrl: asked.data.adminUrl || state.info.adminUrl || '' });
      var deadline = Date.now() + Math.max(60, Number(asked.data.expiresInSec) || 600) * 1000;
      while (Date.now() < deadline) {
        await sleep(1500, signal);
        var polled = await http('GET', '/pair/' + encodeURIComponent(asked.data.id), undefined, { token: false, signal: signal });
        var data = polled.data || {};
        if (data.state === 'approved' && data.token) {
          secrets.set('companion', { base: base(), token: String(data.token), expiresAt: Number(data.expiresAt) || 0 });
          return status(true);
        }
        if (data.state === 'denied') throw new Error('管理页上拒绝了这次请求');
        if (data.state === 'expired' || polled.status === 404) throw new Error('配对请求过期了，请重新申请');
      }
      throw new Error('等了太久没有放行，请重新申请');
    }

    async function release() {
      if (saved()) { try { await http('POST', '/release', {}); } catch (error) { /* 伴侣不在也照样清掉本机的令牌 */ } }
      secrets.set('companion', undefined);
      state.grant = null;
      return snapshot();
    }

    function brief() {
      if (state.info && state.grant) return '后端伴侣：已连接并放行（' + String(state.info.platform || '') + '）。设备上的文件在 dev:/，命令与无头浏览器在 device 工具箱；要用还需要「设备全权」档位。';
      if (state.info) return '后端伴侣：已检测到，但还没放行（用户要在设置页「后端伴侣」里申请放行）。';
      return '';
    }

    return {
      status: status, call: call, pair: pair, release: release, brief: brief, snapshot: snapshot, missingText: missingText,
      ready: function () { return !!(state.info && state.grant) && state.base === base(); },
      /* 助手能不能用伴侣：除了已经放行，还要当前是「设备全权」档位。联网换路、MCP 经伴侣都看这个——
         档位不是设备全权时，助手完全不碰伴侣（与设置页上写的一致）。 */
      usable: function () { return !!(state.info && state.grant) && state.base === base() && (typeof deps.allowed !== 'function' || deps.allowed() === true); },
      hasSaved: function () { return !!saved(); }
    };
  }

  function installDeviceTools(registry, vfs, env, kit, deps) {
    var companion = deps.companion;
    var enc = modules.vfsEnc;

    /* ---------- dev:/ ---------- */
    vfs.mount({
      id: 'dev', title: '设备上的文件（要后端伴侣与「设备全权」）',
      hint: 'dev:/~/… 用户目录 · dev:/@ws/… 伴侣的工作目录 · dev:/C:/… 或 dev:/home/… 绝对路径',
      scope: function () { return 'device'; },
      list: async function (segs, options) {
        if (!segs.length && !companion.ready()) {
          /* 列挂载点时不该报错：给一行说明。 */
          await companion.status(false);
          if (!companion.ready()) return { items: [{ name: '（没有连接后端伴侣，或还没放行：见助手设置的「后端伴侣」）' }], total: 1 };
        }
        var out = await companion.call('fs_list', { segs: segs, offset: Math.max(0, Math.trunc(Number(options && options.offset) || 0)), limit: Math.max(1, Math.min(2000, Math.trunc(Number(options && options.limit) || 100))) });
        return { items: out.items || [], total: Number(out.total) || 0 };
      },
      read: async function (segs) {
        if (!segs.length) return null;
        var out = await companion.call('fs_read', { segs: segs }, { timeoutMs: 30000 });
        if (out.missing || out.dir) return null;
        if (out.binary) return '（二进制文件，' + out.bytes + ' 字节；需要处理它的话用 device_exec）';
        if (out.tooLarge) throw new Error('这个文件有 ' + Math.round(out.bytes / 1024) + ' KB，太大了：先用 grep 定位，或在 device_exec 里用 head / tail / sed 取一段');
        return String(out.text);
      },
      write: async function (segs, text) {
        if (!segs.length) throw new Error('要写到一个具体的文件，例如 dev:/@ws/notes.md');
        await companion.call('fs_write', { segs: segs, text: String(text) }, { timeoutMs: 30000 });
      },
      remove: async function (segs) {
        if (!segs.length) throw new Error('要指明删除哪个文件');
        await companion.call('fs_remove', { segs: segs });
      },
      /* 检索交给伴侣在设备上做，不把文件一个个搬到浏览器里。 */
      grep: async function (segs, pattern, options) {
        var out = await companion.call('fs_grep', { segs: segs, pattern: pattern, flags: options.flags, context: options.context, limit: options.limit }, { signal: options.signal, timeoutMs: 90000 });
        var basePath = String(options.canonical || 'dev:/').replace(/\/+$/, '');
        var hits = (out.hits || []).map(function (hit) {
          var path = out.single ? basePath : basePath + '/' + String(hit.rel).split('/').map(enc).join('/');
          if (Array.isArray(hit.lines)) return path + '\n' + modules.vfsNumbered(hit.lines, hit.from);
          return path + ':' + hit.line + ': ' + hit.text;
        });
        if (out.note) hits.push(String(out.note));
        return { hits: hits, total: Number(out.total) || 0, files: Number(out.files) || 0, scanned: Number(out.scanned) || 0 };
      }
    });

    /* ---------- device 工具箱 ---------- */
    registry.registerToolset({
      name: 'device', source: 'builtin',
      summary: '设备（要后端伴侣与「设备全权」档位）：跑命令、后台任务、无头浏览器、环境探测与安装依赖；设备上的文件直接用 dev:/ 挂载点。做之前先读知识 device'
    });
    var tool = function (def) { registry.registerTool(Object.assign({ toolset: 'device', source: 'builtin', scope: 'device' }, def)); };
    var clamp = function (value, minimum, maximum, fallback) {
      var number = Math.trunc(Number(value));
      return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
    };

    function execText(out) {
      var output = String(out.output || '');
      if (out.running) {
        return '还在运行（任务 ' + out.id + '）。目前的输出：\n' + (output || '（暂无）') + '\n— 用 device_job 看后续：action=log 取新输出，action=status 看是否结束，action=kill 停掉。';
      }
      var head = '退出码 ' + (out.exitCode === null || out.exitCode === undefined ? '（被信号 ' + (out.signal || '?') + ' 终止）' : out.exitCode) + '，用时 ' + (Math.round((Number(out.durationMs) || 0) / 100) / 10) + ' 秒';
      if (out.truncated) head += '；输出共 ' + out.totalChars + ' 字，这里只有末尾一段（完整输出：device_job action=log id=' + out.id + ' offset=0）';
      return head + '\n' + (output || '（没有输出）');
    }

    tool({
      name: 'device_env', effect: 'read', volatile: true,
      summary: '看设备环境：系统、Node、常用工具（git、python、npm 等）有没有、版本多少、缺的怎么装，伴侣的工作目录在哪。动手前先看一眼。',
      params: [{ name: 'refresh', type: 'boolean', desc: 'true 时重新探测（装完东西之后）' }],
      run: async function (args, ctx) { return companion.call('env', { refresh: args.refresh === true }, { signal: ctx && ctx.signal, timeoutMs: 40000 }); }
    });

    tool({
      name: 'device_exec', effect: 'danger', irreversible: true,
      target: function (args) { return 'cmd:' + String(args.command || ''); },
      describe: function (args) { return '在设备上运行命令：' + String(args.command || '').slice(0, 300) + (args.cwd ? '（目录 ' + args.cwd + '）' : ''); },
      summary: '在设备上运行一条命令（非交互：不能等人输入），返回退出码与输出。超过 timeout 还没结束会转成后台任务继续跑；明知道要跑很久（装依赖、起服务）就直接 background=true。命令撤销不了，动手前想清楚，先说明要做什么。',
      params: [
        { name: 'command', type: 'string', required: true, desc: '完整命令行。Windows 上默认用 cmd，其它系统用 sh' },
        { name: 'cwd', type: 'string', desc: '工作目录：dev:/… 路径或设备上的绝对路径；默认是伴侣的工作目录' },
        { name: 'timeout', type: 'number', desc: '等几秒，默认 60，最多 900' },
        { name: 'background', type: 'boolean', desc: 'true 时立刻返回任务号，不等它结束' },
        { name: 'shell', type: 'string', desc: 'Windows 上可填 powershell；一般不用填' },
        { name: 'stdin', type: 'string', desc: '写进标准输入的内容' }
      ],
      run: async function (args, ctx) {
        var signal = ctx && ctx.signal;
        var payload = { command: String(args.command), timeoutSec: clamp(args.timeout, 1, 900, 60), background: args.background === true, rid: Date.now().toString(36) + Math.random().toString(36).slice(2, 10) };
        if (args.cwd) {
          if (/^dev:\/?/i.test(String(args.cwd))) payload.cwdSegs = vfs.parse(args.cwd).segs;
          else payload.cwd = String(args.cwd);
        }
        if (args.shell) payload.shell = String(args.shell);
        if (args.stdin !== undefined) payload.stdin = String(args.stdin);
        try {
          return execText(await companion.call('exec', payload, { signal: signal, timeoutMs: (payload.timeoutSec + 20) * 1000 }));
        } catch (error) {
          /* 用户点了停止：设备上的进程也要停，不能留它在后台跑。 */
          if (error && error.name === 'AbortError') companion.call('job', { action: 'kill', rid: payload.rid }).catch(function () { /* 尽力而为 */ });
          throw error;
        }
      }
    });

    tool({
      name: 'device_job', volatile: true,
      effect: function (args) { return args.action === 'kill' ? 'danger' : 'read'; },
      describe: function (args) { return args.action === 'kill' ? '停掉设备上的任务 ' + String(args.id || '') : '查看设备上的任务'; },
      summary: '查看或停掉 device_exec 起的任务。action=list 列出全部；status 看一个任务是否结束；log 取输出（offset 是上次读到的位置）；kill 停掉它。',
      params: [{ name: 'action', type: 'string', required: true, desc: 'list | status | log | kill' }, { name: 'id', type: 'string', desc: '任务号' }, { name: 'offset', type: 'number', desc: 'log 从第几个字开始' }],
      run: async function (args, ctx) {
        var action = ['list', 'status', 'log', 'kill'].indexOf(args.action) >= 0 ? args.action : 'list';
        return companion.call('job', { action: action, id: args.id ? String(args.id) : '', offset: clamp(args.offset, 0, 100000000, 0) }, { signal: ctx && ctx.signal });
      }
    });

    tool({
      name: 'device_browser', volatile: true,
      effect: function (args) { return ['text', 'console', 'screenshot', 'close', 'status'].indexOf(args.action) >= 0 ? 'read' : 'write'; },
      irreversible: function (args) { return ['text', 'console', 'screenshot', 'close', 'status'].indexOf(args.action) < 0; },
      target: function (args) { return args.action === 'open' ? String(args.url || '') : 'browser:' + String(args.action || ''); },
      describe: function (args) { return '无头浏览器：' + String(args.action || '') + (args.url ? ' ' + String(args.url).slice(0, 160) : args.selector ? ' ' + String(args.selector).slice(0, 80) : ''); },
      summary: '设备上的无头浏览器（用设备里已有的 Chrome / Chromium / Edge，独立的临时用户目录，不碰用户自己的浏览器）。用来试你做的前端页面、看需要跑脚本才出内容的网页。action：open 打开网址并等它加载完 → text 取页面文字 / eval 在页面里跑一段脚本 / click、type 操作元素 / console 看报错 / screenshot 截图存进工作目录 / close 关掉。',
      params: [
        { name: 'action', type: 'string', required: true, desc: 'open | text | eval | click | type | console | screenshot | close' },
        { name: 'url', type: 'string', desc: 'open 用' },
        { name: 'selector', type: 'string', desc: 'click / type 用的 CSS 选择器；text 也可以用它只取一部分' },
        { name: 'text', type: 'string', desc: 'type 要输入的文字' },
        { name: 'code', type: 'string', desc: 'eval 的函数体，可用 await，用 return 给出结果' },
        { name: 'wait', type: 'number', desc: 'open 之后再等几毫秒（页面要异步渲染时），默认 300' }
      ],
      run: async function (args, ctx) {
        return companion.call('browser', { action: String(args.action || ''), url: args.url, selector: args.selector, text: args.text, code: args.code, waitMs: clamp(args.wait, 0, 20000, 300) }, { signal: ctx && ctx.signal, timeoutMs: 70000 });
      }
    });
  }

  modules.COMPANION_PLUGIN_BASE = PLUGIN_BASE;
  modules.normalizeCompanionSettings = normalizeCompanionSettings;
  modules.createCompanionClient = createCompanionClient;
  modules.installDeviceTools = installDeviceTools;
})(typeof globalThis !== 'undefined' ? globalThis : window);
