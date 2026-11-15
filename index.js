/*
 * Reader-II 酒馆扩展入口。
 * 这里只做三件事：记下扩展自己的地址、等酒馆就绪、在空闲时加载主包（dist/reader-ii.ext.js）。
 * 主包有几百 KB，不放在酒馆的启动路径上；记忆注入、助手面板等都在主包里。
 */
const base = new URL('.', import.meta.url).href;
window.__ReaderIIBase = base;
window.__ReaderIIQueue = window.__ReaderIIQueue || [];

function context() {
  try { return window.SillyTavern?.getContext?.() ?? null; } catch { return null; }
}

function addEntries() {
  const menu = document.getElementById('extensionsMenu');
  if (menu && !document.getElementById('reader-ii-menu')) {
    const item = document.createElement('div');
    item.id = 'reader-ii-menu';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>夜梦助手</span>';
    item.addEventListener('click', () => window.ReaderII?.agent.open('chat'));
    menu.appendChild(item);
  }
  /* /yume 打开面板；/yume 一句话 直接提问，回答作为命令的返回值。 */
  try {
    const ctx = context();
    if (ctx?.SlashCommandParser && ctx?.SlashCommand && !window.__ReaderIISlash) {
      window.__ReaderIISlash = true;
      ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
        name: 'yume',
        helpString: '夜梦助手：不带内容时打开面板；带内容时让她处理这句话并返回回答。',
        unnamedArgumentList: [],
        callback: async (_args, text) => {
          const input = String(text ?? '').trim();
          if (!input) { window.ReaderII?.agent.open('chat'); return ''; }
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
  script.src = `${base}dist/reader-ii.ext.js`;
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
