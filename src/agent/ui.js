(function (root) {
  'use strict';

  /*
   * 夜梦助手面板：对话 / 记忆 / 设置 三页，画在酒馆主文档里。
   * 用 <dialog>.showModal() 进入浏览器顶层，大厅与抽卡面板的 z-index 盖不住它；配色跟随读者当前主题。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var OVERLAY_ID = 'reader-agent-overlay';
  var STYLE_ID = 'reader-agent-style';
  var TYPE_ORDER = ['episode', 'fact', 'bond', 'howto'];

  var CSS = [
    '#reader-agent-overlay{--ra-bg:#1d1612;--ra-panel:#2a201a;--ra-panel2:#33271f;--ra-line:rgba(226,190,130,.22);--ra-ink:#f1e7d0;--ra-mute:#b9a88c;--ra-accent:#d9a85a;--ra-accent-ink:#2a1c0c;--ra-user:#3b2d22;--ra-ok:#8fbf8a;--ra-bad:#e08a7a;--ra-warn:#e2b25c;--ra-shadow:rgba(0,0,0,.55);',
    'position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:rgba(8,6,5,.62);color:var(--ra-ink);font:15px/1.6 "Noto Serif SC","Songti SC","Source Han Serif SC",serif;z-index:2147483647;overflow:hidden}',
    '#reader-agent-overlay::backdrop{background:rgba(8,6,5,.5)}',
    '#reader-agent-overlay[data-theme="summer"]{--ra-bg:#eaf6f8;--ra-panel:#fbfeff;--ra-panel2:#e3f1f5;--ra-line:rgba(40,120,150,.22);--ra-ink:#17323c;--ra-mute:#5b7a86;--ra-accent:#2f9fc4;--ra-accent-ink:#fff;--ra-user:#d4ecf4;--ra-ok:#2f8f6a;--ra-bad:#c9544a;--ra-warn:#b7791f;--ra-shadow:rgba(20,60,80,.25);background:rgba(190,225,235,.5)}',
    '#reader-agent-overlay[data-theme="ink"]{--ra-bg:#f3efe4;--ra-panel:#fbf8ef;--ra-panel2:#ece6d6;--ra-line:rgba(60,70,60,.24);--ra-ink:#262a26;--ra-mute:#6d7168;--ra-accent:#5d8f84;--ra-accent-ink:#fff;--ra-user:#e3ecdf;--ra-ok:#4d7f5d;--ra-bad:#a8423a;--ra-warn:#96702a;--ra-shadow:rgba(40,40,30,.28);background:rgba(120,120,105,.42)}',
    '#reader-agent-overlay *{box-sizing:border-box}',
    '#reader-agent-overlay .ra-shell{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(880px,94vw);height:min(760px,90vh);display:flex;flex-direction:column;background:var(--ra-bg);border:1px solid var(--ra-line);border-radius:14px;box-shadow:0 24px 70px var(--ra-shadow);overflow:hidden}',
    '#reader-agent-overlay .ra-head{display:flex;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid var(--ra-line);background:var(--ra-panel)}',
    '#reader-agent-overlay .ra-id{display:flex;flex-direction:column;line-height:1.25;min-width:0}',
    '#reader-agent-overlay .ra-id b{font-size:17px;letter-spacing:.06em}',
    '#reader-agent-overlay .ra-id i{font-style:normal;font-size:12px;color:var(--ra-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#reader-agent-overlay .ra-tabs{display:flex;gap:4px;margin-left:auto}',
    '#reader-agent-overlay button{font:inherit;color:inherit;cursor:pointer}',
    '#reader-agent-overlay .ra-tab{padding:6px 14px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-tab[aria-selected="true"]{border-color:var(--ra-line);background:var(--ra-panel2);color:var(--ra-ink)}',
    '#reader-agent-overlay .ra-close{width:34px;height:34px;border:1px solid var(--ra-line);border-radius:50%;background:transparent;font-size:18px;line-height:1}',
    '#reader-agent-overlay .ra-pane{flex:1;min-height:0;display:none;flex-direction:column}',
    '#reader-agent-overlay .ra-pane.is-on{display:flex}',
    '#reader-agent-overlay .ra-log{flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}',
    '#reader-agent-overlay .ra-msg{max-width:86%;padding:9px 13px;border-radius:12px;white-space:pre-wrap;word-break:break-word}',
    '#reader-agent-overlay .ra-ai{align-self:flex-start;background:var(--ra-panel);border:1px solid var(--ra-line);border-top-left-radius:4px}',
    '#reader-agent-overlay .ra-user{align-self:flex-end;background:var(--ra-user);border-top-right-radius:4px}',
    '#reader-agent-overlay .ra-thought{align-self:flex-start;max-width:86%;color:var(--ra-mute);font-size:13.5px;padding:0 4px;white-space:pre-wrap}',
    '#reader-agent-overlay .ra-msg code{font:13px/1.5 ui-monospace,Consolas,monospace;background:var(--ra-panel2);padding:1px 5px;border-radius:4px}',
    '#reader-agent-overlay .ra-msg pre{margin:6px 0;padding:8px 10px;background:var(--ra-panel2);border-radius:8px;overflow-x:auto;font:13px/1.5 ui-monospace,Consolas,monospace;white-space:pre}',
    '#reader-agent-overlay .ra-step{align-self:flex-start;max-width:92%;font-size:13px;color:var(--ra-mute);border-left:2px solid var(--ra-line);padding:2px 0 2px 10px}',
    '#reader-agent-overlay .ra-step summary{cursor:pointer;list-style:none;display:flex;gap:8px;align-items:baseline}',
    '#reader-agent-overlay .ra-step summary::-webkit-details-marker{display:none}',
    '#reader-agent-overlay .ra-step .st{flex:none;font-weight:700}',
    '#reader-agent-overlay .ra-step[data-state="run"] .st{color:var(--ra-warn)}',
    '#reader-agent-overlay .ra-step[data-state="ok"] .st{color:var(--ra-ok)}',
    '#reader-agent-overlay .ra-step[data-state="bad"] .st{color:var(--ra-bad)}',
    '#reader-agent-overlay .ra-step pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Consolas,monospace;max-height:180px;overflow:auto}',
    '#reader-agent-overlay .ra-confirm{align-self:stretch;border:1px solid var(--ra-warn);border-radius:10px;padding:10px 12px;background:var(--ra-panel)}',
    '#reader-agent-overlay .ra-confirm.is-danger{border-color:var(--ra-bad)}',
    '#reader-agent-overlay .ra-confirm h4{margin:0 0 4px;font-size:14px}',
    '#reader-agent-overlay .ra-confirm pre{margin:6px 0;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Consolas,monospace;color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
    '#reader-agent-overlay .ra-btn{padding:6px 14px;border:1px solid var(--ra-line);border-radius:8px;background:var(--ra-panel2)}',
    '#reader-agent-overlay .ra-btn.is-main{background:var(--ra-accent);border-color:var(--ra-accent);color:var(--ra-accent-ink)}',
    '#reader-agent-overlay .ra-btn.is-bad{border-color:var(--ra-bad);color:var(--ra-bad);background:transparent}',
    '#reader-agent-overlay .ra-btn:disabled{opacity:.5;cursor:default}',
    '#reader-agent-overlay .ra-btn.is-small{padding:3px 9px;font-size:12.5px}',
    '#reader-agent-overlay .ra-quick{display:flex;gap:6px;padding:0 16px 8px;flex-wrap:wrap}',
    '#reader-agent-overlay .ra-chip{padding:3px 11px;border:1px solid var(--ra-line);border-radius:999px;background:transparent;font-size:12.5px;color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-chip[aria-pressed="true"]{background:var(--ra-accent);border-color:var(--ra-accent);color:var(--ra-accent-ink)}',
    '#reader-agent-overlay .ra-input{display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--ra-line);background:var(--ra-panel)}',
    '#reader-agent-overlay textarea,#reader-agent-overlay input[type=text],#reader-agent-overlay input[type=password],#reader-agent-overlay input[type=number],#reader-agent-overlay input[type=search],#reader-agent-overlay select{font:inherit;color:var(--ra-ink);background:var(--ra-bg);border:1px solid var(--ra-line);border-radius:8px;padding:7px 9px;min-width:0}',
    '#reader-agent-overlay .ra-input textarea{flex:1;height:64px;resize:none}',
    '#reader-agent-overlay .ra-foot{display:flex;gap:10px;align-items:center;padding:6px 16px 10px;font-size:12px;color:var(--ra-mute);background:var(--ra-panel)}',
    '#reader-agent-overlay .ra-foot span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media (max-width:560px){.ra-foot span{white-space:normal}}',
    '#reader-agent-overlay .ra-scroll{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;overscroll-behavior:contain}',
    '#reader-agent-overlay .ra-card{border:1px solid var(--ra-line);border-radius:10px;background:var(--ra-panel);padding:11px 13px;margin-bottom:10px}',
    '#reader-agent-overlay .ra-card h3{margin:0 0 8px;font-size:14.5px;letter-spacing:.04em}',
    '#reader-agent-overlay .ra-upd-list{margin:6px 0;padding-left:20px}',
    '#reader-agent-overlay .ra-upd-list li{margin:3px 0}',
    '#reader-agent-overlay .ra-upd-ok{color:var(--ra-accent)}',
    '#reader-agent-overlay .ra-upd-bad{color:#d9775f}',
    '#reader-agent-overlay .ra-note{font-size:12.5px;color:var(--ra-mute);margin:4px 0}',
    '#reader-agent-overlay .ra-mem{border:1px solid var(--ra-line);border-radius:10px;background:var(--ra-panel);padding:9px 12px;margin-bottom:8px}',
    '#reader-agent-overlay .ra-mem-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}',
    '#reader-agent-overlay .ra-badge{flex:none;font-size:12px;padding:0 7px;border-radius:5px;border:1px solid var(--ra-line);color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-badge.t-episode{color:var(--ra-accent);border-color:var(--ra-accent)}',
    '#reader-agent-overlay .ra-badge.t-bond{color:var(--ra-bad);border-color:var(--ra-bad)}',
    '#reader-agent-overlay .ra-badge.t-fact{color:var(--ra-ok);border-color:var(--ra-ok)}',
    '#reader-agent-overlay .ra-badge.t-howto{color:var(--ra-warn);border-color:var(--ra-warn)}',
    '#reader-agent-overlay .ra-mem-title{font-weight:700;flex:1;min-width:120px}',
    '#reader-agent-overlay .ra-mem-body{margin:5px 0;white-space:pre-wrap;word-break:break-word;font-size:14px}',
    '#reader-agent-overlay .ra-mem-keys{font-size:12px;color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-form{display:grid;grid-template-columns:110px 1fr;gap:8px 10px;align-items:center}',
    '#reader-agent-overlay .ra-form label{font-size:13.5px;color:var(--ra-mute)}',
    '#reader-agent-overlay .ra-form textarea{width:100%;min-height:92px;resize:vertical}',
    '#reader-agent-overlay .ra-form input[type=text],#reader-agent-overlay .ra-form input[type=password],#reader-agent-overlay .ra-form textarea,#reader-agent-overlay .ra-form select{width:100%}',
    '#reader-agent-overlay .ra-form .wide{grid-column:1/-1}',
    '#reader-agent-overlay .ra-check{display:flex;gap:8px;align-items:center;font-size:14px}',
    '#reader-agent-overlay .ra-status{font-size:12.5px;color:var(--ra-mute);min-height:1.4em}',
    '#reader-agent-overlay .ra-status.is-bad{color:var(--ra-bad)}',
    '#reader-agent-overlay .ra-dots::after{content:"…";animation:ra-dots 1.2s steps(3,end) infinite}',
    '@keyframes ra-dots{0%{content:"."}33%{content:".."}66%{content:"…"}}',
    '@media(max-width:640px){#reader-agent-overlay .ra-shell{width:100vw;height:100%;max-height:none;border-radius:0;border:0}#reader-agent-overlay .ra-head{flex-wrap:wrap;gap:8px}#reader-agent-overlay .ra-tabs{order:3;width:100%;margin-left:0}#reader-agent-overlay .ra-tab{flex:1}#reader-agent-overlay .ra-close{margin-left:auto}#reader-agent-overlay .ra-form{grid-template-columns:1fr}#reader-agent-overlay .ra-msg{max-width:94%}}',
    '@media(prefers-reduced-motion:reduce){#reader-agent-overlay .ra-dots::after{animation:none}}'
  ].join('');

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  /* 只做最少的排版：代码块、行内代码、加粗；其余按原样换行显示。 */
  function rich(text) {
    var parts = String(text == null ? '' : text).split(/```/);
    return parts.map(function (part, index) {
      if (index % 2 === 1) return '<pre>' + esc(part.replace(/^[A-Za-z0-9_-]*\n/, '')) + '</pre>';
      return esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    }).join('');
  }

  function createAgentUi(env, kit, agent, memory, llm, deps) {
    var doc = env.document;
    var overlay = null;
    var tab = 'chat';
    var running = false;
    var pendingConfirms = [];
    var memoryFilter = { type: '', store: '', query: '' };
    var editing = null;
    var unsubscribe = [];

    function themeName() {
      var value = kit.readChatValue('dream_visual_theme');
      if (value !== 'summer' && value !== 'ink' && value !== 'cafe') {
        try { value = env.storage && env.storage.getItem(modules.localKey('dream_visual_theme')); } catch (error) { value = ''; }
      }
      return value === 'summer' || value === 'ink' ? value : 'cafe';
    }

    function ensureStyle() {
      var style = doc.getElementById(STYLE_ID);
      if (!style) {
        style = doc.createElement('style');
        style.id = STYLE_ID;
        (doc.head || doc.documentElement).appendChild(style);
      }
      if (style.textContent !== CSS) style.textContent = CSS;
    }

    function $(selector) { return overlay ? overlay.querySelector(selector) : null; }

    function toast(message, bad) {
      var target = $('[data-ra-status="' + tab + '"]');
      if (!target) return;
      target.textContent = message || '';
      target.classList.toggle('is-bad', !!bad);
    }

    /* ---------- 对话页 ---------- */
    function logNode() { return $('#ra-log'); }

    function append(html, className) {
      var log = logNode();
      if (!log) return null;
      var stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      var node = doc.createElement('div');
      node.className = className;
      node.innerHTML = html;
      log.appendChild(node);
      if (stick) log.scrollTop = log.scrollHeight;
      return node;
    }

    function clearIndicator() {
      var node = $('#ra-thinking');
      if (node) node.remove();
    }

    function showIndicator(label) {
      clearIndicator();
      var node = append('<span class="ra-dots">' + esc(label) + '</span>', 'ra-thought');
      if (node) node.id = 'ra-thinking';
    }

    function renderHistory() {
      var log = logNode();
      if (!log) return;
      log.innerHTML = '';
      var turns = agent.getHistory();
      if (!turns.length) {
        var persona = agent.personaContext();
        append(rich(persona.id === 'genki' ? '来啦！要查什么、改什么，还是随便聊聊？交给我！'
          : persona.id === 'weirdo' ? '……啊，你打开了这一页。那么，今天要拜托我什么？'
          : '我在这里。需要我替您查看卡里的资料、整理记忆，或者只是说说话，都可以。'), 'ra-msg ra-ai');
        return;
      }
      turns.forEach(function (turn) {
        append(rich(turn.text), 'ra-msg ' + (turn.role === 'assistant' ? 'ra-ai' : 'ra-user'));
        if (turn.tools && turn.tools.length) append(esc('用过的工具：' + turn.tools.join('、')), 'ra-thought');
      });
      log.scrollTop = log.scrollHeight;
    }

    function setRunning(value) {
      running = value;
      var send = $('#ra-send');
      if (send) { send.textContent = value ? '停止' : '发送'; send.classList.toggle('is-main', !value); send.classList.toggle('is-bad', value); }
      var input = $('#ra-text');
      if (input) input.disabled = value;
    }

    function confirmCard(request) {
      return new Promise(function (resolve) {
        clearIndicator();
        var danger = request.tier === 'danger';
        var device = request.scope === 'device';
        var title = danger ? '需要确认：这个操作难以恢复' : request.tier === 'net' ? '需要确认：要向外面发请求' : '需要确认';
        var node = append('<h4>' + title + (device ? '（在你的设备上）' : '') + '</h4><div>' + esc(request.description || request.name) + '</div>'
          + '<pre>' + esc(JSON.stringify(request.args, null, 1)) + '</pre>'
          + '<div class="ra-row"><button type="button" class="ra-btn is-main" data-answer="allow">允许</button>'
          + (danger ? '' : '<button type="button" class="ra-btn" data-answer="always">' + esc(request.alwaysLabel || '本次对话都允许这个工具') + '</button>')
          + '<button type="button" class="ra-btn is-bad" data-answer="deny">拒绝</button></div>', 'ra-confirm' + (danger ? ' is-danger' : ''));
        var done = false;
        var finish = function (answer) {
          if (done) return;
          done = true;
          pendingConfirms = pendingConfirms.filter(function (item) { return item !== finish; });
          if (node) node.innerHTML = '<div>' + esc(request.description || request.name) + '</div><div class="ra-note">' + (answer === 'deny' ? '已拒绝' : answer === 'always' ? '已允许（本次对话内不再为此询问）' : '已允许') + '</div>';
          resolve(answer);
        };
        pendingConfirms.push(finish);
        if (!node) { finish('deny'); return; }
        node.addEventListener('click', function (event) {
          var button = event.target.closest('[data-answer]');
          if (!button) return;
          /* 设备上的操作只认真人的点击：页面里别的脚本用 click() 模拟的点击（isTrusted 为 false）不算数。
             这只是多一道门槛；真正的边界在伴侣那边（要在设备本机的管理页放行）。 */
          if (device && event.isTrusted === false && button.getAttribute('data-answer') !== 'deny') return;
          finish(button.getAttribute('data-answer'));
        });
        var log = logNode();
        if (log) log.scrollTop = log.scrollHeight;
      });
    }

    function onAgentEvent(event) {
      if (!overlay) return;
      if (event.type === 'thinking') { showIndicator(event.step ? '继续思考' : '思考中'); return; }
      if (event.type === 'thought') { clearIndicator(); append(esc(event.text), 'ra-thought'); return; }
      if (event.type === 'tool_start') {
        clearIndicator();
        var node = append('<details><summary><span class="st">◇</span><span>' + esc(event.description && event.description !== event.name ? event.description : event.name) + '</span></summary><pre>'
          + esc(event.name + ' ' + JSON.stringify(event.args)) + '</pre></details>', 'ra-step');
        if (node) { node.setAttribute('data-step', event.id); node.setAttribute('data-state', 'run'); }
        return;
      }
      if (event.type === 'tool_end') {
        var step = overlay.querySelector('.ra-step[data-step="' + event.id + '"]');
        if (!step) {
          step = append('<details><summary><span class="st">◇</span><span>' + esc(event.name) + '</span></summary><pre></pre></details>', 'ra-step');
          if (!step) return;
        }
        step.setAttribute('data-state', event.ok ? 'ok' : 'bad');
        var mark = step.querySelector('.st');
        if (mark) mark.textContent = event.ok ? '✓' : event.denied ? '⊘' : '✕';
        var pre = step.querySelector('pre');
        if (pre) pre.textContent = (pre.textContent ? pre.textContent + '\n' : '') + '→ ' + (event.summary || '');
        return;
      }
      if (event.type === 'final') { clearIndicator(); append(rich(event.text), 'ra-msg ra-ai'); return; }
      if (event.type === 'error') { clearIndicator(); append(esc('没能完成：' + event.message), 'ra-thought'); return; }
      if (event.type === 'aborted') { clearIndicator(); append('已停止。', 'ra-thought'); }
    }

    async function send(textOverride) {
      if (running) {
        pendingConfirms.slice().forEach(function (finish) { finish('deny'); });
        agent.stop();
        return;
      }
      var input = $('#ra-text');
      var text = String(textOverride !== undefined ? textOverride : input && input.value || '').trim();
      if (!text) return;
      if (input && textOverride === undefined) input.value = '';
      append(rich(text), 'ra-msg ra-user');
      var log = logNode();
      if (log) log.scrollTop = log.scrollHeight;
      setRunning(true);
      try {
        var outcome = await agent.run(text, { onEvent: onAgentEvent, confirm: confirmCard });
        if (outcome.busy) append(esc(outcome.answer), 'ra-thought');
      } catch (error) {
        append(esc('出错：' + String(error && error.message || error)), 'ra-thought');
      } finally {
        clearIndicator();
        setRunning(false);
        refreshFoot();
        if (input) { try { input.focus(); } catch (error) { /* 面板可能已关闭 */ } }
      }
    }

    function footPermission() {
      var current = agent.getSettings();
      var mode = { readonly: '只读', card: '单卡', tavern: '酒馆全权', device: '设备全权' }[current.mode] || '单卡';
      if (current.mode === 'readonly') return mode;
      return mode + ' · ' + ({ ask: '先询问', auto: '档位内直接执行', yolo: '全部直接执行' }[current.approval] || '先询问') + (current.lite ? ' · 轻聊' : '');
    }

    function refreshFoot() {
      var node = $('#ra-foot-text');
      if (!node) return;
      var backend = llm.getBackendSummary('agent');
      var memorySettings = memory.getSettings();
      node.textContent = '模型：' + (backend.mode === 'custom' ? backend.model : '酒馆当前连接')
        + ' ｜ 记忆：' + (memorySettings.enabled ? (memory.targetStore() === 'ocean' ? '《' + memorySettings.oceanBook + '》' : '当前聊天') : '关闭')
        + ' ｜ 权限：' + footPermission();
      var persona = $('#ra-persona');
      if (persona) persona.textContent = 'READER AGENT · ' + agent.personaContext().name;
    }

    /* ---------- 记忆页 ---------- */
    function memoryEditorHtml(record) {
      var isNew = !record.id;
      var types = TYPE_ORDER.map(function (type) { return '<option value="' + type + '"' + (record.type === type ? ' selected' : '') + '>' + memory.TYPES[type] + '</option>'; }).join('');
      var importance = [1, 2, 3, 4, 5].map(function (value) { return '<option value="' + value + '"' + (Number(record.importance) === value ? ' selected' : '') + '>' + value + '</option>'; }).join('');
      return '<div class="ra-card" id="ra-editor"><h3>' + (isNew ? '新增记忆' : '编辑记忆') + '</h3><div class="ra-form">'
        + '<label>类型</label><select data-f="type">' + types + '</select>'
        + '<label>标题</label><input type="text" data-f="title" maxlength="40" value="' + esc(record.title || '') + '">'
        + '<label>正文</label><textarea data-f="content" maxlength="4000">' + esc(record.content || '') + '</textarea>'
        + '<label>触发词</label><input type="text" data-f="keys" value="' + esc((record.keys || []).join('，')) + '" placeholder="用逗号分隔；正文或对话里出现这些词时会想起它">'
        + '<label>重要度</label><select data-f="importance">' + importance + '</select>'
        + '<label>归属</label><select data-f="owner"><option value="story"' + (record.owner !== 'agent' ? ' selected' : '') + '>正文的记忆：正文里的夜梦会想起</option><option value="agent"' + (record.owner === 'agent' ? ' selected' : '') + '>助手自己的：打开“同一个人”后正文才会想起</option></select>'
        + (isNew ? '<label>存放位置</label><select data-f="store"><option value="chat"' + (record.store === 'chat' ? ' selected' : '') + '>当前聊天</option><option value="ocean"' + (record.store === 'ocean' ? ' selected' : '') + '>《' + esc(memory.getSettings().oceanBook) + '》世界书（跨存档）</option></select>' : '')
        + '<label class="ra-check wide"><input type="checkbox" data-f="pinned"' + (record.pinned ? ' checked' : '') + '>常驻：每一轮都带上（《夜之洋》里对应蓝灯条目）</label>'
        + '<div class="ra-row wide"><button type="button" class="ra-btn is-main" data-act="mem-save">保存</button><button type="button" class="ra-btn" data-act="mem-cancel">取消</button></div>'
        + '</div></div>';
    }

    function memoryItemHtml(record) {
      var stars = '★★★★★'.slice(0, record.importance) + '☆☆☆☆☆'.slice(0, 5 - record.importance);
      return '<div class="ra-mem" data-id="' + esc(record.id) + '"><div class="ra-mem-head"><span class="ra-badge t-' + record.type + '">' + esc(memory.TYPE_SHORT[record.type]) + '</span>'
        + '<span class="ra-mem-title">' + esc(record.title) + '</span><span class="ra-mem-keys">' + stars + '</span>'
        + '<span class="ra-badge">' + (record.store === 'ocean' ? '夜之洋' : '聊天') + '</span>' + (record.owner === 'agent' ? '<span class="ra-badge">助手</span>' : '') + (record.pinned ? '<span class="ra-badge">常驻</span>' : '') + (record.enabled ? '' : '<span class="ra-badge">已停用</span>') + '</div>'
        + '<div class="ra-mem-body">' + esc(record.content) + '</div>'
        + (record.keys.length ? '<div class="ra-mem-keys">触发词：' + esc(record.keys.join('、')) + '</div>' : '')
        + '<div class="ra-row" style="margin-top:6px"><button type="button" class="ra-btn is-small" data-act="mem-edit">编辑</button>'
        + '<button type="button" class="ra-btn is-small" data-act="mem-pin">' + (record.pinned ? '取消常驻' : '设为常驻') + '</button>'
        + '<button type="button" class="ra-btn is-small" data-act="mem-move">' + (record.store === 'ocean' ? '移到当前聊天' : '移到夜之洋') + '</button>'
        + '<button type="button" class="ra-btn is-small is-bad" data-act="mem-del">删除</button></div></div>';
    }

    async function renderMemory() {
      var pane = $('[data-pane="memory"] .ra-scroll');
      if (!pane) return;
      var status, list;
      try {
        status = await memory.status();
        list = await memory.list({ type: memoryFilter.type || undefined, store: memoryFilter.store || undefined, query: memoryFilter.query || undefined, fresh: true });
      } catch (error) {
        pane.innerHTML = '<div class="ra-card">读取记忆失败：' + esc(String(error && error.message || error)) + '</div>';
        return;
      }
      if (!overlay || tab !== 'memory') return;
      var chip = function (group, value, label) {
        return '<button type="button" class="ra-chip" data-act="mem-filter" data-group="' + group + '" data-value="' + value + '" aria-pressed="' + (memoryFilter[group] === value) + '">' + label + '</button>';
      };
      var last = status.last ? ((status.last.ok ? '上次整理：新增 ' + status.last.added + '、更新 ' + status.last.updated : '上次整理失败：' + (status.last.error || '')) + (status.last.note ? '（' + status.last.note + '）' : '')) : '还没有整理过';
      var threshold = status.thresholds.auto ? '自动整理阈值 ' + (status.thresholds.turns || '—') + ' 条回复 / ' + (status.thresholds.chars || '—') + ' 字' : '自动整理已关闭';
      var html = '<div class="ra-card"><div class="ra-row"><label>本聊天的新记忆写到</label><select id="ra-store">'
        + '<option value=""' + (status.chatOverride === '' ? ' selected' : '') + '>跟随全局设置（' + (memory.getSettings().store === 'ocean' ? '夜之洋' : '当前聊天') + '）</option>'
        + '<option value="chat"' + (status.chatOverride === 'chat' ? ' selected' : '') + '>当前聊天</option>'
        + '<option value="ocean"' + (status.chatOverride === 'ocean' ? ' selected' : '') + '>《' + esc(status.oceanBook) + '》世界书（跨存档）</option></select>'
        + '<button type="button" class="ra-btn is-main" data-act="mem-run"' + (status.running ? ' disabled' : '') + '>立即整理</button>'
        + '<button type="button" class="ra-btn" data-act="mem-new">新增记忆</button>'
        + '<button type="button" class="ra-btn" data-act="mem-export">导出</button><button type="button" class="ra-btn" data-act="mem-import">导入</button></div>'
        + '<p class="ra-note">当前聊天 ' + status.chatCount + ' 条 · 《' + esc(status.oceanBook) + '》' + (status.oceanExists ? status.oceanCount + ' 条' + (status.oceanNative ? '（已挂载，由酒馆按触发词原生带入）' : '（未挂载，由脚本带入）') : '尚未创建')
        + ' ｜ 待整理 ' + status.pending.turns + ' 条回复 / ' + status.pending.chars + ' 字 ｜ ' + esc(threshold) + '</p>'
        + '<p class="ra-note">' + esc(last) + '</p><div class="ra-status" data-ra-status="memory"></div></div>';
      html += '<div class="ra-card"><h3>前情梗概</h3><textarea id="ra-summary" style="width:100%;min-height:70px" placeholder="整理对话时自动更新；也可以自己改写。注入正文时放在记忆的最前面。">' + esc(status.summary || '') + '</textarea>'
        + '<div class="ra-row" style="margin-top:6px"><button type="button" class="ra-btn is-small" data-act="mem-summary">保存梗概</button></div></div>';
      if (editing) html += memoryEditorHtml(editing);
      html += '<div class="ra-row" style="margin-bottom:8px">' + chip('type', '', '全部') + TYPE_ORDER.map(function (type) { return chip('type', type, memory.TYPE_SHORT[type]); }).join('')
        + '<span style="width:10px"></span>' + chip('store', '', '两处') + chip('store', 'chat', '聊天') + chip('store', 'ocean', '夜之洋')
        + '<input type="search" id="ra-mem-q" placeholder="搜索" value="' + esc(memoryFilter.query) + '" style="flex:1;min-width:120px"></div>';
      html += list.length ? list.map(memoryItemHtml).join('') : '<p class="ra-note">这里还没有记忆。聊上一阵后会自动整理；也可以点“立即整理”或“新增记忆”。</p>';
      var scroll = pane.scrollTop;
      pane.innerHTML = html;
      pane.scrollTop = scroll;
    }

    function readEditor() {
      var box = $('#ra-editor');
      if (!box) return null;
      var field = function (name) { return box.querySelector('[data-f="' + name + '"]'); };
      return {
        type: field('type').value,
        title: field('title').value,
        content: field('content').value,
        keys: field('keys').value,
        importance: Number(field('importance').value),
        pinned: field('pinned').checked,
        owner: field('owner') ? field('owner').value : undefined,
        store: field('store') ? field('store').value : undefined
      };
    }

    function download(name, text) {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = doc.createElement('a');
      link.href = url;
      link.download = name;
      doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }

    function pickFile() {
      return new Promise(function (resolve) {
        var input = doc.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = function () {
          var file = input.files && input.files[0];
          if (!file) { resolve(null); return; }
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result || '')); };
          reader.onerror = function () { resolve(null); };
          reader.readAsText(file);
        };
        input.click();
      });
    }

    async function memoryAction(action, element) {
      var item = element.closest('[data-id]');
      var id = item ? item.getAttribute('data-id') : '';
      try {
        if (action === 'mem-filter') {
          memoryFilter[element.getAttribute('data-group')] = element.getAttribute('data-value');
        } else if (action === 'mem-new') {
          editing = { type: 'fact', title: '', content: '', keys: [], importance: 3, pinned: false, owner: 'story', store: memory.targetStore() };
        } else if (action === 'mem-edit') {
          editing = await memory.get(id);
        } else if (action === 'mem-cancel') {
          editing = null;
        } else if (action === 'mem-save') {
          var data = readEditor();
          if (!data || !data.content.trim()) { toast('正文不能为空', true); return; }
          if (editing && editing.id) await memory.update(editing.id, data);
          else await memory.add(Object.assign({ source: 'manual' }, data), { store: data.store });
          editing = null;
        } else if (action === 'mem-pin') {
          var current = await memory.get(id);
          if (current) await memory.update(id, { pinned: !current.pinned });
        } else if (action === 'mem-move') {
          var record = await memory.get(id);
          if (record) { toast('正在移动…'); await memory.move(id, record.store === 'ocean' ? 'chat' : 'ocean'); }
        } else if (action === 'mem-del') {
          if (element.getAttribute('data-armed') !== '1') {
            element.setAttribute('data-armed', '1');
            element.textContent = '再点一次删除';
            return;
          }
          await memory.remove(id);
        } else if (action === 'mem-run') {
          toast('正在整理对话…');
          element.disabled = true;
          var report = await memory.consolidate({ reason: 'manual', force: true });
          await renderMemory();
          toast(report.ok ? (report.note || '整理完成：新增 ' + report.added.length + ' 条，更新 ' + report.updated.length + ' 条' + (report.errors.length ? '，' + report.errors.length + ' 条写入失败' : '')) : '整理失败：' + report.error, !report.ok);
          return;
        } else if (action === 'mem-summary') {
          memory.setSummary($('#ra-summary').value);
          toast('梗概已保存');
          return;
        } else if (action === 'mem-export') {
          download('reader-ii-memory-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(await memory.exportAll(), null, 2));
          return;
        } else if (action === 'mem-import') {
          var text = await pickFile();
          if (!text) return;
          var outcome = await memory.importAll(text);
          await renderMemory();
          toast('导入完成：新增 ' + outcome.added + ' 条，跳过 ' + outcome.skipped + ' 条' + (outcome.errors.length ? '，失败 ' + outcome.errors.length + ' 条' : ''), outcome.errors.length > 0);
          return;
        }
        await renderMemory();
      } catch (error) {
        toast(String(error && error.message || error), true);
      }
    }

    /* ---------- 设置页 ---------- */
    function renderSettings() {
      var pane = $('[data-pane="settings"] .ra-scroll');
      if (!pane) return;
      var a = agent.getSettings();
      var m = memory.getSettings();
      var option = function (value, label, current) { return '<option value="' + value + '"' + (String(current) === String(value) ? ' selected' : '') + '>' + label + '</option>'; };
      var number = function (name, value, minimum, maximum, step) { return '<input type="number" data-s="' + name + '" value="' + esc(value) + '" min="' + minimum + '" max="' + maximum + '"' + (step ? ' step="' + step + '"' : '') + ' style="width:120px">'; };
      var check = function (name, value, label) { return '<label class="ra-check wide"><input type="checkbox" data-s="' + name + '"' + (value ? ' checked' : '') + '>' + label + '</label>'; };
      var route = function (key, label) {
        var backend = llm.getBackendSummary(key);
        return '<p class="ra-note">' + label + '：' + esc(backend.mode === 'custom' ? backend.model + ' · ' + backend.apiurl : '酒馆当前连接') + '</p>';
      };
      pane.innerHTML = '<div class="ra-card"><h3>助手</h3><div class="ra-form">'
        + '<label>权限档位</label><select data-s="a.mode">' + option('readonly', '只读：只看不改', a.mode) + option('card', '单卡：只改当前聊天和这张卡（推荐）', a.mode) + option('tavern', '酒馆全权：酒馆里的一切', a.mode) + option('device', '设备全权：再加上设备上的文件与命令（需后端伴侣）', a.mode) + '</select>'
        + '<label>确认方式</label><select data-s="a.approval">' + option('ask', '每次写入前询问（推荐）', a.approval) + option('auto', '档位内直接执行，危险操作仍询问', a.approval) + option('yolo', '全部直接执行', a.approval) + '</select>'
        + check('a.plotContext', a.plotContext, '让助手了解当前剧情（做前后端、修脚本时可以关掉，省 token）')
        + check('a.lite', a.lite, '轻聊：不带任何工具，只聊天')
        + '<label>最多工具步数</label>' + number('a.maxSteps', a.maxSteps, 1, 40)
        + '<label>带入历史轮数</label>' + number('a.historyTurns', a.historyTurns, 0, 40)
        + '<label>温度</label>' + number('a.temperature', a.temperature, 0, 2, 0.05)
        + '<label>输出上限</label>' + number('a.maxTokens', a.maxTokens, 256, 64000)
        + '<label>单次超时（秒）</label>' + number('a.timeoutSec', a.timeoutSec, 20, 900)
        + check('a.recall', a.recall, '回答前自动带入相关记忆')
        + '</div><p class="ra-note">输出上限与温度只对独立 API 生效；走酒馆连接时沿用当前预设。</p></div>'
        + rulesCardHtml(a.rules)
        + '<div class="ra-card"><h3>记忆</h3><div class="ra-form">'
        + check('m.enabled', m.enabled, '启用记忆系统')
        + '<label>自动整理与带入正文</label><select data-s="m.scope">' + option('reader', '只在用了 Reader-II 的聊天里（推荐）', m.scope) + option('all', '所有聊天', m.scope) + '</select>'
        + '<label>新记忆写到</label><select data-s="m.store">' + option('chat', '当前聊天（随存档，互不相干）', m.store) + option('ocean', '《夜之洋》世界书（跨存档）', m.store) + '</select>'
        + check('m.autoExtract', m.autoExtract, '自动整理：对话攒够下面任一数量后，把它沉淀为记忆')
        + '<label>每多少条回复</label>' + number('m.everyTurns', m.everyTurns, 0, 200)
        + '<label>或每多少字</label>' + number('m.everyChars', m.everyChars, 0, 400000)
        + '<label>最近几条先不整理</label>' + number('m.keepRecent', m.keepRecent, 0, 20)
        + check('m.inject', m.inject, '把相关记忆带进正文提示词')
        + '<label>注入深度</label>' + number('m.injectDepth', m.injectDepth, 0, 40)
        + '<label>最多带几条</label>' + number('m.injectMax', m.injectMax, 1, 30)
        + '<label>字数预算</label>' + number('m.injectBudget', m.injectBudget, 200, 20000)
        + check('m.injectSummary', m.injectSummary, '同时带上前情梗概')
        + check('m.agentExtract', m.agentExtract, '与助手的对话也沉淀为记忆（情感、偏好、做法）')
        + check('m.unify', m.unify, '助手夜梦 = 正文夜梦：助手自己的记忆也带进正文（功能记忆除外；正文里不主动超游）')
        + '<label>夜之洋书名</label><input type="text" data-s="m.oceanBook" value="' + esc(m.oceanBook) + '" maxlength="60">'
        + '<label>夜之洋挂载</label><select data-s="m.oceanMount">' + option('global', '全局启用：所有角色卡的聊天都能想起', m.oceanMount) + option('character', '绑到当前角色卡：只在这张卡的各个存档间共享', m.oceanMount) + option('none', '不挂载：只由脚本检索带入', m.oceanMount) + '</select>'
        + '</div><p class="ra-note">两个数量都填 0 时只在手动点“立即整理”时整理。已挂载的《夜之洋》由酒馆按触发词原生带入正文；当前聊天里的记忆、以及未挂载的《夜之洋》由脚本带入。没打开“同一个人”时，助手自己的记忆不进正文，它们在《夜之洋》里的条目保持停用。</p></div>'
        + '<div class="ra-card"><h3>模型</h3>' + route('agent', '助手对话') + route('memory', '记忆整理') + route('adapt', '语义适配')
        + '<p class="ra-note">三项各自对应「独立 API」里的调用类型；没有单独设置时用默认方案，默认方案也没有时走酒馆当前连接。</p>'
        + '<div class="ra-row"><button type="button" class="ra-btn" data-act="open-api">打开独立 API 设置</button><button type="button" class="ra-btn" data-act="open-panel">打开语义适配面板</button></div></div>'
        + '<div class="ra-row"><button type="button" class="ra-btn is-main" data-act="save-settings">保存设置</button><span class="ra-status" data-ra-status="settings"></span></div>'
        + connectorsCardHtml()
        + (netUi ? netUi.cardsHtml() : '')
        + updatesCardHtml()
        + '<div class="ra-card"><h3>改动记录</h3><p class="ra-note">助手每一轮改过的东西都留有改动前的样子，可以按轮撤销。之后又被别处改过的不会被强行覆盖。</p><div id="ra-runs"></div></div>';
      renderRuns();
    }

    /* ---------- 权限规则与插件对接（设置页） ---------- */
    var RULE_EFFECT = { deny: '禁止', ask: '总是先问', allow: '免问' };
    var RULE_ACTION = { '*': '读写', read: '只管读', write: '只管写' };

    function ruleRowHtml(rule) {
      var opts = function (map, current) { return Object.keys(map).map(function (key) { return '<option value="' + key + '"' + (key === current ? ' selected' : '') + '>' + map[key] + '</option>'; }).join(''); };
      return '<div class="ra-row" data-rule style="margin:4px 0"><select data-r="effect">' + opts(RULE_EFFECT, rule.effect || 'deny') + '</select><select data-r="action">' + opts(RULE_ACTION, rule.action || '*') + '</select>'
        + '<input type="text" data-r="pattern" value="' + esc(rule.pattern || '') + '" placeholder="路径或工具名，如 wb:/日记/**" style="flex:1;min-width:160px">'
        + '<button type="button" class="ra-btn is-small is-bad" data-act="rule-del">删除</button></div>';
    }

    function rulesCardHtml(rules) {
      return '<div class="ra-card"><h3>权限规则</h3><p class="ra-note">按路径或工具名匹配：<code>*</code> 不跨“/”，<code>**</code> 跨层级。禁止优先，其余取第一条匹配的。例：<code>wb:/日记/**</code> 禁止读写这本世界书；<code>var:/chat.json*</code> 写聊天变量免问；<code>slash_run</code> 斜杠命令总是先问。档位不够的写入照样不执行。</p>'
        + '<div id="ra-rules">' + (rules || []).map(ruleRowHtml).join('') + '</div>'
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="rule-add">添加规则</button><span class="ra-note">改完点“保存设置”。</span></div></div>';
    }

    function readRules() {
      return Array.prototype.map.call(overlay.querySelectorAll('[data-rule]'), function (row) {
        var get = function (name) { return row.querySelector('[data-r="' + name + '"]').value; };
        return { effect: get('effect'), action: get('action'), pattern: get('pattern').trim() };
      }).filter(function (rule) { return rule.pattern; });
    }

    /* 乙组的 MCP 服务器放进 #ra-mcp（data-slot="mcp"）。 */
    function connectorsCardHtml() {
      var custom = agent.getSettings().connectors || [];
      var active = agent.listConnectors();
      var activeIds = active.map(function (item) { return item.id; });
      var builtin = active.filter(function (item) { return !item.custom; }).map(function (item) { return '<span class="ra-badge" title="' + esc(item.summary || '') + '">' + esc(item.title) + '</span>'; }).join(' ');
      var rows = custom.map(function (manifest) {
        return '<div class="ra-row" data-conn="' + esc(manifest.id) + '" style="justify-content:space-between;margin:4px 0"><span><b>' + esc(manifest.title || manifest.id) + '</b> <span class="ra-note">' + esc(manifest.id) + ' · ' + (activeIds.indexOf(manifest.id) >= 0 ? '已探测到' : '没探测到（插件没装或还没加载）') + '</span></span>'
          + '<span class="ra-row"><button type="button" class="ra-btn is-small" data-act="conn-view">查看</button><button type="button" class="ra-btn is-small is-bad" data-act="conn-del">删除</button></span></div>';
      }).join('');
      return '<div class="ra-card" id="ra-conn-card"><h3>插件对接</h3><p class="ra-note">已探测到：</p><div class="ra-row">' + (builtin || '<span class="ra-note">没有</span>') + '</div>'
        + '<p class="ra-note" style="margin-top:10px">自定义对接（声明式 connector.json，格式见知识 connector-authoring，也可以让助手替你写）：</p>'
        + (rows || '<p class="ra-note">还没有。</p>')
        + '<textarea id="ra-conn-json" spellcheck="false" placeholder="{&quot;id&quot;: &quot;myplugin&quot;, &quot;title&quot;: &quot;我的插件&quot;, &quot;detect&quot;: &quot;window.MyPlugin&quot;, &quot;tools&quot;: […]}" style="width:100%;min-height:110px;margin-top:6px;box-sizing:border-box"></textarea>'
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="conn-save">添加 / 按 id 更新</button><span class="ra-note">这一栏的改动立即生效。</span></div>'
        + '<div id="ra-mcp" data-slot="mcp">' + (netUi ? netUi.mcpHtml() : '') + '</div></div>';
    }

    /* 联网、MCP、后端伴侣三块设置在 ui-net.js；这里只留插槽与分发。 */
    var netUi = deps && typeof deps.netUi === 'function' ? deps.netUi({
      $: $, esc: esc, toast: toast,
      ask: function (text) { showTab('chat'); if (!running) send(text); }
    }) : null;

    function settingsAction(action, actor) {
      try {
        if (action === 'rule-add') { $('#ra-rules').insertAdjacentHTML('beforeend', ruleRowHtml({})); return; }
        if (action === 'rule-del') { actor.closest('[data-rule]').remove(); return; }
        var list = (agent.getSettings().connectors || []).slice();
        var row = actor.closest('[data-conn]');
        var id = row ? row.getAttribute('data-conn') : '';
        if (action === 'conn-view') {
          var found = list.filter(function (item) { return item.id === id; })[0];
          if (found) $('#ra-conn-json').value = JSON.stringify(found, null, 2);
          return;
        }
        if (action === 'conn-del') {
          if (actor.getAttribute('data-armed') !== '1') { actor.setAttribute('data-armed', '1'); actor.textContent = '再点一次删除'; return; }
          agent.saveSettings({ connectors: list.filter(function (item) { return item.id !== id; }) });
          toast('已删除对接 ' + id);
        } else if (action === 'conn-save') {
          var manifest;
          try { manifest = JSON.parse($('#ra-conn-json').value); } catch (error) { throw new Error('对接描述不是合法的 JSON：' + error.message); }
          var checked = agent.validateConnector(manifest);
          agent.saveSettings({ connectors: list.filter(function (item) { return item.id !== checked.id; }).concat([manifest]) });
          toast('已保存对接「' + checked.title + '」，' + checked.tools + ' 个工具' + (checked.detected ? '' : '；暂时没探测到这个插件'));
        }
        var card = $('#ra-conn-card');
        if (card) card.outerHTML = connectorsCardHtml();
      } catch (error) {
        toast(String(error && error.message || error), true);
      }
    }

    /* ---------- 检查更新（设置页；交接 0.6 甲组第 9 项，逻辑在 updates.js） ---------- */
    var updates = deps && deps.updates || null;
    var updatesView = '', updatesPlan = null;
    var GUIDE_EXT = '<ol class="ra-upd-list"><li>酒馆顶栏「扩展」（三个方块的图标）→「管理扩展」→ 找到「Reader-II · 夜梦」，点它的更新按钮（就是 git pull）。TauriTavern 在扩展管理里同样操作。当初是手动拷贝安装的，重新下载后覆盖 <code>manifest.json</code>、<code>index.js</code>、<code>dist/</code>、<code>knowledge/</code>。</li>'
      + '<li>刷新酒馆页面。</li><li>回到这里点「检查卡内组件」，把卡内组件更新到同一版本。</li></ol>'
      + '<p class="ra-note">设置、记忆、工作区、对话记录都不在扩展目录里，更新扩展不会动它们。不要直接改扩展目录里的文件（git pull 会因此失败，或把改动冲掉）：自定义的东西放工作区 <code>ws:/</code>，或者另写一个扩展。</p>';
    var GUIDE_CDN = '<p class="ra-note">你没有装扩展，夜梦助手是从 CDN 加载的：刷新页面就会拿到新版（jsDelivr 有缓存，可能要等几个小时）。想及时更新，可以装上扩展。</p>';
    var UPDATE_MARK = { current: '✓', missing: '＋', outdated: '↑', modified: '✎', unavailable: '—', blocked: '!' };

    function updatesCardHtml() {
      if (!updates) return '';
      var s = updates.getSettings(), carrier = updates.carrier();
      var last = s.installed && s.installed.version ? '；上次代装 v' + esc(s.installed.version) : '';
      return '<div class="ra-card" id="ra-upd-card"><h3>检查更新</h3>'
        + '<p class="ra-note">当前版本 <b>v' + esc(updates.version) + '</b>（' + (carrier === 'cdn' ? '从 CDN 加载' : carrier === 'extension' ? '酒馆扩展' : '载入方式未知') + '）' + last + '。</p>'
        + '<div class="ra-row"><button type="button" class="ra-btn" data-act="upd-check">检查更新</button><button type="button" class="ra-btn" data-act="upd-inspect">检查卡内组件</button></div>'
        + '<details><summary class="ra-note">更新源（每行一个地址，按顺序尝试）</summary><textarea id="ra-upd-remotes" style="width:100%;min-height:56px">' + esc(s.remotes.join('\n')) + '</textarea>'
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="upd-remotes">保存更新源</button><button type="button" class="ra-btn is-small" data-act="upd-reset">恢复默认</button></div></details>'
        + '<div id="ra-upd-out" aria-live="polite">' + updatesView + '</div></div>';
    }

    function checkHtml(result) {
      var errors = result.errors && result.errors.length ? '<p class="ra-note">没连上的更新源：' + result.errors.map(esc).join('；') + '</p>' : '';
      if (!result.ok) return '<p class="ra-upd-bad">检查失败，不能据此判断已是最新。</p>' + errors;
      if (result.status === 'newer') return '<p class="ra-upd-ok">有新版本 <b>v' + esc(result.latest) + '</b>（当前 v' + esc(result.current) + '）。</p>' + (result.carrier === 'cdn' ? GUIDE_CDN : GUIDE_EXT) + errors;
      if (result.status === 'older') return '<p>当前 v' + esc(result.current) + ' 比更新源上的 v' + esc(result.latest) + ' 还新（开发中的版本）。</p>' + errors;
      return '<p>已是最新：v' + esc(result.current) + '（更新源 ' + esc(result.source) + '）。卡内组件要和扩展同一版本，可以点「检查卡内组件」看一眼。</p>' + errors;
    }

    function planHtml(plan) {
      var rows = plan.items.map(function (item) {
        var details = item.details && item.details.length && item.status !== 'current' ? '<ul class="ra-upd-list">' + item.details.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('') + '</ul>' : '';
        return '<li data-upd="' + esc(item.key) + '" data-status="' + esc(item.status) + '">' + (UPDATE_MARK[item.status] || '·') + ' <b>' + esc(item.label) + '</b>：' + esc(item.text) + details + '</li>';
      }).join('');
      var needsScope = plan.items.some(function (item) { return item.action === 'install' && (item.key === 'script' || item.key === 'worldbook'); });
      var scope = needsScope ? '<div class="ra-row"><label>新装到</label><select id="ra-upd-scope"><option value="character"' + (plan.scope === 'character' ? ' selected' : '') + '>当前角色卡（推荐）</option><option value="global"' + (plan.scope === 'global' ? ' selected' : '') + '>全局（每个聊天都运行）</option></select></div>' : '';
      var notes = plan.notes.length ? '<p class="ra-upd-bad">' + plan.notes.map(esc).join('<br>') + '</p>' : '';
      var action = plan.actions
        ? '<div class="ra-row"><button type="button" class="ra-btn is-main" data-act="upd-apply">安装 / 更新卡内组件（' + plan.actions + ' 项）</button></div><p class="ra-note">动手前会再核对一遍；写到一半出错，已写的会退回。被替换的世界书条目留作停用的备份，你改过的不覆盖。</p>'
        : '<p>卡内组件不需要改动。</p>';
      return '<p>卡内组件 v' + esc(plan.version) + '（来源 ' + esc(plan.source) + '，全部校验通过）：</p><ul class="ra-upd-list">' + rows + '</ul>' + scope + notes + action;
    }

    function reportHtml(report) {
      var parts = ['<p class="ra-upd-ok">' + (report.done.length ? '已完成：' + report.done.map(esc).join('、') : '没有需要改动的') + '。</p>'];
      if (report.kept.length) parts.push('<p class="ra-note">没有覆盖（你改过）：' + report.kept.map(esc).join('、') + '</p>');
      if (report.notes.length) parts.push('<p class="ra-upd-bad">' + report.notes.map(esc).join('<br>') + '</p>');
      if (report.reload) parts.push('<p class="ra-note">刷新页面后全部生效。</p>');
      return parts.join('');
    }

    function setUpdatesView(html) {
      updatesView = html;
      var out = $('#ra-upd-out');
      if (out) out.innerHTML = html;
    }

    async function updatesAction(action, actor) {
      if (!updates) return;
      try {
        if (action === 'upd-remotes') { updates.saveSettings({ remotes: ($('#ra-upd-remotes') || {}).value || '' }); toast('更新源已保存'); return; }
        if (action === 'upd-reset') {
          updates.saveSettings({ remotes: [] });
          var card = $('#ra-upd-card');
          if (card) card.outerHTML = updatesCardHtml();
          toast('已恢复默认更新源');
          return;
        }
        if (action === 'upd-check') { setUpdatesView('<p class="ra-note">正在检查…</p>'); setUpdatesView(checkHtml(await updates.checkRemote())); return; }
        if (action === 'upd-inspect') {
          var select = $('#ra-upd-scope'), options = select ? { scope: select.value } : {};
          updatesPlan = null;
          setUpdatesView('<p class="ra-note">正在下载并校验卡内组件…</p>');
          updatesPlan = await updates.inspect(options);
          setUpdatesView(planHtml(updatesPlan));
          return;
        }
        if (action === 'upd-apply') {
          if (!updatesPlan) throw new Error('请先点「检查卡内组件」');
          if (actor.getAttribute('data-armed') !== '1') { actor.setAttribute('data-armed', '1'); actor.textContent = '再点一次确认'; return; }
          actor.disabled = true;
          var plan = updatesPlan;
          updatesPlan = null;
          setUpdatesView(reportHtml(await updates.apply(plan)));
        }
      } catch (error) {
        var text = String(error && error.message || error);
        setUpdatesView('<p class="ra-upd-bad">' + esc(text).replace(/\n/g, '<br>') + '</p>');
        toast(text.split('\n')[0], true);
      }
    }

    /* ---------- 改动记录与撤销 ---------- */
    var forceUndo = Object.create(null);

    function renderRuns() {
      var box = $('#ra-runs');
      if (!box || typeof agent.listRuns !== 'function') return;
      agent.listRuns(12).then(function (runs) {
        if (!runs.length) { box.innerHTML = '<p class="ra-note">还没有改动记录。</p>'; return; }
        box.innerHTML = runs.map(function (run) {
          var notes = (run.notes || []).length ? '<br><span class="ra-note">无法自动撤销：' + esc(run.notes.join('；')) + '</span>' : '';
          var button = run.changes && !run.undone
            ? '<button type="button" class="ra-btn is-small' + (forceUndo[run.id] ? ' is-bad' : '') + '" data-act="undo-run" data-run="' + esc(run.id) + '">' + (forceUndo[run.id] ? '强制撤销' : '撤销') + '</button>' : '';
          return '<div class="ra-row" style="justify-content:space-between;gap:8px;margin:6px 0"><span>' + esc(new Date(run.startedAt).toLocaleString()) + ' · ' + esc(run.title || '')
            + ' · 改动 ' + run.changes + ' 处' + (run.undone ? '（已撤销）' : '') + notes + '</span>' + button + '</div>';
        }).join('');
      }).catch(function () { box.innerHTML = '<p class="ra-note">读取记录失败。</p>'; });
    }

    function undoRun(actor) {
      var id = actor.getAttribute('data-run');
      actor.disabled = true;
      agent.undo(id, { force: forceUndo[id] === true }).then(function (report) {
        if (report.conflicts.length) {
          forceUndo[id] = true;
          toast('已恢复 ' + report.restored.length + ' 处；另有 ' + report.conflicts.length + ' 处' + report.conflicts[0].reason + '，再点一次可强制恢复', true);
        } else {
          delete forceUndo[id];
          toast('已撤销这一轮的 ' + report.restored.length + ' 处改动');
        }
        renderRuns();
      }).catch(function (error) { toast(String(error && error.message || error), true); renderRuns(); });
    }

    function saveSettingsFromForm() {
      var agentPatch = {}, memoryPatch = {};
      overlay.querySelectorAll('[data-s]').forEach(function (input) {
        var key = input.getAttribute('data-s');
        var value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
        if (key.indexOf('a.') === 0) agentPatch[key.slice(2)] = value;
        else memoryPatch[key.slice(2)] = value;
      });
      if ($('#ra-rules')) agentPatch.rules = readRules();
      agent.saveSettings(agentPatch);
      memory.saveSettings(memoryPatch);
      renderSettings();
      refreshFoot();
      toast('设置已保存');
    }

    /* ---------- 面板 ---------- */
    function showTab(next) {
      tab = next === 'memory' || next === 'settings' ? next : 'chat';
      if (!overlay) return;
      overlay.querySelectorAll('.ra-tab').forEach(function (button) { button.setAttribute('aria-selected', String(button.getAttribute('data-tab') === tab)); });
      overlay.querySelectorAll('.ra-pane').forEach(function (pane) { pane.classList.toggle('is-on', pane.getAttribute('data-pane') === tab); });
      if (tab === 'memory') renderMemory();
      else if (tab === 'settings') renderSettings();
      else { refreshFoot(); var input = $('#ra-text'); if (input) { try { input.focus(); } catch (error) { /* ignore */ } } }
    }

    function build() {
      ensureStyle();
      overlay = doc.createElement('dialog');
      overlay.id = OVERLAY_ID;
      overlay.setAttribute('aria-label', '夜梦助手');
      overlay.innerHTML = '<div class="ra-shell"><header class="ra-head"><div class="ra-id"><b>九十九夜梦</b><i id="ra-persona">READER AGENT</i></div>'
        + '<nav class="ra-tabs" role="tablist"><button type="button" class="ra-tab" role="tab" data-tab="chat">对话</button><button type="button" class="ra-tab" role="tab" data-tab="memory">记忆</button><button type="button" class="ra-tab" role="tab" data-tab="settings">设置</button></nav>'
        + '<button type="button" class="ra-close" data-act="close" aria-label="关闭">×</button></header>'
        + '<section class="ra-pane" data-pane="chat"><div class="ra-log" id="ra-log" aria-live="polite"></div>'
        + '<div class="ra-quick"><button type="button" class="ra-chip" data-quick="看看现在 Reader 的状态。">看看状态</button><button type="button" class="ra-chip" data-quick="帮我把这张卡的变量适配到 Reader-II，逐项告诉我结果。">适配这张卡</button><button type="button" class="ra-chip" data-quick="把最近的对话整理成记忆，告诉我记下了什么。">整理记忆</button><button type="button" class="ra-chip" data-quick="你还记得关于我和这个故事的哪些事？">你还记得什么</button></div>'
        + '<div class="ra-input"><textarea id="ra-text" placeholder="想问什么、想让我做什么，直接说。Enter 发送，Shift+Enter 换行"></textarea><button type="button" class="ra-btn is-main" id="ra-send">发送</button></div>'
        + '<div class="ra-foot"><span id="ra-foot-text"></span><button type="button" class="ra-btn is-small" data-act="clear">清空对话</button></div></section>'
        + '<section class="ra-pane" data-pane="memory"><div class="ra-scroll"></div></section>'
        + '<section class="ra-pane" data-pane="settings"><div class="ra-scroll"></div></section></div>';
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) { close(); return; }
        var tabButton = event.target.closest('.ra-tab');
        if (tabButton) { showTab(tabButton.getAttribute('data-tab')); return; }
        var quick = event.target.closest('[data-quick]');
        if (quick && !running) { send(quick.getAttribute('data-quick')); return; }
        if (event.target.closest('#ra-send')) { send(); return; }
        var actor = event.target.closest('[data-act]');
        if (!actor) return;
        var action = actor.getAttribute('data-act');
        if (action === 'close') close();
        else if (action === 'clear') {
          if (running) return;
          if (actor.getAttribute('data-armed') !== '1') { actor.setAttribute('data-armed', '1'); actor.textContent = '再点一次清空'; setTimeout(function () { actor.removeAttribute('data-armed'); actor.textContent = '清空对话'; }, 3000); return; }
          actor.removeAttribute('data-armed'); actor.textContent = '清空对话';
          agent.clearHistory(); renderHistory();
        }
        else if (action === 'save-settings') saveSettingsFromForm();
        else if (action === 'open-api') { close(); var shell = deps.shell && deps.shell(); if (shell) shell.command('openIndependentApiSettings'); }
        else if (action === 'open-panel') { close(); var core = deps.core && deps.core(); if (core && core.openPanel) core.openPanel(); }
        else if (action === 'undo-run') undoRun(actor);
        else if (action.indexOf('mem-') === 0) memoryAction(action, actor);
        else if (action.indexOf('rule-') === 0 || action.indexOf('conn-') === 0) settingsAction(action, actor);
        else if (action.indexOf('upd-') === 0) updatesAction(action, actor);
        else if (netUi && /^(?:net|mcp|comp)-/.test(action)) netUi.action(action, actor, event);
      });
      overlay.addEventListener('change', function (event) {
        if (netUi && netUi.change(event)) return;
        if (event.target.id === 'ra-upd-scope' && updates) {
          try { updates.saveSettings({ scope: event.target.value }); } catch (error) { /* 下面重新检查时会报出来 */ }
          updatesAction('upd-inspect');
          return;
        }
        if (event.target.id === 'ra-store') {
          try { memory.setChatStoreOverride(event.target.value); renderMemory(); refreshFoot(); } catch (error) { toast(String(error && error.message || error), true); }
        }
      });
      overlay.addEventListener('input', function (event) {
        if (event.target.id === 'ra-mem-q') {
          memoryFilter.query = event.target.value;
          clearTimeout(overlay.__raSearch);
          overlay.__raSearch = setTimeout(function () {
            renderMemory().then(function () { var input = $('#ra-mem-q'); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
          }, 300);
        }
      });
      overlay.addEventListener('keydown', function (event) {
        if (event.target.id === 'ra-text' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
        /* 输入事件不冒泡到酒馆：聊天页的快捷键不该在面板里触发。 */
        event.stopPropagation();
      });
      overlay.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
      doc.body.appendChild(overlay);
    }

    function open(target) {
      if (!doc || !doc.createElement) throw new Error('当前环境无法打开夜梦助手');
      var stale = doc.getElementById(OVERLAY_ID);
      if (stale && stale !== overlay) stale.remove();
      if (!overlay || !overlay.isConnected) build();
      overlay.setAttribute('data-theme', themeName());
      if (!overlay.open) {
        try { overlay.showModal(); } catch (error) { overlay.setAttribute('open', ''); }
      }
      if (!running) renderHistory();
      showTab(target || tab);
      if (!unsubscribe.length) {
        /* 设置被别处改了（斜杠命令、插件、助手自己）时，底栏跟着更新。 */
        unsubscribe.push(agent.onChange(function (reason) { if (reason === 'settings' && overlay && overlay.open) refreshFoot(); }));
        unsubscribe.push(memory.onChange(function (reason) {
          if (!overlay || !overlay.open) return;
          if (reason === 'chat') { if (!running) renderHistory(); refreshFoot(); }
          if (tab === 'memory' && reason !== 'settings' && !editing) renderMemory();
        }));
      }
      return true;
    }

    function close() {
      if (!overlay) return;
      try { if (overlay.open && typeof overlay.close === 'function') overlay.close(); else overlay.removeAttribute('open'); } catch (error) { overlay.removeAttribute('open'); }
    }

    function dispose() {
      pendingConfirms.slice().forEach(function (finish) { finish('deny'); });
      unsubscribe.forEach(function (stop) { try { stop(); } catch (error) { /* ignore */ } });
      unsubscribe = [];
      close();
      if (overlay) overlay.remove();
      overlay = null;
      var style = doc && doc.getElementById(STYLE_ID);
      if (style) style.remove();
    }

    return { open: open, close: close, dispose: dispose, isOpen: function () { return !!(overlay && overlay.open); } };
  }

  modules.createAgentUi = createAgentUi;
})(typeof globalThis !== 'undefined' ? globalThis : window);
