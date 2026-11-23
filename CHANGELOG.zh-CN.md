# 更新日志

MetroTerm 的重要变更记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)——只有数字和点；候选版是该版本在 GitHub 上的预发布（prerelease），
不加后缀。英文更新日志见 [CHANGELOG.md](CHANGELOG.md)；打标签前两种语言都要写好对应版本的一节
（`node scripts/release-notes.mjs vX.Y.Z --check`）。

## [Unreleased]

### 新增

- Ctrl+PgUp / Ctrl+PgDn：切换到当前分屏（窗格）标签栏里的上一个 / 下一个标签（循环，可在快捷键设置里修改；Ctrl+B p / n 仍然可用）。
- Session → Preferences → Keyboard Shortcuts…：可以修改默认快捷键（点一项的快捷键，再按下新的组合键）。组合键已被其他命令占用时不会接受，并提示被哪个命令占用，可以点 REASSIGN 改为分配给这一项；固定的按键（Ctrl+Shift+1…9、Ctrl+C、Ctrl+V、Alt+F4）不能占用。菜单和工具提示显示当前使用的快捷键。保存在 settings.json（`keys`，只存改过的项）。
- Ctrl+Shift+L 清空终端回滚（终端右键菜单里也显示）。
- 终端配色方案改为 iTerm2 的 `.itermcolors` 文件：`~/.metroterm/themes/black/` 放深色和 Gold 主题用的方案，`~/.metroterm/themes/white/` 放浅色主题用的方案。第一次启动时放入 MetroTerm 自带的三套方案；下载 iTerm2 主题（例如 terminalthemes.com）放进这两个目录即可增加方案。Settings → TERMINAL COLORS 为上面 THEME 选中的主题选择方案，从列表里选（不能输入）：Default（主题自己的方案）或该主题目录里的方案（深色 / Gold 从 `black`，浅色从 `white`）；保存过的方案文件被删掉时显示“文件不存在”。关键字高亮仍用应用主题自己的颜色。
- SSH、Telnet、TCP 会话的 Session Settings 可以单独设置 PROXY：使用全局代理（Session → Proxy…）、不用代理、会话自己的 SOCKS5 / HTTP CONNECT 代理，或**跳板机**：可以选多个已保存的 SSH 会话，按列表顺序依次连接（添加、↑ ↓ 调整顺序、移除；相当于 `ssh -J a,b`）。第一个跳板机按它自己的设置连接；循环会被拒绝。
- 同时只能运行一个 MetroTerm：再次启动（菜单、桌面图标、命令行）时把已打开的窗口切到前面并给它键盘焦点（当前标签的终端，对话框输入框有焦点时保持不变），不再打开第二个。
- 有打开的终端时关闭 MetroTerm（Session → Exit、窗口的关闭按钮、Alt+F4 / ⌘Q、任务栏或 Dock）会先询问是否继续；浏览器里离开页面前也会询问。
- Session 面板显示 agent CLI 状态：终端里运行 Claude Code、Codex、opencode 等编程 agent CLI（还有 Gemini CLI、Copilot CLI、Cursor Agent、Qwen Code、Kimi Code、Amp 等）时，这个标签下面多一行：左边是 agent 名称，右边是 Metro 风格的方块状态标签（WORKING 琥珀色、NEEDS INPUT 实心红块、DONE 绿色、IDLE 只有边框），前面的图标表示状态：工作中是转动的星形，等待输入是会轻轻抖动的对话框，完成时画出一个对勾——工作中、等待输入、已完成（在你看别的终端时完成）、空闲。由后端按检测规则从终端输出判断（每个终端一个屏幕模型、每种 agent 一个 TOML 规则清单）；本地终端按前台进程识别 agent（通过 Node、Python 或符号链接启动的也能认出：Pi 的 npm 包、cursor-agent 自带的 Node、Hermes 的启动器），SSH / Telnet / 串口终端按屏幕内容或 agent 设置的窗口标题识别（除 Claude Code、Codex、opencode 外还有 Devin、Kiro、Amp、Grok）。全部从终端输出读取——屏幕文字、窗口标题（OSC 0/2）和进度（OSC 9），不往 agent 里安装插件或 hook。规则可以在 `~/.metroterm/agents/` 里覆盖。
- 终端网址链接：鼠标移到 `http://` / `https://` 网址上显示下划线，Ctrl+单击（macOS ⌘+单击）用默认浏览器打开；直接单击仍是选中文字。用 xterm 官方的 `@xterm/addon-web-links` 实现。
- 给 agent CLI 用的 MCP 服务（Session → Preferences → Settings… → MCP SERVER，默认关闭）：Claude Code、Codex、Gemini CLI 等 MCP 客户端可以列出 MetroTerm 的终端和其中 agent 的状态、读终端屏幕或最近几行、等某段输出出现、给另一个终端里的 agent 发提示并等它做完、输入文字或按键、切换到某个终端、打开新标签。只监听 127.0.0.1（默认端口 7690），需要设置里生成的访问令牌，网页发来的请求一律拒绝。传输方式：SSE（`/sse`）和 Streamable HTTP（`/mcp`）；设置里为每种 CLI 给出可直接复制的配置。取消“Allow agents to type, open and arrange tabs”后只读；在 MetroTerm 终端里运行的 agent 不能给自己所在的终端输入。agent 状态仍然只来自终端输出。
- MCP 服务支持窗口与分屏：`list_windows` 列出 MetroTerm 的窗口、每个窗口终端区的分屏方式和窗格（A、B … 与标签栏上的字母一致）以及每个窗格里的标签；`split_pane` 把窗格往右 / 下 / 左 / 上拆分并在新窗格里开新终端（可顺便执行命令），还有 `resize_pane`、`zoom_pane`、`move_terminal`（移到别的窗格、窗口或新拆出的窗格）、`new_window`、`rename_window`、`focus_window`，`open_terminal` 也能指定窗口或窗格。默认都在后台进行，不抢焦点。`close_terminal`、`close_pane`、`close_window`：agent 自己打开的直接关闭，其余先问用户（用户取消时 agent 收到 `cancelled`）；agent 自己所在的终端、窗格、窗口和最后一个窗口不会被关闭。
- MCP 服务支持 Session 面板里的标签操作：`list_terminals` 给出每个标签显示的名字、所在窗口和窗格，按标签栏顺序排列，已断开的标签也列出；`rename_terminal` 改名（或恢复默认名），`move_terminal` 调整标签顺序（`before`、`last`），`open_terminal` 克隆标签，`reconnect_terminal` / `disconnect_terminal` 重新连接或断开标签的会话（断开时除非是 agent 打开的标签，否则先问用户），`close_terminal` 可一次关闭多个标签。标签重连后，原来的终端 id 仍然可用。

