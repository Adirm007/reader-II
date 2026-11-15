/*
 * 假酒馆助手：脚本 iframe 里的预置全局（card-tavern.js 把它放在主脚本前面加载）。照酒馆助手的做法：
 *   - TavernHelper 与它的每个接口都铺成脚本里的全局函数；Mvu、toastr 也放进来；
 *   - eventOn / eventOnce / eventMakeFirst / eventMakeLast / eventEmit / eventRemoveListener / eventClearAll / tavern_events，
 *     脚本卸载（pagehide）时清掉自己挂的监听；
 *   - getButtonEvent、getScriptId、initializeGlobal / waitGlobalInitialized（共享到酒馆主窗口）；
 *   - SillyTavern：带 getContext 的那一份（最坏情况——交接 0.5 的 7.F「仍未验证」第 1 条：findHost 不能停在脚本 iframe 上）。
 */
(function () {
  'use strict';
  var top = window.parent;
  var mock = top.__mock;
  var impl = top.__helperImpl;
  var ctx = top.SillyTavern.getContext();

  window.TavernHelper = top.TavernHelper;
  Object.keys(impl).forEach(function (name) { if (typeof impl[name] === 'function') window[name] = impl[name]; });
  window.SillyTavern = Object.assign({}, ctx, { getContext: top.SillyTavern.getContext });
  window.Mvu = top.Mvu;
  window.toastr = top.toastr;
  window.tavern_events = Object.assign({}, ctx.eventTypes);
  window.iframe_events = { MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended' };

  var mine = [];
  function track(event, handler) { mine.push([event, handler]); return { stop: function () { window.eventRemoveListener(event, handler); } }; }
  window.eventOn = function (event, handler) { ctx.eventSource.on(event, handler); return track(event, handler); };
  window.eventMakeLast = window.eventOn;
  window.eventMakeFirst = function (event, handler) { ctx.eventSource.makeFirst(event, handler); return track(event, handler); };
  window.eventOnce = function (event, handler) {
    var wrapped = function () { window.eventRemoveListener(event, wrapped); return handler.apply(this, arguments); };
    ctx.eventSource.on(event, wrapped);
    return track(event, wrapped);
  };
  window.eventEmit = function (event) { return ctx.eventSource.emit.apply(ctx.eventSource, arguments); };
  window.eventRemoveListener = function (event, handler) {
    ctx.eventSource.removeListener(event, handler);
    mine = mine.filter(function (pair) { return pair[0] !== event || pair[1] !== handler; });
  };
  window.eventClearAll = function () { mine.slice().forEach(function (pair) { ctx.eventSource.removeListener(pair[0], pair[1]); }); mine = []; };
  window.addEventListener('pagehide', function () { window.eventClearAll(); });

  window.getButtonEvent = function (name) { return mock.buttonEvent(name); };
  window.getScriptId = function () { return mock.scriptJson.id; };
  window.initializeGlobal = function (name, value) { top[name] = value; window[name] = value; mock.globals[name] = true; };
  window.waitGlobalInitialized = function (name) {
    return new Promise(function (resolve) {
      (function check() {
        if (top[name] !== undefined) { window[name] = top[name]; resolve(top[name]); } else setTimeout(check, 50);
      })();
    });
  };
})();
