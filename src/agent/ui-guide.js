(function (root) {
  'use strict';

  /*
   * 功能说明子页面：分三大模块展示 Reader-II 全部能力，替代分散在设置表单里的长段注释。
   *   1. 前端设置调整
   *   2. 卡内使用功能
   *   3. Agent 功能
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  var SECTIONS = [
    ['ra-guide-frontend', '前端设置调整'],
    ['ra-guide-card', '卡内使用功能'],
    ['ra-guide-agent', 'Agent 功能']
  ];

  function tile(title, body) {
    return '<div class="ra-guide-tile"><h4>' + title + '</h4><p>' + body + '</p></div>';
  }

  function tableRows(rows) {
    return '<table class="ra-guide-table"><tbody>' + rows.map(function (row) {
      return '<tr><th>' + row[0] + '</th><td>' + row[1] + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  function frontendCard(card) {
    return card('ra-guide-frontend', '前端设置调整',
      '<p class="ra-guide-lead">所有设置集中在「设置」页；顶栏标注「立即生效」或「单独保存」的区块即时应用，其余选项点击底部「保存设置」统一落盘。</p>'
      + '<div class="ra-guide-grid">'
      + tile('按卡启停与正文位置', '在「这张卡」独立开关当前角色卡的 Reader-II 注入与记账；关闭后保留历史记录。「正文提示词位置」控制读者核心、变量更新规则与变量列表的插入位置、顺序、深度、角色或 <code>{{outlet::名称}}</code> 出口。')
      + tile('权限档位与规则', '提供 <b>只读 / 单卡 / 酒馆全权 / 设备全权</b> 四档权限，以及 <b>每次询问 / 档位内自动 / 全部自动</b> 三种确认方式。权限规则按路径或工具名匹配（<code>*</code> 不跨层级，<code>**</code> 跨层级），禁止规则优先。')
      + tile('人格、外貌与系统提示', '可分别覆写当前人格提示词、大厅装扮对应的外貌描述（用于正文、聊天与自拍），以及所有人格共用的助手专用系统提示词。清空后保存即可恢复原文。')
      + tile('工具调用与轮数', '默认「自动」优先走原生函数调用，不兼容时自动退回文本协议；遇到模型只说不做可点「测试工具调用」自检。单任务工具轮数按批次计，用完后可在对话中直接追加。')
      + tile('模型连接、子代理与媒体', '支持在独立 API 方案表中维护多个端点，并为主模型按连接分别保存上下文窗口、思考档位、图片接口与反代额外 JSON 参数。子代理支持沿用主模型、按角色分工或智能选模；图片与视频工具可独立配置。')
      + tile('记忆、插件、MCP 与伴侣', '助手记忆支持按聊天保存或跨存档写入《夜之洋》，开启「助手夜梦 = 正文夜梦」后可按深度与预算带入正文。插件对接、MCP（HTTP / stdio）、GitHub 令牌、免问网站与后端伴侣均可在设置页一站管理。')
      + '</div>'
      + '<div class="ra-row ra-mt">'
      + '<button type="button" class="ra-btn is-small" data-act="guide-jump" data-tab-target="settings" data-section="ra-agent-card">前往助手设置</button>'
      + '<button type="button" class="ra-btn is-small" data-act="guide-jump" data-tab-target="settings" data-section="ra-model-card">前往主模型设置</button>'
      + '<button type="button" class="ra-btn is-small" data-act="guide-jump" data-tab-target="settings" data-section="ra-conn-card">前往插件对接</button>'
      + '</div>');
  }

  function cardFeaturesCard(card) {
    return card('ra-guide-card', '卡内使用功能',
      '<p class="ra-guide-lead">在已启用 Reader-II 的角色卡上，点击酒馆扩展菜单「Reader-II」或发送 <code>/yume</code> 打开读者大厅；无卡或停用卡时直接进入夜梦助手。</p>'
      + '<div class="ra-guide-grid">'
      + tile('读者来信与换装主题', '正文中的 <code>&lt;dream&gt;</code> 片段自动渲染为悬浮轻信，记账与任务事件块在展示和提示词发送时自动隐藏。服务台支持切换 <b>咖啡馆 / 盛夏 / 水墨</b> 三套视觉主题与多套人格装扮，助手窗口与语义面板自动同步主题。')
      + tile('FP 与七槽语义适配', '将 <b>当前地点、重要角色、任务、技能、状态、货币、背包</b> 七个语义槽映射到宿主卡变量，兼容 MVU、小白X（2.0 / 3.0）与纯文字卡。未绑定槽位自动使用 <code>stat_data.READER</code> 后备；绑定货币槽后，FP 增减直接联动宿主货币。')
      + tile('读者大厅与定调书架', '大厅内置定调、主题写入、书架、相册与棋局等互动模块，并支持通过服务台四个快捷入口一键直达对话、助手设置、记忆管理与语义适配面板。')
      + tile('命运抽卡与角色条目', '在命运抽卡中消费 FP 抽取书页与物品并自动入包（绑定背包槽时直接写入宿主背包）；开启角色条目生成后，抽到角色书页可按模板自动生成并管理对应世界书条目。')
      + '</div>');
  }

  function agentCard(card) {
    return card('ra-guide-agent', 'Agent 功能',
      '<p class="ra-guide-lead">夜梦助手内置统一虚拟文件系统（VFS）、按需知识库、插件工具箱与按轮撤销机制，可在当前酒馆环境中直接完成查错、改卡、制卡、联网研究与本机协作。</p>'
      + '<div class="ra-guide-grid">'
      + tile('专业制卡与排错工具箱', '自动探测并接入酒馆常用插件：<b>MVU</b> 支持只读查看与 <code>mvu_test_update</code> 无副作用试跑更新；<b>EJS</b> 支持只读语法检查、变量表与开关检查；<b>小白X</b> 同时支持变量 2.0（<code>&lt;state&gt;</code> / JSON 批量写入 / 模板查看）与变量 3.0（规则导出、草案校验试算、动作预览/结算与撤销）。')
      + tile('按需知识库（kb:/）', '内置 MVU Beta &amp; MVUzod、EJS 提示词模板、小白X 2.0/3.0、制卡流程、故障排查、插件对接、MCP 与设备开发等技能；需要更细文档时自动按需拉取上游手册并缓存，也可在 <code>ws:/skills/</code> 编写个人工作流。')
      + tile('多对话、编辑与按轮撤销', '助手对话按角色卡隔离，支持新建/切换/删除线程、编辑任意历史消息，以及在回复中直接渲染生成的图片与视频。助手每次文件修改都会留存镜像，可在「设置 → 改动记录」按轮一键撤销。')
      + tile('子代理与外部扩展', '复杂任务可派发给子代理执行；通过 <code>gh:/</code> 直接浏览 GitHub 仓库并支持 <code>github_push</code> 推送工作区文件；接入 MCP 服务器与后端伴侣后，还可操作本地文件、运行命令与驱动无头浏览器验证页面。')
      + '</div>'
      + '<h4 class="ra-sub">VFS 路径速查</h4>'
      + tableRows([
        ['<code>chat:/</code> · <code>card:/</code> · <code>cards:/</code>', '当前聊天楼层正文、当前角色卡字段、全部角色卡列表'],
        ['<code>wb:/</code> · <code>regex:/</code>', '世界书条目（含 .meta.json）、酒馆正则与美化脚本'],
        ['<code>script:/</code> · <code>preset:/</code>', '酒馆助手脚本、当前启用的预设提示词'],
        ['<code>var:/</code> · <code>mem:/</code> · <code>ws:/</code>', '楼层/聊天/MVU/全局变量、助手记忆（夜之洋）、持久化工作区'],
        ['<code>page:/</code> · <code>ext:/</code> · <code>kb:/</code>', '页面报错与环境（只读）、已装扩展源码（只读）、知识库参考文档（只读）'],
        ['<code>gh:/</code> · <code>web:/</code> · <code>dev:/</code>', 'GitHub 仓库直读、抓取网页缓存、后端伴侣本机文件（需设备全权）']
      ])
      + '<div class="ra-row ra-mt">'
      + '<button type="button" class="ra-btn is-small is-main" data-act="guide-jump" data-tab-target="chat">打开夜梦对话</button>'
      + '<button type="button" class="ra-btn is-small" data-act="guide-jump" data-tab-target="settings" data-section="ra-runs-card">查看改动记录</button>'
      + '</div>');
  }

  function createGuideUi(view) {
    function tocHtml() {
      return SECTIONS.map(function (item, index) {
        return '<button type="button" data-act="guide-toc" data-target="' + item[0] + '"' + (index === 0 ? ' aria-current="true"' : '') + '>' + item[1] + '</button>';
      }).join('');
    }
    function contentHtml() {
      return frontendCard(view.card) + cardFeaturesCard(view.card) + agentCard(view.card);
    }
    return { sections: SECTIONS, tocHtml: tocHtml, contentHtml: contentHtml };
  }

  modules.createGuideUi = createGuideUi;
})(typeof globalThis !== 'undefined' ? globalThis : window);
