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
    var tokenAttempt = 0;
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
      return '<span role="status" class="ra-status' + (note && note.bad ? ' is-bad' : '') + '" id="ra-' + key + '-note">' + esc(note ? note.text : '') + '</span>';
    }

    function options(map, current) {
      return Object.keys(map).map(function (key) { return '<option value="' + key + '"' + (key === current ? ' selected' : '') + '>' + map[key] + '</option>'; }).join('');
    }

    /* ---------- MCP ---------- */
    var mcpScanAt = 0, mcpScanJob = null, mcpScanError = '';

    function tauriDirectoryHtml(rows) {
      var tt = rows.filter(function (row) { return row.source === 'tt'; });
      var status = mcpScanError || (mcpScanJob || !mcpScanAt ? '正在读取酒馆的工具服务列表…' : '在酒馆「扩展 → MCP」里登记并启用服务后，可以在这里选择。');
      return '<h4 class="ra-sub">从 TauriTavern 接入</h4><p class="ra-note">' + esc(status) + '</p>'
        + tt.map(function (row) {
          var state = !row.available ? '已在酒馆停用或删除' : !row.enabled ? '可接入' : row.tools ? '已接入 · ' + row.tools + ' 个工具' : '已接入 · 请在酒馆 MCP 管理器中允许需要的工具';
          return '<div class="ra-item" data-mcp="' + esc(row.id) + '"><div class="ra-item-main"><b>' + esc(row.name) + '</b><p class="ra-note">' + esc(state) + '</p>'
            + (row.toolNames.length ? '<p class="ra-note">' + esc(row.toolNames.slice(0, 8).join('、')) + '</p>' : '') + '</div><span class="ra-row">'
            + (row.available ? '<button type="button" class="ra-btn is-small" data-act="mcp-tt-connect">' + (row.enabled ? '刷新工具' : '接入') + '</button>' : '')
            + (row.enabled ? '<button type="button" class="ra-btn is-small" data-act="mcp-tt-remove">在助手中停用</button>' : '') + '</span></div>';
        }).join('')
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="mcp-tt-scan">重查酒馆列表</button></div>'
        + '<p class="ra-note">点「接入」读取这项服务允许使用的工具。助手要实际调用时会显示工具和参数，点「允许」才会发送。</p>';
    }

    function mcpHtml() {
      var rows = mcp.list();
      var own = rows.filter(function (row) { return row.source === 'own'; });
      var body = own.map(function (row) {
        var state = row.error || (row.at ? row.tools + ' 个工具 · ' + ago(row.at) + '更新' : '尚未连接');
        return '<div class="ra-item" data-mcp="' + esc(row.id) + '" data-enabled="' + (row.enabled ? '1' : '0') + '">'
          + '<div class="ra-item-main"><b>' + esc(row.name) + '</b><p class="ra-note">' + esc(state + (row.enabled ? '' : ' · 已停用')) + '</p>'
          + (row.toolNames.length ? '<p class="ra-note">' + esc(row.toolNames.slice(0, 8).join('、')) + '</p>' : '') + '</div>'
          + '<span class="ra-row"><select data-mcp-trust aria-label="调用工具时是否询问">' + options(TRUST_LABEL, row.trust) + '</select>'
          + (row.transport === 'http' ? '<select data-mcp-via aria-label="连接方式">' + options(VIA_LABEL, row.via) + '</select>' : '')
          + '<button type="button" class="ra-btn is-small" data-act="mcp-refresh">刷新工具</button>'
          + '<button type="button" class="ra-btn is-small" data-act="mcp-toggle">' + (row.enabled ? '停用' : '启用') + '</button>'
          + '<button type="button" class="ra-btn is-small is-bad" data-act="mcp-del">删除</button></span></div>';
      }).join('');
      return '<p class="ra-note">有些服务能让夜梦查资料或操作其他软件，这类服务叫 MCP。平时聊天、抽卡都可以跳过这里。</p>'
        + (mcp.hasTauri() ? '<div id="ra-mcp-tt">' + tauriDirectoryHtml(rows) + '</div>' : '') + body
        + '<details id="ra-mcp-manual"><summary>用服务方给的配置手动接入</summary>'
        + '<p class="ra-note">从服务的使用说明里复制 MCP 配置（JSON），粘贴后点「添加服务」。其中 url 是工具的网址，command 是需要后端伴侣在本机启动的程序。服务需要的密钥只粘贴在这里。</p>'
        + '<label for="ra-mcp-json">服务配置</label><textarea id="ra-mcp-json" class="is-code" spellcheck="false" placeholder="{&quot;mcpServers&quot;: {&quot;服务名&quot;: {&quot;url&quot;: &quot;https://…/mcp&quot;}}}"></textarea>'
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="mcp-add">添加服务 / 更新同名配置</button></div></details>' + noteHtml('mcp');
    }

    function renderMcp() {
      var node = $('#ra-mcp');
      if (!node) return;
      var draft = ($('#ra-mcp-json') || {}).value || '';
      var open = ($('#ra-mcp-manual') || {}).open;
      node.innerHTML = mcpHtml();
      if (open) $('#ra-mcp-manual').open = true;
      if (draft) $('#ra-mcp-json').value = draft;
    }

    function scanMcp(force) {
      if (!mcp.hasTauri() || mcpScanJob || (!force && Date.now() - mcpScanAt < 15000)) return;
      mcpScanError = '';
      mcpScanJob = mcp.scanTauri().catch(function (error) {
        mcpScanError = '读取失败：' + String(error.message || error);
      }).finally(function () {
        mcpScanAt = Date.now();
        mcpScanJob = null;
        var directory = $('#ra-mcp-tt');
        if (directory) directory.innerHTML = tauriDirectoryHtml(mcp.list());
      });
    }

    /* ---------- 联网 ---------- */
    function githubTokenLink(label, permission) {
      var url = 'https://github.com/settings/personal-access-tokens/new?name=Reader-II+' + permission
        + '&contents=' + permission;
      return '<a class="ra-btn is-small" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    }

    function tokenFieldsHtml() {
      var token = String(secrets.get('github.token') || '');
      return '<div id="ra-token-fields"><div class="ra-form"><label for="ra-net-token">GitHub 令牌</label>'
        + '<input type="password" id="ra-net-token" autocomplete="off" spellcheck="false" placeholder="' + (token ? '已保存 ' + esc(secrets.mask(token)) + '，可粘贴新令牌替换' : '粘贴后自动验证并保存到这台设备') + '"></div>'
        + '<div class="ra-row" style="margin-top:8px"><button type="button" class="ra-btn is-small" data-act="net-token-test">验证令牌</button>'
        + (token ? '<button type="button" class="ra-btn is-small is-bad" data-act="net-token-clear">清除本机令牌</button>' : '') + noteHtml('github') + '</div></div>';
    }

    function netCardHtml() {
      var settings = net.settings();
      return '<section class="ra-card" id="ra-net-card"><h3>联网<span class="ra-live">单独保存</span></h3>'
        + '<p>想读一篇网页或 GitHub 上的公开项目？把链接发给夜梦，说「帮我总结一下」，就可以开始。</p>'
        + '<h4 class="ra-sub">让夜梦访问你的 GitHub 仓库</h4>'
        + '<p class="ra-note">仓库就是存放项目文件的地方。想读私有仓库、搜索代码或提交修改时，选下面一种用途。令牌决定夜梦可以访问哪些仓库，只粘贴在下方的令牌框里。</p>'
        + '<div class="ra-row">' + githubTokenLink('只读：看文件、搜代码', 'read') + githubTokenLink('可推送：提交文件', 'write') + '</div>'
        + '<ol class="ra-list"><li>按钮会打开 GitHub 并预填权限。如果出现登录页，先登录。要用自己的私有仓库或提交文件，在 <b>Repository access</b> 下选 <b>Only select repositories</b>，勾选要用的仓库。组织的仓库先在 <b>Resource owner</b> 选择该组织。</li>'
        + '<li>点页面底部的 <b>Generate token</b>，确认后复制生成的令牌，回到这里粘贴。</li></ol>'
        + tokenFieldsHtml()
        + (['readonly', 'card'].indexOf(agent.getSettings().mode) >= 0 ? '<p class="ra-note">想让夜梦提交文件时，还需要在<button type="button" class="ra-btn is-small" data-act="toc" data-target="ra-agent-card">助手权限</button>选择「酒馆全权」并保存。只读文件可以沿用当前档位。</p>' : '')
        + '<details class="ra-fold"><summary>' + panel.icon('chevron') + '更多联网设置（免问网站、阅读代理）</summary><div class="ra-form">'
        + '<label for="ra-net-hosts">访问时免问的网站</label><textarea id="ra-net-hosts" class="is-code" spellcheck="false" placeholder="每行一个，例如 docs.example.com">' + esc(settings.allowHosts.join('\n')) + '</textarea>'
        + '<p class="ra-note">填你信任的网站域名，每行一个。你在对话里主动发的链接也能直接读取。其他网站由夜梦在访问前询问你。</p>'
        + '<label for="ra-net-proxy">阅读代理（可留空）</label><input type="text" id="ra-net-proxy" value="' + esc(settings.proxy) + '" placeholder="https://r.jina.ai/{url}" maxlength="300" spellcheck="false">'
        + '<p class="ra-note">有些网站会拦住网页读取。夜梦会先尝试浏览器和酒馆已有的连接方式。如果你有可信的代读服务，可填它提供的地址，服务会收到要读的网址。用 <code>{url}</code> 表示原网址，<code>{enc}</code> 表示编码后的网址。</p></div>'
        + '<div class="ra-row" style="margin-top:8px"><button type="button" class="ra-btn is-small" data-act="net-save">保存网站和代理设置</button>' + noteHtml('net') + '</div></details></section>';
    }

    /* ---------- 后端伴侣 ---------- */
    function companionGuide(autoExpand) {
      var tauri = !!env.host.__TAURITAVERN__;
      var ua = String(env.host.navigator && env.host.navigator.userAgent || '');
      var windows = /Windows/i.test(ua), mobile = /Android|iPhone|iPad|Mobile/i.test(ua);
      var archive = 'https://github.com/Adirm007/reader-II/archive/refs/heads/main.zip';
      var download = env.host.__ReaderIIBase
        ? '<a class="ra-btn is-small" download="reader-ii-companion.zip" href="' + esc(env.host.__ReaderIIBase + 'dist/reader-ii-companion.zip') + '">下载当前版本的伴侣 ZIP</a> ' : '';
      var links = '<div class="ra-row">' + download + '<a href="' + archive + '" target="_blank" rel="noopener noreferrer">备用下载（完整仓库，打开 companion 文件夹）</a></div>';
      var docs = '<a href="https://github.com/Adirm007/reader-II/blob/main/companion/README.md" target="_blank" rel="noopener noreferrer">查看各平台的安装说明</a>';
      if (tauri && mobile) return '<p class="ra-note">手机上的 TauriTavern 没有本机 Node 后端。可继续使用普通聊天、网页和已接入的网络工具。需要操作设备文件时，请在能运行伴侣的电脑或 Termux 酒馆上安装。</p>' + docs;
      var node = '<a href="https://nodejs.org/en/download" target="_blank" rel="noopener noreferrer">安装 Node.js LTS</a>';
      var steps;
      if (tauri && windows) {
        steps = '<ol><li>先把 ZIP 全部解压到一个会保留的位置。</li><li>在解压文件夹里双击 <code>Windows-Tauri.cmd</code>，按回车。它会找到正在运行的酒馆，必要时请你选择 <code>TauriTavern.exe</code>。提示找不到 Node 时先' + node + '。</li><li>以后双击桌面的「TauriTavern + Reader-II」就能同时打开两者。在托盘里退出酒馆，伴侣也会停止。回到这里点「检测伴侣」。</li></ol>'
          + '<p class="ra-note">卸载时再打开 Windows-Tauri.cmd，输入 2。它会移除专用快捷方式，原酒馆图标照常使用。</p>';
      } else if (tauri) {
        var launcher = /Macintosh|Mac OS X/i.test(ua) ? '桌面上的「TauriTavern + Reader-II.command」' : '应用菜单里的「TauriTavern + Reader-II」';
        steps = '<ol><li>把 ZIP 解压到会长期保留的位置。如果电脑还没有 Node.js，先' + node + '。</li><li>在解压后的伴侣文件夹里打开终端，运行一次 <code>node setup-desktop.mjs install</code>，按提示选择酒馆。</li><li>先退出已经打开的酒馆。以后从' + launcher + '启动，伴侣会跟着酒馆启停。回到这里点「检测伴侣」。</li></ol>'
          + '<p class="ra-note">卸载时在同一目录运行 <code>node setup-desktop.mjs uninstall</code> 即可移除启动入口。</p>';
      } else if (windows) {
        steps = '<ol><li>把 ZIP 解压到运行酒馆的电脑，双击 <code>Windows-SillyTavern.cmd</code>，按回车。</li><li>在弹出的窗口选择酒馆文件夹里的 <code>config.yaml</code>。安装器会打开服务器插件开关。重启酒馆一次，回到这里点「检测伴侣」。</li><li>以后它随酒馆启动和退出。卸载时再双击同一个文件，输入 2，选择同一份 config.yaml，随后重启酒馆。</li></ol><p class="ra-note">用终端也可以运行 <code>node setup.mjs install</code> 或 <code>node setup.mjs uninstall</code>。</p>';
      } else {
        steps = '<ol><li>把 ZIP 解压到<b>运行酒馆的设备</b>。用手机访问别人的酒馆时，请让服主安装。</li><li>在解压后的伴侣文件夹打开终端，运行 <code>node setup.mjs install</code>。按提示粘贴酒馆根目录（里面有 config.yaml）。安装器会打开酒馆的服务器插件开关。</li><li>重启酒馆一次，再点「检测伴侣」。以后启动和退出酒馆时，伴侣会一起启停。Termux 中运行的原生酒馆也用这条命令。</li></ol>'
          + '<p class="ra-note">卸载时在同一目录运行 <code>node setup.mjs uninstall</code> 后重启酒馆。</p>';
      }
      var cleanup = '<details><summary>彻底卸载，也清除配对和工作文件</summary><p class="ra-note">先在本页点「断开」，退出酒馆并按上面的卸载步骤移除伴侣。下载的 ZIP 和专门解压的文件夹都可删除。</p>'
        + '<p class="ra-note">数据另存在运行伴侣的设备上。先把 <code>workspace</code> 里要留的文件移出来，再删除整个 <code>'
        + (windows ? '%USERPROFILE%\\.reader-ii-companion' : '~/.reader-ii-companion') + '</code> 目录，就会一起清除授权和操作记录。设置过 <code>READER_II_COMPANION_HOME</code> 时，数据在你指定的位置。</p></details>';
      return '<details class="ra-fold"' + (autoExpand ? ' open' : '') + '><summary>' + panel.icon('chevron') + '安装或卸载伴侣</summary>' + links + steps + cleanup + docs + '</details>';
    }

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
          + '<div>在<b>装伴侣的设备</b>上打开管理页 ' + link + '。首次使用要从伴侣或酒馆的终端打开带 #key 的完整地址。核对四位码和来源，选放行期限。点「拒绝」就会结束本次申请。</div>'
          + '<div class="ra-row" style="margin-top:8px"><button type="button" class="ra-btn is-small" data-act="comp-cancel">取消</button><span class="ra-note">放行之前，设备上什么都做不了。</span></div></div>';
      }
      return '<section class="ra-card" id="ra-comp-card"><h3>后端伴侣<span class="ra-live">立即生效</span></h3>'
        + '<p class="ra-note">想让夜梦整理电脑文件、运行命令或启动本地工具时才需要安装。只想聊天、玩卡或看网页，可以跳过。</p>'
        + companionGuide(!snap.found && !!snap.error)
        + '<p class="ra-tip" id="ra-comp-state"><b>状态</b>：' + esc(line) + '</p>'
        + (current.mode !== 'device' ? '<p class="ra-note">准备好要让夜梦操作设备时，在<button type="button" class="ra-btn is-small" data-act="toc" data-target="ra-agent-card">助手权限</button>选择「设备全权」并保存。</p>' : '')
        + wait
        + '<details><summary>更改连接地址</summary><div class="ra-form"><label for="ra-comp-url">自定义地址</label><input type="url" id="ra-comp-url" value="' + esc(current.companion && current.companion.url || '') + '" placeholder="留空使用此平台的默认地址" maxlength="200" spellcheck="false"></div><p class="ra-note">端口有改动时，填启动窗口显示的地址，然后点「检测伴侣」。这里的地址不含管理密钥 #key。</p></details>'
        + '<div class="ra-row" style="margin-top:8px"><button type="button" class="ra-btn is-small" data-act="comp-check">检测伴侣</button>'
        + (snap.found && !pairing ? '<button type="button" class="ra-btn is-small is-main" data-act="comp-pair">' + (snap.granted ? '重新申请放行' : '申请放行') + '</button>' : '')
        + (snap.saved ? '<button type="button" class="ra-btn is-small is-bad" data-act="comp-release">断开</button>' : '')
        + (snap.granted ? '<button type="button" class="ra-btn is-small" data-act="comp-env">让她看看设备环境</button><span class="ra-note">要收回这台浏览器的放行，点「断开」；也能在管理页随时撤销。</span>' : '')
        + noteHtml('comp') + '</div></section>';
    }

    function replace(id, html) {
      var node = $(id);
      if (node) node.outerHTML = html;
    }
    function renderComp() { replace('#ra-comp-card', companionCardHtml()); }

    function setNote(key, text, bad) {
      notes[key] = { text: text, bad: !!bad };
      var node = $('#ra-' + key + '-note');
      if (node) { node.textContent = text; node.classList.toggle('is-bad', !!bad); }
    }

    async function verifyGithubToken() {
      var attempt = ++tokenAttempt;
      var input = $('#ra-net-token');
      var candidate = input.value.trim() || secrets.get('github.token');
      if (!candidate) { setNote('github', '请先粘贴从 GitHub 复制的令牌。', true); return; }
      setNote('github', '正在向 GitHub 验证…');
      try {
        var login = await web.verifyToken(candidate);
        if (attempt !== tokenAttempt) return;
        var persisted = secrets.set('github.token', candidate);
        if (secrets.get('github.token') !== candidate) throw new Error('验证通过，但浏览器未能保存。请检查本站的存储权限后重试。');
        setNote('github', persisted ? '已验证并保存 · GitHub 账号 ' + login : '已验证 · GitHub 账号 ' + login + '。当前浏览器只能在本次会话里使用令牌。');
        replace('#ra-token-fields', tokenFieldsHtml());
      } catch (error) {
        if (attempt === tokenAttempt) setNote('github', error.status === 401 ? 'GitHub 不接受这枚令牌。请检查是否复制完整，或重新生成。' : String(error.message || error), true);
      }
    }

    function tokenInput(event) {
      tokenAttempt += 1;
      setNote('github', '');
      if (event.inputType === 'insertFromPaste') verifyGithubToken();
    }

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
      } else if (name === 'mcp-tt-scan') {
        scanMcp(true);
      } else if (name === 'mcp-tt-connect') {
        actor.disabled = true;
        work('mcp', renderMcp, async function () {
          var server = await mcp.connectTauri(id);
          return '已接入「' + server.name + '」，可用工具 ' + server.tools.length + ' 个';
        });
      } else if (name === 'mcp-tt-remove') {
        actor.disabled = true;
        work('mcp', renderMcp, async function () { await mcp.disconnectTauri(id); return '已从助手停用，酒馆里的登记仍可使用'; });
      } else if (name === 'net-save') {
        try {
          var hosts = String(($('#ra-net-hosts') || {}).value || '').split(/[\s,，;；]+/).filter(Boolean);
          var proxy = String(($('#ra-net-proxy') || {}).value || '').trim();
          if (proxy && !modules.normalizeWebSettings({ proxy: proxy }).proxy) throw new Error('阅读代理地址应以 http(s):// 或 / 开头，并包含 {url} 或 {enc}。');
          var saved = agent.saveSettings({ web: Object.assign({}, net.settings(), { allowHosts: hosts, proxy: proxy }) });
          var dropped = hosts.length - saved.web.allowHosts.length;
          $('#ra-net-hosts').value = saved.web.allowHosts.join('\n');
          $('#ra-net-proxy').value = saved.web.proxy;
          setNote('net', '已保存' + (dropped > 0 ? '（已略过重复或无效的网站）' : ''));
        } catch (error) { setNote('net', String(error.message || error), true); }
      } else if (name === 'net-token-test') {
        verifyGithubToken();
      } else if (name === 'net-token-clear') {
        if (actor.getAttribute('data-armed') !== '1') { actor.setAttribute('data-armed', '1'); actor.textContent = '再点一次清除'; return; }
        tokenAttempt += 1;
        secrets.set('github.token', undefined);
        if (secrets.get('github.token')) { setNote('github', '浏览器未能清除令牌。请检查本站的存储权限后重试。', true); return; }
        setNote('github', '本机令牌已清除');
        replace('#ra-token-fields', tokenFieldsHtml());
      } else if (name === 'comp-check') {
        work('comp', renderComp, async function () {
          var url = String(($('#ra-comp-url') || {}).value || '').trim();
          if (url) {
            var parsed;
            try { parsed = new URL(url); } catch (error) { throw new Error('请填伴侣的完整地址，例如 http://127.0.0.1:8790'); }
            if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error('这里只填连接地址，例如 http://127.0.0.1:8790。带 #key 的完整地址要在设备浏览器中打开。');
          }
          agent.saveSettings({ companion: { url: url } });
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

    return { mcpHtml: mcpHtml, scanMcp: scanMcp, cardsHtml: function () { return netCardHtml() + companionCardHtml(); }, action: action, change: change, tokenInput: tokenInput };
  }

  modules.createNetUi = createNetUi;
})(typeof globalThis !== 'undefined' ? globalThis : window);
