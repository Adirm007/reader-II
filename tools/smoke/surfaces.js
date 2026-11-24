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
  } else if (page === 'float' || page === 'float-dock') {
    /* 后台任务的状态浮窗：挂一张进行中的牌子和一张失败的牌子。float 是助手窗口关着时浮在页面上的样子，float-dock 是收进窗口里的样子。 */
    const board = window.ReaderII.jobs;
    board.list().forEach((job) => { if (job.state === 'running') board.cancel(job.id); else board.dismiss(job.id); });
    if (window.__smokeJob) window.__smokeJob.cancelled('截图换页');
    board.list().forEach((job) => board.dismiss(job.id));
    board.start({ owner: 'director', kind: 'patrol', level: 'minor', title: '导演 · 后台巡检', stage: '场记判定偏移' }).fail(new Error('场记没有按约定返回 JSON：回复里没有 JSON 对象'));
    window.__smokeJob = board.start({ owner: 'director', kind: 'plan', title: '导演 · 编纲', stage: '第 2 步 · 卷核立意与关系网', steps: 4, step: 2, cancel() {}, open() {} });
    window.__smokeJob.log('勘察资料 8420 字（上限 11702）');
    window.__smokeJob.log('第 1 步完成（512 字）');
    if (page === 'float-dock') window.ReaderII.agent.open('chat');
    const dock = page === 'float' ? 'page' : 'dialog';
    /* 浮窗是异步重画的：认准这一次新挂的那张牌子（按 id），别把上一轮留在页面上的旧内容当成新的。 */
    const row = () => document.querySelector(`#reader-agent-float .rf-job[data-job="${window.__smokeJob.id}"]`);
    await until(() => {
      const found = document.querySelector('#reader-agent-float');
      return found && found.dataset.dock === dock && found.dataset.theme === theme && found.querySelectorAll('.rf-job').length === 2 && row();
    }, '状态浮窗 ' + dock);
    if (row().dataset.open !== '1') row().querySelector('[data-rf="toggle"]').click();
    await until(() => row() && row().dataset.open === '1', '浮窗展开');
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
