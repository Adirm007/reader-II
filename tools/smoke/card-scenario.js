/*
 * ② 卡内组件的冒烟场景（card.html?auto=1 时自动运行）。尽量走真实的路径：点脚本按钮、点大厅与彩蛋页的入口、在面板里打字点按钮。
 * 每一步一行 PASS / FAIL，最后把总评写进标题（SMOKE PASS n/n 或 SMOKE FAIL m/n）。
 *   ext=1（默认）：扩展 ① 也装着。第一阶段跑完整场景，然后刷新页面进第二阶段（phase=2），查刷新后的本机存储与 IndexedDB。
 *   ext=0：没装扩展，② 从 CDN 拉 ①；命令行冒烟里用局域网地址打开（非安全上下文），顺带查 SHA-256 垫片。
 * 命令行：node tools/smoke/run.mjs card。页面里（含所有 iframe）的异常与 console.error 由运行器经调试协议收集。
 */
const params = new URLSearchParams(location.search);
const mock = window.__mock;
const withExtension = mock.withExtension;
const phase = params.get('phase') === '2' ? 2 : 1;
const STORE = 'reader-ii-card-smoke';
const results = phase === 2 ? JSON.parse(sessionStorage.getItem(STORE) || '[]') : [];
const logNode = document.getElementById('smoke-log');
const MARK = 'reader_ii_local_keys_migrated_v1';
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const started = Date.now();
  let last = null;
  for (;;) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    if (Date.now() - started > timeout) throw new Error(`等待超时：${label}${last ? '（' + (last.message || last) + '）' : ''}`);
    await sleep(50);
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
const $ = (selector, root = document) => root.querySelector(selector);
const call = (name, args) => `<tool_call name="${name}">\n${Object.entries(args).map(([key, value]) => `<arg name="${key}">${value}</arg>`).join('\n')}\n</tool_call>`;

function report() {
  const failed = results.filter((item) => !item.ok);
  const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  logNode.innerHTML = results.map((item) => `<span class="${item.ok ? 'pass' : 'fail'}">${item.ok ? 'PASS' : 'FAIL'}  ${esc(item.name)}${item.detail ? '  — ' + esc(item.detail) : ''}</span>`).join('\n');
  return failed;
}
async function step(name, body) {
  try {
    const detail = await body();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error && error.message || error) });
  }
  report();
}
function finish() {
  const failed = report();
  document.title = failed.length ? `SMOKE FAIL ${failed.length}/${results.length}` : `SMOKE PASS ${results.length}/${results.length}`;
  logNode.insertAdjacentHTML('afterbegin', `<b class="${failed.length ? 'fail' : 'pass'}">${document.title}</b>\n`);
  try { sessionStorage.removeItem(STORE); } catch (error) { /* ignore */ }
}

/* ---------- 取各个窗口 ---------- */
const scriptWin = () => mock.scriptFrame && mock.scriptFrame.contentWindow;
const controllerFrame = () => document.getElementById('reader-ii-controller');
const ctl = () => { const frame = controllerFrame(); return frame && frame.contentWindow; };
const shell = () => window.ReaderShell;
const newKey = (oldKey) => scriptWin().__ReaderIIModules.localKey(oldKey);
const panel = () => $('#reader-agent-overlay');
const panelOpen = () => !!(panel() && panel().open);
const activeTab = () => { const tab = $('#reader-agent-overlay .ra-tab[aria-selected="true"]'); return tab && tab.getAttribute('data-tab'); };
function closeAgent() { try { window.ReaderII && window.ReaderII.agent.close(); } catch (error) { /* ignore */ } }

