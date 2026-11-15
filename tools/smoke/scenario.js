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
  const input = await until(() => $('#ra-text'), '输入框');
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

  await step('启动期间没有报错', async () => {
    const errors = (window.__readerIIProbe && window.__readerIIProbe.errors || []).map((item) => item.text);
    assert(errors.length === 0, errors.join(' | ').slice(0, 300));
  });

  await step('记忆不在无关聊天里自动注入', async () => {
    /* 假酒馆的聊天没有 Reader-II 卡内组件的痕迹：默认范围下不该有记忆注入，也不该为整理而调用模型。 */
    await sleep(200);
    const injected = mock.prompts['reader-ii-memory'];
    assert(!injected || !(injected.text || injected.content), '在没用 Reader-II 的聊天里注入了记忆');
    assert(mock.llmCalls.length === 0, '启动后就调用了模型');
    assert(window.ReaderII.memory.getSettings().scope === 'reader', '记忆范围的默认值不对');
  });

  await step('扩展菜单入口与 /yume 命令', async () => {
    await until(() => $('#reader-ii-menu'), '菜单入口');
    assert(mock.slash.some((command) => command.name === 'yume'), '没有注册 /yume');
  });

  await step('点菜单打开面板（<dialog> 顶层）', async () => {
    $('#reader-ii-menu').click();
    const overlay = await until(() => $('#reader-agent-overlay'), '面板');
    assert(overlay.open, '面板没有处于打开状态');
    assert($('#ra-text') && $('#ra-send'), '缺少输入框或发送按钮');
    const rect = overlay.getBoundingClientRect();
    assert(rect.width > 200 && rect.height > 200, `面板尺寸异常 ${rect.width}x${rect.height}`);
    assert(!/undefined|\[object /.test(overlay.textContent), '面板文字里出现了 undefined：' + ($('#ra-foot-text')?.textContent || ''));
    assert(/权限：单卡/.test($('#ra-foot-text').textContent), '底栏没有显示权限档位');
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
    await ask('把王都人口改成三十万', [
      '我先看看这个条目。\n' + call('read', { path: 'wb:/设定集/王都' }),
      call('edit', { path: 'wb:/设定集/王都', old: '人口十万', new: '人口三十万' }),
      '已经把王都的人口改成三十万了。',
    ], 'allow');
    assert(/人口三十万/.test(capital()), '世界书没有被修改：' + capital());
    assert(/已经把王都的人口改成三十万了/.test($('#ra-log').textContent), '面板里没有出现最终回答');
    assert(/【核心工具】/.test(mock.llmCalls[0][0].content), '系统提示词里没有核心工具');
  });

  await step('对话：确认卡点「拒绝」不会写入', async () => {
    await ask('再改成一万', [call('edit', { path: 'wb:/设定集/王都', old: '人口三十万', new: '人口一万' }), '你没有同意，我没有改。'], 'deny');
    assert(/人口三十万/.test(capital()), '被拒绝的修改还是写进去了');
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
    $('#reader-agent-overlay [data-act="save-settings"]').click();
    await sleep(80);
    assert(agent.getSettings().mode === 'tavern', '保存后档位没变');
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

  await step('设置页：检查更新与卡内组件（本机当假远端）', async () => {
    $('#reader-agent-overlay [data-tab="settings"]').click();
    const box = await until(() => $('#ra-upd-remotes'), '更新源输入框');
    box.value = location.origin + '/';
    $('#reader-agent-overlay [data-act="upd-remotes"]').click();
    assert(window.ReaderII.updates.getSettings().remotes[0] === location.origin + '/', '更新源没有保存');
    $('#reader-agent-overlay [data-act="upd-check"]').click();
    const checked = await until(() => { const text = $('#ra-upd-out')?.textContent || ''; return /已是最新|检查失败|有新版本|还新/.test(text) && text; }, '检查更新的结果');
    assert(/已是最新/.test(checked), '本机与扩展是同一版本，应当显示已是最新：' + checked.slice(0, 160));
    $('#reader-agent-overlay [data-act="upd-inspect"]').click();
    const listed = await until(() => { const text = $('#ra-upd-out')?.textContent || ''; return /全部校验通过|失败/.test(text) && text; }, '卡内组件清单', 20000);
    assert(/全部校验通过/.test(listed) && /主脚本/.test(listed) && /世界书/.test(listed) && /正则/.test(listed), '卡内组件清单不对：' + listed.slice(0, 200));
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
