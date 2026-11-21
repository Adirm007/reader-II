/*
 * 冒烟场景（host.html?auto=1 时自动运行）。尽量走真实的界面路径：点菜单、往输入框打字、点发送、点确认卡。
 * 每一步一行 PASS / FAIL，最后把总评写进标题（SMOKE PASS n/n 或 SMOKE FAIL m/n）。
 * 命令行里跑：node tools/smoke/run.mjs（自己起服务器和无头 Chrome，两种模式各跑一遍）。
 */
const params = new URLSearchParams(location.search);
const mock = window.__mock;
const withHelper = params.get('th') !== '0';
const results = [];
const logNode = document.getElementById('smoke-log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`等待超时：${label}`);
    await sleep(40);
  }
}
const call = (name, args) => `<tool_call name="${name}">\n${Object.entries(args).map(([key, value]) => `<arg name="${key}">${value}</arg>`).join('\n')}\n</tool_call>`;
const $ = (selector) => document.querySelector(selector);

function report() {
  const failed = results.filter((item) => !item.ok);
  const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  logNode.innerHTML = results.map((item) => `<span class="${item.ok ? 'pass' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'}  ${esc(item.name)}${item.detail ? '  — ' + esc(item.detail) : ''}</span>`).join('\n');
  return failed;
}

async function step(name, body) {
  try {
    const detail = await body();
    results.push({ name, ok: true, detail: detail === undefined ? '' : detail });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error && error.message || error) });
  }
  report();
}

function assert(condition, message) { if (!condition) throw new Error(message); }

/* 世界书「王都」条目现在的正文：两种模式存的地方不同。 */
function capital() {
  if (withHelper) return mock.worldbooks.设定集.find((entry) => entry.name === '王都').content;
  return Object.values(mock.native.设定集.entries).find((entry) => entry.comment === '王都').content;
}

async function ask(text, replies, onConfirm) {
  mock.replies.push(...replies);
  const input = await until(() => $('#ra-text:not(:disabled)'), '输入框');
  input.value = text;
  $('#ra-send').click();
  if (onConfirm) {
    const button = await until(() => $(`#ra-log .ra-confirm [data-answer="${onConfirm}"]`), '确认卡');
    button.click();
  }
  await until(() => !window.ReaderII.agent.isBusy(), '本轮结束', 15000);
  await sleep(60);
}

