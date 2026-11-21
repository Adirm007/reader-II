# Reader-II 后端伴侣

可选组件。装上并放行之后，夜梦助手可以在**你的设备**上做事：跑命令、读写文件、检索目录、开无头浏览器、启动命令类（stdio）的 MCP 服务器，以及替浏览器去取那些不允许跨域的网址。

不装它，Reader-II 的其他功能（夜梦助手、记忆、抓网页、GitHub、HTTP 类的 MCP、卡内组件）都照常工作。

只用 Node 标准库（Node 18 及以上），**不需要 `npm install`**。

## 下载

在夜梦助手「设置 → 后端伴侣 → 安装或卸载伴侣」点击「下载当前版本的伴侣 ZIP」，先全部解压。也可以下载[完整源码 ZIP](https://github.com/Adirm007/reader-II/archive/refs/heads/main.zip)，其中的 `companion` 就是同一个文件夹。只需要 Node.js 18 或更新版本。缺少 Node 时下载 [Node.js LTS](https://nodejs.org/en/download)。

## 原生 SillyTavern（Windows、macOS、Linux 或 Termux）

**Windows 双击安装**　在运行酒馆的电脑上解压 ZIP，双击 **Windows-SillyTavern.cmd**，按回车，选择酒馆根目录的 **config.yaml**。重启酒馆一次，安装完成。卸载时再双击这个文件，输入 **2**，选择同一份 config.yaml，重启酒馆。这两步也可以用下面的命令完成。

1. 在**运行酒馆的设备**上，打开解压出的伴侣文件夹。在这个文件夹打开终端（Windows 文件夹地址栏输入 `powershell` 后按回车），执行：

   ```sh
   node setup.mjs install
   ```

2. 按提示粘贴酒馆根目录，也就是放着 `server.js` 和 `config.yaml` 的文件夹。例如 Termux 可以直接运行 `node setup.mjs install ~/SillyTavern`。
3. 重启酒馆，回到助手设置点「检测伴侣」。以后开酒馆就开伴侣，关酒馆就停。安装器将所需文件复制到酒馆的 `plugins/reader-ii-companion/`，会将服务器插件开关 `enableServerPlugins` 设为 `true`。原生酒馆的伴侣地址留空即可。

**卸载或更新**　在解压目录运行 `node setup.mjs uninstall`，或在酒馆根目录运行 `node plugins/reader-ii-companion/setup.mjs uninstall`，随后重启酒馆。安装器仅移除自己登记的文件。如果安装时替你打开过服务器插件，卸载时会在没有其他服务器插件的情况下恢复开关。更新时先卸载旧版本，再从新版 ZIP 安装。工作文件及放行记录保存在下文的数据目录，可继续沿用。

## Windows 上的 TauriTavern

1. 将解压出的伴侣目录放在长期保留的位置，例如“文档”。双击里面的 **Windows-Tauri.cmd**，按回车创建桌面快捷方式。酒馆已打开时可自动识别；否则会弹出窗口让你选择 `TauriTavern.exe`。
2. 双击桌面的 **TauriTavern + Reader-II**。它启动酒馆和伴侣，酒馆已运行时就使用那个酒馆进程。设置里的地址留空，点「检测伴侣」即可。首次授权用伴侣控制台显示的带 `#key` 的管理页地址。
3. 酒馆只最小化到托盘时，伴侣会继续工作。从托盘退出酒馆后，伴侣也会停止。只想提前停伴侣，可以在它的窗口按 Ctrl+C。平时从酒馆原图标打开，仍是原来的启动方式。此方法不登记登录启动项、系统服务或计划任务。

**完整卸载**　先在助手设置点「断开」，退出酒馆。再运行 **Windows-Tauri.cmd** 输入 **2**，它会移除专用快捷方式。也可以直接删除这个桌面快捷方式。删除先前下载的 ZIP 和专门解压的伴侣目录。最后按下文「数据放在哪」清理独立的数据目录；工作区里有需要的文件先备份。共用的 Node.js 与酒馆本身可继续使用。

## macOS 或 Linux 上的 TauriTavern

1. 把伴侣解压到会保留的位置。在这个文件夹打开终端，运行一次 `node setup-desktop.mjs install`。安装器会寻找酒馆，找不到时会请你选择或粘贴路径。也可直接传入路径，例如 macOS 的 `node setup-desktop.mjs install "/Applications/TauriTavern.app"` 或 Linux 的 `node setup-desktop.mjs install "$HOME/Applications/TauriTavern.AppImage"`。AppImage 需先在文件属性中允许执行。
2. 先完全退出从原图标启动的酒馆。以后在 macOS 桌面双击 **TauriTavern + Reader-II.command**，或从 Linux 应用菜单打开 **TauriTavern + Reader-II**。它会一起启动酒馆和伴侣，在酒馆退出后停止伴侣。
3. 保留启动器打开的终端。在助手设置里将伴侣地址留空，点「检测伴侣」。入口使用本机地址 `http://127.0.0.1:8790`。第一次授权请打开伴侣终端里带 `#key` 的管理页地址。

**卸载**　在助手设置点「断开」，退出酒馆。在同一解压目录运行 `node setup-desktop.mjs uninstall` 即可移除入口。确认以后用不到时，可再删除 ZIP、专用解压目录，以及下文的数据目录（先备份工作文件）。

## 临时独立运行与手机

也可以在解压的伴侣目录运行 `node standalone.mjs`。终端显示的本机地址默认是 `http://127.0.0.1:8790`；端口被占用时，把实际显示的地址填入「更改连接地址」。Ctrl+C 可停止。

手机上的 TauriTavern 没有可加载此插件的 Node 后端。日常玩卡和助手聊天可以跳过伴侣；Android 若使用 Termux 运行原生酒馆，可按原生安装步骤配置。用手机访问别人托管的酒馆时，服务器插件要在运行酒馆的设备上装，授权后操作的是那台设备。

## 放行

1. 夜梦助手的「设置」里把权限档位调到「设备全权」并保存。
2. 「设置 → 后端伴侣」点「检测」，再点「申请放行」。面板上会出现一个 4 位**配对码**。
3. 在**装着伴侣的那台设备**上，用浏览器打开控制台里打印的管理页地址（带 `#key=…` 的那个；同一个地址也写在数据目录的 `admin-url.txt` 里）。
4. 核对管理页上的配对码、来源与面板上的一致，选一个期限：**放行 2 小时** / **放行到伴侣重启** / **长期放行**。

不想授权时，在管理页点「拒绝」。已授权可在管理页点「撤销」，或在助手里点「断开」清除这台浏览器保存的令牌。清理管理页的本地记忆可在浏览器删除对应管理页地址的站点数据。

之后助手在设备上的每一步，仍然按她自己的权限设置请你确认（命令算危险操作，默认每条都问）。管理页上可以随时撤销，也能看到最近做过的操作。

## 安全模型：为什么要绕到另一个页面去点

酒馆页面里除了夜梦助手，还跑着别的扩展和角色卡自带的脚本。它们与助手**同源**：助手能发的请求，它们也能发；助手存在页面里的任何东西，它们也读得到。所以「页面知道一个密码」拦不住它们。

伴侣的做法是把「同意」这一步放到页面脚本够不着的地方：

- 管理页在**另一个端口**上（另一个源）。酒馆页面里的脚本读不到它的内容，也没法替你点按钮。
- 管理页的接口要**管理密钥**（只在控制台输出与本机磁盘上），要求自定义请求头，只认发给本机地址的请求，不给任何跨源许可，也不允许被嵌进别的页面。
- 放行有**期限**。到期、被撤销、或伴侣重启（选了「到伴侣重启」时）之后，页面手里的令牌就失效了。
- 操作接口还会核对请求的来源与放行时记下的一致。

需要你清楚的一点：**放行期间，那个酒馆页面（连同里面装的所有扩展与角色卡脚本）等同于拿到了这台设备。** 所以：

- 只在确实要让助手做设备上的事时放行，用完可以在管理页上撤销；
- 「长期放行」只适合你信得过这个酒馆里装的所有东西的情况；
- 来路不明的角色卡，不要在放行期间导入并启用它带的脚本。

管理页上还有三个限制：关掉命令执行、关掉无头浏览器、把文件访问限定在几个目录里。注意只要还允许运行命令，命令本身不受目录限制。

## 数据放在哪

`~/.reader-ii-companion/`（可用环境变量 `READER_II_COMPANION_HOME` 改）：

| 文件 | 内容 |
|---|---|
| `config.json` | 管理页端口、三个限制 |
| `admin.key`、`admin-url.txt` | 管理密钥与带密钥的管理页地址 |
| `grants.json` | 有期限与长期的放行（只存令牌的哈希） |
| `audit.log` | 操作记录 |
| `workspace/` | 伴侣的工作目录（`dev:/@ws/`）：命令的默认目录、截图 |

彻底移除伴侣时，先停止伴侣，备份仍需要的 `workspace/`，再移除这整个数据目录。Windows 默认位置为 `%USERPROFILE%\.reader-ii-companion`。这个目录本身不能经文件接口读写（`workspace/` 除外）。

## 提供的操作（给开发者）

接口：`GET /status`、`POST /pair`、`GET /pair/<id>`、`POST /release`、`POST /op/<名字>`（要 `X-Reader-II-Token`）。

| 操作 | 作用 |
|---|---|
| `env` | 系统、Node、常用工具的版本与安装命令 |
| `exec` / `job` | 运行命令（超时转后台）；查看、读取输出、停掉任务 |
| `fs_list` `fs_read` `fs_write` `fs_remove` `fs_grep` | 文件：列目录、读、写（原文件是 CRLF 时写回 CRLF）、删、在设备上检索 |
| `http` | 代发 HTTP 请求（没有跨域限制；MCP 的流式回应拿到结果就返回） |
| `browser` | 无头浏览器：`open` `text` `eval` `click` `type` `console` `screenshot` `close` |
| `mcp_start` `mcp_send` `mcp_stop` | 启动命令类的 MCP 服务器并转发 JSON-RPC |

源码：`core.mjs`（放行、接口、管理页的服务端）、`ops.mjs`（各操作）、`browser.mjs`（调试协议走管道，不开调试端口）、`mcp-stdio.mjs`、`admin.mjs`（管理页）、`index.mjs`（酒馆插件入口）、`standalone.mjs`（独立运行）。

测试：`node --test tests/companion.test.mjs`。
