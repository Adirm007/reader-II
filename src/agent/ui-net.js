(function (root) {
  'use strict';

  /*
   * 设置页里与「联网 / MCP / 后端伴侣」有关的三块（交接 0.6 乙组）。逻辑在 net.js / web.js / mcp.js / device.js，这里只管界面。
   *   mcpHtml()     放进「插件对接」卡末尾的 #ra-mcp 插槽
   *   cardsHtml()   「联网」卡 #ra-net-card 与「后端伴侣」卡 #ra-comp-card
   *   action(name)  点击分发：net-* / mcp-* / comp-*；change(event) 处理下拉框
   * 这三块的改动都不跟着底部的「保存设置」走：MCP 与伴侣立即生效，联网有自己的保存按钮。
   * 样式在 ui-theme.js，这里只用它的类名（ra-card / ra-item / ra-form / ra-btn …）；内联样式只剩几处间距。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var TRUST_LABEL = { ask: '每次先问', hint: '自称只读的免问', all: '都免问' };
  var VIA_LABEL = { auto: '自动', direct: '只直连', companion: '经伴侣' };

  function createNetUi(env, kit, agent, deps, panel) {
    var net = deps.net, secrets = deps.secrets, mcp = deps.mcp, companion = deps.companion, web = deps.web;
    var $ = panel.$, esc = panel.esc;
    var notes = { net: null, mcp: null, comp: null };
    var pairing = null, pairAbort = null;

    function ago(at) {
      var minutes = Math.round((Date.now() - at) / 60000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return minutes + ' 分钟前';
      if (minutes < 1440) return Math.round(minutes / 60) + ' 小时前';
      return Math.round(minutes / 1440) + ' 天前';
    }

    function clock(at) {
      var date = new Date(at);
      var pad = function (value) { return String(value).padStart(2, '0'); };
      var same = new Date().toDateString() === date.toDateString();
      return (same ? '' : (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日 ') + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function noteHtml(key) {
      var note = notes[key];
      return '<span class="ra-status' + (note && note.bad ? ' is-bad' : '') + '" id="ra-' + key + '-note">' + esc(note ? note.text : '') + '</span>';
    }

    function options(map, current) {
      return Object.keys(map).map(function (key) { return '<option value="' + key + '"' + (key === current ? ' selected' : '') + '>' + map[key] + '</option>'; }).join('');
    }

    /* ---------- MCP ---------- */
    function mcpHtml() {
      var rows = mcp.list();
      var body = rows.map(function (row) {
        var own = row.source === 'own';
        var stateText = row.error ? '出错：' + row.error : row.tools ? row.tools + ' 个工具' + (row.at ? ' · ' + ago(row.at) + '取回' : '') : '还没连接';
        var kind = own ? (row.transport === 'stdio' ? '在设备上启动（要伴侣）' : 'HTTP') : 'TauriTavern';
        return '<div class="ra-item" data-mcp="' + esc(row.id) + '" data-enabled="' + (row.enabled ? '1' : '0') + '">'
          + '<div class="ra-item-main"><b>' + esc(row.name) + '</b> <span class="ra-badge">' + esc(kind) + '</span>'
          + '<p class="ra-note">' + esc(stateText + (own && !row.enabled ? ' · 已停用' : '')) + '</p>'
          + '<p class="ra-note">' + esc(row.target) + '</p>'
          + (row.toolNames && row.toolNames.length ? '<p class="ra-note">' + esc(row.toolNames.slice(0, 8).join('、') + (row.toolNames.length > 8 ? '…' : '')) + '</p>' : '') + '</div>'
          + (own ? '<span class="ra-row"><select data-mcp-trust title="这个服务器的工具要不要先问你" aria-label="要不要先问">' + options(TRUST_LABEL, row.trust) + '</select>'
            + (row.transport === 'http' ? '<select data-mcp-via title="怎么连：浏览器直连，还是经后端伴侣" aria-label="怎么连">' + options(VIA_LABEL, row.via) + '</select>' : '')
            + '<button type="button" class="ra-btn is-small" data-act="mcp-refresh">刷新</button>'
            + '<button type="button" class="ra-btn is-small" data-act="mcp-toggle">' + (row.enabled ? '停用' : '启用') + '</button>'
            + '<button type="button" class="ra-btn is-small is-bad" data-act="mcp-del">删除</button></span>' : '')
          + '</div>';
      }).join('');
      return '<h4 class="ra-sub">MCP 服务器</h4><p class="ra-note">把外部工具接给助手。网址类（Streamable HTTP）由浏览器直连，对方不允许跨域时改由后端伴侣代连；命令类（stdio）要后端伴侣在设备上启动。'
        + '它们的工具算「联网」：默认每次先问，可以按服务器放宽。密钥（请求头、环境变量）只存在这台设备的浏览器里。</p>'
        + (body || '<p class="ra-note">还没有。</p>')
        + (mcp.hasTauri() ? '<div class="ra-row" style="margin:8px 0"><button type="button" class="ra-btn is-small" data-act="mcp-tt">同步 TauriTavern 里登记的 MCP</button><span class="ra-note">只带入在它的 MCP 管理器里启用、并且权限不是 Off 的工具；Ask 的每次先问，Allow 的免问。</span></div>' : '')
        + '<textarea id="ra-mcp-json" class="is-code" spellcheck="false" placeholder="{&quot;mcpServers&quot;: {&quot;exa&quot;: {&quot;url&quot;: &quot;https://mcp.exa.ai/mcp&quot;, &quot;headers&quot;: {&quot;Authorization&quot;: &quot;Bearer …&quot;}}}}&#10;或 {&quot;fs&quot;: {&quot;command&quot;: &quot;npx&quot;, &quot;args&quot;: [&quot;-y&quot;, &quot;@modelcontextprotocol/server-filesystem&quot;, &quot;/path&quot;]}}" style="margin-top:8px"></textarea>'
        + '<div class="ra-row" style="margin-top:8px"><button type="button" class="ra-btn is-small" data-act="mcp-add">添加 / 按名字更新</button>' + noteHtml('mcp') + '</div>';
    }

    function renderMcp() {
      var node = $('#ra-mcp');
      if (!node) return;
      var draft = ($('#ra-mcp-json') || {}).value || '';
      node.innerHTML = mcpHtml();
      if (draft && $('#ra-mcp-json')) $('#ra-mcp-json').value = draft;
    }

    /* ---------- 联网 ---------- */
    function netCardHtml() {
      var settings = net.settings();
      var token = String(secrets.get('github.token') || '');
      return '<section class="ra-card" id="ra-net-card"><h3>联网<span class="ra-live">单独保存</span></h3>'
        + '<p class="ra-note">助手用 web 工具箱抓网页、读 GitHub 仓库。下面名单里的主机，以及你在对话里亲口给过的网址，可以直接访问；别的主机第一次访问会先问你——卡里、网页里的文字有可能诱导她把聊天内容发到别处，所以「发往哪里」要你看一眼。</p>'
        + '<div class="ra-form">'
        + '<label>免问的主机</label><textarea id="ra-net-hosts" class="is-code" spellcheck="false" placeholder="每行一个，例如 docs.example.com；*.example.com 表示所有子域名">' + esc(settings.allowHosts.join('\n')) + '</textarea>'
        + '<label>阅读代理（可空）</label><input type="text" id="ra-net-proxy" value="' + esc(settings.proxy) + '" placeholder="https://r.jina.ai/{url}" maxlength="300" spellcheck="false">'
        + '<label>GitHub 令牌</label><input type="password" id="ra-net-token" autocomplete="off" spellcheck="false" placeholder="' + (token ? '已保存 ' + esc(secrets.mask(token)) + '（留空表示不改）' : '没有（公开仓库不需要）') + '">'
        + '</div>'
        + '<p class="ra-note">多数网站不允许网页直接跨域读取。被拦时依次改走：后端伴侣（装了并放行的话）→ 酒馆后端自带的访问接口 → 这里填的阅读代理（网址会交给那个服务去取，所以默认不填；<code>{url}</code> 处填原网址，<code>{enc}</code> 处填编码后的网址）。</p>'
        + '<p class="ra-note">GitHub 令牌用来读私有仓库、搜代码、推送，并把接口额度从每小时 60 次提到 5000 次。建议用 fine-grained 令牌：只勾要用的仓库，Contents 给读写。它只存在这台设备的浏览器里，不进酒馆的设置文件，助手自己也读不到明文；推送每次都会先问你。</p>'
        + '<div class="ra-row" style="margin-top:8px"><button type="button" class="ra-btn is-small is-main" data-act="net-save">保存联网设置</button><button type="button" class="ra-btn is-small" data-act="net-token-test">测试令牌</button>'
        + (token ? '<button type="button" class="ra-btn is-small is-bad" data-act="net-token-clear">清除令牌</button>' : '') + noteHtml('net') + '</div></section>';
    }

    /* ---------- 后端伴侣 ---------- */
    function companionCardHtml() {
      var snap = companion.snapshot();
      var current = agent.getSettings();
      var info = snap.info || {};
      var line;
      if (snap.granted) {
        var until = snap.grant.expiresAt ? '到 ' + clock(snap.grant.expiresAt) : snap.grant.persistent ? '长期有效' : '到伴侣重启为止';
        line = '已连接并放行（' + until + '）· ' + String(info.platform || '') + ' · 伴侣 ' + String(info.version || '');
      } else if (snap.found) line = '已检测到伴侣 ' + String(info.version || '') + '（' + (info.mode === 'plugin' ? '酒馆后端插件' : '独立运行') + '），还没放行';
      else line = snap.error || '还没检测';
      var wait = '';
      if (pairing) {
        var link = /^https?:\/\//i.test(String(pairing.adminUrl || '')) ? '<a href="' + esc(pairing.adminUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(pairing.adminUrl) + '</a>' : '伴侣的管理页';
        wait = '<div class="ra-confirm" style="margin:10px 0"><h4>等待放行：配对码 <span id="ra-comp-code" style="letter-spacing:.2em">' + esc(pairing.code || '…') + '</span></h4>'
          + '<div>到<b>装着伴侣的那台设备</b>上打开管理页 ' + link + '（第一次要用伴侣启动时在控制台里打印的、带 key 的那个地址），核对配对码一致，再点「放行」。</div>'
          + '<div class="ra-row" style="margin-top:8px"><button type="button" class="ra-btn is-small" data-act="comp-cancel">取消</button><span class="ra-note">放行之前，设备上什么都做不了。</span></div></div>';
      }
      return '<section class="ra-card" id="ra-comp-card"><h3>后端伴侣<span class="ra-live">立即生效</span></h3>'
        + '<p class="ra-note">可选，只在「设备全权」档位下才会用到。一个装在酒馆后端（或单独运行）的小程序，让助手能在你的设备上跑命令、读写文件、开无头浏览器、启动命令类的 MCP 服务器；每次连接都要你在设备本机的管理页上放行，页面里的脚本代替不了你。TauriTavern 与手机上通常装不了，不影响别的功能。安装办法见 README「后端伴侣」。</p>'
        + '<p class="ra-tip" id="ra-comp-state"><b>状态</b>：' + esc(line) + '</p>'
        + (current.mode !== 'device' ? '<p class="ra-note">当前的权限档位不是「设备全权」，助手不会动设备上的东西；要用请在上面的「权限档位」里选它并保存。</p>' : '')
        + wait
        + '<div class="ra-form" style="margin-top:12px"><label>伴侣地址</label><input type="text" id="ra-comp-url" value="' + esc(current.companion && current.companion.url || '') + '" placeholder="留空 = 酒馆后端插件；单独运行时填 http://127.0.0.1:8790" maxlength="200" spellcheck="false"></div>'
        + '<div class="ra-row" style="margin-top:8px"><button type="button" class="ra-btn is-small" data-act="comp-check">检测</button>'
        + (snap.found && !pairing ? '<button type="button" class="ra-btn is-small is-main" data-act="comp-pair">' + (snap.granted ? '重新申请放行' : '申请放行') + '</button>' : '')
        + (snap.saved ? '<button type="button" class="ra-btn is-small is-bad" data-act="comp-release">断开</button>' : '')
        + (snap.granted ? '<button type="button" class="ra-btn is-small" data-act="comp-env">让她看看设备环境</button>' : '')
        + noteHtml('comp') + '</div></section>';
    }

    function replace(id, html) {
      var node = $(id);
      if (node) node.outerHTML = html;
    }
    function renderNet() { replace('#ra-net-card', netCardHtml()); }
    function renderComp() { replace('#ra-comp-card', companionCardHtml()); }

    /* 跑一个可能要等的动作：先写「处理中」，完事后重画那一块并写上结果。 */
    function work(key, render, task) {
      notes[key] = { text: '处理中…', bad: false };
      var node = $('#ra-' + key + '-note');
      if (node) { node.textContent = '处理中…'; node.classList.remove('is-bad'); }
      Promise.resolve().then(task).then(function (message) {
        notes[key] = message ? { text: String(message), bad: false } : null;
        render();
      }, function (error) {
        notes[key] = { text: String(error && error.message || error).slice(0, 400), bad: true };
        render();
      });
    }

    function action(name, actor) {
      var row = actor && actor.closest ? actor.closest('[data-mcp]') : null;
      var id = row ? row.getAttribute('data-mcp') : '';

      if (name === 'mcp-add') {
        work('mcp', renderMcp, async function () {
          var entries = mcp.parse(($('#ra-mcp-json') || {}).value || '');
          var lines = [];
          for (var index = 0; index < entries.length; index += 1) {
            try {
              var found = await mcp.add(entries[index]);
              lines.push('「' + entries[index].server.name + '」已添加，' + found.tools.length + ' 个工具');
            } catch (error) {
              lines.push('「' + entries[index].server.name + '」已登记，但连接失败：' + String(error && error.message || error).slice(0, 200));
            }
          }
          if ($('#ra-mcp-json')) $('#ra-mcp-json').value = '';
          return lines.join('；');
        });
      } else if (name === 'mcp-refresh') {
        work('mcp', renderMcp, async function () { var found = await mcp.refresh(id); return '已刷新，' + found.tools.length + ' 个工具'; });
      } else if (name === 'mcp-toggle') {
        work('mcp', renderMcp, function () { mcp.update(id, { enabled: row.getAttribute('data-enabled') !== '1' }); return ''; });
      } else if (name === 'mcp-del') {
        if (actor.getAttribute('data-armed') !== '1') { actor.setAttribute('data-armed', '1'); actor.textContent = '再点一次删除'; return; }
        work('mcp', renderMcp, async function () { await mcp.remove(id); return '已删除'; });
      } else if (name === 'mcp-tt') {
        work('mcp', renderMcp, async function () {
          var state = await mcp.syncTauri();
          var count = state.servers.reduce(function (sum, server) { return sum + server.tools.length; }, 0);
          return '已同步 ' + state.servers.length + ' 个服务器、' + count + ' 个工具';
        });
      } else if (name === 'net-save') {
        work('net', renderNet, function () {
          var hosts = String(($('#ra-net-hosts') || {}).value || '').split(/[\s,，;；]+/).filter(Boolean);
          var proxy = String(($('#ra-net-proxy') || {}).value || '').trim();
          var token = String(($('#ra-net-token') || {}).value || '').trim();
          var saved = agent.saveSettings({ web: { allowHosts: hosts, proxy: proxy } });
          if (token) secrets.set('github.token', token);
          var dropped = hosts.length - saved.web.allowHosts.length;
          if (proxy && !saved.web.proxy) throw new Error('其余已保存；阅读代理没有保存：它要以 http(s):// 或 / 开头，并包含 {url} 或 {enc}');
          return '已保存' + (dropped > 0 ? '（有 ' + dropped + ' 行不是合法的主机名，已略过）' : '') + (token ? '；令牌已更新' : '');
        });
      } else if (name === 'net-token-test') {
        work('net', renderNet, async function () {
          var typed = String(($('#ra-net-token') || {}).value || '').trim();
          if (typed) secrets.set('github.token', typed);
          if (!web.hasToken()) throw new Error('还没有填令牌');
          var out = await web.github('/user');
          return '令牌有效：' + String(out.data && out.data.login || '') + (out.headers['x-oauth-scopes'] ? '（权限：' + out.headers['x-oauth-scopes'] + '）' : '');
        });
      } else if (name === 'net-token-clear') {
        if (actor.getAttribute('data-armed') !== '1') { actor.setAttribute('data-armed', '1'); actor.textContent = '再点一次清除'; return; }
        work('net', renderNet, function () { secrets.set('github.token', undefined); return '令牌已清除'; });
      } else if (name === 'comp-check') {
        work('comp', renderComp, async function () {
          var url = String(($('#ra-comp-url') || {}).value || '').trim();
          var saved = agent.saveSettings({ companion: { url: url } });
          if (url && !saved.companion.url) throw new Error('伴侣地址要写成 http://主机:端口');
          var snap = await companion.status(true);
          return snap.found ? '' : (snap.error || '没有检测到后端伴侣');
        });
      } else if (name === 'comp-pair') {
        pairAbort = typeof AbortController === 'function' ? new AbortController() : null;
        pairing = { code: '', adminUrl: '' };
        notes.comp = null;
        renderComp();
        companion.pair(function (update) { pairing = update; renderComp(); }, pairAbort ? pairAbort.signal : undefined).then(function () {
          pairing = null; notes.comp = { text: '已放行', bad: false }; renderComp();
        }, function (error) {
          pairing = null;
          notes.comp = error && error.name === 'AbortError' ? null : { text: String(error && error.message || error).slice(0, 300), bad: true };
          renderComp();
        });
      } else if (name === 'comp-cancel') {
        if (pairAbort) pairAbort.abort();
        pairing = null;
        renderComp();
      } else if (name === 'comp-release') {
        work('comp', renderComp, async function () { await companion.release(); return '已断开：这台浏览器里的令牌已清除'; });
      } else if (name === 'comp-env') {
        panel.ask('看一下设备环境：系统、常用工具装了哪些、缺哪些。缺的先告诉我各自是做什么用的、要怎么装，等我同意再动手装。');
      }
    }

    function change(event) {
      var target = event.target;
      if (!target || !target.hasAttribute) return false;
      var isTrust = target.hasAttribute('data-mcp-trust'), isVia = target.hasAttribute('data-mcp-via');
      if (!isTrust && !isVia) return false;
      var row = target.closest('[data-mcp]');
      if (!row) return true;
      var id = row.getAttribute('data-mcp');
      work('mcp', renderMcp, function () { mcp.update(id, isTrust ? { trust: target.value } : { via: target.value }); return isTrust ? '已改为「' + (TRUST_LABEL[target.value] || '') + '」' : '连接方式已改，点「刷新」重新连接'; });
      return true;
    }

    return { mcpHtml: mcpHtml, cardsHtml: function () { return netCardHtml() + companionCardHtml(); }, action: action, change: change };
  }

  modules.createNetUi = createNetUi;
})(typeof globalThis !== 'undefined' ? globalThis : window);
