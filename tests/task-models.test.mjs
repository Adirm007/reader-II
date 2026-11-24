import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const scope = vm.createContext({ URL, AbortController, Blob, btoa, setTimeout, clearTimeout });
for (const file of ['reader-env','reader-media','reader-task-models','reader-llm-gateway']) {
  vm.runInContext(readFileSync(new URL('../src/' + file + '.js', import.meta.url), 'utf8'), scope);
}
const messages = [{ role:'user', content:'请检查摘要' }];
function fixture(handler, ctx, hostImport) {
  const bag = new Map(), calls = [];
  const gateway = scope.__ReaderIIModules.createLlmGateway({
    storage:{ getItem:k => bag.get(k), setItem:(k,v) => bag.set(k,v) }, hostImport,
    host:{ SillyTavern:ctx && { getContext:() => ctx }, fetch:async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, body, init });
      return handler(url, init, body);
    } },
  });
  const add = (model, source = 'openai') => gateway.saveConnectionPreset({
    name:model, model, source, apiurl:'https://' + model + '.test/v1', key:model + '-key',
  });
  return { gateway, calls, add };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('智能从当前助手连接取完整模型列表，每次派发重新读取；固定分工可切另一个反代及思考档位', async () => {
  const { gateway:g, calls, add } = fixture((url, init, body) => url.endsWith('/models') ? Response.json({ data:[
    { id:'a', context_length:20000 }, { id:'worker', context_length:1000000, supported_reasoning_efforts:['low','high'] },
  ] }) : Response.json({ choices:[{ message:{ content:body.model } }] }));
  const a = add('a'), b = add('b');
  g.saveAgentConnection({ selected:a.id });
  const catalog = await g.listTaskModels('delegate', { selected:'agent' });
  assert.equal(calls[0].url, 'https://a.test/v1/models');
  assert.deepEqual(plain(catalog[1].reasoningEfforts), ['low','high']);
  const main = await g.resolveTaskModel('delegate', { model:'a' });
  assert.equal(main.contextWindow, 20000); assert.equal(main.isCurrent, true);
  await g.chatTask({ messages, model:'worker', reasoningEffort:'high' });
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer a-key');
  assert.equal(calls.at(-1).body.reasoning_effort,'high');
  assert.equal(calls.at(-1).body.tools, undefined);
  await g.chatTask({ messages, presetId:b.id, model:'a', reasoningEffort:'high' });
  assert.equal(calls.at(-1).init.headers.Authorization,'Bearer b-key');
  assert.equal(calls.at(-1).body.reasoning_effort,undefined);
  g.saveAgentConnection({ selected:b.id });
  await g.listTaskModels('delegate');
  assert.equal(calls.at(-1).url,'https://b.test/v1/models');
});

test('独立方案密码不可读，改地址后清除；开关保留媒体方案和模型', () => {
  const { gateway:g, add } = fixture(() => assert.fail());
  const p = add('video');
  assert.equal(g.getConnectionPreset(p.id).hasKey,true);
  assert.doesNotMatch(JSON.stringify(g.getConnectionPreset(p.id)), /video-key/);
  g.saveConnectionPreset({ ...p, apiurl:'https://new.test/v1' });
  assert.equal(g.getConnectionPreset(p.id).hasKey,false);
  assert.equal(g.getTaskConnection('video').configured,false);
  g.saveTaskConnection('video',{selected:p.id,model:'sora-2',enabled:true});
  assert.equal(g.getTaskConnection('video').configured,true);
  g.saveTaskConnection('video',{selected:'off'});
  assert.equal(g.getTaskConnection('video').configured,false);
  assert.equal(g.getTaskConnection('video').model,'sora-2');
  assert.equal(g.getTaskConnection('video').selected,p.id);
});

