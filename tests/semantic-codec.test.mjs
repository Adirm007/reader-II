import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const readerDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const context = { console, structuredClone };
context.globalThis = context;
context.window = context;
vm.createContext(context);
for (const name of ['reader-mvu-guard.js', 'reader-host-adapter.js', 'reader-semantic-codec.js']) {
  vm.runInContext(fs.readFileSync(path.join(readerDir, 'src', name), 'utf8'), context, { filename: name });
}
const codec = context.__ReaderIIModules;
const ref = 'hostref:' + encodeURIComponent(JSON.stringify(['stat_data', '复杂.根[测试]']));

assert.equal(codec.validateSemanticLeaf('location', '陶匠巷祖屋'), '陶匠巷祖屋');
assert.equal(codec.validateSemanticLeaf('location', {
  '大陆': '沃恩德大陆',
  '区域': '埃鲁因西境-兰托尼兰城',
  '场所': '陶匠巷祖屋',
}), '沃恩德大陆 - 埃鲁因西境-兰托尼兰城 - 陶匠巷祖屋', '地点中间节点应按宿主顺序聚合字符串叶子');
assert.throws(() => codec.validateSemanticLeaf('location', { 坐标: { x: 12, y: 9 } }), /字符串/);
assert.throws(() => codec.validateSemanticLeaf('currency', { 金额: 10 }), /有限数值叶节/, '有写回语义的货币不得含糊聚合容器');

const characterArray = [
  { 档案: { 名字: '低谷' }, 关系: { 值: -100 } },
  { 档案: { 名字: '同伴' }, 关系: { 值: 40 } },
];
const characterLinear = codec.validateSemanticMapping('characters', {
  version: 1,
  slot: 'characters',
  rootRef: ref,
  containerKind: 'array',
  name: { from: 'path', path: ['档案', '名字'] },
  fields: { favor: { path: ['关系', '值'], transform: { type: 'linear', scale: 0.5, offset: 50 } } },
}, ref, characterArray).mapping;
assert.deepEqual(JSON.parse(JSON.stringify(codec.normalizeSemanticContainer(characterLinear, characterArray))), [
  { name: '低谷', favor: 0 },
  { name: '同伴', favor: 70 },
]);

const characterEnum = codec.validateSemanticMapping('characters', {
  version: 1,
  slot: 'characters',
  rootRef: ref,
  containerKind: 'object',
  name: { from: 'key' },
  fields: { favor: { path: ['文字好感'], transform: { type: 'enum', values: { 陌生: 10, 挚友: 90 } } } },
}, ref, { 'A.B[角色]': { 文字好感: '挚友' } }).mapping;
assert.deepEqual(JSON.parse(JSON.stringify(codec.normalizeSemanticContainer(characterEnum, { 'A.B[角色]': { 文字好感: '挚友' } }))), [
  { name: 'A.B[角色]', favor: 90 },
]);

const taskMapping = codec.validateSemanticMapping('tasks', {
  version: 1,
  slot: 'tasks',
  rootRef: ref,
  containerKind: 'object',
  name: { from: 'key' },
  fields: {},
}, ref, { '任务.一[特别]': { 奖励: '不读取' } }).mapping;
assert.deepEqual(JSON.parse(JSON.stringify(codec.normalizeSemanticContainer(taskMapping, { '任务.一[特别]': { 奖励: '不读取' } }))), ['任务.一[特别]']);

const skillMapping = codec.validateSemanticMapping('skills', {
  version: 1,
  slot: 'skills',
  rootRef: ref,
  containerKind: 'array',
  name: { from: 'path', path: ['meta', '名称'] },
  fields: {},
}, ref, [{ meta: { 名称: '故事的主人' }, 品质: '不读取' }]).mapping;
assert.deepEqual(JSON.parse(JSON.stringify(codec.normalizeSemanticContainer(skillMapping, [{ meta: { 名称: '故事的主人' } }]))), ['故事的主人']);

const statusContainer = { 初始键: { 元: { 名: '初始状态' }, 文: { 效果: '有效', 时长: '1轮' }, 类型: '宿主' } };
const statusMapping = codec.validateSemanticMapping('statuses', {
  version: 1,
  slot: 'statuses',
  rootRef: ref,
  containerKind: 'object',
  name: { from: 'path', path: ['元', '名'] },
  fields: { effect: { path: ['文', '效果'] }, duration: { path: ['文', '时长'] } },
  construct: { constants: [{ path: ['类型'], value: '特殊' }] },
}, ref, statusContainer).mapping;
const inserted = codec.insertSemanticStatusIfAbsent(statusMapping, statusContainer, {
  name: '主题:海边',
  effect: '效果文本包含《海边》；没有独立作品语义。',
  duration: '至定调解除',
});
assert.equal(inserted.inserted, true);
assert.deepEqual(JSON.parse(JSON.stringify(statusContainer['主题:海边'])), {
  元: { 名: '主题:海边' },
  文: { 效果: '效果文本包含《海边》；没有独立作品语义。', 时长: '至定调解除' },
  类型: '特殊',
});

assert.throws(() => codec.validateSemanticMapping('tasks', {
  version: 1, slot: 'tasks', rootRef: ref, containerKind: 'array', name: { from: 'path', path: ['名称'] }, fields: {},
}, ref, []), /空容器/);
assert.doesNotThrow(() => codec.validateSemanticMapping('tasks', {
  version: 1, slot: 'tasks', rootRef: ref, containerKind: 'array', name: { from: 'path', path: ['名称'] }, fields: {},
}, ref, [], { allowEmpty: true }), '已确认映射在容器暂时清空后应允许确定性结构复验');
assert.throws(() => codec.validateSemanticMapping('skills', {
  version: 1, slot: 'skills', rootRef: ref, containerKind: 'array', name: { from: 'path', path: ['__proto__'] }, fields: {},
}, ref, [{ 名称: '危险' }]), /危险/);
assert.throws(() => codec.validateSemanticMapping('tasks', {
  version: 1, slot: 'tasks', rootRef: ref, containerKind: 'object', name: { from: 'key' }, fields: {}, note: 'function(){return 1}',
}, ref, { 任务: {} }), /JS|函数|不允许/);

console.log('semantic-codec.test.mjs: all assertions passed');