/* 页面里所有轻信 iframe（递归进同源的正文美化 iframe）。 */
function letterFrames() {
  const found = [];
  (function walk(doc) {
    doc.querySelectorAll('iframe').forEach((frame) => {
      if (frame.hasAttribute('data-reader-dream-frame')) { found.push(frame); return; }
      if (frame.id === 'reader-ii-controller' || frame === mock.scriptFrame) return;
      try { if (frame.contentDocument) walk(frame.contentDocument); } catch (error) { /* 跨域 */ }
    });
  })(document);
  return found;
}
const letterOf = (id) => letterFrames().find((frame) => frame.getAttribute('data-reader-message-id') === String(id));
const letterBody = (frame) => frame && frame.contentDocument && frame.contentDocument.querySelector('.text-body-royal');
const allLetters = (check) => { const frames = letterFrames(); return frames.length > 0 && frames.every((frame) => frame.contentDocument && check(frame.contentDocument)); };

async function ask(text, replies, onConfirm) {
  mock.replies.push(...replies);
  const input = await until(() => $('#ra-text'), '输入框');
  input.value = text;
  $('#ra-send').click();
  if (onConfirm) (await until(() => $(`#ra-log .ra-confirm [data-answer="${onConfirm}"]`), '确认卡')).click();
  await until(() => !window.ReaderII.agent.isBusy(), '本轮结束', 15000);
  await sleep(60);
}

/* ---------- 共用的几步 ---------- */
async function bootSteps() {
  await step('主脚本在酒馆助手的脚本 iframe 里启动（世界书与三条正则已就位）', async () => {
    await mock.booted;
    const core = await until(() => scriptWin() && scriptWin().ReaderCore, '脚本 iframe 里的 ReaderCore', 20000);
    await core.ready();
    assert(window.ReaderCore === core, '酒馆主窗口上没有同一个 ReaderCore');
    assert(mock.worldbooks['reader-ii.worldbook'].length === 4, '世界书没有导入');
    return `${mock.scriptJson.name} · ${(mock.scriptJson.content.length / 1024).toFixed(0)} KB · 世界书 4 条 · 正则 ${mock.regexScripts.character.length} 条`;
  });
  await step('findHost 取酒馆主窗口：脚本 iframe 也带 SillyTavern.getContext 时，壳与控制器仍在酒馆主文档', async () => {
    const win = scriptWin();
    assert(typeof win.SillyTavern.getContext === 'function', '前提不成立：脚本 iframe 的 SillyTavern 没有 getContext');
    assert(win.__ReaderIIModules.findHostWindow(win) === window, 'findHost 停在了脚本 iframe 上');
    assert(window.ReaderShell, '酒馆主窗口上没有 ReaderShell（壳建到别处去了）');
    assert(!win.document.getElementById('reader-ii-controller'), '控制器建在了脚本 iframe 里');
  });
  await step('真控制器在壳里启动', async () => {
    await until(() => shell(), '壳', 20000);
    assert(await shell().ready, '壳的 ready 没有给出控制器');
    await until(() => ctl() && ctl().ReaderController, '控制器 ReaderController', 20000);
    assert(shell().isAlive, '壳报告已停止');
    const size = (ctl().document.documentElement.outerHTML.length / 1024).toFixed(0);
    return `控制器文档 ${size} KB · 资源包版本 ${shell().runtimeVersion}`;
  });
}

async function letterStep() {
  await step('轻信挂载并登记：主文档一封、正文美化 iframe 里一封；事件块被显示正则藏起', async () => {
    const frames = await until(() => {
      const list = letterFrames();
      return list.length >= 2 && list.every((frame) => letterBody(frame)) ? list : null;
    }, '两封轻信', 15000);
    const ids = frames.map((frame) => frame.getAttribute('data-reader-message-id')).sort();
    assert(JSON.stringify(ids) === '["0","2"]', '楼层号不对：' + ids.join(','));
    assert(letterOf(2).ownerDocument !== document, '第 2 楼的轻信应当在正文美化 iframe 里');
    assert(/欢迎回来/.test(letterBody(letterOf(0)).textContent) && /今天的故事/.test(letterBody(letterOf(2)).textContent), '轻信正文不对');
    await until(() => shell().getLetters(0).length === 1 && shell().getLetters(2).length === 1, '登记到壳（第 0、2 楼各一封）');
    const render = $('.mes[mesid="2"] iframe.smoke-render');
    const shown = document.getElementById('chat').textContent + render.contentDocument.body.textContent;
    assert(!/READER_TASK_EVENT|冒烟用的事件块/.test(shown), '事件块没有被显示正则藏起来');
    return '第 0、2 楼各登记一封';
  });
}

