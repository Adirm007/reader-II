import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../src/reader-prompt-placement.js', import.meta.url), 'utf8');
const payload = { core: '夜梦开场白', rules: '更新规则', list: '变量列表' };
function setup() {
  const local = new Map();
  const host = vm.createContext({ localStorage: { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value) } });
  vm.runInContext(code, host);
  return host.__ReaderIIModules.readerPromptPlacement;
}

test('旧账号沿用核心与两条深度提示词位置，保存与账号内其他设置共存', () => {
  const placement = setup();
  let saved = 0;
  const ctx = { extensionSettings: { reader_ii: { agent: { mode: 'card' } } }, saveSettingsDebounced() { saved++; } };
  const config = placement.placements(ctx);
  assert.deepEqual(Array.from(placement.sections, s => [s.key, config[s.key].position, config[s.key].depth, config[s.key].order]), [
    ['core', 0, 0, 100], ['rules', 4, 4, 100], ['list', 4, 1, 200]
  ]);
  Object.assign(config.core, { position: '4', role: '2', depth: '9999', order: '0' });
  config.rules.enabled = false;
  placement.save(ctx, config);
  assert.equal(saved, 1);
  assert.deepEqual(ctx.extensionSettings.reader_ii.agent, { mode: 'card' });
  assert.deepEqual(JSON.parse(JSON.stringify(placement.placements(ctx).core)), { enabled: true, position: 4, depth: 9999, order: 0, role: 2, outletName: '' });
  assert.equal(placement.placements(ctx).rules.enabled, false);
  assert.equal(placement.placements({ extensionSettings: {} }).core.position, 0);
  assert.equal(placement.placements({ extensionSettings: {} }).rules.enabled, true);
  placement.save(null, config);
  assert.equal(placement.placements(null).core.role, 2);
  assert.equal(placement.placements({ extensionSettings: {} }).core.position, 0);
});

test('三段临时条目携带世界书位置、顺序、角色和深度，只在有有效出口时创建宏条目', () => {
  const placement = setup();
  const config = placement.placements(null);
  config.core.order = 554;
  config.core.depth = 6;
  config.core.role = 1;
  config.core.outletName = '夜梦';
  for (const [position] of placement.positions) {
    config.core.position = position;
    const entries = placement.entries(config, payload);
    assert.equal(entries.length, 3);
    assert.equal(new Set(entries.map(e => e.world + '.' + e.uid)).size, 3);
    const core = entries[0];
    assert.deepEqual([core.position, core.order, core.role, core.depth, core.outletName], [position, 554, 1, 6, '夜梦']);
    assert.equal(core.content, payload.core);
    assert.ok(core.constant && core.ignoreBudget && core.preventRecursion);
  }
  config.rules.enabled = false;
  config.core.position = 7;
  for (const name of ['', '__proto__']) {
    config.core.outletName = name;
    assert.equal(placement.entries(config, payload).length, 1);
    assert.equal(placement.entries(config, { ...payload, list: '' }).length, 0);
  }
});

test('损坏或缺失的设置以单个字段为单位恢复', () => {
  const placement = setup();
  const config = placement.placements({ extensionSettings: { reader_ii: { storyPromptPlacement: {
    rules: { position: -9, depth: '', order: null, role: 3, outletName: null },
    list: { position: 7, outletName: ' 变量列表  ', depth: 10000, order: 17 },
  } } } });
  assert.deepEqual([config.rules.position, config.rules.depth, config.rules.order, config.rules.role], [4, 4, 100, 0]);
  assert.deepEqual([config.list.position, config.list.outletName, config.list.depth, config.list.order], [7, '变量列表', 1, 17]);
});
