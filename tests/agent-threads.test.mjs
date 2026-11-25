import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup() {
  const env = { host: { crypto: globalThis.crypto } };
  const globals = vm.createContext({});
  for (const file of ['reader-env.js', 'agent/store.js']) {
    vm.runInContext(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), globals);
  }
  const modules = globals.__ReaderIIModules;
  const databases = new Map();
  const factory = (env, name) => {
    if (!databases.has(name)) databases.set(name, modules.createStore(env, name));
    return databases.get(name);
  };
  const ctx = {
    extensionSettings: {}, characterId: 0, chatId: '旅程',
    characters: [{ name: '艾琳', avatar: 'ailin.png' }, { name: '时雨', avatar: 'rain.png' }],
  };
  const reopen = () => modules.createThreadHistory(env, { context: () => ctx }, factory);
  return { ctx, reopen, history: reopen() };
}

test('多对话保留历史、图片与归属，切换卡和账号均隔离，欢迎页单独保存', async () => {
  const { ctx, history, reopen } = setup();
  await history.ready();
  const first = history.currentId();
  const turns = Array.from({ length: 140 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', id: String(i), text: '消息 ' + i,
  }));
  turns.at(-1).images = [{ url: 'https://example.org/generated.png' }];
  await history.write({ turns, extracted: 39 });
  const second = await history.create();
  assert.equal(history.read().turns.length, 0);
  await history.select(first);
  assert.equal(history.read().turns.length, 140);
  assert.equal(history.read().turns.at(-1).images[0].url, turns.at(-1).images[0].url);
  const reloaded = reopen();
  await reloaded.ready();
  assert.equal(reloaded.currentId(), first);
  assert.equal(reloaded.read().extracted, 39);
  ctx.characterId = 1;
  await history.ready();
  assert.notEqual(history.currentId(), first);
  await history.select(first);
  assert.equal(history.canRun(), false);
  await assert.rejects(history.write(history.read()), /切换/);
  ctx.characterId = undefined;
  ctx.chatId = '';
  await history.ready();
  assert.equal(history.isUnbound(), true);
  assert.equal(history.canRun(), true);
  assert.equal(history.list().find(item => item.id === history.currentId()).owner.label, '无卡');
  await history.remove(second);
  const originalAccount = ctx.extensionSettings;
  ctx.extensionSettings = {};
  await history.ready();
  assert.equal(history.list().length, 1);
  assert.equal(history.list().some(item => item.id === first), false);
  ctx.extensionSettings = originalAccount;
  ctx.characterId = 0;
  ctx.chatId = '旅程';
  await history.ready();
  assert.equal(history.currentId(), first);
  assert.equal(history.list().some(item => item.id === second), false);
});

test('交接只带摘要，保留来源；并发编辑按版本拒绝覆盖，刷新可继续', async () => {
  const { history, reopen } = setup();
  await history.ready();
  const fromId = history.currentId();
  const data = history.read();
  data.turns = [{ id: 'u', role: 'user', text: '最初问题' }];
  await history.write(data);
  const another = reopen();
  await another.ready();
  const stale = another.read();
  const dest = await history.handoff({ fromId, input: '继续完成', summary: '已核对来源 A；只需处理 B。' });
  assert.equal(history.currentId(), dest);
  assert.equal(history.read().turns.length, 0);
  assert.equal(history.read().checkpoint.text, '已核对来源 A；只需处理 B。');
  assert.equal(history.read().checkpoint.task, '继续完成');
  await history.select(fromId);
  assert.equal(history.read().turns.at(-1).text, '继续完成');
  assert.equal(history.list().find(item => item.id === fromId).nextId, dest);
  assert.equal(another.currentId(), fromId);
  await assert.rejects(another.write(stale), /已被其他操作修改/);
  await another.refresh();
  const latest = another.read();
  latest.turns[0].text = '重新编辑';
  await another.write(latest);
  await history.refresh();
  assert.equal(history.read().turns[0].text, '重新编辑');
  await history.remove(fromId);
  assert.equal(history.currentId(), dest);
});

test('update 排队读改写；另一个标签页改过时重新载入再追加；交接不重复补已存的用户原话', async () => {
  const { history, reopen } = setup();
  await history.ready();
  const fromId = history.currentId();
  const another = reopen();
  await another.ready();
  await another.update((data) => { data.turns.push({ id: 'x', role: 'user', text: '另一页先说的' }); });
  /* 这一页缓存的还是旧版本：版本对不上时重新载入，再把这句追加上去，不覆盖另一页写的。 */
  await history.update((data) => { data.turns.push({ id: 'y', role: 'user', text: '这一页后说的' }); });
  assert.equal(history.read().turns.map((turn) => turn.id).join(','), 'x,y');
  /* 同一页里排在后面的 update 读到的是前一个落定后的内容。 */
  await Promise.all([
    history.update((data) => { data.turns.push({ id: 'a1', role: 'assistant', text: '一' }); }),
    history.update((data) => { data.extracted = data.turns.length; }),
  ]);
  assert.equal(history.read().extracted, 3);
  const dest = await history.handoff({ fromId, input: '这一页后说的', inputId: 'y', summary: '摘要', users: ['另一页先说的'] });
  assert.equal(history.currentId(), dest);
  assert.equal(history.read().checkpoint.users.join(','), '另一页先说的');
  await history.select(fromId);
  assert.equal(history.read().turns.map((turn) => turn.id).join(','), 'x,y,a1');
});

test('待返回的正文刷新不会覆盖新选中的线程，带占位角色 ID 的欢迎页使用无卡记录', async () => {
  const { ctx, history } = setup();
  await history.ready();
  const original = history.currentId();
  const [, created] = await Promise.all([history.refresh(), history.create()]);
  assert.equal(history.currentId(), created);
  const first = history.select(original);
  const second = history.select(created);
  const ready = history.ready();
  await Promise.all([first, second, ready]);
  assert.equal(history.currentId(), created);
  for (const emptyId of ['', -1, '-1', null, undefined]) {
    ctx.characterId = emptyId;
    await history.ready();
    assert.equal(history.isUnbound(), true);
  }
  ctx.characterId = '0';
  await history.ready();
  assert.equal(history.isUnbound(), false);
  assert.equal(history.currentId(), created);
});
