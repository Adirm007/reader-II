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

  /* ---------- 分卷导演：导演页、状态浮窗、导演模型与简报位置 ---------- */
  const director = window.ReaderII.director;
  const dirOutline = ['### 板块 A：全景勘察与卷核定性', '旧港的雨季，酒馆里来了修钟的人。', '### 板块 B：核心人物与独立关系网', '- [既有] 艾琳：酒馆老板娘，嘴硬心软。',
    '### 板块 C：后台实情与客观时钟', '**后台完整实情**：灯塔的旧账本被藏在了钟楼的夹层里。', '**客观推进时钟**：第三天傍晚港务司来清点库房。',
    '### 板块 D：分阶段动态推演', '#### Phase 1：雨夜来客', '新看守冒雨来打听修钟的人。', '#### Phase 2：钟楼的夹层', '上钟楼校时。', '#### Phase 3：清点之日', '账本的去向摆上桌面。',
    '### 板块 E：收束形态与跨卷钩子库', '钩子：一只怀表。'].join('\n');
  const dirBrief = (tag) => ['【当前阶段与承接】' + tag + '。{{user}}刚在酒馆坐下。', '【在场角色状态与情绪动因】艾琳照常擦杯子，心底还压着对旧钟的牵挂。', '【人物火花与本轮暗压】座钟慢了七分钟。',
    '【情绪节奏与交互留白】不要快进到钟楼；把选择留给玩家。', '【本轮忌口】禁止替玩家做决定。'].join('\n');
  const dirDelivery = '<self_check>\n1. 通过\n</self_check>\n<volume_outline>\n' + dirOutline + '\n</volume_outline>\n<volume_index>\n'
    + JSON.stringify({ title: '雨季的钟', phases: [{ n: 1, title: '雨夜来客' }, { n: 2, title: '钟楼的夹层' }, { n: 3, title: '清点之日' }], new_characters: [] })
    + '\n</volume_index>\n<first_brief>\n' + dirBrief('Phase 1 · 雨夜') + '\n</first_brief>';
  const floatNode = () => $('#reader-agent-float');

  await step('导演页：开卷单会话编纲，交代的话进首个编纲请求；状态浮窗随助手窗口的开关换停靠位', async () => {
    mock.replies.length = 0;
    /* 两种模式共用同一个浏览器档案：上一种模式留下的分卷还在工作区里（档案是持久的），先清掉再从头演。 */
    await director.ready();
    if (director.getStatus().volume) await director.discardVolume();
    if (director.getStatus().plan) await director.discardDraft();
    agent.open('chat');
    $('#reader-agent-overlay [data-tab="director"]').click();
    await until(() => $('#rd-status-card') && $('#rd-flow-card') && $('#rd-config-card') && $('[data-act="dir-activate"]'), '导演页的几块内容');
    assert(/空闲/.test($('#rd-status-card').textContent), '还没开卷时应显示空闲');
    /* 配置里是两块各自独立的 Skill 编辑区：总导演与场记各有来源、路径与一套按钮，内容互不相同。 */
    await until(() => ($('#rd-skill-planner')?.value || '').includes('## 阶段一：全景勘察') && ($('#rd-skill-patrol')?.value || '').includes('## 三级偏移判定'), '两份 Skill 编辑器载入各自的内置正文');
    assert(!$('#rd-skill') && !/三级偏移判定/.test($('#rd-skill-planner').value) && !/全景勘察/.test($('#rd-skill-patrol').value), '两份 Skill 不该混在一个编辑器里');
    for (const role of ['planner', 'patrol']) {
      const box = $('#rd-cfg-skill-' + role);
      assert(/内置默认/.test(box.querySelector('.rd-skill-head')?.textContent || '') && box.textContent.includes('ws:/skills/director-' + role + '/SKILL.md'), role + ' 的 Skill 应标明生效来源与路径');
      for (const act of ['dir-skill-save', 'dir-skill-reset', 'dir-skill-export', 'dir-skill-import']) {
        assert(box.querySelector('[data-act="' + act + '"][data-skill="' + role + '"]'), role + ' 的 Skill 缺少按钮 ' + act);
      }
      assert(box.querySelector('[data-act="dir-skill-reset"]').disabled, '还是内置默认时「恢复内置默认」应是灰的');
    }
    assert(!/七个二级标题|缺的段已用内置/.test($('#rd-config-card').textContent), '配置里不该再有标题切片与缺段降级的提示');
    /* 只改场记那一份并保存：总导演编辑框里没保存的字、它的来源都不受影响；再把场记恢复成内置。 */
    const plannerBox = $('#rd-skill-planner'), patrolBox = $('#rd-skill-patrol');
    plannerBox.value += '\n（总导演这边打到一半、还没保存的字）';
    plannerBox.dispatchEvent(new Event('input', { bubbles: true }));
    patrolBox.value = '我的巡检规矩：只看最新两楼。';
    patrolBox.dispatchEvent(new Event('input', { bubbles: true }));
    $('[data-act="dir-skill-save"][data-skill="patrol"]').click();
    await until(() => /工作区自定义/.test($('#rd-cfg-skill-patrol .rd-skill-head')?.textContent || ''), '场记 Skill 保存后标成工作区自定义');
    assert((await director.getSkill('patrol')).text === '我的巡检规矩：只看最新两楼。' && (await director.getSkill('planner')).source === 'builtin', '只该存下场记那一份');
    assert($('#rd-skill-planner').value.endsWith('（总导演这边打到一半、还没保存的字）') && /内置默认/.test($('#rd-cfg-skill-planner .rd-skill-head').textContent), '保存场记不该冲掉总导演编辑框里没保存的字');
    const resetPatrol = $('[data-act="dir-skill-reset"][data-skill="patrol"]');
    resetPatrol.click();
    assert(resetPatrol.getAttribute('data-armed') === '1' && $('[data-act="dir-skill-reset"][data-skill="planner"]').getAttribute('data-armed') !== '1', '恢复默认的确认只该落在点的那一份上');
    $('[data-act="dir-skill-reset"][data-skill="patrol"]').click();
    await until(() => ($('#rd-skill-patrol')?.value || '').includes('## 三级偏移判定') && /内置默认/.test($('#rd-cfg-skill-patrol .rd-skill-head')?.textContent || ''), '场记 Skill 恢复成内置');
    assert($('#rd-skill-planner').value.endsWith('（总导演这边打到一半、还没保存的字）'), '恢复场记也不该动总导演的编辑框');
    $('#rd-skill-planner').value = (await director.getSkill('planner')).text;
    assert(!/undefined|\[object /.test($('[data-pane="director"]').textContent), '导演页文字里出现了 undefined');

    /*
     * 单会话编纲：先在本地建图（不调模型），再在同一个只读 Agent 会话里边查资料边写。
     * 假模型第一轮用 read 查一条世界书，第二轮交付四段标签；第二轮先停在闸门上，好在编纲途中看浮窗。
     * 闸门在 finally 里放开：中途哪条断言没过，编纲也照样定稿，不会把后面的导演步骤一起拖死。
     */
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const before = mock.llmCalls.length;
    mock.replies.push(call('read', { path: 'wb:/设定集/王都' }), async () => { await gate; return dirDelivery; });
    try {
      $('#rd-say-text').value = '这一卷不要阴谋';
      $('[data-act="dir-activate"]').click();
      /* 编纲中：工作流卡是只读 Agent 的工作态（当前动作 + 指标徽章 + 活动条），没有「4 步」的步骤条。 */
      await until(() => /编纲中/.test($('#rd-status-card')?.textContent || '') && $('#rd-flow-card .rd-agent[data-kind="plan"][data-state="running"]'), '编纲中的工作态');
      assert(!$('#rd-flow-card .rd-track'), '工作流卡里不该再有步骤条');
      const sayBox = $('#rd-say-text');
      sayBox.value = '打到一半的插话';
      /* 建图不调模型：等第一个编纲请求真的发出去，再看交代的话在不在里面。 */
      const first = await until(() => mock.llmCalls[before], '第一个编纲请求', 15000);
      assert(/总导演/.test(String(first[0] && first[0].content)), '第一个模型请求不是总导演的编纲请求');
      assert(first.some((message) => message.role === 'user' && /【用户意见[\s\S]*这一卷不要阴谋/.test(String(message.content))), '开卷前交代的话没有带进第一个编纲请求');
      const second = await until(() => mock.llmCalls[before + 1], '带着查阅结果的第二个编纲请求', 15000);
      assert(second.some((message) => message.role === 'user' && /<action_result name="read" status="ok">[\s\S]*王都位于北方/.test(String(message.content))), '只读查阅的结果没有交回编纲会话');
      /* 查完一轮资料、第二个请求在途：摘要行写着此刻的动作，徽章是真实的指标，活动条在走，日志里是查阅的过程。 */
      await until(() => /自主查阅与编纲中/.test($('#rd-flow-card .rd-agent-label')?.textContent || '') && /已查阅 1 项资料/.test($('#rd-flow-card .rd-agent-stats')?.textContent || ''), '工作态摘要跟上了查阅');
      const stats = $('#rd-flow-card .rd-agent-stats').textContent;
      assert(/工具 1 轮/.test(stats) && /断点已保存/.test(stats) && !/自动重写/.test(stats), '指标徽章不对：' + stats);
      assert(!$('#rd-flow-bar').hidden && getComputedStyle($('#rd-flow-bar')).display !== 'none', '有活在跑时活动条应显示');
      assert(/导演 · 编纲 · 自主查阅与编纲（已查 1 项资料）/.test($('#rd-live').textContent) && /查阅世界书 wb:\/设定集\/王都/.test($('#rd-live').textContent), '实时日志应写着当前动作与查阅过程：' + $('#rd-live').textContent.slice(0, 160));
      assert(!/\d\s*\/\s*4/.test($('#rd-flow-card').textContent), '工作流卡里不该再出现「几/4」的步数');
      /* 页面被事件驱动着重画了好几轮：插话框还是同一个节点，里面打到一半的字还在。 */
      assert($('#rd-say-text') === sayBox && sayBox.value === '打到一半的插话', '插话框在重画中被重建了，或者打到一半的字丢了');
      sayBox.value = '';
      await sleep(80);
      assert(!floatNode()?.isConnected, '助手窗口停在导演页时不该再摆一个浮窗');

      /* 换到别的页：浮窗收进窗口，成为标题栏下面的一条。 */
      $('#reader-agent-overlay [data-tab="chat"]').click();
      const docked = await until(() => (floatNode()?.dataset.dock === 'dialog' && floatNode().parentElement === $('#reader-agent-overlay .ra-shell') ? floatNode() : null), '浮窗停靠在窗口里');
      assert(docked.previousElementSibling === $('#reader-agent-overlay .ra-head'), '窗口里的浮窗应紧跟在标题栏后面');
      /* 浮窗写着此刻的动作；编纲没有固定步数，所以没有「2/4」，进度条是循环的脉冲条。 */
      await until(() => /导演 · 编纲/.test(docked.textContent) && /自主查阅与编纲（已查 1 项资料）/.test(docked.textContent), '浮窗显示编纲此刻的动作', 3000);
      assert(!docked.querySelector('.rf-step') && docked.querySelector('.rf-bar.is-loop'), '编纲的浮窗不该有步数，进度条应是循环脉冲条');
      assert(docked.dataset.theme === $('#reader-agent-overlay').dataset.theme, '浮窗的主题应与助手窗口一致');

      /*
       * 关掉窗口：浮窗回到酒馆页面上，能展开、能点。
       * <dialog> 的 close 事件是异步派发的，助手在它的处理函数里收起导演页（ui.js）。先等它派发完，再用「查看」重开：
       * 晚到的 close 落在重开之后，会把刚显示的导演页收起来，页面不再跟着导演更新，定稿后状态卡一直停在「编纲中」。
       */
      let closeEvent = false;
      $('#reader-agent-overlay').addEventListener('close', () => { closeEvent = true; }, { once: true });
      agent.close();
      await until(() => closeEvent, '助手窗口的 close 事件');
      const floating = await until(() => (floatNode()?.dataset.dock === 'page' && floatNode().parentElement === document.body ? floatNode() : null), '浮窗回到页面上');
      assert(getComputedStyle(floating).position === 'fixed' && floating.getBoundingClientRect().width > 120, '页面上的浮窗应固定在角落');
      floating.querySelector('[data-rf="toggle"]').click();
      await until(() => floatNode().querySelector('[data-rf="open"]') && floatNode().querySelector('[data-rf="cancel"]'), '展开后的「查看」与「停止」');
      const lines = floatNode().querySelector('.rf-lines')?.textContent || '';
      assert(/开局轻索引地图/.test(lines) && /查阅世界书 wb:\/设定集\/王都（\d+ 字）/.test(lines), '展开后应有建图与查阅的过程日志：' + lines.slice(0, 160));
      floatNode().querySelector('[data-rf="open"]').click();
      await until(() => $('#reader-agent-overlay')?.open && $('.ra-pane[data-pane="director"].is-on'), '「查看」跳到导演页');
    } finally { release(); }

    await until(() => /执导中/.test($('#rd-status-card')?.textContent || ''), '定稿后进入执导', 15000);
    /* 执导中的状态卡照旧画大纲的 Phase 进度条（剧情分幕）；工作流卡里的 Agent 工作态与活动条收起。 */
    assert($('#rd-status-card .rd-track li[data-on="now"]')?.textContent.includes('雨夜来客'), '阶段进度条没有标出当前阶段');
    assert($('#rd-status-card .rd-track').querySelectorAll('li').length === 3, '大纲有三个 Phase，进度条应有三格');
    await until(() => !$('#rd-flow-card .rd-agent') && $('#rd-flow-bar').hidden, '定稿后工作态与活动条收起');
    await until(() => ($('#rd-brief')?.value || '').includes('Phase 1 · 雨夜。我刚在酒馆坐下'), '首轮简报（主角名已换成实名）');
    assert(director.injectable() && (await director.briefFor('normal')).includes('我刚在酒馆坐下'), '导演应当可以注入简报');
    return '第 ' + director.getStatus().volume.no + ' 卷《' + director.getStatus().volume.title + '》';
  });

  await step('导演页：后台巡检更新简报；设置页有导演模型与简报位置；完结归档后可恢复', async () => {
    /*
     * 关窗后马上重开（不等 close 事件）：close 是异步派发的，会在窗口又开着时才到。
     * 晚到的 close 不能把刚显示的导演页收起来——下面巡检出的新简报照样要刷到页面上。
     */
    agent.close();
    agent.open('director');
    await sleep(80);
    assert($('#reader-agent-overlay')?.open && $('.ra-pane[data-pane="director"].is-on'), '关窗后马上重开，应停在导演页');
    assert(!(floatNode()?.isConnected && floatNode().parentElement === document.body), '窗口开着时浮窗不该搬回酒馆页面上');
    mock.replies.length = 0;
    mock.replies.push(JSON.stringify({ drift_level: 1, reason: '换了路', phase_cursor: 2, state_delta: '绕到了钟楼后面', facts_add: ['没走正门'], local_patch: '艾琳改从后门送人',
      next_brief: dirBrief('第二轮'), volume_completed: false }));
    mock.chat.push({ name: '我', is_user: true, mes: '我绕到钟楼后面。' }, { name: '艾琳', is_user: false, mes: '后门的锁早就锈死了。' });
    await window.SillyTavern.getContext().eventSource.emit('generation_ended');
    await until(() => ($('#rd-brief')?.value || '').includes('第二轮。我刚在酒馆坐下'), '巡检后的新简报', 12000);
    const statusText = $('#rd-status-card').textContent;
    assert(/L1 局部绕道/.test(statusText) && /Phase 2 \/ 3/.test(statusText) && /绕到了钟楼后面/.test(statusText), '状态没有跟上巡检：' + statusText.slice(0, 160));

    /* 手改简报：保存时照样净化（主角名、宏）。 */
    const briefBox = $('#rd-brief');
    briefBox.value = '【当前阶段与承接】{{user}}站在钟楼下。{{getvar::x}}';
    briefBox.dispatchEvent(new Event('input', { bubbles: true }));
    $('[data-act="dir-brief-save"]').click();
    await until(() => $('#rd-brief')?.value === '【当前阶段与承接】我站在钟楼下。｛｛getvar::x｝｝', '保存后的简报已净化');
    /* 配置：改一项并保存。 */
    const every = $('[data-d="cfg.patrolEvery"]');
    every.value = '2';
    every.dispatchEvent(new Event('input', { bubbles: true }));
    $('[data-act="dir-config-save"]').click();
    await until(() => director.getSettings().patrolEvery === 2, '配置已保存');
    director.saveSettings({ patrolEvery: 1 });

    /* 设置页：导演模型（总导演 / 场记）与简报的注入位置。 */
    $('#reader-agent-overlay [data-tab="settings"]').click();
    await until(() => $('#ra-director-model-card [data-editor="director"]') && $('#ra-director-model-card [data-editor="director_judge"]'), '导演模型卡片');
    assert($('[data-placement-section="director"] [data-s="p.director.enabled"]'), '正文提示词位置里应有导演简报这一槽');
    assert($('.ra-toc [data-target="ra-director-model-card"]'), '设置目录里应有导演模型');
    const judgeBox = $('#ra-director-model-card [data-editor="director_judge"]');
    judgeBox.querySelector('[data-model-name]').value = 'cheap-model';
    judgeBox.querySelector('[data-director-effort]').value = 'low';
    judgeBox.querySelector('[data-act="models-director-save"]').click();
    const saved = window.ReaderII.llm.getTaskConnection('director_judge');
    assert(saved.model === 'cheap-model' && saved.effort === 'low' && saved.selected === 'director', '场记的模型设置没有保存');
    judgeBox.querySelector('[data-model-name]').value = '';
    judgeBox.querySelector('[data-director-effort]').value = 'auto';
    judgeBox.querySelector('[data-act="models-director-save"]').click();
    assert(window.ReaderII.llm.getTaskConnection('director_judge').model === '', '场记的模型设置没有还原');

    /* 完结本卷 → 归档 → 恢复。 */
    $('#reader-agent-overlay [data-tab="director"]').click();
    (await until(() => $('[data-act="dir-finish-ask"]:not(:disabled)'), '完结按钮')).click();
    mock.replies.push(JSON.stringify({ title: '雨季的钟', summary: '账本的去向摆上了桌面。', hooks: ['一只怀表'], entries: [] }));
    (await until(() => $('[data-act="dir-finish"]:not(:disabled)'), '确认完结')).click();
    await until(() => /空闲/.test($('#rd-status-card')?.textContent || '') && $('[data-act="dir-restore"]'), '归档后回到空闲', 15000);
    assert(!director.injectable(), '归档之后不该再注入');
    await until(() => /账本的去向摆上了桌面/.test($('#rd-docs-card')?.textContent || ''), '档案列在「已完结的卷」里');
    $('[data-act="dir-restore"]').click();
    assert($('[data-act="dir-restore"]').getAttribute('data-armed') === '1', '危险的按钮应先进入确认态');
    $('[data-act="dir-restore"]').click();
    await until(() => /执导中/.test($('#rd-status-card')?.textContent || ''), '恢复上一卷');
    assert(director.injectable(), '恢复之后应当可以注入');
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
