import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const scope = vm.createContext({});
vm.runInContext(readFileSync(new URL('../src/reader-agent-preset.js', import.meta.url), 'utf8'), scope);
const preset = scope.__ReaderIIModules;

test('使用宿主当前提示词管理器，保留角色、相对顺序、深度注入与附加文本', async () => {
  const current = { id: 'active-profile' };
  const manager = {
    activeCharacter: current,
    getPromptsForCharacter(character, enabledOnly) {
      assert.equal(character, current);
      assert.equal(enabledOnly, true);
      return [
        { content: 'before' }, { identifier: 'chatHistory', marker: true },
        { role: 'system', content: 'after' },
        { role: 'assistant', content: 'depth 1', injection_position: 1, injection_depth: 1 },
        { content: 'suffix', injection_position: 2, attach_role: 'user', attach_index: -1, attach_side: 'end' },
        { content: 'skip', injection_trigger: ['impersonate'] },
      ];
    },
  };
  const selected = await preset.prepareAgentPreset({ host: { SillyTavern: { getContext: () => ({}) } },
    hostImport: async () => ({ promptManager: manager }) }, '夜梦');
  const input = [{ role: 'system', content: 'reader' }, { role: 'user', content: 'past' }, { role: 'user', content: 'current' }];
  const actual = preset.applyAgentPreset(input, selected);
  assert.deepEqual(Array.from(actual, m => [m.role, m.content]), [
    ['system', 'reader'], ['system', 'before'], ['user', 'past'], ['assistant', 'depth 1'],
    ['user', 'current\n\nsuffix'], ['system', 'after'],
  ]);
  assert.equal(input[2].content, 'current');
});

test('旧宿主可从酒馆助手获取正在使用的预设，仅带入启用的条目', async () => {
  const host = {
    SillyTavern: { getContext: () => ({}) },
    TavernHelper: { getPreset(name) {
      assert.equal(name, 'in_use');
      return { prompts: [{ role: 'user', enabled: true, content: 'active' }, { enabled: false, content: 'disabled' }],
        prompts_unused: [{ content: 'unused' }] };
    } },
  };
  const entries = await preset.prepareAgentPreset({ host }, '夜梦');
  assert.deepEqual(Array.from(entries, x => x.message.content), ['active']);
});
