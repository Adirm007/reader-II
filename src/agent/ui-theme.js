(function (root) {
  'use strict';

  /*
   * 夜梦助手窗口（ui.js）与语义适配面板（reader-ui-bridge.js）共用的主题样式与图标。
   *
   * 三套主题（咖啡馆 cafe / 盛夏 summer / 水墨 ink）都是「浅色纸面上的深色字」，各自是那个世界里的一件东西，
   * 而不是换了配色的同一块面板：
   *   cafe    胡桃木夹板上夹着的一张点单纸：木框、木纹标题带、顶上一枚黄铜夹，页签像索引标签垂到纸上
   *   summer  一封航空信：红白蓝斜纹信边，名字是一张微微歪着的海蓝签条，页签是分段按钮
   *   ink     宣纸加朱砂双线框：直角、纸面有纤维，左上一枚朱砂印，当前页签下面一道朱砂
   * 取色与材质照上游 reader/ui/src/themes/<主题>/popups.css 开头的变量（--pc-* / --ps-* / --pi-*）。
   *
   * 为什么写得这么「防御」：两个界面都画在酒馆主文档里，酒馆给 select / textarea / input / button / code / 复选框
   * 都写了全局样式（另有一条给所有元素加 text-shadow 的 * 规则，占位符颜色还带 !important）。所以这里每条规则都带着
   * 根节点的 id，表单控件先整体重置再上色；复选框干脆不显示原生控件，旁边画一枚拨动开关。
   * 不用图片：材质是 CSS 渐变与内联 SVG 噪点，图片加载不出来也不会塌；图标是内联 SVG，不用别人机器上可能缺字的符号。
   * 正文一律系统黑体（不让它落到 Windows 的宋体上）；标题在咖啡馆与水墨里用楷体，盛夏用加粗黑体。
   * 不用上游的 u4 子集字体：它们只收了大厅里那些固定文字，新写的标题会缺字。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var THEMES = ['cafe', 'summer', 'ink'];
  var STYLE_ID = 'reader-ii-theme-style';
  var AGENT_ID = 'reader-agent-overlay';
  var PANEL_ID = 'reader-core-panel';

  var FONT = '"PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
  var KAI = '"LXGW WenKai","Kaiti SC","STKaiti","KaiTi",' + FONT;
  var MONO = 'ui-monospace,"Cascadia Code","SF Mono",Consolas,"Liberation Mono",monospace';
  /*
   * 文本类控件；复选框与隐藏域不在内。用 :where() 是为了不给它自己添优先级：整条规则只凭根节点的 id 压过酒馆，
   * 后面写的 select、textarea 以及各处「宽度撑满」的规则才盖得过这条基础规则。
   */
  var FIELD = ':where(input[type="text"],input[type="password"],input[type="number"],input[type="search"],input:not([type]),select,textarea)';

  function svgUrl(svg) { return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")'; }

  /* 下拉框的箭头。data URI 里用不了 currentColor，所以每套主题各带一枚自己颜色的。 */
  function arrow(color) {
    return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>');
  }

  /* 纸面的噪点：frequency 给两个数时横竖不同，出来的是拉长的纤维。matrix 的最后一行决定浓淡。 */
  function noise(frequency, seed, matrix) {
    return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="' + frequency
      + '" numOctaves="3" seed="' + seed + '" stitchTiles="stitch"/><feColorMatrix values="' + matrix + '"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>');
  }

  var CAFE_GRAIN = noise('.8', 7, '0 0 0 0 .36  0 0 0 0 .26  0 0 0 0 .16  0 0 0 .06 0');
  var INK_FIBER = noise('.012 .09', 3, '0 0 0 0 .45  0 0 0 0 .4  0 0 0 0 .3  0 0 0 .09 0');
  var WOOD = 'repeating-linear-gradient(90deg,rgba(0,0,0,.06) 0 3px,transparent 3px 11px),linear-gradient(180deg,#5a3622,#3b2418 45%,#2a1a12)';
  var BRASS = 'linear-gradient(180deg,#f1d89a,#b8894a 55%,#8a6233)';
  var AIRMAIL = 'repeating-linear-gradient(135deg,#c8372d 0 14px,#fbf8f0 14px 22px,#1f6f9a 22px 36px,#fbf8f0 36px 44px)';

  /*
   * 主题变量。--rt-ink3 是最浅的一档字色，三套都调到了在各自纸面上对比度不低于 4.5。
   * --rt-main 是主按钮的底：咖啡馆黄铜、盛夏海蓝（珊瑚色配白字对比度不够，只拿来做点缀）、水墨墨黑。
   */
  var VARS = {
    cafe: [
      '--rt-title:' + KAI,
      '--rt-paper:#f3e8d2', '--rt-card:#fbf5e6', '--rt-field:#fffaf0', '--rt-sunk:#e9dcc2',
      '--rt-ink:#2b211a', '--rt-ink2:#5f4d3d', '--rt-ink3:#756351',
      '--rt-line:rgba(43,33,26,.16)', '--rt-line2:rgba(43,33,26,.34)',
      '--rt-main:' + BRASS, '--rt-main-ink:#2a1c10', '--rt-main-edge:#7a5529',
      '--rt-btn:#fffaf0', '--rt-btn-ink:#2b211a', '--rt-btn-edge:rgba(43,33,26,.34)',
      '--rt-mark:#9e2a20', '--rt-bad:#9e2a20', '--rt-ok:#456e36', '--rt-warn:#8a5d14',
      '--rt-focus:#a87a3c', '--rt-ring:rgba(184,137,74,.34)',
      '--rt-r:3px', '--rt-rb:10px', '--rt-pill:999px',
      '--rt-user:' + WOOD, '--rt-user-ink:#eee7d6', '--rt-ai:#fffaf0',
      '--rt-on:#9e2a20', '--rt-off:rgba(43,33,26,.3)', '--rt-knob:linear-gradient(180deg,#f6e3b0,#c39450)',
      '--rt-veil:radial-gradient(ellipse at 50% 40%,rgba(40,24,14,.55),rgba(8,5,3,.88))', '--rt-blur:3px',
      '--rt-arrow:' + arrow('#5f4d3d')
    ],
    summer: [
      '--rt-title:' + FONT,
      '--rt-paper:#fbf8f0', '--rt-card:#ffffff', '--rt-field:#ffffff', '--rt-sunk:#edf3f2',
      '--rt-ink:#12404c', '--rt-ink2:#4d6d74', '--rt-ink3:#587780',
      '--rt-line:rgba(31,111,154,.18)', '--rt-line2:rgba(31,111,154,.42)',
      '--rt-main:#1f6f9a', '--rt-main-ink:#ffffff', '--rt-main-edge:#154e6e',
      '--rt-btn:#ffffff', '--rt-btn-ink:#154e6e', '--rt-btn-edge:rgba(31,111,154,.5)',
      '--rt-mark:#f07a5f', '--rt-bad:#c8372d', '--rt-ok:#1f7a5c', '--rt-warn:#8f6200',
      '--rt-focus:#1f6f9a', '--rt-ring:rgba(31,111,154,.22)',
      '--rt-r:8px', '--rt-rb:14px', '--rt-pill:999px',
      '--rt-user:#1f6f9a', '--rt-user-ink:#ffffff', '--rt-ai:#ffffff',
      '--rt-on:#1f6f9a', '--rt-off:#aab7bd', '--rt-knob:#ffffff',
      '--rt-veil:linear-gradient(180deg,rgba(207,231,241,.7),rgba(31,111,154,.45))', '--rt-blur:5px',
      '--rt-arrow:' + arrow('#4d6d74')
    ],
    ink: [
      '--rt-title:' + KAI,
      '--rt-paper:#efe6d2', '--rt-card:rgba(255,252,244,.62)', '--rt-field:#fbf7ec', '--rt-sunk:#e6dcc5',
      '--rt-ink:#1d1b18', '--rt-ink2:#3a3631', '--rt-ink3:#655f56',
      '--rt-line:rgba(58,54,49,.2)', '--rt-line2:rgba(58,54,49,.46)',
      '--rt-main:#1d1b18', '--rt-main-ink:#f6f0e2', '--rt-main-edge:#1d1b18',
      '--rt-btn:transparent', '--rt-btn-ink:#1d1b18', '--rt-btn-edge:#3a3631',
      '--rt-mark:#b8322a', '--rt-bad:#b8322a', '--rt-ok:#3f6b52', '--rt-warn:#86601c',
      '--rt-focus:#2f4b6e', '--rt-ring:rgba(47,75,110,.24)',
      '--rt-r:0px', '--rt-rb:2px', '--rt-pill:2px',
      '--rt-user:rgba(185,198,193,.62)', '--rt-user-ink:#1d1b18', '--rt-ai:#f6f0e2',
      '--rt-on:#b8322a', '--rt-off:#c9bfa9', '--rt-knob:#f6f0e2',
      '--rt-veil:radial-gradient(ellipse at 50% 40%,rgba(30,20,14,.45),rgba(20,14,10,.85))', '--rt-blur:3px',
      '--rt-arrow:' + arrow('#3a3631')
    ]
  };

  /*
   * 记号（展开见 expand）：{R} 两个界面的根，{A} 助手窗口，{P} 语义适配面板，{C} {S} {I} 三套主题下的根。
   * 根用 :is(#a,#b) 写，优先级按 id 算，压得过酒馆的全局规则，也不必到处写 !important。
   */
  var RULES = [
    /* ---------- 根：遮罩，变量，基准字体 ---------- */
    '{R}{' + VARS.cafe.join(';') + ';--rt-font:' + FONT + ';--rt-mono:' + MONO + ';box-sizing:border-box;position:fixed;inset:0;margin:0;padding:0;border:0;width:100%;height:100%;max-width:none;max-height:none;overflow:hidden;align-items:center;justify-content:center;background:var(--rt-veil);-webkit-backdrop-filter:blur(var(--rt-blur));backdrop-filter:blur(var(--rt-blur));color:var(--rt-ink);font:15px/1.65 var(--rt-font);letter-spacing:normal;text-align:left;text-shadow:none;color-scheme:light;-webkit-text-size-adjust:100%;outline:none}',
    '{R}[data-theme="summer"]{' + VARS.summer.join(';') + '}',
    '{R}[data-theme="ink"]{' + VARS.ink.join(';') + '}',
    /* <dialog> 没打开时必须保持 display:none，所以只在 [open] 时才排版。 */
    '{A}{z-index:2147483647}',
    '{A}[open]{display:flex}',
    '{A}::backdrop{background:transparent}',
    /* 面板不是 <dialog>，靠 z-index：要盖过读者自己的悬浮信封（2147483646）。 */
    '{P}{z-index:2147483647;display:flex}',

    /* ---------- 重置：把酒馆渗进来的全局样式挡在外面 ---------- */
    '{R} *,{R} *::before,{R} *::after{box-sizing:border-box;text-shadow:none;scrollbar-width:thin;scrollbar-color:var(--rt-line2) transparent}',
    '{R} [hidden]{display:none!important}',
    '{R} ::selection{background:var(--rt-ring)}',
    '{R} button{appearance:none;-webkit-appearance:none;margin:0;padding:0;border:0;border-radius:0;background:none;box-shadow:none;color:inherit;font:inherit;letter-spacing:inherit;text-transform:none;text-align:center;cursor:pointer;opacity:1;filter:none;-webkit-tap-highlight-color:transparent}',
    '{R} button:disabled{cursor:default}',
    '{R} :is(h3,h4,p,pre,ol,ul,dl,dd){margin:0;padding:0}',
    '{R} :is(b,strong){font-weight:700}',
    '{R} i{font-style:normal}',
    '{R} br{display:inline;margin:0}',
    '{R} a{color:var(--rt-mark);text-decoration:underline;text-underline-offset:2px;word-break:break-all}',
    '{R} code{display:inline;padding:1px 5px;border:0;border-radius:3px;background:var(--rt-sunk);color:inherit;font:12.5px/1.5 var(--rt-mono);white-space:pre-wrap;word-break:break-word}',
    '{R} pre{font:12.5px/1.6 var(--rt-mono);white-space:pre-wrap;word-break:break-word}',
    '{R} summary{cursor:pointer;list-style:none}',
    '{R} summary::-webkit-details-marker{display:none}',
    '{R} svg.ra-ico{flex:none;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}',
    '{R} :focus-visible{outline:2px solid var(--rt-focus);outline-offset:2px}',
    '{R} .ra-shell:focus,{R} .ra-shell:focus-visible{outline:none}',

    /* ---------- 表单控件 ---------- */
    '{R} ' + FIELD + '{appearance:none;-webkit-appearance:none;display:inline-block;width:auto;min-width:0;max-width:100%;height:auto;min-height:36px;max-height:none;margin:0;padding:7px 10px;border:1px solid var(--rt-line2);border-radius:var(--rt-r);background-color:var(--rt-field);color:var(--rt-ink);font:14px/1.5 var(--rt-font);letter-spacing:normal;box-shadow:none;outline:none;opacity:1;filter:none;transition:border-color .15s,box-shadow .15s}',
    '{R} ' + FIELD + ':focus{border-color:var(--rt-focus);box-shadow:0 0 0 3px var(--rt-ring);outline:none}',
    /* 酒馆的 textarea::placeholder 带 !important，这里也得带。 */
    '{R} ' + FIELD + '::placeholder{color:var(--rt-ink3)!important;opacity:.75}',
    '{R} ' + FIELD + ':disabled{opacity:.55}',
    '{R} input[type="search"]::-webkit-search-cancel-button{-webkit-appearance:none;display:none}',
    '{R} select{padding-right:30px;background-image:var(--rt-arrow);background-repeat:no-repeat;background-position:right 10px center;background-size:10px 6px;text-overflow:ellipsis;cursor:pointer}',
    '{R} select option,{R} select option:not(:checked){background-color:#fffdf8;color:#222}',
    '{R} textarea{display:block;width:100%;resize:vertical;line-height:1.6}',
    '{R} textarea.is-code{min-height:86px;font:12.5px/1.6 var(--rt-mono)}',

    /* 拨动开关。原生复选框留在原地但看不见（酒馆那条复选框规则的优先级很高，所以每条都带 !important），键盘与读屏照常能用。 */
    '{R} .ra-check{position:relative;display:flex;align-items:flex-start;gap:12px;padding:5px 0;color:var(--rt-ink);font-size:14px;line-height:1.55;cursor:pointer}',
    '{R} .ra-check>span:last-child{flex:1;min-width:0}',
    '{R} .ra-check input[type="checkbox"]{position:absolute!important;left:0!important;top:8px!important;width:1px!important;height:1px!important;min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;outline:0!important;opacity:0!important;overflow:hidden!important;clip-path:inset(50%)!important;appearance:none!important;-webkit-appearance:none!important;transform:none!important;filter:none!important;box-shadow:none!important;display:block!important;pointer-events:none!important}',
    '{R} .ra-check input[type="checkbox"]::before{display:none!important}',
    '{R} .ra-hint{display:block;color:var(--rt-ink2);font-size:12.5px;line-height:1.6}',
    '{R} .ra-switch{flex:none;position:relative;display:inline-block;width:40px;height:22px;margin-top:1px;border-radius:var(--rt-pill);background:var(--rt-off);transition:background .18s}',
    '{R} .ra-switch::after{content:"";position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:var(--rt-pill);background:var(--rt-knob);box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .18s}',
    '{R} input:checked+.ra-switch,{R} [aria-checked="true"]>.ra-switch{background:var(--rt-on)}',
    '{R} input:checked+.ra-switch::after,{R} [aria-checked="true"]>.ra-switch::after{transform:translateX(18px)}',
    '{R} input:focus-visible+.ra-switch,{R} input:focus-visible+.ra-tick{box-shadow:0 0 0 3px var(--rt-ring)}',
    '{R} .ra-switch-btn{flex:none;display:inline-flex;align-items:center;padding:9px 0}',
    '{R} .ra-switch-btn:disabled{opacity:.5}',
    '{R} .ra-switch-row{display:flex;align-items:center;gap:16px}',
    '{R} .ra-switch-row>div{flex:1;min-width:0}',
    /* 「我已核对」这种一次性的确认用方框，不用开关。 */
    '{R} .ra-tick{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-top:2px;border:1.5px solid var(--rt-line2);border-radius:min(var(--rt-r),4px);background:var(--rt-field);color:transparent}',
    '{R} input:checked+.ra-tick{background:var(--rt-on);border-color:var(--rt-on);color:#fff}',

    /* ---------- 按钮、短句、徽标 ---------- */
    '{R} .ra-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:6px 14px;border:1px solid var(--rt-btn-edge);border-radius:var(--rt-r);background:var(--rt-btn);color:var(--rt-btn-ink);font-size:14px;line-height:1.25;white-space:nowrap;transition:background .15s,border-color .15s,color .15s,filter .15s,transform .1s}',
    '{R} .ra-btn:hover:not(:disabled){border-color:var(--rt-ink)}',
    '{R} .ra-btn:active:not(:disabled){transform:translateY(1px)}',
    '{R} .ra-btn:disabled{opacity:.5}',
    '{R} .ra-btn.is-main{background:var(--rt-main);border-color:var(--rt-main-edge);color:var(--rt-main-ink);font-weight:700}',
    '{R} .ra-btn.is-main:hover:not(:disabled){border-color:var(--rt-main-edge);filter:brightness(1.07)}',
    '{R} .ra-btn.is-bad{background:transparent;border-color:var(--rt-bad);color:var(--rt-bad)}',
    /* 「再点一次删除」：第一次点完按钮变成实心的，一眼看得出它等着第二下。 */
    '{R} .ra-btn.is-bad:hover:not(:disabled),{R} .ra-btn[data-armed="1"]{background:var(--rt-bad);border-color:var(--rt-bad);color:#fff}',
    '{R} .ra-btn.is-ghost{background:transparent;border-color:transparent;color:var(--rt-ink2)}',
    '{R} .ra-btn.is-ghost:hover:not(:disabled){border-color:var(--rt-line2);color:var(--rt-ink)}',
    '{R} .ra-btn.is-small{min-height:28px;padding:3px 10px;font-size:12.5px}',
    '{R} .ra-chip{position:relative;display:inline-flex;align-items:center;min-height:30px;padding:3px 13px;border:1px solid var(--rt-line2);border-radius:var(--rt-pill);background:transparent;color:var(--rt-ink2);font-size:13px;line-height:1.3;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}',
    '{R} .ra-chip:hover{background:var(--rt-card);border-color:var(--rt-ink2);color:var(--rt-ink)}',
    '{R} .ra-chip[aria-pressed="true"]{background:var(--rt-ink);border-color:var(--rt-ink);color:var(--rt-paper)}',
    '{R} .ra-badge{flex:none;display:inline-block;padding:0 7px;border:1px solid var(--rt-line2);border-radius:min(var(--rt-r),4px);color:var(--rt-ink2);font-size:12px;line-height:1.65;white-space:nowrap}',
    '{R} .ra-badge.t-episode{border-color:currentColor;color:var(--rt-warn)}',
    '{R} .ra-badge.t-fact{border-color:currentColor;color:var(--rt-ok)}',
    '{R} .ra-badge.t-bond{border-color:currentColor;color:var(--rt-bad)}',
    '{R} .ra-tag{max-width:100%;padding:1px 8px;border-radius:min(var(--rt-r),4px);background:var(--rt-sunk);color:var(--rt-ink2);font-size:12px;line-height:1.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '{R} .ra-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '{R} .ra-note{margin:6px 0;color:var(--rt-ink2);font-size:12.5px;line-height:1.7}',
    '{R} .ra-status{min-height:1.4em;color:var(--rt-ink2);font-size:12.5px;line-height:1.5}',
    '{R} .ra-status.is-bad,{R} .is-error{color:var(--rt-bad)}',
    '{R} .ra-status:empty{display:none}',
    '{R} .ra-good{color:var(--rt-ok)}',
    '{R} .ra-warnc{color:var(--rt-bad)}',

    /* ---------- 外框与标题栏（中性的骨架；材质在下面各主题里） ---------- */
    '{R} .ra-shell{position:relative;display:flex;flex-direction:column;width:min(960px,calc(100% - 56px));height:min(780px,calc(100% - 64px));min-height:0;border-radius:var(--rt-r);background:var(--rt-paper);color:var(--rt-ink)}',
    '{P} .ra-shell{width:min(1080px,calc(100% - 56px));height:min(860px,calc(100% - 64px))}',
    '{R} .ra-head{position:relative;flex:none;display:flex;align-items:center;gap:12px;min-height:60px;padding:10px 14px}',
    '{R} .ra-id{display:flex;align-items:center;gap:10px;min-width:0}',
    '{R} .ra-seal{flex:none;display:flex;align-items:center;justify-content:center;user-select:none}',
    '{R} .ra-name{display:flex;flex-direction:column;align-items:flex-start;min-width:0;line-height:1.25}',
    '{R} .ra-name b{font-size:18px;white-space:nowrap}',
    '{R} .ra-name i{max-width:100%;font-size:11.5px;letter-spacing:.08em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '{R} .ra-head-gap{flex:1}',
    '{R} .ra-tabs{flex:none;display:flex;margin-left:auto}',
    '{R} .ra-tab{display:inline-flex;align-items:center;justify-content:center;font-size:14.5px;white-space:nowrap;transition:background .15s,color .15s}',
    '{R} .ra-back{flex:none;display:inline-flex;align-items:center;gap:4px;height:34px;padding:0 12px 0 8px;border-radius:var(--rt-r);font-size:13.5px;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}',
    '{R} .ra-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:var(--rt-r);transition:background .15s,border-color .15s,color .15s}',

    /* 咖啡馆：夹板与点单纸 */
    '{C} .ra-shell{background:' + CAFE_GRAIN + ',var(--rt-paper);box-shadow:0 0 0 10px #6b4429,0 0 0 11px #2a170c,0 30px 70px rgba(0,0,0,.7)}',
    '{C} .ra-shell::before{content:"";position:absolute;z-index:3;left:50%;top:-24px;width:132px;height:32px;margin-left:-66px;border-radius:7px 7px 3px 3px;background:radial-gradient(circle at 50% 46%,#24140a 0 4px,rgba(255,246,214,.55) 4.6px 5.6px,transparent 6.2px),' + BRASS + ';box-shadow:inset 0 1px 0 rgba(255,250,220,.75),inset 0 -2px 0 rgba(90,60,25,.35),0 3px 7px rgba(0,0,0,.55);pointer-events:none}',
    '{C} .ra-head{padding-bottom:0;border-radius:var(--rt-r) var(--rt-r) 0 0;background:' + WOOD + ';color:#eee7d6;box-shadow:inset 0 -1px 0 #1d100a}',
    '{C} .ra-head>:not(.ra-tabs){margin-bottom:10px}',
    '{C} .ra-name b{font:700 20px/1.2 var(--rt-title);letter-spacing:.14em;text-shadow:0 1px 0 rgba(0,0,0,.45)}',
    '{C} .ra-name i{color:#c9c2b1}',
    '{C} .ra-seal{width:34px;height:34px;border-radius:50%;background:' + BRASS + ';color:#2a1c10;font:700 17px/1 var(--rt-title);box-shadow:inset 0 1px 0 rgba(255,250,220,.7),0 2px 4px rgba(0,0,0,.45)}',
    '{C} .ra-seal i:last-child{display:none}',
    '{C} .ra-tabs{align-self:flex-end;gap:4px}',
    '{C} .ra-tab{padding:8px 20px 9px;border-radius:7px 7px 0 0;background:rgba(238,231,214,.1);box-shadow:inset 0 0 0 1px rgba(238,231,214,.14);color:#c9c2b1;font:16px/1.3 var(--rt-title);letter-spacing:.1em}',
    '{C} .ra-tab:hover{background:rgba(238,231,214,.2);color:#eee7d6}',
    '{C} .ra-tab[aria-selected="true"]{background:var(--rt-paper);box-shadow:0 -2px 6px rgba(0,0,0,.28);color:var(--rt-ink);font-weight:700}',
    '{C} :is(.ra-back,.ra-close){border:1px solid rgba(238,231,214,.32);background:rgba(0,0,0,.16);color:#eee7d6}',
    '{C} :is(.ra-back,.ra-close):hover{border-color:rgba(238,231,214,.65);background:rgba(238,231,214,.16)}',
    '{C} .ra-btn.is-main{box-shadow:inset 0 1px 0 rgba(255,250,220,.7),0 1px 2px rgba(43,33,26,.3)}',
    '{C} .ra-card{box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 2px 6px rgba(43,33,26,.07)}',
    '{C} .ra-ai{box-shadow:0 1px 3px rgba(43,33,26,.1)}',
    '{C} .ra-user{box-shadow:inset 0 0 0 1px rgba(224,190,122,.28),0 2px 5px rgba(43,33,26,.28)}',
    /* 输入框是点单纸的横格：行高与格距都是 28px，字正好落在格子里。 */
    '{C} #ra-text{min-height:56px;padding:0 13px;line-height:28px;background-image:repeating-linear-gradient(180deg,transparent 0 27px,rgba(43,106,160,.14) 27px 28px);background-attachment:local}',

    /* 盛夏：航空信 */
    '{S} .ra-shell{border:10px solid transparent;border-radius:4px;background:linear-gradient(var(--rt-paper),var(--rt-paper)) padding-box,' + AIRMAIL + ' border-box;box-shadow:0 24px 60px rgba(21,78,110,.4)}',
    '{S} .ra-head{border-bottom:1px dashed rgba(31,111,154,.4)}',
    '{S} .ra-name{gap:3px}',
    '{S} .ra-name b{padding:3px 14px 4px;background:#1f6f9a;color:#fbf8f0;font:800 17px/1.3 var(--rt-font);letter-spacing:.14em;transform:rotate(-1.2deg);box-shadow:0 3px 6px rgba(21,78,110,.28)}',
    '{S} .ra-name i{color:var(--rt-ink3)}',
    '{S} .ra-seal{width:38px;height:38px;border:2px solid #f07a5f;border-radius:50%;color:#d9573a;font:800 12px/1 var(--rt-font);transform:rotate(-10deg);box-shadow:inset 0 0 0 2px #fbf8f0,inset 0 0 0 3px rgba(240,122,95,.55)}',
    '{S} .ra-tabs{gap:2px;padding:3px;border:1.5px solid #1f6f9a;border-radius:999px;background:#fff}',
    '{S} .ra-tab{padding:5px 18px;border-radius:999px;color:#1f6f9a;font-size:14px;font-weight:700}',
    '{S} .ra-tab:hover{background:rgba(31,111,154,.1)}',
    '{S} .ra-tab[aria-selected="true"]{background:#1f6f9a;color:#fff}',
    '{S} :is(.ra-back,.ra-close){border:1.5px solid rgba(31,111,154,.45);border-radius:999px;background:#fff;color:#1f6f9a}',
    '{S} :is(.ra-back,.ra-close):hover{border-color:#1f6f9a;background:#1f6f9a;color:#fff}',
    '{S} .ra-card{border-radius:12px;box-shadow:0 2px 10px rgba(21,78,110,.07)}',
    '{S} .ra-card>h3{font-weight:800}',
    '{S} .ra-card>h3::before{width:8px;height:8px;border-radius:50%}',
    '{S} .ra-ai{border-color:rgba(31,111,154,.42)}',

    /* 水墨：宣纸与朱砂框。框是四层内阴影，所以内容要让出 18px。 */
    '{I} .ra-shell{padding:18px;background:' + INK_FIBER + ',linear-gradient(180deg,#f6f0e2,#efe6d2);box-shadow:inset 0 0 0 10px #f6f0e2,inset 0 0 0 12px #b8322a,inset 0 0 0 15px #f6f0e2,inset 0 0 0 16px rgba(184,50,42,.6),0 24px 60px rgba(10,6,4,.6)}',
    '{I} .ra-head{padding:10px 12px;border-bottom:1px solid rgba(58,54,49,.35)}',
    '{I} .ra-name b{font:700 22px/1.2 var(--rt-title);letter-spacing:.22em}',
    '{I} .ra-name i{color:var(--rt-ink3)}',
    '{I} .ra-seal{flex-direction:column;width:32px;height:38px;border-radius:3px 4px 3px 5px;background:#b8322a;color:#f6f0e2;font:700 14px/1.08 var(--rt-title);box-shadow:inset 0 0 0 1.5px rgba(246,240,226,.5)}',
    '{I} .ra-tabs{gap:6px}',
    '{I} .ra-tab{position:relative;padding:8px 14px;color:var(--rt-ink3);font:16px/1.3 var(--rt-title);letter-spacing:.18em}',
    '{I} .ra-tab:hover{color:var(--rt-ink)}',
    '{I} .ra-tab[aria-selected="true"]{color:var(--rt-ink);font-weight:700}',
    '{I} .ra-tab[aria-selected="true"]::after{content:"";position:absolute;left:14px;right:calc(14px + .18em);bottom:2px;height:2px;background:#b8322a}',
    '{I} :is(.ra-back,.ra-close){border:1px solid transparent;color:var(--rt-ink2)}',
    '{I} :is(.ra-back,.ra-close):hover{border-color:var(--rt-line2);color:var(--rt-ink)}',
    '{I} .ra-card>h3{font-size:18px;letter-spacing:.16em}',
    '{I} .ra-ai{border-color:rgba(58,54,49,.42)}',
    '{I} .ra-user{box-shadow:inset 0 0 0 1px rgba(47,75,110,.2)}',

    /* ---------- 对话页 ---------- */
    '{R} .ra-pane{flex:1;min-height:0;display:none;flex-direction:column}',
    '{R} .ra-pane.is-on{display:flex}',
    '{A} .ra-threads{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--rt-line);color:var(--rt-ink2);font-size:13px}',
    '{A} .ra-threads select{flex:1 1 0;width:0;min-width:50px;overflow:hidden;text-overflow:ellipsis}',
    '{A} .ra-threads button{flex:none}',
    '{A} #ra-thread-status{margin:4px 16px 0;font-size:12px;color:var(--rt-ink3)}',
    '{A} .ra-generated{display:block;max-width:100%;height:auto;max-height:60vh;object-fit:contain;margin-top:6px;border-radius:var(--rt-r)}',
    '{A} .ra-checkpoint{border-left:3px solid var(--rt-focus);background:var(--rt-sunk);padding:7px 12px;color:var(--rt-ink2);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}',
    '{R} .ra-log{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:20px 22px 12px;overscroll-behavior:contain}',
    '{R} .ra-msg{max-width:82%;padding:9px 14px;border-radius:var(--rt-rb);line-height:1.7;white-space:pre-wrap;word-break:break-word}',
    '{R} .ra-msg[data-turn-id]:not(.is-editing){display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:6px}',
    '{R} .ra-msg-edit{display:grid;place-items:center;width:28px;height:28px;padding:0;color:inherit;background:transparent;border:0;border-radius:var(--rt-r);opacity:.75;cursor:pointer}',
    '{R} .ra-msg-edit:is(:hover,:focus-visible){opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}',
    '{R} .ra-msg.is-editing{width:min(100%,42rem)}',
    '{R} .ra-msg.is-editing .ra-row{margin-top:6px;white-space:normal}',
    '{R} .ra-ai{align-self:flex-start;border:1px solid var(--rt-line);border-top-left-radius:min(var(--rt-rb),3px);background:var(--rt-ai)}',
    '{R} .ra-user{align-self:flex-end;border-top-right-radius:min(var(--rt-rb),3px);background:var(--rt-user);color:var(--rt-user-ink)}',
    '{R} .ra-msg pre{margin:6px 0;padding:9px 11px;border-radius:min(var(--rt-r),6px);background:var(--rt-sunk);overflow-x:auto;white-space:pre}',
    '{R} .ra-user :is(code,pre){background:rgba(255,255,255,.16)}',
    '{R} .ra-thought{align-self:flex-start;max-width:86%;padding:1px 4px 1px 12px;border-left:2px solid var(--rt-line2);color:var(--rt-ink3);font-size:13.5px;white-space:pre-wrap;word-break:break-word}',
    '{R} .ra-dots{display:inline-flex;align-items:center;gap:8px}',
    '{R} .ra-dots i{width:5px;height:5px;margin-left:-3px;border-radius:50%;background:currentColor;animation:ra-blink 1.2s infinite both}',
    '{R} .ra-dots i:nth-child(2){animation-delay:.2s}',
    '{R} .ra-dots i:nth-child(3){animation-delay:.4s}',
    '{R} .ra-step{align-self:flex-start;max-width:92%;color:var(--rt-ink2);font-size:13px}',
    '{R} .ra-step summary{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:4px 12px 4px 8px;border:1px solid var(--rt-line);border-radius:var(--rt-pill);background:var(--rt-card)}',
    '{R} .ra-step summary>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '{R} .ra-step .st{flex:none;display:inline-flex;width:16px;height:16px}',
    '{R} .ra-step[data-state="run"] .st{color:var(--rt-warn);animation:ra-spin 1.1s linear infinite}',
    '{R} .ra-step[data-state="ok"] .st{color:var(--rt-ok)}',
    '{R} .ra-step[data-state="bad"] .st{color:var(--rt-bad)}',
    '{R} .ra-step pre{margin:6px 0 2px;padding:8px 10px;max-height:180px;overflow:auto;border-radius:min(var(--rt-r),6px);background:var(--rt-sunk);font-size:12px}',
    '{R} .ra-notice{align-self:center;display:inline-flex;align-items:flex-start;gap:6px;max-width:92%;padding:4px 14px;border:1px dashed var(--rt-line2);border-radius:var(--rt-rb);color:var(--rt-ink2);font-size:12.5px;line-height:1.6}',
    '{R} .ra-notice svg{margin-top:2px}',
    '{R} .ra-confirm{align-self:stretch;padding:12px 14px;border:1px solid var(--rt-warn);border-left-width:4px;border-radius:var(--rt-r);background:var(--rt-card)}',
    '{R} .ra-confirm.is-danger{border-color:var(--rt-bad)}',
    /* 答完之后收成一行记录，不再占着一大块、也不再抢眼。 */
    '{R} .ra-confirm.is-done{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;padding:6px 12px;border-color:var(--rt-line);border-left-color:var(--rt-line2);background:transparent;color:var(--rt-ink2);font-size:13.5px}',
    '{R} .ra-confirm.is-done .ra-note{margin:0}',
    '{R} .ra-confirm h4{margin:0 0 4px;font-size:14.5px;font-weight:700}',
    '{R} .ra-confirm pre{margin:8px 0 10px;padding:8px 10px;max-height:150px;overflow:auto;border-radius:min(var(--rt-r),6px);background:var(--rt-sunk);color:var(--rt-ink2);font-size:12px}',
    '{R} .ra-quick{flex:none;display:flex;flex-wrap:wrap;gap:8px;padding:2px 22px 12px}',
    '{R} .ra-input{flex:none;display:flex;align-items:flex-end;gap:10px;padding:12px 22px 8px;border-top:1px solid var(--rt-line)}',
    '{A} #ra-text{flex:1;width:auto;min-height:48px;max-height:160px;padding:11px 13px;resize:none;font-size:15px;line-height:1.6;overflow-y:auto}',
    '{A} #ra-send{flex:none;min-width:76px;min-height:48px;padding:0 20px;font-size:15px}',
    '{A} #ra-send.is-bad{background:var(--rt-bad);border-color:var(--rt-bad);color:#fff}',
    '{R} .ra-foot{flex:none;display:flex;align-items:center;gap:10px;padding:0 22px 14px;color:var(--rt-ink3);font-size:12px}',
    '{R} .ra-tags{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:6px}',
    '{A} #ra-foot-text{display:contents}',
    '{A} #ra-tool-mode{cursor:pointer}',
    '{A} #ra-tool-mode[data-mode="none"]{color:var(--rt-bad)}',

    /* ---------- 记忆页与设置页 ---------- */
    '{R} .ra-scroll{position:relative;flex:1;min-width:0;min-height:0;overflow-y:auto;padding:20px 22px;overscroll-behavior:contain}',
    '{R} .ra-card{margin:0 0 14px;padding:16px 18px;border:1px solid var(--rt-line);border-radius:var(--rt-r);background:var(--rt-card)}',
    '{R} .ra-card>h3{display:flex;align-items:center;gap:10px;margin:0 0 10px;color:var(--rt-ink);font:700 16.5px/1.3 var(--rt-title);letter-spacing:.08em}',
    '{R} .ra-card>h3::before{content:"";flex:none;width:4px;height:15px;border-radius:1px;background:var(--rt-mark)}',
    '{R} .ra-live{margin-left:auto;padding:0 8px;border-radius:var(--rt-pill);background:var(--rt-sunk);color:var(--rt-ink3);font:400 11.5px/1.8 var(--rt-font);letter-spacing:.04em;white-space:nowrap}',
    '{R} .ra-group{display:flex;align-items:center;gap:10px;margin:18px 0 8px;color:var(--rt-ink3);font-size:12.5px;font-weight:700;letter-spacing:.14em}',
    '{R} .ra-group::after{content:"";flex:1;height:1px;background:var(--rt-line)}',
    '{R} .ra-card>h3+.ra-group{margin-top:4px}',
    '{R} .ra-sub{margin:18px 0 6px;font-size:14px;font-weight:700}',
    '{R} .ra-form{display:grid;grid-template-columns:132px minmax(0,1fr);gap:10px 14px;align-items:center}',
    '{R} .ra-form>label:not(.ra-check){color:var(--rt-ink2);font-size:13.5px}',
    '{R} .ra-form>' + FIELD + '{width:100%}',
    '{R} .ra-form>.wide{grid-column:1/-1}',
    '{A} .ra-model-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,208px),1fr));align-items:end;gap:10px 14px}',
    '{A} .ra-model-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:13px;color:var(--rt-ink2)}',
    '{A} .ra-model-field input,{A} .ra-model-field textarea,{A} .ra-model-field select{width:100%;min-width:0}',
    '{A} .ra-model-picker{grid-column:1/-1;display:flex;align-items:end;gap:6px 10px;flex-wrap:wrap}',
    '{A} .ra-model-picker .ra-model-field{flex:1 1 210px}',
    '{A} .ra-model-picker select{flex:1 1 180px;min-width:0;max-width:100%}',
    '{A} .ra-model-picker [data-model-hint]:not(:empty){flex-basis:100%}',
    '{A} .ra-role{border:1px solid var(--rt-line);border-radius:var(--rt-r);min-width:0;padding:10px 12px;margin:8px 0 12px}',
    '{A} .ra-role legend{padding:0 5px;color:var(--rt-ink2);font-weight:bold}',
    '{A} #ra-preset-form,{A} .ra-model-field+button{margin-top:8px}',
    '{R} .ra-nums{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px 12px;margin:8px 0 4px}',
    '{R} .ra-num{display:flex;flex-direction:column;gap:4px;color:var(--rt-ink2);font-size:12.5px}',
    '{R} .ra-num input{width:100%}',
    '{R} .ra-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 14px;margin:6px 0 10px;font-size:13.5px}',
    '{R} .ra-kv dt{color:var(--rt-ink2)}',
    '{R} .ra-kv dd{min-width:0;word-break:break-all}',
    '{R} .ra-rule{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:8px;align-items:center;margin:6px 0}',
    '{R} .ra-probe{display:flex;align-items:flex-start;gap:8px;margin:6px 0;font-size:13.5px}',
    '{R} .ra-probe>svg{margin-top:3px}',
    '{R} .ra-probe[data-ok="1"]>svg{color:var(--rt-ok)}',
    '{R} .ra-probe[data-ok="0"]>svg{color:var(--rt-bad)}',
    '{R} .ra-probe b{flex:none}',
    '{R} .ra-probe span{min-width:0;color:var(--rt-ink2);word-break:break-word}',
    '{R} .ra-tip{margin:8px 0 0;padding:8px 12px;border-left:3px solid var(--rt-mark);background:var(--rt-sunk);font-size:13px;line-height:1.65}',
    '{R} .ra-tip.is-bad{border-left-color:var(--rt-bad)}',
    '{R} .ra-list{margin:6px 0;padding-left:20px;font-size:13.5px;line-height:1.7}',
    '{R} .ra-list li{margin:3px 0}',
    '{R} details.ra-fold{margin:12px 0 0}',
    '{R} details.ra-fold>summary{display:inline-flex;align-items:center;gap:6px;color:var(--rt-ink2);font-size:13px}',
    '{R} details.ra-fold>summary svg{transition:transform .15s}',
    '{R} details.ra-fold[open]>summary svg{transform:rotate(180deg)}',
    '{R} details.ra-fold>textarea{margin:8px 0}',
    '{R} .ra-item{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px 12px;padding:10px 0;border-top:1px solid var(--rt-line)}',
    '{R} .ra-item-main{flex:1 1 220px;min-width:0}',
    '{R} .ra-item-main .ra-note{margin:2px 0 0;word-break:break-all}',
    '{R} .ra-run{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--rt-line);font-size:13.5px}',
    '{R} .ra-run:first-child{border-top:0}',
    '{R} .ra-run>span{min-width:0;word-break:break-word}',
    '{R} .ra-membar{display:flex;flex-wrap:wrap;align-items:center;gap:10px}',
    '{R} .ra-inline{flex:1 1 260px;min-width:0;display:inline-flex;align-items:center;gap:8px;color:var(--rt-ink2);font-size:13.5px}',
    '{R} .ra-inline select{flex:1;min-width:0}',
    '{R} .ra-facts{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 4px}',
    '{R} .ra-filter{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:4px 0 12px}',
    '{R} .ra-sep{flex:none;width:1px;height:18px;margin:0 2px;background:var(--rt-line2)}',
    '{R} .ra-search{position:relative;flex:1 1 160px;min-width:0;display:flex}',
    '{R} .ra-search>svg{position:absolute;left:10px;top:50%;margin-top:-8px;color:var(--rt-ink3)}',
    '{R} .ra-search>input{width:100%;padding-left:32px}',
    '{R} .ra-empty{padding:26px 10px;color:var(--rt-ink3);font-size:13.5px;text-align:center}',
    '{R} .ra-mem{margin:0 0 10px;padding:12px 14px;border:1px solid var(--rt-line);border-radius:var(--rt-r);background:var(--rt-card)}',
    '{R} .ra-mem-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}',
    '{R} .ra-mem-title{flex:1;min-width:120px;font-weight:700}',
    '{R} .ra-mem-body{margin:6px 0;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word}',
    '{R} .ra-mem-keys{color:var(--rt-ink3);font-size:12px}',
    '{R} .ra-mem .ra-row{margin-top:8px}',
    '{R} .ra-stars{flex:none;display:inline-flex;gap:3px}',
    '{R} .ra-stars i{width:6px;height:6px;border-radius:50%;background:var(--rt-line2)}',
    '{R} .ra-stars i.on{background:var(--rt-mark)}',
    /* 设置页：左边一列目录，右边滚动；「保存设置」固定在底部。 */
    '{R} .ra-set{flex:1;min-height:0;display:grid;grid-template-columns:172px minmax(0,1fr)}',
    '{R} .ra-toc{min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:18px 10px 18px 16px;border-right:1px solid var(--rt-line)}',
    '{R} .ra-toc button{flex:none;display:block;width:100%;padding:7px 12px;border-radius:var(--rt-r);color:var(--rt-ink2);font-size:13.5px;line-height:1.4;text-align:left;white-space:nowrap;transition:background .15s,color .15s}',
    '{R} .ra-toc button:hover{background:var(--rt-card);color:var(--rt-ink)}',
    '{R} .ra-toc button[aria-current="true"]{background:var(--rt-card);box-shadow:inset 3px 0 0 var(--rt-mark);color:var(--rt-ink);font-weight:700}',
    '{R} .ra-savebar{flex:none;display:flex;align-items:center;gap:12px;padding:10px 22px;border-top:1px solid var(--rt-line);background:var(--rt-card)}',
    '{R} .ra-savebar .ra-status,{R} .ra-savebar .ra-status:empty{display:block;flex:1;min-width:0;min-height:0}',
    '{R} .ra-dirty{flex:none;color:var(--rt-warn);font-size:12.5px}',

    /* ---------- 语义适配面板 ---------- */
    '{P} .rp-body{flex:1;min-height:0;display:grid;grid-template-columns:236px minmax(0,1fr)}',
    '{P} .rp-rail{min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:20px 14px 20px 20px;border-right:1px solid var(--rt-line)}',
    '{P} .rp-stat{padding:14px 16px;border:1px solid var(--rt-line);border-radius:var(--rt-r);background:var(--rt-card)}',
    '{P} .rp-label{display:block;margin:0 0 4px;color:var(--rt-ink3);font-size:12px;font-weight:700;letter-spacing:.14em}',
    '{P} .rp-balance{display:flex;align-items:baseline;gap:6px}',
    '{P} .rp-balance b{font:700 30px/1.15 var(--rt-title);word-break:break-all}',
    '{P} .rp-balance span{color:var(--rt-mark);font-size:12px;font-weight:700;letter-spacing:.1em}',
    '{P} .rp-health{display:flex;align-items:flex-start;gap:8px;font-size:13.5px;line-height:1.6}',
    '{P} .rp-dot{flex:none;width:8px;height:8px;margin-top:7px;border-radius:50%;background:var(--rt-ok);box-shadow:0 0 0 3px var(--rt-line)}',
    '{P} .rp-main{min-width:0;min-height:0;overflow-y:auto;padding:20px 22px 26px;overscroll-behavior:contain}',
    '{P} .rp-llm{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:0}',
    '{P} .rp-copy{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:1px}',
    '{P} .rp-copy strong{font-size:15px}',
    '{P} .rp-copy span{color:var(--rt-ink3);font:12px/1.5 var(--rt-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '{P} .rp-llm-settings{flex:1 1 100%;padding-top:14px;border-top:1px dashed var(--rt-line2)}',
    '{P} .rp-seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--rt-line2);border-radius:var(--rt-r);background:var(--rt-sunk)}',
    '{P} .rp-seg button{min-height:30px;padding:4px 16px;border-radius:min(var(--rt-r),6px);color:var(--rt-ink2);font-size:13.5px}',
    '{P} .rp-seg button[aria-pressed="true"]{background:var(--rt-field);box-shadow:0 1px 2px rgba(0,0,0,.14);color:var(--rt-ink);font-weight:700}',
    '{P} .rp-api{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:10px 12px;margin-top:12px}',
    '{P} .rp-field{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--rt-ink2);font-size:12.5px}',
    '{P} .rp-field.is-wide{grid-column:1/-1}',
    '{P} .rp-field ' + FIELD + '{width:100%}',
    '{P} .rp-model{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}',
    '{P} .rp-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 16px;margin:22px 0 12px}',
    '{P} .rp-head h3{font:700 19px/1.3 var(--rt-title);letter-spacing:.1em}',
    '{P} .rp-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '{P} .rp-batch{flex:1 1 100%;color:var(--rt-ink2);font-size:12.5px;white-space:pre-line}',
    '{P} .rp-route{margin:0 0 10px;border:1px solid var(--rt-line);border-radius:var(--rt-r);background:var(--rt-card);overflow:hidden}',
    '{P} .rp-route[open]{border-color:var(--rt-line2)}',
    '{P} .rp-route>summary{display:grid;grid-template-columns:34px minmax(0,1fr) auto 16px;align-items:center;gap:12px;min-height:60px;padding:10px 16px;user-select:none}',
    '{P} .rp-route>summary:hover{background:var(--rt-sunk)}',
    '{P} .rp-num{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid var(--rt-line2);border-radius:50%;color:var(--rt-mark);font:700 12px/1 var(--rt-mono)}',
    '{P} .rp-state[data-state="active"]{border-color:currentColor;color:var(--rt-ok)}',
    '{P} .rp-state[data-state="draft"]{border-color:currentColor;color:var(--rt-warn)}',
    '{P} .rp-state[data-state="broken"]{border-color:currentColor;color:var(--rt-bad)}',
    '{P} .rp-chev{display:inline-flex;color:var(--rt-ink3);transition:transform .16s}',
    '{P} .rp-route[open] .rp-chev{transform:rotate(180deg)}',
    '{P} .rp-route-body{padding:4px 16px 16px;border-top:1px solid var(--rt-line)}',
    '{P} .rp-req{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 16px;margin:12px 0 0;color:var(--rt-ink2);font-size:12.5px}',
    '{P} .rp-warn{margin:12px 0 0;padding:8px 12px;border-left:3px solid var(--rt-bad);background:var(--rt-sunk);font-size:13px;line-height:1.65}',
    '{P} .rp-route .ra-search{margin-top:10px}',
    '{P} .reader-ui-tree{max-height:300px;overflow:auto;margin-top:8px;padding:6px;border:1px solid var(--rt-line2);border-radius:var(--rt-r);background:var(--rt-field)}',
    '{P} .reader-ui-tree-row{display:grid;grid-template-columns:28px minmax(0,1fr);align-items:stretch;gap:4px;margin:1px 0}',
    '{P} .reader-ui-tree-toggle{display:flex;align-items:center;justify-content:center;width:28px;min-height:32px;border-radius:var(--rt-r);color:var(--rt-ink3)}',
    '{P} .reader-ui-tree-toggle:hover{background:var(--rt-sunk);color:var(--rt-ink)}',
    '{P} .reader-ui-tree-toggle svg{transition:transform .14s}',
    '{P} .reader-ui-tree-toggle[aria-expanded="true"] svg{transform:rotate(90deg)}',
    '{P} .reader-ui-tree-spacer{width:28px}',
    '{P} .reader-ui-tree-pick{display:grid;grid-template-columns:minmax(110px,.85fr) minmax(0,1.5fr);align-items:center;gap:14px;min-width:0;min-height:32px;padding:5px 9px;border:1px solid transparent;border-radius:var(--rt-r);text-align:left}',
    '{P} .reader-ui-tree-pick:hover{background:var(--rt-sunk)}',
    '{P} .reader-ui-tree-pick[aria-pressed="true"]{border-color:var(--rt-line2);background:var(--rt-sunk);box-shadow:inset 3px 0 0 var(--rt-mark)}',
    '{P} .reader-ui-tree-name{min-width:0;display:flex;align-items:center;gap:8px;font-size:13.5px;overflow-wrap:anywhere}',
    '{P} .reader-ui-tree-node-mark{flex:none;width:6px;height:6px;border:1px solid var(--rt-ink3);border-radius:50%}',
    '{P} .reader-ui-tree-pick[aria-pressed="true"] .reader-ui-tree-node-mark{border-color:var(--rt-mark);background:var(--rt-mark)}',
    '{P} .reader-ui-tree-meta{min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;color:var(--rt-ink3);font:12px/1.4 var(--rt-mono);overflow:hidden}',
    '{P} .reader-ui-tree-type{flex:none;padding:1px 6px;border:1px solid var(--rt-line);border-radius:3px}',
    '{P} .reader-ui-tree-preview{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '{P} .reader-ui-tree-children{margin-left:14px;padding-left:6px;border-left:1px solid var(--rt-line)}',
    '{P} .rp-selected{margin-top:8px;color:var(--rt-ink2);font:12.5px/1.5 var(--rt-mono);overflow-wrap:anywhere}',
    '{P} .rp-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}',
    '{P} .rp-actions .ra-check{padding:0;font-size:13.5px}',
    '{P} .rp-actions .is-bad{margin-left:auto}',
    '{P} .rp-status{margin-top:8px;color:var(--rt-ink2);font-size:12.5px;white-space:pre-line}',
    '{P} .rp-status:empty{display:none}',
    '{P} .rp-pre{max-height:180px;overflow:auto;margin:10px 0 0;padding:10px 12px;border:1px solid var(--rt-line);border-radius:var(--rt-r);background:var(--rt-sunk);color:var(--rt-ink2);font-size:12px}',
    '{P} .rp-request{margin-top:10px;border:1px solid var(--rt-line);border-radius:var(--rt-r)}',
    '{P} .rp-request>summary{padding:8px 12px;color:var(--rt-ink2);font-size:12.5px}',
    '{P} .rp-request>pre{max-height:230px;overflow:auto;padding:10px 12px;border-top:1px solid var(--rt-line);color:var(--rt-ink2);font-size:12px}',
    /* 出错的状态行：放在面板这几条之后，才压得过它们各自的字色。 */
    '{P} .is-error{color:var(--rt-bad)}',

    '@keyframes ra-blink{0%,80%,100%{opacity:.2}40%{opacity:1}}',
    '@keyframes ra-spin{to{transform:rotate(360deg)}}',

    /* ---------- 窄屏：面板里的侧栏先收到上面 ---------- */
    '@media (max-width:760px){'
      + '{P} .rp-body{display:block;overflow-y:auto;overscroll-behavior:contain}'
      + '{P} .rp-rail{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;overflow:visible;padding:14px 12px 0;border-right:0}'
      + '{P} .rp-rail>.ra-note{grid-column:1/-1;margin:0}'
      + '{P} .rp-stat{padding:12px 14px}'
      + '{P} .rp-balance b{font-size:24px}'
      + '{P} .rp-main{overflow:visible;padding:14px 12px 22px}'
      + '{P} .rp-api{grid-template-columns:minmax(0,1fr)}'
      + '}',

    /* ---------- 手机：铺满，框收窄，标题栏两行，控件字号 16px（iOS 小于 16px 会自动放大页面），触控目标不小于 40px ---------- */
    '@media (max-width:640px){'
      + '{R} .ra-shell{width:100%;height:100%;border-radius:0}'
      + '{C} .ra-shell{border:5px solid #5a3622;box-shadow:none}'
      + '{C} .ra-shell::before{display:none}'
      + '{S} .ra-shell{border-width:6px;border-radius:0;box-shadow:none}'
      + '{I} .ra-shell{padding:9px;box-shadow:inset 0 0 0 3px #f6f0e2,inset 0 0 0 4px #b8322a,inset 0 0 0 6px #f6f0e2,inset 0 0 0 7px rgba(184,50,42,.6)}'
      + '{R} .ra-head{flex-wrap:wrap;gap:8px 10px;min-height:0;padding:8px 10px}'
      + '{R} .ra-id{flex:1}'
      + '{R} .ra-head-gap{display:none}'
      + '{R} .ra-back{height:40px}'
      + '{R} .ra-close{width:40px;height:40px}'
      + '{R} .ra-tabs{order:5;width:100%;margin-left:0}'
      + '{R} .ra-tab{flex:1;min-height:40px}'
      + '{C} .ra-head{padding-bottom:0}'
      + '{C} .ra-head>:not(.ra-tabs){margin-bottom:0}'
      + '{P}[data-theme="cafe"] .ra-head{padding-bottom:8px}'
      + '{C} .ra-name b{font-size:18px}'
      + '{I} .ra-name b{font-size:19px;letter-spacing:.16em}'
      + '{I} .ra-head{padding:6px 6px 4px}'
      + '{R} ' + FIELD + '{min-height:40px;font-size:16px}'
      + '{R} textarea.is-code{font-size:16px}'
      + '{R} .ra-btn,{R} .ra-btn.is-small{min-height:40px}'
      + '{R} .ra-btn.is-small{padding:6px 12px;font-size:13px}'
      + '{R} .ra-chip{min-height:34px}'
      + '{R} .ra-chip::after{content:"";position:absolute;inset:-4px 0}'
      + '{R} .ra-log{padding:14px 12px 8px}'
      + '{R} .ra-msg{max-width:92%}'
      + '{R} .ra-quick{flex-wrap:nowrap;overflow-x:auto;padding:2px 12px 10px;scrollbar-width:none}'
      + '{R} .ra-quick::-webkit-scrollbar,{R} .ra-toc::-webkit-scrollbar{display:none}'
      + '{R} .ra-input{padding:10px 12px 6px}'
      + '{A} #ra-text{font-size:16px}'
      + '{A} #ra-send{min-width:68px;padding:0 16px}'
      + '{R} .ra-foot{padding:0 12px 10px}'
      + '{R} .ra-scroll{padding:14px 12px}'
      + '{R} .ra-card{padding:14px}'
      + '{R} .ra-form{grid-template-columns:minmax(0,1fr);gap:6px}'
      + '{R} .ra-form>label:not(.ra-check){margin-top:6px}'
      + '{R} .ra-rule{grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto}'
      + '{R} .ra-rule>input{grid-column:1/-1;grid-row:2}'
      + '{R} .ra-set{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}'
      + '{R} .ra-toc{flex-direction:row;overflow-x:auto;overflow-y:hidden;gap:6px;padding:8px 12px;border-right:0;border-bottom:1px solid var(--rt-line);scrollbar-width:none}'
      + '{R} .ra-toc button{width:auto;min-height:40px;padding:8px 14px}'
      + '{R} .ra-toc button[aria-current="true"]{box-shadow:inset 0 -3px 0 var(--rt-mark)}'
      + '{R} .ra-savebar{padding:8px 12px}'
      + '{P} .rp-route>summary{grid-template-columns:30px minmax(0,1fr) auto 16px;gap:10px;padding:10px 12px}'
      + '{P} .rp-route-body{padding:4px 12px 14px}'
      + '{P} .rp-seg button{min-height:40px}'
      + '{P} :is(.reader-ui-tree-toggle,.reader-ui-tree-pick){min-height:40px}'
      + '{P} .reader-ui-tree-pick{grid-template-columns:minmax(90px,1fr) minmax(0,1fr);gap:8px}'
      + '{P} .reader-ui-tree-preview{display:none}'
      + '{P} .rp-actions .is-bad{margin-left:0}'
      + '}',
    '@media (prefers-reduced-motion:reduce){{R} *,{R} *::before,{R} *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}'
  ];

  function expand(css) {
    var both = ':is(#' + AGENT_ID + ',#' + PANEL_ID + ')';
    var themed = { C: 'cafe', S: 'summer', I: 'ink' };
    return css.replace(/\{([RAPCSI])\}/g, function (all, key) {
      if (key === 'R') return both;
      if (key === 'A') return '#' + AGENT_ID;
      if (key === 'P') return '#' + PANEL_ID;
      return both + '[data-theme="' + themed[key] + '"]';
    });
  }

  var CSS = expand(RULES.join('\n'));

  /* 图标：16×16 的线条，颜色跟着文字走。 */
  var ICONS = {
    back: '<path d="M10 3 5 8l5 5"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/>',
    chevron: '<path d="M4 6l4 4 4-4"/>',
    caret: '<path d="M6 4l4 4-4 4"/>',
    pencil: '<path d="m3 10-.5 3.5L6 13l7-7a1.4 1.4 0 0 0 0-2l-1-1a1.4 1.4 0 0 0-2 0Zm6-6 3 3"/>',
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    cross: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    ban: '<circle cx="8" cy="8" r="5.2"/><path d="M4.4 11.6 11.6 4.4"/>',
    spin: '<path d="M8 2.8a5.2 5.2 0 1 0 5.2 5.2"/>',
    info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3v3.5M8 5.1v.3"/>'
  };

  function icon(name) {
    return '<svg class="ra-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' + (ICONS[name] || '') + '</svg>';
  }

  /*
   * 当前主题：聊天变量 dream_visual_theme（用户在彩蛋服务台里换主题时写的），没有就看本机的兜底键，再没有就是咖啡馆。
   * 每次打开窗口时取一次，所以换了主题后下次打开就跟着变。
   */
  function themeName(env, kit) {
    var value = '';
    try { value = kit && typeof kit.readChatValue === 'function' ? kit.readChatValue('dream_visual_theme') : ''; } catch (error) { value = ''; }
    if (THEMES.indexOf(value) < 0) {
      try { value = env && env.storage ? env.storage.getItem(modules.localKey('dream_visual_theme')) : ''; } catch (error) { value = ''; }
    }
    return THEMES.indexOf(value) >= 0 ? value : 'cafe';
  }

  function ensure(doc) {
    if (!doc || !doc.createElement) return;
    var style = doc.getElementById(STYLE_ID);
    if (!style) {
      style = doc.createElement('style');
      style.id = STYLE_ID;
      (doc.head || doc.documentElement || doc.body).appendChild(style);
    }
    if (style.textContent !== CSS) style.textContent = CSS;
  }

  function remove(doc) {
    var style = doc && doc.getElementById ? doc.getElementById(STYLE_ID) : null;
    if (style) style.remove();
  }

  modules.READER_THEMES = THEMES;
  modules.readerTheme = { name: themeName, ensure: ensure, remove: remove, icon: icon, css: CSS, AGENT_ID: AGENT_ID, PANEL_ID: PANEL_ID };
})(typeof globalThis !== 'undefined' ? globalThis : window);
