(function (root) {
  'use strict';

  /*
   * 后台任务的状态浮窗：不在助手对话里跑的活（导演的编纲、巡检、重构、归档、建档）进行时，在界面上露一张小牌子。
   * 它只读任务看板（jobs.js），不认识具体是谁在干活。
   *
   * 两个停靠位（样式在 ui-theme.js 的「后台任务的状态浮窗」一节）：
   *   page    助手窗口关着：挂在酒馆页面的 <body> 上，桌面在右上角、顶栏下面，手机在顶部居中。
   *   dialog  助手窗口开着：搬进窗口里、标题栏下面，成一条状态带。助手窗口是模态 <dialog>，开着的时候它外面的
   *           东西全都点不到（inert），留在页面上的浮窗就成了摆设，所以必须搬进去。
   * 助手窗口正停在「导演」页时不显示：那一页本身就有完整的进度与日志，再摆一条是重复。
   *
   * 每个任务一行：转圈 / 对勾 / 叉，标题，当前阶段，步数；点开能看最近几行过程，有「查看」（跳到导演页）、
   * 「停止」，结束之后有「关闭」。失败的自动展开，不让报错藏在折叠里。
   *
   * deps: { isDialogOpen(), dialogShell(), isSuppressed(), getTheme(), getMode() }
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var FLOAT_ID = 'reader-agent-float';
  var MAX_ROWS = 3;
  var STATE_ICON = { running: 'spin', done: 'check', failed: 'cross', cancelled: 'ban' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function createJobFloat(env, jobs, deps) {
    var doc = env.document;
    var theme = modules.readerTheme || null;
    var options = deps || {};
    var node = null, usable = true, disposed = false, queued = false;
    var open = Object.create(null);         /* 哪些任务是展开的 */
    var touched = Object.create(null);      /* 用户自己点过展开 / 收起的任务：之后不再替他决定 */
    var signature = '';

    function call(name, fallback) {
      try { return typeof options[name] === 'function' ? options[name]() : fallback; } catch (error) { return fallback; }
    }
    function icon(name) { return theme ? theme.icon(name) : ''; }

    function visibleJobs() {
      var major = call('getMode', 'all') === 'major';
      return jobs.list().filter(function (job) { return !major || job.level === 'major' || job.state === 'failed'; });
    }

    function ensureNode() {
      if (node || !usable) return node;
      try {
        if (!doc || typeof doc.createElement !== 'function') throw new Error('no document');
        var stale = typeof doc.getElementById === 'function' ? doc.getElementById(FLOAT_ID) : null;
        if (stale && typeof stale.remove === 'function') stale.remove();
        var created = doc.createElement('div');
        if (!created || typeof created.addEventListener !== 'function' || typeof created.setAttribute !== 'function') throw new Error('no dom');
        created.id = FLOAT_ID;
        created.setAttribute('role', 'status');
        created.setAttribute('aria-live', 'polite');
        created.setAttribute('aria-label', '后台任务');
        created.addEventListener('click', onClick);
        /* 浮窗里的按键不传给酒馆：聊天页的快捷键不该被它触发。 */
        created.addEventListener('keydown', function (event) { event.stopPropagation(); });
        node = created;
      } catch (error) {
        usable = false;   /* 没有可用的 DOM（Node 里的测试）：浮窗不出现，别的照常 */
        node = null;
      }
      return node;
    }

    function rowHtml(job) {
      var running = job.state === 'running';
      var expanded = open[job.id] === true;
      var steps = job.steps > 0 ? Math.min(job.step, job.steps) + '/' + job.steps : '';
      var percent = job.steps > 0 ? Math.round(Math.min(job.step, job.steps) / job.steps * 100) : 0;
      var line = running ? (job.stage || job.detail || '进行中') : (job.result || (job.state === 'done' ? '完成' : job.state === 'failed' ? '失败' : '已停止'));
      var lines = job.lines.slice(-6);
      if (!running && job.result) lines.push(job.result);
      var more = '';
      if (expanded) {
        more = '<div class="rf-more">' + (lines.length ? '<div class="rf-lines">' + esc(lines.join('\n')) + '</div>' : '')
          + '<div class="rf-acts">'
          + (job.canOpen ? '<button type="button" class="rf-btn" data-rf="open">查看</button>' : '')
          + (job.canCancel ? '<button type="button" class="rf-btn is-bad" data-rf="cancel">停止</button>' : '')
          + (running ? '' : '<button type="button" class="rf-btn" data-rf="dismiss">关闭</button>')
          + '</div></div>';
      }
      return '<div class="rf-job" data-job="' + esc(job.id) + '" data-state="' + esc(job.state) + '" data-open="' + (expanded ? '1' : '0') + '">'
        + '<div class="rf-head"><button type="button" class="rf-main" data-rf="toggle" aria-expanded="' + (expanded ? 'true' : 'false') + '" title="' + (expanded ? '收起' : '展开') + '">'
        + '<span class="rf-state">' + icon(STATE_ICON[job.state] || 'info') + '</span>'
        + '<span class="rf-text"><b class="rf-title">' + esc(job.title) + '</b><span class="rf-stage">' + esc(line) + '</span></span>'
        + (running && steps ? '<span class="rf-step">' + steps + '</span>' : '')
        + '<span class="rf-chev">' + icon('chevron') + '</span></button>'
        + (running ? '' : '<button type="button" class="rf-x" data-rf="dismiss" aria-label="关闭这条" title="关闭">' + icon('close') + '</button>')
        + '</div>'
        + (running ? '<div class="rf-bar' + (job.steps > 0 ? '' : ' is-loop') + '"><i' + (job.steps > 0 ? ' style="width:' + percent + '%"' : '') + '></i></div>' : '')
        + more + '</div>';
    }

    /* 该挂在哪：助手窗口开着就进窗口（标题栏下面），否则挂在页面上。 */
    function dock() {
      var shell = call('isDialogOpen', false) ? call('dialogShell', null) : null;
      var place = shell ? 'dialog' : 'page';
      var parent = shell || doc.body;
      if (!parent || typeof parent.appendChild !== 'function') return false;
      if (node.parentNode !== parent || node.getAttribute('data-dock') !== place) {
        node.setAttribute('data-dock', place);
        var head = shell && typeof shell.querySelector === 'function' ? shell.querySelector('.ra-head') : null;
        if (head && head.nextSibling && typeof parent.insertBefore === 'function') parent.insertBefore(node, head.nextSibling);
        else parent.appendChild(node);
      }
      return true;
    }

    function detach() {
      if (node && node.parentNode && typeof node.remove === 'function') node.remove();
      signature = '';
    }

    function render() {
      queued = false;
      if (disposed || !usable) return;
      var list = visibleJobs();
      if (!list.length || call('isSuppressed', false)) { detach(); return; }
      if (!ensureNode()) return;
      /* 失败的自动展开一次；之后用户收起来就不再弹开。 */
      list.forEach(function (job) {
        if (job.state === 'failed' && !touched[job.id]) open[job.id] = true;
      });
      try {
        if (theme) theme.ensure(doc);
        node.setAttribute('data-theme', call('getTheme', 'cafe'));
        if (!dock()) return;
        var shown = list.slice(0, MAX_ROWS);
        var html = shown.map(rowHtml).join('') + (list.length > shown.length ? '<div class="rf-rest">另有 ' + (list.length - shown.length) + ' 项后台任务</div>' : '');
        if (html !== signature) { node.innerHTML = html; signature = html; }
      } catch (error) {
        if (env.console && typeof env.console.warn === 'function') env.console.warn('[ReaderII] 状态浮窗渲染失败', error);
      }
    }

    function schedule() {
      if (queued || disposed) return;
      queued = true;
      var timer = setTimeout(render, 0);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    function onClick(event) {
      var actor = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-rf]') : null;
      if (!actor) return;
      var row = actor.closest('[data-job]');
      var id = row ? row.getAttribute('data-job') : '';
      var action = actor.getAttribute('data-rf');
      if (!id) return;
      if (action === 'toggle') { open[id] = open[id] !== true; touched[id] = true; signature = ''; render(); }
      else if (action === 'open') jobs.open(id);
      else if (action === 'cancel') jobs.cancel(id);
      else if (action === 'dismiss') { jobs.dismiss(id); delete open[id]; delete touched[id]; }
    }

    var unsubscribe = jobs.onChange(function (job, reason) {
      if (reason === 'remove') { delete open[job.id]; delete touched[job.id]; }
      schedule();
    });

    return {
      /* 助手窗口开、关、换页，主题或浮窗的显示级别变了：重新决定挂在哪、显示什么。 */
      sync: schedule,
      refresh: render,
      node: function () { return node; },
      dispose: function () {
        disposed = true;
        try { unsubscribe(); } catch (error) { /* ignore */ }
        detach();
        node = null;
      }
    };
  }

  modules.createJobFloat = createJobFloat;
})(typeof globalThis !== 'undefined' ? globalThis : window);
