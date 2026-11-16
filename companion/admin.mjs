/*
 * 管理页：一个不带任何密钥的静态页面。管理密钥由页面脚本从地址里的 #key=… 取出（之后记在这个页面自己的 localStorage 里），
 * 每次请求放在 X-Admin-Key 请求头里。页面里所有来自外部的文字（来源、客户端名、UA、命令）都用 textContent 写入，不拼 HTML。
 * 脚本里不要用反引号与美元符加花括号：整页是一个模板字符串。
 */
export function adminPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reader-II 后端伴侣 · 管理页</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.65 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #15171c; color: #dfe3ec; }
  main { max-width: 860px; margin: 0 auto; padding: 20px 16px 60px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 16px; margin: 26px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #2c313c; }
  .sub { color: #8f97a8; font-size: 13px; }
  .card { background: #1e2129; border: 1px solid #2c313c; border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
  .card.ask { border-color: #d9a85a; }
  .code { font: 700 30px/1.2 ui-monospace, Consolas, monospace; letter-spacing: .18em; color: #f1d08a; }
  .origin { font-weight: 700; word-break: break-all; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
  button { font: inherit; color: inherit; background: #2a2f3a; border: 1px solid #3a4150; border-radius: 8px; padding: 6px 14px; cursor: pointer; }
  button.main { background: #d9a85a; border-color: #d9a85a; color: #2a1c0c; }
  button.bad { background: transparent; border-color: #e08a7a; color: #e08a7a; }
  button:disabled { opacity: .5; cursor: default; }
  input[type=text], textarea { font: 14px/1.5 ui-monospace, Consolas, monospace; width: 100%; box-sizing: border-box; background: #14161b; color: inherit; border: 1px solid #3a4150; border-radius: 8px; padding: 6px 8px; }
  textarea { min-height: 70px; }
  label.check { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 3px 8px 3px 0; vertical-align: top; border-bottom: 1px solid #262a33; word-break: break-all; }
  td.t { white-space: nowrap; color: #8f97a8; }
  .warn { color: #e2b25c; }
  .err { color: #e08a7a; }
  .ok { color: #8fbf8a; }
  .empty { color: #8f97a8; }
</style>
</head>
<body>
<main>
  <h1>Reader-II 后端伴侣</h1>
  <div class="sub" id="meta">正在连接…</div>
  <div id="gate"></div>
  <div id="app" hidden>
    <h2>等待放行的请求</h2>
    <p class="sub">酒馆页面里的夜梦助手申请使用这台设备。<b class="warn">放行期间，那个酒馆页面（连同里面装的所有扩展与角色卡脚本）可以在这台设备上运行命令、读写文件。</b>只在你信得过那个酒馆里装的东西、并且确实要让助手做设备上的事时放行；配对码要和助手面板上显示的一致。</p>
    <div id="pending"></div>
    <h2>已经放行的</h2>
    <div id="grants"></div>
    <h2>限制</h2>
    <div class="card">
      <label class="check"><input type="checkbox" id="cfg-exec"> 允许运行命令（关掉后也不能启动命令类的 MCP 服务器）</label>
      <label class="check"><input type="checkbox" id="cfg-browser"> 允许无头浏览器</label>
      <div class="sub" style="margin-top:8px">文件访问只限这些目录（每行一个绝对路径，可用 ~ 表示用户目录；留空表示不限）。注意：只要还允许运行命令，命令本身不受这个限制。</div>
      <textarea id="cfg-roots" spellcheck="false"></textarea>
      <div class="sub" style="margin-top:8px">浏览器路径（留空 = 自动找 Chrome / Chromium / Edge）</div>
      <input type="text" id="cfg-chrome" spellcheck="false">
      <div class="row"><button id="cfg-save">保存限制</button><span class="sub" id="cfg-note"></span></div>
    </div>
    <h2>正在运行的任务</h2>
    <div id="jobs"></div>
    <h2>最近的操作</h2>
    <div class="card"><table><tbody id="audit"></tbody></table></div>
    <p class="sub" id="where"></p>
  </div>
</main>
<script>
(function () {
  'use strict';
  var KEY_NAME = 'reader_ii_companion_admin_key';
  var key = '';
  var found = /[#&]key=([a-f0-9]{48})/.exec(location.hash);
  if (found) {
    key = found[1];
    try { localStorage.setItem(KEY_NAME, key); } catch (error) { /* 无痕模式 */ }
    try { history.replaceState(null, '', location.pathname); } catch (error) { /* ignore */ }
  } else {
    try { key = localStorage.getItem(KEY_NAME) || ''; } catch (error) { key = ''; }
  }
  var configDirty = false, configLoaded = false, timer = null;
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) {
      if (name === 'text') node.textContent = attrs[name];
      else if (name === 'on') Object.keys(attrs.on).forEach(function (type) { node.addEventListener(type, attrs.on[type]); });
      else node.setAttribute(name, attrs[name]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }
  function fill(node, children) { node.textContent = ''; children.forEach(function (child) { node.appendChild(child); }); }
  function api(method, path, body) {
    var headers = { 'X-Admin-Key': key };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }).then(function (response) {
      return response.json().then(function (data) { return { status: response.status, data: data }; });
    });
  }
  function clock(at) {
    var date = new Date(at);
    var pad = function (value) { return String(value).padStart(2, '0'); };
    var today = new Date().toDateString() === date.toDateString();
    return (today ? '' : (date.getMonth() + 1) + '/' + date.getDate() + ' ') + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }
  function act(path, body) {
    return api('POST', path, body).then(function (out) {
      if (!out.data || out.data.ok !== true) alert((out.data && out.data.error) || '没有成功');
      return refresh();
    }, function () { alert('连不上伴侣'); });
  }

  function gate(message) {
    $('app').hidden = true;
    var input = h('input', { type: 'text', placeholder: '管理密钥（48 位十六进制）', spellcheck: 'false' });
    fill($('gate'), [h('div', { class: 'card ask' }, [
      h('div', { class: 'err', text: message }),
      h('p', { class: 'sub', text: '请用伴侣启动时在控制台里打印的那个地址打开本页（形如 http://127.0.0.1:8790/#key=…）；同一个地址也写在伴侣数据目录的 admin-url.txt 里。也可以把密钥粘贴到这里：' }),
      input,
      h('div', { class: 'row' }, [h('button', { class: 'main', text: '确定', on: { click: function () {
        var typed = String(input.value || '').trim();
        var inner = /key=([a-f0-9]{48})/.exec(typed);
        key = inner ? inner[1] : typed;
        try { localStorage.setItem(KEY_NAME, key); } catch (error) { /* ignore */ }
        refresh();
      } } })])
    ])]);
  }

  function renderPending(list) {
    if (!list.length) { fill($('pending'), [h('p', { class: 'empty', text: '现在没有。在夜梦助手的设置页「后端伴侣」里点「申请放行」后，请求会出现在这里。' })]); return; }
    fill($('pending'), list.map(function (item) {
      var approve = function (ttl) { return function () { act('/admin/approve', { id: item.id, ttl: ttl }); }; };
      return h('div', { class: 'card ask' }, [
        h('div', { class: 'sub', text: '配对码' }), h('div', { class: 'code', text: item.code }),
        h('div', {}, [h('span', { class: 'sub', text: '来自 ' }), h('span', { class: 'origin', text: item.origin || '（没有带来源）' })]),
        h('div', { class: 'sub', text: [item.client, item.ua, item.remote ? '地址 ' + item.remote : '', clock(item.createdAt)].filter(Boolean).join(' · ') }),
        h('div', { class: 'row' }, [
          h('button', { class: 'main', text: '放行 2 小时', on: { click: approve('hours:2') } }),
          h('button', { text: '放行到伴侣重启', on: { click: approve('session') } }),
          h('button', { text: '长期放行', on: { click: function () { if (confirm('长期放行：这个酒馆页面今后一直可以使用这台设备，直到你在这里撤销。确定吗？')) act('/admin/approve', { id: item.id, ttl: 'always' }); } } }),
          h('button', { class: 'bad', text: '拒绝', on: { click: function () { act('/admin/deny', { id: item.id }); } } })
        ])
      ]);
    }));
  }

  function renderGrants(list, now) {
    if (!list.length) { fill($('grants'), [h('p', { class: 'empty', text: '没有。' })]); return; }
    var nodes = list.map(function (grant) {
      var until = grant.expiresAt ? '到 ' + clock(grant.expiresAt) + '（还有 ' + Math.max(0, Math.round((grant.expiresAt - now) / 60000)) + ' 分钟）' : grant.persistent ? '长期' : '到伴侣重启为止';
      return h('div', { class: 'card' }, [
        h('div', { class: 'origin', text: grant.origin || '（没有带来源）' }),
        h('div', { class: 'sub', text: [grant.label, until, '放行于 ' + clock(grant.createdAt)].filter(Boolean).join(' · ') }),
        h('div', { class: 'row' }, [h('button', { class: 'bad', text: '撤销', on: { click: function () { act('/admin/revoke', { id: grant.id }); } } })])
      ]);
    });
    if (list.length > 1) nodes.push(h('div', { class: 'row' }, [h('button', { class: 'bad', text: '全部撤销', on: { click: function () { act('/admin/revoke', { all: true }); } } })]));
    fill($('grants'), nodes);
  }

  function renderConfig(config) {
    if (configDirty && configLoaded) return;
    $('cfg-exec').checked = config.exec !== false;
    $('cfg-browser').checked = config.browser !== false;
    $('cfg-roots').value = (config.fsRoots || []).join('\\n');
    $('cfg-chrome').value = config.browserPath || '';
    configLoaded = true;
  }

  function renderJobs(list) {
    if (!list.length) { fill($('jobs'), [h('p', { class: 'empty', text: '没有。' })]); return; }
    fill($('jobs'), list.map(function (job) {
      return h('div', { class: 'card' }, [h('div', { text: job.command }), h('div', { class: 'sub', text: job.id + ' · ' + job.cwd + ' · 已运行 ' + Math.round(job.durationMs / 1000) + ' 秒' })]);
    }));
  }

  function renderAudit(list) {
    if (!list.length) { fill($('audit'), [h('tr', {}, [h('td', { class: 'empty', text: '还没有。' })])]); return; }
    fill($('audit'), list.map(function (entry) {
      return h('tr', {}, [h('td', { class: 't', text: clock(entry.at) }), h('td', { class: 't', text: entry.op }), h('td', { text: entry.summary })]);
    }));
  }

  function refresh() {
    if (timer) { clearTimeout(timer); timer = null; }
    var again = function () { timer = setTimeout(refresh, document.hidden ? 6000 : 2000); };
    if (!key) { $('meta').textContent = ''; gate('需要管理密钥。'); return Promise.resolve(); }
    return api('GET', '/admin/state').then(function (out) {
      if (out.status === 401) { gate('管理密钥不对。'); return; }
      var state = out.data || {};
      $('gate').textContent = '';
      $('app').hidden = false;
      $('meta').textContent = '版本 ' + state.version + ' · ' + (state.mode === 'plugin' ? '酒馆后端插件' : '独立运行') + ' · ' + state.platform;
      $('where').textContent = '数据目录：' + state.home + '　工作目录：' + state.workspace;
      renderPending(state.pending || []);
      renderGrants(state.grants || [], state.now || Date.now());
      renderConfig(state.config || {});
      renderJobs(state.jobs || []);
      renderAudit(state.audit || []);
      document.title = ((state.pending || []).length ? '（' + state.pending.length + '）' : '') + 'Reader-II 后端伴侣 · 管理页';
      again();
    }, function () {
      $('meta').textContent = '连不上伴侣（它可能已经退出）。';
      again();
    });
  }

  ['cfg-exec', 'cfg-browser', 'cfg-roots', 'cfg-chrome'].forEach(function (id) {
    $(id).addEventListener('input', function () { configDirty = true; });
    $(id).addEventListener('change', function () { configDirty = true; });
  });
  $('cfg-save').addEventListener('click', function () {
    var roots = String($('cfg-roots').value || '').split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    api('POST', '/admin/config', { exec: $('cfg-exec').checked, browser: $('cfg-browser').checked, fsRoots: roots, browserPath: String($('cfg-chrome').value || '').trim() }).then(function (out) {
      var ok = out.data && out.data.ok === true;
      $('cfg-note').textContent = ok ? '已保存' : ((out.data && out.data.error) || '没有保存成功');
      $('cfg-note').className = ok ? 'ok' : 'err';
      if (ok) { configDirty = false; refresh(); }
    });
  });
  refresh();
})();
</script>
</body>
</html>
`;
}
