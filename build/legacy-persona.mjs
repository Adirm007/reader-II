// 自定义人格与条件机制的通用化。
// 这一段替换逐字沿用 Reader-II 3.x 构建脚本里对 0726 模板做的处理（锚点在现行上游里仍然存在），
// 只去掉了“人格生成改走 ReaderCore”的那一条：现行上游已经经「独立 API · 人格创作」路由生成。
import { replaceRange, replaceRegex, countExact } from './lib.mjs';
import { customPersonaFields, genericCustomConditionKnowledge } from './payloads.mjs';

export function applyPersonaTransforms(input) {
  let source = input;
  source = replaceRange(
    source,
    'var CUSTOM_PERSONA_REQUIRED=',
    "var CUSTOM_CONDITION_STATE_KEY='dream_custom_condition_state';",
    customPersonaFields(),
    '自定义人格通用字段',
  );
  source = replaceRange(
    source,
    'var CUSTOM_CONDITION_VARIABLES=',
    'function createCustomConditionId(prefix)',
    `${genericCustomConditionKnowledge()}\n`,
    '自定义条件通用知识库',
  );
  source = replaceRegex(
    source,
    /var valueRules='【变量动作值规则】[\s\S]*?;\nvar examples=JSON\.stringify\(/,
    `var valueRules='【受控变量动作值规则】\\nnumber：set写目标数值，delta写变化量（例如扣除1000写-1000）。\\nstring：set写目标文本。\\nboolean：set的value必须是true或false。\\njson：set写完整对象或数组，merge合并对象字段，append追加数组项，remove_value移除匹配项，remove删除所选子字段。\\n动作知识库同时包含Reader白名单变量与当前完整宿主MVU树；只选择知识库中的变量，不手写路径。FP固定读写stat_data.READER.命运点数。\\nJSON对象模板：'+JSON.stringify(CUSTOM_ACTION_JSON_SAMPLES);
var examples=JSON.stringify(`,
    '自定义条件动作说明',
  );
  source = replaceRegex(
    source,
    /var examples=JSON\.stringify\(\[[\s\S]*?\]\);\nreturn shared/,
    `var examples=JSON.stringify([
  {effectMode:'variables',prompt:'',actions:[{variable:'fp',operation:'delta',value:-1000,name:''}],matchMode:'all',triggerMode:'always',cooldownTurns:1,conditions:[{variable:'fp',operator:'gt',value:1000,name:''}]},
  {effectMode:'both',prompt:'本轮叙事气氛变得格外温暖。',actions:[{variable:'reader_effect',operation:'set',value:{'类型':'特殊','效果':'叙事氛围变得温暖而安宁','层数':1,'剩余时间':'本轮','来源':'自定义人格'},name:'暖意'}],matchMode:'all',triggerMode:'enter',cooldownTurns:1,conditions:[{variable:'user_input',operator:'contains',value:'休息',name:''}]}
]);
return shared`,
    '自定义条件通用示例',
  );
  source = source
    .replace(/虚海中的不明存在/g, '世界外的不明存在')
    .replace(/静默修改MVU变量/g, '静默修改变量')
    .replace(/只由死代码修改MVU变量/g, '只由Reader受控解释器修改已选择变量')
    .replace(/【本次：手动添加EJS】/g, '【本次：手动添加条件】')
    .replace(/ascensionAdvantage:'登神长阶优势',/g, '')
    .replace(/\n6\. ascensionAdvantage：保留“辅助<user>获取并融合路径力量”的功能并以她的风格解释。/g, '')
    .replace(
      "function customConditionSafePath(path){return typeof path==='string'&&/^(事件|世界|任务列表|主角|命运点数|关系列表|新闻)(\\.|$)/.test(path)&&!/[<>{}\\[\\]\"';\\r\\n]/.test(path)&&!/(^|\\.)(__proto__|prototype|constructor)(\\.|$)/.test(path);}",
      "function customConditionSafePath(path){return typeof path==='string'&&/^(?:stat_data\\.(?!READER(?:\\.|$))|命运点数$|主角\\.(?:状态效果|技能)(?:\\.|$)|任务列表(?:\\.|$)|关系列表(?:\\.|$)|地点$|进度$)/.test(path)&&!/[<>{}\\[\\]\"';\\r\\n]/.test(path)&&!/(^|\\.)(__proto__|prototype|constructor)(\\.|$)/.test(path);}"
    )
    .replace(
      "function defaultCustomCondition(){var def=getCustomConditionVariable('hero_money');",
      "function defaultCustomCondition(){var def=getCustomConditionVariable('fp');"
    )
    .replace(
      "var variable=String(input.variable||'');var def=getCustomConditionVariable(variable);",
      "var variable=String(input.variable||'');var legacy={hero_money:'fp',hero_status:'reader_effect',hero_bag_item:'item_exists',hero_skill:'skill_exists'};if(legacy[variable])variable=legacy[variable];var def=getCustomConditionVariable(variable);"
    )
    .replace(
      "return{id:String(input.id||createCustomConditionId('cond')).replace(/[^A-Za-z0-9_-]/g,'')||createCustomConditionId('cond'),variable:variable,source:source,path:path,valueType:valueType,operator:operator,value:value,name:name,subname:subname};",
      "return{id:String(input.id||createCustomConditionId('cond')).replace(/[^A-Za-z0-9_-]/g,'')||createCustomConditionId('cond'),variable:variable,source:source,ref:def?String(def.ref||''):String(input.ref||''),segments:customActionClone(def&&def.segments?def.segments:(input.segments||[])),path:path,valueType:valueType,operator:operator,value:value,name:name,subname:subname};"
    )
    .replaceAll(
      'getCustomActionOperators(adef?adef.valueType:action.valueType)',
      'getCustomActionOperators(adef?adef.valueType:action.valueType,adef)',
    )
    .replaceAll(
      'getCustomActionOperators(adef.valueType)',
      'getCustomActionOperators(adef.valueType,adef)',
    )
    .replaceAll(
      'getCustomActionOperators(item.valueType)',
      'getCustomActionOperators(item.valueType,item)',
    )
    .replace(
      "if(def.source==='mvu'&&!customConditionSafePath(c.path))",
      "if(def.host&&(!c.ref||String(c.ref).indexOf('hostref:')!==0))errors.push(cp+'宿主路径引用无效');else if(!def.host&&def.source==='mvu'&&!customConditionSafePath(c.path))",
    )
    .replace(
      "if(!customConditionSafePath(a.path))errors.push(ap+'MVU路径无效');",
      "if(adef.host&&(!a.ref||String(a.ref).indexOf('hostref:')!==0))errors.push(ap+'宿主路径引用无效');else if(!adef.host&&!customConditionSafePath(a.path))errors.push(ap+'变量路径无效');",
    )
    .replace(
      "if(adef.valueType==='json'&&a.operation==='set'&&(!a.value||typeof a.value!=='object'||Array.isArray(a.value)))",
      "if(adef.valueType==='json'&&a.operation==='set'&&(!a.value||typeof a.value!=='object'||(adef.hostValueType==='object'&&Array.isArray(a.value))||(adef.hostValueType==='array'&&!Array.isArray(a.value))))",
    )
    .replace(
      "if(action.operation==='remove'){html+='<span class=\"cp-action-no-value\">无需填值</span>';}",
      "if(action.operation==='remove'||action.operation==='toggle'){html+='<span class=\"cp-action-no-value\">无需填值</span>';}",
    )
    .replace(
      "function openCustomPersonaStudio(e,toastFn,persona){if(e)e.stopPropagation();",
      "function openCustomPersonaStudio(e,toastFn,persona){if(e)e.stopPropagation();if(!CUSTOM_HOST_CATALOG_LOADED){refreshHostVariableCatalog().catch(function(error){console.warn('[Reader] 宿主变量目录读取失败',error);CUSTOM_HOST_CATALOG_LOADED=true;}).then(function(){openCustomPersonaStudio(null,toastFn,persona);});return;}",
    )
    .replace(
      "condition.variable=element.value;condition.source=def.source;condition.path=def.path;condition.valueType=def.valueType;",
      "condition.variable=element.value;condition.source=def.source;condition.ref=def.ref||'';condition.segments=customActionClone(def.segments||[]);condition.path=def.path;condition.valueType=def.valueType;",
    )
    .replace(
      "最多12条机制。</div></div><button type=\"button\" class=\"cp-cond-btn\" data-cp-cond-action=\"add-rule\">＋ 添加机制</button>",
      "最多12条机制。</div><input data-cp-host-query value=\"'+escHtml(CUSTOM_HOST_CATALOG_QUERY)+'\" placeholder=\"搜索宿主变量：货币、位置、人物……\" style=\"margin-top:8px;min-width:280px\"></div><button type=\"button\" class=\"cp-cond-btn\" data-cp-cond-action=\"add-rule\">＋ 添加机制</button>",
    )
    .replace(
      "html+='<div class=\"cp-action-row\" data-cp-action-index=\"'+ai+'\"><select data-cp-action-field=\"variable\">';for(var av=0;av<CUSTOM_ACTION_VARIABLES.length;av++){var actionVar=CUSTOM_ACTION_VARIABLES[av];",
      "html+='<div class=\"cp-action-row\" data-cp-action-index=\"'+ai+'\"><select data-cp-action-field=\"variable\">';var visibleActionVariables=visibleCustomVariables(CUSTOM_ACTION_VARIABLES,action.variable);for(var av=0;av<visibleActionVariables.length;av++){var actionVar=visibleActionVariables[av];",
    )
    .replace(
      "html+='<div class=\"cp-cond-row\" data-cp-cond-index=\"'+j+'\"><select data-cp-cond-field=\"variable\">';for(var v=0;v<CUSTOM_CONDITION_VARIABLES.length;v++){var variable=CUSTOM_CONDITION_VARIABLES[v];",
      "html+='<div class=\"cp-cond-row\" data-cp-cond-index=\"'+j+'\"><select data-cp-cond-field=\"variable\">';var visibleConditionVariables=visibleCustomVariables(CUSTOM_CONDITION_VARIABLES,condition.variable);for(var v=0;v<visibleConditionVariables.length;v++){var variable=visibleConditionVariables[v];",
    )
    .replace(
      "function bindCustomConditionalPanel(root){var panel=root.querySelector('[data-cp-condition-panel]');if(!panel||panel.__cpBound)return;panel.__cpBound=true;panel.addEventListener('click',function(event){",
      "function bindCustomConditionalPanel(root){var panel=root.querySelector('[data-cp-condition-panel]');if(!panel||panel.__cpBound)return;panel.__cpBound=true;panel.addEventListener('input',function(event){if(!event.target.matches('[data-cp-host-query]'))return;CUSTOM_HOST_CATALOG_QUERY=String(event.target.value||'');renderCustomConditionalPanel(root);var next=panel.querySelector('[data-cp-host-query]');if(next){next.focus();next.setSelectionRange(next.value.length,next.value.length);}});panel.addEventListener('click',function(event){",
    );
  /* 上面有一串不带计数的 replace：确认通用化确实落到了代码里。 */
  const expect = [
    ['visibleCustomVariables(', 3], ['data-cp-host-query', 2], ['refreshHostVariableCatalog()', 3],
    ["getCustomConditionVariable('fp')", 1], ['宿主路径引用无效', 2], ['静默修改MVU变量', 0],
  ];
  for (const [token, minimum] of expect) {
    const count = countExact(source, token);
    if (minimum === 0 ? count !== 0 : count < minimum) throw new Error(`自定义人格通用化未生效：${token} 出现 ${count} 次`);
  }
  return source;
}
