---
name: connector-authoring
description: 给没有预置对接的插件写对接：找接口、起草 connector.json、试调、启用
---
# 给一个插件写对接

目标：让你能调用某个插件公开的函数（读它的记忆 / 状态，或让它做事）。

1. **找接口**
   - 插件自己的文档：请用户给链接（`web` 工具箱抓取），或看 `ext:/<扩展>/manifest.json` → 入口文件 → README / API 文档。
   - 在源码里找它挂到全局的对象：`grep "window\.\w+ *=|globalThis\.\w+ *=" ext:/<扩展>/<入口文件>`。
   - 看现场：`run_js target=page`，例如 `return Object.keys(window.SomePlugin)`，确认对象真的存在、函数名对得上。
2. **起草**：写到 `ws:/plugins/<id>/connector.json`

```json
{
  "id": "someplugin",
  "title": "某插件",
  "summary": "一句话说明它能提供什么",
  "detect": "window.SomePlugin",
  "brief": "SomePlugin.getSummary",
  "tools": [
    { "name": "someplugin_get", "summary": "读取某项数据", "effect": "read",
      "call": "SomePlugin.get", "params": [{ "name": "key", "type": "string", "required": true }] }
  ]
}
```

   - `detect` / `call` / `brief` 是宿主窗口上的全局路径；调用时按 `params` 的顺序传参。
   - `effect`：只读填 `read`，会改东西填 `write`，删除类填 `danger`。`brief` 可省略——它返回的文字会进入「剧情察知」。
   - 这是声明式的，不含代码；需要转换数据才能用的接口，请用户自己写扩展并调用 `ReaderII.agent.registerTool`（见开发者指南）。
3. **试调**：先在 `run_js target=page` 里直接调一次那个函数，确认参数与返回值。
4. **启用**：把这份 JSON 加进设置（需要「酒馆全权」，会请用户确认）：

```js
const agent = window.ReaderII.agent;
const list = agent.getSettings().connectors.filter((item) => item.id !== 'someplugin');
list.push(/* 上面的对象 */);
agent.saveSettings({ connectors: list });
return agent.listConnectors();
```

   之后它的工具在与 id 同名的工具箱里，用 `toolbox` 打开。
5. **告诉用户**：接了哪些函数、哪些会改数据、对接文件放在哪。