async function shaStep() {
  await step(`SHA-256 垫片（${window.isSecureContext ? '安全上下文，走 crypto.subtle' : '非安全上下文，没有 crypto.subtle，走纯 JS'}）`, async () => {
    const client = ctl().DreamFixedReleaseClient;
    assert(client && typeof client.sha256 === 'function', '控制器里没有 DreamFixedReleaseClient.sha256');
    assert(!!(window.crypto && window.crypto.subtle) === window.isSecureContext, 'crypto.subtle 与安全上下文对不上');
    const digest = await client.sha256(new TextEncoder().encode('abc'));
    assert(digest === ABC_SHA256, 'abc 的摘要不对：' + digest);
    const big = new Uint8Array(200000).map((_, index) => index % 251);
    const expected = window.crypto.subtle ? [...new Uint8Array(await window.crypto.subtle.digest('SHA-256', big))].map((byte) => byte.toString(16).padStart(2, '0')).join('') : null;
    const actual = await client.sha256(big);
    if (expected) assert(actual === expected, '20 万字节的摘要与 crypto.subtle 不同');
    assert(/^[0-9a-f]{64}$/.test(actual), '摘要格式不对');
    return window.isSecureContext ? 'abc 与 20 万字节都对' : 'abc 对，20 万字节算得出（无 subtle 可对照）';
  });
}

