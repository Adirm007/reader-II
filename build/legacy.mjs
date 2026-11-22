// 上游 source/legacy-reader.js → Reader-II 通用版控制器主体。
//
// 上游把所有宿主写入集中在 ReaderTransactions 上（命运点数、主角状态、主角背包）。通用版换用按语义路由解析路径的
// ReaderTransactions（src/controller/reader-transactions-generic.js），因此这里只需要：
//   · 把直接写 stat_data.主角 / 命运点数 的几处改成事务接口；
//   · 自定义人格、条件机制、缘加强换成不依赖命定之诗变量表的通用版本；
//   · 去掉不进通用版的东西：书海、检查更新；彩蛋页换上夜梦助手 / 助手设置 / 语义适配 / 记忆的入口（只此一处）。
import { countExact, replaceExact, replaceRegex, replaceFunction, patchFunction, findFunctions, assertSyntax } from './lib.mjs';
import { applyPersonaTransforms } from './legacy-persona.mjs';
import { renameLocalKeys } from './local-keys.mjs';

const AGENT_DOOR = "h+='<div class=\"dlb-sub-h\">夜梦助手<i>READER AGENT</i></div><button type=\"button\" class=\"dlb-row\" data-dlb=\"eggagent\" style=\"width:100%;text-align:left;background:transparent;color:inherit;font:inherit;cursor:pointer\"><div class=\"ic\">'+dlbSvg('quill')+'</div><div class=\"tx\"><div class=\"nm\">和夜梦说说话<em>AGENT</em></div><div class=\"ds\">查资料、改变量、适配这张卡、整理记忆；要动手改东西之前会先问你</div></div><div class=\"rt\"><span class=\"sv2\">打开</span></div></button>';";
const MEMORY_ROWS = "h+='<div class=\"dlb-row\" data-dlb=\"eggagentset\"><div class=\"ic\">'+dlbSvg('tuning')+'</div><div class=\"tx\"><div class=\"nm\">助手设置<em>SETTINGS</em></div><div class=\"ds\">模型与工具调用方式、权限、联网与插件对接、版本更新</div></div><div class=\"pr\">打开</div></div>';\n"
  + "h+='<div class=\"dlb-row\" data-dlb=\"eggmemory\"><div class=\"ic\">'+dlbSvg('info')+'</div><div class=\"tx\"><div class=\"nm\">记忆<em>MEMORY</em></div><div class=\"ds\">查看与助手的交流记忆，可随聊天保存或存进《夜之洋》</div></div><div class=\"rt\"><span class=\"go\">'+dlbSvg('go')+'</span></div></div>';\n"
  + "h+='<div class=\"dlb-row\" data-dlb=\"eggpanel\"><div class=\"ic\">'+dlbSvg('tuning')+'</div><div class=\"tx\"><div class=\"nm\">语义适配<em>READER CORE</em></div><div class=\"ds\">把宿主卡的变量接到读者这边：地点、角色、任务、技能、状态、货币、背包</div></div><div class=\"rt\"><span class=\"go\">'+dlbSvg('go')+'</span></div></div>';";

/* 控制器里新增的小函数：通往主脚本里的 ReaderCore（语义层）、夜梦助手与适配面板。 */
const GENERIC_HELPERS = [
  "function getReaderHostWindow(){return window.parent;}",
  "function getReaderCoreApi(){var a=window.__ReaderIICore||(window.parent&&window.parent.__ReaderIICore)||window.ReaderCore||(window.parent&&window.parent.ReaderCore);if(!a||!a.__reader_core_api)throw new Error('Reader-II主系统尚未加载');return a;}",
  `async function dreamOpenAgent(tab){
    try {
      var api = await getReaderCoreApi().loadReaderII();
      if (!window.__readerControllerAlive) return false;
      api.agent.open(tab || 'chat');
      closeDreamLobby();
      return true;
    } catch (error) {
      if (window.__readerControllerAlive) pToast('夜梦助手打开失败：' + (error && error.message || error));
      return false;
    }
  }`,
  "function dreamOpenPanel(){try{try{closeDreamLobby();}catch(e0){}Promise.resolve(getReaderCoreApi().openPanel()).catch(function(error){showToast(error&&error.message?error.message:String(error));});return true;}catch(error){showToast(error&&error.message?error.message:String(error));return false;}}",
].join('\n');

