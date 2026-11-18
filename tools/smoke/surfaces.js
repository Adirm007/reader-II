/* 冒烟与截图共用的打开路径，不改界面样式。主题写在聊天变量里。 */
window.__smokeUntil = async function (check, label, timeout = 15000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('等待超时：' + label);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};
window.__smokeView = async function (theme, page) {
  const until = window.__smokeUntil;
  await until(() => window.ReaderII?.ready && window.ReaderCore, '扩展就绪');
  const ctx = window.SillyTavern.getContext();
  ctx.chatMetadata.variables.dream_visual_theme = theme;
  // 控制器的本机偏好也同步，防止旧偏好覆盖当前聊天主题。
  localStorage.setItem('reader_ii_visual_theme', theme);
  await window.ReaderII.lobby.enable();
  window.ReaderII.agent.close();
  const panel = document.querySelector('[data-reader-core-panel]');
  if (panel) panel.querySelector('[data-reader-close]')?.click();
  window.ReaderShell.close();
  if (page === 'lobby') {
    if (!await window.ReaderII.lobby.open()) throw new Error('大厅未打开');
    await until(() => document.querySelector('#dlb-overlay'), '大厅');
  } else if (page === 'panel') {
    window.ReaderCore.openPanel();
    await until(() => document.querySelector(`[data-reader-core-panel][data-theme="${theme}"]`), '语义适配主题');
  } else {
    window.ReaderII.agent.open(page);
    await until(() => {
      const dialog = document.querySelector('#reader-agent-overlay');
      return dialog?.open && dialog.dataset.theme === theme && dialog.querySelector(`.ra-pane[data-pane="${page}"].is-on`);
    }, '助手页与主题 ' + page);
    const scroll = document.querySelector(`[data-pane="${page}"] .ra-scroll`);
    if (scroll) scroll.scrollTop = 0;
  }
  if (document.fonts?.ready) await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
};
