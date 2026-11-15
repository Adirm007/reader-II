// 通用版自定义人格的字段表与条件 / 动作知识库。
// 逐字取自 Reader-II 3.x 的构建脚本（当时对 0726 模板做的通用化），现行上游里对应的锚点仍然存在，由 build/legacy.mjs 套用。
export function customPersonaFields() {
  return String.raw`var CUSTOM_PERSONA_REQUIRED=['systemName','definition','coreConcept','opening','personality','role','hobbies','wish','constraints','letterStyle','corpus'];
var CUSTOM_PERSONA_FIELDS=[
{section:'身份与核心',key:'systemName',label:'系统名',required:true,placeholder:'例如：哀怜的少女、心爱的少女、怪人'},
{section:'身份与核心',key:'definition',label:'定义',required:true,type:'textarea',placeholder:'她是什么、在哪里、如何看待<user>与世界'},
{section:'身份与核心',key:'coreConcept',label:'核心概念',required:true,type:'textarea'},
{section:'身份与核心',key:'coreMechanism',label:'独特机制',required:false,type:'textarea'},
{section:'读者侧机制',key:'revival',label:'复活机制',required:false,type:'textarea'},
{section:'人格档案',key:'personality',label:'性格',required:true,type:'textarea'},
{section:'人格档案',key:'role',label:'定位',required:true},
{section:'人格档案',key:'hobbies',label:'爱好',required:true,type:'textarea'},
{section:'人格档案',key:'wish',label:'愿望',required:true,type:'textarea'},
{section:'人格档案',key:'constraints',label:'行为约束',required:true,type:'textarea'},
{section:'人格档案',key:'appearance',label:'形象',required:false,type:'textarea'},
{section:'人格档案',key:'avatarUrl',label:'头像URL',required:false},
{section:'语言与书信',key:'opening',label:'开场白',required:true,type:'textarea'},
{section:'语言与书信',key:'letterStyle',label:'书信风格',required:true,type:'textarea'},
{section:'语言与书信',key:'corpusMode',label:'语料使用方式',required:true,type:'select',options:[['fixed','固定结果语料'],['random','随机抽取语料池']]},
{section:'语言与书信',key:'corpus',label:'语料库',required:true,type:'textareaTall'},
{section:'定调书池',key:'toneMode',label:'定调书池来源',required:true,type:'select',options:[['reader','沿用读者'],['kuromaku','沿用哀怜的少女'],['shoujo','沿用少女'],['custom','专属类型书池']]},
{section:'定调书池',key:'tonePrompt',label:'专属书池要求',required:false,type:'textarea'},
{section:'条件机制',key:'conditionalEnabled',label:'条件机制',required:true,type:'select',options:[['off','不启用'],['on','启用']]},
{section:'条件机制',key:'conditionalAuthoring',label:'条件添加方式',required:true,type:'select',options:[['ai','AI生成条件'],['manual','手动设置条件']]},
{section:'条件机制',key:'conditionalRequest',label:'条件机制需求',required:false,type:'textareaTall'},
{section:'AI生成',key:'preference',label:'用户偏好',required:false,type:'textareaTall'}
];
`;
}