### 修复

- Linux 桌面版：用输入法（fcitx5、IBus 的拼音等）在终端里输入的文字只发送一次；以前用 fcitx5 时一个词会重复出现好几遍，还夹着拼音字母和前面的文字。
- 分屏或标签很多时不再占用大量 CPU 和内存：终端的 WebGL 渲染器在达到浏览器的 WebGL 上下文上限后不再互相挤掉、循环重建。隐藏的终端（后台标签、其他窗口、被隐藏的窗格）5 秒后交还 WebGL 上下文，显示时重新获得；最多同时使用 12 个上下文，超出的终端在有空余之前用 xterm 的 DOM 渲染器绘制。终端输出不再为了状态栏的 Ln / Ch 让整个界面重新渲染，Gold 主题当前标签上的流光也不再每帧重绘。
- 终端查找：匹配色块现在随主题明显变化（深色青蓝、浅色黄、Gold 琥珀；以前深色和 Gold 几乎是同一种琥珀色）。
- Sender：行号重新和文字对齐（以前低 2–3 px），滚到底部时也保持对齐。
- 关键字高亮：用滚轮或滚动条滚进可见区域的行、拖动分隔线改变面板大小后重新折行的行，现在也会着色（以前不着色）。只处理默认前景色和背景色的文字，SGR 设置过颜色的文字（16 色、xterm-256color 调色板、真彩色）保持原色；每次更新的计算量也更小。
- 关键字高亮改为直接给终端缓冲区里的文字着色（不再用装饰），大量输出和滚动时明显更流畅；程序覆盖写的文字不会留下旧颜色。vim、less、htop 等全屏程序里也给它们没设颜色的文字着色（同样由 View → Highlight Keywords 开关）。
- 对话框：用快捷键打开的对话框（如 Ctrl+Shift+W 关闭标签）里，还按着 Ctrl / Shift 时 ← / → 也能在底部按钮间切换，回车也能触发按钮。
- 终端左侧的时间 / 行号栏不再给没有输出的行显示行号，尤其是调整窗格大小之后。
- 终端行号按行计数，不再按屏幕行：自动换行占好几行的长行只有一个行号，下一行接着是下一个号（以前每遇到折行就跳号）。状态栏的 Ln 用同样的行号。
- 重连（窗格工具栏的 ↻、终端右键菜单、Session → Reconnect Session）只重连当前终端，同一会话的其他标签和分屏窗格保持连接。
- 对话框：输入框滚出可见区域时，它的文字光标不再留在固定的标题 / 按钮栏上面或对话框外面；输入框滚回来后光标重新显示。
- macOS 应用自带标题栏：双击标题栏重新是最大化 / 还原窗口；最大化按钮进入全屏。