test('酒馆主连接允许当前模型覆盖，不修改主连接设置；后端错误保留 HTTP 状态', async () => {
  const ctx = { mainApi:'openai', chatCompletionSettings:{chat_completion_source:'custom',custom_model:'main',custom_url:'https://host.test'},getRequestHeaders:() => ({'x-csrf':'x'}) };
  const { gateway:g,calls } = fixture((url,init,body) => url.endsWith('/status') ? Response.json({data:[{id:'other'}]}) :
    body.model === 'bad' ? Response.json({error:{message:'Insufficient balance'}},{status:402}) :
    Response.json({choices:[{message:{content:body.model}}]}), ctx, async () => ({
      getChatCompletionModel:s => s.custom_model, createGenerationParameters:async (settings, model, type, messages) => ({generate_data:{...settings,model,messages}}),
    }));
  assert.equal(await g.chatTask({ model:'other',messages }), 'other');
  assert.equal(calls.at(-1).url, '/api/backends/chat-completions/generate');
  assert.equal(ctx.chatCompletionSettings.custom_model,'main');
  await assert.rejects(g.chatTask({ model:'bad',messages }), e => e.status === 402 && /balance/.test(e.message));
});

test('OpenAI 图像输出下载后可在对话持久显示；跨域媒体下载不带任何授权头', async () => {
  const { gateway:g,calls,add } = fixture((url) => url.endsWith('/images/generations')
    ? Response.json({data:[{url:'https://temporary.test/file.png'}]}) : new Response(new Uint8Array([1,2,3]), {headers:{'Content-Type':'image/png'}}));
  const p = add('photo');
  g.saveTaskConnection('image',{selected:p.id,model:'gpt-image-1',enabled:true});
  const out = await g.generateMedia('image','鲸鱼');
  assert.equal(calls[0].body.model,'gpt-image-1');
  assert.equal(calls[0].init.headers.Authorization,'Bearer photo-key');
  assert.equal(calls[1].init.credentials,'omit');
  assert.deepEqual(Object.keys(calls[1].init.headers),[]);
  assert.equal(out.images[0].url,'data:image/png;base64,AQID');
});

test('OpenAI 视频一次创建，查询任务后下载携带同源鉴权的视频字节', async () => {
  const { gateway:g,calls,add } = fixture((url) => url.endsWith('/videos') ? Response.json({id:'job123',status:'queued'}) :
    url.endsWith('/content') ? new Response(new Uint8Array([11,22,33]),{headers:{'content-type':'video/mp4'}}) : Response.json({id:'job123',status:'completed'}));
  const p = add('video');
  g.saveTaskConnection('video',{selected:p.id,model:'sora-2'});
  const out = await g.generateMedia('video','城市夜景',{seconds:8,size:'1280x720'});
  assert.deepEqual(calls.map(call => call.url), ['https://video.test/v1/videos','https://video.test/v1/videos/job123','https://video.test/v1/videos/job123/content']);
  assert.equal(calls[0].body.seconds,'8');
  assert.equal(calls[2].init.headers.Authorization,'Bearer video-key');
  assert.equal(out.videos[0].url,'data:video/mp4;base64,CxYh');
});

test('原生 Gemini 采用 generateContent，Veo 读取任务与成片，用外部签名 URI 下载时不泄露 Google key', async () => {
  const { gateway:g,calls,add } = fixture((url) => {
    if (url.endsWith(':generateContent')) return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/webp',data:'AQID'}}]}}]});
    if (url.endsWith(':predictLongRunning')) return Response.json({name:'models/veo/operations/id-1'});
    if (url.endsWith('/operations/id-1')) return Response.json({done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:'https://signed.test/video'}}]}}});
    return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'video/mp4'}});
  });
  const p = add('google','makersuite');
  g.saveTaskConnection('image',{selected:p.id,model:'gemini-3-pro-image-preview'});
  g.saveTaskConnection('video',{selected:p.id,model:'veo-3.1-generate-preview'});
  assert.equal((await g.generateMedia('image','海')).images[0].url,'data:image/webp;base64,AQID');
  assert.deepEqual(calls[0].body.generationConfig.responseModalities,['TEXT','IMAGE']);
  assert.equal((await g.generateMedia('video','雨')).videos[0].url,'data:video/mp4;base64,AQID');
  assert.equal(calls[1].init.headers['x-goog-api-key'],'google-key');
  assert.equal(calls.at(-1).url,'https://signed.test/video');
  assert.deepEqual(Object.keys(calls.at(-1).init.headers),[]);
});

