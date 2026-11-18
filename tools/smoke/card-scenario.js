/* 只装扩展的按卡冒烟。?native=1 时没有酒馆助手、没有 MVU。 */
const params = new URLSearchParams(location.search);
const mock = window.__mock;
const $ = (selector, root = document) => root.querySelector(selector);
const until = window.__smokeUntil;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const results = [];
const log = document.getElementById('smoke-log');
function report() {
  log.textContent = results.map((x) => `${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? ' — ' + x.detail : ''}`).join('\n');
}
async function step(name, task) {
  try { const detail = await task(); results.push({ name, ok: true, detail }); }
  catch (error) { results.push({ name, ok: false, detail: String(error.message || error) }); }
  report();
}
function letters(doc = document) {
  const found = [...doc.querySelectorAll('iframe[data-reader-dream-frame]')];
  for (const frame of doc.querySelectorAll('iframe:not([data-reader-dream-frame])')) {
    try { if (frame.contentDocument) found.push(...letters(frame.contentDocument)); } catch { /* 跨源页不在轻信范围 */ }
  }
  return found;
}
const letterBody = (id) => letters().find((f) => f.dataset.readerMessageId === String(id))?.contentDocument?.querySelector('.text-body-royal');
async function main() {
  await step('只加载扩展，ReaderCore 与 ReaderII 在酒馆主窗口就绪', async () => {
    await mock.booted;
    await until(() => window.ReaderII?.ready && window.ReaderCore, '扩展主包', 20000);
    assert(!document.querySelector('iframe[id^="th-script-"]'), '加载了旧主脚本');
    assert(!mock.worldbooks['reader-ii.worldbook'], '加载了旧世界书');
    if (mock.native) assert(!window.TavernHelper && !window.Mvu, '原生模式仍提供了插件');
    window.ReaderII.memory.saveSettings({ enabled: false }); // 假模型只负责事件，不做自动记忆整理。
    return mock.native ? '没有酒馆助手、没有 MVU' : '有酒馆助手与 MVU';
  });
  await step('未启用时不注入；菜单确认后按卡启用并进入大厅', async () => {
    assert(!window.ReaderII.lobby.isEnabled(), '新卡应未启用');
    await mock.eventSource.emit(mock.ctx.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    assert(['reader_ii_core', 'reader_ii_rules', 'reader_ii_list'].every((id) => !mock.prompts[id]?.text), '未启用就注入了提示词');
    const menu = await until(() => $('#reader-ii-menu'), '扩展菜单');
    assert(menu.textContent.includes('Reader-II · 大厅'), '菜单名称不对');
    menu.click();
    await until(() => window.ReaderII.lobby.isEnabled() && $('#dlb-overlay'), '启用并打开大厅', 20000);
    assert(mock.confirms.length === 1, '应先问一次');
    assert(mock.ctx.characters[0].data.extensions.reader_ii.enabled === true, '没有保存角色卡开关');
  });
  await step('三套大厅主题与服务台四个入口', async () => {
    for (const theme of ['cafe', 'summer', 'ink']) {
      await window.__smokeView(theme, 'lobby');
      const ctl = $('#reader-ii-controller').contentWindow;
      assert(ctl.getVisualTheme() === theme, '大厅主题不对：' + theme);
      for (const [key, page] of [['eggagent', 'chat'], ['eggagentset', 'settings'], ['eggmemory', 'memory'], ['eggpanel', 'panel']]) {
        window.ReaderII.agent.close();
        $('[data-reader-core-panel] [data-reader-close]')?.click();
        assert(await window.ReaderII.lobby.open('eggs'), '服务台没打开');
        (await until(() => $(`[data-dlb="${key}"]`), key)).click();
        if (page === 'panel') {
          await until(() => $(`[data-reader-core-panel][data-theme="${theme}"]`), '语义适配');
          const back = $('[data-reader-core-panel] [data-reader-back]');
          assert(back && !back.hidden, '缺少返回服务台'); back.click();
          await until(() => $('[data-dlb="eggpanel"]'), '回到服务台');
        } else {
          await until(() => $('#reader-agent-overlay')?.open && $(`.ra-tab[data-tab="${page}"][aria-selected="true"]`) && $(`.ra-pane[data-pane="${page}"].is-on`), '助手页 ' + page);
          assert($('#reader-agent-overlay').dataset.theme === theme, '助手主题不对');
          const back = $('#reader-agent-overlay [data-act="back-lobby"]');
          assert(back && !back.hidden, '缺少返回服务台'); back.click();
          await until(() => !$('#reader-agent-overlay').open && $('[data-dlb="eggagent"]'), '回到服务台');
        }
      }
    }
  });
  await step('设置页保存工具调用方式并显示保存状态；按卡开关可停用和启用', async () => {
    await window.__smokeView('cafe', 'settings');
    const mode = $('select[data-s="a.toolProtocol"]');
    assert(mode && ['auto', 'native', 'text'].every((value) => [...mode.options].some((o) => o.value === value)), '缺少工具调用方式');
    mode.value = 'text'; $('[data-act="save-settings"]').click();
    await until(() => window.ReaderII.agent.getSettings().toolProtocol === 'text' && $('[data-ra-status="settings"]')?.textContent.includes('设置已保存'), '设置保存');
    const toggle = () => $('#ra-reader-card [data-act="card-toggle"]');
    assert(toggle()?.getAttribute('aria-checked') === 'true', '卡开关应开启'); toggle().click();
    await until(() => !window.ReaderII.lobby.isEnabled() && toggle()?.getAttribute('aria-checked') === 'false', '卡停用');
    toggle().click(); await until(() => window.ReaderII.lobby.isEnabled() && toggle()?.getAttribute('aria-checked') === 'true', '卡启用');
    assert(!document.querySelector('[data-act="upd-inspect"], [data-act="upd-apply"], #ra-upd-scope'), '仍有旧组件安装入口');
    window.ReaderII.agent.close();
  });
  await step('无 MessageFormatter 时两条内置正则挂轻信并隐藏事件', async () => {
    assert(!mock.ctx.MessageFormatter, '此场景必须覆盖正则兜底');
    assert(mock.ctx.extensionSettings.regex.length === 2, '应有两条内置正则');
    mock.renderChat(); window.ReaderShell.scan();
    await until(() => letterBody(0) && letterBody(2), '主文档和美化 iframe 的轻信');
    assert(/欢迎回来/.test(letterBody(0).textContent) && /今天的故事/.test(letterBody(2).textContent), '轻信正文不对');
    const decorated = $('.mes[mesid="2"] iframe.smoke-render').contentDocument.body.textContent;
    assert(!/READER_TASK_EVENT|冒烟用的事件块/.test($('#chat').textContent + decorated), '事件块仍在显示');
  });
  await step('生成前注入三条编译提示词；发给模型的事件块被移除', async () => {
    await mock.eventSource.emit(mock.ctx.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    for (const [id, position, depth] of [['reader_ii_core', 2, 0], ['reader_ii_rules', 1, 4], ['reader_ii_list', 1, 1]]) {
      const item = mock.prompts[id]; assert(item?.text && item.position === position && item.depth === depth, '提示词缺失或位置不对：' + id);
      assert(!/<%|%>/.test(item.text), '模板没有编译');
    }
    const event = '<READER_FP_EVENT>{"event_id":"hidden"}</READER_FP_EVENT>';
    const data = { chat: [{ content: '正文' + event }, { content: [{ type: 'text', text: '正文' + event }] }] };
    await mock.eventSource.emit(mock.ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, data);
    assert(data.chat[0].content === '正文' && data.chat[1].content[0].text === '正文', '事件块进了提示词');
  });
  await step('生成一轮 FP 记账，事件不显示且新轻信挂上', async () => {
    const before = Number(await window.ReaderCore.getFpBalance());
    const id = await mock.receive('下一页。\n<READER_FP_EVENT>{"source":"reader_owned","category":"resurrection","event_id":"smoke-fp","evidence":"冒烟"}</READER_FP_EVENT>\n<dream>「这一页送给你。」</dream>');
    await until(async () => Number(await window.ReaderCore.getFpBalance()) === before + 200, 'FP 入账');
    assert(!/READER_FP_EVENT|smoke-fp/.test($(`.mes[mesid="${id}"]`).textContent), '事件显示出来了');
    await until(() => /这一页送给你/.test(letterBody(id)?.textContent || ''), '新轻信');
    return `${before} → ${before + 200}`;
  });
  await step('大厅的命运抽卡能打开', async () => {
    await window.ReaderII.lobby.open();
    (await until(() => $('[data-dlb="gacha"]'), '抽卡入口')).click();
    await until(() => { const node = $('.bs-gacha, [data-dream-overlay="gacha"]'); return node && !node.hidden; }, '抽卡面板');
    $('#reader-ii-controller').contentWindow.ReaderGacha.close();
  });
  const failed = results.filter((x) => !x.ok);
  document.title = failed.length ? `SMOKE FAIL ${failed.length}/${results.length}` : `SMOKE PASS ${results.length}/${results.length}`;
  report();
}
if (params.get('auto') === '1') main().catch((error) => { log.textContent += '\nFAIL ' + error.stack; document.title = 'SMOKE FAIL 场景异常'; });
