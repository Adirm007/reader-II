(function (root) {
  'use strict';

  /*
   * 扩展包（reader-ii.ext.js）的启动入口：装配环境 → 记忆 → Agent 内核 → 面板，挂到宿主窗口的 ReaderII 上。
   * 两种载体都走这里：酒馆扩展直接加载；酒馆助手脚本在没有扩展时也可以加载同一份包。
   * 重复加载是安全的：已经有实例就什么都不做。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var SETTINGS_NAMESPACE = 'reader_ii';

  function boot() {
    var env = modules.createEnv(root);
    var host = env.host;
    if (host.ReaderII && host.ReaderII.ready === true) return host.ReaderII;

    var kit = modules.createHostKit(env);
    var llm = modules.createLlmGateway(env);
    var history = modules.createAgentHistory(env, kit);
    var memory = modules.createMemorySystem(env, llm, kit, history);
    var store = modules.createStore(env);
    var journal = modules.createJournal(store);
    var vfs = modules.createVfs({ journal: journal });
    var registry = modules.createRegistry();
    var probe = modules.installPageProbe(env);
    var agent = null, ui = null;
    /* 联网、MCP、后端伴侣（交接 0.6 乙组）。密钥只在本机；三者的设置是助手设置里的 web / mcp / companion 三段。 */
    var secrets = modules.createSecrets(env);
    var agentSettings = function () { return agent ? agent.getSettings() : {}; };
    var companion = null, mcp = null, web = null;
    var net = modules.createNet(env, kit, { secrets: secrets, settings: function () { return agentSettings().web; }, companion: function () { return companion; } });
    companion = modules.createCompanionClient(env, kit, {
      net: net, secrets: secrets, version: modules.READER_AGENT_VERSION,
      settings: function () { return agentSettings().companion; },
      allowed: function () { return agentSettings().mode === 'device'; }
    });

    /* 设置随酒馆账号走（extension_settings）；拿不到时退回 localStorage。 */
    var settingsIo = {
      read: function () {
        var ctx = kit.context();
        var bag = ctx && ctx.extensionSettings && ctx.extensionSettings[SETTINGS_NAMESPACE];
        if (bag && modules.isObject(bag.agent)) return bag.agent;
        return kit.localRead('reader_ii_agent_settings_v1', {});
      },
      write: function (value) {
        kit.localWrite('reader_ii_agent_settings_v1', value);
        var ctx = kit.context();
        if (!ctx || !ctx.extensionSettings) return;
        ctx.extensionSettings[SETTINGS_NAMESPACE] = Object.assign({}, ctx.extensionSettings[SETTINGS_NAMESPACE], { agent: value });
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
      }
    };

    function describeEnv() {
      var ctx = kit.context() || {};
      var version = '';
      try { version = host.TavernHelper && typeof host.TavernHelper.getTavernHelperVersion === 'function' ? host.TavernHelper.getTavernHelperVersion() : ''; } catch (error) { version = ''; }
      return {
        reader_ii: modules.READER_AGENT_VERSION, carrier: env.carrier,
        tauritavern: !!host.__TAURITAVERN__, tavern_helper: host.TavernHelper ? version || true : false,
        mobile: /Android|iPhone|iPad|Mobile/i.test(String(host.navigator && host.navigator.userAgent || '')),
        character: ctx.name2 || '', chat_length: Array.isArray(ctx.chat) ? ctx.chat.length : 0,
        plugins: agent ? agent.listConnectors().map(function (item) { return item.title; }) : [],
        permission: agent ? agent.permissions.describe() : ''
      };
    }

    modules.installBuiltinProviders(vfs, env, kit, { store: store, probe: probe, describeEnv: describeEnv, memory: memory });
    modules.installCoreTools(registry, { vfs: vfs, env: env, kit: kit });
    web = modules.installWebTools(registry, vfs, env, kit, { net: net, secrets: secrets });
    modules.installDeviceTools(registry, vfs, env, kit, { companion: companion });
    var legacy = modules.createAgentTools(env, kit, {
      core: function () { return host.ReaderCore && host.ReaderCore.__reader_core_api ? host.ReaderCore : null; },
      memory: memory,
      shell: function () { return host.ReaderShell || null; },
      openUi: function (tab) { return ui ? ui.open(tab) : null; }
    });
    modules.adoptLegacyTools(registry, legacy);
    var skills = modules.installSkills(registry, vfs, env, store);
    var connectors = modules.installConnectors(registry, env, kit, function () { return agent ? agent.getSettings().connectors : []; });

    agent = modules.createAgent(env, llm, kit, memory, {
      history: history, registry: registry, vfs: vfs, journal: journal, connectors: connectors, settingsIo: settingsIo, apiTier: legacy.apiTier,
      requestMoreRounds: function (request) { return ui ? ui.requestMoreRounds(request) : 0; },
      core: function () { return host.ReaderCore && host.ReaderCore.__reader_core_api ? host.ReaderCore : null; },
      envLines: function () { return [web ? web.brief() : '', mcp ? mcp.brief() : '', companion.brief()]; }
    });
    mcp = modules.createMcp(env, kit, {
      registry: registry, net: net, secrets: secrets, store: store, version: modules.READER_AGENT_VERSION,
      companion: function () { return companion; },
      settings: function () { return agentSettings().mcp; },
      save: function (value) { agent.saveSettings({ mcp: value }); }
    });
    /* 设置被别处改了（面板、助手自己）时，MCP 工具箱跟着重新登记。 */
    agent.onChange(function (reason) { if (reason === 'settings') { try { mcp.sync(); } catch (error) { /* 登记失败不影响别的 */ } } });
    registry.on('run:start', kit.prepareWorldbooks);
    /* 之前放行过、或已经开到「设备全权」时，每轮开始前看一眼伴侣在不在（一分钟内不重复）；别的用户不会因此多发请求。 */
    registry.on('run:start', function () {
      if (companion.hasSaved() || agent.getSettings().mode === 'device') return companion.status(false);
      return null;
    });
    var updates = modules.createUpdater(env, kit);
    ui = modules.createAgentUi(env, kit, agent, memory, llm, {
      updates: updates,
      netUi: function (panel) { return modules.createNetUi(env, kit, agent, { net: net, secrets: secrets, mcp: mcp, companion: companion, web: web }, panel); },
      shell: function () { return host.ReaderShell || null; },
      core: function () { return host.ReaderCore && host.ReaderCore.__reader_core_api ? host.ReaderCore : null; },
      /* 下面才定义的 lobby：助手窗口的「服务台」返回按钮与设置页「这张卡」的开关要用。 */
      lobby: function () { return lobby; }
    });

    try { memory.install(); } catch (error) { env.console.warn('[ReaderII] 记忆系统启动失败', error); }
    connectors.refresh();
    skills.loadUserSkills().catch(function () { /* 工作区不可用时没有用户知识 */ });
    mcp.load().catch(function () { /* 没有缓存就等用户点刷新 */ });

    /*
     * 读者大厅：所有入口的去处（扩展菜单里的「Reader-II · 大厅」与不带内容的 /yume）。
     * Reader 按角色卡启用：这张卡还没启用时先问一句——启用并进大厅，或者只用夜梦助手（她在任何聊天里都能用）。
     */
    function toast(kind, text) {
      var toastr = env.toastr || host.toastr;
      if (toastr && typeof toastr[kind] === 'function') toastr[kind](text, 'Reader-II');
      else env.console.info('[ReaderII] ' + text);
    }
    function currentCore() { return host.ReaderCore && host.ReaderCore.__reader_core_api ? host.ReaderCore : null; }

    async function askEnable() {
      var ctx = kit.context() || {};
      var name = kit.names().char;
      var text = '要在「' + name + '」这张卡上启用 Reader-II 吗？\n\n启用后，九十九夜梦会读这个故事、偶尔来信，读者大厅（定调、命运抽卡等）也在这张卡上可用；她的设定会随每次生成一起发给模型。之后随时可以在「彩蛋服务台 → 助手设置」里关掉。';
      if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
        var html = '<div style="text-align:left;line-height:1.7">' + text.replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }).replace(/\n/g, '<br>') + '</div>';
        try {
          var picked = await ctx.callGenericPopup(html, ctx.POPUP_TYPE.CONFIRM, '', {
            okButton: '启用并进入大厅', cancelButton: '先不用',
            customButtons: [{ text: '只用夜梦助手', result: 77 }]
          });
          if (picked === 77) return 'agent';
          return picked === 1 || picked === true ? 'enable' : 'cancel';
        } catch (error) { /* 弹窗出不来就用浏览器自带的 */ }
      }
      return typeof host.confirm === 'function' && host.confirm(text) ? 'enable' : 'cancel';
    }

    var lobby = {
      isEnabled: function () { var core = currentCore(); return !!core && core.isEnabled(); },
      enable: function () { var core = currentCore(); return core ? core.setEnabled(true) : Promise.reject(new Error('读者还没有就绪')); },
      disable: function () { var core = currentCore(); return core ? core.setEnabled(false) : Promise.reject(new Error('读者还没有就绪')); },
      /* page：lobby（默认）或大厅里的某一页，如 eggs（彩蛋服务台）。返回是否打开了大厅。 */
      open: async function (page) {
        var core = currentCore();
        var shell = host.ReaderShell;
        if (!core || !shell || typeof shell.open !== 'function') { toast('warning', '读者界面还没有就绪，请稍等一下再试'); return false; }
        if (!core.hasChat()) { toast('info', '请先打开一个聊天，再进读者大厅'); return false; }
        if (!core.isEnabled()) {
          var choice = await askEnable();
          if (choice === 'agent') { ui.open('chat'); return false; }
          if (choice !== 'enable') return false;
          try { await core.setEnabled(true); }
          catch (error) { toast('error', '启用失败：' + String(error && error.message || error)); return false; }
        }
        var opened = false;
        try { opened = await shell.open(page || 'lobby'); } catch (error) { env.console.warn('[ReaderII] 大厅打开失败', error); }
        if (!opened) toast('warning', '大厅没能打开：读者界面可能还在准备，稍等几秒再点一次');
        return !!opened;
      }
    };

    var api = {
      version: modules.READER_AGENT_VERSION, ready: true, carrier: env.carrier,
      agent: Object.assign(agent, { open: ui.open, close: ui.close }),
      lobby: lobby,
      memory: memory, kit: kit, llm: llm, vfs: vfs, updates: updates, mcp: mcp, companion: companion, net: net,
      dispose: function () {
        try { ui.dispose(); } catch (error) { /* ignore */ }
        try { memory.dispose(); } catch (error) { /* ignore */ }
      }
    };
    host.ReaderII = api;
    host.ReaderAgent = api.agent;
    host.ReaderMemory = memory;

    /* 比我们早加载的插件可以把登记动作排进 __ReaderIIQueue，这里统一执行。 */
    var queue = Array.isArray(host.__ReaderIIQueue) ? host.__ReaderIIQueue.splice(0) : [];
    host.__ReaderIIQueue = { push: function (task) { try { task(api); } catch (error) { env.console.warn('[ReaderII] 插件登记失败', error); } } };
    queue.forEach(function (task) { host.__ReaderIIQueue.push(task); });
    try { host.dispatchEvent(new host.CustomEvent('reader-ii:ready', { detail: { version: api.version } })); } catch (error) { /* ignore */ }
    env.console.info('[ReaderII] 夜梦助手就绪', api.version, env.carrier);
    return api;
  }

  modules.bootReaderII = boot;
  if (root.__READER_II_NO_AUTOBOOT__ !== true) {
    try { boot(); } catch (error) { (root.console || console).error('[ReaderII] 启动失败', error); }
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