test('视频中止、超时、上游任务失败均不重新创建任务', async () => {
  for (const mode of ['cancel','timeout','failed']) {
    const controller = new AbortController();
    const { gateway:g,calls,add } = fixture(async (url,init) => {
      if (url.endsWith('/videos')) return Response.json({id:'one',status:'queued'});
      if (mode === 'failed') return Response.json({status:'failed',error:{ message:'quota reached' }});
      if (mode === 'cancel') setTimeout(() => controller.abort(),1);
      return new Promise((resolve,reject) => init.signal.addEventListener('abort',() => reject(new DOMException('abort','AbortError')),{once:true}));
    });
    const p = add('sora'); g.saveTaskConnection('video',{selected:p.id});
    await assert.rejects(g.generateMedia('video','山',{signal:controller.signal,timeoutMs:mode === 'timeout' ? 12 : 5000}),
      e => mode === 'failed' ? /quota reached/.test(e.message) : e.name === (mode === 'cancel' ? 'AbortError' : 'TimeoutError'));
    assert.equal(calls.filter(c => c.init.method === 'POST').length,1);
  }
});

test('Veo 同源下载允许 302 到 CDN，实际 HTTP 重定向不会带去源密钥', async t => {
  async function serve(handler) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return 'http://127.0.0.1:' + server.address().port;
  }
  let received, originalKey;
  const cdn = await serve((req,res) => { received = [req.headers,req.url]; res.setHeader('Content-Type','video/mp4'); res.end(Buffer.from([4,5])); });
  const origin = await serve((req,res) => {
    if (req.url.startsWith('/file?')) {
      originalKey = new URL(req.url,'http://localhost').searchParams.get('key');
      res.writeHead(302,{ Location:cdn + '/signed' }); res.end(); return;
    }
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.method === 'POST' ? { name:'operations/test' } :
      { done:true, response:{ generateVideoResponse:{ generatedSamples:[{ video:{ uri:origin + '/file?alt=media' } }] } } }));
  });
  const bag = new Map();
  const g = scope.__ReaderIIModules.createLlmGateway({ storage:{getItem:k=>bag.get(k),setItem:(k,v)=>bag.set(k,v)},host:{fetch} });
  const p = g.saveConnectionPreset({ model:'veo-3.1-test',apiurl:origin,source:'makersuite',key:'secret' });
  g.saveTaskConnection('video',{selected:p.id});
  assert.equal((await g.generateMedia('video','蓝天')).videos[0].url,'data:video/mp4;base64,BAU=');
  assert.equal(originalKey,'secret');
  assert.doesNotMatch(JSON.stringify(received),/secret|x-goog-api-key|authorization/i);
});

test('主连接为自定义端点时保留端点路径及其授权，模型覆盖只用于当前媒体请求', async () => {
  const ctx = {mainApi:'openai',chatCompletionSettings:{chat_completion_source:'custom',custom_model:'main',
    custom_url:'https://custom.test/proxy/openai/v1', custom_include_headers:'{"X-Proxy-Key":"main-secret"}'},getRequestHeaders:()=>({'X-CSRF-Token':'local-secret'})};
  const { gateway:g,calls } = fixture(url => url.endsWith('/images/generations') ? Response.json({data:[{b64_json:'AQI='}]}) :
    url.endsWith('/videos') ? Response.json({id:'ok',status:'completed'}) : new Response(new Uint8Array([9]),{headers:{'content-type':'video/mp4'}}), ctx);
  g.saveTaskConnection('image',{selected:'agent',model:'gpt-image-1'}); g.saveTaskConnection('video',{selected:'agent',model:'sora-2'});
  const img = await g.generateMedia('image','星空');
  assert.equal(img.images[0].url,'data:image/png;base64,AQI=');
  await g.generateMedia('video','星空');
  assert.equal(calls[0].url,'https://custom.test/proxy/openai/v1/images/generations');
  assert.equal(calls[1].url,'https://custom.test/proxy/openai/v1/videos');
  assert.equal(calls[2].init.headers['X-Proxy-Key'],'main-secret');
  assert.equal(calls[2].init.redirect,'error');
  assert.equal(calls[0].init.headers['X-CSRF-Token'],undefined);
  assert.equal(ctx.chatCompletionSettings.custom_model,'main');
});

