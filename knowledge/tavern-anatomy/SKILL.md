---
name: tavern-anatomy
description: 酒馆里各样东西在哪：角色卡、世界书、正则、酒馆助手脚本、预设、变量各自的路径与写法要点
---
# 酒馆里的东西在哪

| 想找 / 想改 | 路径 | 要点 |
|---|---|---|
| 正文某一楼 | `chat:/<楼层>`（从 0 起，`latest` 是最新） | 改正文用 edit；`<楼层>.json` 是属性，只读 |
| 角色卡字段 | `card:/description.md` `first_mes.md` `greetings/<n>.md` … | 改完即保存；`meta.json` 只读 |
| 世界书条目 | `wb:/<书>/<条目>` | 开关、触发词、位置在 `<条目>.meta.json`；同名条目带 `#uid` |
| 正则 | `regex:/global|card/<名>/find.txt` · `replace.html` · `meta.json` | 美化界面的 HTML 通常在 replace.html 里，很长，先 grep |
| 酒馆助手脚本 | `script:/global|card|preset/<名>/content.js` | 常被压成一行：grep 会给出列号，再 `read … column=` |
| 预设提示词 | `preset:/prompts/<名>.md` | 只有正在使用的预设 |
| 变量 | `var:/chat.json` `message/<楼层>.json` `mvu.json` `global.json` | `#/a/b` 取子树：`var:/mvu.json#/stat_data/主角` |
| 别的扩展的源码 | `ext:/<扩展>/manifest.json` → 入口文件 | 只读，目录列不出来，顺着 import 读 |
| 报错现场 | `page:/errors` `page:/console` `page:/env.json` | 先看这里 |

- 哪本世界书属于当前卡：`ls wb:/` 的备注里写着「当前卡 / 当前聊天 / 全局启用」。单卡档位只能改前两种。
- 世界书条目的 `strategy.type`：`constant` 常驻（蓝灯）、`selective` 关键词（绿灯）、`vectorized` 向量。
- 新建条目：直接 `write wb:/<书>/<新条目名>`；再改它的 `.meta.json` 设触发词。
- 改动前先读、改动后回读。名字里的 `/ # %` 在路径里是 `%2F %23 %25`，照抄 ls 给出的名字即可。
