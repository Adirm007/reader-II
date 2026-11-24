(function (root) {
  'use strict';

  /*
   * 后台任务看板：不在助手对话里跑的活（导演的编纲、巡检、重构、归档……）在这里挂一张牌子，
   * 界面上的状态浮窗（ui-float.js）只读这块看板，不认识具体是谁在干活。
   *
   *   var job = board.start({ owner: 'director', kind: 'patrol', title: '导演 · 后台巡检', stage: '判定偏移', level: 'minor',
   *                           steps: 0, cancel: fn, open: fn });
   *   job.update({ stage, detail, step });   job.log('一行过程');
   *   job.done('L0 顺轨 · 简报已备好');      job.fail(error);      job.cancelled();
   *
   * level：major 是用户发起或时间长的活（编纲、重构、归档），minor 是每轮都有的活（巡检）；浮窗可以只显示 major。
   * 结束的任务再留一小会儿（成功 4 秒、失败 12 秒），让人看得到结果，然后自己撤掉。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var LINGER_OK = 4000, LINGER_BAD = 12000, MAX_LINES = 30;

  function createJobBoard() {
    var jobs = new Map();
    var listeners = [];
    var sequence = 0;

    function view(job) {
      return {
        id: job.id, owner: job.owner, kind: job.kind, level: job.level, title: job.title, stage: job.stage, detail: job.detail,
        step: job.step, steps: job.steps, state: job.state, result: job.result, startedAt: job.startedAt, endedAt: job.endedAt,
        lines: job.lines.slice(), canCancel: job.state === 'running' && typeof job.cancel === 'function', canOpen: typeof job.open === 'function'
      };
    }

    function emit(job, reason) {
      var snapshot = view(job);
      listeners.slice().forEach(function (listener) { try { listener(snapshot, reason); } catch (error) { /* 界面出错不影响任务 */ } });
    }

    function later(task, ms) {
      var timer = setTimeout(task, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    }

    function finish(job, state, result) {
      if (job.state !== 'running') return;
      job.state = state;
      job.result = String(result == null ? '' : result).slice(0, 300);
      job.endedAt = Date.now();
      emit(job, 'end');
      job.timer = later(function () { remove(job.id); }, state === 'done' ? LINGER_OK : LINGER_BAD);
    }

    function remove(id) {
      var job = jobs.get(id);
      if (!job) return false;
      if (job.timer) clearTimeout(job.timer);
      jobs.delete(id);
      emit(job, 'remove');
      return true;
    }

    function start(spec) {
      var source = spec || {};
      var job = {
        id: 'job-' + Date.now().toString(36) + '-' + (++sequence).toString(36), order: sequence,
        owner: String(source.owner || ''), kind: String(source.kind || ''), level: source.level === 'minor' ? 'minor' : 'major',
        title: String(source.title || '后台任务').slice(0, 60), stage: String(source.stage || '').slice(0, 120), detail: String(source.detail || '').slice(0, 300),
        step: Math.max(0, Math.trunc(Number(source.step) || 0)), steps: Math.max(0, Math.trunc(Number(source.steps) || 0)),
        state: 'running', result: '', startedAt: Date.now(), endedAt: 0, lines: [],
        cancel: typeof source.cancel === 'function' ? source.cancel : null, open: typeof source.open === 'function' ? source.open : null, timer: null
      };
      jobs.set(job.id, job);
      emit(job, 'start');
      return {
        id: job.id,
        update: function (patch) {
          if (job.state !== 'running' || !patch) return;
          if (patch.title !== undefined) job.title = String(patch.title).slice(0, 60);
          if (patch.stage !== undefined) job.stage = String(patch.stage).slice(0, 120);
          if (patch.detail !== undefined) job.detail = String(patch.detail).slice(0, 300);
          if (patch.step !== undefined) job.step = Math.max(0, Math.trunc(Number(patch.step) || 0));
          if (patch.steps !== undefined) job.steps = Math.max(0, Math.trunc(Number(patch.steps) || 0));
          emit(job, 'update');
        },
        log: function (line) {
          if (job.state !== 'running') return;
          job.lines.push(String(line).slice(0, 200));
          if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
          emit(job, 'update');
        },
        done: function (result) { finish(job, 'done', result); },
        fail: function (error) { finish(job, 'failed', error && error.message || error); },
        cancelled: function (result) { finish(job, 'cancelled', result || '已停止'); },
        running: function () { return job.state === 'running'; }
      };
    }

    return {
      start: start,
      /* 进行中的排前面，然后是刚结束的；各自从新到旧（同一毫秒里开的按先后序号分，顺序不会跳）。 */
      list: function () {
        return Array.from(jobs.values()).sort(function (left, right) {
          var a = left.state === 'running' ? 0 : 1, b = right.state === 'running' ? 0 : 1;
          return a - b || right.startedAt - left.startedAt || right.order - left.order;
        }).map(view);
      },
      cancel: function (id) {
        var job = jobs.get(id);
        if (!job || job.state !== 'running' || !job.cancel) return false;
        try { job.cancel(); } catch (error) { /* 取消器出错按没取消算 */ return false; }
        return true;
      },
      open: function (id) {
        var job = jobs.get(id);
        if (!job || !job.open) return false;
        try { job.open(); } catch (error) { return false; }
        return true;
      },
      dismiss: function (id) {
        var job = jobs.get(id);
        return !!job && job.state !== 'running' && remove(id);
      },
      busy: function () { return Array.from(jobs.values()).some(function (job) { return job.state === 'running'; }); },
      onChange: function (listener) {
        listeners.push(listener);
        return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
      }
    };
  }

  modules.createJobBoard = createJobBoard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
