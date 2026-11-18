/* 假酒馆的浏览器边界；没有真实用户弹窗，记录确认并接受按卡启用。 */
window.__mock.confirms = [];
window.confirm = function (text) { window.__mock.confirms.push(String(text)); return true; };
