# MetroTerm

MetroTerm 是一个桌面终端工作台：左边是会话列表和文件浏览器，右边是多标签终端和批量发送工具。界面是直角 Metro 风格，有深色、浅色两套配色。

支持本地 shell（bash、zsh 等）、SSH、Telnet、原始 TCP 和串口。SSH 连接上可以直接浏览、上传、下载远程文件（SFTP），不用再登录一次。SSH / Telnet / TCP 可以走 SOCKS5 或 HTTP 代理。当前版本 0.0.1。

> 开发、构建和实现细节见 [wiki/README.md](wiki/README.md)。

## 预览

<table>
  <tr>
    <td><img width="570" src="https://github.com/user-attachments/assets/b608f34d-2715-4f41-993a-c201e960078d" /></td>
    <td><img width="570" src="https://github.com/user-attachments/assets/213a67cd-80c1-4ce0-812c-8d1a735b4e27" /></td>
  </tr>
</table>

## 安装

安装包在 GitHub 的 Releases 页面（每个版本附带 `SHA256SUMS.txt` 校验和）：

| 系统 | x64（amd64） | ARM64 |
|---|---|---|
| Ubuntu 22.04+ / Debian 12+ | `MetroTerm_0.0.1_amd64.deb` | `MetroTerm_0.0.1_arm64.deb` |
| Fedora / RHEL / openSUSE | `MetroTerm-0.0.1-1.x86_64.rpm` | `MetroTerm-0.0.1-1.aarch64.rpm` |
| 其他 Linux | `MetroTerm_0.0.1_amd64.AppImage` | `MetroTerm_0.0.1_aarch64.AppImage` |
| Windows 10 / 11 | `MetroTerm_0.0.1_x64-setup.exe`（或 `_x64_en-US.msi`） | `MetroTerm_0.0.1_arm64-setup.exe` |
| Windows 离线安装（自带 WebView2） | `MetroTerm_0.0.1_x64-offline-setup.exe` | `MetroTerm_0.0.1_arm64-offline-setup.exe` |
| Windows 便携版（免安装） | `MetroTerm_0.0.1_x64-portable.zip` | `MetroTerm_0.0.1_arm64-portable.zip` |
| macOS 10.15 及更新版本（请装上系统更新里的 Safari，界面用系统 WebKit） | `MetroTerm_0.0.1_x64.dmg`（Intel） | `MetroTerm_0.0.1_aarch64.dmg`（Apple 芯片） |
| 浏览器版（无图形界面的 Linux 服务器，glibc 2.28+） | `MetroTerm_0.0.1_linux-x86_64-web.tar.gz` | `MetroTerm_0.0.1_linux-aarch64-web.tar.gz` |

（本地用 `npm run build:macos` 编译时生成的是 Intel 和 Apple 芯片通用的 `_universal.dmg`。）

```bash
sudo apt install ./MetroTerm_0.0.1_amd64.deb     # ARM64 机器用 _arm64.deb
metroterm                                        # 或从应用菜单启动 MetroTerm
```

- **Windows**：运行 `-setup.exe` 安装，可以选择只为当前用户安装（不需要管理员权限）或为所有用户安装（装到 Program Files，需要管理员权限）；安装目录可以含中文和空格。需要 Microsoft Edge WebView2，Windows 11 自带；Windows 10 上没有时安装程序会自动下载，离线的电脑用 `-offline-setup.exe`。**便携版**解压后直接运行 `MetroTerm.exe`，设置和会话保存在旁边的 `data` 文件夹里（记住的密码换电脑后要重新输入）。安装包没有代码签名，Windows 可能提示“未知发布者”。
- **macOS**：打开 `.dmg`，把 MetroTerm 拖进“应用程序”。安装包只有临时（ad-hoc）签名，没有 Apple 开发者签名和公证，第一次打开时请在 Finder 里右键 → 打开（或在“系统设置 → 隐私与安全性”里允许；也可以运行 `xattr -dr com.apple.quarantine /Applications/MetroTerm.app`）。
- **Linux**：`.rpm` 用 `sudo dnf install ./MetroTerm-*.rpm`；AppImage 先 `chmod +x` 再运行。
- **浏览器版**：解压后运行 `./metroterm web`（后台运行用 `./metroterm web --daemon`），在浏览器打开 `http://127.0.0.1:7681/`（界面来自旁边的 `www/`）。能访问这个地址的人就能打开 shell，远程服务器请用 SSH 隧道访问：`ssh -L 7681:127.0.0.1:7681 user@server`。

终端字体推荐安装 Nerd Fonts 里的 **RobotoMono Nerd Font**（安装包不自带）；没装时会使用系统的等宽字体。

### 启动参数

```bash
metroterm                                # 启动桌面应用
metroterm --help                         # 显示帮助
metroterm --version                      # 显示版本号（MetroTerm 0.0.1）
metroterm web                            # Web 模式：不开桌面窗口，在默认浏览器里打开 MetroTerm
metroterm web --listen 0.0.0.0:8080      # Web 模式并指定监听地址
metroterm web --daemon                   # 在后台启动 Web 模式（不开浏览器），打印网址后返回
metroterm web --stop                     # 停止后台的 Web 模式
metroterm --log ~/mt-logs                # 本次运行的日志写到这个目录（metroterm.log）
```