- Windows：Filer 的“定位到终端目录”和“跟随终端”现在能找到终端所在目录（cmd、PowerShell、Git Bash，包括 PowerShell 的 `cd`）；OSC 7 的 `file:///C:/…` 路径能正确打开，并支持 OSC 9;9。
- macOS：系统 WebKit 较旧的 Mac（多见于 Intel 机型）打开后不再是空白窗口；界面仍然起不来时，窗口里会显示错误信息。

- Windows 安装包：选择没有写入权限的目录（例如只为当前用户安装时选 Program Files 下的目录）不再装到一半报 “Error opening file for writing”；选择目录页会说明原因，并禁用“下一步”。
- macOS：应用图标在 Dock 和启动台里不再比其他应用大一圈。
- macOS：应用自己的滚动条下面不再露出系统的横向滚动条（在列很宽的 Filer 里能看到）。
- macOS：使用应用自带标题栏时，最小化恢复正常；最大化按钮和系统绿色按钮一样进入 macOS 全屏（独立的全屏空间），不再只是铺满桌面。
- Windows：第一次启动时 Explorer 里建的是 cmd 和 PowerShell，不再是 bash 和 zsh；旧版本在 Windows 上建的、没改过的 bash / zsh 会话会换成 cmd / PowerShell。

### 变更

- 桌面应用和 Web 模式合成一个程序：Web 模式改为 `metroterm web`（原来是 `metroterm --web`），后台运行和停止改为 `metroterm web --daemon` / `metroterm web --stop`（原来是 `--daemon` / `--stop`），地址用 `--listen ADDR`。浏览器版改为运行 `./metroterm web`（原来是 `./metroterm-server`）。开头的 `--` 会被忽略（`metroterm -- web --daemon`）；旧参数会提示新写法。
- Session 面板行排得更整齐：每个标签的第一行高度统一为 28px，标题、右对齐的 user@host / shell 和连接圆点上下对齐；文字分三级（标签标题；agent 名称和 user@host / shell 小 1px，后者颜色更淡）；agent 那一行高 18px，状态标签右边和圆点对齐；“OPEN TABS” 计数改为大写加字距。

- 弹窗：点击字段的标题不再聚焦或打开该控件（复选框、单选框的文字照常可以点击切换）；点击弹窗外的遮罩不再关闭弹窗。
- 终端查找改用 xterm 官方的 `@xterm/addon-search` 实现：当前匹配同时被选中，最多计数 / 着色 1000 处（显示“1000+”），Find all 给上限以内的所有匹配着色，不再只限视口附近。关键字高亮不再给网址着色。
- 单击高亮终端里的一行时，左侧栏里这一行的时间和行号也一起高亮：变为亮色（光标所在行仍是红色 / 金色）。
- 终端左侧的时间 / 行号栏字号跟随终端字号（比终端字号小 1，随 Settings 的终端字号和 View → Zoom 变化），不再固定 12px；栏宽随之变化，数字在每行里上下居中（与字体无关）。
- 终端右键菜单去掉了 Move Tab to New Pane、Zoom Pane、Close Pane；它们仍在标签右键菜单（Move Tab to New Pane）、窗格的 ⋮ 菜单（Zoom Pane、Close Pane）和 Ctrl+B 快捷键（`!`、`z`、`x`）里。

- Windows：默认界面字体改为微软雅黑（Microsoft YaHei）。
- Linux 和 macOS：默认界面字体为 DejaVu Sans Mono（没有安装时用内置字体）。
- 默认终端字体（Settings → TERMINAL FONT → Default）改为 DejaVu Sans Mono；它没有的字形（中文等）和没有安装它的系统，由 Sarasa Mono SC 等内置字体接替。
- 弹窗最高 640 px，内容更多时在标题和按钮之间滚动。
- Session → Preferences：Keyboard Shortcuts… 移到 Default Session Settings… 下面。

