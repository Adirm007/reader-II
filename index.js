/*
 * Reader-II 酒馆扩展入口。
 * 这里只做三件事：记下扩展自己的地址、等酒馆就绪、在空闲时加载主包（dist/reader-ii.ext.js）。
 * 主包有一兆多，不放在酒馆的启动路径上；语义层、读者界面、提示词、记忆与夜梦助手都在主包里。
 *
 * 大厅与 /yume 沿用原有入口。扩展设置里的按钮在没有打开角色卡时也能进入助手。
 */
const entry = new URL(import.meta.url);
const base = new URL('.', entry).href;
window.__ReaderIIBase = base;
window.__ReaderIIQueue = window.__ReaderIIQueue || [];

function context() {
  try { return window.SillyTavern?.getContext?.() ?? null; } catch { return null; }
}

function openLobby() {
  const lobby = window.ReaderII?.lobby;
  if (lobby) return lobby.open();
  window.toastr?.info('Reader-II 还在加载，请稍等一下再点', 'Reader-II');
  return Promise.resolve(false);
}

function addEntries() {
  const menu = document.getElementById('extensionsMenu');
  if (menu && !document.getElementById('reader-ii-menu')) {
    const item = document.createElement('div');
    item.id = 'reader-ii-menu';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = '打开读者大厅：轻信、定调、命运抽卡，以及彩蛋服务台里的夜梦助手';
    item.innerHTML = '<div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>Reader-II · 大厅</span>';
    item.addEventListener('click', () => { openLobby(); });
    menu.appendChild(item);
  }
  function assistantButton(parent, id, className) {
    if (!parent || document.getElementById(id)) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = className;
    button.textContent = 'Reader-II · 夜梦助手';
    button.addEventListener('click', () => window.ReaderII.agent.open('chat'));
    parent.appendChild(button);
  }
  assistantButton(menu, 'reader-ii-agent-menu', 'list-group-item flex-container flexGap5 interactable');
  assistantButton(document.getElementById('extensions_settings2') || document.getElementById('extensions_settings'),
    'reader-ii-agent-settings', 'menu_button menu_button_icon interactable');
  /* /yume 打开大厅；/yume 一句话 让夜梦助手处理这句话，回答作为命令的返回值（给快捷回复与脚本用，不是界面入口）。 */
  try {
    const ctx = context();
    if (ctx?.SlashCommandParser && ctx?.SlashCommand && !window.__ReaderIISlash) {
      window.__ReaderIISlash = true;
      ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
        name: 'yume',
        helpString: 'Reader-II：不带内容时打开读者大厅；带内容时让夜梦助手处理这句话并返回回答。',
        unnamedArgumentList: [],
        callback: async (_args, text) => {
          const input = String(text ?? '').trim();
          if (!input) { await openLobby(); return ''; }
          const result = await window.ReaderII.agent.run(input, {});
          return result.answer;
        },
      }));
    }
  } catch (error) {
    console.warn('[ReaderII] 斜杠命令注册失败', error);
  }
}

function load() {
  if (window.ReaderII?.ready) { addEntries(); return; }
  if (document.querySelector('script[data-reader-ii]')) return;
  const script = document.createElement('script');
  const bundle = new URL('dist/reader-ii.ext.js', base);
  const version = entry.searchParams.get('v');
  if (version) bundle.searchParams.set('v', version);
  script.src = bundle.href;
  script.dataset.readerIi = '1';
  script.onload = addEntries;
  script.onerror = () => console.error('[ReaderII] 主包加载失败：', script.src);
  document.head.appendChild(script);
}

function start() {
  const idle = window.requestIdleCallback ?? ((task) => setTimeout(task, 600));
  idle(load, { timeout: 4000 });
}

const ctx = context();
const types = ctx?.eventTypes ?? ctx?.event_types;
if (ctx?.eventSource && types?.APP_READY) ctx.eventSource.once(types.APP_READY, start);
else start();