- **web**：界面和后端由同一个地址提供，默认 `http://127.0.0.1:7681/`（端口被占用、又没有用 `--listen` 指定时自动换一个空闲端口），桌面版启动后自动打开默认浏览器（`--no-browser` 不打开），终端里会打印网址；按 Ctrl+C 停止。会话、设置都和桌面版共用 `~/.metroterm`。Web 模式可以获得本机 shell 权限，默认只监听本机；只接受来自自己页面的请求（其他网站不能连接它）。监听 `0.0.0.0` 时同一网络里的人都能访问，请只在可信网络里使用。
- **web --listen ADDR**（`-l ADDR`）：监听地址。
- **web --daemon**：Web 模式作为后台进程运行：脱离当前终端（关掉终端也不会停），不打开浏览器，打印网址和 PID 后立即返回；可以和 `--listen` 一起用。已经有一个在运行时只打印它的网址。状态记在 `~/.metroterm/daemon.json`，日志照常写到日志文件。适合放进系统的开机 / 登录自启动项。
- **web --stop**：停止 `web --daemon` 启动的后台进程。
- **web --www DIR** / **--no-www**：界面来自 DIR（构建出的 `dist/`）/ 只提供后端（配合 Vite 开发服务器）。默认用程序旁边的 `www/`（浏览器版），没有时用桌面版内置的界面。
- **--log DIR**：日志文件 `metroterm.log`（以及轮转出的 `.1` … `.N`）写到 DIR，覆盖 Session → Log → Log Settings 里的路径，只对本次运行有效；目录不存在时自动创建。桌面应用和 `web` 都可以用。
- 参数前的 `--` 会被忽略：`metroterm -- web --daemon` 等同于 `metroterm web --daemon`（例如 `cargo run --bin metroterm -- web --daemon`）。
- Windows 上请在命令提示符或 PowerShell 里运行 `MetroTerm.exe --help`，输出会显示在这个窗口里。

## 界面一览

| 区域 | 用途 |
| --- | --- |
| **Explorer** | 保存的会话，按文件夹整理。双击打开终端 |
| **Filer** | 当前终端所在机器的文件（本机或 SFTP） |
| **终端** | 多标签终端，标签栏下方是工具栏 |
| **Sender** | 把文本批量发送到一个或多个终端 |
| **Session 面板** | 管理已打开的终端标签（可选，从面板的 Settings 菜单添加）；终端里运行 Claude Code、Codex、opencode 等 agent CLI 时，标签下面多一行显示它的状态：工作中 / 等待输入 / 已完成 / 空闲 |
| **Monitor 面板** | 当前终端所在主机的 CPU、内存、网络、磁盘和进程（可选，从面板的 Settings 菜单添加） |
| **菜单搜索** | 菜单栏右侧 Tunnels 左边的 🔍（或 Ctrl+Shift+P）：输入菜单命令里的词（顺序不限，中英文都行），结果显示为 `Session / New Session` 这样的路径，↑ ↓ 选择、Enter 执行、Esc 关闭；**?** 显示用法 |
| **Tunnels** | 菜单栏右侧按钮或 Tool → Tunnels…：SSH 端口转发（本地 / 远程 / 动态 SOCKS），按钮上显示正在运行的隧道数 |
| **状态栏** | 活动消息、窗口按钮（多个窗口时）、列数×行数、光标行列、键盘模式（Local / Remote Mode，点击切换）、锁屏（🔒 图标）、主题 |

所有面板都可以拖动分隔线调整大小；拖到很小时面板会收起，往回拖即可恢复。

**标签可以用鼠标拖动调整位置**：面板标签（Explorer、Session、Filer、Sender、Monitor）可以在同一个标签栏里调整顺序，也可以拖到另一个面板的标签栏，移到那个面板。终端标签可以在标签栏里调整顺序；Session 面板里的行也能拖动，它和终端标签栏是同一个顺序，两边可以互相拖放。拖动时有一条竖线（Session 面板里是横线）标出放下的位置，按 Esc 取消。标签顺序会保存。每个面板标题栏的 Settings 菜单可以把面板一分为二，或添加 Explorer / Filer / Sender / Session / Monitor 标签。**每种面板在所有区域里只能打开一个**：在某个面板打开一个已经在别的面板打开的标签，会先把原来的关掉，再在这里打开（菜单里只在本面板打开的项打勾）。

## 功能

### 终端