test('只给文本子代理列出可对话能力，未知别名和明确否定的思考能力不猜档位', async () => {
  const { gateway:g,add } = fixture(() => Response.json({data:[
    {id:'gpt-5.4',supports_reasoning:false},{id:'some-model'}, {id:'reranker',type:'rerank',output_modalities:['text']},
    {id:'veo-3.1-test'},{id:'gpt-image-1'},{id:'text-embedding-3-small'},
  ]}));
  const p = add('proxy');
  g.saveAgentConnection({selected:p.id});
  const records = await g.listTaskModels('delegate');
  assert.deepEqual(plain(records.filter(r=>r.supportsTextChat).map(r=>r.id)),['gpt-5.4','some-model']);
  assert.equal(records[0].reasoningEfforts.length,0);
  assert.equal(records[1].reasoningEfforts.length,0);
});

test('子代理尊重服务端的内容停止标记，不能当作空文本再换模型', async () => {
  const { gateway:g,add,calls } = fixture(url => url.endsWith('/models') ? Response.json({ data:[{id:'worker'}] }) :
    Response.json({choices:[{message:{content:'',refusal:'不能处理此请求'},finish_reason:'content_filter'}]}));
  const p = add('worker');
  await assert.rejects(g.chatTask({messages,presetId:p.id}), {code:'provider_stop'});
  assert.equal(calls.filter(c=>c.url.endsWith('/chat/completions')).length,1);
});

test('酒馆文本补全查询实际服务器、切换端点后重新识别同名模型；派发覆盖模型时不传思考档', async () => {
  const settings = { type:'ollama',ollama_model:'worker',server_urls:{ollama:'http://localhost:11001'} };
  const ctx = { mainApi:'textgenerationwebui', textCompletionSettings:settings, maxContext:20000, getRequestHeaders:()=>({'X-CSRF-Token':'test'}),
    chatCompletionSettings:{chat_completion_source:'openai',openai_model:'stale-chat-model',reverse_proxy:'https://stale.test/v1'} };
  const module = { textgenerationwebui_settings:settings, getTextGenModel:s=>s.ollama_model, getTextGenServer:type=>settings.server_urls[type] };
  const {gateway:g,calls} = fixture((url,init,body) => {
    assert.equal(init.headers['X-CSRF-Token'],'test');
    if (url === '/api/backends/text-completions/status') {
      assert.equal(body.api_type,'ollama');
      return Response.json({result:'worker',data:[{id:'worker'},{id:'alternate',context_length:body.api_server.endsWith('11001') ? 20000 : 64000,
        supported_reasoning_efforts:['high']}]});
    }
    assert.equal(url,'/api/backends/text-completions/generate');
    return Response.json({ choices:[{text:'检查完成'}] });
  },ctx,async path => path === '/script.js' ? { amount_gen:256, max_context:20000, extractMessageFromData:data=>data.choices[0].text } : module);
  const models = await g.listTaskModels('delegate');
  assert.equal(models[1].contextWindow,20000); assert.equal(models[1].reasoningEfforts.length,0);
  assert.equal((await g.resolveTaskModel('delegate')).model,'worker');
  settings.server_urls.ollama = 'http://localhost:11002';
  const child = await g.resolveTaskModel('delegate',{model:'alternate'});
  assert.equal(child.source,'ollama'); assert.equal(child.contextWindow,64000); assert.equal(child.isCurrent,false);
  assert.equal(await g.chatTask({ model:'alternate', reasoningEffort:'high', messages }), '检查完成');
  assert.equal(calls.at(-1).body.api_server,'http://localhost:11002');
  assert.equal(calls.at(-1).body.model,'alternate'); assert.equal(calls.at(-1).body.reasoning_effort,undefined);
  assert.equal(calls.filter(c=>c.url.endsWith('/status')).length,2);
  assert.doesNotMatch(JSON.stringify(calls),/stale\.test|stale-chat-model/);
});

