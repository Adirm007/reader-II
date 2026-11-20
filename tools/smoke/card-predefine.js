/* 假酒馆的浏览器边界；没有真实用户弹窗，记录确认并接受按卡启用。 */
window.__mock.confirms = [];
window.confirm = function (text) { window.__mock.confirms.push(String(text)); return true; };

// 自动冒烟用一份刚升级的存档，验证旧助手聊天可翻阅、旧记忆不会被带入新库。
if (new URLSearchParams(location.search).get('auto') === '1') {
  const vars = window.__mock.ctx.chatMetadata.variables;
  vars.reader_ii_memory = { items: {
    old: { id: 'old', type: 'fact', owner: 'agent', source: 'agent', title: '旧记忆样本', content: '旧助手偏好', pinned: true },
  } };
  vars.reader_ii_agent = { v: 1, extracted: 0, turns: [
    { id: 'old-user', role: 'user', text: '升级前的聊天样本。' },
    { id: 'old-assistant', role: 'assistant', text: '旧版助手回复。' },
  ] };
}