- 本地 shell、SSH、Telnet、TCP、串口，支持 vim、htop、less 等全屏程序，中文、日文、韩文和输入法正常显示和输入。
- 终端是原生的 xterm.js 渲染（WebGL 渲染器：WebGL 不可用时在状态栏和日志里报错，终端位置显示原因，不退回 DOM 渲染器。为了节省显存和 CPU，后台标签、其他窗口里和被隐藏的窗格隐藏 5 秒后交还 WebGL 上下文，显示时立刻恢复；所有终端最多同时占用 12 个 WebGL 上下文，屏幕上的终端超过 12 个时多出的暂用 DOM 渲染器；自带的光标和输入法处理；滚动条和软件里其他地方的一样是软件自己画的），只按主题设置配色，不做下划线或渲染修补。
- **终端配色方案**：使用 iTerm2 的 `.itermcolors` 文件。`~/.metroterm/themes/black/` 是深色和 Gold 主题可用的方案，`~/.metroterm/themes/white/` 是浅色主题可用的方案；第一次启动时放入自带的 MetroTerm Dark / Gold / Light。想要更多方案，从 [terminalthemes.com](https://terminalthemes.com/themes)（原 iTerm2-Color-Schemes）下载 iTerm2 格式的主题文件放进对应目录（深色背景的放 `black`，浅色背景的放 `white`），然后在 **Settings → TERMINAL COLORS** 里选择：这里设置的是上面 THEME 选中的主题（切换 THEME 就设置另一个主题），是一个下拉列表（不能输入），**Default** 表示主题自己的方案（MetroTerm Dark / Gold / Light），列表里是该主题目录中的其他方案；保存过的方案文件被删掉时显示“文件不存在”。文件被删掉时退回内置配色；关键字高亮的颜色不受方案影响。
- 左侧栏显示每一行的输出时间 `[20:33:03]` 和行号（字号比终端字号小 1，跟随终端字号变化，包括 View → Zoom；数字在每行里上下居中），光标所在行是红色；还没有输出的行不显示（调整窗格大小后也一样）；被重画的行（进度条、重画的提示符）显示最新时间，自动换行的续行不显示行号也不占行号——行号按逻辑行连续编号，不会因为折行跳号，状态栏的 Ln 也是这个行号。全屏程序（vim、htop）里显示每行最后一次变化的时间和屏幕行号。在 **View** 菜单里可以分别打开 / 关闭 “Show Time”（时间）和 “Show Line Number”（行号），两项都关掉时左侧栏整个隐藏。
- 在终端里选中一段文字（双击单词或拖动选择，一行以内），其他相同的文字会用浅色底标出来（区分大小写，和选区严格对齐，中文按字宽对齐，跨自动换行也能匹配）；取消选择后标记消失。
- **查找**：点工具栏全屏按钮右边的放大镜，或在终端里按 Ctrl+F（或右键 → Find…），打开右上角的查找栏，搜索整个回滚（不区分大小写，用 xterm 官方的 `@xterm/addon-search` 实现），有选中文字时自动填入。Enter / Shift+Enter 下一个 / 上一个，当前匹配用色块高亮（较亮）、选中并高亮所在行；“Find all” 按钮给所有匹配加上较淡的色块；计数最多到 1000（显示 `1000+`）；Esc 关闭。色块颜色随主题变化（深色青蓝、浅色黄、Gold 琥珀），切换主题时立即更新。
- **网址链接**：终端里的 `http://` / `https://` 网址由 xterm 官方的 `@xterm/addon-web-links` 识别：鼠标移上去显示下划线和手形指针，**Ctrl+单击**（macOS 上 ⌘+单击）用系统默认浏览器打开（浏览器模式下在新标签页打开）；直接单击仍然是选中文字 / 高亮这一行。网址本身不再额外着色。
- **关键字高亮**：程序输出里的关键字自动着色——时间（绿）、INFO / DEBUG 等日志级别、error / failed / invalid / refused 等错误（红）、warning / retrying（黄）、passed / done（绿）、closed / stopped（橙）、数字和版本号（紫）、引号里的字符串（黄）、括号和日志里的 ` - `（绿）、IP / MAC 地址、UUID、`--help` 这类命令行选项（橙）、`ls -l` 的权限，以及提示符的 `$` / `#` / `>` 符号。路径和网址里的内容不着色；程序自己设置了颜色的文字（16 色、xterm-256color 的 256 色、真彩色：`ls --color`、git 等）不改，全屏程序（vim、htop、less）里也只给没设颜色的文字着色；滚轮 / 滚动条翻到的回滚内容同样着色。每个主题有自己的一套颜色。在 **View → Highlight Keywords** 里打开 / 关闭（默认打开）。
- 粗体文字（如 `ls --color` 的目录、提示符里的粗体）默认用常规字重显示，颜色不变；在 Settings → BOLD TEXT 里可以改回加粗。
- 终端失去焦点时（点到其他面板、菜单或别的窗口）不显示光标，回到终端后光标重新出现。
- 单击某一行（或左侧栏的行号）会高亮这一行，左侧栏里这一行的时间和行号也变成亮色（光标下面还没有输出的空行不会高亮，单击空行会取消高亮），自动换行的长行整行一起高亮，输出滚动时跟着这一行走。
- 中文等宽显示：默认字体优先用更纱黑体 **Sarasa Mono SC**、其次 **Source Code Pro**（需要系统已安装，没装时用后面的字体）；会盖到下一格的单宽字符（如 Ⅰ Ⅱ Ⅲ）自动压进一格；文字和背景的对比度至少 4.5:1，偏暗的颜色会自动调亮。
- 光标默认是橘色方块，可在 Preferences 的 CURSOR 里改成 **竖线**（2px 宽）或 **下划线**（3px 高），并选择闪烁或常亮；样式由 xterm 自己绘制。
- **全屏**：工具栏第一个按钮把终端放大到整个窗口（分屏时只显示这个窗格），再点一次恢复原来的面板和分屏。
- **缩放**：View → Zoom（Ctrl+= / Ctrl+-），只影响当前标签。
- **右键菜单**：复制、粘贴、复制整行、全选、清空回滚（Ctrl+Shift+L）、把选中内容发到 Sender、把选中内容或全部输出保存成文件，以及复制会话、重连（只重连当前终端，同一会话的其他标签和窗格不受影响；Session → Reconnect Session 也一样）、断开、左右 / 上下分屏。会话属性在 Session → Preferences → Session Settings…，关闭标签用标签上的 × 或 Ctrl+Shift+W。
- 会话结束或断线后，在终端里按 Enter 重新连接。
- **分屏（tmux 风格窗格，每个窗格是一个标签组）**：终端区域可以分成多个窗格，每个窗格是一个标签组，有自己的标签栏、工具栏（左侧是全屏、查找、克隆会话、重连，然后是面包屑；右侧依次是窗格字母 A / B / C…（只有一个窗格时不显示，和旁边的图标上下居中对齐）、收藏、**⋮** 窗格菜单）和行号栏。⋮ 菜单里是分屏、放大、关闭窗格等；在本窗格新建标签用 Ctrl+B `c`；时间 / 行号栏的显示开关在 View 菜单。标签右键 → **Split Left / Right** / **Split Top / Bottom**（新窗格里打开同一会话的新 shell / 连接）、**Move Tab to New Pane**；终端右键菜单里只有两个分屏项；⋮ 菜单里有分屏、Zoom Pane、Close Pane。把标签拖到另一个窗格的标签栏就移到那个窗格；窗格的最后一个标签关闭或移走后窗格消失。拖动 1px 分隔线调整大小（分隔线没有额外的拖动条，鼠标移上去变成调整大小的指针；拖到任何位置分隔线都保持可见）；点击窗格切换焦点，当前窗格的字母用强调色标出（标签下面没有额外的选中线）。窗格布局随窗口一起保存（旧版本保存的分屏会自动转换）。
- **tmux 快捷键**（Local Mode，焦点在终端里）：先按 **Ctrl+B**（状态栏显示前缀键；前缀键可在键盘快捷键里修改），再按下表中的键。Remote Mode 下 Ctrl+B 直接发给远程（远程自己的 tmux 照常可用）。

  | 键 | 功能 |
  | --- | --- |
  | `%` / `"` | 左右分屏 / 上下分屏 |
  | 方向键 | 切换到该方向的窗格 |
  | `o` / `;` | 下一个 / 上一个窗格 |
  | `x` | 关闭当前窗格及其中的标签（先确认） |
  | `z` | 放大 / 还原当前窗格 |
  | `!` | 把当前标签移到右侧的新窗格 |
  | `{` / `}` | 与上一个 / 下一个窗格交换 |
  | Ctrl+方向键 / Alt+方向键 | 小步 / 大步调整窗格大小 |
  | `c` | 在当前窗格新建标签（同一会话） |
  | `n` / `p`、`0`…`9` | 当前窗格的下一个 / 上一个标签、第 n 个标签 |
  | `&` | 关闭当前标签 |
  | `,` | 重命名当前标签 |
  | Ctrl+B | 把 Ctrl+B 本身发给终端 |
  | Esc | 取消 |
- **拖入文件写路径**：从系统文件管理器把文件拖到终端上，路径（含空格等特殊字符时自动加引号，多个文件用空格分隔）会写到命令行，不回车。桌面版写完整路径；浏览器模式（`--web`）里浏览器不提供路径，只写文件名。文件悬停在可放下的区域（终端、Sender、Filer 列表）上时，该区域盖上一层半透明蒙版，中间用文字说明松开后会做什么。

### 会话（Explorer）

- 会话放在文件夹里，文件夹可以多层嵌套，会话和文件夹都可以拖动整理。
- 顶部一行：左边是会话筛选框（按名称、主机筛选会话和文件夹），右边是 **NEW**（新建会话）。
- 右键：新建会话或文件夹、打开新终端、收藏、复制（Duplicate）、重命名、删除、属性（Properties…）。
- 第一次启动时 Explorer 的 Local 文件夹里是本机的 shell：Windows 上是 **cmd** 和 **PowerShell**，Linux / macOS 上是 **bash** 和 **zsh**。旧版本在 Windows 上建的、没改过的 bash / zsh 会话会自动换成 cmd / PowerShell。
- 本机没有安装的 shell 会显示为灰色。
- 会话类型：**SSH**、**Telnet**（端口默认 23，自动协商终端类型和窗口大小）、**TCP**（原样收发字节）、**串口**（端口、波特率、数据位、校验、停止位、流控；本机检测到的串口会列在下拉里）、**本地 shell**。Telnet / TCP / 串口可以勾选“本地回显”。每种类型在 Explorer、标签和 Session 面板里有各自的图标。
- Telnet / TCP / 串口会话没有文件系统，选中它们时 Filer 显示提示。
- Explorer 记住展开 / 收起状态（每个窗口各自记住）；Explorer 移到别的面板时状态保留。

### SSH

- 支持 SSH agent、私钥、密码和一次性验证码（OTP），顺序和 OpenSSH 一致。
- 认证方式选 **Password** 时可以勾选 **Remember password** 保存密码（加密保存，只能在本机、本用户下解密）。
- 第一次连接未知主机时显示指纹让你确认；主机密钥变化时拒绝连接。
- 同一个会话的多个终端、Filer 和隧道共用一条连接。

### 隧道（Tunnels）

- 点菜单栏右侧的 **Tunnels**（或 Tool → Tunnels…）打开端口转发列表，**NEW TUNNEL** 新建。每个隧道选择一个 SSH 会话和类型：
  - **LOCAL（-L）**：本机监听一个端口，连接经 SSH 服务器转到目标主机（目标地址按服务器看到的填写，例如 `localhost:5432` 是服务器上的数据库）；
  - **REMOTE（-R）**：SSH 服务器监听一个端口，连接经本机转到目标主机（目标地址按本机看到的填写）；
  - **DYNAMIC（-D）**：本机开一个 SOCKS 4 / 4a / 5 代理（无认证），浏览器或其他程序通过它经 SSH 服务器访问任意地址。
- 监听地址留空时只监听本机回环地址（远程隧道是服务器的 `localhost`），其他电脑连不上；需要时填 `0.0.0.0`。本地和动态隧道的端口留空时自动选一个空闲端口，列表里显示实际端口。远程隧道监听 1024 以下的端口或 `0.0.0.0` 需要服务器允许（root、`GatewayPorts`）。
- 列表里可以启动 / 停止、编辑、删除。每行显示状态（运行 / 启动中 / 已停止）、当前和累计连接数、收发字节数，以及最近一次失败的原因（例如目标拒绝连接、服务器禁止转发）。修改正在运行的隧道后会自动按新设置重启。
- 启动隧道时，如果会话还没连接，会先连接（可能弹出密码框）。SSH 连接断开后隧道停止并显示 “SSH connection closed”，重新点启动即可。
- 勾选 **Start when MetroTerm starts** 的隧道在软件启动时自动开启。隧道配置保存在 `sessions.json`。浏览器模式下隧道由 `metroterm web` 运行，页面关闭或刷新时停止。

### 代理（Session → Proxy…）

- SOCKS5（可选用户名 / 密码）或 HTTP CONNECT（可选 Basic 认证）。主机名交给代理解析。
- 对 SSH、Telnet、TCP 会话生效。
- 每个 SSH / Telnet / TCP 会话可以在 Session Settings 的 **PROXY** 里单独选择：使用这里的全局代理（默认）、不用代理（直连）、会话自己的 SOCKS5 / HTTP CONNECT 代理，或 **JUMP HOST（跳板机）**：可以选多个已保存的 SSH 会话，按列表顺序依次连接，最后一个跳板机连到目标（相当于 `ssh -J a,b`）。用下面的下拉添加，↑ ↓ 调整顺序，× 移除；第一个跳板机按它自己的代理 / 跳板机设置连接，最多 8 层，不能形成循环。跳板机的密码 / 口令和 host key 确认照常询问。
- **TEST** 按钮测试代理是否可用。TEST TARGET 默认是 `www.gstatic.com/generate_204`：通过代理发一个 HTTP 请求，显示状态码（正常是 204）和耗时。也可以填其他网址，或填 `host:port` 只测试能否建立连接（例如 SSH 服务器）；`https://` 网址只建立到 443 端口的连接，不检查 HTTPS 应答。
- 代理密码加密保存。

### 文件（Filer）

- 自动跟随当前终端标签：本地会话浏览本机，SSH 会话浏览远程服务器。
- 路径框可以直接输入；支持上一级、后退、主目录、刷新（F5）。
- 列：名称、修改时间、类型、大小、权限、所有者、组。点列名排序（当前排序的列名高亮，旁边的小箭头表示方向），拖动分隔线调整列宽，双击恢复默认。
- Ctrl+F 搜索当前目录；⋮ 菜单可以显示 / 隐藏隐藏文件。
- 右键新建文件夹、重命名（F2）、删除（Del）、复制路径、上传、下载。
- **多选**：Ctrl+点击加选 / 取消，Shift+点击选中一段，Shift+↑ / ↓ 扩展选区，Ctrl+A 全选。选中多项时删除、移动到… / 复制到…、复制路径、复制路径到终端、下载（桌面版选一个目标文件夹，文件夹会跳过）作用于全部选中项，重命名只针对单项；底部显示选中数量和总大小。
- **拖放上传**：从系统文件管理器把文件（桌面版也可以是文件夹）拖到文件列表上，上传到当前显示的目录；悬停时列表上显示蒙版和目标目录。
- **传输进度和通知**：上传 / 下载 / 移动 / 复制多个文件时，列表下方显示当前第几个、总进度和每个文件的状态；结束后提示成功（几秒后自动消失）或失败（显示原因，可一键重试失败的文件），运行中可取消剩下的文件。
- 右键 **移动到… / 复制到…**：在弹出的窗口里选目标目录（点文件夹进入、↑ 上一级，或直接输入路径），文件和整个目录都可以；目标目录里已有同名项、或把目录放进它自己里面时会提示并禁止。
- 底部三个按钮：**复制路径到终端**、**进入终端当前目录**、**自动跳转**（开启后终端里 `cd` 到哪里，Filer 就跟到哪里）。

### Sender

- Targets：当前终端（Current Session）、勾选的终端（Select Session）或所有终端（All Sessions）。选 **Select Session** 时输入区右侧出现已打开终端的列表，勾选要发送的终端（表头的复选框全选 / 全不选），批量发送同一段指令。
- **By: Line** 逐行发送（每行加回车），Interval 是两次重复之间的秒数；**By: Char** 逐字符发送，Interval 单位是毫秒（最小 20 ms），每个间隔发送一个字符。Count 是重复次数。
- ■ Stop 或 Esc 取消还没发出的内容。
- **拖入文件写路径**：从系统文件管理器把文件拖到输入区，路径插入到光标处（替换选中的文字），规则和终端相同（需要时加引号、多个用空格分隔）。

### Monitor

- 面板 Settings 菜单 → **Monitor**。显示当前终端标签所在主机的实时数据，切换终端标签时跟着切换：
  - 系统、开机时长、负载（1 / 5 / 15 分钟）、进程数；
  - CPU 总占用和每个核心的占用，内存、交换区，并画出最近 60 次的曲线；
  - 网络收发速率（鼠标悬停显示开机以来的总量）、磁盘读写速率、各分区的已用 / 总容量；
  - 全部进程（PID、名称、用户、CPU、内存），默认按 CPU 从高到低。
- 支持本地会话（Linux、macOS、Windows）和 SSH 会话（远端为 Linux 或 macOS）。SSH 会话只用已有的连接，不会自己发起连接或弹出密码框；会话没连接时显示提示。Telnet / TCP / 串口会话没有可监控的数据。
- 右上角可选刷新间隔（1 / 2 / 5 / 10 秒）和暂停。面板不可见时（切到其他标签、面板收起、窗口最小化）不采样，不会占用远端资源。
- **进程列表**：
  - **排序**：点列标题按该列排序，再点一次反向；数字列先从大到小。只显示当前排序的前 20 个进程。排序方式和刷新间隔会记住。
  - **搜索**：在 Monitor 面板里按 Ctrl+F，或点 Processes 右侧的搜索按钮，在标题下方打开搜索框（样式与 Filer 的搜索框相同）。只按进程名称匹配，匹配部分高亮；结果同样按当前排序取前 20 个，右侧显示“显示数 / 匹配数”（不搜索时是“显示数 / 进程总数”）。Enter 或 ↓ 跳到列表，Esc 或 × 关闭搜索框。
  - **停止进程**：选中后右键 → **Stop**（SIGTERM，进程可以保存后退出）或 **Kill**（SIGKILL，立即结束），也可以按 Del / Shift+Del。都会先弹出确认框，写明进程名、PID、用户和所在主机。Windows 本机上 Stop 是请求程序关闭，Kill 是结束任务。
  - 右键菜单还能复制 PID、名称、命令行。键盘：↑ ↓ / PageUp / PageDown / Home / End 选择。
  - 只能停止有权限的进程：本机是运行 MetroTerm 的用户，SSH 是登录的用户。没有权限时，面板和状态栏显示原因（例如 Operation not permitted）。

### MCP 服务（让 agent CLI 操作终端）

Session → Preferences → Settings… → **MCP SERVER** 选 ON（默认关闭）。打开后，Claude Code、Codex、Gemini CLI 等 agent CLI 可以通过 [MCP](https://modelcontextprotocol.io) 看到并操作 MetroTerm 里打开的终端：列出终端和其中 agent 的状态、读屏幕、等某段输出出现、给另一个终端里的 agent 发提示并等它做完、输入文字或按键、打开新标签，以及管理**窗口和分屏**（Window 菜单的窗口、终端区的 tmux 式窗格）。

- 只监听本机 `127.0.0.1`（默认端口 7690），必须带**访问令牌**（打开时自动生成，可复制 / 重新生成）；网页发来的请求（带 Origin）一律拒绝。
- 两种传输：SSE（`/sse`，Claude Code、Gemini CLI 等）和 Streamable HTTP（`/mcp`，Codex 等）。设置里选好 CLI 会给出可直接复制的配置。
- **窗口与分屏**：`list_windows` 列出所有窗口、每个窗口的分屏树（左右 / 上下及比例）、窗格（A、B … 与标签栏右侧字母一致）和每个窗格里的标签；`split_pane` 把窗格往右 / 下 / 左 / 上拆开并在新窗格里开一个终端（默认与原窗格同一会话，可顺便执行一条命令），`resize_pane` 移动窗格边界，`zoom_pane` 只显示一个窗格，`move_terminal` 把标签（连同正在运行的会话）移到别的窗格、别的窗口或新拆出的窗格，`new_window` / `rename_window` / `focus_window` 管理窗口，`open_terminal` 也可以指定窗口或窗格。都默认在后台进行，不抢当前焦点（`focus: true` 才切过去）。
- **标签（与 Session 面板一致）**：`list_terminals` 给出每个标签的名称（`tab_name`，即标签和 Session 面板上显示的名字）、所在窗口和窗格，按界面里的顺序排列，已断开的标签也列出（`connected: false`）。`rename_terminal` 改名（不给名字则恢复默认名），`move_terminal` 带 `before` / `last` 调整标签顺序，`open_terminal` 带 `terminal` 克隆一个标签（同一会话、同一窗格），`reconnect_terminal` 重新连接（返回新的终端 id；旧 id 仍然指向这个标签），`disconnect_terminal` 断开但保留标签，`close_terminal` 可以用 `terminals` 一次关闭多个（只问一次）。
- **关闭**：`close_terminal` / `close_pane` / `close_window`。agent 自己打开的终端直接关闭；其余的会弹出“An agent (MCP) wants to close …”确认框（`disconnect_terminal` 同样），用户取消（或 120 秒没回答）时调用返回 `cancelled`。不能关闭 agent 自己所在的终端、窗格或窗口，也不能关闭最后一个窗口。
- 取消 **Allow agents to type, open and arrange tabs** 后只能读、等待和切换显示，不能输入、打开 / 拆分 / 移动 / 改名 / 重连 / 断开 / 关闭。
- agent 从 MetroTerm 自己的终端里连过来时，会认出“这是你所在的终端”，不能给自己输入。
- Agent 的状态仍然只来自终端输出解析，MCP 只是让 agent 来查询和操作。

### 窗口与其他

- **语言**：English（默认）和中文，在 Settings → LANGUAGE 选择，保存后立即切换（菜单、对话框、面板、状态栏消息都会翻译），保存在 `settings.json` 的 `language`。
- **主题**：深色、浅色和 **Gold**（深色基础上的金色配色：金色选中、当前标签、主按钮和对话框边框，终端黄色改为金色，光标与深色主题一样是橙色；Explorer、Session、Filer 的名称和文件图标与深色主题相同）。在 Settings → THEME 选择，或点状态栏右下角的主题按钮按 深色 → 浅色 → Gold 轮换。
- **窗口透明度**（桌面版）：Settings → WINDOW OPACITY，30%–100%，拖动时立即预览。
- **字体**：Settings → FONTS，分别设置终端字体和界面字体（下拉列出本机检测到的常用字体，也可以直接输入字体名），下面有预览。终端字体默认是 DejaVu Sans Mono（没有安装的系统、以及它没有的字形如中文，由后面的 Sarasa Mono SC、Source Code Pro 等接替）。Windows 上默认界面字体是微软雅黑（Microsoft YaHei），Linux 和 macOS 上默认是 DejaVu Sans Mono（没有安装时用内置字体栈）。
- **只运行一个实例**（桌面版）：MetroTerm 已经在运行时再次启动（菜单、桌面图标、命令行），会把已打开的窗口切到前面并给它键盘焦点（直接可以在当前终端里输入），不会打开第二个进程。
- **关闭确认**：有打开的终端时退出（Session → Exit、窗口的关闭按钮、Alt+F4 / ⌘Q、任务栏或 Dock）会先询问，点 EXIT 才关闭；浏览器里由浏览器询问是否离开页面。
- **软件日志**（Session → Log）：Log Settings… 设置日志级别（Off / Error / Warn / Info / Debug / Trace）、日志文件路径（默认 `~/.metroterm/logs/metroterm.log`）、格式（文本或 JSON Lines）、单个文件大小上限和保留的旧文件数；Open Log Folder 打开日志目录。日志记录连接、断开、错误和状态栏消息，不记录终端输出。
- **关于**：Help → About MetroTerm… 显示版本号（0.0.1）、后端版本和运行环境。
- **锁屏**：状态栏的 🔒 锁屏图标或 View → Lock Screen。可以设置锁屏密码，也可以不设密码直接锁定；在 Settings 里可以设置空闲多少分钟后自动锁屏。锁定时终端和连接照常运行。
- **专注模式**：Ctrl+Shift+F 或菜单栏右侧按钮。窗口最大化，可以选择全屏、置顶，隐藏菜单栏、工具栏、状态栏和各个面板；再按一次恢复。
- **Mode 菜单**：**Full Screen**（F11）全屏；**Always On Top**（桌面版）窗口置顶；**Local Mode / Remote Mode** 选择终端里的键盘模式（默认 Local，状态栏右下角也可以点击切换，选择会保存）：
  - **Local Mode**：MetroTerm 处理自己的快捷键——有选中文字时 Ctrl+C 复制（没有选中时仍是中断），Ctrl+V 粘贴，Alt+N、Ctrl+= 等应用快捷键都生效。
  - **Remote Mode**：终端里的按键全部按原样转发给远程（包括 Ctrl+F、Ctrl+Shift+C / V、Alt+N 等），适合需要远程程序自己的快捷键（如 Emacs、tmux）的场景；切回 Local Mode 用 Mode 菜单或状态栏。
- **View 菜单**：Zoom、**Show Time** / **Show Line Number**（终端左侧的时间列和行号列）、专注模式、锁屏。
- **Tool 菜单**：Tunnels…；Triggers…（即将推出）。
- **Window 菜单（多窗口）**：在同一个程序窗口里建多个“窗口”，像标签一样切换（不会打开新的系统窗口）。每个窗口有自己的面板布局（新窗口从固定框架开始：左侧 Explorer / Filer，右上终端 | 右上角面板，下方 Sender）和自己的一组终端标签。
  - **New Window** 新建窗口并打开一个本地 shell；**Rename Window…** 改名；**Close Window** 关闭当前窗口（有终端时先确认，其中的 shell / 连接会结束；只剩一个窗口时不能关闭）。
  - 切换：Window 菜单里的窗口列表、状态栏右侧的窗口按钮（单击切换、双击改名、右键菜单：显示、改名、左移 / 右移、新建、关闭；**+** 新建；只有一个窗口时不显示），或 Ctrl+Shift+1…9、Ctrl+Shift+PgUp / PgDn（上一个 / 下一个）。
  - 切到其他窗口时，原窗口的终端连接、Sender 里的文字、Filer 位置等都保持不变。
  - 终端标签右键 → **Move to 〈窗口名〉**：把正在运行的会话移到另一个窗口。
- **Gold 主题**下菜单栏是金色渐变，当前终端标签的上边框有一道流光。
- **标题栏**（桌面版）：在 Settings 中选择应用自带标题栏（默认）或系统标题栏。macOS 上应用自带标题栏的最大化按钮（□）和系统的绿色按钮一样，进入 / 退出 macOS 全屏（独立的全屏空间）；双击标题栏和系统标题栏一样是最大化 / 还原窗口。在浏览器里使用时没有标题栏，菜单栏直接位于页面顶部，Settings 里也不显示这个选项。
- **记住状态**：窗口大小、Window 菜单的各个窗口（名称、布局、打开的终端标签和改过的名字）、Filer 的列宽和排序都会保存，下次启动自动恢复。
- 关闭终端标签前会弹出确认框。

## 常用快捷键

| 快捷键 | 功能 |
| --- | --- |
| Ctrl+Shift+C / Ctrl+Shift+V | 终端复制 / 粘贴（Local Mode 下 Ctrl+C 有选中时复制、Ctrl+V 粘贴；Remote Mode 下这些键都发给远程） |
| Ctrl+F | 在终端里打开查找栏（Local Mode；Remote Mode 下发给远程）；在 Filer 里是搜索当前目录；在 Monitor 里是按名称搜索进程 |
| Ctrl+= / Ctrl+- | 放大 / 缩小当前终端字号 |
| Ctrl+Shift+F | 进入 / 退出专注模式 |
| Ctrl+Shift+P | 搜索菜单命令 |
| Alt+N | 新建会话 |
| Ctrl+Shift+S | 会话另存为 |
| Ctrl+Shift+W | 关闭当前标签 |
| Ctrl+Shift+L | 清空终端回滚（右键菜单 → Clear Scrollback） |
| Ctrl+B 再按 `%` / `"` / 方向键 / `z` / `x` | tmux 风格分屏、切换、放大、关闭窗格（见上文“tmux 快捷键”） |
| F11 | 全屏 |
| F2 / Del / F5 | Filer 重命名 / 删除 / 刷新 |

上表是默认值。**Session → Preferences → Keyboard Shortcuts…** 可以修改：点一项的快捷键，按下新的组合键（必须带 Ctrl / Alt，或是功能键；Esc 取消）。组合键已被别的功能占用时不会接受，提示被谁占用，可以点 REASSIGN 改为分配给这一项（原来那项变为无快捷键）；Ctrl+Shift+1…9、Ctrl+C、Ctrl+V、Alt+F4 是固定的，不能占用。每项可以恢复默认或移除，RESET ALL 全部恢复默认。菜单里显示的快捷键随设置变化。保存在 `settings.json` 的 `keys`（只存改过的项）。

## 设置与配置文件

- **Session → Preferences → Settings…**：语言（English / 中文）、主题（深色 / 浅色 / Gold）、终端配色方案（TERMINAL COLORS）、标题栏样式、窗口透明度、终端字体和界面字体、终端字号、回滚行数、粗体文字（REGULAR 常规 / BOLD 加粗，默认常规）、光标样式（方块 / 竖线 / 下划线；终端失去焦点时不显示光标）和闪烁、锁屏密码和自动锁屏。
- **Session Settings…**（Preferences 子菜单）：当前会话的属性。
- **Default Session Settings…**：新建会话的默认值（包括默认会话类型）。
- **Keyboard Shortcuts…**（Preferences 子菜单，在 Default Session Settings… 下面）：修改快捷键，并检查是否已被占用（见“常用快捷键”）。
- **Session → Proxy…**：代理；**Session → Log**：软件日志。
- 所有配置保存在 `~/.metroterm/`（Windows 为 `%USERPROFILE%\.metroterm\`）：`settings.json` 是偏好设置，`sessions.json` 是会话、标签、布局和隧道，`known_hosts` 是在 MetroTerm 里接受的主机密钥。可以用 Session → Preferences → Profiles Directory… 打开这个目录。
- 配置文件里不会出现明文密码。
- 所有密码输入框右侧都有眼睛按钮，点一下显示明文，再点一下隐藏。弹窗里的输入框、下拉框、数字框和切换按钮都和底部按钮一样高（26 px）。点击字段的标题（如 HOST、TERMINAL FONT）不会聚焦或打开该控件，只有点控件本身才会；复选框、单选框的文字照常可以点击切换。点击弹窗外的遮罩不会关闭弹窗（用关闭按钮、取消 / 保存或 Esc）。

## 已知问题

- 使用 zsh 时，如果输入的命令很长、已经换行，再把终端缩窄，可能会留下一份旧的输入行。这是 zsh 本身的行为，bash 没有这个问题。

## 许可证

[Apache License 2.0](LICENSE)，Copyright 2026 SevenShell contributors。

## 参考项目

- [https://github.com/herdrdev/herdr](https://github.com/herdrdev/herdr)
- [https://github.com/kingToolbox/WindTerm](https://github.com/kingToolbox/WindTerm)