export function genericCustomConditionKnowledge() {
  return String.raw`var CUSTOM_CONDITION_VARIABLES=[
  {key:'fp',label:'当前FP',source:'reader',path:'命运点数',valueType:'number'},
  {key:'reader_effect',label:'Reader效果',source:'reader',path:'主角.状态效果.{name}',valueType:'exists',nameLabel:'效果名'},
  {key:'chapter_task',label:'Reader章节任务',source:'reader',path:'任务列表.{name}',valueType:'exists',nameLabel:'任务名'},
  {key:'user_input',label:'本轮用户输入',source:'user_input',path:'',valueType:'string'},
  {key:'last_ai',label:'上轮AI输出',source:'last_ai',path:'',valueType:'string'},
  {key:'recent_chat',label:'最近四条聊天内容',source:'recent_chat',path:'',valueType:'string'},
  {key:'turn_count',label:'当前聊天楼层数',source:'turn_count',path:'',valueType:'number'}
];
var CUSTOM_BASE_CONDITION_VARIABLES=CUSTOM_CONDITION_VARIABLES.slice();
var CUSTOM_CONDITION_OPERATORS={
  number:[['gt','大于'],['gte','大于等于'],['eq','等于'],['neq','不等于'],['lt','小于'],['lte','小于等于']],
  string:[['contains','包含'],['not_contains','不包含'],['eq','等于'],['neq','不等于'],['regex','匹配正则']],
  boolean:[['eq','等于']],
  array:[['includes','包含'],['not_includes','不包含']],
  exists:[['exists','存在'],['not_exists','不存在']]
};
var CUSTOM_CONDITION_TRIGGER_MODES=[['always','条件满足的每轮'],['enter','条件刚成立时一次'],['cooldown','满足时每隔若干轮'],['once','整场对话仅一次']];
var CUSTOM_ACTION_JSON_SAMPLES={reader_effect:{'效果':'','剩余时间':'','来源':'自定义人格'}};
var CUSTOM_ACTION_VARIABLES=[
  {key:'fp',label:'当前FP',path:'命运点数',valueType:'number',source:'reader',nameLabel:'',sample:null,operations:[['delta','增加/减少'],['set','设为']]},
  {key:'reader_effect',label:'Reader语义状态',path:'主角.状态效果.{name}',valueType:'json',source:'reader',nameLabel:'状态名',sample:CUSTOM_ACTION_JSON_SAMPLES.reader_effect,hostValueType:'object',operations:[['set','新增（同名拒绝）']]}
];
var CUSTOM_BASE_ACTION_VARIABLES=CUSTOM_ACTION_VARIABLES.slice();
var CUSTOM_ACTION_OPERATORS={number:[['delta','增加/减少'],['set','设为']],string:[['set','设为']],boolean:[['set','设为'],['toggle','切换真假']],json:[['set','整体设为'],['merge','合并字段'],['append','追加一项'],['remove_value','移除匹配项'],['remove','删除字段']]};
var CUSTOM_RULE_EFFECT_MODES=[['prompt','发送文本给LLM'],['variables','静默修改变量'],['both','发送文本并修改变量']];
var CUSTOM_HOST_CATALOG_LOADED=false,CUSTOM_HOST_CATALOG_EVENT_BOUND=false,CUSTOM_HOST_CATALOG_QUERY='';
var CUSTOM_ACTION_OPERATION_LABELS={set:'设为',delta:'增加/减少',toggle:'切换真假',merge:'合并字段',append:'追加一项',remove_value:'移除匹配项',remove:'删除字段'};
function hostConditionValueType(type){if(type==='object'||type==='null')return'exists';if(type==='array')return'array';return type;}
function hostActionValueType(type){return type==='object'||type==='array'||type==='null'?'json':type;}
function visibleCustomVariables(items,selectedKey){var query=String(CUSTOM_HOST_CATALOG_QUERY||'').trim().toLowerCase();if(!query)return items;return items.filter(function(item){return !item.host||item.key===selectedKey||(item.label+' '+item.path).toLowerCase().indexOf(query)>=0;});}
async function refreshHostVariableCatalog(){var core=getReaderCoreApi();var items=await core.listHostVariables();CUSTOM_CONDITION_VARIABLES=CUSTOM_BASE_CONDITION_VARIABLES.slice();CUSTOM_ACTION_VARIABLES=CUSTOM_BASE_ACTION_VARIABLES.slice();for(var i=0;i<items.length;i++){var item=items[i],key='host::'+item.ref;CUSTOM_CONDITION_VARIABLES.push({key:key,label:'宿主 · '+item.label,source:'host',ref:item.ref,segments:item.segments,path:item.path,valueType:hostConditionValueType(item.valueType),host:true,hostValueType:item.valueType});if(item.writable&&item.operations&&item.operations.length){CUSTOM_ACTION_VARIABLES.push({key:key,label:'宿主 · '+item.label,source:'host',ref:item.ref,segments:item.segments,path:item.path,valueType:hostActionValueType(item.valueType),host:true,hostValueType:item.valueType,sample:item.value,operations:item.operations.map(function(op){return[op,CUSTOM_ACTION_OPERATION_LABELS[op]||op];})});}}CUSTOM_HOST_CATALOG_LOADED=true;return items;}
setTimeout(function(){try{var host=getReaderHostWindow();if(!CUSTOM_HOST_CATALOG_EVENT_BOUND){CUSTOM_HOST_CATALOG_EVENT_BOUND=true;host.addEventListener('reader-core-changed',function(){CUSTOM_HOST_CATALOG_LOADED=false;refreshHostVariableCatalog().then(function(){var doc=getCustomPersonaHostDocument(),panel=doc&&doc.getElementById('cp-overlay');if(panel)renderCustomConditionalPanel(panel);}).catch(function(error){console.warn('[Reader] 宿主变量目录刷新失败',error);});});}}catch(error){}},0);
function getCustomActionVariable(key){for(var i=0;i<CUSTOM_ACTION_VARIABLES.length;i++)if(CUSTOM_ACTION_VARIABLES[i].key===key)return CUSTOM_ACTION_VARIABLES[i];return null;}
function getCustomActionOperators(valueType,def){return def&&Array.isArray(def.operations)&&def.operations.length?def.operations:(CUSTOM_ACTION_OPERATORS[valueType]||CUSTOM_ACTION_OPERATORS.json);}
function customActionOperatorLabel(operation){for(var type in CUSTOM_ACTION_OPERATORS){var ops=CUSTOM_ACTION_OPERATORS[type];for(var i=0;i<ops.length;i++)if(ops[i][0]===operation)return ops[i][1];}return operation;}
function customActionClone(value){try{return JSON.parse(JSON.stringify(value));}catch(e){return value;}}
function defaultCustomAction(variableKey){var def=getCustomActionVariable(variableKey||'fp')||CUSTOM_ACTION_VARIABLES[0];var value=def.valueType==='number'?0:(def.valueType==='boolean'?true:customActionClone(def.sample==null?{}:def.sample));return{id:createCustomConditionId('act'),variable:def.key,source:def.source||'',ref:def.ref||'',segments:customActionClone(def.segments||[]),path:def.path,valueType:def.valueType,hostValueType:def.hostValueType||'',operation:getCustomActionOperators(def.valueType,def)[0][0],value:value,name:''};}
function sanitizeCustomAction(input){input=input&&typeof input==='object'?input:{};var variable=String(input.variable||'');var legacy={hero_money:'fp',hero_status:'reader_effect'};if(legacy[variable])variable=legacy[variable];var def=getCustomActionVariable(variable);var name=String(input.name||'').trim();var path=def?def.path:String(input.path||'').trim();if(def&&path.indexOf('{name}')>=0)path=path.replace('{name}',name);var value=input.value;if(def&&def.valueType==='number'&&value!==''&&value!=null&&Number.isFinite(Number(value)))value=Number(value);if(def&&def.valueType==='boolean'){if(value===true||String(value)==='true')value=true;else if(value===false||String(value)==='false')value=false;}if(def&&def.valueType==='json'&&typeof value==='string'&&value.trim()){try{value=JSON.parse(value);}catch(e){value=value.trim();}}var ops=getCustomActionOperators(def?def.valueType:String(input.valueType||''),def);var operation=String(input.operation||((ops[0]||[])[0]||''));return{id:String(input.id||createCustomConditionId('act')).replace(/[^A-Za-z0-9_-]/g,'')||createCustomConditionId('act'),variable:variable,source:def?String(def.source||''):String(input.source||''),ref:def?String(def.ref||''):String(input.ref||''),segments:customActionClone(def&&def.segments?def.segments:(input.segments||[])),path:path,valueType:def?def.valueType:String(input.valueType||''),hostValueType:def?String(def.hostValueType||''):String(input.hostValueType||''),operation:operation,value:value,name:name};}
function customActionValueText(value){if(value==null)return'';if(typeof value==='object'){try{return JSON.stringify(value);}catch(e){return'';}}return String(value);}
`;
}
