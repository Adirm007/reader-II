---
name: debugging
description: 排查「爆红 / 不渲染 / 变量不更新 / 脚本没反应」的标准定位步骤
---
# 排查步骤

按「看现场 → 定位 → 验证 → 最小修改 → 复核」推进：

1. **查看现场**：先读 `page:/errors`（近期报错与红框提示）和 `page:/env.json`（酒馆助手版本、已装插件），记录报错的文件名、函数名和关键词。
2. **按症状定位**：
   - 界面不渲染或错位 → `grep` 查 `regex:/`（核对 `find.txt` 匹配规则与 `replace.html` 的 HTML/脚本）。
   - 脚本无响应 → `grep` 查 `script:/`。
   - 设定或 EJS 异常 → `grep` 查 `wb:/` 与 `preset:/`；打开 `toolbox ejs` 用 `ejs_features` 检查开关、`ejs_check_syntax` 检查语法、`ejs_variables` 核对变量路径。
   - 变量未更新 → 打开 `toolbox mvu` 用 `mvu_inspect` / `mvu_test_update` 验证 MVU；或打开 `toolbox lwb` 用 `lwb_schema` / `lwb_v3_inspect` / `lwb_v3_preview` 验证小白X 2.0/3.0。
3. **定向读取**：依据 `grep` 返回的行号或列号，分段 `read` 出问题附近的几十行代码。
4. **验证假设**：用 `run_js target=page` 检查运行期全局对象或楼层数据；把纯逻辑与正则匹配放 `run_js target=sandbox` 用样本测试。
5. **最小改动与回读**：用 `edit` 仅替换故障片段，改完回读确认，再请用户刷新或重新生成验证效果。
6. **清晰汇报**：说明根因、修改位置、验证方式以及尚未覆盖的验证项。

## 常见根因速查

- **正则不生效**：检查 `find` 是否符合 `/…/flags` 写法；核对作用范围（AI 输出 / 用户输入）与「仅格式显示 / 仅格式提示词」；检查正文标签是否被排序更靠前的正则提前改写。
- **变量不更新**：检查 `chat:/latest` 原始输出格式是否闭合；核对路径前缀（MVU 更新命令省 `stat_data.`，EJS/宏必须带 `stat_data.`）；检查 Zod / `$meta` / 小白X 约束是否拒收（见 `page:/errors` 或 `mvu_test_update` / `lwb_v3_inspect`）。
- **脚本无响应**：检查脚本启用状态、依赖全局对象的初始化时机，以及是否存在同名重复脚本互相覆盖。