test('子代理模型列表识别 Gemini 2.5 / 3 / 4 各代的思考档位与上下文窗口', async () => {
  const { gateway:g, add } = fixture(() => Response.json({ data:[
    { id:'gemini-4-neon' }, { id:'gemini-4-argon' }, { id:'gemini-3.1-pro-preview' },
    { id:'gemini-3-pro-preview' }, { id:'gemini-3-flash-preview' }, { id:'gemini-2.5-flash' },
    { id:'gemini-2.5-flash-image' },
  ] }));
  const p = add('google');
  g.saveAgentConnection({ selected:p.id });
  const records = await g.listTaskModels('delegate');
  const byId = Object.fromEntries(records.map(r => [r.id, r]));
  assert.deepEqual(plain(byId['gemini-4-neon'].reasoningEfforts), ['low','medium','high','xhigh']);
  assert.equal(byId['gemini-4-neon'].contextWindow, 1048576);
  assert.deepEqual(plain(byId['gemini-4-argon'].reasoningEfforts), ['low','medium','high']);
  assert.deepEqual(plain(byId['gemini-3.1-pro-preview'].reasoningEfforts), ['low','medium','high']);
  assert.deepEqual(plain(byId['gemini-3-pro-preview'].reasoningEfforts), ['low','high']);
  assert.deepEqual(plain(byId['gemini-3-flash-preview'].reasoningEfforts), ['minimal','low','medium','high']);
  assert.deepEqual(plain(byId['gemini-2.5-flash'].reasoningEfforts), ['none','minimal','low','medium','high']);
  assert.deepEqual(plain(byId['gemini-2.5-flash-image'].reasoningEfforts), []);
});

