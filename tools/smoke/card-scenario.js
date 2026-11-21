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
    // 升级用户即使保留最积极的旧阈值，正文事件也不应发起任何整理请求。
    window.ReaderII.memory.saveSettings({ enabled: true, autoExtract: true, everyTurns: 1, keepRecent: 0 });
    return mock.native ? '没有酒馆助手、没有 MVU' : '有酒馆助手与 MVU';
  });
  await step('新卡默认注入；统一入口直接进入大厅', async () => {
    assert(window.ReaderII.lobby.isEnabled(), '新卡应默认启用');
    await mock.eventSource.emit(mock.ctx.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    assert(mock.prompts.reader_ii_core?.text, '默认启用的卡没有注入核心提示词');
    const menu = await until(() => $('#reader-ii-menu'), '扩展菜单');
    assert(menu.textContent.trim() === 'Reader-II', '菜单名称不对');
    menu.click();
    await until(() => window.ReaderII.lobby.isEnabled() && $('#dlb-overlay'), '启用并打开大厅', 20000);
    assert(mock.confirms.length === 0, '默认启用时仍在询问');
  });
  await step('同一张卡可新建、切换与删除独立的助手对话', async () => {
    const threads = window.ReaderII.agent.threads;
    await threads.ready();
    const first = threads.currentId(), second = await threads.create();
    assert(second !== first && second === threads.currentId(), '没有切换到新建的对话');
    assert(threads.list().every(row => row.owner.key && row.owner.label.includes(mock.ctx.name2)), '对话归属未包含角色名称');
    await threads.select(first);
    assert(threads.currentId() === first, '没有切换回原对话');
    await threads.remove(second);
    assert(threads.list().some(row => row.id === first) && !threads.list().some(row => row.id === second), '删除影响了其他对话');
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
    assert($('[data-s="a.plotContext"]').checked && $('#ra-plot-mode').value === 'auto', '新安装应默认自动读取剧情来源');
    assert(!$('[data-s="a.useAssistantPreset"]'), '仍有旧预设开关');
    const persona = $('textarea[data-s="personaPrompt"]');
    const appearance = $('#ra-appearance-prompt');
    const system = $('textarea[data-s="a.assistantSystemPrompt"]');
    const originalLook = window.ReaderII.agent.personaContext().appearance.defaultPrompt;
    assert(persona && system && originalLook && appearance?.value === originalLook, '设置里没有显示当前人格和装扮');
    persona.value = '冒烟当前人格：说话前先放下手中的书。';
    appearance.value = '细银边圆眼镜，衣领别着一朵蓝花。';
    system.value = '冒烟助手专用：办完任务后发一份清单。';
    mode.value = 'text'; $('[data-act="save-settings"]').click();
    await until(() => window.ReaderII.agent.getSettings().toolProtocol === 'text' && $('[data-ra-status="settings"]')?.textContent.includes('设置已保存'), '设置保存');
    assert(window.ReaderII.agent.getSettings().assistantSystemPrompt === system.value, '助手专用文本未保存');
    assert(window.ReaderII.agent.personaContext().appearance.prompt === appearance.value && $('#ra-appearance-prompt').value === appearance.value, '助手没有取得保存后的外貌');
    $('#ra-appearance-prompt').value = '';
    $('[data-act="save-settings"]').click();
    assert(window.ReaderII.agent.personaContext().appearance.prompt === originalLook && $('#ra-appearance-prompt').value === originalLook, '清空外貌后没有恢复大厅装扮');
    const toggle = () => $('#ra-reader-card [data-act="card-toggle"]');
    assert(toggle()?.getAttribute('aria-checked') === 'true', '卡开关应开启'); toggle().click();
    await until(() => !window.ReaderII.lobby.isEnabled() && toggle()?.getAttribute('aria-checked') === 'false', '卡停用');
    window.ReaderII.agent.close();
    $('#reader-ii-menu').click();
    await until(() => $('#reader-agent-overlay')?.open && $('.ra-pane[data-pane="chat"].is-on'), '本卡停用后进入助手');
    assert(!window.ReaderII.lobby.isEnabled(), '打开助手不应重新启用卡');
    $('[data-tab="settings"]').click();
    toggle().click(); await until(() => window.ReaderII.lobby.isEnabled() && toggle()?.getAttribute('aria-checked') === 'true', '卡启用');
    assert(!document.querySelector('[data-act="upd-inspect"], [data-act="upd-apply"], #ra-upd-scope'), '仍有旧组件安装入口');
    window.ReaderII.agent.close();
  });
  await step('模型方案与列表、任务角色和媒体工具可以分别配置，关闭后保留选择', async () => {
    await window.__smokeView('cafe', 'settings');
    const { agent, llm } = window.ReaderII;
    const change = (node, value) => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); };
    $('#ra-preset-manager').open = true;
    const editor = $('[data-editor="preset"]');
    $('[data-preset-name]', editor).value = '测试反代';
    $('[data-preset-url]', editor).value = 'https://ui-model-smoke.invalid/v1';
    $('[data-act="models-fetch"]', editor).click();
    const list = await until(() => $('[data-model-results] option[value="catalog-writer"]', editor), '编辑未保存连接时读取模型目录');
    change(list.parentElement, 'catalog-writer');
    assert($('[data-model-name]', editor).value === 'catalog-writer', '列表选择没有回填模型');
    $('[data-act="models-preset-save"]').click();
    const id = $('#ra-preset-choice').value;
    assert(id && llm.getConnectionPreset(id).model === 'catalog-writer', '新方案未保存');
    change($('#ra-delegate-mode'), 'rules');
    $('[data-act="models-role-add"]').click();
    const role = $('#ra-role-rows').lastElementChild;
    $('[data-role-name]', role).value = '剧情校对';
    $('[data-role-task]', role).value = '检查前后设定是否一致';
    change($('[data-source-select]', role), id);
    $('[data-model-name]', role).value = 'private-alias';
    change($('[data-role-effort]', role), 'high');
    $('[data-act="save-settings"]').click();
    const saved = agent.getSettings().subagents.rules.find(rule => rule.name === '剧情校对');
    assert(saved?.presetId === id && saved?.model === 'private-alias' && saved?.effort === 'high', '角色设置未按指定模型保存');
    $('#ra-subagents-enabled').click();
    assert(!agent.getSettings().subagents.enabled && agent.getSettings().subagents.rules.length, '关闭丢失了角色方案');
    $('#ra-subagents-enabled').click();
    const media = $('[data-editor="video"]');
    change($('[data-source-select]', media), id);
    $('[data-model-name]', media).value = 'catalog-film';
    $('[data-media-enabled]', media).checked = true;
    $('[data-act="models-media-save"]', media).click();
    assert(llm.getTaskConnection('video').configured, '媒体工具尚未启用');
    $('[data-media-enabled]', media).checked = false;
    $('[data-act="models-media-save"]', media).click();
    assert(!llm.getTaskConnection('video').configured && llm.getTaskConnection('video').model === 'catalog-film', '关闭视频工具丢失了模型');
    change($('#ra-delegate-mode'), 'smart');
    $('[data-act="save-settings"]').click();
    assert(agent.getSettings().subagents.mode === 'smart' && agent.getSettings().subagents.rules.length, '切换智能代理丢失角色');
    agent.close();
    agent.open('settings');
    assert($('#ra-delegate-mode').value === 'smart' && $('[data-editor="video"] [data-source-select]').value === id, '重开面板未恢复配置');
    agent.close();
  });
  await step('媒体工具生成的图片与视频可在回复中打开，重开后仍在', async () => {
    const { agent, llm } = window.ReaderII;
    const originalReply = llm.chatReply, originalGenerate = llm.generateMedia;
    const originalSettings = agent.getSettings();
    const originalImage = llm.getTaskConnection('image'), originalVideo = llm.getTaskConnection('video');
    const previous = agent.threads.currentId(), thread = await agent.threads.create();
    const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k2yQAAAAASUVORK5CYII=';
    const video = 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28y';
    const prompts = [], calls = [];
    try {
      llm.saveTaskConnection('image', { enabled: true });
      llm.saveTaskConnection('video', { enabled: true });
      agent.saveSettings({ toolProtocol: 'text', lite: false, recall: false, plotContext: false, approval: 'auto' });
      llm.generateMedia = async kind => {
        calls.push(kind);
        return kind === 'image' ? { images: [{ url: picture }] } : { videos: [{ url: video }] };
      };
      llm.chatReply = async request => {
        prompts.push(JSON.stringify(request.messages));
        return { text: prompts.length === 1
          ? '<tool_call name="generate_image"><arg name="prompt">一张城市夜景</arg></tool_call>\n<tool_call name="generate_video"><arg name="prompt">拍摄城市夜景</arg></tool_call>'
          : '已完成。' };
      };
      agent.open('chat');
      await until(() => $('#ra-text') && !$('#ra-text').disabled, '媒体对话就绪');
      $('#ra-text').value = '生成城市夜景的图片和视频。';
      $('#ra-send').click();
      await until(() => {
        const allow = $('#ra-log [data-answer="allow"]');
        if (allow && !allow.disabled) allow.click();
        return $('#ra-log .ra-ai img') && $('#ra-log .ra-ai video');
      }, '回复中的两种媒体');
      assert(calls.includes('image') && calls.includes('video'), '主助手未调用两个媒体工具');
      assert(!prompts.at(-1).includes('base64,'), '媒体二进制进入主模型提示词');
      await until(() => !agent.isBusy(), '媒体任务结束');
      const delivered = agent.getHistory().at(-1);
      assert(delivered?.images?.[0]?.url === picture && delivered?.videos?.[0]?.url === video, '本轮已经显示，历史未保存完整附件');
      assert(agent.threads.currentId() === thread, '本轮实际会话不匹配 ' + JSON.stringify(agent.threads.list().map(row => [row.title, row.id === thread, row.nextId ? '已交接' : '无交接'])));
      agent.close();
      await agent.threads.select(previous);
      await agent.threads.select(thread);
      assert(agent.getHistory().at(-1)?.videos?.[0]?.url === video, '重新选择线程时丢失视频附件');
      agent.open('chat');
      await until(() => !$('#ra-text').disabled, '重新打开媒体会话');
      const images = Array.from(document.querySelectorAll('#ra-log .ra-ai img.ra-generated'));
      const videos = Array.from(document.querySelectorAll('#ra-log video[controls]'));
      assert(images.some(node => node.src === picture) && videos.some(node => node.src === video), '重开后媒体元素数量 ' + images.length + '/' + videos.length + '，记录数 ' + agent.getHistory().length);
    } finally {
      llm.chatReply = originalReply; llm.generateMedia = originalGenerate;
      agent.saveSettings(originalSettings);
      llm.saveTaskConnection('image', originalImage); llm.saveTaskConnection('video', originalVideo);
      agent.close();
      if (!agent.isBusy()) { await agent.threads.select(previous); await agent.threads.remove(thread); }
    }
  });
  await step('三段正文提示词可分别设置世界书位置、深度、角色和出口，保存后重新打开仍生效', async () => {
    await window.__smokeView('cafe', 'settings');
    assert($('textarea[data-s="personaPrompt"]').value.includes('冒烟当前人格') && $('textarea[data-s="a.assistantSystemPrompt"]').value.includes('冒烟助手专用'), '重新打开后提示词有误');
    const field = key => $('#ra-placement-card [data-s="p.' + key + '"]');
    const change = (key, value) => {
      const input = field(key);
      input.value = value;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    assert(field('core.position').options.length === 8 && field('core.position').value === '0', '核心默认位置或位置选项不对');
    assert(field('rules.depth').value === '4' && field('list.depth').value === '1', '两条默认深度不对');
    change('core.position', '7');
    assert(!field('core.outletName').closest('[hidden]') && field('core.role').closest('[hidden]'), '出口字段显示不对');
    change('core.outletName', '夜梦正文');
    change('rules.depth', '7'); change('rules.role', '2'); change('rules.order', '199');
    field('list.enabled').click();
    $('[data-act="save-settings"]').click();
    const stored = mock.ctx.extensionSettings.reader_ii.storyPromptPlacement;
    assert(stored.core.position === 7 && stored.core.outletName === '夜梦正文', '宏出口未保存');
    assert(stored.rules.depth === 7 && stored.rules.role === 2 && stored.rules.order === 199 && !stored.list.enabled, '深度设置或开关未保存');
    window.ReaderII.agent.close(); await window.__smokeView('cafe', 'settings');
    assert(field('core.outletName').value === '夜梦正文' && field('rules.role').value === '2' && !field('list.enabled').checked, '重开后设置丢失');
    change('core.position', '0'); change('rules.depth', '4'); change('rules.role', '0'); change('rules.order', '100');
    field('list.enabled').click(); $('[data-act="save-settings"]').click();
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
    assert(mock.prompts.reader_ii_core.text.includes('冒烟当前人格'), '当前人格提示词未进入正文');
    assert(!Object.values(mock.prompts).some(item => (item?.text || '').includes('冒烟助手专用')), '助手共用提示词泄漏到正文');
    const event = '<READER_FP_EVENT>{"event_id":"hidden"}</READER_FP_EVENT>';
    const data = { chat: [{ content: '正文' + event }, { content: [{ type: 'text', text: '正文' + event }] }] };
    await mock.eventSource.emit(mock.ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, data);
    assert(data.chat[0].content === '正文' && data.chat[1].content[0].text === '正文', '事件块进了提示词');
  });
  await step('生成一轮 FP 记账，事件不显示且新轻信挂上', async () => {
    const modelCalls = mock.llmCalls.length;
    const before = Number(await window.ReaderCore.getFpBalance());
    const id = await mock.receive('下一页。\n<READER_FP_EVENT>{"source":"reader_owned","category":"resurrection","event_id":"smoke-fp","evidence":"冒烟"}</READER_FP_EVENT>\n<dream>「这一页送给你。」</dream>');
    await until(async () => Number(await window.ReaderCore.getFpBalance()) === before + 200, 'FP 入账');
    assert(!/READER_FP_EVENT|smoke-fp/.test($(`.mes[mesid="${id}"]`).textContent), '事件显示出来了');
    await until(() => /这一页送给你/.test(letterBody(id)?.textContent || ''), '新轻信');
    await new Promise(resolve => setTimeout(resolve, 2800));
    assert(mock.llmCalls.length === modelCalls, '正文生成后调用了记忆整理模型');
    return `${before} → ${before + 200}`;
  });
  await step('大厅的命运抽卡能打开', async () => {
    await window.ReaderII.lobby.open();
    (await until(() => $('[data-dlb="gacha"]'), '抽卡入口')).click();
    await until(() => { const node = $('.bs-gacha, [data-dream-overlay="gacha"]'); return node && !node.hidden; }, '抽卡面板');
    $('#reader-ii-controller').contentWindow.ReaderGacha.close();
  });
  await step('换卡、同卡换聊天、切回原卡后服务台都能直接打开助手', async () => {
    const { ctx } = mock;
    const { agent } = window.ReaderII;
    const firstChat = ctx.chatId, firstName = ctx.name2;
    const firstCard = ctx.characterId, messages = [...ctx.chat];
    const secondCard = ctx.characters.push({ name: '第二张卡', avatar: 'second.png', data: { extensions: {} } }) - 1;
    async function enter(card, chatId) {
      ctx.characterId = card;
      ctx.name2 = ctx.characters[card].name;
      await mock.switchChat(chatId, card === firstCard ? messages : [{ name: ctx.name2, mes: '你好。' }]);
    }
    async function openFromDesk(action, tab) {
      assert(await window.ReaderII.lobby.open('eggs'), '服务台没打开');
      $('[data-dlb="' + action + '"]').click();
      await until(() => $('#reader-agent-overlay')?.open && $('.ra-pane[data-pane="' + tab + '"].is-on'), '服务台打开' + tab);
      await agent.threads.ready();
      const row = agent.threads.list().find(item => item.id === agent.threads.currentId());
      assert(row?.owner.label === ctx.name2 + ' / ' + ctx.chatId, '助手仍在上一段聊天');
      agent.close();
    }
    try {
      await openFromDesk('eggagent', 'chat');
      // 旧卡脚本曾向父窗口写入 ReaderAgent 占位。卸载时酒馆助手会还原它写入前的属性。
      delete window.ReaderAgent;
      await enter(secondCard, '第二张卡的第一段聊天');
      await openFromDesk('eggagent', 'chat');
      await enter(secondCard, '第二张卡的另一段聊天');
      await openFromDesk('eggagentset', 'settings');
      await enter(firstCard, firstChat);
      await openFromDesk('eggmemory', 'memory');
    } finally {
      window.ReaderAgent = agent;
      agent.close();
      if (ctx.characterId !== firstCard || ctx.chatId !== firstChat) await enter(firstCard, firstChat);
      ctx.name2 = firstName;
      ctx.characters.pop();
    }
  });
  const failed = results.filter((x) => !x.ok);
  document.title = failed.length ? `SMOKE FAIL ${failed.length}/${results.length}` : `SMOKE PASS ${results.length}/${results.length}`;
  report();
}
if (params.get('auto') === '1') main().catch((error) => { log.textContent += '\nFAIL ' + error.stack; document.title = 'SMOKE FAIL 场景异常'; });