export function transformLegacy(input) {
  let source = input;

  /* ---- 0. 去掉逐信启动的引导（常驻控制器由适配层启动） ---- */
  source = replaceRegex(source, /\ninitDreamSys\(\);\s*setTimeout\(function\(\)\{try\{dreamWbAutoCheck\(\);\}catch\(e\)\{\}\},5000\);/, '\n', '旧引导');

  /* ---- 1. 宿主读写：改走事务接口 ---- */
  source = replaceFunction(source, 'hasHelperApi', "function hasHelperApi(){return typeof TAVERN_HELPER.getVariables==='function'&&typeof TAVERN_HELPER.updateVariablesWith==='function';}");
  source = replaceFunction(source, 'getCurrentFp', 'function getCurrentFp(vars){return ReaderTransactions.fp(vars);}');
  source = replaceFunction(source, 'hasPoem', "function hasPoem(vars){return ReaderTransactions.statuses(vars).some(function(status){return String(status.name||'').indexOf('祷诗·')===0;});}");
  source = patchFunction(source, 'handlePrayer', [[
    "ReaderTransactions.merge(vars,buildStatusPatch(vars,'祷诗·'+poem.name,{类型:'特殊',效果:poem.effect,层数:1,剩余时间:'至午夜刷新',来源:'祷诗-优先于节奏调整;优劣势与相邻层级压制抵消;对高于或低于自身两个层级目标无效'}));",
    "ReaderTransactions.setStatus(vars,{name:'祷诗·'+poem.name,effect:poem.effect,duration:'至午夜刷新',source:'读者的祷诗（优先于节奏调整）'});",
  ]], '祷诗写入');
  source = patchFunction(source, 'handleRhythm', [[
    "ReaderTransactions.merge(vars,buildStatusPatch(vars,actualConfig.key,{类型:'特殊',效果:actualConfig.effect,层数:1,剩余时间:actualConfig.duration,来源:'节奏调整-次于祷诗'}));",
    "ReaderTransactions.setStatus(vars,{name:actualConfig.key,effect:actualConfig.effect,duration:actualConfig.duration,source:'读者的节奏调整（次于祷诗）'});",
  ]], '节奏调整写入');
  source = replaceExact(source, "effect:'短期内将邂逅命定之人潜力角色或触发关系起点'", "effect:'短期内将邂逅值得深交的角色或触发关系起点'", '缘的效果文案');
  source = patchFunction(source, 'addFP', [['vars.stat_data.命运点数=value;', 'ReaderTransactions.setFp(vars,value);']], '棋局奖励');
  /* 定调：书架里直接结算（扣 1000 FP 并写入“定调”状态），与正文事件 tone_apply 等价。 */
  source = replaceFunction(source, 'bsTune', "async function bsTune(doc,title,toastFn){var remain;try{remain=await ReaderTransactions.run('paid-action',async function(token){return ReaderTransactions.transact(token,token.id+':tone',function(vars){if(ReaderTransactions.statuses(vars).some(function(status){return String(status.name||'').indexOf('定调')!==-1;}))throw new Error('请先在对话中要求当前状态系统解除现有定调');var fp=ReaderTransactions.charge(vars,1000);ReaderTransactions.setStatus(vars,{name:'定调',effect:'叙事基调参考《'+title+'》，只借鉴主题与氛围，不复制角色和剧情；解除时由当前状态系统同步处理相关主题。',duration:'至用户要求解除',source:'读者书架'});return fp;});});}catch(error){toastFn(error&&error.message?error.message:String(error));return;}toastFn('已选择定调: '+title+'，剩余 '+remain+'FP');bsCloseDT(doc);bsClose(doc);}");
  /* 不再使用的命定之诗路径拼装函数。 */
  for (const name of ['getRootVars', 'getMainCharacter', 'cloneStatusEffects', 'writeVars', 'buildMainPatch', 'buildFpPatch', 'getStatusEffects', 'buildStatusPatch']) {
    source = replaceFunction(source, name, '', '移除 ' + name);
  }

  /* ---- 2. 自定义人格与条件机制 ---- */
  source = applyPersonaTransforms(source);
  source = replaceExact(source, "fpDefinition:'FP定义',newsStyle:'爆料风格',skillAdvantage:'技能获取优势',", '', '人格生成 schema 的命定之诗字段');
  source = replaceExact(source, "\\n4. fpDefinition：一句话说明FP对她而言是什么。\\n5. newsStyle：她提供情报时的口吻和信息倾向。\\n6. ascensionAdvantage：保留“辅助<user>获取并融合路径力量”的功能并以她的风格解释。\\n7. skillAdvantage：多行机制，保留消耗fp瞬间学会与辅助领悟两项功能。", '', '人格生成说明里的命定之诗字段');

  /* ---- 3. 缘加强：只走通用模板系统 ---- */
  source = replaceRegex(source, /var YUAN_PLUS_BLUE_WHITELIST=\[[^\]]*\];/, 'var YUAN_PLUS_BLUE_WHITELIST=["世界","设定","规则","背景","概览","种族","势力","组织","地理","历史","文化","命名","world","setting","lore"];', '缘加强常驻条目白名单');
  source = replaceExact(source, "var YUAN_PLUS_BOOK_NAME='阿斯塔利亚人物志';", "var YUAN_PLUS_BOOK_NAME='Reader生成条目';", '缘加强默认世界书');
  source = replaceFunction(source, 'yuanPlusLoadTemplate', "async function yuanPlusLoadTemplate(){throw new Error('通用版的缘加强使用“条目模仿”里的模板');}");
  source = replaceFunction(source, 'writeYuanPlusStatus', "async function writeYuanPlusStatus(roleName,token,cost){var target=token||ReaderTransactions.capture();return ReaderTransactions.transact(target,target.id+':yuan',function(vars){var remain=ReaderTransactions.charge(vars,cost||0);ReaderTransactions.setStatus(vars,{name:'涟漪·缘·'+roleName,effect:'短期内更容易与“'+roleName+'”产生符合当前世界逻辑的关系起点；宣告的当轮不会遭遇此人，可以知晓的只有名字，不预设身份、立场或结果。',duration:'至实际产生关系起点',source:'缘加强'});return remain;});}");
  source = replaceFunction(source, 'handleYuanPlusOrder', "async function handleYuanPlusOrder(){return ReaderTransactions.run('paid-action',async function(token){var cost=RHYTHM_CONFIG['缘'].cost;ReaderTransactions.requireFp(token,cost);if(!window.ReaderTemplateSystem||typeof window.ReaderTemplateSystem.generateForYuanPlus!=='function')throw new Error('条目模仿（模板系统）尚未就绪');var result=await window.ReaderTemplateSystem.generateForYuanPlus(token);ReaderTransactions.assertCurrent(token);var remain=await writeYuanPlusStatus(result.entryName,token,cost);showToast('已写入世界书 '+result.bookName+'，剩余 '+remain+'FP');});}");

  /* ---- 4. 文案（保留黑幕人格名与三次确认流程） ---- */
  source = replaceExact(source, '更新新闻', '请读者写一则旁观札记', '点单文案', countExact(source, '更新新闻'));
  source = replaceExact(source, '<span>新闻更新</span>', '<span>旁观札记</span>', '菜单文案', countExact(source, '<span>新闻更新</span>'));
  source = replaceExact(source, '条目模仿与书海的请求可分别指定方案', '条目模仿、命运抽卡与夜梦助手的请求可分别指定方案', '独立 API 说明', countExact(source, '条目模仿与书海的请求可分别指定方案'));

  /* ---- 5. 书海与多核心管理不进通用版 ---- */
  source = replaceExact(source, "var albumOrder=['咖啡馆','读者们','失乐园','收录','私货','书海'];", "var albumOrder=['咖啡馆','读者们','失乐园','收录','私货'];", '专辑顺序');
  source = replaceExact(source, "\n,'书海':ReaderBookseaAlbum.songs", '', '书海专辑');
  source = replaceFunction(source, 'dlbEnterBooksea', '', '书海入口函数');
  source = replaceRegex(source, /h\+='<div class="dlb-sub-h">书海迷宫<i>BOOKSEA<\/i><\/div><button type="button" class="dlb-row" data-dlb="eggbooksea"[^\n]*\n/, AGENT_DOOR + '\n', '彩蛋页书海入口');
  source = replaceRegex(source, /if\(dreamHasReaderIIAgent\(\)\)\{h\+='<button type="button" class="dlb-row" data-dlb="eggagent"[^\n]*\n/, '', '移除共存附加助手入口');
  source = replaceRegex(source, /h\+='<div class="dlb-row" data-dlb="eggcoremgr">[^\n]*\n/, '', '彩蛋页移除核心管理行');
  source = replaceExact(source, "if(act==='eggbooksea'){dlbEnterBooksea();return;}\nif(act==='eggagent'){dreamOpenReaderIIAgent(e,pToast);return;}\nif(act==='eggcoremgr'){openCoreManagerSettings(e,pToast);return;}", "if(act==='eggagent'){dreamOpenAgent('chat');return;}if(act==='eggagentset'){dreamOpenAgent('settings');return;}if(act==='eggmemory'){dreamOpenAgent('memory');return;}if(act==='eggpanel'){dreamOpenPanel();return;}", '彩蛋页入口动作');
  source = replaceExact(source, "var cmEl=ov.querySelector('#dlb-egg-coremgr');if(cmEl)cmEl.textContent=dreamCoreManagerLabel();", '', '同步彩蛋核心管理标签');
  source = replaceExact(source, "dreamSetText(['dlb-egg-coremgr','dfm-core-mgr'],dreamCoreManagerLabel());\n", '', '同步附加核心管理标签');
  source = replaceExact(source, "dreamSyncCoreManagerReaderSilent(snst);", '', '同步核心管理静默状态', 2);
  source = replaceExact(
    source,
    '<div class="sub-opt" data-action="coreManager"><span>核心管理</span><span id="dfm-core-mgr" style="font-family:monospace;font-size:12px;letter-spacing:1px;">\'+escHtml(dreamCoreManagerLabel())+\'</span></div><div style="padding:0 10px 6px 10px;font-size:11px;color:#8a796f;font-style:italic;">多开系统核心时指定主核心、隔离宏冲突，并按核心配置静默与临时唤起词</div>',
    '',
    '悬浮菜单移除核心管理',
  );
  source = replaceExact(source, "else if(act==='coreManager'){openCoreManagerSettings(e,pToast);}", '', '悬浮菜单移除核心管理动作');
  for (const name of ['dreamSyncCoreManagerReaderSilent', 'dreamCoreManagerLabel', 'dreamHasReaderIIAgent', 'dreamOpenReaderIIAgent', 'openCoreManagerSettings']) {
    source = replaceFunction(source, name, '', '移除 ' + name);
  }
  source = replaceExact(source, "['booksea_compile','书海 · 技能整备','进入迷宫前编译同行者能力'],\n['booksea_supplier','书海 · 补给员对话','迷宫里和补给员聊天、请她生成东西'],\n",
    "['agent','夜梦助手','助手对话与工具调用'],\n['memory','记忆整理','整理用户与夜梦助手的聊天（夜之洋）'],\n['adapt','语义适配','一键适配时寻找宿主变量、分析容器结构'],\n", '独立 API 调用类型');
  source = replaceExact(source, '/* 调用类型：[键, 名称, 说明]。书海读取同一份 dream_independent_api_v2.routes。正文回复始终走酒馆当前插头。 */', '/* 调用类型：[键, 名称, 说明]。主脚本里的助手、记忆与语义适配读取同一份方案表的 routes。正文回复始终走酒馆当前插头。 */', '独立 API 注释');

  /* ---- 6. 检查更新不进通用版：换成记忆与语义适配入口 ---- */
  source = replaceRegex(source, /h\+='<div class="dlb-row" data-dlb="eggwb">[^\n]*\n/, MEMORY_ROWS + '\n', '彩蛋页检查更新');
  source = replaceExact(source, "if(act==='eggupdates'){openDreamReleaseUpdates(e,pToast);return;}\nif(act==='eggwb'){openDreamWorldbookUpdate(e,pToast);return;}\n", '', '检查更新动作');
  source = replaceExact(source,
    '<div class="sub-opt" data-action="worldbookUpdate"><span>检查更新</span><span style="font-family:monospace;font-size:12px;">检查</span></div><div style="padding:0 10px 6px 10px;font-size:11px;color:#8a796f;font-style:italic;">分别检查正则、脚本和世界书，更新可用项目</div>',
    '',
    '悬浮菜单检查更新');
  source = replaceExact(source, "else if(act==='worldbookUpdate'){openDreamWorldbookUpdate(e,pToast);}", '', '悬浮菜单动作');
  /* 世界书版本检查整段不再需要（读的是上游仓库的发布清单）。 */
  source = replaceFunction(source, 'dreamWbAutoCheck', 'async function dreamWbAutoCheck(){}', '世界书自动检查');
  source = replaceFunction(source, 'openDreamWorldbookUpdate', "function openDreamWorldbookUpdate(e){if(e&&e.stopPropagation)e.stopPropagation();dreamOpenAgent('memory');}", '世界书更新窗口');

  /* ---- 7. 常驻宿主接口在通用版里叫 ReaderShell（ReaderCore 是语义层） ---- */
  source = replaceExact(source, 'pW.ReaderCore', 'pW.ReaderShell', '宿主接口名', countExact(source, 'pW.ReaderCore'));

  /* ---- 8. 新增的小函数 ---- */
  source = replaceExact(source, 'function hasHelperApi(){', GENERIC_HELPERS + '\nfunction hasHelperApi(){', '通用辅助函数');

  /* ---- 校验：命定之诗专属的读写与多核心管理不应再出现 ---- */
  for (const token of ['stat_data.命运点数', 'buildStatusPatch', 'getMainCharacter(', 'getRootVars(', 'cloneStatusEffects(', 'writeVars(', 'buildMainPatch(', 'buildFpPatch(', 'getStatusEffects(', 'dlbEnterBooksea', 'eggbooksea', 'eggcoremgr', 'ReaderCoreManager', 'ReaderBookseaAlbum.songs', '阿斯塔利亚', '登神长阶', 'openDreamReleaseUpdates']) {
    if (source.includes(token)) throw new Error('通用化后仍残留：' + token);
  }
  for (const name of ['getReaderCoreApi', 'dreamOpenAgent', 'dreamOpenPanel', 'getReaderHostWindow']) {
    if (findFunctions(source, name).length !== 1) throw new Error('通用辅助函数 ' + name + ' 应恰有一处');
  }
  /* ---- 9. 本机存储键换成 reader-II 自己的（build/local-keys.mjs） ---- */
  source = renameLocalKeys(source, 'legacy-reader.js');
  return assertSyntax(source, 'legacy-reader.generic.js');
}
