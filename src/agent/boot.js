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
    var memory = modules.createMemorySystem(env, llm, kit);
    var store = modules.createStore(env);
    var journal = modules.createJournal(store);
    var vfs = modules.createVfs({ journal: journal });
    var registry = modules.createRegistry();
    var probe = modules.installPageProbe(env);
    var agent = null, ui = null;

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
      registry: registry, vfs: vfs, journal: journal, connectors: connectors, settingsIo: settingsIo, apiTier: legacy.apiTier,
      core: function () { return host.ReaderCore && host.ReaderCore.__reader_core_api ? host.ReaderCore : null; }
    });
    var updates = modules.createUpdater(env, kit);
    ui = modules.createAgentUi(env, kit, agent, memory, llm, {
      updates: updates,
      shell: function () { return host.ReaderShell || null; },
      core: function () { return host.ReaderCore && host.ReaderCore.__reader_core_api ? host.ReaderCore : null; }
    });

    try { memory.install(); } catch (error) { env.console.warn('[ReaderII] 记忆系统启动失败', error); }
    connectors.refresh();
    skills.loadUserSkills().catch(function () { /* 工作区不可用时没有用户知识 */ });

    var api = {
      version: modules.READER_AGENT_VERSION, ready: true, carrier: env.carrier,
      agent: Object.assign(agent, { open: ui.open, close: ui.close }),
      memory: memory, kit: kit, llm: llm, vfs: vfs, updates: updates,
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