- 终端输出高亮：命令行选项（`--help`、`-f`）改为橙色。
- 面板的 Settings 菜单变窄，不再在别处已打开的视图旁显示 “In another panel”。
- 终端：恢复关键字高亮——时间、日志级别、错误 / 警告 / 结果、数字、引号里的字符串、括号、地址、网址、命令行选项、`ls -l` 权限和提示符符号各有颜色（每个主题一套），只改程序没有自己着色的文字。不再修改渲染器；View → Highlight Keywords 可以关闭。
- 终端：查找的匹配改为色块高亮（当前匹配更亮），不再加框。
- 状态栏：拖动分隔条或窗口时，Window 列数 × 行数实时变化，不再等停止拖动后才更新。
- 终端：恢复查找功能——窗格工具栏全屏按钮右边的放大镜、Ctrl+F（Local Mode）或右键 → Find… 打开查找栏，搜索整个回滚（不区分大小写），当前匹配用色块标出并高亮所在行；Enter / Shift+Enter 切换，Find all 标出所有匹配。
- 终端：滚动条贴到窗格右边缘。
- 终端：选中一行以内的文字时，其他相同的文字加浅色背景（由终端渲染器画进格子里，和选区严格对齐），随滚动和新输出更新，中文按字宽对齐。
- 终端：粗体文字默认用常规字重显示（颜色照样变亮）；Settings → BOLD TEXT 可以改回加粗。
- 终端：失去焦点时不再显示光标（原来是一个空心框）；滚动条改为软件自己的直角滚动条，和其他地方一致。
- 终端：时间 / 行号栏（View → Show Time / Show Line Number）和点击行高亮（只高亮已经输出过的行，单击光标下面的空行会取消高亮）改用 xterm 的公开接口重新实现，在 WebGL 渲染器下可用，各种显示缩放下都严格对齐；输出增多时行号栏宽度不再变化。
- 终端：竖线光标和下划线光标加粗——竖线 2px 宽，下划线 3px 高（原来都是 1px）。
- 终端：中文等宽显示改进——默认终端字体优先用更纱黑体 Sarasa Mono SC 和 Source Code Pro（已安装时）；会盖到下一格的单宽字符（Ⅰ Ⅱ Ⅲ 等）压进一格；文字颜色和背景的对比度至少 4.5:1。终端只用 WebGL 渲染：WebGL 不可用时报错并在终端位置显示原因（不退回 DOM 渲染器）；WebGL 上下文丢失时自动重建。
- 弹窗页脚按钮（确定 / 取消等）改小：高度从 32 px 改为 26 px；弹窗里的输入框、下拉框、数字框和切换按钮也改成同样的 26 px。
- 密码输入框右侧加了眼睛按钮，点一下显示明文，再点一下隐藏。
- Explorer、Filer、Sender、Session、Monitor 每种面板只能在一个面板里打开：在别的面板打开时会先关掉原来的。保存的布局里有重复的，只保留第一个。
- Settings → THEME 里的 Gold 选项不再显示“PRO MAX”标记。
- macOS：最低版本改为 10.15（Tauri 2 支持的最低版本）。
- Windows 安装包：可以选择只为当前用户安装或为所有用户安装（Program Files）；中文系统上安装界面显示中文。

### 移除

- 终端：恢复为原生的 xterm.js 渲染，只设置字体、光标、回滚行数和主题配色。移除了：网址下划线和 Ctrl+单击打开、自定义输入法处理、终端的改造过的光标，以及所有行间距 / 字宽 / 制表符字形的调整。

## [0.0.1] - 2026-11-16

第一个版本。

### 新增

- 终端工作台：左边是 Explorer（会话）和 Filer，右边是多标签终端和 Sender，另有 Monitor 面板；所有面板都可以移动、调整大小和关闭。
- 会话：本地 shell（bash、zsh 等）、SSH、Telnet、原始 TCP 和串口，按文件夹整理；SSH / Telnet / TCP 可以走 SOCKS5 或 HTTP 代理。
- SSH：密码和密钥登录、记住密码（加密保存）、主机密钥校验、本地 / 远程 / 动态隧道（Tool → Tunnels）。
- Filer：SFTP 和本地文件——多选、拖放上传、带进度和通知的传输、移动 / 复制 / 重命名 / 权限。
- 终端：tmux 快捷键（Ctrl+B）的分屏，每个窗格一个标签组；查找、缩放、窗格全屏、时间和行号栏、方块 / 竖线 / 下划线光标、拖入文件写路径。
- 一个程序窗口里的多个“窗口”（Window 菜单，Ctrl+Shift+1…9）。
- Sender：按行或按字符把文本发给一个或多个会话。
- 菜单搜索（Ctrl+Shift+P）、专注模式、锁屏、深色 / 浅色 / Gold 主题、中英文界面。
- 浏览器模式：`metroterm --web` / `--daemon`，以及独立的浏览器版安装包（`metroterm-server` + `www/` 里的界面）。
- 安装包：Linux（deb、rpm、AppImage）、Windows（setup.exe、msi、自带 WebView2 的离线安装包、便携版 zip）和 macOS（dmg），x86_64 和 ARM64。