async function main() {
  await step('主包加载并就绪', async () => {
    await until(() => window.ReaderII && window.ReaderII.ready, 'ReaderII.ready', 10000);
    return `${window.ReaderII.version} · ${window.ReaderII.carrier} · 酒馆助手 ${withHelper ? '有' : '无'}`;
  });
  const agent = window.ReaderII.agent;
  const vfs = window.ReaderII.vfs;

  if (params.has('unbound')) {
    const answer = '这是无卡助手的回复。';
    const marker = 'reader-smoke-unbound-reload';
    await step('从魔法棒菜单进入无卡助手', async () => {
      const menu = await until(() => $('#reader-ii-menu'), 'Reader-II 入口');
      delete window.ReaderII;
      delete window.ReaderAgent;
      menu.click();
      await until(() => $('#reader-agent-overlay')?.open && $('#ra-text'), '无卡助手');
      assert(window.ReaderII.agent === agent && window.ReaderAgent === agent, '魔法棒入口没有恢复已加载的助手');
      assert(!window.ReaderII.lobby.isEnabled(), '无卡打开助手触发了读者大厅');
    });
    if (!sessionStorage.getItem(marker)) {
      await step('在无卡会话中发送消息', async () => {
        agent.saveSettings({ lite: true, plotContext: false, recall: false });
        await ask('测试无卡会话', [answer]);
        await until(() => agent.getHistory().some(turn => turn.text === answer), '回复存入历史');
      });
      if (!results.some(item => !item.ok)) {
        sessionStorage.setItem(marker, '1');
        location.reload();
        return;
      }
    } else {
      await step('刷新后恢复同一无卡会话及回复', async () => {
        await until(() => $('#ra-log')?.textContent.includes(answer), '无卡回复重载');
        assert(agent.getHistory().some(turn => turn.role === 'user' && turn.text === '测试无卡会话'), '未恢复用户消息');
      });
    }
    const failures = report();
    document.title = failures.length ? 'SMOKE FAIL ' + failures.length : 'SMOKE PASS ' + results.length;
    return;
  }

  await step('启动期间没有报错', async () => {
    const errors = (window.__readerIIProbe && window.__readerIIProbe.errors || []).map((item) => item.text);
    assert(errors.length === 0, errors.join(' | ').slice(0, 300));
  });

  await step('新卡默认启用，助手记忆仍按其独立开关控制', async () => {
    await sleep(200);
    const injected = mock.prompts['reader-ii-memory'];
    assert(!injected || !(injected.text || injected.content), '记忆共享关闭时注入了正文记忆');
    assert(mock.llmCalls.length === 0, '启动后就调用了模型');
    assert(!window.ReaderII.memory.getSettings().unify, '助手记忆应默认仅供助手使用');
  });

  await step('扩展菜单入口与 /yume 命令', async () => {
    const item = await until(() => $('#reader-ii-menu'), '菜单入口');
    assert(item.matches('#extensionsMenu > div.list-group-item') && item.firstElementChild.matches('.extensionsMenuExtensionButton'), '扩展菜单条目必须匹配酒馆原生菜单与图标样式');
    assert(!$('#extensions_settings2 [id^="reader-ii"], #extensions_settings [id^="reader-ii"]'), '扩展设置页出现了多余的 Reader-II 入口');
    assert(mock.slash.some((command) => command.name === 'yume'), '没有注册 /yume');
  });

  await step('菜单进入大厅，再从服务台打开助手（<dialog> 顶层）', async () => {
    assert($('#reader-ii-menu').textContent.trim() === 'Reader-II', '菜单名称不对');
    assert(document.querySelectorAll('#extensionsMenu [id^="reader-ii"]').length === 1, '扩展菜单有重复的 Reader-II 入口');
    $('#reader-ii-menu').click();
    await until(() => $('#dlb-overlay'), '大厅', 20000);
    await window.ReaderII.lobby.open('eggs');
    (await until(() => $('[data-dlb="eggagent"]'), '服务台对话入口')).click();
    const overlay = await until(() => $('#reader-agent-overlay'), '面板');
    assert(overlay.open, '面板没有处于打开状态');
    assert($('#ra-text') && $('#ra-send'), '缺少输入框或发送按钮');
    const rect = overlay.getBoundingClientRect();
    assert(rect.width > 200 && rect.height > 200, `面板尺寸异常 ${rect.width}x${rect.height}`);
    assert(!/undefined|\[object /.test(overlay.textContent), '面板文字里出现了 undefined：' + ($('#ra-foot-text')?.textContent || ''));
    assert($('#ra-tool-mode[data-mode="native"], #ra-tool-mode[data-mode="text"], #ra-tool-mode[data-mode="none"]'), '底栏没有显示工具调用方式');
    assert(document.documentElement.scrollWidth <= window.innerWidth + 1, '页面出现了横向滚动');
    return `${Math.round(rect.width)}×${Math.round(rect.height)} @ ${window.innerWidth}×${window.innerHeight}`;
  });

  await step('上一次运行留下的数据还在（刷新后）', async () => {
    /* 第一次打开时没有；跑过一遍再刷新，工作区标记与运行记录应当都在。 */
    const marker = await vfs.readText('ws:/smoke/标记.md');
    const runs = await agent.listRuns(10);
    return marker === null ? '首次运行，尚无旧数据' : `工作区标记在，运行记录 ${runs.length} 条`;
  });

  await step('对话：读 → 改 → 确认卡点「允许」→ 回答', async () => {
    const greeting = $('#ra-log [data-turn-id="greeting"]');
    if (greeting) {
      greeting.querySelector('[data-act="turn-edit"]').click();
      greeting.querySelector('textarea').value = '这里是修订后的欢迎语。';
      greeting.querySelector('[data-act="turn-save"]').click();
      await until(() => greeting.querySelector('.ra-msg-text')?.textContent === '这里是修订后的欢迎语。', '保存欢迎语');
    }
    await ask('把王都人口改成三十万', [
      '我先看看这个条目。\n' + call('read', { path: 'wb:/设定集/王都' }),
      call('edit', { path: 'wb:/设定集/王都', old: '人口十万', new: '人口三十万' }),
      '已经把王都的人口改成三十万了。',
    ], 'allow');
    assert(/人口三十万/.test(capital()), '世界书没有被修改：' + capital());
    assert(/已经把王都的人口改成三十万了/.test($('#ra-log').textContent), '面板里没有出现最终回答');
    assert(/【核心工具】/.test(mock.llmCalls[0][0].content), '系统提示词里没有核心工具');
    if (greeting) assert(mock.llmCalls[0].some(turn => turn.role === 'assistant' && turn.content === '这里是修订后的欢迎语。'), '第一轮没有收到已编辑的欢迎语');
  });

  await step('双方气泡支持编辑、保存、取消，重开后保留原角色与工具记录', async () => {
    const calls = mock.llmCalls.length;
    for (const [role, newText] of [['user', '请核对王都人口。'], ['ai', '核对完毕，人口三十万。']]) {
      const node = Array.from(document.querySelectorAll('#ra-log .ra-' + role + '[data-turn-id]')).at(-1);
      const original = node.querySelector('.ra-msg-text').textContent;
      node.querySelector('[data-act="turn-edit"]').click();
      node.querySelector('textarea').value = '放弃的修改';
      node.querySelector('[data-act="turn-cancel"]').click();
      assert(node.querySelector('.ra-msg-text').textContent === original, '取消编辑后原文有误');
      node.querySelector('[data-act="turn-edit"]').click();
      node.querySelector('textarea').value = newText;
      node.querySelector('[data-act="turn-save"]').click();
      await until(() => node.querySelector('.ra-msg-text')?.textContent === newText, '保存消息');
    }
    assert(mock.llmCalls.length === calls && capital().includes('人口三十万'), '编辑触发了模型或工具');
    assert($('#ra-log .ra-step[data-state="ok"]'), '编辑后丢失本轮工具详情');
    agent.close();
    agent.open('chat');
    await until(() => $('#ra-text:not(:disabled)') && $('#ra-log').textContent.includes('用过的工具'), '从 IndexedDB 重载历史工具记录');
    const [user, ai] = agent.getHistory().slice(-2);
    assert(user.text === '请核对王都人口。' && ai.text === '核对完毕，人口三十万。', '重开后消息不符');
    assert(ai.tools.includes('edit') && $('#ra-log').textContent.includes('用过的工具'), '重开后丢失工具记录');
  });

  await step('对话：确认卡点「拒绝」不会写入', async () => {
    const before = mock.llmCalls.length;
    await ask('再改成一万', [call('edit', { path: 'wb:/设定集/王都', old: '人口三十万', new: '人口一万' }), '你没有同意，我没有改。'], 'deny');
    assert(mock.llmCalls[before].some(turn => turn.role === 'user' && turn.content === '请核对王都人口。'), '下一轮缺少修订后的用户消息');
    assert(mock.llmCalls[before].some(turn => turn.role === 'assistant' && turn.content.includes('核对完毕，人口三十万。')), '下一轮缺少修订后的助手消息');
    assert(/人口三十万/.test(capital()), '被拒绝的修改还是写进去了');
  });

  await step('对话：从受阻操作进入权限档位，保存后返回原任务', async () => {
    const previous = agent.getSettings().mode;
    agent.saveSettings({ mode: 'readonly' });
    const original = capital();
    mock.replies.push(call('edit', { path: 'wb:/设定集/王都', old: '人口三十万', new: '人口九万' }), '保留原文。');
    $('#ra-text').value = '修改前让我看一下权限';
    $('#ra-send').click();
    try {
      const open = await until(() => $('#ra-log [data-review="settings"]'), '档位调整入口');
      assert(open.closest('.ra-confirm').textContent.includes('wb:/设定集/王都'), '没有显示实际操作目标');
      open.click();
      const mode = $('#ra-agent-card [data-s="a.mode"]');
      assert(document.activeElement === mode && mode.value === 'readonly', '没有定位到权限档位');
      mode.value = previous;
      $('#reader-agent-overlay [data-act="save-settings"]').click();
      assert($('#reader-agent-overlay [data-pane="chat"]').classList.contains('is-on'), '保存设置后没有返回对话');
      $('#ra-log [data-review="retry"]').click();
      await sleep(50);
      assert(agent.isBusy() && !$('#ra-log [data-answer="allow"]'), '模拟点击触发了待执行的写入');
      $('#ra-log [data-review="skip"]').click();
      await until(() => !agent.isBusy(), '结束本次权限等待');
      assert(capital() === original, '跳过后仍然写入');
    } finally {
      if (agent.isBusy()) $('#ra-send').click();
      agent.saveSettings({ mode: previous });
    }
  });

  await step('沙箱脚本 run_js（隔离 iframe）', async () => {
    const before = mock.llmCalls.length;
    /* 沙箱里伸手去够酒馆应当被浏览器拦下（跨源）。 */
    const code = 'let reach; try { reach = typeof parent.SillyTavern; } catch (error) { reach = "blocked"; } console.log("reach=" + reach); return 6 * 7;';
    await ask('算一下', [call('run_js', { code }), '是 42。']);
    const feedback = mock.llmCalls[before + 1].at(-1).content;
    assert(/status="ok"/.test(feedback) && /返回：42/.test(feedback), feedback.slice(0, 300));
    assert(/reach=blocked/.test(feedback), '沙箱竟然能碰到酒馆页面：' + feedback.slice(0, 200));
    assert(!document.querySelector('iframe[sandbox]'), '沙箱 iframe 没有清理');
    return feedback.match(/输出：\n([^\n]*)/)?.[1] || '';
  });

  await step('工具轮数：从对话底栏保存，触顶可在当前任务中选择汇总', async () => {
    $('#ra-tool-mode').click();
    const budget = await until(() => $('#ra-tools-card [data-s="a.maxSteps"]'), '每项任务的工具轮数');
    assert(Number(budget.max) >= 200, '大任务预算不可选');
    budget.value = '1';
    $('#reader-agent-overlay [data-act="save-settings"]').click();
    $('#reader-agent-overlay [data-tab="chat"]').click();
    assert(/1 轮$/.test($('#ra-tool-mode').textContent), '对话底栏没有更新');
    const before = capital();
    mock.replies.push(call('read', { path: 'wb:/设定集/王都' }), call('edit', { path: 'wb:/设定集/王都', old: '人口三十万', new: '人口九万' }), '已按要求汇总。');
    $('#ra-text').value = '读完还想写时先等我决定';
    $('#ra-send').click();
    try {
      const proceed = await until(() => $('#ra-log [data-budget="continue"]'), '预算用完的选择');
      assert(proceed.closest('.ra-confirm').textContent.includes('edit'), '没有显示待执行工具');
      proceed.click();
      await sleep(60);
      assert(agent.isBusy() && $('#ra-log [data-budget="continue"]'), '脚本模拟的点击追加了轮数');
      $('#ra-log [data-budget="finish"]').click();
      await until(() => !agent.isBusy(), '汇总完成');
      assert(capital() === before && $('#ra-log').textContent.includes('已按要求汇总'), '汇总时执行了待处理的改动或未回复');
    } finally { if (agent.isBusy()) $('#ra-send').click(); }
  });

  await step('IndexedDB：运行日志与工作区落盘', async () => {
    const runs = await agent.listRuns(10);
    assert(runs.length >= 1 && runs[0].changes >= 0, '没有运行记录');
    await vfs.write('ws:/smoke/标记.md', '冒烟 ' + Date.now(), null);
    assert(/^冒烟 /.test(await vfs.readText('ws:/smoke/标记.md')), '工作区读不回来');
    const databases = indexedDB.databases ? await indexedDB.databases() : null;
    if (databases) assert(databases.some((item) => item.name === 'reader_ii_agent_v1'), '没有创建 IndexedDB 数据库（走了内存退路）');
    return databases ? 'reader_ii_agent_v1 已创建' : '浏览器不支持 databases()，未确认';
  });

  await step('设置页：权限档位与确认方式可见、可保存', async () => {
    $('#reader-agent-overlay [data-tab="settings"]').click();
    const mode = await until(() => $('#reader-agent-overlay [data-s="a.mode"]'), '权限档位下拉');
    assert(mode.options.length === 4, '权限档位应有四档');
    assert($('#reader-agent-overlay [data-s="a.approval"]') && $('#reader-agent-overlay [data-s="a.plotContext"]') && $('#reader-agent-overlay [data-s="a.lite"]'), '缺少确认方式 / 剧情 / 轻聊开关');
    mode.value = 'tavern';
    $('#ra-tools-card [data-s="a.maxSteps"]').value = '200';
    $('#reader-agent-overlay [data-act="save-settings"]').click();
    await sleep(80);
    assert(agent.getSettings().mode === 'tavern', '保存后档位没变');
    assert(agent.getSettings().maxSteps === 200, '较大的预算没有生效');
    assert(window.SillyTavern.getContext().extensionSettings.reader_ii?.agent?.mode === 'tavern', '设置没有写进 extension_settings');
  });

  await step('设置页：改动记录里点「撤销」恢复世界书', async () => {
    const button = await until(() => $('#ra-runs [data-act="undo-run"]'), '撤销按钮');
    const rows = document.querySelectorAll('#ra-runs [data-act="undo-run"]').length;
    button.click();
    await until(() => /人口十万/.test(capital()), '世界书恢复', 5000);
    await until(() => document.querySelectorAll('#ra-runs [data-act="undo-run"]').length < rows, '记录刷新', 5000);
    return $('[data-ra-status="settings"]')?.textContent || '';
  });

  await step('记忆页能渲染', async () => {
    $('#reader-agent-overlay [data-tab="memory"]').click();
    await until(() => ($('#reader-agent-overlay [data-pane="memory"] .ra-scroll')?.children.length || 0) > 0, '记忆页内容');
  });

  await step('设置页：手动不选剧情来源可以保存，总开关与提示词独立生效', async () => {
    const previous = agent.getSettings();
    const persona = agent.personaContext();
    const field = (key) => $('#reader-agent-overlay [data-s="' + key + '"]');
    const personaText = '冒烟当前人格：以翻书声作开场。';
    const systemText = '冒烟助手共用：谈话结束时道声晚安。';
    try {
      $('#reader-agent-overlay [data-tab="settings"]').click();
      const source = await until(() => $('#ra-plot-mode'), '剧情来源设置');
      assert(source.value === 'auto' && field('a.plotContext').checked, '新设置应默认开启自动读取');
      assert(['baibai', 'shujuku', 'lwb', 'worldengine'].every((id) => $('#ra-plot-options [value="' + id + '"]')), '剧情来源选项不全');
      source.value = 'manual';
      source.dispatchEvent(new Event('change', { bubbles: true }));
      assert(!$('#ra-plot-options').hidden && field('a.plotContext').checked, '手动模式未显示或意外切换了总开关');
      field('personaPrompt').value = personaText;
      field('a.assistantSystemPrompt').value = systemText;
      $('#reader-agent-overlay [data-act="save-settings"]').click();
      agent.close();
      agent.open('settings');
      await until(() => field('personaPrompt'), '重开助手设置');
      assert($('#ra-plot-mode').value === 'manual' && field('a.plotContext').checked && agent.getSettings().plotSources.length === 0, '重新打开后剧情开关或来源有误');
      assert(field('personaPrompt').value === personaText && field('a.assistantSystemPrompt').value === systemText, '重新打开后丢失提示词');

      for (const id of [persona.id, persona.id === 'genki' ? 'reader' : 'genki']) {
        const before = mock.llmCalls.length;
        const reply = await agent.run('测试人格提示词', { persona: id, lite: true, remember: false });
        assert(!reply.error && mock.llmCalls.length === before + 1, '助手请求失败：' + reply.error);
        const system = mock.llmCalls[before][0].content;
        assert(system.includes(systemText), '该人格没有收到共用提示词：' + id);
        assert(system.includes(personaText) === (id === persona.id), '当前人格提示词的作用范围有误：' + id);
      }
    } finally {
      agent.saveSettings(previous);
      agent.close();
      agent.open('memory');
    }
  });

  await step('插件：读取作者文件、添加摘要函数、重新扫描并一起使用两份剧情记忆', async () => {
    const previous = agent.getSettings();
    window.SmokeNotes = { first: () => '灯塔改用蓝光', second: () => '学徒收到回信' };
    try {
      agent.open('settings');
      const mode = await until(() => $('#ra-plot-mode'), '选择剧情来源');
      await until(() => /broken-notes.*id/.test($('#ra-conn-problems').textContent), '首次扫描指出插件和出错字段');
      mode.value = 'manual';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      const draft = $('#ra-persona-prompt');
      draft.value = '未保存的人格草稿';
      $('#ra-conn-json').value = '未提交的另一个对接草稿';
      const manifest = { id: 'smoke_notes', title: '灯塔记录', detect: 'SmokeNotes.first', brief: 'SmokeNotes.first' };
      const files = new DataTransfer();
      files.items.add(new File([JSON.stringify(manifest)], 'connector.json', { type: 'application/json' }));
      $('#ra-conn-file').files = files.files;
      $('#ra-conn-file').dispatchEvent(new Event('change', { bubbles: true }));
      const first = await until(() => $('[data-plot-source][value="smoke_notes"]'), '从 JSON 导入摘要来源');
      first.click();
      $('[data-act="conn-goto-source"]').click();
      assert($('#ra-conn-source').open, '从剧情设置未能打开添加来源');
      $('#ra-source-name').value = '学徒笔记';
      $('#ra-source-method').value = 'window.SmokeNotes.second';
      $('[data-act="conn-source-add"]').click();
      const id = agent.scanConnectors().find((row) => row.title === '学徒笔记').id;
      const second = '[data-plot-source][value="' + id + '"]';
      $(second).click();
      $('[data-act="conn-scan"]').click();
      await until(() => /扫描完成/.test($('#ra-conn-note').textContent), '重新扫描');
      assert(/broken-notes.*id/.test($('#ra-conn-problems').textContent), '重新扫描后丢失无效对接的原因');
      const toggle = '[data-conn="smoke_notes"] [data-act="conn-toggle"]';
      $(toggle).click();
      assert(/未接入|停用/.test($('[data-plot-source][value="smoke_notes"]').closest('label').textContent), '已停用来源未标注状态');
      $('[data-plot-source][value="smoke_notes"]').click();
      $('[data-plot-connector="smoke_notes"] [data-act="conn-toggle"]').click();
      assert($('[data-plot-source][value="smoke_notes"]').checked && $(second).checked, '接入并选用应直接勾选该来源并保留其他多选');
      assert(draft === $('#ra-persona-prompt') && draft.value === '未保存的人格草稿' && $('#ra-conn-json').value === '未提交的另一个对接草稿', '插件操作覆盖了其他草稿');
      $('#reader-agent-overlay [data-act="save-settings"]').click();
      agent.close();
      agent.open('settings');
      assert($('[data-plot-source][value="smoke_notes"]').checked && $(second).checked, '重开丢失多选');
      const before = mock.llmCalls.length;
      await agent.run('你记得哪些事？', { lite: true, remember: false });
      const system = mock.llmCalls[before][0].content;
      assert(system.includes('灯塔改用蓝光') && system.includes('学徒收到回信'), '模型没有同时收到两份剧情');
    } finally {
      agent.saveSettings(previous);
      delete window.SmokeNotes;
      agent.close();
      agent.open('memory');
    }
  });

  await step('各挂载点可列出、角色卡可保存', async () => {
    const mounts = (await vfs.list('', {})).items.map((item) => item.name);
    const listed = [];
    for (const mount of mounts) {
      if (!withHelper && /^(script|preset):/.test(mount)) continue;   /* 这两个只有酒馆助手提供 */
      await vfs.list(mount, { limit: 5 });
      listed.push(mount);
    }
    await vfs.write('card:/description.md', '酒馆的老板娘，红发。', null);
    assert(mock.posts.some((post) => post.url === '/api/characters/merge-attributes' && post.body.description === '酒馆的老板娘，红发。'), '角色卡没有提交保存');
    assert(/已创建|reader_ii|\d/.test(await vfs.readText('page:/env.json')), 'page:/env.json 读取失败');
    assert((await vfs.grep('chat:/', '艾琳', {})).total >= 1, '聊天检索没有命中');
    return listed.join(' ');
  });

  await step('轻聊与关闭后再打开', async () => {
    agent.saveSettings({ lite: true });
    window.ReaderII.agent.close();
    assert(!$('#reader-agent-overlay').open, '面板没有关上');
    window.ReaderII.agent.open('chat');
    const before = mock.llmCalls.length;
    await ask('晚上好', ['晚上好，作家先生。']);
    assert(!/【核心工具】/.test(mock.llmCalls[before][0].content), '轻聊模式不该带工具');
    assert(/晚上好，作家先生/.test($('#ra-log').textContent), '没有显示回答');
    agent.saveSettings({ lite: false, mode: 'card' });
  });

  await step('设置页：只检查版本（本机当假远端）', async () => {
    $('#reader-agent-overlay [data-tab="settings"]').click();
    const box = await until(() => $('#ra-upd-remotes'), '更新源输入框');
    box.value = location.origin + '/';
    $('#reader-agent-overlay [data-act="upd-remotes"]').click();
    assert(window.ReaderII.updates.getSettings().remotes[0] === location.origin + '/', '更新源没有保存');
    $('#reader-agent-overlay [data-act="upd-check"]').click();
    const checked = await until(() => { const text = $('#ra-upd-out')?.textContent || ''; return /已是最新|检查失败|有新版本|还新/.test(text) && text; }, '检查更新的结果');
    assert(/已是最新/.test(checked), '本机与扩展是同一版本，应当显示已是最新：' + checked.slice(0, 160));
    assert(!document.querySelector('[data-act="upd-inspect"], [data-act="upd-apply"], #ra-upd-scope'), '仍有旧组件更新入口');
  });

  /* ---------- 联网、MCP、后端伴侣（交接 0.6 乙组）；假对端在 host.html 里 ---------- */
  await step('沙箱脚本不能联网（CSP + Worker）', async () => {
    $('#reader-agent-overlay [data-tab="chat"]').click();
    const before = mock.llmCalls.length;
    /* 本机的静态服务器是连得上的：没有 CSP 的话这个请求会成功。Worker 里没有 document。 */
    const target = location.origin + '/manifest.json';
    const code = `let net; try { await fetch(${JSON.stringify(target)}, { mode: 'no-cors' }); net = 'reached'; } catch (error) { net = 'blocked'; } return net + '/' + typeof document;`;
    await ask('再算一下', [call('run_js', { code }), '算完了。']);
    const feedback = mock.llmCalls[before + 1].at(-1).content;
    assert(/返回：blocked\/undefined/.test(feedback), feedback.slice(0, 300));
  });

  await step('联网：陌生主机先问，可按主机记住；网页转成正文并留在 web:/', async () => {
    const before = mock.llmCalls.length;
    mock.replies.push(call('web_fetch', { url: 'https://docs.smoke.test/page' }), '读完了。');
    const input = await until(() => $('#ra-text'), '输入框');
    input.value = '读一下那个页面';
    $('#ra-send').click();
    const card = await until(() => $('#ra-log .ra-confirm [data-answer="always"]')?.closest('.ra-confirm'), '确认卡');
    assert(/要向外面发请求/.test(card.textContent), '确认卡没有说明这是联网：' + card.textContent.slice(0, 80));
    assert(/本次对话都允许访问 docs\.smoke\.test/.test(card.textContent), '确认卡上没有按主机记住的按钮');
    card.querySelector('[data-answer="always"]').click();
    await until(() => !window.ReaderII.agent.isBusy(), '本轮结束', 15000);
    const feedback = mock.llmCalls[before + 1].at(-1).content;
    assert(/《冒烟文档》/.test(feedback) && /# 安装/.test(feedback), '网页没有转成正文：' + feedback.slice(0, 300));
    assert(/\[下载页\]\(https:\/\/docs\.smoke\.test\/dl\)/.test(feedback), '链接没有转成绝对地址：' + feedback.slice(0, 300));
    assert(/```\nnpm i reader\n```/.test(feedback), '代码块没有保留：' + feedback.slice(0, 300));
    assert(!/导航栏|页脚|injected/.test(feedback), '导航、页脚或脚本混进了正文');
    const cached = await vfs.list('web:/', {});
    assert(cached.items.length === 1 && mock.web.hits.length === 1, '缓存或请求次数不对');
    /* 同一主机第二次不再问。 */
    await ask('再读另一页', [call('web_fetch', { url: 'https://docs.smoke.test/other' }), '读完了。']);
    assert(mock.web.hits.length === 2, '第二次访问没有发出');
    assert(document.querySelectorAll('#ra-log .ra-confirm [data-answer]').length === 0, '同一主机又问了一次');
    return cached.items[0].name;
  });

  await step('GitHub：直达只读或推送授权页，粘贴后验证，错误令牌保留旧设置', async () => {
    $('#reader-agent-overlay [data-tab="settings"]').click();
    const card = await until(() => $('#ra-net-card'), '联网设置');
    const links = Array.from(card.querySelectorAll('a'), (link) => new URL(link.href));
    assert(links.length === 2 && links.every((url) => url.origin === 'https://github.com' && url.pathname === '/settings/personal-access-tokens/new'), '未直达细粒度令牌创建页');
    assert(links.map((url) => url.searchParams.get('contents')).join(',') === 'read,write', '未按用途预填仓库权限');
    const paste = (value) => {
      const input = $('#ra-net-token');
      input.value = value;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    };
    const token = () => JSON.parse(localStorage.getItem('reader_ii_secrets_v1') || '{}')['github.token'];
    const hosts = $('#ra-net-hosts');
    hosts.value += '\nsmoke.example.com';
    paste('smoke-valid-token');
    await until(() => /已验证并保存.*smoke-reader/.test($('#ra-github-note')?.textContent || ''), '显示 GitHub 账号');
    assert(token() === 'smoke-valid-token' && $('#ra-net-token').value === '', '验证成功后没有保存或清空输入框');
    paste('smoke-invalid-token');
    await until(() => $('#ra-github-note')?.classList.contains('is-bad'), '无效令牌提示');
    $('#ra-net-card [data-act="net-save"]').click();
    assert(token() === 'smoke-valid-token', '无效令牌替换了旧令牌');
    assert(agent.getSettings().web.allowHosts.includes('smoke.example.com'), '验证令牌时丢掉了待保存的网站设置');
    assert(!JSON.stringify(window.SillyTavern.getContext().extensionSettings).includes('smoke-valid-token'), 'GitHub 令牌进了酒馆设置');
    const clear = $('#ra-net-card [data-act="net-token-clear"]');
    clear.click(); clear.click();
    assert(!token(), '本机令牌未清除');
  });

  await step('TauriTavern MCP：设置页自动列出服务，选中一项后才读取工具', async () => {
    const discovered = [];
    let offline = true;
    const id = '12345678-0000-4000-8000-000000000abc';
    window.__TAURITAVERN__ = { api: { mcp: { servers: {
      list: async () => {
        if (offline) throw new Error('酒馆服务暂时离线');
        return { servers: [{ id, displayName: '天气工具', state: 'active', toolPermissions: { forecast: 'ask' } }] };
      },
      discover: async key => {
        discovered.push(key);
        return { tools: [{ nativeName: 'forecast', permission: 'ask', inputSchema: { type: 'object' } }] };
      },
    }, tools: { testCall: () => { throw new Error('设置页不应执行工具'); } } } } };
    try {
      $('#reader-agent-overlay [data-tab="chat"]').click();
      $('#reader-agent-overlay [data-tab="settings"]').click();
      const row = '#ra-mcp [data-mcp="' + id + '"]';
      await until(() => $('#ra-mcp-tt')?.textContent.includes('酒馆服务暂时离线'), '自动扫描显示宿主读取失败原因');
      offline = false;
      $('#ra-mcp-tt [data-act="mcp-tt-scan"]').click();
      const connect = await until(() => $(row + ' [data-act="mcp-tt-connect"]'), '重新读取后发现天气工具');
      assert(!$('#ra-mcp-tt').textContent.includes('读取失败'), '重试成功后仍然提示读取失败');
      assert(discovered.length === 0 && !$('#ra-mcp-manual').open, '扫描时自动接入服务或打开手动配置');
      connect.click();
      const disable = await until(() => $(row + ' [data-act="mcp-tt-remove"]'), '完成接入');
      assert(discovered.join() === id && /forecast/.test($(row).textContent), '没有显示所选服务的工具');
      disable.click();
      await until(() => !$(row + ' [data-act="mcp-tt-remove"]'), '助手停用工具箱');
      assert($(row + ' [data-act="mcp-tt-connect"]'), '停用影响了宿主的登记');
    } finally { delete window.__TAURITAVERN__; }
  });

  await step('MCP：粘贴 JSON 添加服务器 → 工具箱 → 调用 → 删除（密钥不进酒馆设置）', async () => {
    $('#reader-agent-overlay [data-tab="settings"]').click();
    const box = await until(() => $('#ra-mcp-json'), 'MCP 输入框');
    $('#ra-mcp-manual summary').click();
    assert($('#ra-mcp-manual').open && box.offsetHeight > 0, '手动 MCP 导入没有展开');
    assert($('#ra-net-card') && $('#ra-comp-card'), '设置页缺少「联网」或「后端伴侣」卡');
    assert(!/undefined|\[object /.test($('#reader-agent-overlay [data-pane="settings"]').textContent), '设置页文字里出现了 undefined');
    box.value = JSON.stringify({ mcpServers: { smoke: { url: 'https://mcp.smoke.test/mcp', headers: { Authorization: 'Bearer s3cret-smoke' } } } });
    $('#reader-agent-overlay [data-act="mcp-add"]').click();
    await until(() => /2 个工具/.test($('#ra-mcp')?.textContent || ''), 'MCP 工具目录', 10000);
    assert(/已添加，2 个工具/.test($('#ra-mcp-note')?.textContent || ''), '没有显示添加结果：' + ($('#ra-mcp-note')?.textContent || ''));
    assert(mock.mcp.seen[0].auth === 'Bearer s3cret-smoke', '请求头没有带上密钥');
    assert(mock.mcp.seen.at(-1).session === 'smoke-session', '后续请求没有带会话标识');
    const settingsText = JSON.stringify(window.SillyTavern.getContext().extensionSettings);
    assert(!settingsText.includes('s3cret-smoke') && /"smoke"/.test(settingsText), '密钥进了酒馆设置，或服务器没有保存');
    assert((localStorage.getItem('reader_ii_secrets_v1') || '').includes('s3cret-smoke'), '密钥没有存到本机');
    assert(agent.listToolsets().some((set) => set.name === 'mcp/smoke'), '没有登记成工具箱');
    $('#reader-agent-overlay [data-tab="chat"]').click();
    const before = mock.llmCalls.length;
    await ask('用一下那个工具', [call('mcp_smoke_echo', { text: '夜梦' }), '调用完了。'], 'allow');
    const feedback = mock.llmCalls[before + 1].at(-1).content;
    assert(/echo: \{"text":"夜梦"\}/.test(feedback), feedback.slice(0, 300));
    assert(/- mcp\/smoke：/.test(mock.llmCalls[before][0].content), '工具箱目录里没有这个服务器');
    $('#reader-agent-overlay [data-tab="settings"]').click();
    (await until(() => $('#ra-mcp [data-mcp="smoke"] [data-act="mcp-del"]'), '删除按钮')).click();
    (await until(() => $('#ra-mcp [data-mcp="smoke"] [data-act="mcp-del"][data-armed="1"]'), '二次确认')).click();
    await until(() => !$('#ra-mcp [data-mcp="smoke"]'), '服务器从列表里消失');
    assert(!agent.listToolsets().some((set) => set.name === 'mcp/smoke') && agent.getSettings().mcp.servers.length === 0, '删除后还留着');
    assert(!(localStorage.getItem('reader_ii_secrets_v1') || '').includes('s3cret-smoke'), '删除后密钥还在本机');
  });

  await step('后端伴侣：没装时如实显示；配对放行；设备上的确认只认真人点击；断开', async () => {
    $('#reader-agent-overlay [data-tab="settings"]').click();
    const download = await until(() => $('#ra-comp-card a[download="reader-ii-companion.zip"]'), '伴侣安装包下载');
    const packageResponse = await fetch(download.href);
    const bytes = new Uint8Array(await packageResponse.arrayBuffer());
    assert(packageResponse.ok && bytes[0] === 80 && bytes[1] === 75, '安装包不是可下载的 ZIP');
    assert($('#ra-comp-card').textContent.includes('setup.mjs uninstall'), '缺少原生卸载命令');
    (await until(() => $('#reader-agent-overlay [data-act="comp-check"]'), '检测按钮')).click();
    await until(() => /没有检测到后端伴侣/.test($('#ra-comp-card')?.textContent || ''), '未检测到的提示');
    assert(/没有连接后端伴侣/.test((await vfs.list('dev:/', {})).items[0].name), 'dev:/ 没有给出说明');
    assert(!$('#reader-agent-overlay [data-act="comp-pair"]'), '没检测到伴侣时不该有申请放行的按钮');

    mock.companion.present = true;
    $('#reader-agent-overlay [data-act="comp-check"]').click();
    const pairButton = await until(() => $('#reader-agent-overlay [data-act="comp-pair"]'), '申请放行按钮');
    assert(/已检测到伴侣/.test($('#ra-comp-state').textContent), '状态行不对：' + $('#ra-comp-state').textContent);
    pairButton.click();
    await until(() => ($('#ra-comp-code')?.textContent || '') === '4821', '配对码');
    await until(() => /已连接并放行/.test($('#ra-comp-state')?.textContent || ''), '放行后的状态', 8000);
    assert(window.ReaderII.companion.ready(), '伴侣没有就绪');
    assert(!JSON.stringify(window.SillyTavern.getContext().extensionSettings).includes(mock.companion.token), '伴侣令牌进了酒馆设置');
    assert((await vfs.readText('dev:/~/a.txt')) === '设备上的文件\n', '读不到设备上的文件');

    /* 设备上的操作：脚本模拟的点击不能点「允许」。 */
    agent.saveSettings({ mode: 'device' });
    $('#reader-agent-overlay [data-tab="chat"]').click();
    mock.replies.push(call('device_exec', { command: 'echo hi' }), '你没有同意。');
    const input = await until(() => $('#ra-text'), '输入框');
    input.value = '跑一条命令';
    $('#ra-send').click();
    const allow = await until(() => $('#ra-log .ra-confirm [data-answer="allow"]'), '确认卡');
    assert(/在你的设备上/.test(allow.closest('.ra-confirm').textContent), '确认卡没有标明是设备上的操作');
    allow.click();
    await sleep(300);
    assert(window.ReaderII.agent.isBusy() && !mock.companion.ops.some((item) => item.op === 'exec'), '模拟的点击竟然放行了设备上的命令');
    $('#ra-log .ra-confirm [data-answer="deny"]').click();
    await until(() => !window.ReaderII.agent.isBusy(), '本轮结束', 15000);
    assert(!mock.companion.ops.some((item) => item.op === 'exec'), '被拒绝的命令还是执行了');

    $('#reader-agent-overlay [data-tab="settings"]').click();
    (await until(() => $('#reader-agent-overlay [data-act="comp-release"]'), '断开按钮')).click();
    await until(() => /还没放行/.test($('#ra-comp-state')?.textContent || ''), '断开后的状态');
    assert(!(localStorage.getItem('reader_ii_secrets_v1') || '').includes(mock.companion.token), '断开后令牌还在本机');
    agent.saveSettings({ mode: 'card' });
    mock.companion.present = false;
  });

  await step('全程没有新的报错', async () => {
    const errors = (window.__readerIIProbe && window.__readerIIProbe.errors || []).map((item) => item.text);
    assert(errors.length === 0, errors.join(' | ').slice(0, 400));
  });

  const failed = report();
  document.title = failed.length ? `SMOKE FAIL ${failed.length}/${results.length}` : `SMOKE PASS ${results.length}/${results.length}`;
  logNode.insertAdjacentHTML('afterbegin', `<b class="${failed.length ? 'fail' : 'pass'}">${document.title}</b>\n`);
}

if (params.get('auto') === '1') main();
