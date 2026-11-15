/* Reader-II 通用钩子（7.C；构建时放在 controller-adapter.js 之后、reader-ui-switch.js 之前）。
 *  · ReaderController.command 补两个命令名：openGacha（命运抽卡）、openIndependentApiSettings（独立 API 设置）。
 *    夜梦助手的 reader_ui 工具与助手面板经 ReaderShell.command 调用这两个名字。
 *  · 新版大厅加不了新图标：点立绘 [data-u4-her] 就是和夜梦说话（dreamOpenAgent('chat')）。
 * 控制器脚本会经过酒馆的宏替换，这个文件里不能出现宏的写法。 */
(function () {
  var app = window.ReaderController;
  if (!app || typeof app.command !== 'function') throw new Error('Reader-II 通用钩子：ReaderController 尚未建立');
  var extra = {
    openGacha: function () { return dreamOpenGacha(); },
    openIndependentApiSettings: function () { return openIndependentApiSettings(null, pToast); }
  };
  var original = app.command;
  app.command = function (name) {
    if (!Object.prototype.hasOwnProperty.call(extra, name)) return original.apply(this, arguments);
    if (!window.__readerControllerAlive) return false;
    var result = extra[name].apply(null, Array.prototype.slice.call(arguments, 1));
    window.__readerHostApi?.refresh();
    return result;
  };

  /* 委托在酒馆主文档上（pD 是适配层包过的文档，监听器随控制器销毁）；捕获阶段，免得被大厅自己的点击处理拦下。 */
  pD.addEventListener('click', function (event) {
    var target = event.target;
    var her = target && typeof target.closest === 'function' ? target.closest('[data-u4-her]') : null;
    if (!her || !window.__readerControllerAlive) return;
    event.preventDefault();
    event.stopPropagation();
    dreamOpenAgent('chat');
  }, true);
  var style = pD.createElement('style');
  style.textContent = '[data-u4-her]{cursor:pointer}';
  (pD.head || pD.documentElement).appendChild(style);
})();