/* ---------- 第一阶段（装了扩展） ---------- */
async function phaseOne() {
  await bootSteps();
  const migrated = Object.keys(mock.oldPrefs);

  await step('本机存储键迁移：新键抄到同样的值，旧键还在且没变，标记里 15 个旧键', async () => {
    for (const oldKey of migrated) {
      assert(localStorage.getItem(newKey(oldKey)) === mock.oldPrefs[oldKey], `${newKey(oldKey)} 没有抄到`);
      assert(localStorage.getItem(oldKey) === mock.oldPrefs[oldKey], `旧键 ${oldKey} 被改了`);
    }
    const marked = JSON.parse(localStorage.getItem(MARK) || '[]');
    assert(marked.length === 15, '标记里应有 15 个旧键：' + marked.length);
    assert(migrated.every((key) => marked.includes(key)), '标记里缺了写过的旧键');
    return migrated.map(newKey).join(' ');
  });

  await letterStep();

  await step('迁移过来的偏好生效：水墨主题、悬浮模式、旧版前端、字号 18、信纸展开', async () => {
    const c = ctl();
    assert(c.getVisualTheme() === 'ink', '主题应是 ink：' + c.getVisualTheme());
    assert(c.gLS('reader_ii_render_mode', 'inline') === 'float', '显示模式应是悬浮');
    assert(c.getCurFSZ() === 18, '字号应是 18：' + c.getCurFSZ());
    assert(!shell().settings().ui, '应当是旧版前端（reader_ii_ui_v4=off）');
    await until(() => allLetters((doc) => doc.documentElement.getAttribute('data-dream-theme') === 'ink'), '轻信用水墨主题');
    await until(() => allLetters((doc) => doc.querySelector('.wrapper-v9-fix') && !doc.querySelector('.wrapper-v9-fix.lv')), '轻信用旧版视图（.wrapper-v9-fix 没有 .lv）');
    await until(() => allLetters((doc) => doc.querySelector('.cafe-v20-responsive.letter-unfolded')), '信纸展开');
    await until(() => allLetters((doc) => Math.abs(parseFloat(doc.querySelector('.wrapper-v9-fix').style.zoom) - 1.125) < 0.01), '轻信字号 18（zoom 1.125）');
  });

  await step('独立 API：控制器与夜梦助手都读到迁移过来的方案（语义适配走它，助手对话仍走酒馆）', async () => {
    const state = ctl().readDreamApiState();
    assert(state.presets.some((preset) => preset.id === 'smoke1' && preset.name === '冒烟方案') && state.routes.adapt === 'smoke1', '控制器没读到：' + JSON.stringify(state).slice(0, 200));
    await until(() => window.ReaderII && window.ReaderII.ready, '扩展 ① 就绪', 15000);
    const adapt = window.ReaderII.llm.getBackendSummary('adapt'), agent = window.ReaderII.llm.getBackendSummary('agent');
    assert(adapt.mode === 'custom' && adapt.model === 'smoke-model', '夜梦助手的语义适配没走迁移过来的方案：' + JSON.stringify(adapt));
    assert(agent.mode === 'main', '助手对话不该走这个方案：' + JSON.stringify(agent));
    ctl().openIndependentApiSettings(null, () => {});
    await until(() => $('#cpl-overlay .dad-presets') && /冒烟方案/.test($('#cpl-overlay .dad-presets').textContent), '独立 API 面板列出「冒烟方案」');
    $('#cpl-overlay .cpl-close').click();
    await until(() => !$('#cpl-overlay'), '独立 API 面板关上');
  });

  await step('独立 API：在控制器或夜梦助手里改，都只写新键，两边看到的一样', async () => {
    const before = localStorage.getItem('dream_independent_api_v2');
    const state = ctl().readDreamApiState();
    state.presets.push({ id: 'smoke2', name: '第二方案', apiurl: 'http://127.0.0.1:9/v1', key: '', model: 'smoke-model-2', source: 'openai' });
    state.routes.adapt = 'smoke2';
    ctl().writeDreamApiState(state);
    assert(localStorage.getItem('dream_independent_api_v2') === before, '旧键 dream_independent_api_v2 被改了');
    assert(localStorage.getItem('dream_independent_api_v1') === null, '写出了旧键 dream_independent_api_v1');
    assert((localStorage.getItem('reader_ii_independent_api_v2') || '').includes('smoke2'), '新键没写进去');
    assert(window.ReaderII.llm.getBackendSummary('adapt').model === 'smoke-model-2', '夜梦助手没看到控制器改后的方案');
    window.ReaderII.llm.saveSettings({ enabled: false, apiurl: '', key: '', model: '', source: 'openai' });
    assert(localStorage.getItem('dream_independent_api_v2') === before, '夜梦助手保存时改了旧键');
    const after = ctl().readDreamApiState();
    assert(after.presets.some((preset) => preset.id === 'smoke2') && after.routes.adapt === 'smoke2', '夜梦助手保存后控制器读到的方案不对：' + JSON.stringify(after).slice(0, 200));
  });

  await step('菜单板的「夜梦助手」「记忆」两行（悬浮模式的信件页）', async () => {
    await shell().open({ page: 'letters', messageId: 2 });
    (await until(() => $('#dfo [data-action="readerAgent"]'), '菜单板「夜梦助手」')).click();
    await until(() => panelOpen() && activeTab() === 'chat', '夜梦助手面板（对话页）');
    closeAgent();
    await shell().open({ page: 'letters', messageId: 2 });
    (await until(() => $('#dfo [data-action="readerMemory"]'), '菜单板「记忆」')).click();
    await until(() => panelOpen() && activeTab() === 'memory', '夜梦助手面板（记忆页）');
    closeAgent();
    shell().close();
  });

  await step('新旧前端切换：彩蛋页的开关写 reader_ii_ui_v4，轻信跟着换成新版视图', async () => {
    await shell().open('eggs');
    (await until(() => $('#dlb-overlay [data-dlb="egglegacyui"]'), '彩蛋页的前端开关')).click();
    await until(() => localStorage.getItem('reader_ii_ui_v4') !== 'off' && $('#dlb-overlay #u4r'), '切到新版前端');
    assert(localStorage.getItem('dream_ui_v4') === 'off', '旧键 dream_ui_v4 被改了');
    assert(shell().settings().ui, '壳推给轻信的设置里没有新版界面');
    await until(() => allLetters((doc) => doc.querySelector('.wrapper-v9-fix.lv')), '轻信换成新版视图（.wrapper-v9-fix.lv）');
    return 'reader_ii_ui_v4=' + localStorage.getItem('reader_ii_ui_v4');
  });

  await step('改显示模式只写新键：切回内嵌', async () => {
    ctl().toggleDisplayMode();
    assert(localStorage.getItem('reader_ii_render_mode') === 'inline', '新键没变成 inline');
    assert(localStorage.getItem('dream_render_mode') === 'float', '旧键 dream_render_mode 被改了');
  });

  await step('大厅三主题能开（咖啡馆、盛夏、水墨），轻信跟着换主题', async () => {
    for (const theme of ['cafe', 'summer', 'ink']) {
      ctl().applyVisualTheme(theme, false);
      shell().refresh();
      await shell().open('lobby');
      await until(() => $('#dlb-overlay #u4r') && document.documentElement.getAttribute('data-u4-theme') === theme, `${theme} 大厅`);
      await until(() => allLetters((doc) => doc.documentElement.getAttribute('data-dream-theme') === theme), `${theme} 轻信`);
    }
  });

  await step('点大厅立绘打开夜梦助手', async () => {
    await shell().open('lobby');
    (await until(() => $('#dlb-overlay [data-u4-her]'), '大厅立绘')).click();
    await until(() => panelOpen() && activeTab() === 'chat', '夜梦助手面板');
    closeAgent();
  });

  await step('彩蛋页的三个入口：夜梦助手、记忆、语义适配', async () => {
    const entries = [
      ['eggagent', '夜梦助手（对话页）', () => panelOpen() && activeTab() === 'chat'],
      ['eggmemory', '夜梦助手（记忆页）', () => panelOpen() && activeTab() === 'memory'],
      ['eggpanel', '语义适配面板', () => $('[data-reader-core-panel]')],
    ];
    for (const [key, label, check] of entries) {
      await shell().open('eggs');
      (await until(() => $(`#dlb-overlay [data-dlb="${key}"]`), `彩蛋页入口 ${key}`)).click();
      await until(check, label);
      closeAgent();
      const core = $('[data-reader-core-panel]');
      if (core) core.remove();
    }
  });

  await step('夜梦助手：一轮带工具的对话，确认卡点「允许」后写入', async () => {
    window.ReaderII.agent.open('chat');
    const before = mock.llmCalls.length;
    await ask('把王都人口改成二十万', [
      '我先看看这个条目。\n' + call('read', { path: 'wb:/设定集/王都' }),
      call('edit', { path: 'wb:/设定集/王都', old: '人口十万', new: '人口二十万' }),
      '改好了，王都现在有二十万人。',
    ], 'allow');
    assert(/人口二十万/.test(mock.worldbooks.设定集[0].content), '世界书没有被修改：' + mock.worldbooks.设定集[0].content);
    assert(/改好了，王都现在有二十万人/.test($('#ra-log').textContent), '面板里没有出现最终回答');
    assert(/【核心工具】/.test(JSON.stringify(mock.llmCalls[before])), '系统提示词里没有核心工具');
    closeAgent();
  });

  await step('记忆页：新增、删除、立即整理，整理后注入正文', async () => {
    window.ReaderII.agent.open('memory');
    (await until(() => $('#reader-agent-overlay [data-act="mem-new"]'), '「新增记忆」')).click();
    const editor = await until(() => $('#ra-editor'), '记忆编辑框');
    $('[data-f="title"]', editor).value = '冒烟记忆';
    $('[data-f="content"]', editor).value = '这是冒烟测试写的一条记忆。';
    $('[data-f="keys"]', editor).value = '冒烟';
    $('[data-act="mem-save"]', editor).click();
    const item = () => [...document.querySelectorAll('#reader-agent-overlay .ra-mem')].find((node) => /冒烟记忆/.test(node.textContent));
    await until(item, '新增的记忆出现在列表里');
    const del = () => $('[data-act="mem-del"]', item());
    del().click();
    await until(() => del() && del().getAttribute('data-armed') === '1', '删除按钮进入确认');
    del().click();
    await until(() => !item(), '记忆被删掉');
    mock.replies.push(JSON.stringify({ summary: '作家深夜来到旧书店，夜梦在柜台后看书。', memories: [{ op: 'add', type: 'episode', title: '书店的夜晚', content: '作家在深夜推开旧书店的门，夜梦合上书向他微笑。', keys: ['旧书店'], importance: 3 }] }));
    (await until(() => $('#reader-agent-overlay [data-act="mem-run"]:not([disabled])'), '「立即整理」')).click();
    await until(() => [...document.querySelectorAll('#reader-agent-overlay .ra-mem')].some((node) => /书店的夜晚/.test(node.textContent)), '整理出的记忆', 15000);
    let injected;
    try {
      injected = await until(() => { const prompt = mock.prompts['reader-ii-memory']; const text = prompt && (prompt.content || prompt.text); return text && /旧书店/.test(text) ? text : null; }, '记忆注入正文');
    } catch (error) {
      throw new Error(error.message + '；聊天变量：' + Object.keys(mock.ctx.chatMetadata.variables).join(',') + '；注入：' + JSON.stringify(mock.prompts).slice(0, 300));
    }
    closeAgent();
    return `注入 ${injected.length} 字`;
  });

  await step('抽卡面板能开，设置里改档位名并保存到 reader_ii_gacha_settings_v1', async () => {
    await shell().open('lobby');
    (await until(() => $('#dlb-overlay [data-dlb="gacha"]'), '大厅「命运抽卡」')).click();
    const gacha = await until(() => { const node = $('.bs-gacha, [data-dream-overlay="gacha"]'); return node && !node.hidden ? node : null; }, '抽卡面板');
    (await until(() => $('[aria-label="抽卡设置"]', gacha), '抽卡设置按钮')).click();
    const input = await until(() => $('[aria-label="第 1 档的名字"]', gacha), '第 1 档的名字');
    input.value = '凡品';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...gacha.querySelectorAll('button')].find((button) => button.textContent.trim() === '保存设置').click();
    await until(() => (localStorage.getItem('reader_ii_gacha_settings_v1') || '').includes('凡品'), '档位名存进 reader_ii_gacha_settings_v1');
    assert(!localStorage.getItem('dream_gacha_settings_v1'), '写出了原版读者的抽卡键');
    ctl().ReaderGacha.close();
    await until(() => { const node = $('.bs-gacha, [data-dream-overlay="gacha"]'); return !node || node.hidden; }, '抽卡面板关上');
  });

  await step('生成一轮：生成前钩子不卡，回复里的 FP 事件记账，事件块不显示，新楼层的轻信挂上', async () => {
    const before = Number(await window.ReaderCore.getFpBalance());
    const started = Date.now();
    const index = await mock.receive('夜梦翻到下一页。\n<READER_FP_EVENT>{"source":"reader_owned","category":"resurrection","event_id":"smoke-fp","evidence":"冒烟"}</READER_FP_EVENT>\n<dream>「这一页送给你。」</dream>');
    const took = Date.now() - started;
    assert(took < 5000, `生成前后的钩子花了 ${took} ms`);
    await until(async () => Number(await window.ReaderCore.getFpBalance()) === before + 200, `命运点数 ${before} → ${before + 200}`);
    assert(!/READER_FP_EVENT|smoke-fp/.test($(`.mes[mesid="${index}"]`).textContent), '事件块显示出来了');
    await until(() => letterBody(letterOf(index)) && /这一页送给你/.test(letterBody(letterOf(index)).textContent), '新楼层的轻信');
    return `命运点数 ${before} → ${before + 200}，钩子 ${took} ms`;
  });

  await step('流式输出：插槽稳定之后只挂一封轻信', async () => {
    const target = mock.chat.length;
    const seen = new WeakSet();
    let created = 0;
    const count = () => document.querySelectorAll('#chat iframe[data-reader-dream-frame]').forEach((frame) => {
      if (seen.has(frame)) return;
      seen.add(frame);
      const mes = frame.closest('.mes');
      if (mes && mes.getAttribute('mesid') === String(target)) created += 1;
    });
    const observer = new MutationObserver(count);
    observer.observe(document.getElementById('chat'), { childList: true, subtree: true });
    const head = '夜梦把书签夹好。<dream>「晚安，作家先生。」</dream>';
    await mock.stream(['夜梦', '夜梦把书签', '夜梦把书签夹好。<dream>「晚', head, head + '\n她', head + '\n她关了', head + '\n她关了灯', head + '\n她关了灯。'], 60);
    await until(() => letterBody(letterOf(target)), '新楼层的轻信', 8000);
    await sleep(600);
    count();
    observer.disconnect();
    assert(created === 1, `流式输出期间建了 ${created} 个轻信 iframe`);
    assert(/晚安/.test(letterBody(letterOf(target)).textContent), '轻信正文不对');
  });

  await step('改偏好只写新键：字号恢复默认就删掉新键；原版读者后来写的旧键不影响 reader-II', async () => {
    ctl().setCurFSZ(16);
    assert(localStorage.getItem('reader_ii_font_size') === null, '字号恢复默认后新键应被删掉');
    assert(localStorage.getItem('dream_font_size') === '18', '旧键 dream_font_size 被改了');
    localStorage.setItem('dream_visual_theme', 'summer');
    localStorage.setItem('dream_font_size', '20');
    return '接着刷新页面，第二阶段核对';
  });

  await step('换聊天：控制器重建，新聊天的轻信挂上', async () => {
    const oldWin = ctl();
    await mock.switchChat('card-smoke-2', [{ name: '夜梦', is_user: false, mes: '雨夜。\n<dream>「换了一个聊天，也还是我。」</dream>' }]);
    await until(() => ctl() && ctl() !== oldWin && ctl().ReaderController, '控制器重建', 15000);
    await until(() => letterFrames().length === 1 && /换了一个聊天/.test(letterBody(letterFrames()[0]) ? letterBody(letterFrames()[0]).textContent : ''), '新聊天的轻信', 10000);
    await until(() => shell().getLetters().length === 1, '只登记新聊天的那一封');
  });

  await shaStep();

  sessionStorage.setItem(STORE, JSON.stringify(results));
  const next = new URLSearchParams(params);
  next.set('phase', '2');
  location.search = next.toString();
}

