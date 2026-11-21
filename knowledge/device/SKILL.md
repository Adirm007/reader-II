---
name: device
description: 通过后端伴侣在本地设备工作：dev:/ 文件、命令与后台任务、无头浏览器与酒馆扩展开发
---
# 在设备上做事

## 就绪条件

满足以下三项后即可使用设备能力（【当前环境】中出现「后端伴侣：已连接并放行」即已连通；缺任一项时按工具报错如实告知用户）：

1. 已部署后端伴侣（酒馆后端插件，或独立运行进程；TauriTavern 需独立运行）。
2. 用户在「设置 → 后端伴侣」中完成配对并在本机管理页批准放行（放行有时效）。
3. 助手权限档位已设为「设备全权」。

## 设备文件：`dev:/`

可直接使用核心文件工具 `ls` / `grep` / `read` / `edit` / `write`：

- 常用起点：`dev:/~/…`（用户主目录）、`dev:/@ws/…`（伴侣工作目录，适合存放草稿与克隆仓库）。
- 绝对路径：Windows 写作 `dev:/C:/Users/…`，Linux/macOS/Termux 写作 `dev:/home/…`、`dev:/data/data/com.termux/files/home/…`；`ls dev:/` 可列出可用根目录与盘符。
- `grep` 在设备端执行，自动跳过 `.git`、`node_modules`；范围过大时按提示缩小目录。
- 文件读取统一使用 `\n`，写回原 CRLF 文件时自动恢复原换行格式；文件改动自动记入本轮撤销记录。
- `rm` 仅删除单个文件或空目录；删除非空目录或处理二进制文件需经 `device_exec` 执行命令并先向用户说明影响。

## 执行命令：`device_exec`

打开 `device` 工具箱后，先调用 `device_env` 确认 `platform`、可用工具与包管理器：

- 命令以**非交互模式**运行：需要确认的命令附带 `-y` 等参数；涉及 `sudo` 或需手工输密码的命令请用户自己在终端运行。
- Windows 默认使用 `cmd`（可传 `shell=powershell` 切换），类 Unix 系统使用 `sh`。
- `cwd` 可传 `dev:/…` 路径，省略时默认在伴侣工作目录执行。
- 超出 `timeout`（默认 60 秒）会自动转为后台任务并返回任务号；预计耗时较长的操作（安装依赖、启动开发服务器）直接传 `background=true`，随后用 `device_job` 查看日志（`action=log`）、状态（`action=status`）或停止（`action=kill`）。
- 命令不可自动撤销且每次需用户确认；涉及删除、覆盖或系统配置变更前，简明说明操作目的与影响范围，严格聚焦用户交代的目标。

## 安装依赖

从 `device_env` 读取 `tools`（已装版本）、`missing`（缺失工具与推荐安装命令）和 `packageManager`：

1. 向用户列出缺少的工具、用途及对应命令，确认后再安装。
2. 使用 `background=true` 执行安装，完成后调 `device_env refresh=true` 复查。
3. 需要 `sudo` 或 Windows 缺少 `winget` 时，把明确步骤交给用户自行安装；安装失败时把关键报错行转告用户。

## Git 协作

设备装有 `git` 时可直接克隆到 `dev:/@ws/` 并执行提交与推送；若设备未配置 Git 凭据，改用 `web` 工具箱的 `github_push`（详见 `skill web-github`）。

## 无头浏览器：`device_browser`

用于验证前端页面或抓取依赖脚本渲染的网页（使用设备上的 Chrome / Chromium / Edge 与独立临时配置目录）：

```text
device_browser action=open url=http://127.0.0.1:5173
device_browser action=text                  （整页文本，可传 selector）
device_browser action=console               （查看控制台报错）
device_browser action=eval code=return document.querySelectorAll('.card').length
device_browser action=click selector=#save
device_browser action=type selector=#name text=夜梦
device_browser action=screenshot            （保存至 dev:/@ws/screenshots/ 供用户查看）
device_browser action=close
```

前端修改后的标准验证顺序：`open` → `console` 确认无报错 → `text` / `eval` 校验渲染结果 → 必要时 `click` / `type` 走通交互。

## 开发酒馆扩展

1. 参考 `skill tavern-anatomy`，需要案例时通过 `gh:/` 阅读现成扩展源码。
2. 在工作区或 `dev:/@ws/<扩展名>/` 编写 `manifest.json`（含 `display_name`、`js`、`css`、`version`、`author`）和入口脚本。
3. 安装到酒馆第三方扩展目录：`<酒馆>/data/<用户>/extensions/<扩展名>/`（旧版在 `<酒馆>/public/scripts/extensions/third-party/`），请用户刷新页面。
4. 通过 `page:/errors` 和 `run_js target=page` 检查运行状态。
5. 验证通过后推送到 GitHub 便于安装和更新。

扩展夜梦助手能力时，新建独立扩展并调用 `window.ReaderII.agent.registerTool` 等公开接口（详见 `gh:/Adirm007/reader-II/docs/开发者指南.md`），保留 Reader-II 扩展目录本身干净以便正常升级。
