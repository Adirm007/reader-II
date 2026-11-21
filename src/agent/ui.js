(function (root) {
  'use strict';

  /*
   * 夜梦助手窗口：对话 / 记忆 / 设置 三页，画在酒馆主文档里。
   * 用 <dialog>.showModal() 进入浏览器顶层，大厅与抽卡面板的 z-index 盖不住它。
   * 样式在 ui-theme.js（与语义适配面板共用一套主题变量与外框），这里只有标记与接线。
   * 可从大厅的彩蛋服务台进入，也可从无卡或停用卡的 Reader-II 入口直接进入。
   * 标记里的 id、data-act、data-tab、data-s 等是冒烟脚本认的约定（tools/smoke/），改名要两边一起改。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var OVERLAY_ID = 'reader-agent-overlay';
  var TYPE_ORDER = ['episode', 'fact', 'bond', 'howto'];
  var INPUT_MAX_HEIGHT = 160;   /* 输入框随内容长高到这里为止，再多就在框里滚动 */
  /* 设置页和目录使用相同的顺序。 */
  var SECTIONS = [
    ['ra-reader-card', '这张卡'], ['ra-placement-card', '正文提示词位置'], ['ra-agent-card', '助手'], ['ra-tools-card', '工具调用'], ['ra-rules-card', '权限规则'],
    ['ra-memory-card', '记忆'], ['ra-connections-card', '模型连接'], ['ra-model-card', '主模型'], ['ra-delegation-card', '子代理'], ['ra-media-card', '媒体工具'], ['ra-conn-card', '插件对接'], ['ra-mcp-card', 'MCP 工具服务'], ['ra-net-card', '联网'],
    ['ra-comp-card', '后端伴侣'], ['ra-upd-card', '版本更新'], ['ra-runs-card', '改动记录']
  ];
  var TOOL_MODE = { native: '原生调用', text: '文本协议', none: '不可用' };

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

  function imageHtml(images) {
    return (Array.isArray(images) ? images : []).map(function (item, index) {
      var url = item && item.url;
      if (typeof url !== 'string' || !/^(?:https?:\/\/[^\s"'<>]+|data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+)$/i.test(url)) return '';
      return '<img class="ra-generated" loading="lazy" referrerpolicy="no-referrer" alt="生成的图片 ' + (index + 1) + '" src="' + esc(url) + '">';
    }).join('');
  }
  function mediaHtml(message) {
    return imageHtml(message.images) + (Array.isArray(message.videos) ? message.videos : []).map(function (item, index) {
      var url = item && item.url;
      if (typeof url !== 'string' || !/^(?:https?:\/\/[^\s"'<>]+|data:video\/(?:mp4|webm|ogg|quicktime);base64,[a-z0-9+/=]+)$/i.test(url)) return '';
      return '<video class="ra-generated" controls playsinline preload="metadata" aria-label="生成的视频 ' + (index + 1) + '" src="' + esc(url) + '"></video>';
    }).join('');
  }

  function createAgentUi(env, kit, agent, memory, llm, deps) {
    var doc = env.document;
    var host = env.host || root;
    var theme = modules.readerTheme || null;
    var overlay = null;
    var tab = 'chat';
    var running = false;
    var runningChat = null;
    var pendingUserNode = null;
    var pendingInput = '', contextUsage = null, loadingThreads = false;
    var threadRefresh = 0;
    var threads = agent.threads;
    var pendingConfirms = [];
    var permissionReview = null;
    var memoryFilter = { type: '', store: '', query: '' };
    var editing = null;
    var unsubscribe = [];
    var dirty = false;      /* 要点「保存设置」才生效的那四块（助手、工具调用、权限规则、记忆）有没有没保存的改动 */
    var probeView = '';     /* 「测试工具调用」的结果；重画设置页时还在 */
    var spyHold = 0;        /* 点了目录之后的一小段时间里，不让滚动反过来改目录的高亮 */

    function icon(name) { return theme ? theme.icon(name) : ''; }
    function themeName() { return theme ? theme.name(env, kit) : 'cafe'; }
    function lobbyApi() { return deps && typeof deps.lobby === 'function' ? deps.lobby() : null; }
    function coreApi() { return deps && typeof deps.core === 'function' ? deps.core() : null; }
    function message(error) { return String(error && error.message || error); }

    /* 触屏上回车留给换行（软键盘按不出 Shift+Enter），发送靠按钮。 */
    function touchInput() {
      try { return !!(host.matchMedia && host.matchMedia('(pointer: coarse)').matches); } catch (error) { return false; }
    }
    function calmMotion() {
      try { return !!(host.matchMedia && host.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (error) { return false; }
    }

    function $(selector) { return overlay ? overlay.querySelector(selector) : null; }

    function toast(text, bad) {
      var target = $('[data-ra-status="' + tab + '"]');
      if (!target) return;
      target.textContent = text || '';
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
      var node = append('<span class="ra-dots">' + esc(label) + '<i></i><i></i><i></i></span>', 'ra-thought');
      if (node) node.id = 'ra-thinking';
    }

    /* 运行中途的一行提示：protocol（原生调用走不通，改走文本协议）、nudge（她只说不做，已提醒一次）。 */
    function notice(kind, text) {
      clearIndicator();
      var node = append(icon('info') + '<span>' + esc(text) + '</span>', 'ra-notice');
      if (node) node.setAttribute('data-notice', kind);
    }

    function showTurn(node, turn) {
      if (!node) return;
      node.dataset.turnId = turn.id;
      node.__raSnapshot = { chatKey: kit.chatKey(), threadId: threads.currentId(), originalText: turn.text };
      node.classList.remove('is-editing');
      var label = turn.role === 'user' ? '编辑用户消息' : '编辑夜梦消息';
      node.innerHTML = '<div class="ra-msg-text">' + rich(turn.text) + '</div>' + mediaHtml(turn)
        + (threads.canRun() ? '<button type="button" class="ra-msg-edit" data-act="turn-edit" aria-label="' + label + '" title="' + label + '">' + icon('pencil') + '</button>' : '');
    }

    async function editTurn(action, button) {
      var node = button.closest('.ra-msg');
      if (!node || !node.__raSnapshot) return;
      var snapshot = node.__raSnapshot;
      if (kit.chatKey() !== snapshot.chatKey || threads.currentId() !== snapshot.threadId) { renderHistory(); return; }
      var id = node.dataset.turnId;
      if (action === 'turn-edit') {
        node.classList.add('is-editing');
        node.innerHTML = '<textarea rows="4" data-turn-text aria-label="消息正文"></textarea>'
          + '<div class="ra-row"><button type="button" class="ra-btn is-small is-main" data-act="turn-save">保存</button>'
          + '<button type="button" class="ra-btn is-small" data-act="turn-cancel">取消</button><span role="status" class="ra-turn-status"></span></div>';
        var field = node.querySelector('[data-turn-text]');
        field.value = snapshot.originalText;
        field.focus();
        return;
      }
      var turn;
      if (action === 'turn-save') {
        var controls = node.querySelectorAll('textarea,button');
        controls.forEach(function (control) { control.disabled = true; });
        try { turn = await agent.editHistoryTurn(id, node.querySelector('[data-turn-text]').value, snapshot); }
        catch (error) {
          controls.forEach(function (control) { control.disabled = false; });
          node.querySelector('.ra-turn-status').textContent = message(error);
          return;
        }
      } else {
        var history = agent.getHistory();
        turn = id === 'greeting' && !history.length ? agent.getGreeting() : history.find(function (item) { return item.id === id; });
      }
      if (!node.isConnected) return;
      if (!turn || kit.chatKey() !== snapshot.chatKey || threads.currentId() !== snapshot.threadId) { renderHistory(); return; }
      showTurn(node, turn);
      node.querySelector('[data-act="turn-edit"]').focus({ preventScroll: true });
    }

    function renderHistory() {
      var log = logNode();
      if (!log) return;
      log.innerHTML = '';
      var turns = agent.getHistory();
      var checkpoint = threads.checkpoint();
      if (checkpoint) {
        var handoff = checkpoint.task ? '<p class="ra-note">任务：' + esc(checkpoint.task) + '</p>' : '';
        append('<details class="ra-fold"><summary>' + icon('chevron') + '上下文摘要</summary><div class="ra-fold-body">' + handoff + '<div>' + rich(checkpoint.text) + '</div></div></details>', 'ra-checkpoint');
      }
      var rows = threads.list(), currentId = threads.currentId();
      var active = rows.find(function (row) { return row.id === currentId; });
      if (active && active.nextId && rows.some(function (row) { return row.id === active.nextId; })) {
        append('<button type="button" class="ra-btn is-small" data-act="thread-next" data-thread-target="' + esc(active.nextId) + '">打开交接后的对话</button>', 'ra-thought');
      }
      if (!turns.length) {
        if (!checkpoint) showTurn(append('', 'ra-msg ra-ai'), agent.getGreeting());
        return;
      }
      turns.forEach(function (turn) {
        showTurn(append('', 'ra-msg ' + (turn.role === 'assistant' ? 'ra-ai' : 'ra-user')), turn);
        if (turn.tools && turn.tools.length) append(esc('用过的工具：' + turn.tools.join('、')), 'ra-thought');
      });
      log.scrollTop = log.scrollHeight;
    }

    function threadControls() {
      var select = $('#ra-thread-select');
      if (!select) return;
      var id = threads.currentId();
      select.innerHTML = threads.list().map(function (row) {
        return option(esc(row.id), esc(row.owner.label + ' · ' + (row.title || '新对话')), id);
      }).join('');
      var locked = running || agent.isBusy() || loadingThreads;
      select.disabled = locked;
      $('[data-act="thread-new"]').disabled = locked;
      $('[data-act="thread-delete"]').disabled = locked || !id;
      var note = $('#ra-thread-status');
      note.textContent = loadingThreads ? '正在打开对话…' : !threads.canRun() ? '正在查看历史。回到所属卡和聊天后可以继续，无卡对话可在酒馆首页继续。' : !threads.persistent() ? '本地数据库不可用，本次对话仅保存在此页面。' : '';
      note.hidden = !note.textContent;
      $('#ra-send').disabled = !running && (locked || !threads.canRun());
      $('#ra-text').disabled = locked || !threads.canRun();
      $('[data-act="clear"]').disabled = locked || !threads.canRun();
      overlay.querySelectorAll('[data-quick]').forEach(function (button) { button.disabled = locked || !threads.canRun(); });
    }

    async function refreshThreads(reload) {
      var seq = ++threadRefresh;
      loadingThreads = true;
      threadControls();
      try {
        if (reload) await threads.refresh();
        else await threads.ready();
        if (threadRefresh !== seq || !overlay) return;
        contextUsage = null;
        if (!running) renderHistory();
      } catch (error) { notice('thread', message(error)); }
      finally {
        if (threadRefresh === seq && overlay) { loadingThreads = false; threadControls(); refreshFoot(); }
      }
    }

    async function threadAction(action, target) {
      if (loadingThreads || running || agent.isBusy()) return;
      if (action === 'remove' && !host.confirm('删除这条助手对话及其中的图片和视频？')) return;
      loadingThreads = true;
      threadControls();
      try {
        await threads[action](target);
        var input = $('#ra-text');
        if (input) { input.value = ''; fitInput(); }
      } catch (error) { notice('thread', message(error)); }
      finally { loadingThreads = false; threadControls(); }
    }

    function fitInput() {
      var input = $('#ra-text');
      if (!input) return;
      input.style.height = 'auto';
      /* scrollHeight 不含边框；页签没显示时它是 0，交给样式里的 min-height。 */
      if (input.scrollHeight) input.style.height = Math.min(input.scrollHeight + 2, INPUT_MAX_HEIGHT) + 'px';
    }

    function setRunning(value) {
      running = value;
      var send = $('#ra-send');
      if (send) { send.textContent = value ? '停止' : '发送'; send.classList.toggle('is-main', !value); send.classList.toggle('is-bad', value); }
      var input = $('#ra-text');
      if (input) input.disabled = value;
      threadControls();
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
          + (danger || request.confirmEach ? '' : '<button type="button" class="ra-btn" data-answer="always">' + esc(request.alwaysLabel || '本次对话都允许这个工具') + '</button>')
          + '<button type="button" class="ra-btn is-bad" data-answer="deny">拒绝</button></div>', 'ra-confirm' + (danger ? ' is-danger' : ''));
        var done = false;
        var finish = function (answer) {
          if (done) return;
          done = true;
          pendingConfirms = pendingConfirms.filter(function (item) { return item !== finish; });
          if (node) node.classList.add('is-done');
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

    function stepHtml(label, detail) {
      return '<details><summary><span class="st">' + icon('spin') + '</span><span>' + esc(label) + '</span></summary><pre>' + esc(detail) + '</pre></details>';
    }

    function reviewPermission(request) {
      if (!running || !overlay || !overlay.open) return false;
      clearIndicator();
      var labels = modules.AGENT_MODES;
      var node = append('<h4>这一步需要「' + esc(labels[request.requiredMode]) + '」</h4>'
        + '<div>' + esc(request.description || request.name) + '</div>'
        + (request.path ? '<pre>' + esc(request.path) + '</pre>' : '')
        + '<p>当前档位是「' + esc(labels[request.currentMode]) + '」。保存的新档位也会用于后续任务。</p>'
        + '<div class="ra-row"><button type="button" class="ra-btn is-main" data-review="settings">打开权限设置</button>'
        + '<button type="button" class="ra-btn" data-review="retry">重新检查并继续</button>'
        + '<button type="button" class="ra-btn" data-review="skip">本任务保持当前档位</button></div>', 'ra-confirm');
      if (!node) return false;
      logNode().scrollTop = logNode().scrollHeight;
      return new Promise(function (resolve) {
        var signal = request.signal;
        var abort = function () { finish(false); };
        function finish(choice) {
          if (permissionReview !== finish) return;
          permissionReview = null;
          pendingConfirms = pendingConfirms.filter(function (item) { return item !== finish; });
          if (signal) signal.removeEventListener('abort', abort);
          node.classList.add('is-done');
          node.textContent = choice === true ? '已请求重新检查本次调用的权限' : '已结束权限调整';
          resolve(choice === true);
        }
        permissionReview = finish;
        pendingConfirms.push(finish);
        if (signal && signal.aborted) { abort(); return; }
        if (signal) signal.addEventListener('abort', abort, { once: true });
        node.addEventListener('click', function (event) {
          var button = event.target.closest('[data-review]');
          if (!button || permissionReview !== finish) return;
          var action = button.getAttribute('data-review');
          if (action === 'settings') {
            showTab('settings');
            gotoSection('ra-agent-card', false);
            var select = $('[data-s="a.mode"]');
            if (select) select.focus();
          } else if (action === 'skip') finish(false);
          else if (action === 'retry' && event.isTrusted) finish(true);
        });
      });
    }

    function requestMoreRounds(request) {
      if (!running || !overlay || !overlay.isConnected) return 0;
      clearIndicator();
      var next = request.tools.slice(0, 6).join('、') || '重新提交上次未写完的调用';
      var node = append('<h4>已用完 ' + request.rounds + ' 轮，是否继续这项任务？</h4>'
        + '<div>接下来要做：' + esc(next) + '</div>'
        + '<div class="ra-row"><label class="ra-num"><span>追加工具轮数</span><input data-extra-rounds type="number" min="1" max="' + modules.AGENT_MAX_STEP_BUDGET + '" step="1" required value="' + request.suggested + '"></label>'
        + '<button type="button" class="ra-btn is-main" data-budget="continue">继续本任务</button>'
        + '<button type="button" class="ra-btn" data-budget="finish">汇总并结束</button></div>', 'ra-confirm');
      if (!node) return 0;
      var log = logNode();
      if (log) log.scrollTop = log.scrollHeight;
      return new Promise(function (resolve) {
        var signal = request.signal;
        var abort = function () { finish(0); };
        function finish(choice) {
          pendingConfirms = pendingConfirms.filter(function (item) { return item !== finish; });
          if (signal) signal.removeEventListener('abort', abort);
          node.classList.add('is-done');
          node.textContent = choice > 0 ? '已追加 ' + choice + ' 轮' : signal && signal.aborted ? '已停止' : '已结束工具调用';
          resolve(choice > 0 ? choice : 0);
        }
        pendingConfirms.push(finish);
        if (signal && signal.aborted) { abort(); return; }
        if (signal) signal.addEventListener('abort', abort, { once: true });
        node.addEventListener('click', function (event) {
          var button = event.target.closest('[data-budget]');
          if (!button) return;
          if (button.getAttribute('data-budget') === 'finish') { finish(0); return; }
          if (!event.isTrusted) return;
          var field = node.querySelector('[data-extra-rounds]');
          if (field.reportValidity()) finish(field.valueAsNumber);
        });
      });
    }

    function onAgentEvent(event) {
      if (!overlay || (running && runningChat !== kit.chatKey())) return;
      if (event.type === 'context') { contextUsage = event; refreshFoot(); return; }
      if (event.type === 'summarizing') { showIndicator(event.strategy === 'handoff' ? '正在整理交接摘要' : '正在压缩上下文'); return; }
      if (event.type === 'compact') { notice('compact', '已压缩上下文，正在继续当前任务。'); return; }
      if (event.type === 'handoff') {
        renderHistory();
        pendingUserNode = append(rich(pendingInput), 'ra-msg ra-user');
        threadControls();
        notice('handoff', '已在新对话中接续任务。');
        return;
      }
      if (event.type === 'thinking') { showIndicator(event.step ? '继续思考 · 已用 ' + event.step + '/' + event.limit + ' 轮' : '思考中'); return; }
      if (event.type === 'thought') { clearIndicator(); append(esc(event.text), 'ra-thought'); return; }
      if (event.type === 'protocol') {
        notice('protocol', '原生函数调用这条路没走通' + (event.reason ? '（' + event.reason + '）' : '') + '，已改用文本协议接着做。');
        refreshFoot();
        return;
      }
      if (event.type === 'nudge') {
        notice('nudge', event.reason === 'capabilities' ? '已提醒助手核对本次可用的工具。'
          : event.reason === 'plan' ? '计划里还有待办，已提醒助手继续。' : '她只是应了一声、还没动手，已经提醒她一次。');
        return;
      }
      if (event.type === 'tool_start') {
        clearIndicator();
        var node = append(stepHtml(event.description && event.description !== event.name ? event.description : event.name, event.name + ' ' + JSON.stringify(event.args)), 'ra-step');
        if (node) { node.setAttribute('data-step', event.id); node.setAttribute('data-state', 'run'); }
        return;
      }
      if (event.type === 'tool_end') {
        var step = overlay.querySelector('.ra-step[data-step="' + event.id + '"]');
        if (!step) {
          step = append(stepHtml(event.name, ''), 'ra-step');
          if (!step) return;
        }
        step.setAttribute('data-state', event.ok ? 'ok' : 'bad');
        var mark = step.querySelector('.st');
        if (mark) mark.innerHTML = icon(event.ok ? 'check' : event.denied ? 'ban' : 'cross');
        var pre = step.querySelector('pre');
        if (pre) pre.textContent = (pre.textContent ? pre.textContent + '\n' : '') + '→ ' + (event.summary || '');
        return;
      }
      if (event.type === 'final') {
        clearIndicator();
        var replyNode = append(rich(event.text) + (event.turns ? '' : mediaHtml(event)), 'ra-msg ra-ai');
        if (event.turns) {
          var greeting = $('#ra-log [data-turn-id="greeting"]:not(.is-editing)');
          if (greeting) greeting.remove();
          showTurn(pendingUserNode, event.turns[0]);
          showTurn(replyNode, event.turns[1]);
        }
        return;
      }
      if (event.type === 'error') { clearIndicator(); append(esc('没能完成：' + event.message), 'ra-thought'); return; }
      if (event.type === 'aborted') { clearIndicator(); append('已停止。', 'ra-thought'); }
    }

    async function send(textOverride) {
      if (running) {
        pendingConfirms.slice().forEach(function (finish) { finish('deny'); });
        agent.stop();
        return;
      }
      if (loadingThreads || !threads.canRun()) return;
      var input = $('#ra-text');
      var text = String(textOverride !== undefined ? textOverride : input && input.value || '').trim();
      if (!text) return;
      if (input && textOverride === undefined) { input.value = ''; fitInput(); }
      pendingUserNode = append(rich(text), 'ra-msg ra-user');
      pendingInput = text;
      var log = logNode();
      if (log) log.scrollTop = log.scrollHeight;
      runningChat = kit.chatKey();
      setRunning(true);
      try {
        var outcome = await agent.run(text, { onEvent: onAgentEvent, confirm: confirmCard, reviewPermission: reviewPermission, interactiveBudget: true });
        if (outcome.busy) append(esc(outcome.answer), 'ra-thought');
      } catch (error) {
        append(esc('出错：' + message(error)), 'ra-thought');
      } finally {
        clearIndicator();
        setRunning(false);
        if (runningChat !== kit.chatKey()) renderHistory();
        runningChat = null;
        pendingUserNode = null;
        pendingInput = '';
        refreshFoot();
        /* 触屏上不抢焦点：不然每答完一轮软键盘都弹出来。 */
        if (input && !touchInput()) { try { input.focus(); } catch (error) { /* 面板可能已关闭 */ } }
      }
    }

    function footPermission() {
      var current = agent.getSettings();
      var mode = { readonly: '只读', card: '单卡', tavern: '酒馆全权', device: '设备全权' }[current.mode] || '单卡';
      if (current.mode === 'readonly') return mode;
      return mode + ' · ' + ({ ask: '先询问', auto: '档位内直接执行', yolo: '全部直接执行' }[current.approval] || '先询问') + (current.lite ? ' · 轻聊' : '');
    }

    function toolStatus() {
      try { return typeof agent.toolStatus === 'function' ? agent.toolStatus() : { mode: 'none', via: '', reason: '', setting: 'auto' }; }
      catch (error) { return { mode: 'none', via: '', reason: message(error), setting: 'auto' }; }
    }

    /* 底栏：模型 / 记忆 / 权限 / 工具调用方式，各是一枚小标签。 */
    function refreshFoot() {
      var node = $('#ra-foot-text');
      if (!node) return;
      var backend = llm.getBackendSummary('agent');
      var memorySettings = memory.getSettings();
      var tag = function (text) { return '<span class="ra-tag">' + esc(text) + '</span>'; };
      node.innerHTML = tag('模型：' + (backend.mode === 'custom' ? backend.model : '酒馆当前连接'))
        + tag('记忆：' + (!memorySettings.enabled ? '关闭' : threads.isUnbound() ? '无卡 · 手动整理' : memory.targetStore() === 'ocean' ? '《' + memorySettings.oceanBook + '》' : '当前聊天'))
        + tag('权限：' + footPermission());
      if (contextUsage) {
        node.innerHTML += tag('上下文约 ' + Number(contextUsage.used).toLocaleString() + ' / ' + Number(contextUsage.contextWindow).toLocaleString() + ' tokens');
      }
      var status = toolStatus();
      var mode = TOOL_MODE[status.mode] ? status.mode : 'none';
      var tool = $('#ra-tool-mode');
      if (tool) {
        tool.setAttribute('data-mode', mode);
        tool.textContent = '工具：' + TOOL_MODE[mode] + ' · ' + agent.getSettings().maxSteps + ' 轮';
        tool.title = (status.reason ? status.reason + '。' : '') + '设置工具轮数与调用方式';
      }
      var persona = $('#ra-persona');
      if (persona) persona.textContent = 'READER AGENT · ' + agent.personaContext().name;
    }

    /* ---------- 记忆页 ---------- */
    function memoryEditorHtml(record) {
      var isNew = !record.id;
      var types = TYPE_ORDER.map(function (type) { return '<option value="' + type + '"' + (record.type === type ? ' selected' : '') + '>' + memory.TYPES[type] + '</option>'; }).join('');
      var importance = [1, 2, 3, 4, 5].map(function (value) { return '<option value="' + value + '"' + (Number(record.importance) === value ? ' selected' : '') + '>' + value + '</option>'; }).join('');
      return '<section class="ra-card" id="ra-editor"><h3>' + (isNew ? '新增记忆' : '编辑记忆') + '</h3><div class="ra-form">'
        + '<label>类型</label><select data-f="type">' + types + '</select>'
        + '<label>标题</label><input type="text" data-f="title" maxlength="40" value="' + esc(record.title || '') + '">'
        + '<label>正文</label><textarea data-f="content" maxlength="4000">' + esc(record.content || '') + '</textarea>'
        + '<label>触发词</label><input type="text" data-f="keys" value="' + esc((record.keys || []).join('，')) + '" placeholder="用逗号分隔，检索记忆时会匹配这些词">'
        + '<label>重要度</label><select data-f="importance">' + importance + '</select>'
        + (isNew ? '<label>存放位置</label><select data-f="store"><option value="chat"' + (record.store === 'chat' ? ' selected' : '') + '>当前聊天</option><option value="ocean"' + (record.store === 'ocean' ? ' selected' : '') + '>《' + esc(memory.getSettings().oceanBook) + '》世界书（跨存档）</option></select>' : '')
        + '<label class="ra-check wide"><input type="checkbox" data-f="pinned"' + (record.pinned ? ' checked' : '') + '><span class="ra-switch" aria-hidden="true"></span><span>常驻<span class="ra-hint">开启正文共享后，在预算内优先带入这条记忆</span></span></label>'
        + '<div class="ra-row wide"><button type="button" class="ra-btn is-main" data-act="mem-save">保存</button><button type="button" class="ra-btn" data-act="mem-cancel">取消</button></div>'
        + '</div></section>';
    }

    function starsHtml(count) {
      var dots = '';
      for (var index = 1; index <= 5; index += 1) dots += '<i' + (index <= count ? ' class="on"' : '') + '></i>';
      return '<span class="ra-stars" role="img" aria-label="重要度 ' + Number(count) + '" title="重要度 ' + Number(count) + '">' + dots + '</span>';
    }

    function memoryItemHtml(record) {
      return '<div class="ra-mem" data-id="' + esc(record.id) + '"><div class="ra-mem-head"><span class="ra-badge t-' + record.type + '">' + esc(memory.TYPE_SHORT[record.type]) + '</span>'
        + '<span class="ra-mem-title">' + esc(record.title) + '</span>' + starsHtml(record.importance)
        + '<span class="ra-badge">' + (record.store === 'ocean' ? '夜之洋' : '聊天') + '</span>' + (record.pinned ? '<span class="ra-badge">常驻</span>' : '') + (record.enabled ? '' : '<span class="ra-badge">已停用</span>') + '</div>'
        + '<div class="ra-mem-body">' + esc(record.content) + '</div>'
        + (record.keys.length ? '<div class="ra-mem-keys">触发词：' + esc(record.keys.join('、')) + '</div>' : '')
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="mem-edit">编辑</button>'
        + '<button type="button" class="ra-btn is-small" data-act="mem-pin">' + (record.pinned ? '取消常驻' : '设为常驻') + '</button>'
        + '<button type="button" class="ra-btn is-small" data-act="mem-move">' + (record.store === 'ocean' ? '移到当前聊天' : '移到夜之洋') + '</button>'
        + '<button type="button" class="ra-btn is-small is-bad" data-act="mem-del">删除</button></div></div>';
    }

    async function renderMemory() {
      var pane = $('[data-pane="memory"] .ra-scroll');
      if (!pane) return;
      var status, list, threadId;
      try {
        await threads.ready();
        threadId = threads.currentId();
        if (!threads.canRun()) { pane.innerHTML = '<p class="ra-note">回到此助手对话所属的卡和聊天后，可以查看和整理记忆。</p>'; return; }
        status = await memory.status();
        list = await memory.list({ type: memoryFilter.type || undefined, store: memoryFilter.store || undefined, query: memoryFilter.query || undefined, fresh: true });
      } catch (error) {
        pane.innerHTML = '<div class="ra-card">读取记忆失败：' + esc(message(error)) + '</div>';
        return;
      }
      if (!overlay || tab !== 'memory' || threadId !== threads.currentId()) return;
      var chip = function (group, value, label) {
        return '<button type="button" class="ra-chip" data-act="mem-filter" data-group="' + group + '" data-value="' + value + '" aria-pressed="' + (memoryFilter[group] === value) + '">' + label + '</button>';
      };
      var fact = function (text) { return '<span class="ra-tag">' + esc(text) + '</span>'; };
      var last = status.last ? ((status.last.ok ? '上次整理：新增 ' + status.last.added + '、更新 ' + status.last.updated : '上次整理失败：' + (status.last.error || '')) + (status.last.note ? '（' + status.last.note + '）' : '')) : '还没有整理过';
      var ocean = '《' + status.oceanBook + '》' + (status.oceanExists ? status.oceanCount + ' 条' : '尚未创建');
      var html = '<section class="ra-card"><div class="ra-membar"><label class="ra-inline"><span>本聊天的新记忆写到</span><select id="ra-store">'
        + '<option value=""' + (status.chatOverride === '' ? ' selected' : '') + '>跟随全局设置（' + (memory.getSettings().store === 'ocean' ? '夜之洋' : '当前聊天') + '）</option>'
        + '<option value="chat"' + (status.chatOverride === 'chat' ? ' selected' : '') + '>当前聊天</option>'
        + '<option value="ocean"' + (status.chatOverride === 'ocean' ? ' selected' : '') + '>《' + esc(status.oceanBook) + '》世界书（跨存档）</option></select></label>'
        + '<span class="ra-row"><button type="button" class="ra-btn is-main" data-act="mem-run"' + (status.running ? ' disabled' : '') + '>整理助手对话</button>'
        + '<button type="button" class="ra-btn" data-act="mem-new">新增记忆</button>'
        + '<button type="button" class="ra-btn is-ghost" data-act="mem-export">导出</button><button type="button" class="ra-btn is-ghost" data-act="mem-import">导入</button></span></div>'
        + '<div class="ra-facts">' + fact('当前聊天 ' + status.chatCount + ' 条') + fact(ocean) + fact('待整理 ' + status.pending.turns + ' 条助手回复') + '</div>'
        + '<p class="ra-note">' + esc(last) + '</p><div class="ra-status" data-ra-status="memory"></div></section>';
      if (editing) html += memoryEditorHtml(editing);
      html += '<div class="ra-filter">' + chip('type', '', '全部') + TYPE_ORDER.map(function (type) { return chip('type', type, memory.TYPE_SHORT[type]); }).join('')
        + '<span class="ra-sep" aria-hidden="true"></span>' + chip('store', '', '两处') + chip('store', 'chat', '聊天') + chip('store', 'ocean', '夜之洋')
        + '<label class="ra-search">' + icon('search') + '<input type="search" id="ra-mem-q" placeholder="搜索" aria-label="搜索记忆" value="' + esc(memoryFilter.query) + '"></label></div>';
      html += list.length ? list.map(memoryItemHtml).join('') : '<p class="ra-empty">这里还没有助手记忆。和夜梦助手聊过后，可以点“整理助手对话”。</p>';
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
      if (!threads.canRun()) { renderMemory(); return; }
      var item = element.closest('[data-id]');
      var id = item ? item.getAttribute('data-id') : '';
      try {
        if (action === 'mem-filter') {
          memoryFilter[element.getAttribute('data-group')] = element.getAttribute('data-value');
        } else if (action === 'mem-new') {
          editing = { type: 'fact', title: '', content: '', keys: [], importance: 3, pinned: false, store: memory.targetStore() };
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
          toast('正在整理助手对话…');
          element.disabled = true;
          var report = await memory.consolidate();
          await renderMemory();
          toast(report.ok ? (report.note || '整理完成：新增 ' + report.added.length + ' 条，更新 ' + report.updated.length + ' 条' + (report.errors.length ? '，' + report.errors.length + ' 条写入失败' : '')) : '整理失败：' + report.error, !report.ok);
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
        /* 点「新增」「编辑」后把编辑框带到眼前：它排在存放位置下面，不滚的话看不出点了有反应。 */
        if (action === 'mem-new' || action === 'mem-edit') {
          var box = $('#ra-editor');
          if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
        }
      } catch (error) {
        toast(message(error), true);
      }
    }

    /* ---------- 设置页 ---------- */
    function option(value, label, current) {
      return '<option value="' + value + '"' + (String(current) === String(value) ? ' selected' : '') + '>' + label + '</option>';
    }
    /* 数字输入排成紧凑的小格：标签在上，输入框在下。 */
    function numberField(name, label, value, minimum, maximum, step) {
      return '<label class="ra-num"><span>' + label + '</span><input type="number" inputmode="decimal" data-s="' + name + '" value="' + esc(value) + '" min="' + minimum + '" max="' + maximum + '"' + (step ? ' step="' + step + '"' : '') + '></label>';
    }
    function switchField(name, value, label, hint) {
      return '<label class="ra-check"><input type="checkbox" data-s="' + name + '"' + (value ? ' checked' : '') + '><span class="ra-switch" aria-hidden="true"></span><span>' + label
        + (hint ? '<span class="ra-hint">' + hint + '</span>' : '') + '</span></label>';
    }
    function group(title) { return '<div class="ra-group">' + title + '</div>'; }
    /* live：这一块不跟着底部的「保存设置」走，标题右边标一句它怎么生效（立即生效 / 单独保存）。 */
    function card(id, title, body, live) {
      return '<section class="ra-card" id="' + id + '"><h3>' + title + (live ? '<span class="ra-live">' + live + '</span>' : '') + '</h3>' + body + '</section>';
    }
    function replaceCard(id, html) {
      var node = $('#' + id);
      if (node && html) node.outerHTML = html;
    }

    /* 这张卡上的 Reader-II：按角色卡启用。助手自己在任何聊天里都能用，这个开关管的是来信、大厅、记账与提示词注入。 */
    function readerCardHtml() {
      var lobby = lobbyApi();
      var core = coreApi();
      if (!lobby) return '';
      var hasChat = false, enabled = false;
      try { hasChat = !!(core && core.hasChat()); enabled = hasChat && !!lobby.isEnabled(); } catch (error) { hasChat = false; }
      var name = '';
      try { name = kit.names().char || ''; } catch (error) { name = ''; }
      var body = !core ? '<p class="ra-note">读者界面尚未就绪。</p>'
        : !hasChat ? '<p class="ra-note">打开一个聊天后可切换当前角色卡的启停状态。</p>'
        : '<div class="ra-switch-row"><div><b>在「' + esc(name || '这张卡') + '」上启用 Reader-II</b>'
          + ' <span class="ra-badge">' + (enabled ? '已启用' : '已停用') + '</span></div>'
          + '<button type="button" class="ra-switch-btn" role="switch" aria-checked="' + (enabled ? 'true' : 'false') + '" aria-label="在这张卡上启用 Reader-II" data-act="card-toggle"><span class="ra-switch" aria-hidden="true"></span></button></div>';
      return card('ra-reader-card', '这张卡', body, '立即生效');
    }

    function refreshBack() {
      var back = $('[data-act="back-lobby"]');
      if (!back) return;
      var on = false;
      try { var lobby = lobbyApi(); on = !!(lobby && lobby.isEnabled()); } catch (error) { on = false; }
      back.hidden = !on;
    }

    async function cardToggle(actor) {
      var lobby = lobbyApi();
      if (!lobby) return;
      actor.disabled = true;
      try {
        if (lobby.isEnabled()) await lobby.disable(); else await lobby.enable();
        toast(lobby.isEnabled() ? '已在这张卡上启用 Reader-II' : '已在这张卡上停用 Reader-II');
      } catch (error) {
        toast(message(error), true);
      }
      replaceCard('ra-reader-card', readerCardHtml());
      refreshBack();
    }

    function placementCardHtml() {
      var placement = modules.readerPromptPlacement;
      if (!placement) return '';
      var config = placement.placements(kit.context());
      var body = placement.sections.map(function (section) {
        var v = config[section.key];
        var prefix = 'p.' + section.key + '.';
        var positionOptions = placement.positions.map(function (entry) { return option(entry[0], entry[1], v.position); }).join('');
        var chatOnly = ' data-placement-position="4"' + (v.position === 4 ? '' : ' hidden');
        return '<section class="ra-subcard" data-placement-section="' + section.key + '" aria-label="' + section.label + '">'
          + switchField(prefix + 'enabled', v.enabled, section.label)
          + '<div data-placement-fields' + (v.enabled ? '' : ' hidden') + '><div class="ra-nums">'
          + '<label class="ra-num">注入位置<select data-s="' + prefix + 'position">' + positionOptions + '</select></label>'
          + numberField(prefix + 'order', '插入顺序', v.order, 0, 9999)
          + '<label class="ra-num"' + chatOnly + '>聊天深度<input type="number" min="0" max="9999" required data-s="' + prefix + 'depth" value="' + v.depth + '"></label>'
          + '<label class="ra-num"' + chatOnly + '>消息角色<select data-s="' + prefix + 'role">'
          + option(0, '系统', v.role) + option(1, '用户', v.role) + option(2, '助手', v.role) + '</select></label>'
          + '<label class="ra-num" data-placement-position="7"' + (v.position === 7 ? '' : ' hidden') + '>出口名称（{{outlet::名称}}）<input data-s="' + prefix + 'outletName" placeholder="出口名称" value="' + esc(v.outletName) + '"></label>'
          + '</div></div></section>';
      }).join('');
      return card('ra-placement-card', '正文提示词位置', body);
    }

    function updatePlacementFields(section) {
      var prefix = 'p.' + section.dataset.placementSection + '.';
      section.querySelector('[data-placement-fields]').hidden = !section.querySelector('[data-s="' + prefix + 'enabled"]').checked;
      var position = section.querySelector('[data-s="' + prefix + 'position"]').value;
      section.querySelectorAll('[data-placement-position]').forEach(function (node) { node.hidden = node.dataset.placementPosition !== position; });
    }

    function agentCardHtml(a) {
      var persona = agent.personaContext();
      return card('ra-agent-card', '助手', group('权限')
        + '<div class="ra-form">'
        + '<label>权限档位</label><select data-s="a.mode">' + option('readonly', '只读：查看酒馆与写入工作区', a.mode) + option('card', '单卡：当前聊天与角色卡（推荐）', a.mode) + option('tavern', '酒馆全权：酒馆内全部资源', a.mode) + option('device', '设备全权：含本机文件与命令（需伴侣）', a.mode) + '</select>'
        + '<label>确认方式</label><select data-s="a.approval">' + option('ask', '每次写入前询问（推荐）', a.approval) + option('auto', '档位内自动执行，危险操作仍询问', a.approval) + option('yolo', '全部自动执行', a.approval) + '</select>'
        + '</div>'
        + group('对话')
        + '<div class="ra-stack">'
        + '<div class="ra-field-stack"><label for="ra-persona-prompt">夜梦人格提示词 · ' + esc(persona.name) + '</label>'
        + '<textarea id="ra-persona-prompt" data-s="personaPrompt" data-persona-key="' + esc(persona.key) + '" rows="6" placeholder="清空保存可恢复默认人格原文">' + esc(persona.override || persona.defaultPrompt) + '</textarea></div>'
        + '<div class="ra-field-stack"><label for="ra-appearance-prompt">夜梦当前外貌提示词</label>'
        + '<textarea id="ra-appearance-prompt" data-s="appearancePrompt" data-prompt-key="' + esc(persona.appearance.key) + '" rows="3" placeholder="清空保存可恢复当前装扮默认外貌">' + esc(persona.appearance.prompt) + '</textarea></div>'
        + '<div class="ra-field-stack"><label for="ra-assistant-system-prompt">助手专用系统提示词</label>'
        + '<textarea id="ra-assistant-system-prompt" data-s="a.assistantSystemPrompt" rows="3" placeholder="所有人格共用，仅随助手对话发送">' + esc(a.assistantSystemPrompt) + '</textarea></div>'
        + '</div>'
        + switchField('a.plotContext', a.plotContext, '让助手了解当前剧情')
        + connectorUi.plotHtml(a.plotSources)
        + switchField('a.lite', a.lite, '轻聊模式（无工具）')
        + switchField('a.recall', a.recall, '回答前自动带入相关记忆')
        + group('生成参数')
        + '<div class="ra-form"><label for="ra-context-strategy">上下文接近上限</label><select id="ra-context-strategy" data-s="a.contextStrategy">'
        + option('compact', '在当前对话中压缩', a.contextStrategy) + option('handoff', '生成摘要并交接到新对话', a.contextStrategy) + '</select></div>'
        + '<div class="ra-nums">' + numberField('a.historyTurns', '历史轮数（−1 自动，0 关闭）', a.historyTurns, -1, 1000)
        + numberField('a.temperature', '温度（独立 API）', a.temperature, 0, 2, 0.05) + numberField('a.maxTokens', '输出上限（独立 API）', a.maxTokens, 256, 64000) + numberField('a.timeoutSec', '单次超时（秒）', a.timeoutSec, 20, 900) + '</div>');
    }

    function toolLineHtml() {
      var status = toolStatus();
      var mode = TOOL_MODE[status.mode] ? status.mode : 'none';
      var text = mode === 'native' ? '原生函数调用' : mode === 'text' ? '文本协议' : '现在用不了';
      return '<p class="ra-note" id="ra-tool-line">现在用的是：<b>' + text + '</b>' + (status.reason ? '（' + esc(status.reason) + '）' : '') + '</p>';
    }

    function probeHtml(report) {
      var row = function (key, label, item) {
        return '<div class="ra-probe" data-probe="' + key + '" data-ok="' + (item.ok ? '1' : '0') + '">' + icon(item.ok ? 'check' : 'cross') + '<b>' + label + '</b><span>' + esc(item.detail || (item.ok ? '可用' : '不可用')) + '</span></div>';
      };
      var advice = report.recommend === 'native' ? '建议用原生函数调用。结论已经生效：选「自动」时会直接用它。'
        : report.recommend === 'text' ? '建议用文本协议。结论已经生效：选「自动」时会直接用它。'
        : '两种方式都没走通：这个模型或中转站多半不支持工具调用。可以换一个模型，或者打开「轻聊」只聊天。';
      return row('native', '原生函数调用', report.native) + row('text', '文本协议', report.text)
        + '<p class="ra-tip' + (report.recommend === 'none' ? ' is-bad' : '') + '" data-probe="recommend" data-recommend="' + esc(report.recommend) + '">' + advice + '</p>';
    }

    function toolsCardHtml(a) {
      return card('ra-tools-card', '工具调用',
        '<div class="ra-form">'
        + '<label for="ra-max-steps">每项任务的工具轮数</label><input id="ra-max-steps" type="number" inputmode="decimal" data-s="a.maxSteps" value="' + esc(a.maxSteps) + '" min="1" max="' + modules.AGENT_MAX_STEP_BUDGET + '">'
        + '<label>调用方式</label><select data-s="a.toolProtocol">' + option('auto', '自动（优先原生，回退文本）', a.toolProtocol) + option('native', '仅原生函数调用', a.toolProtocol) + option('text', '仅文本协议', a.toolProtocol) + '</select></div>'
        + toolLineHtml()
        + '<div class="ra-row ra-mt"><button type="button" class="ra-btn" data-act="probe-tools">测试工具调用</button></div>'
        + '<div id="ra-probe-out" aria-live="polite">' + probeView + '</div>');
    }

    async function probeTools(actor) {
      var out = $('#ra-probe-out');
      actor.disabled = true;
      if (out) out.innerHTML = '<p class="ra-note"><span class="ra-dots">正在测试<i></i><i></i><i></i></span></p>';
      try {
        probeView = probeHtml(await agent.probeTools());
      } catch (error) {
        probeView = '<p class="ra-tip is-bad">' + esc(message(error)) + '</p>';
      }
      out = $('#ra-probe-out');
      if (out) out.innerHTML = probeView;
      var line = $('#ra-tool-line');
      if (line) line.outerHTML = toolLineHtml();
      if (actor.isConnected) actor.disabled = false;
      refreshFoot();
    }

    /* 权限规则 */
    var RULE_EFFECT = { deny: '禁止', ask: '总是先问', allow: '免问' };
    var RULE_ACTION = { '*': '读写', read: '只管读', write: '只管写' };

    function ruleRowHtml(rule) {
      var opts = function (map, current) { return Object.keys(map).map(function (key) { return '<option value="' + key + '"' + (key === current ? ' selected' : '') + '>' + map[key] + '</option>'; }).join(''); };
      return '<div class="ra-rule" data-rule><select data-r="effect" aria-label="怎么处理">' + opts(RULE_EFFECT, rule.effect || 'deny') + '</select><select data-r="action" aria-label="管读还是写">' + opts(RULE_ACTION, rule.action || '*') + '</select>'
        + '<input type="text" data-r="pattern" value="' + esc(rule.pattern || '') + '" placeholder="路径或工具名，如 wb:/日记/**" aria-label="路径或工具名" spellcheck="false">'
        + '<button type="button" class="ra-btn is-small is-bad" data-act="rule-del">删除</button></div>';
    }

    function rulesCardHtml(rules) {
      return card('ra-rules-card', '权限规则',
        '<div id="ra-rules">' + (rules || []).map(ruleRowHtml).join('') + '</div>'
        + '<div class="ra-row ra-mt"><button type="button" class="ra-btn is-small" data-act="rule-add">添加规则</button></div>');
    }

    function readRules() {
      return Array.prototype.map.call(overlay.querySelectorAll('[data-rule]'), function (row) {
        var get = function (name) { return row.querySelector('[data-r="' + name + '"]').value; };
        return { effect: get('effect'), action: get('action'), pattern: get('pattern').trim() };
      }).filter(function (rule) { return rule.pattern; });
    }

    function memoryCardHtml(m) {
      return card('ra-memory-card', '助手记忆', switchField('m.enabled', m.enabled, '启用助手记忆')
        + switchField('m.agentExtract', m.agentExtract, '自动整理助手对话')
        + '<div class="ra-nums">' + numberField('m.agentEveryTurns', '每多少条助手回复整理一次', m.agentEveryTurns, 1, 40) + '</div>'
        + '<div class="ra-form ra-mt"><label>新记忆写到</label><select data-s="m.store">' + option('chat', '当前聊天（随存档）', m.store) + option('ocean', '《夜之洋》世界书（跨存档）', m.store) + '</select>'
        + '<label>跨存档世界书名</label><input type="text" data-s="m.oceanBook" value="' + esc(m.oceanBook) + '" maxlength="60"></div>'
        + group('正文共享')
        + switchField('m.unify', m.unify, '助手夜梦 = 正文夜梦')
        + '<div class="ra-nums">' + numberField('m.injectDepth', '注入深度', m.injectDepth, 0, 40) + numberField('m.injectMax', '最多带几条', m.injectMax, 1, 30) + numberField('m.injectBudget', '字数预算', m.injectBudget, 200, 20000) + '</div>');
    }

    var modelUi = modules.createModelUi(llm, agent, {
      $: $, esc: esc, icon: icon, card: card, dirty: setDirty, toast: toast,
      profileChanged: function () {
        var fields = $('#ra-model-fields');
        if (!fields || fields.dataset.profileKey !== agent.getModelSettings().key || fields.dataset.edited !== '1') {
          replaceCard('ra-model-card', modelCardHtml()); resolveDisplayedModel();
        }
        refreshFoot();
      },
      canChangeProfile: function () {
        var fields = $('#ra-model-fields');
        return !fields || fields.dataset.edited !== '1' || host.confirm('切换连接会重新载入主模型参数。放弃这些尚未保存的参数？');
      }
    });

    function modelCardHtml() {
      var route = function (key, label) {
        var backend = llm.getBackendSummary(key);
        return '<dt>' + label + '</dt><dd>' + esc(backend.mode === 'custom' ? backend.model + ' · ' + backend.apiurl : '酒馆当前连接') + '</dd>';
      };
      var profile = agent.getModelSettings();
      var caps = llm.getModelCapabilities('agent', profile);
      var origin = { override: '手动指定', metadata: '模型接口', catalog: '已知模型规格', host: '酒馆设置', fallback: '估算值' };
      var lobby = lobbyApi();
      var lobbyEnabled = false;
      try { lobbyEnabled = !!(lobby && lobby.isEnabled()); } catch (error) { lobbyEnabled = false; }
      var lobbyButtons = lobbyEnabled ? '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="open-api">打开大厅独立 API 设置</button><button type="button" class="ra-btn is-small" data-act="open-panel">打开语义适配</button></div>' : '';
      return card('ra-model-card', '主模型', '<dl class="ra-kv">' + route('agent', '助手对话') + route('memory', '记忆整理') + route('adapt', '语义适配') + '</dl>'
        + lobbyButtons
        + group('助手模型参数 · ' + esc(profile.model || caps.model || '当前连接'))
        + '<div class="ra-form" id="ra-model-fields" data-profile-key="' + esc(profile.key) + '">'
        + '<p class="ra-note wide">当前窗口 · <b>' + esc(Number(caps.contextWindow).toLocaleString()) + '</b> tokens（' + esc(origin[caps.origin] || caps.origin) + '）</p>'
        + '<label for="ra-window">上下文窗口（0 自动）</label><input type="number" id="ra-window" data-s="model.contextWindow" min="0" max="100000000" step="1" value="' + esc(profile.contextWindow || 0) + '">'
        + '<label for="ra-effort">思考档位</label><select id="ra-effort" data-s="model.reasoningEffort">' + modelUi.effortOptions(profile.reasoningEffort) + '</select>'
        + '<label for="ra-image-mode">图片接口</label><select id="ra-image-mode" data-s="model.imageMode">' + option('auto', '自动识别', profile.imageMode) + option('chat', '多模态对话', profile.imageMode) + option('generation', '独立 API 图像生成接口', profile.imageMode) + '</select>'
        + '<details class="wide ra-fold"><summary>' + icon('chevron') + '反代专用参数</summary><div class="ra-fold-body">'
        + '<div class="ra-field-stack"><label for="ra-model-json">额外请求参数（JSON 对象）</label>'
        + '<textarea id="ra-model-json" class="is-code" data-s="model.modelParameters" rows="3" spellcheck="false" placeholder="{}">' + esc(JSON.stringify(profile.modelParameters || {}, null, 2)) + '</textarea></div>'
        + '</div></details></div>');
    }

    var connectorUi = modules.createConnectorUi(agent, { $: $, esc: esc, icon: icon, card: card, gotoSection: gotoSection, setDirty: setDirty });

    /* 联网、MCP、后端伴侣三块设置在 ui-net.js；这里只留插槽与分发。 */
    var netUi = deps && typeof deps.netUi === 'function' ? deps.netUi({
      $: $, esc: esc, toast: toast, icon: icon,
      ask: function (text) { showTab('chat'); if (!running) send(text); }
    }) : null;

    function settingsAction(action, actor) {
      try {
        if (action === 'rule-add') { $('#ra-rules').insertAdjacentHTML('beforeend', ruleRowHtml({})); setDirty(true); return; }
        if (action === 'rule-del') { actor.closest('[data-rule]').remove(); setDirty(true); return; }
      } catch (error) {
        toast(message(error), true);
      }
    }

    /* ---------- 版本更新（逻辑在 updates.js：只比对更新源上的版本号，更新本身走酒馆的扩展更新） ---------- */
    var updates = deps && deps.updates || null;
    var updatesView = '';
    var GUIDE = '<ol class="ra-list"><li>酒馆顶栏「扩展」（三个方块的图标）→「管理扩展」→ 找到「Reader-II · 夜梦」，点它的更新按钮（就是 git pull）。TauriTavern 在扩展管理里同样操作。当初是手动拷贝安装的，重新下载后覆盖 <code>manifest.json</code>、<code>index.js</code>、<code>dist/</code>、<code>knowledge/</code>。</li>'
      + '<li>刷新酒馆页面。</li></ol>'
      + '<p class="ra-note">Reader-II 只有扩展这一个组件，更新完它就全部更新完了。设置、记忆、工作区、对话记录都不在扩展目录里，更新不会动它们。不要直接改扩展目录里的文件（git pull 会因此失败，或把改动冲掉）：自定义的东西放工作区 <code>ws:/</code>，或者另写一个扩展。</p>';

    function runningVersion() {
      if (!updates) return '';
      return String(typeof updates.version === 'function' ? updates.version() : updates.version || '');
    }

    function updatesCardHtml() {
      if (!updates) return '';
      var s = updates.getSettings();
      var checked = s.lastCheck && s.lastCheck.at
        ? '上次检查 ' + new Date(s.lastCheck.at).toLocaleString() + '：' + ({ newer: '有新版本 v' + s.lastCheck.latest, same: '与更新源一致', older: '本机比更新源新' }[s.lastCheck.status] || '没有结果')
        : '还没有检查过';
      return card('ra-upd-card', '版本更新', '<p>当前版本 <b>v' + esc(runningVersion()) + '</b></p><p class="ra-note">' + esc(checked) + '</p>'
        + '<div class="ra-row"><button type="button" class="ra-btn" data-act="upd-check">检查更新</button></div>'
        + '<div id="ra-upd-out" aria-live="polite">' + updatesView + '</div>'
        + '<details class="ra-fold"><summary>' + icon('chevron') + '更新源设置</summary><div class="ra-fold-body">'
        + '<div class="ra-field-stack"><label for="ra-upd-remotes">更新源地址（每行一个，按顺序尝试）</label>'
        + '<textarea id="ra-upd-remotes" class="is-code" spellcheck="false">' + esc(s.remotes.join('\n')) + '</textarea></div>'
        + '<div class="ra-row ra-mt"><button type="button" class="ra-btn is-small" data-act="upd-remotes">保存更新源</button><button type="button" class="ra-btn is-small" data-act="upd-reset">恢复默认</button></div></div></details>');
    }

    function checkHtml(result) {
      var errors = result.errors && result.errors.length ? '<p class="ra-note">没连上的更新源：' + result.errors.map(esc).join('；') + '</p>' : '';
      if (!result.ok) return '<p class="ra-tip is-bad">检查失败，不能据此判断已是最新。</p>' + errors;
      if (result.status === 'newer') return '<p class="ra-tip">有新版本 <b>v' + esc(result.latest) + '</b>（当前 v' + esc(result.current) + '）。</p>' + GUIDE + errors;
      if (result.status === 'older') return '<p class="ra-tip">当前 v' + esc(result.current) + ' 比更新源上的 v' + esc(result.latest) + ' 还新（开发中的版本）。</p>' + errors;
      return '<p class="ra-tip">已是最新：v' + esc(result.current) + '（更新源 ' + esc(result.source) + '）。</p>' + errors;
    }

    function setUpdatesView(html) {
      updatesView = html;
      var out = $('#ra-upd-out');
      if (out) out.innerHTML = html;
    }

    async function updatesAction(action) {
      if (!updates) return;
      try {
        if (action === 'upd-remotes') { updates.saveSettings({ remotes: ($('#ra-upd-remotes') || {}).value || '' }); toast('更新源已保存'); return; }
        if (action === 'upd-reset') {
          updates.saveSettings({ remotes: [] });
          replaceCard('ra-upd-card', updatesCardHtml());
          var fold = $('#ra-upd-card details');
          if (fold) fold.open = true;
          toast('已恢复默认更新源');
          return;
        }
        if (action === 'upd-check') {
          setUpdatesView('<p class="ra-note"><span class="ra-dots">正在检查<i></i><i></i><i></i></span></p>');
          setUpdatesView(checkHtml(await updates.checkRemote()));
        }
      } catch (error) {
        var text = message(error);
        setUpdatesView('<p class="ra-tip is-bad">' + esc(text).replace(/\n/g, '<br>') + '</p>');
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
          var notes = (run.notes || []).length ? '<span class="ra-hint">无法自动撤销：' + esc(run.notes.join('；')) + '</span>' : '';
          var button = run.changes && !run.undone
            ? '<button type="button" class="ra-btn is-small' + (forceUndo[run.id] ? ' is-bad' : '') + '" data-act="undo-run" data-run="' + esc(run.id) + '">' + (forceUndo[run.id] ? '强制撤销' : '撤销') + '</button>' : '';
          return '<div class="ra-run"><span>' + esc(new Date(run.startedAt).toLocaleString()) + ' · ' + esc(run.title || '')
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
      }).catch(function (error) { toast(message(error), true); renderRuns(); });
    }

    /* ---------- 功能说明子页面 ---------- */
    var guideUi = typeof modules.createGuideUi === 'function' ? modules.createGuideUi({ card: card }) : null;
    var guideSpyHold = 0;
    function guideScroll() { return $('[data-pane="guide"] .ra-scroll'); }
    function markGuideToc(id) {
      var toc = $('[data-pane="guide"] .ra-toc');
      if (!toc) return;
      Array.prototype.forEach.call(toc.querySelectorAll('button'), function (button) {
        var on = button.getAttribute('data-target') === id;
        if (on) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
        if (on && toc.scrollWidth > toc.clientWidth) {
          var left = button.offsetLeft - toc.offsetLeft;
          if (left < toc.scrollLeft || left + button.offsetWidth > toc.scrollLeft + toc.clientWidth) toc.scrollLeft = Math.max(0, left - 24);
        }
      });
    }
    function spyGuide(force) {
      if (!guideUi) return;
      var scroll = guideScroll();
      if (!scroll || (!force && Date.now() < guideSpyHold)) return;
      var line = scroll.scrollTop + 48, current = '', last = '';
      guideUi.sections.forEach(function (item) {
        var node = $('#' + item[0]);
        if (!node) return;
        last = item[0];
        if (!current || node.offsetTop <= line) current = item[0];
      });
      if (scroll.scrollTop > 0 && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) current = last;
      if (current) markGuideToc(current);
    }
    function gotoGuideSection(id, smooth) {
      var scroll = guideScroll(), node = $('#' + id);
      if (!scroll || !node) return;
      var top = Math.max(0, node.offsetTop - 14);
      guideSpyHold = Date.now() + 800;
      markGuideToc(id);
      if (smooth && !calmMotion() && typeof scroll.scrollTo === 'function') scroll.scrollTo({ top: top, behavior: 'smooth' });
      else scroll.scrollTop = top;
    }
    function renderGuide() {
      var toc = $('[data-pane="guide"] .ra-toc'), pane = guideScroll();
      if (!guideUi || !toc || !pane) return;
      if (!pane.children.length) {
        toc.innerHTML = guideUi.tocHtml();
        pane.innerHTML = guideUi.contentHtml();
      }
      spyGuide(true);
    }

    /* ---------- 设置页：整页、目录、保存 ---------- */
    function settingsScroll() { return $('[data-pane="settings"] .ra-scroll'); }

    function setDirty(value) {
      dirty = !!value;
      var hint = $('.ra-dirty');
      if (hint) hint.hidden = !dirty;
    }

    function markToc(id) {
      var toc = $('[data-pane="settings"] .ra-toc');
      if (!toc) return;
      Array.prototype.forEach.call(toc.querySelectorAll('button'), function (button) {
        var on = button.getAttribute('data-target') === id;
        if (on) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
        /* 手机上目录是横着的一排：让当前这一项留在看得见的地方。 */
        if (on && toc.scrollWidth > toc.clientWidth) {
          var left = button.offsetLeft - toc.offsetLeft;
          if (left < toc.scrollLeft || left + button.offsetWidth > toc.scrollLeft + toc.clientWidth) toc.scrollLeft = Math.max(0, left - 24);
        }
      });
    }

    function renderToc() {
      var toc = $('[data-pane="settings"] .ra-toc');
      if (!toc) return;
      toc.innerHTML = SECTIONS.filter(function (item) { return $('#' + item[0]); }).map(function (item) {
        return '<button type="button" data-act="toc" data-target="' + item[0] + '">' + item[1] + '</button>';
      }).join('');
      spy(true);
    }

    /* 滚动时目录跟着走：取顶线之上最后一块；滚到底时最后几块够不到顶线，直接算最后一块。 */
    function spy(force) {
      var scroll = settingsScroll();
      if (!scroll || (!force && Date.now() < spyHold)) return;
      var line = scroll.scrollTop + 48, current = '', last = '';
      SECTIONS.forEach(function (item) {
        var node = $('#' + item[0]);
        if (!node) return;
        last = item[0];
        if (!current || node.offsetTop <= line) current = item[0];
      });
      if (scroll.scrollTop > 0 && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) current = last;
      markToc(current);
    }

    function gotoSection(id, smooth) {
      var scroll = settingsScroll();
      var node = $('#' + id);
      if (!scroll || !node) return;
      var top = Math.max(0, node.offsetTop - 14);
      spyHold = Date.now() + 800;
      markToc(id);
      if (smooth && !calmMotion() && typeof scroll.scrollTo === 'function') scroll.scrollTo({ top: top, behavior: 'smooth' });
      else scroll.scrollTop = top;
    }

    function safeSettingsSection(id, title, render) {
      try {
        return render();
      } catch (error) {
        if (env.console && typeof env.console.error === 'function') env.console.error('[ReaderII] 设置页区块渲染失败：' + title, error);
        return card(id, title, '<p class="ra-tip is-bad">该区块渲染失败：' + esc(message(error)) + '</p>');
      }
    }

    function renderSettings() {
      var pane = settingsScroll();
      if (!pane) return;
      var a = agent.getSettings();
      var m = memory.getSettings();
      var scroll = pane.scrollTop;
      try { connectorUi.scan(); } catch (error) {
        if (env.console && typeof env.console.error === 'function') env.console.error('[ReaderII] 插件对接扫描失败', error);
      }
      pane.innerHTML = safeSettingsSection('ra-reader-card', '这张卡', readerCardHtml)
        + safeSettingsSection('ra-placement-card', '正文提示词位置', placementCardHtml)
        + safeSettingsSection('ra-agent-card', '助手', function () { return agentCardHtml(a); })
        + safeSettingsSection('ra-tools-card', '工具调用', function () { return toolsCardHtml(a); })
        + safeSettingsSection('ra-rules-card', '权限规则', function () { return rulesCardHtml(a.rules); })
        + safeSettingsSection('ra-memory-card', '助手记忆', function () { return memoryCardHtml(m); })
        + safeSettingsSection('ra-connections-card', '模型连接', modelUi.connectionsHtml)
        + safeSettingsSection('ra-model-card', '主模型', modelCardHtml)
        + safeSettingsSection('ra-delegation-card', '子代理', modelUi.delegationHtml)
        + safeSettingsSection('ra-media-card', '媒体工具', modelUi.mediaHtml)
        + safeSettingsSection('ra-conn-card', '插件对接', connectorUi.cardHtml)
        + (netUi ? safeSettingsSection('ra-mcp-card', 'MCP 工具服务', function () { return card('ra-mcp-card', 'MCP 工具服务', '<div id="ra-mcp">' + netUi.mcpHtml() + '</div>', '立即生效'); }) : '')
        + (netUi ? (typeof netUi.netCardHtml === 'function' && typeof netUi.companionCardHtml === 'function'
          ? safeSettingsSection('ra-net-card', '联网', netUi.netCardHtml) + safeSettingsSection('ra-comp-card', '后端伴侣', netUi.companionCardHtml)
          : safeSettingsSection('ra-comp-card', '联网与后端伴侣', netUi.cardsHtml)) : '')
        + safeSettingsSection('ra-upd-card', '版本更新', updatesCardHtml)
        + card('ra-runs-card', '改动记录', '<div id="ra-runs"></div>');
      pane.scrollTop = scroll;
      setDirty(false);
      try { modelUi.syncMode(); } catch (error) { /* 子代理区块失败时不阻塞目录 */ }
      renderToc();
      renderRuns();
      connectorUi.discover(false);
      resolveDisplayedModel();
      if (netUi) { try { netUi.scanMcp(); } catch (error) { /* ignore */ } }
    }

    function resolveDisplayedModel() {
      var fields = $('#ra-model-fields');
      llm.resolveModelCapabilities('agent').then(function () {
        if (fields === $('#ra-model-fields') && fields.dataset.edited !== '1') replaceCard('ra-model-card', modelCardHtml());
        modelUi.refreshStatus();
      }).catch(function () { /* 未提供元数据的代理仍可手填窗口。 */ });
    }

    function saveSettingsFromForm() {
      var budget = $('[data-s="a.maxSteps"]');
      if (budget && (!budget.value || !budget.reportValidity())) {
        toast('工具轮数应为 1 至 ' + modules.AGENT_MAX_STEP_BUDGET + ' 的整数', true);
        budget.focus();
        return;
      }
      var agentPatch = {}, modelPatch = {}, memoryPatch = {}, placements = {};
      var invalid = null;
      overlay.querySelectorAll('[data-s]').forEach(function (input) {
        var key = input.getAttribute('data-s');
        var value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
        if (key.indexOf('model.') === 0) {
          var field = key.slice(6);
          if (field === 'modelParameters') {
            try {
              value = JSON.parse(value.trim() || '{}');
              if (!modules.isObject(value)) throw new Error();
            } catch (error) { invalid = [input, '额外请求参数必须是有效的 JSON 对象']; }
          }
          if (field === 'contextWindow' && !input.validity.valid) invalid = [input, '上下文窗口应为 0 至 100000000 的整数'];
          modelPatch[field] = value;
        }
        else if (key.indexOf('a.') === 0) agentPatch[key.slice(2)] = value;
        else if (key === 'personaPrompt' && value !== input.defaultValue) {
          var persona = agent.personaContext();
          var promptKey = input.getAttribute('data-persona-key');
          var prompts = agent.getSettings().personaPrompts;
          if (!value.trim() || (promptKey === persona.key && value.trim() === persona.defaultPrompt)) delete prompts[promptKey];
          else prompts[promptKey] = value.trim();
          agentPatch.personaPrompts = prompts;
        }
        else if (key === 'appearancePrompt' && value !== input.defaultValue) {
          var appearance = agent.personaContext().appearance;
          var appearanceKey = input.getAttribute('data-prompt-key');
          var appearances = agent.getSettings().appearancePrompts;
          if (!value.trim() || (appearanceKey === appearance.key && value.trim() === appearance.defaultPrompt)) delete appearances[appearanceKey];
          else appearances[appearanceKey] = value.trim();
          agentPatch.appearancePrompts = appearances;
        }
        else if (key.indexOf('m.') === 0) memoryPatch[key.slice(2)] = value;
        else if (key.indexOf('p.') === 0) {
          var parts = key.split('.');
          var section = placements[parts[1]] || (placements[parts[1]] = {});
          section[parts[2]] = value;
          if (!invalid && !input.closest('[hidden]')) {
            if (input.type === 'number' && (input.value === '' || !input.validity.valid)) invalid = [input, '请填写 0 至 9999 的整数'];
            if (parts[2] === 'outletName' && !modules.readerPromptPlacement.validOutlet(value.trim())) invalid = [input, '请填写有效的出口名称'];
          }
        }
      });
      if (invalid) { toast(invalid[1], true); invalid[0].focus(); return; }
      agentPatch.plotSources = connectorUi.selection();
      try { agentPatch.subagents = modelUi.readDelegation(); }
      catch (error) { toast(message(error), true); return; }
      try { agent.saveModelSettings(modelPatch, $('#ra-model-fields').dataset.profileKey); }
      catch (error) { toast(message(error), true); return; }
      if ($('#ra-rules')) agentPatch.rules = readRules();
      if ($('#ra-placement-card')) {
        try { modules.readerPromptPlacement.save(kit.context(), placements); }
        catch (error) { toast('正文提示词位置保存失败：' + message(error), true); return; }
      }
      agent.saveSettings(agentPatch);
      memory.saveSettings(memoryPatch);
      renderSettings();
      refreshFoot();
      toast('设置已保存');
      if (permissionReview) showTab('chat');
    }

    /* ---------- 面板 ---------- */
    function showTab(next) {
      tab = next === 'memory' || next === 'settings' || next === 'guide' ? next : 'chat';
      if (!overlay) return;
      overlay.querySelectorAll('.ra-tab').forEach(function (button) { button.setAttribute('aria-selected', String(button.getAttribute('data-tab') === tab)); });
      overlay.querySelectorAll('.ra-pane').forEach(function (pane) { pane.classList.toggle('is-on', pane.getAttribute('data-pane') === tab); });
      if (tab === 'memory') renderMemory();
      else if (tab === 'guide') renderGuide();
      else if (tab === 'settings') {
        /* 有没保存的改动时不重画：切去别的页再回来，填到一半的东西还在。只把会自己变的改动记录刷新一下。 */
        var scroller = settingsScroll();
        if (dirty && scroller && scroller.children.length) { replaceCard('ra-reader-card', readerCardHtml()); renderRuns(); }
        else { toast(''); renderSettings(); }
      }
      else {
        refreshFoot();
        fitInput();
        /* 页签没显示时滚不动（高度是 0）：切回来再落到最新一条上。 */
        var log = logNode();
        if (log) log.scrollTop = log.scrollHeight;
        var input = $('#ra-text');
        if (input && !touchInput()) { try { input.focus(); } catch (error) { /* ignore */ } }
      }
    }

    /* 语义适配面板要读这张卡的变量：没启用 Reader-II 或没有聊天时打不开，把原因说出来，而不是关了窗口就没下文。 */
    function openSemanticPanel() {
      var core = coreApi();
      if (!core || typeof core.openPanel !== 'function') { toast('读者界面还没有就绪', true); return; }
      close();
      Promise.resolve().then(function () { return core.openPanel(); }).catch(function (error) {
        var toastr = env.toastr || host.toastr;
        if (toastr && typeof toastr.warning === 'function') toastr.warning('语义适配没能打开：' + message(error), 'Reader-II');
        else env.console.warn('[ReaderII] 语义适配没能打开', error);
      });
    }

    function backToLobby() {
      close();
      var lobby = lobbyApi();
      if (!lobby || typeof lobby.open !== 'function') return;
      Promise.resolve().then(function () { return lobby.open('eggs'); }).catch(function (error) { env.console.warn('[ReaderII] 回不到服务台', error); });
    }

    function build() {
      if (theme) theme.ensure(doc);
      var touch = touchInput();
      overlay = doc.createElement('dialog');
      overlay.id = OVERLAY_ID;
      overlay.setAttribute('aria-label', '夜梦助手');
      overlay.innerHTML = '<div class="ra-shell" tabindex="-1" autofocus><header class="ra-head">'
        + '<button type="button" class="ra-back" data-act="back-lobby" title="回到彩蛋服务台" hidden>' + icon('back') + '<span>服务台</span></button>'
        + '<div class="ra-id"><span class="ra-seal" aria-hidden="true"><i>夜</i><i>梦</i></span><div class="ra-name"><b>九十九夜梦</b><i id="ra-persona">READER AGENT</i></div></div>'
        + '<nav class="ra-tabs" role="tablist"><button type="button" class="ra-tab" role="tab" data-tab="chat">对话</button><button type="button" class="ra-tab" role="tab" data-tab="memory">记忆</button><button type="button" class="ra-tab" role="tab" data-tab="settings">设置</button><button type="button" class="ra-tab" role="tab" data-tab="guide">说明</button></nav>'
        + '<button type="button" class="ra-close" data-act="close" aria-label="关闭，回到聊天" title="关闭，回到聊天">' + icon('close') + '</button></header>'
        + '<section class="ra-pane" data-pane="chat"><div class="ra-threads"><label for="ra-thread-select">对话</label><select id="ra-thread-select" aria-label="按所属卡切换对话"></select>'
        + '<button type="button" class="ra-btn is-small" data-act="thread-new">新建</button><button type="button" class="ra-btn is-small" data-act="thread-delete">删除</button></div>'
        + '<p id="ra-thread-status" role="status" hidden></p><div class="ra-log" id="ra-log" aria-live="polite"></div>'
        + '<div class="ra-quick"><button type="button" class="ra-chip" data-quick="看看现在 Reader 的状态。">看看状态</button><button type="button" class="ra-chip" data-quick="帮我把这张卡的变量适配到 Reader-II，逐项告诉我结果。">适配这张卡</button><button type="button" class="ra-chip" data-quick="把我们最近的助手对话整理成记忆，告诉我记下了什么。">整理记忆</button><button type="button" class="ra-chip" data-quick="你还记得我们聊过哪些事？">你还记得什么</button></div>'
        + '<div class="ra-input"><textarea id="ra-text" rows="1" aria-label="对夜梦说的话" placeholder="' + (touch ? '想问什么、想让我做什么，直接说。' : '想问什么、想让我做什么，直接说。Enter 发送，Shift+Enter 换行') + '"></textarea><button type="button" class="ra-btn is-main" id="ra-send">发送</button></div>'
        + '<div class="ra-foot"><div class="ra-tags"><span id="ra-foot-text"></span><button type="button" class="ra-tag" id="ra-tool-mode" data-act="goto-tools" data-mode="none">工具：不可用</button></div>'
        + '<button type="button" class="ra-btn is-small is-ghost" data-act="clear">清空对话</button></div></section>'
        + '<section class="ra-pane" data-pane="memory"><div class="ra-scroll"></div></section>'
        + '<section class="ra-pane" data-pane="settings"><div class="ra-set"><nav class="ra-toc" aria-label="设置目录"></nav><div class="ra-scroll"></div></div>'
        + '<div class="ra-savebar"><span class="ra-status" data-ra-status="settings" role="status"></span><span class="ra-dirty" hidden>有改动还没保存</span>'
        + '<button type="button" class="ra-btn is-main" data-act="save-settings" title="保存设置">保存设置</button></div></section>'
        + '<section class="ra-pane" data-pane="guide"><div class="ra-set"><nav class="ra-toc" aria-label="功能说明目录"></nav><div class="ra-scroll"></div></div></section></div>';
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
        if (action.indexOf('turn-') === 0) editTurn(action, actor);
        else if (action === 'thread-new') threadAction('create');
        else if (action === 'thread-delete') threadAction('remove', threads.currentId());
        else if (action === 'thread-next') threadAction('select', actor.dataset.threadTarget);
        else if (action === 'close') close();
        else if (action === 'back-lobby') backToLobby();
        else if (action === 'clear') {
          if (running) return;
          if (actor.getAttribute('data-armed') !== '1') { actor.setAttribute('data-armed', '1'); actor.textContent = '再点一次清空'; setTimeout(function () { actor.removeAttribute('data-armed'); actor.textContent = '清空对话'; }, 3000); return; }
          actor.removeAttribute('data-armed'); actor.textContent = '清空对话';
          Promise.resolve(agent.clearHistory()).then(function () { renderHistory(); threadControls(); }).catch(function (error) { notice('thread', message(error)); });
        }
        else if (action === 'toc') gotoSection(actor.getAttribute('data-target'), true);
        else if (action === 'guide-toc') gotoGuideSection(actor.getAttribute('data-target'), true);
        else if (action === 'guide-jump') {
          var jumpTab = actor.getAttribute('data-tab-target') || 'settings';
          var jumpSection = actor.getAttribute('data-section');
          showTab(jumpTab);
          if (jumpTab === 'settings' && jumpSection) gotoSection(jumpSection, false);
        }
        else if (action === 'goto-tools') { showTab('settings'); gotoSection('ra-tools-card', false); }
        else if (action === 'save-settings') saveSettingsFromForm();
        else if (action === 'card-toggle') cardToggle(actor);
        else if (action === 'probe-tools') probeTools(actor);
        else if (action.indexOf('models-') === 0) modelUi.action(action, actor);
        else if (action === 'open-api') { close(); var shell = deps.shell && deps.shell(); if (shell) shell.command('openIndependentApiSettings'); }
        else if (action === 'open-panel') openSemanticPanel();
        else if (action === 'undo-run') undoRun(actor);
        else if (action.indexOf('mem-') === 0) memoryAction(action, actor);
        else if (action.indexOf('rule-') === 0) settingsAction(action, actor);
        else if (action.indexOf('conn-') === 0) connectorUi.action(action, actor);
        else if (action.indexOf('upd-') === 0) updatesAction(action);
        else if (netUi && /^(?:net|mcp|comp)-/.test(action)) netUi.action(action, actor, event);
      });
      overlay.addEventListener('change', function (event) {
        if (event.target.id === 'ra-thread-select') { threadAction('select', event.target.value); return; }
        modelUi.change(event.target);
        if (event.target.closest('#ra-model-fields')) $('#ra-model-fields').dataset.edited = '1';
        if (event.target.closest && event.target.closest('[data-s],[data-r]')) setDirty(true);
        connectorUi.change(event.target);
        var placementSection = event.target.closest && event.target.closest('[data-placement-section]');
        if (placementSection) updatePlacementFields(placementSection);
        if (netUi && netUi.change(event)) return;
        if (event.target.id === 'ra-store') {
          try { memory.setChatStoreOverride(event.target.value); renderMemory(); refreshFoot(); } catch (error) { toast(message(error), true); }
        }
      });
      overlay.addEventListener('input', function (event) {
        if (netUi && event.target.id === 'ra-net-token') { netUi.tokenInput(event); return; }
        if (event.target.id === 'ra-text') { fitInput(); return; }
        modelUi.input(event.target);
        if (event.target.closest('#ra-model-fields')) $('#ra-model-fields').dataset.edited = '1';
        if (event.target.closest && event.target.closest('[data-s],[data-r],[data-editor="role"]')) { setDirty(true); return; }
        if (event.target.id === 'ra-mem-q') {
          memoryFilter.query = event.target.value;
          clearTimeout(overlay.__raSearch);
          overlay.__raSearch = setTimeout(function () {
            renderMemory().then(function () { var input = $('#ra-mem-q'); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
          }, 300);
        }
      });
      overlay.addEventListener('keydown', function (event) {
        if (event.target.matches('[data-turn-text]') && !event.isComposing) {
          var editAction = event.key === 'Escape' ? 'turn-cancel' : event.key === 'Enter' && (event.ctrlKey || event.metaKey) ? 'turn-save' : '';
          if (editAction) { event.preventDefault(); event.target.closest('.ra-msg').querySelector('[data-act="' + editAction + '"]').click(); }
        }
        if (event.target.id === 'ra-text' && event.key === 'Enter' && !event.shiftKey && !event.isComposing && !touchInput()) { event.preventDefault(); send(); }
        /* 输入事件不冒泡到酒馆：聊天页的快捷键不该在面板里触发。 */
        event.stopPropagation();
      });
      overlay.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
      /* scroll 事件不冒泡，直接挂在设置页与说明页的滚动容器上。 */
      var scroller = settingsScroll();
      if (scroller) scroller.addEventListener('scroll', function () { spy(false); }, { passive: true });
      var gScroller = guideScroll();
      if (gScroller) gScroller.addEventListener('scroll', function () { spyGuide(false); }, { passive: true });
      doc.body.appendChild(overlay);
    }

    function open(target) {
      if (!doc || !doc.createElement) throw new Error('当前环境无法打开夜梦助手');
      var stale = doc.getElementById(OVERLAY_ID);
      if (stale && stale !== overlay) stale.remove();
      if (!overlay || !overlay.isConnected) build();
      else if (theme) theme.ensure(doc);
      overlay.setAttribute('data-theme', themeName());
      refreshBack();
      if (!overlay.open) {
        try { overlay.showModal(); } catch (error) { overlay.setAttribute('open', ''); }
      }
      if (!running) refreshThreads(true);
      showTab(target || tab);
      /* <dialog> 打开时会把焦点给第一枚按钮（「服务台」），上面就多出一圈焦点框。对话页的焦点已经在输入框里；
         别的页（以及触屏，不该弹键盘）把焦点放在外框上，按 Tab 再进到第一个控件。 */
      if (tab !== 'chat' || touchInput()) {
        var shellNode = $('.ra-shell');
        if (shellNode) { try { shellNode.focus({ preventScroll: true }); } catch (error) { /* ignore */ } }
      }
      if (!unsubscribe.length) {
        /* 设置被别处改了（斜杠命令、插件、助手自己）时，底栏跟着更新。 */
        unsubscribe.push(agent.onChange(function (reason) {
          if (!overlay || !overlay.open) return;
          if (reason === 'settings' || reason === 'probe') refreshFoot();
          if (reason === 'run' && !running) refreshThreads();
        }));
        unsubscribe.push(memory.onChange(function (reason) {
          /* 换了聊天：设置页里「这张卡」说的已经是另一张卡了，没保存的改动不再留着，下次进设置页重画。 */
          if (reason === 'chat') {
            dirty = false;
            editing = null;
            if (running && runningChat !== kit.chatKey()) {
              agent.stop();
              pendingConfirms.slice().forEach(function (finish) { finish('deny'); });
            }
          }
          if (!overlay || !overlay.open) return;
          if (reason === 'chat') { refreshThreads(); refreshBack(); if (tab === 'settings') renderSettings(); }
          if (tab === 'memory' && reason !== 'settings' && !editing) renderMemory();
        }));
      }
      return true;
    }

    function close() {
      if (!overlay) return;
      if (permissionReview) permissionReview(false);
      try { if (overlay.open && typeof overlay.close === 'function') overlay.close(); else overlay.removeAttribute('open'); } catch (error) { overlay.removeAttribute('open'); }
    }

    function dispose() {
      pendingConfirms.slice().forEach(function (finish) { finish('deny'); });
      unsubscribe.forEach(function (stop) { try { stop(); } catch (error) { /* ignore */ } });
      unsubscribe = [];
      close();
      if (overlay) overlay.remove();
      overlay = null;
      if (theme) theme.remove(doc);
    }

    return { open: open, close: close, dispose: dispose, requestMoreRounds: requestMoreRounds, refreshThreads: refreshThreads, isOpen: function () { return !!(overlay && overlay.open); } };
  }

  modules.createAgentUi = createAgentUi;
})(typeof globalThis !== 'undefined' ? globalThis : window);