/* ---------- 第二阶段：刷新以后 ---------- */
async function phaseTwo() {
  await step('刷新后：主脚本、壳与控制器照常启动', async () => {
    await mock.booted;
    const core = await until(() => scriptWin() && scriptWin().ReaderCore, '脚本 iframe 里的 ReaderCore', 20000);
    await core.ready();
    await until(() => ctl() && ctl().ReaderController, '控制器', 20000);
    await until(() => letterFrames().length >= 2 && letterFrames().every((frame) => letterBody(frame)), '轻信', 15000);
  });
  await step('刷新后：删掉的字号新键没有被旧键抄回来，轻信用默认字号', async () => {
    assert(localStorage.getItem('reader_ii_font_size') === null, '新键又有值了：' + localStorage.getItem('reader_ii_font_size'));
    assert(localStorage.getItem('dream_font_size') === '20', '旧键应是第一阶段最后写的 20');
    assert(ctl().getCurFSZ() === 16, '字号应是默认 16');
    await until(() => allLetters((doc) => { const zoom = doc.querySelector('.wrapper-v9-fix').style.zoom; return !zoom || Math.abs(parseFloat(zoom) - 1) < 0.01; }), '轻信 zoom 回到 1');
  });
  await step('刷新后：原版读者后来改的旧键不影响 reader-II', async () => {
    assert(localStorage.getItem('dream_visual_theme') === 'summer', '前提：旧键是 summer');
    assert(localStorage.getItem('reader_ii_visual_theme') === 'ink', '新键被旧键改了：' + localStorage.getItem('reader_ii_visual_theme'));
    assert(JSON.parse(localStorage.getItem(MARK) || '[]').length === 15, '迁移标记变了');
  });
  await step('刷新后：新版前端与内嵌模式保留', async () => {
    assert(localStorage.getItem('reader_ii_ui_v4') !== 'off', '新版前端偏好没保留');
    assert(localStorage.getItem('reader_ii_render_mode') === 'inline', '内嵌模式没保留');
    await until(() => allLetters((doc) => doc.querySelector('.wrapper-v9-fix.lv')), '轻信用新版视图（.wrapper-v9-fix.lv）');
    await shell().open('eggs');
    await until(() => $('#dlb-overlay #u4r'), '彩蛋页是新版前端');
    shell().close();
  });
  await step('刷新后：夜梦助手的运行记录还在（IndexedDB）', async () => {
    await until(() => window.ReaderII && window.ReaderII.ready, '扩展 ① 就绪', 15000);
    const runs = await window.ReaderII.agent.listRuns(10);
    assert(runs.length >= 1, '没有运行记录');
    return `运行记录 ${runs.length} 条`;
  });
  finish();
}

