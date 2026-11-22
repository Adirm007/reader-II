/* Reader-II 通用钩子（7.C；构建时放在 controller-adapter.js 之后、reader-ui-switch.js 之前）。
 *  · ReaderController.command 补两个命令名：openGacha（命运抽卡）、openIndependentApiSettings（独立 API 设置）。
 *    夜梦助手的 reader_ui 工具与助手面板经 ReaderShell.command 调用这两个名字。
 *    另有 openAgent（助手窗口的某一页）与 openPanel（语义适配），给酒馆扩展菜单之外的调用方用。
 *  · 助手的入口只在大厅的「彩蛋服务台」里（和夜梦说说话 / 助手设置 / 语义适配 / 记忆），立绘不再当入口。
 * 控制器脚本会经过酒馆的宏替换，这个文件里不能出现宏的写法。 */
(function () {
  var app = window.ReaderController;
  if (!app || typeof app.command !== 'function') throw new Error('Reader-II 通用钩子：ReaderController 尚未建立');
  var extra = {
    openGacha: function () { return dreamOpenGacha(); },
    openIndependentApiSettings: function () { return openIndependentApiSettings(null, pToast); },
    openExtraSettings: function () { return typeof openExtraSettingsModal === 'function' ? openExtraSettingsModal(null, pToast) : false; },
    openAgent: function (tab) { return dreamOpenAgent(tab || 'chat'); },
    openPanel: function () { return dreamOpenPanel(); }
  };
  var original = app.command;
  app.command = function (name) {
    if (!Object.prototype.hasOwnProperty.call(extra, name)) return original.apply(this, arguments);
    if (!window.__readerControllerAlive) return false;
    var result = extra[name].apply(null, Array.prototype.slice.call(arguments, 1));
    window.__readerHostApi?.refresh();
    return result;
  };

})();
