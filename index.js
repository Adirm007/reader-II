/*
 * Reader-II 酒馆扩展入口。
 * 这里只做三件事：记下扩展自己的地址、等酒馆就绪、在空闲时加载主包（dist/reader-ii.ext.js）。
 * 主包有一兆多，不放在酒馆的启动路径上；语义层、读者界面、提示词、记忆与夜梦助手都在主包里。
 *
 * Reader-II 根据当前聊天与角色卡开关进入大厅或助手。
 */
const entry = new URL(import.meta.url);
const base = new URL('.', entry).href;
window.__ReaderIIBase = base;
window.__ReaderIIQueue = window.__ReaderIIQueue || [];

function context() {
  try { return window.SillyTavern?.getContext?.() ?? null; } catch { return null; }
}

async function getReader() {
  if (!window.ReaderII?.ready && !window.ReaderCore?.loadReaderII) await loadBundle();
  if (window.ReaderII?.ready && window.ReaderII.lobby) return window.ReaderII;
  if (window.ReaderCore?.loadReaderII) return window.ReaderCore.loadReaderII();
  throw new Error('主包缺少启动模块，请重新安装 Reader-II。');
}

async function openReader() {
  try {
    const reader = await getReader();
    return await reader.lobby.open();
  } catch (error) {
    window.toastr?.warning(error.message || String(error), 'Reader-II');
    return false;
  }
}

function addEntries() {
  const menu = document.getElementById('extensionsMenu');
  if (menu && !document.getElementById('reader-ii-menu')) {
    const item = document.createElement('div');
    item.id = 'reader-ii-menu';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.setAttribute('role', 'button');
    item.innerHTML = '<div class="fa-solid fa-book-open extensionsMenuExtensionButton" aria-hidden="true"></div><span>Reader-II</span>';
    item.addEventListener('click', openReader);
    menu.appendChild(item);
  }

  try {
    const ctx = context();
    if (ctx?.SlashCommandParser && ctx?.SlashCommand && !window.__ReaderIISlash) {
      window.__ReaderIISlash = true;
      ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
        name: 'yume',
        helpString: '打开 Reader-II。有角色卡时进入大厅，无卡或本卡停用时进入助手。带内容时让助手回答。',
        unnamedArgumentList: [],
        callback: async (_args, text) => {
          const input = String(text ?? '').trim();
          if (!input) { await openReader(); return ''; }
          const reader = await getReader();
          const result = await reader.agent.run(input, {});
          return result.answer;
        },
      }));
    }
  } catch (error) {
    console.warn('[ReaderII] 斜杠命令注册失败', error);
  }
}

let loading;
function loadBundle() {
  if (loading) return loading;
  const bundle = new URL('dist/reader-ii.ext.js', base);
  const version = entry.searchParams.get('v');
  if (version) bundle.searchParams.set('v', version);
  loading = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-reader-ii]');
    const script = existing || document.createElement('script');
    function failed(message) {
      script.remove();
      reject(new Error(message));
    }
    script.addEventListener('load', () => {
      if (window.ReaderII?.ready || window.ReaderCore?.loadReaderII) resolve();
      else failed('主包没有初始化成功，请检查 Reader-II 扩展文件后重试。');
    }, { once: true });
    script.addEventListener('error', () => failed('未能加载 Reader-II 主包，请检查酒馆连接，再点一次重试。'), { once: true });
    if (!existing) {
      script.src = bundle.href;
      script.dataset.readerIi = '1';
      document.head.appendChild(script);
    }
  }).catch(error => {
    loading = undefined;
    throw error;
  });
  return loading;
}

function start() {
  addEntries();
  const idle = window.requestIdleCallback ?? ((task) => setTimeout(task, 600));
  idle(() => getReader().catch(error => console.warn('[ReaderII]', error.message)), { timeout: 4000 });
}

const ctx = context();
const types = ctx?.eventTypes ?? ctx?.event_types;
if (ctx?.eventSource && types?.APP_READY) ctx.eventSource.once(types.APP_READY, start);
else start();