test('gateway.chatTools 与 chatTaskTools 支持独立 api 与 modelOverride 路由，文本补全或显式主连接均正确分流', async () => {
  const { gateway: g, calls, add } = fixture((url, init, body) => {
    if (url.endsWith('/models')) {
      return Response.json({ data: [
        { id: 'main-a', context_length: 32000 },
        { id: 'director-pro', context_length: 200000, supported_reasoning_efforts: ['low', 'high'] },
      ] });
    }
    return Response.json({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'wb:/设定集/旧港' }) } }],
        },
      }],
    });
  });
  const a = add('main-a');
  const b = add('director-base');
  g.saveAgentConnection({ selected: a.id });
  g.saveTaskConnection('director', { selected: b.id, model: 'director-pro', effort: 'high' });

  const tools = [{ type: 'function', function: { name: 'read', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];

  /* 1. 直接调 gateway.toolSupport / gateway.chatTools 传独立 api 与 modelOverride，不改原对象 */
  const customApi = { apiurl: 'https://custom-dir.test/v1', key: 'custom-key', model: 'orig-model', source: 'openai' };
  const sup = g.toolSupport('agent', { api: customApi, modelOverride: 'override-model' });
  assert.deepEqual(plain(sup), { native: true, via: 'direct', model: 'override-model' });
  const directReply = await g.chatTools({ api: customApi, modelOverride: 'override-model', route: 'agent', messages, tools, toolChoice: 'auto', textOnly: true });
  assert.equal(customApi.model, 'orig-model', '不篡改调用方传入的 api 对象');
  assert.equal(calls.at(-1).url, 'https://custom-dir.test/v1/chat/completions');
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer custom-key');
  assert.equal(calls.at(-1).body.model, 'override-model');
  assert.equal(calls.at(-1).body.tools[0].function.name, 'read');
  assert.equal(directReply.toolCalls[0].name, 'read');

  /* 2. chatTaskTools('director') 走总导演自己的独立方案、覆盖模型与思考档位，而不是主助手方案 a */
  const taskSup = g.taskToolSupport('director');
  assert.equal(taskSup.native, true);
  assert.equal(taskSup.model, 'director-pro');
  const taskReply = await g.chatTaskTools({ kind: 'director', messages, tools, toolChoice: 'auto' });
  assert.equal(calls.at(-1).url, 'https://director-base.test/v1/chat/completions');
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer director-base-key');
  assert.equal(calls.at(-1).body.model, 'director-pro');
  assert.equal(calls.at(-1).body.reasoning_effort, 'high');
  assert.equal(calls.at(-1).body.tools[0].function.name, 'read');
  assert.equal(taskReply.toolCalls[0].name, 'read');

  /* 3. 酒馆主连接是文本补全时，即使主助手配了独立方案，总导演切到 tavern 也必须抛 no_native_tools 供回退 */
  const textCtx = { mainApi: 'textgenerationwebui', textCompletionSettings: { type: 'ollama', ollama_model: 'local-text', server_urls: { ollama: 'http://localhost:11434' } } };
  const textEnv = fixture((url) => url.endsWith('/status') ? Response.json({ data: [{ id: 'local-text' }] }) : Response.json({ choices: [{ text: 'ok' }] }), textCtx);
  const p = textEnv.add('agent-only');
  textEnv.gateway.saveAgentConnection({ selected: p.id });
  textEnv.gateway.saveTaskConnection('director', { selected: 'tavern' });
  assert.equal(textEnv.gateway.toolSupport('agent', { api: null }).native, false);
  assert.equal(textEnv.gateway.taskToolSupport('director').native, false);
  await assert.rejects(textEnv.gateway.chatTaskTools({ kind: 'director', messages, tools }), { code: 'no_native_tools' });

  /* 4. P1-4 反例：上下文超限（含 "in the functions"）、工具序列错误、内容风控 400 绝不能被误判为 no_native_tools */
  const falsePositives = [
    "This model's maximum context length is 8192 tokens (7500 in the messages, 700 in the functions).",
    'messages.2: tool_use ids were found without tool_result blocks immediately after',
    "Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.",
    'Please ensure that function call turn comes immediately after a user turn or after a function response turn.',
    'Request rejected due to content_filter safety policy',
  ];
  for (const errText of falsePositives) {
    const errEnv = fixture(() => new Response(JSON.stringify({ error: { message: errText } }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const pr = errEnv.add('err-preset');
    errEnv.gateway.saveTaskConnection('director', { selected: pr.id });
    let caught = null;
    try { await errEnv.gateway.chatTaskTools({ kind: 'director', messages, tools, retries: 0 }); } catch (e) { caught = e; }
    assert.ok(caught, '应抛出错误：' + errText);
    assert.notEqual(caught.code, 'no_native_tools', '绝不能将此错误误判为 no_native_tools：' + errText);
  }
  /* 而明确不支持 tools 的 400（含 Gemma not enabled、Pydantic Extra inputs are not permitted 等）应准确抛 no_native_tools */
  const trueUnsup = [
    'Unrecognized request argument supplied: tools',
    'Function calling is not enabled for models/gemma-3-27b-it',
    'tools: Extra inputs are not permitted',
    'Function calling is disabled for this model',
  ];
  for (const errText of trueUnsup) {
    const realUnsup = fixture(() => new Response(JSON.stringify({ error: { message: errText } }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const rp = realUnsup.add('unsup-preset');
    realUnsup.gateway.saveTaskConnection('director', { selected: rp.id });
    await assert.rejects(realUnsup.gateway.chatTaskTools({ kind: 'director', messages, tools, retries: 0 }), { code: 'no_native_tools' }, '应识别为 no_native_tools：' + errText);
  }
});