/* ---------- 没装扩展（ext=0） ---------- */
async function withoutExtension() {
  await bootSteps();
  await step('没装扩展：点脚本按钮「夜梦助手」从 CDN 加载 ① 并打开面板', async () => {
    const already = !!(window.ReaderII && window.ReaderII.ready);
    (await until(() => $('#th-buttons [data-th-button="夜梦助手"]'), '脚本按钮')).click();
    await until(() => window.ReaderII && window.ReaderII.ready, '① 就绪', 20000);
    await until(panelOpen, '夜梦助手面板', 10000);
    const tag = $('script[data-reader-ii="cdn"]');
    assert(tag && /^https:\/\/cdn\.jsdelivr\.net\/gh\/Adirm007\/reader-II@main\/dist\/reader-ii\.ext\.js/.test(tag.src), '没有从 CDN 加载：' + (tag && tag.src));
    assert(/^https:\/\/cdn\.jsdelivr\.net\/gh\/Adirm007\/reader-II@main\//.test(window.__ReaderIIBase || ''), '__ReaderIIBase 不是 CDN 地址');
    assert(!document.querySelectorAll('script[data-reader-ii]')[1], '加载了不止一份 ①');
    closeAgent();
    return already ? '点之前已由后台自动加载' : '点按钮时加载';
  });
  await letterStep();
  await shaStep();
  await step('大厅能开（旧版前端，偏好照迁移）', async () => {
    await shell().open('lobby');
    await until(() => $('#dlb-overlay'), '大厅');
    assert(!$('#dlb-overlay #u4r'), '应当是旧版前端');
    shell().close();
  });
  await step('夜梦助手：知识库从 CDN 地址读取', async () => {
    const listing = await window.ReaderII.vfs.list('kb:/', {});
    const first = listing.items && listing.items[0];
    assert(first, 'kb:/ 是空的：' + JSON.stringify(listing).slice(0, 200));
    const name = String(first.name || first.path || '').replace(/^kb:\/?/, '').replace(/\/$/, '');
    const text = await window.ReaderII.vfs.readText(`kb:/${name}/SKILL.md`);
    assert(text && text.length > 20, `kb:/${name}/SKILL.md 读不到`);
    return `${listing.items.length} 份知识，kb:/${name}/SKILL.md ${text.length} 字`;
  });
  finish();
}

if (params.get('auto') === '1') {
  (phase === 2 ? phaseTwo() : withExtension ? phaseOne() : withoutExtension()).catch((error) => {
    results.push({ name: '场景异常中断', ok: false, detail: String(error && error.stack || error) });
    finish();
  });
}
