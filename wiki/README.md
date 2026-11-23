# MetroTerm 开发文档

面向开发者：构建、打包、代码结构、RPC、配置文件格式，以及各模块的实现细节和踩过的坑。用户使用说明见根目录的 [README.md](../README.md)；完整配色表见 [style-css.md](style-css.md)。

- [开发环境与运行](#开发环境与运行)
- [代码规范](#代码规范)
- [打包](#打包)
  - [发布（GitHub Actions）](#发布github-actions)
- [架构](#架构)
- [RPC](#rpc)
- [配置文件](#配置文件)
- [实现说明](#实现说明)
  - [终端：渲染与性能](#终端渲染与性能)
  - [终端：外观](#终端外观)
  - [终端：行号栏与点击行高亮](#终端行号栏与点击行高亮)
  - [终端：相同文字标记](#终端相同文字标记)
  - [终端：查找](#终端查找)
  - [终端：网址链接](#终端网址链接)
  - [终端：输入](#终端输入)
  - [终端：右键菜单](#终端右键菜单)
  - [滚动条](#滚动条)
  - [布局与面板](#布局与面板)
  - [Explorer 与 Session 面板](#explorer-与-session-面板)
  - [Filer](#filer)
  - [SSH](#ssh)
  - [Sender](#sender)
  - [菜单、弹窗与输入框](#菜单弹窗与输入框)
  - [桌面外壳与窗口](#桌面外壳与窗口)
  - [锁屏与专注模式](#锁屏与专注模式)
- [已知限制](#已知限制)
- [设计规则](#设计规则)

## 开发环境与运行

技术栈：**React + TypeScript**（前端），**Rust**（后端），终端渲染用 `@xterm/xterm` 5.5 + `@xterm/addon-webgl`，查找和网址链接用官方的 `@xterm/addon-search` 0.15 / `@xterm/addon-web-links` 0.11（WebGL 渲染器；隐藏的终端和等待 WebGL 上下文的终端暂用 xterm 的 DOM 渲染器，见下文）。

后端只有一套 RPC（`src-rust/src/backend.rs`），可以用两种方式运行：

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| 桌面应用（推荐） | `npm run tauri dev` | Tauri，通过 `invoke('rpc')` 和 `backend-event` 事件通信 |
| 浏览器 + 本地后端 | 终端 1：`npm run server`；终端 2：`npm run dev` | `metroterm web --no-www` 监听 `127.0.0.1:7681`，Vite 把 `/api` 代理过去（HTTP + WebSocket） |

> `metroterm web` 可以获得本机 shell 权限，所以默认只监听 localhost。不要把它暴露到公网。

安装好的桌面应用也能以浏览器方式运行：`metroterm web [--listen ADDR] [--daemon]`（见下文“命令行参数”）。

### 命令行参数（`src-rust/src/cli.rs`）

只有一个程序 `metroterm`（`src-rust/src/bin/metroterm.rs`，只调用 `cli::main()`）：不带命令是桌面应用，`metroterm web …` 是 Web 模式。`Cargo.toml` 里只有这一个 `[[bin]]`（`required-features = ["server"]`）：默认的 `desktop` feature 编出桌面应用 + Web 模式，`--no-default-features --features server` 编出只有 Web 模式的版本（浏览器版，不需要 GTK / WebKit；不带命令运行时提示用 `metroterm web`，退出码 2）。

- `cli::parse()`：`--help` / `-h`、`--version` / `-V` 打印后退出；未知参数打印错误、退出码 2；单独的 `--` 忽略（`cargo run --bin metroterm -- web --daemon` 和 `metroterm -- web --daemon` 都等同 `metroterm web --daemon`）；macOS 的 `-psn_…` 忽略。旧写法 `--web` / `--daemon` / `--stop` 报错并提示新写法。Windows release 版的桌面构建是 GUI 子系统（`windows_subsystem` 只在 `desktop` feature 时设置），有参数时先 `AttachConsole(ATTACH_PARENT_PROCESS)`，输出才会出现在启动它的控制台里。解析逻辑在 `parse_args`，有单元测试。
- `--log DIR`（或 `--log=DIR`，桌面和 `web` 都可以）：`applog::set_dir` 把目录记在 `OnceLock` 里（相对路径按当前目录解析，先创建目录并试写 `metroterm.log`，失败退出码 1）。之后 `LogConfig::file()` 和 `default_path()` 都返回这个目录下的 `metroterm.log`，Log Settings 里保存的路径在本次运行中不生效。
- `web`（`cli::run_web`）：不创建 Tauri 应用。界面来源（`choose_ui`）：`--no-www` → 只有后端；`--www DIR`（必须有 `index.html`，否则退出码 2）；程序旁边的 `www/`（浏览器版）；桌面版内置的界面（`desktop::bundle_files()`：`desktop::context()` 是唯一的 `tauri::generate_context!()`，窗口和 Web 模式共用，`assets` 是打包进二进制的前端文件，`get` 时解压）；都没有（debug 构建）→ 只有后端。有界面时 `server::serve_web` 同一个 axum 服务既提供 `/api`，也用 fallback 提供静态文件（`/` 和没有扩展名的路径 → `index.html`；`/assets/` 带哈希，长缓存）；只有后端时 `server::serve_backend`（Vite dev / preview 把 `/api` 代理过来）。
- 地址：`--listen` / `-l`（或 `--listen=ADDR`），默认 `127.0.0.1:7681`；没有指定且被占用时，有界面就改用随机端口，只有后端则报错（Vite 代理要固定端口）；指定了地址时绑定失败直接报错。桌面构建有界面时用 `xdg-open` / `open` / `rundll32 url.dll,FileProtocolHandler` 打开浏览器（`--no-browser` 不打开）；浏览器版（多半在没有桌面的服务器上）不打开。
- Web 模式的 `/api` 有同源检查（`api_guard` 中间件，只在 `serve_web` 时启用）：Host 必须是 `localhost` 或 IP 地址（防 DNS rebinding），浏览器带的 Origin 必须和 Host 相同（防其他网站打开 WebSocket，WebSocket 不受 CORS 限制）；不带 Origin 的请求（curl）放行。只有后端时不检查（Vite 代理会改写 Host）。
- 为此 `desktop` feature 包含 `server`（axum），桌面二进制大一些。
- `web --daemon`（`cli::start_daemon`）：本进程只负责启动——用 `current_exe()` 再启动自己，参数 `web --daemon-child [--listen=ADDR] [--www 绝对路径 | --no-www] [--log 绝对路径]`，标准输入输出都接到 null；Unix 在子进程里 `setsid()`（新会话，关掉终端的 SIGHUP、终端里的 Ctrl+C 都到不了它），Windows 用 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`。子进程走 `run_web`（`daemon_child`）：不打开浏览器，监听成功后写 `~/.metroterm/daemon.json`（`{pid, url, addr}`）。父进程最多等 10 s，读到 PID 相同的状态文件就打印网址退出；子进程提前退出则报错（看日志）。已有状态文件且该地址能连上时只打印已在运行的那个（连不上就当作过期文件）。
- `web --stop`（`cli::stop_daemon`）：读 `daemon.json`，地址能连上才停：Unix `kill(pid, SIGTERM)`，Windows `taskkill /PID … /T /F`；等端口关闭（最多 5 s）后删掉状态文件。

### 前置条件

- Node.js 20+
- Rust stable 1.85+
- 桌面版需要安装 Tauri 2 的平台依赖：<https://v2.tauri.app/start/prerequisites/>

```bash
npm install
npm run tauri dev                 # 桌面版
npm run tauri build               # 打包

# 浏览器模式
npm run server                    # = cargo run --no-default-features --features server --bin metroterm -- web --no-www
npm run dev                       # 另开一个终端；可用 METROTERM_BACKEND=http://host:port 指定后端地址
```

常用检查：

```bash
npm run typecheck                 # TypeScript 类型检查（含 vite.config.ts）
npm run format                    # Prettier 格式化前端代码（不含 src/styles/ 下的编号样式文件）
npm run check                     # 类型检查 + 格式检查 + cargo fmt --check（提交前运行）
npm run build                     # 前端构建（会清空 dist/）
```

## 代码规范

- **TypeScript / CSS**：Prettier 统一格式（`.prettierrc.json`：单引号、分号、尾逗号、单参数箭头函数不加括号、行宽 140），`.editorconfig` 统一缩进和换行。
- **`src/styles/` 下的样式文件不用 Prettier**（已列入 `.prettierignore`，`colors.css` 除外），采用紧凑写法：每条规则一行（`选择器 { 属性: 值; … }`），`@media` / `@keyframes` 内的规则缩进两格、各占一行，只在顶层注释（分节标题）前空一行，修改时请手工保持这种排版。
- **类型检查**：`strict`，并开启 `noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`；没用到的变量、参数、import 会直接报错。
- **Rust**：`cargo fmt` 格式化；`cargo clippy --no-default-features --features server` 应当没有警告（`desktop.rs` 只能在 chroot 里编译，随 `npm run build:deb` 一起检查；Windows 版用 `npm run build:windows` 检查 `cfg(windows)` 分支）。
- **模块划分**（见下面“架构 → 目录结构”）：只属于 App 的状态和逻辑放 `src/app/`（hook 放 `app/hooks/`，菜单构造放 `app/menus/`，只在 App 里用的界面部分放 `app/views/`）；组件放 `src/components/<功能>/`，几个功能共用的控件放 `components/common/`；与界面无关的逻辑放 `src/lib/<领域>/`。新文件放进它所属功能的目录，同一目录里的文件名不重复目录名（`lib/terminal/find.ts`，不是 `terminalFind.ts`）。一个文件超过约 1000 行时，先把纯函数、常量和子组件移到同目录的文件里。只在文件内部使用的函数、常量、类型不要 `export`；通用的小函数（格式化、比较、端口解析）放 `src/lib/format.ts`，不要在各文件里各写一份。不直接访问 xterm 私有字段（`_core` 等），只用公开接口。
- **样式**：`src/styles/` 下**按部件分文件**（`base.css`、`layout.css`、`controls.css`、`menus.css`、`dialogs.css`、`terminal.css`、`explorer.css`、`sessions.css`、`filer.css`、`sender.css`、`monitor.css`、`tunnels.css`、`settings.css`、`lock-focus.css`），是样式规则（布局、字体、尺寸）。**只有前三个有顺序**：`index.css` 先引入 `colors.css`（变量）、`base.css`（元素默认样式）、`layout.css`（工作台布局），其余部件文件按字母顺序引入，**彼此之间不依赖顺序**——任何一个部件文件里的规则都不靠“排在后面”去覆盖另一个部件文件的规则。具体要求：(1) 一个部件的规则只放在它自己的文件里，并且同一选择器只写一条（不要在别处再写一条去改它）；(2) 部件要改共用部件（对话框框架、按钮、菜单）的样式时，用更具体的选择器写在自己的文件里（例如 `.metroterm-shell .connection-dialog.focus-dialog`、`.dialog-actions.tunnels-actions`），靠优先级取胜，不靠位置；(3) 每个文件内部按 `/* ===== 小节 ===== */` 分节，同一文件内若两条规则优先级相同且会命中同一元素，保持它们的先后；(4) 文件第一行注释说明它包含哪些部件，新规则放进对应部件文件的对应小节。**颜色统一在 `src/styles/colors.css`**（`index.css` 里最先引入）。`colors.css` 只有三个块：`:root`（深色，默认值）、`:root.theme-light`、`:root.theme-gold`，主题由 `<html>` 的 `theme-*` 类切换。**一个 class 适配所有主题**：样式文件里每条规则只写一次，只写 `var(--token)`，不写颜色值，也不写 `.light` / `.gold` / `html.theme-*` 这类主题选择器；某个部件在某个主题里要不同，就在 `colors.css` 的组件区给它一个变量（如 `--tab-bar-bg`、`--ink-active`），在对应主题块里赋值。新面板只用语义变量（`--panel`、`--ink`、`--muted`、`--line`、`--hover`、`--active`、`--control-*` 等）即可自动适配三个主题。普通灰色用中性灰阶 `--n-XX`（深色 `#XXXXXX`、浅色为其镜像，代替了原来自动生成浅色规则的 `light-theme-twins` 插件），其余用语义名称。改了颜色后同步更新 [`wiki/style-css.md`](style-css.md)（完整配色表）。新增规则时先查是否已有同一选择器的规则，避免同一属性被后面的规则覆盖而成为死代码。
- **清理样式时的回归检查**：把改动前的构建放在另一个端口（`npx vite preview --outDir <旧 dist> --port 1421 --strictPort --host 127.0.0.1`），用 Playwright 对两个版本在 3 个主题（深色 / 浅色 / Gold）× 约 15 个界面状态（默认、窄窗口、Filer 查找、路径输入框、新建会话、Session 菜单、设置、设置里展开的字体下拉框、Tunnels、About、专注模式设置、锁屏、面板菜单、窗格菜单（打开且鼠标悬停）、Sender、Monitor、标签悬停）下逐个元素比较计算样式，结果必须完全一致（0 处差异）。每组比较前先加载一次页面“预热”，让服务器端状态（Monitor 数据、Sender 内容）稳定，否则连续两次加载本身就会不同；可先用“新版对新版”跑一遍确认噪声为 0。注意 Chromium 列出自定义属性（`--*`）的顺序在不同启动之间不固定，比较前要先按属性名排序。**调整部件文件时**另外检查顺序无关：把部件文件按倒序和几种随机顺序拼接，每种顺序下每个元素的每个属性的胜出声明都必须与原样式相同；并列出“两个不同部件文件里、优先级相同、可能命中同一元素、同一属性取值不同”的规则对，这样的规则对必须为 0（有就改选择器或合并到一个文件）。判断“可能命中同一元素”时，运行时才加上的状态类（`is-open`、`is-active`、`is-selected`、`active` 等）和 `:hover` / `:focus` 要当作任何元素都可能有——只看采样到的界面会漏掉，例如“打开的菜单按钮同时被悬停”。

## 打包

| 安装包 | 命令 / 方式 | 产物 |
|---|---|---|
| Ubuntu .deb amd64 | `npm run build:deb` | `MetroTerm_0.0.1_amd64.deb` |
| Ubuntu .deb arm64 | `npm run build:deb:arm64`（交叉编译） | `MetroTerm_0.0.1_arm64.deb` |
| Windows x64 / arm64 | `npm run build:windows`（在 Linux 上交叉编译，NSIS） | `MetroTerm_0.0.1_x64-setup.exe` / `_arm64-setup.exe` |
| macOS 通用 / arm64 / x64 | `npm run build:macos`（在 Linux 上交叉编译；`-- arm64` / `-- x64` 只编一个架构），或 GitHub Actions | `MetroTerm_0.0.1_universal.dmg`（`_aarch64.dmg` / `_x64.dmg`） |
| 全部平台 | GitHub Actions（`.github/workflows/release.yml`，见下面“发布”）：推送 `v*` 标签 | GitHub Release（候选版 / prerelease） |

本地生成的安装包都放在 `release/`（`npm run build` 每次都会清空 `dist/`）。

### 发布（GitHub Actions）

`.github/workflows/release.yml` 参照 7Shell 的发布流程：每个安装包都在它所属平台的原生 runner 上、从打标签的那次提交编译，不从工作区打包。

1. **准备**：`npm run sync:versions -- X.Y.Z` 把版本号写进 `package.json`、`package-lock.json`、`src-rust/Cargo.toml`、`src-rust/Cargo.lock`、`src-rust/tauri.conf.json`（`scripts/versions.mjs`；只允许“数字.数字.数字”——MSI 不支持非数字的预发布后缀）；在 `CHANGELOG.md`（英文）和 `CHANGELOG.zh-CN.md`（中文）里写 `## [X.Y.Z] - 日期` 一节；提交后打标签 `vX.Y.Z` 并推送。
2. **verify**：标签和 5 个清单的版本一致（`node scripts/versions.mjs verify --tag vX.Y.Z`），两种语言的更新日志都有这一节（`node scripts/release-notes.mjs vX.Y.Z --check`）。不一致就不编译——发出去的版本号错了是没法补救的。本地可以用 `npm run verify:versions` 先检查。
3. **build**（6 个平台并行，`fail-fast: false`）：

   | 平台 | runner | 产物 |
   |---|---|---|
   | Linux x86_64 / ARM64 | `ubuntu-22.04` / `ubuntu-22.04-arm`（glibc 2.35） | `_amd64.deb` / `_arm64.deb`、`-1.x86_64.rpm` / `-1.aarch64.rpm`、`_amd64.AppImage` / `_aarch64.AppImage` |
   | Windows x64 / ARM64 | `windows-2022` | `_x64-setup.exe`、`_x64_en-US.msi`、`_x64-offline-setup.exe`（内置 WebView2，`src-rust/tauri.webview2-offline.conf.json`）、`_x64-portable.zip`；ARM64 同样（`_arm64…`） |
   | macOS Apple 芯片 / Intel | `macos-latest` / `macos-15-intel`（各自原生编译） | `_aarch64.dmg` / `_x64.dmg` |

   - `npx tauri build --target <三元组> -- --locked`；ARM Linux 加 8 GB swap、单任务编译、用 lld 链接（runner 内存小）。AppImage 用 `APPIMAGE_EXTRACT_AND_RUN=1`（runner 没有 FUSE）。
   - macOS 打 dmg 要挂载卷并让 Finder 排版，在 runner 上偶尔失败（“Resource busy”），所以最多试 3 次，每次重试前 `hdiutil detach /Volumes/MetroTerm`；编译错误照样失败。
   - 签名：仓库 Secrets 里有 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` 时，Tauri 用 Developer ID 签名并公证；没有时用 ad-hoc 签名（`APPLE_SIGNING_IDENTITY=-`，Apple 芯片的程序至少要有它才能启动），运行摘要里会写明。空的 Secret 会先 `unset`（空字符串不等于“没有”，签名工具会拿空值去签而中途失败）。Windows 安装包没有代码签名。
   - **便携版**：`MetroTerm.exe` + `portable.metroterm` 标记文件 + LICENSE / README。有这个标记时 `config::config_dir()` 用程序旁边的 `data/` 代替 `~/.metroterm`（设置、会话、known_hosts、日志都在里面）。记住的密码按机器和用户加密，换电脑要重新输入。
4. **web**（`.github/workflows/web-package.yml`，可复用，也能在 Actions 页单独运行）：浏览器版 `_linux-x86_64-web.tar.gz` / `_linux-aarch64-web.tar.gz`。界面在 `ubuntu-latest` 上 `npm run build` 一次；`metroterm`（`--no-default-features --features server`，只有 Web 模式，不需要 GTK / WebKit）在 `debian:10` 容器里编译，所以只需要 glibc 2.28（Debian 10+、Ubuntu 18.10+、RHEL 8+），编完用 `objdump -T` 检查最高的 GLIBC 符号版本不超过 2.28。包里是 `metroterm`、`www/`（界面）、LICENSE、README、README-web.txt。`metroterm web` 发现旁边有 `www/index.html`（或 `--www DIR`）就同时提供界面，和桌面版的 Web 模式一样只接受自己页面发来的 `/api` 请求（`server::dir_files` 只读 `www` 里的普通相对路径，拒绝 `..`、以点开头、带 `\` / `:` 的路径段）；`--no-www` 只当后端（配合 Vite 开发）。
5. **release**：收集安装包，检查 17 种必需的文件名都在（缺一个平台就失败，不发不完整的版本），生成 `SHA256SUMS.txt`；正文是中文更新日志 + 校验和 + 安装说明 + 英文更新日志链接；先建草稿上传所有文件，再发布为**候选版（prerelease）**。重新运行同一个标签时只替换文件和正文，不改已发布版本的状态。
6. **promote**：确认没问题后，Actions → Release → Run workflow，填 `tag`、勾选 `promote`：把候选版改成正式版并设为 latest，不编译任何东西（也可以 `gh release edit vX.Y.Z --prerelease=false --latest`）。

没有照搬的部分：自动更新通道（`latest.json`、Tauri 更新签名）——应用里还没有 updater 插件；Winget / Scoop / Homebrew 清单。工作流用 actionlint 1.7.12 + shellcheck 检查过。

### Linux .deb

- 适用于 Ubuntu 22.04 及更新版本。依赖 `libwebkit2gtk-4.1-0`、`libgtk-3-0`。安装内容：`/usr/bin/metroterm`、`/usr/share/applications/MetroTerm.desktop` 和图标；包名 `metro-term`。
- `scripts/build-deb.sh` 在 Ubuntu 22.04 chroot 里编译，所以程序只需要 glibc 2.35；直接在更新的发行版上编译，生成的程序在旧版 Ubuntu 上会因为 glibc 版本太新而无法运行。
- amd64 用 `/opt/jammy`；arm64 用它的副本 `/opt/jammy-arm64`：加 `arm64` 架构（`ports.ubuntu.com`），装 `crossbuild-essential-arm64` 和各 `-dev:arm64` 包，用 `aarch64-linux-gnu-gcc` 链接、`PKG_CONFIG_PATH` 指向 arm64 库。必须单独一个 chroot：arm64 的 `-dev` 包会替换掉 amd64 的（gir 文件不能两个架构同时安装）。准备步骤写在脚本开头的注释里。

### Windows

- `scripts/build-windows.sh` 用 cargo-xwin（clang-cl + lld-link + 微软 CRT / SDK）交叉编译，NSIS 打成 `-setup.exe`（WebView2 缺失时下载引导程序）。MSI 需要只在 Windows 上运行的 WiX，所以只由 GitHub Actions 生成（还有离线安装包和便携版，见“发布”）。
- **NSIS 安装包**（`tauri.conf.json` → `bundle.windows.nsis`）：
  - `installMode: "both"`：安装时选“仅当前用户”（`%LOCALAPPDATA%\MetroTerm`）或“所有用户”（`Program Files`，需要管理员权限；`MULTIUSER_EXECUTIONLEVEL Highest`，管理员账户启动时就弹 UAC）。以前只有按用户安装，选 `C:\Program Files\…` 之类要管理员权限的目录时装到一半报 “Error opening file for writing”。
  - `languages: ["English", "SimpChinese"]`：按系统界面语言自动选，中文系统显示中文。
  - `installerHooks: windows/installer-hooks.nsh`：Tauri 在 `installer.nsi` 开头（MUI2 / FileFunc 之后）包含它。里面的 `.onVerifyInstDir` 在选择目录页每次改路径时，在路径中最近一个已存在的上级目录里试建一个文件夹（`metroterm-setup-check.tmp`，建成即删）；建不了就禁用“下一步”，并把页面说明（控件 1006，只在有目录框 1019 的页面上改）换成原因和办法，路径没问题时换回原文。中文和空格路径本身没有问题（安装包是 Unicode 版），只看权限。文件是带 BOM 的 UTF-8（makensis 才按 UTF-8 读中文）。
- arm64：ring 用普通 `clang`（不是 clang-cl）编译 aarch64 Windows 的 C / 汇编，而 cargo-xwin 用 clang-cl 写法传头文件目录（`/imsvc 目录`），脚本临时放一个 `clang` 包装把它改成 `-isystem`。不要用 `XWIN_CROSS_COMPILER=clang`：它要再下载 2.5 GB 以上的另一套 sysroot。
- 第一次运行下载 MSVC CRT 和 Windows SDK 到 `~/.cache/cargo-xwin`（解压后约 1 GB，解压过程中另需约 2 GB）。编译 `windows` crate 时 2 个任务需要超过 2 GB 内存，小内存机器要先加 swap，否则会被 OOM 杀掉。

### macOS

- `scripts/build-macos.sh` 在 Linux 上交叉编译，默认生成通用版（arm64 + x86_64 用 `llvm-lipo` 合成一个程序；最低 macOS 10.15——Tauri 2 支持的最低版本，`tauri.conf.json` 的 `bundle.macOS.minimumSystemVersion` 同值；arm64 部分 11.0）：
  1. 编译：clang 以 `--target=<arch>-apple-macos<min> -isysroot <SDK>` 编 C 代码（ring、objc2），LLVM 的 `ld64.lld` 链接（arm64 输出自动带临时签名）。Tauri CLI 只编译（`--no-bundle`），因为它的 `.app` / `.dmg` 打包只能在 macOS 上运行。
  - 图标 `icons/icon.icns` 按 Apple 的图标网格：1024 画布里图形占 824×824（四周各留 100px，底部带一点阴影），否则在 Dock / 启动台里比其他应用的图标大一圈。`icon.png`、`.ico` 等其他平台的图标仍是满幅。icns 含 16–1024 的全部尺寸（icp4/icp5/icp6、ic07–ic14，PNG）。
  2. `.app`：脚本自己组装 `MetroTerm.app`（`Info.plist` 取 `tauri.conf.json` 的名称、标识和版本，`icon.icns`），再用 `rcodesign sign` 做 ad-hoc 签名（封存可执行文件、`Info.plist` 和资源）。
  3. `.dmg`：`newfs_hfs` 建空 HFS+ 卷，libdmg-hfsplus 的 `hfsplus addall` 放入 `.app`（保留文件权限）并加 `/Applications` 链接，`dmg build` 压缩成 UDZO。Firefox 在 Linux 上也是这样打 dmg 的。
- 一次性准备：`rustup target add aarch64-apple-darwin x86_64-apple-darwin`；`apt install clang lld llvm`；macOS SDK 放到 `/opt/macsdk/MacOSX15.5.sdk`（`MACOS_SDK` 可改），`newfs_hfs`（github.com/glaubitz/hfs 的 `linux` 分支，`make`）、`hfsplus` / `dmg`（github.com/mozilla/libdmg-hfsplus，cmake）和 `rcodesign`（github.com/indygreg/apple-platform-rs 的发布包）放到 `/opt/mactools/bin`（`MAC_TOOLS` 可改）。Apple 的 SDK 许可只允许在 Apple 硬件上使用，SDK 请从自己 Mac 上的 Xcode 里复制。SDK 里 Swift 模块、iOSSupport、`usr/share` 用不到，可以删掉（1.8 GB → 1.1 GB）。
- 签名：只有 ad-hoc 签名，没有 Developer ID 签名和公证，第一次打开会被 Gatekeeper 拦下（右键 → 打开）。正式发布要用 Apple 开发者证书签名并公证：`rcodesign sign --p12-file …` 加 `rcodesign notary-submit` 在 Linux 上也能完成；或者用 GitHub Actions（在仓库 Secrets 里配置 `APPLE_CERTIFICATE` 等变量，见“发布”）。
- 代码里与平台有关的部分：自动跳转在 macOS 上用 `lsof` 读终端当前目录；Linux 专用的 GTK / WebKitGTK 设置在 `#[cfg(target_os = "linux")]` 里。
- **界面跑在系统自带的 WebKit 上**（WKWebView），WebKit 版本跟着系统 / Safari 更新走：Intel Mac 常停在较老的 macOS（10.15 最多 Safari 15.6），新语法在那里会让整个界面起不来、只剩空窗口。`vite.config.ts` 的 `build.target` 含 `safari13`，esbuild 能降级的语法会自动降级，但**正则后行断言 `(?<!…)` / `(?<=…)`（Safari 16.4 起才支持）降不了**——esbuild 只把它改成 `new RegExp(…)`，模块加载时照样抛 `SyntaxError`。前端代码不要用后行断言（`lib/terminal/scheme.ts` 的高亮规则改用 `notAfter` / `when` 检查前一个字符，结果与原来的写法逐一相同）。其它要注意的：`structuredClone`、`Array.prototype.at`、`Object.hasOwn` 是 Safari 15.4，`crypto.randomUUID` 要带回退（`lib/sessions/tree.ts`）。界面启动失败时 `index.html` 里的一小段老式脚本把错误和 User-Agent 显示在窗口里，不再是空白。

## 架构

### 目录结构（第 56 轮整理）

前端按“应用外壳 / 组件 / 逻辑 / 样式”四层分目录，组件和逻辑再按功能分组；后端按“入口与传输 / 功能模块 / 共用基础”分模块。依赖方向：`app/` → `components/` → `lib/`；`lib/` 不引用 React 组件（`lib/terminal/agentStatus.ts`、`lib/platform/log.ts` 等只用 React 的 store hook）。

```text
src/                                React + TypeScript UI
  main.tsx                          入口：安装全局行为（光标、拖入文件、弹出动画…），加载配置后渲染 App
  types.ts                          共用类型（Connection、TerminalTab、RemoteFile …）
  i18n/index.ts, zh.json            国际化（react-i18next）：t / tc、LANGUAGES、setLanguage；中文翻译（键是英文原文）
  app/                              应用外壳：App 组件和只属于它的状态
    App.tsx                         主界面：把下面的 hook 和视图接起来；会话 / 文件夹、对话框开关、Session 菜单动作、
                                    布局树的渲染（SplitPane + 面板 portal 宿主）
    sessionsDoc.ts                  sessions.json 的会话树：内置本地 shell、默认文件夹、v1 → v4 迁移（initialSessions）
    settingsDoc.ts                  settings.json 的结构（SettingsDoc、readSettings）、面板标题色块（initialSwatches）
    helpers.ts                      App 用的纯函数（stamp、fileSafe、collectLeaves、minSizeOf …）
    tmuxGeometry.ts                 tmux 窗格的 CSS 位置（tmuxStyle、分隔条、sameBoxes）
    PanelSlot.tsx, StatusCursor.tsx 面板占位（portal 宿主搬进来）；状态栏 Window / Ln, Ch（cursorStore，不触发 App 重渲染）
    hooks/
      useWindowFrame.ts             窗口：标题栏样式、最大化 / 全屏 / 置顶、最小化、拖动窗口
      useLockScreen.ts              锁屏：设置、锁定状态、空闲自动锁定
      useFocusMode.ts               专注模式：进入 / 退出时设置和恢复窗口状态
      useExplorerTree.ts            Explorer 会话树：各面板的展开状态、移动 / 新建文件夹 / 重命名 / 删除 / 复制
      useMcpUi.ts                   MCP 的 mcp.ui 请求：调用 lib/workspace/mcpUi.ts 的纯函数并应用，关闭 / 断开前的确认
      usePersistence.ts             把 windows / settings / sessions / explorer 写回 ~/.metroterm
      usePreferences.ts             settings.json 里的偏好：主题、语言、终端（并加载配色方案）、默认会话、外观、代理、日志、MCP、快捷键
      useWorkspace.ts               窗口和终端标签的状态（windows、allTabs、windowIdRef），当前窗口的 tmux 视图，
                                    setLayout / setActiveTabId / updateWindow / setTerminalTabs
      useTabActions.ts              终端标签动作：打开 / 选中 / 重命名 / 重连 / 克隆 / 关闭（含确认），终端全屏，
                                    tmux 窗格动作（拆分、关闭窗格、拆出标签、移到另一窗格）
      useWindowActions.ts           Window 菜单动作：切换、新建、重命名、关闭（含确认）、排序，标签移到另一窗口
      useShortcuts.ts               键盘：tmux 前缀（Ctrl+B + 命令键，tmuxCommand）和全局快捷键（捕获阶段，shortcutRef）
    menus/menuBar.ts                菜单栏（Session · View · Mode · Tool · Window · Help）的纯构造函数，App 传入 MenuBarContext
    menus/contextMenus.ts           右键 / ⋮ 菜单的纯构造函数：标签、状态栏窗口、Explorer 树、终端、面板 ⚙、tmux 窗格
    views/                          只在 App 里用的界面部分（App 把状态和动作作为 props 传入，hook 的返回值整组传：ws、prefs …）
      TmuxPanes.tsx                 终端面板：tmux 窗格（标签栏、工具栏、⋮ 菜单）、所有终端实例的定位、分隔条拖动
      ContentPanel.tsx              内容面板：标签栏（拖动排序 / 移到别的面板）、⚙ 菜单、Explorer / Filer / Monitor / Session / Sender
      AppHeader.tsx                 无边框窗口的标题栏、菜单栏和右侧工具（菜单搜索、Tunnels、专注模式）、专注模式的退出区
      StatusBar.tsx                 状态栏：活动（自己订阅 useActivity）、窗口列表、tmux 前缀、光标位置、Local / Remote Mode、锁屏、主题
      DialogHost.tsx                对话框和浮层：会话 / Explorer 对话框、标签和窗口右键菜单、设置及 Tool / Help 对话框、
                                    菜单搜索、专注模式、各种关闭确认、锁屏、TooltipLayer
      commandPalette.ts             菜单搜索的 React.lazy 和预加载函数（AppHeader 预加载，DialogHost 渲染）
  components/                       React 组件，按功能分组
    common/                         通用控件：Select、ComboBox、NumberInput、PasswordInput、MenuButton（下拉 / 右键菜单）、
                                    MenuBar、Icon、SplitPane、TooltipLayer、FieldMenu（输入框右键菜单）、DialogFrame、
                                    dialog.ts（Esc 关闭、遮罩处理）、MatchHighlight（搜索匹配高亮）
    terminal/                       TerminalView（xterm、会话生命周期、重连）、AuthPromptDialog（密码 / host key）、PaneLetter
    filer/                          Filer（本地 / SFTP 浏览和文件操作）、listing.ts（列、排序、大小 / 日期 / 类型名）、
                                    FileOpDialog（新建文件夹 / 重命名 / 删除）、FilerTransfers（传输批次）、
                                    FilerDestinationDialog（移动到 / 复制到）、previewFiles.ts（静态预览的演示列表）
    sessions/                       SessionsPanel（Session 面板）、SessionTree（Explorer 树和对话框）、
                                    NewConnectionDialog（新建 / 属性 / 另存为）、SessionDefaultsDialog、
                                    sessionFields.ts（两个对话框共用的选项）、FolderTreeSelect
    monitor/                        MonitorPanel、MonitorProcesses（进程列表、Stop / Kill）
    sender/                         SenderPanel
    dialogs/                        应用级对话框：SettingsDialog、AppDialogs（Proxy / Log / About）、KeyBindingsDialog、
                                    TunnelsDialog、FocusModeDialog、LockScreen、CommandPalette（菜单搜索）
  lib/                              与界面无关的逻辑，按领域分组
    format.ts                       pad2、naturalCompare、formatBytes、parsePort
    platform/                       运行环境：backend.ts（desktop / server / preview 三种后端、LOCAL_SPEC）、tauri.ts（窗口）、
                                    config.ts（~/.metroterm 读写）、log.ts（日志、useActivity）、hostOs.ts、version.ts、
                                    clipboard.ts、saveText.ts（保存对话框）
    workspace/                      窗口与布局：layout.ts（面板布局树）、windows.ts（Window 菜单的窗口）、tmux.ts（窗格树）、
                                    focusMode.ts（专注模式布局）、mcpUi.ts（MCP 界面操作的纯函数）
    terminal/                       终端：scheme.ts（xterm 调色板）、palettes.ts / itermcolors.ts（iTerm2 配色）、buffer.ts（逻辑行）、
                                    gutter.ts（时间 / 行号栏）、find.ts、highlight.ts、selectionMarks.ts、cwd.ts（当前目录）、
                                    imeInput.ts、agentStatus.ts（agent 状态 store）、webglBudget.ts
    sessions/                       会话：tree.ts（Explorer 树的纯函数）、transports.ts（会话类型）、tunnels.ts / tunnelRuntime.ts
    settings/                       设置：preferences.ts、keybindings.ts、lockScreen.ts、themes.ts、fonts.ts、fields.ts
    ui/                             全局界面行为：customScrollbars、appCaret、popupMotion、fileDrop、labelClicks、dialogKeys、noAutocomplete、
                                    tabDrag、cssToken、useStableCallback
    files/path.ts                   路径规范化（~、..、Windows 盘符）
  styles/
    index.css                       @import 下面的文件（main.tsx 只引入它）：先 colors、base、layout，其余部件文件与顺序无关
    colors.css                      配色：所有颜色变量（深色 / 浅色 / Gold 三个块），见 wiki/style-css.md
    base.css                        页面与根元素、全局拖动状态、元素默认样式（按钮、输入框、单选 / 复选框、文本框）、图标
    layout.css                      工作台：标题栏、分栏、面板外壳与标签、终端标签栏、tmux 窗格、状态栏、拖放
    controls.css                    控件：Select、文件夹选择、NumberInput、ComboBox、密码框眼睛按钮、状态点、自绘光标与滚动条、提示框
    menus.css                       菜单：下拉 / 右键菜单、菜单栏、菜单搜索
    dialogs.css                     对话框框架：遮罩、标题、字段、提示与错误、底部按钮、小确认框
    terminal.css explorer.css sessions.css filer.css sender.css monitor.css tunnels.css
                                    各面板 / 部件（sessions.css 含会话面板、agent 状态和会话对话框的专用字段）
    settings.css                    设置类对话框：Settings、专注模式设置、快捷键、代理、日志、About
    lock-focus.css                  锁屏与专注模式的退出区
src-rust/src/
  lib.rs                            模块总览
  bin/metroterm.rs                  唯一的程序入口：调用 cli::main()
  cli.rs                            命令行：桌面应用 / web [--listen --daemon --stop --www --no-www --no-browser] / --log / --version / --help
  desktop.rs                        Tauri 外壳（feature "desktop"，默认启用）
  server.rs                         axum WebSocket/HTTP 服务（feature "server"）；`web --www DIR` / 旁边的 `www/` / 内置界面时同时提供界面
  backend.rs                        RPC 分发（与传输方式无关）
  terminal/                         终端会话
    mod.rs                          本地 PTY、SSH shell 通道，Telnet / TCP / 串口交给 stream.rs
    stream.rs                       Telnet（RFC 854 + ECHO/SGA/BINARY/TTYPE/NAWS）、原始 TCP、串口（serialport）
    utf8.rs                         流式 UTF-8 解码，避免中文或 emoji 被截断
    wincwd.rs                       Windows：读 shell 进程的当前目录（PEB）
  remote/                           到其他主机的连接
    ssh.rs                          russh 连接池、认证、known_hosts
    net.rs                          出站 TCP：直连、SOCKS5 / HTTP CONNECT 代理或 SSH 跳板
    tunnel.rs                       SSH 端口转发：本地（-L）、远程（-R，tcpip-forward）、动态（-D，SOCKS 4/4a/5 服务端）
  files.rs                          SFTP 和本地文件系统共用的一套接口，以及带进度的传输
  monitor/                          Monitor 面板的采样
    mod.rs                          类型、Monitor（按连接保存上次的计数）、monitor.signal
    local.rs                        本机：sysinfo
    remote.rs                       SSH 主机：经 exec 通道跑一段 sh 脚本并解析（Linux、macOS）
  agents/                           agent CLI 状态
    mod.rs                          已知 agent 列表、Agents（所有终端）、Snapshot、Tap
    catalog.rs                      内置 / 用户覆盖的检测清单和屏幕特征（manifests/、identify.toml）
    watch.rs                        单个终端：vt100 屏幕模型、OSC 标题 / 进度、识别结果和状态机
    manifest.rs, process.rs         清单的解析与求值；前台进程探测
  mcp/                              MCP 服务（feature "server"）
    mod.rs                          配置、Hub、axum 路由、守卫、JSON-RPC
    tools/mod.rs                    工具调用分发（call）、错误类型
    tools/definitions.rs            工具定义和输入 schema（tools/list）
    tools/terminals.rs              终端 id 解析、list_terminals、输入、等待 agent 状态
    tools/ui.rs                     窗口 / 窗格 / 标签：mcp.ui 请求和 id 转换
    keys.rs, caller.rs              按键名 → 字节；调用方所在终端
  common/                           共用基础
    config.rs                       ~/.metroterm 配置读写（便携版用程序旁的 data/）
    events.rs                       事件定义、交互式询问（prompt）分发
    applog.rs                       软件日志：log crate 的 Logger，级别 / 文件 / 文本或 JSON / 按大小轮转
    locale.rs                       本地 shell 的 UTF-8 locale
    secret.rs                       记住的密码（AES-256-GCM）
    themes.rs                       终端配色文件（.itermcolors）
```

单元测试放在被测模块旁边：小模块用文件末尾的 `#[cfg(test)] mod tests`，大模块拆成独立的 `tests.rs`（`agents/`、`monitor/`、`mcp/tools/`）。

## RPC

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `terminal.start` | `{sessionId, connection, cols, rows}` | — |
| `terminal.write` / `terminal.resize` / `terminal.close` | `{sessionId, …}` | — |
| `connection.disconnect` | `{connectionId}` | — |
| `auth.respond` | `{requestId, answers \| null}` | `bool` |
| `fs.home` / `fs.list` | `{connection, path}` | `string` / `{path, entries}` |
| `fs.mkdir` / `fs.rename` / `fs.remove` | `{connection, path}` / `{connection, from, to}` | — |
| `fs.copy` / `fs.move` | `{connection, from, to}`（`to` 是完整新路径） | — |
| `fs.transfer` | `{transferId, from: {connection, path}, to: {connection, path}}` | 字节数 |
| `fs.cancel` | `{transferId}` | `bool` |
| `file.saveText` | 路径和文本 | — （保存选区 / 输出，UTF-8） |
| `config.dir` / `config.load` / `config.save` | `{name, content}` | — |
| `system.shells` | — | `[{name, path}]`，本机已安装的 shell |
| `system.serialPorts` | — | `[{path, description}]`，本机串口 |
| `log.configure` | `LogConfig`（`level`、`path`、`format`、`maxSizeMb`、`keep`） | 正在使用的日志文件路径 |
| `log.write` | `{level, message}` | — （UI 的状态栏消息，target `ui`） |
| `log.defaultPath` / `log.open` | — / `LogConfig` | 默认路径 / 打开的目录 |
| `monitor.sample` | `{connection}` | 一次快照：`host`、`os`、`kernel`、`uptime`、`load`、`cpu`、`cores`、`coreCount`、`memTotal/memUsed`、`swapTotal/swapUsed`、`rxRate/txRate`、`rxTotal/txTotal`、`readRate/writeRate`、`disks[]`、`processes[]`（全部进程，`{pid, name, user, cpu, memory, command}`，按 CPU 降序，最多 4000 个；`command` 截到 300 字符）、`processCount`。速率是与同一连接上一次采样的差值，第一次为 `null`；SSH 会话没有活动连接时报 `not connected`（不会自己连接） |
| `monitor.signal` | `{connection, pid, signal: "TERM" \| "KILL"}` | — ；失败时返回原因（`Cannot stop process 1: Operation not permitted`） |
| `tunnel.start` | `{tunnel: {id, kind: "local" \| "remote" \| "dynamic", bindHost, bindPort, destHost, destPort}, connection}` | 状态（见 `tunnel.list`）。`bindHost` 为空时本地 / 动态是 `127.0.0.1`、远程是 `localhost`；本地 / 动态的 `bindPort` 为 0 时自动选端口；会话未连接时先连接（可能询问密码）；只支持 SSH 会话 |
| `tunnel.stop` | `{id}` | `bool` |
| `tunnel.list` | — | `[{id, connectionId, kind, state, message, boundHost, boundPort, active, total, rx, tx, started}]`，正在运行或因 SSH 断开而停止（`state: "error"`、`message: "SSH connection closed"`）的隧道 |
| `themes.list` | — | `{dir, black, white}`：配色目录和两个子目录里的方案名（文件名去掉 `.itermcolors`，排序） |
| `themes.load` | `{folder: "black" \| "white", name}` | 文件内容（XML plist，UI 的 `lib/terminal/itermcolors.ts` 解析；名字不能含路径，文件最大 1 MB） |
| `proxy.test` | `{proxy, host, port, path?}` | `{ms, status}`：建立隧道（有 `path` 时再经隧道发 HTTP GET）的耗时，`status` 是 HTTP 状态码，只建隧道时为 `null` |
| `ping` | — | `{version}` |

事件：`terminal.data`、`terminal.exit`、`connection.state`、`auth.prompt`、`auth.done`、`transfer.progress`。隧道状态靠 `tunnel.list` 轮询，没有事件。

浏览器模式另外提供两个 HTTP 端点：`GET /api/fs/download` 和 `PUT /api/fs/upload`，用于流式传输文件。

## 配置文件

配置保存在 `~/.metroterm/`（Windows 为 `%USERPROFILE%\.metroterm\`）。桌面版和浏览器 + 本地后端模式都写到这里；静态预览则写到 localStorage 的 `metroterm:*`。程序旁边有 `portable.metroterm` 标记文件时（Windows 便携版），改用程序旁边的 `data/`（`config::config_dir()`，启动时查一次）。

| 文件 | 内容 |
| --- | --- |
| `settings.json` | `language`（`en` 默认 / `zh`）、`theme`、`titleBar`、面板标题色块 `swatches`、`recent`（最近 10 个会话）、`terminal`（`fontSize` / `scrollback` / `cursorBlink` / `cursorStyle` / `fontFamily` / `boldText` / `gutterTime` / `gutterLine` / `keyMode` / `colorSchemes`：`{dark, gold, light}` 每个应用主题用的配色方案名，`''` = Default）、`sessionDefaults`、`lock`（密码哈希、空闲分钟、是否提示）、`focus`（专注模式设置）、`appearance`（`windowOpacity`、`uiFontFamily`；空 = 默认，Windows 上默认是 Microsoft YaHei，`preferences.ts` 的 `defaultUiFamily`）、`proxy`（`type` none/socks5/http、`host`、`port`、`username`、加密的 `savedPassword`）、`log`（`level`、`path`、`format`、`maxSizeMb`、`keep`）。`terminal` 另有 `fontFamily` |
| `logs/metroterm.log` | 软件日志（默认位置；轮转后为 `.1` … `.N`） |
| `sessions.json` | 见下 |
| `themes/black/`、`themes/white/` | iTerm2 配色方案（`.itermcolors`），见[终端：渲染](#终端渲染)的“配色” |
| `known_hosts` | 在 MetroTerm 里接受的 SSH host key（OpenSSH 格式） |
| `shell/bashrc`、`shell/zsh/` | 本地 bash / zsh 的启动文件，每次启动时重写（见[终端：输入](#终端输入)） |

`sessions.json`（version 4）：

- 没有 `sessions.json` 时（第一次启动）只建内置的本地 shell 会话，按后端所在系统决定（`app/sessionsDoc.ts` 的 `builtinShells`）：Windows 是 `cmd` 和 `powershell`（Windows PowerShell 每台 Windows 都有；pwsh 由用户自己添加），其他系统是 `bash` 和 `zsh`。系统来自后端的 `system.os`（Rust `std::env::consts::OS`，`lib/platform/hostOs.ts` 在首次渲染前读取），所以浏览器模式下看的是服务器的系统，不是浏览器的；静态预览退回到浏览器的 userAgent。Filer / Sender 的路径加引号方式和 Monitor 的 Windows 判断也用它。
- version 3 → 4（只在 Windows 上）：旧版本在 Windows 上也建了 bash / zsh。id 为 `local` / `local-zsh`、名称和 shell 仍是原样的内置会话改成 cmd / PowerShell（id、位置、文件夹、收藏不变，打开的标签和最近列表仍然有效）；用户改过或自己建的会话不动，已经有 cmd / PowerShell 会话时也不动。

- `folders` / `sessions`：会话配置（名称、主机、端口、用户、认证方式、私钥路径、所在文件夹、收藏、代理 `noProxy` / `proxy`（见[代理](#telnettcp串口与代理)）；勾选 Remember password 时含加密的 `savedPassword`，无明文密码）。
- `windows`：Window 菜单的窗口 `{"version": 1, "active": 0, "list": [{name, layout, tabs: [{connectionId, title?, tmuxPane?}], active, tmux?, tmuxActive?, tmuxZoomed?}]}`——每个窗口的名称、面板布局树（每个分隔的 `ratio` 和 `collapsed`）、打开的 shell 标签（顺序、自定义名称）和当前标签。分屏的窗口有 `tmux`（窗格树 `{dir, ratio, first, second}`，叶子是 `{pane: n}`，n 是窗格编号）、每个标签的 `tmuxPane`（所在窗格编号）、`tmuxActive`（按窗格编号列出各窗格显示的标签下标）和 `tmuxZoomed`；没分屏时这些字段都省略。旧格式（标签上的 `panes` / `paneOf` / `focus` / `zoomed`）在读取时自动迁移：选中的（否则第一个）分屏标签的每个窗格变成一个窗格，其余标签放进该宿主标签所在的窗格。
- 旧版的 `layout` / `tabs`（只有一个窗口时）启动时读成窗口 1，之后从文件里删除（`config.ts` 的 `dropConfig`）。
- `filer`：`{"columns": {"name": 238, "modified": 124, …}, "sort": {"key": "size", "descending": false}, "follow": true}`。
- `explorer`：每个 Explorer 面板的文件夹展开状态（`panels`）。
- `monitor`：`{"interval": 2, "sort": {"key": "cpu", "descending": true}}`（Monitor 的刷新间隔和进程排序）。
- `tunnels`：`{"tunnels": [{id, name, sessionId, kind, bindHost, bindPort, destHost, destPort, autoStart}]}`（Tunnels 对话框里的隧道；运行状态不保存）。
- `window`：窗口大小（桌面版在关闭时写入，不含最大化）。
- 旧版的 `layout.json` / `tabs.json` / `window.json` 会在首次保存时合并进来并删除；旧版 `group` 分组会迁移成 “Shell sessions” 下的文件夹。

写入方式是临时文件 + rename（原子替换）。Unix 下目录权限为 `0700`，文件为 `0600`。

## 实现说明

### 终端：渲染

终端是原生的 xterm.js 5.5，**不做任何渲染修改**：`TerminalView.tsx` 只创建 `new Terminal({...})`、加载 `FitAddon`、`WebglAddon` 和 `WebLinksAddon`（查找另加载 `SearchAddon`），其余全部由 xterm 自己负责（渲染、行高、字宽、光标、选区、滚动、输入法组字；只有滚动条换成了软件自绘的，见“滚动条”）。传给 xterm 的选项只有：`cursorBlink`、`cursorStyle`、`fontFamily`、`fontSize`、`scrollback`（来自 Preferences），`convertEol`（只在模拟预览时打开），`theme`（随应用主题切换），以及中文显示用的 `rescaleOverlappingGlyphs: true` 和 `minimumContrastRatio: 4.5`、竖线光标宽度 `cursorWidth: 2`，粗体字重 `fontWeightBold`（Settings → BOLD TEXT，`terminal.boldText`，默认 false = `'normal'`：粗体文字用常规字重，`drawBoldTextInBrightColors` 仍是默认的 true，颜色照样变亮；true = `'bold'`，改了立即生效，不需要 refit），失去焦点时不画光标 `cursorInactiveStyle: 'none'`（xterm 默认画一个空心框 `outline`），以及 `allowProposedApi: true`（装饰 `registerDecoration` 在 xterm 5.5 里仍是“proposed”接口，相同文字标记和 `SearchAddon` 的色块要用；关键字高亮直接改缓冲区格子的颜色，见“终端：关键字高亮”）。

- **光标粗细**：竖线光标 2px（xterm 选项 `cursorWidth`，默认 1）。下划线光标 3px：xterm 没有这个选项（WebGL 渲染器里写死为 1 个设备像素），所以改了 WebGL 插件，这是唯一一处修改，用户明确要求的：
  - WebGL：`scripts/patch-xterm-webgl.mjs` 在 `npm install` 后（`postinstall`）改 `node_modules/@xterm/addon-webgl/lib/addon-webgl.js` 里 `RectangleRenderer.updateCursor` 的“Bottom edge”：下划线样式时高度 = `Math.round(dpr × 3)` 个设备像素、贴在格子底部；空心框（未聚焦的方块）共用这段代码，仍是 1 个设备像素。脚本可重复执行（带标记），找不到原代码时报错退出——所以 `@xterm/addon-webgl` 固定为 `0.18.0`，升级时要同时更新脚本里的匹配串。CI 的 `npm ci` 同样会运行 postinstall。
  - 测试注意：Playwright 的 `device_scale_factor` 模拟不会改变 `ResizeObserver` 的 `device-pixel-content-box`，Chromium 在模拟的 125% / 150% 下 WebGL 画布尺寸不对、终端是空白的；用 `--force-device-scale-factor=1.25` 启动才是真实情况（显示正常）。

- **WebGL 渲染器**（`@xterm/addon-webgl` 0.18，对应 xterm 5.5）：`rescaleOverlappingGlyphs` 只在 WebGL / Canvas 渲染器下生效（xterm 类型说明：不支持 DOM 渲染器），所以每个终端加载 `WebglAddon`。**不退回 DOM 渲染器**（用户要求）：
  - xterm 本身的默认渲染器是 DOM 渲染器，`WebglAddon` 只是可选替换；创建失败时 `loadAddon` 抛异常、上下文丢失时插件只发 `onContextLoss` 通知——“退回 DOM”原来是 `TerminalView` 里捕获异常 / 释放插件之后 xterm 留在默认渲染器上的结果。
  - 现在 `startRenderer()` 创建失败时 `failRenderer`：`log.error('WebGL is not available, the terminal cannot be drawn', error)`（状态栏 + 应用日志，例如 `WebGL2 not supported`），`rendererError` 状态让 `.terminal-body` 加 `has-renderer-error`（`.xterm-host` `visibility: hidden`）并在原位置显示 `.terminal-renderer-error`（原因 + 检查硬件加速的提示）；这个标签不启动会话。
  - `onContextLoss`（插件在 `webglcontextlost` 后等 3 秒没有恢复才发）：释放插件，终端在屏幕上（`host.clientHeight > 0`）时下一帧重新创建 `WebglAddon`；隐藏的标签记 `rendererPending`，显示出来时由 ResizeObserver 回调里的 `restartRendererRef` 重新创建。30 秒内丢失超过 3 次按不可用处理（同上的报错，原因 “the WebGL context was lost repeatedly”）。每次丢失写一条 warn 日志（不进状态栏）。用 `WEBGL_lose_context` 在 Chromium 里测过：前 3 次重建出新的画布，第 4 次显示报错。
  - Playwright 里 `--disable-webgl` 启动可以看到报错界面。
  - **WebGL 上下文预算**（`src/lib/terminal/webglBudget.ts`）：浏览器同时只保留约 16 个 WebGL 上下文（Chromium、WebKit），再创建就丢掉最老的。以前窗格 / 标签多了会形成循环：被丢掉的渲染器重建，又挤掉另一个……（8 个窗格的测试里创建了 43 个上下文，`getContext` 占 83% CPU）；隐藏的终端也一直占着上下文和字形图集（显存）。现在：
    - 终端共用 `MAX_CONTEXTS = 12` 个名额：`startRenderer` 先 `acquireWebgl(slot)`；隐藏的终端（`host.clientHeight === 0`：后台标签、其他窗口、放大时被隐藏的窗格）不创建渲染器，记 `rendererPending`，显示时由 ResizeObserver 回调里的 `restartRendererRef` 在这一帧绘制前创建（不闪）。
    - 隐藏超过 `HIDDEN_RELEASE_MS`（5 s）的终端交还上下文；名额用完时先释放隐藏最久的（`lastShown`）。全部名额都被屏幕上的终端占着时，新的终端先用 xterm 的 DOM 渲染器，有名额空出时（`releaseWebgl` → 微任务里 `retry`）换回 WebGL。
    - 释放渲染器时先记下终端里的 canvas，`dispose()` 之后对它们调 `WEBGL_lose_context.loseContext()`（`loseContexts`）：xterm 的 dispose 只把 canvas 从页面移走，上下文要等垃圾回收才释放，期间仍计入浏览器的上限——这是以前循环的起点。
    - 结果（Chromium，SwiftShader）：8 个窗格、一个窗格持续输出时脚本 CPU 37.6% → 约 12%，上下文 8 个且不再增加；15 个终端时 12 个活动上下文、无丢失循环；隐藏窗格 5 s 后释放、显示时恢复（Chromium、WebKit 测过）。
- **字形清晰度**（第 35–38 轮）：用户反馈 Linux 100% 缩放下终端文字比界面文字发虚，最后确认是**字体**的问题——换一个终端字体（Settings → TERMINAL FONT）就清楚了，不是渲染器的问题。排查过程中试过、已全部撤回的：把字形纹理改成 `NEAREST` 取样（软件渲染下改前改后像素完全相同，确认无用后从 `patch-xterm-webgl.mjs` 删除）、用 `transform` / margin 把画布对齐到整像素（`transform` 让两个引擎都重新取样变糊；margin 在 WebKit 的 1/64 px 布局单位下 125% / 150% 对不准）。不是原因的：`rescaleOverlappingGlyphs`（只处理码位 > 255 的字符）、canvas 的 `textRendering`（各值与 DOM 文字像素相同）。xterm 的 WebGL 输出和普通 canvas 在相同整数格位置画的字逐像素一致（平均差 1.3/255）。另外可参考：WebKitGTK 开启显卡加速合成时，落在小数像素位置的层会被插值变糊，`WEBKIT_DISABLE_COMPOSITING_MODE=1` 可以排查。
- **`rescaleOverlappingGlyphs`**：单格宽但字形会盖到下一格的字符（Ⅰ Ⅱ Ⅲ 等歧义宽度字符、等宽字体里没有的字形）横向压进一格；Emoji、Powerline 和制表符不缩放。
- **`minimumContrastRatio: 4.5`**：文字颜色和背景对比度不足 4.5:1（WCAG AA）时，xterm 绘制时自动调亮 / 调暗前景色，主题里偏暗的灰色（如 ANSI 亮黑）会比调色板里的值更清楚。

- 以前的补丁全部删除：DOM 渲染器补丁（行池、span 合并、行间缝隙的 1px 重叠和 `xterm-bg-cut`）、方块字符画成图片、精确字宽、文字垂直居中、`densityLineHeight` 行高、`letterSpacing` / `fontWeight` 覆盖、光标的 `::before` 重绘和 DECSCUSR / DECSET 12 固定、输入法去重、输出高亮、网址下划线和 Ctrl+单击、查找。相同内容高亮、查找和自绘滚动条后来按新的方式重新加上了，查找和网址链接现在用 xterm 官方插件（见下面各节）。样式文件里不再有改写 `.xterm-*` 内部元素的规则，只保留外层容器的布局（`.terminal-body`、`.xterm-host` 的 flex 和 4px / 8px 内边距、`.xterm { height: 100% }`）。
- 不要再给 xterm 加渲染层面的修补（包括为了行缝去涂背景）；需要时先确认 xterm 本身的行为。唯一的例外是下面的下划线光标粗细（`scripts/patch-xterm-webgl.mjs`）。
- **配色**（`src/lib/terminal/scheme.ts`）：深色、浅色两套 xterm 调色板（16 色 ANSI、前景 / 背景、光标、选区）。深色（`DARK_PALETTE`）是 VS Code 的 Monokai（Molokai）：前景 `#f8f8f2`，背景 `#171717`，橙色光标；浅色用同一套色相加深，背景 `#fafafa`。**Gold 主题和深色共用同一套调色板和默认方案 “MetroTerm Dark”**（原来单独的 “MetroTerm Gold” 方案已删除），只有输出高亮的颜色（`highlight`）仍是 Gold 自己偏金的黄色。
  - **配色方案文件**：调色板可以换成 iTerm2 的 `.itermcolors`（XML plist，`Ansi 0 Color` … `Ansi 15 Color`、`Background` / `Foreground` / `Cursor` / `Cursor Text` / `Selection` / `Selected Text Color`，每色是 0–1 的 `Red/Green/Blue Component`，可选 `Alpha Component`）。目录 `~/.metroterm/themes/black/`（深色、Gold 可选）和 `white/`（浅色可选）；`src-rust/src/common/themes.rs` 的 `ensure()` 在 `Backend::new` 时给**没有任何方案**的目录放入内置文件（`src-rust/themes/`：`black/MetroTerm Dark`、`white/MetroTerm Light`，`include_str!` 编进程序；由 `.devtools/gen_themes.py` 从 `lib/terminal/scheme.ts` 生成，改了内置配色要重新生成）。删掉的默认方案不会因为目录里还有别的方案而被补回。旧版本写入的 `black/MetroTerm Gold.itermcolors`：`ensure()` 发现它和当年的默认文件逐字节相同（`RETIRED` 里的 FNV-1a 64 校验值）就删掉，用户改过的保留。
  - Settings → TERMINAL COLORS：一个 `Select`（下拉列表，不能输入——用户明确要求，第 33 轮的可输入 ComboBox 已改掉），设置的是上面 THEME 当前选中的主题（`schemes[mode]`，切换 THEME 就显示另一个主题的值）；选项（`schemeOptions(theme)`）是 `Default`（值 `''`，hint 为该主题的默认方案名；选中时触发器文字用占位符的淡色 `.ui-select.is-default`）加上该主题目录里的其他方案（打开对话框时 `themes.list` 读一次）；保存过、但文件已不在目录里的方案在列表读完（`schemesLoaded`）后作为一项显示，hint 为 “file not found”。保存在 `terminal.colorSchemes`：`''` = Default（读 `DEFAULT_COLOR_SCHEMES` 的文件，文件没了就用内置调色板、不报警告）；读取 settings 时等于默认方案名的值也规范成 `''`。选了别的方案而文件不存在时记一条 warn 日志并用内置调色板。
  - `lib/terminal/palettes.ts`：`applyColorSchemes(choice, force)` 读取并解析（`lib/terminal/itermcolors.ts` 的 `parseItermcolors`，缺的颜色保留内置值）三个方案，放进一个小 store；`TerminalView` 用 `useTerminalPalette(theme)` 取当前主题的调色板传给 xterm 的 `theme`，并把背景写到 `.terminal-body` 的 `--xterm-bg`（行号栏和内边距同色）。关键字高亮、相同文字标记、查找色块仍用应用主题自己的颜色。
- **字体**：Settings → FONTS 的终端字体，后面接内置的 `TERMINAL_FONT_STACK`：`"Sarasa Mono SC", "Source Code Pro"`（中文等宽：更纱黑体的中文正好两格宽），然后 RobotoMono Nerd Font、Consolas、SF Mono、Cascadia Mono、系统等宽字体。字体不随应用打包，没装更纱黑体 / Source Code Pro 时依次往后找。
- **状态栏 Ln / Ch**：可见标签在 `onCursorMove` / `onResize` / `onLineFeed` 时报告列数 × 行数和光标位置。报告写进 `app/StatusCursor.tsx` 的 `cursorStore`（不放在 App 的 state 里），只有状态栏的 `<StatusCursor>` 用 `useSyncExternalStore` 订阅、每帧最多更新一次：以前每次换行都 `setState`，持续输出时整个 App（菜单、i18n 查表）跟着重渲染，占输出时约 20% 的 CPU。拖动分隔条或调整窗口时，`ResizeObserver` 每一帧用 `fitAddon.proposeDimensions()` 报告终端将要变成的列数 × 行数（状态栏的 Window 实时变化）；终端本身仍然在停止拖动 150 ms 后才调整大小（shell 只收到一次 resize）。
- **启动时不显示 80×24**：终端第一次按面板适配（`sized`）之前，`reportCursor` 报的是适配后将得到的尺寸（`proposedSize`，fit addon 的估算），量不出来就不报，状态栏不会先闪一下 xterm 默认的 “Window 80×24”。
- **FitAddon**：`.xterm-host` 用 `box-sizing: content-box`，FitAddon 读取的宽高不含内边距。
- xterm 5.5 的 `onScroll` 不会因为用户滚动（滚轮、滚动条）触发：`Viewport` 滚动缓冲区时传了 `suppressScrollEvent: true`。需要跟随视口的功能监听 `.xterm-viewport` 元素自己的 `scroll` 事件，或在 `onRender` 里比较 `viewportY`。

### 终端：行号栏与点击行高亮

`src/lib/terminal/gutter.ts` 的 `attachGutter(terminal, {gutter, host, columns})`，只用 xterm 的公开接口（`buffer`、`registerMarker`、`onWriteParsed` / `onRender` / `onResize` / `buffer.onBufferChange`），不碰 xterm 内部，WebGL 和 DOM 渲染器下行为一致。`TerminalView.tsx` 里 `.terminal-body` 是 `.terminal-gutter` + `.xterm-host` 两列，行号栏变宽 / 隐藏时 host 变窄，终端随之 fit。行号栏的字号比终端的字号小 1px（`.terminal-gutter` 的内联 `font-size` = `prefs.fontSize − 1`，最小 6px；数字上下居中：`line-height` = 行高只把字体的 ascent + descent 框居中，各字体的数字在框里高低不同，所以 `centerText()` 把数字 0–9 在 200px 的 canvas 上画出来逐行扫描得到墨迹在基线上 / 下的比例（canvas 的 `actualBoundingBox*` 取整到整像素，12px 时太粗），再用行号栏里一个隐藏的探针（同字体、同行高，基线上放一个零尺寸 inline-block）量出基线在行里的位置，算出 `--gutter-text-dy` 让 `time` / `span` 平移到墨迹中线 = 行中线；字体或行高变化时重算，字体还在加载时不缓存。Chromium / WebKit、RobotoMono / DejaVu Sans Mono / Noto Sans Mono CJK、三档缩放下实测上下空白相差不超过 1 个设备像素；App 传进来的已经包含 View → Zoom 的偏移；CSS 里的 13px 只是默认值），列宽按 `ch` 计算，所以字号变了栏宽跟着变，host 的 `ResizeObserver` 让终端重新 fit；行高仍是终端的行高（`--gutter-row-h`），每行和终端行对齐。以前固定 12px（第 36 轮按用户要求改为跟随终端）。

- **几何**：行高 = `.xterm-screen` 的实际高度 ÷ 行数（渲染器把 screen 设成 行数 × 单元格高度），行号栏的行容器 `translateY` 到 screen 的上沿（`--gutter-row-h`）。行号栏的行和两条高亮带都用这同一组数，100% / 125% / 150% 下误差为 0（Playwright：Chromium `--force-device-scale-factor`、WebKit）。
- **时间**：每个缓冲区行记下写入时间，按“绝对行号”（缓冲区行 + 已从顶部裁掉的行数）存在 Map 里。裁掉的行数靠几个 marker（`anchors`）推算：xterm 裁剪回滚时会把 marker 往上移，`绝对行号 − marker.line` 就是裁掉的行数；每隔 `min(1000, 容量 / 4)` 行在光标处补一个新 marker，所以总有一个还在缓冲区里（`seq 1 12000`、回滚 10000 时顶部的行仍有时间）。光标新到达的行记为当前时间；屏幕最下面一屏里文字变了的行（进度条、重画的提示符）更新为最新时间。所有 marker 都没了（Clear Scrollback、reset）就从头开始。备用屏幕（vim、htop）：每个屏幕行记最后一次变化的时间，行号是屏幕行号。每帧最多处理一次（`requestAnimationFrame` 合并）。
- **行号**：按逻辑行编号——第 n 个不是续行（`isWrapped` 为 false）的缓冲区行是第 n 行，所以折行不会让行号跳号（以前用缓冲区行 + 1，每个折行后面都跳过几个号）。`startsBefore(row)` 数 `row` 之前的逻辑行：`baseY` 以上的计数缓存在 `startsCache`，`onResize`（重排改变折行）和 `reset()` 时递增 `startsEpoch` 让缓存失效；`render` 从视口第一行起用一个累加的计数编号。`lineNumber(row)` 是给外面用的同一个计算：状态栏 Ln 在普通缓冲区里用它（`TerminalView` 的 `reportCursor`），备用屏幕里仍是屏幕行 + 1。自动换行的续行不显示；光标所在逻辑行是 `is-current`（`--gutter-current` 红色）；没写过的空行（光标以下）不显示——判断统一用 `isRendered(行, 裁掉的行数)`（光标到过且有时间）。调整大小（`onResize`）时 xterm 重排缓冲区（变宽时折行被合并，光标上移）：光标以下、现在是空行的绝对行号的时间被删掉，`stampedUpTo` 退回光标处，所以行号栏不会延伸到光标下面没有输出的行；同时设 `rebase`，下一次扫描时重排后文字变了的屏幕行不当作“重画”，不改成当前时间。行号列宽按缓冲区容量（回滚 + 行数）的位数（`--line-digits`，至少 3），输出增多时宽度不变，不会因为跨过 999 / 1000 行而重新 fit、重排整屏。
- **两列开关**：View → Show Time / Show Line Number（`settings.json` → `terminal.gutterTime` / `gutterLine`）：`.terminal-gutter.no-time` / `.no-line` 改 grid 列，两项都关时 `hidden`；`TerminalView` 的 effect 调用 `setColumns` 后 refit。
- **点击行高亮**：在终端里单击（按下和松开相距不超过 3px、没有选中文字）或单击行号栏的行，选中整个逻辑行（包括折行）。只有已经写过的行（显示行号的行，`isRendered`：光标到过或有时间）能选中；单击光标下面还没写过的空行不高亮，并取消已有的高亮；选中的行后来被擦掉（变成光标下面的空行）时高亮先隐藏。用 `registerMarker` 跟踪这一行（输出滚动、回滚裁剪、改变宽度重排时 xterm 都会移动 marker；marker 被裁掉时高亮消失）。这一行在行号栏里的行加 `is-picked`：时间和行号用 `--gutter-picked`（深色 #f2f2f2、浅色 #111111、Gold #f6efe0，不加粗——用户要求），`render` 按 `picked.marker.line`（且 `isRendered`）判断，`unpick` 时重新 `schedule` 一次去掉；同时是光标行时 `is-current` 的颜色优先（CSS 里写在后面）。两条带：`.xterm-host` 里的 `.terminal-line-highlight`（在画布上面，半透明 `--terminal-line-highlight`，`pointer-events: none`）和行号栏里的 `.terminal-gutter-band`（在文字下面），位置都由同一个行高算出，只显示在屏幕内的部分。备用屏幕里不显示。
- 行号栏上的滚轮滚动终端（`terminal.scrollLines`）。提示框、关闭自动填充、自绘滚动条的 MutationObserver 不处理 `.terminal-gutter` 里的变化。

### 终端：相同文字标记

`src/lib/terminal/selectionMarks.ts` 的 `attachSelectionMarks(terminal)`：选中文字时，其他相同的文字加背景色（`--terminal-same-text`，像 VS Code 的 selection highlight）。

- **用 xterm 的装饰画**：`registerDecoration({ marker, x, width, backgroundColor, layer: 'bottom' })`，背景由渲染器自己画进格子里（在文字下面，文字颜色不变），和选区用同一套格子坐标，所以严格对齐。第一版是自己在 `.xterm-host` 里叠半透明的 `<i>`，按 `.xterm-screen` 的尺寸算位置，在小数像素位置 / 非 100% 缩放时和选区差 1px（用户截图），已改掉。用 Playwright 在 100% 和 125% 下比较：标记行和选中行的左右边缘像素完全相同。
- **颜色**：`backgroundColor` 只接受 `#rrggbb`，所以 `colors.css` 里 `--terminal-same-text` 是不透明色（深色 `#3a3a3a`、浅色 `#e2e2e2`、Gold `#3a3324`），运行时从 `<html>` 读出来；切换主题时 `TerminalView` 调 `refresh()`（下一帧再读，App 在自己的 effect 里切换 `<html>` 的主题类）。
- **什么样的选区**：一行以内（不含换行）、不全是空白、最多 256 个字符。精确匹配（区分大小写），不重叠；被选中的那一处不加（`getSelectionPosition().start`，xterm 5.5 实际给的是 0 起的列和绝对行号）。
- **范围**：视口上下各一屏（`viewportY − rows` 到 `viewportY + 2 × rows`），按逻辑行搜索（软换行的行拼起来，跨换行的匹配每行一个装饰），最多 600 处。render / resize 后下一帧重算，滚动（`onScroll`）时立即重算，滚进来的行不会晚一帧才有背景。装饰按 `行:列:宽` 保存，只在匹配集合变化时增删——注册装饰会引起一次 render，重算结果相同就不再变化，不会循环。
- **按格子而不是按字符**：中文等宽字符占 2 格，第二格 `getWidth() === 0` 跳过。
- 在 xterm 里输入会清除选区（xterm 自己的行为），标记随之消失。

### 终端：查找

`src/lib/terminal/find.ts` 的 `attachFind(terminal, { onFocusLine, onChange, onActive })`，界面在 `TerminalView` 里（`.terminal-find`，终端右上角）。搜索和色块由 xterm 官方的 **`@xterm/addon-search`**（0.15，`SearchAddon`）完成，`lib/terminal/find.ts` 只是一层薄封装（对外接口和以前的自写实现相同：`setActive` / `search` / `next` / `previous` / `setAll` / `refresh` / `dispose`），以前自己写的逻辑行搜索、10000 处上限和视口附近的 Find all 都已删除。

- **打开**：窗格工具栏全屏按钮右边的放大镜（Remote Mode 下也能用），Local Mode 下在终端里按 Ctrl+F（Remote Mode 下 Ctrl+F 照样发给远程），或右键菜单 **Find…**。有一行以内的选中文字时，它就是搜索词。用 `flushSync` 立刻渲染并聚焦输入框，紧跟着输入的字符不会落到 shell 里。
- **搜索**：`findNext` / `findPrevious(query, { caseSensitive: false, decorations })`，整个缓冲区（回滚 + 屏幕）；插件自己拼接软换行的行、处理中文宽字符。新的搜索词从打开查找栏时的视口顶部（`anchor`）开始找：插件对新词从选区起点开始搜索，所以先 `terminal.select(0, anchor, 1)` 放一个单格选区；到底后回到开头。
- **当前匹配**：插件选中它（终端选区）、滚动到可见处，并画 `activeMatchBackground`（`--find-current-bg`）；`onFocusLine` 取 `getSelectionPosition().start.y`，通过 `gutter.pickLine` 像点击一样高亮这一行。
- **计数**：`onDidChangeResults({ resultIndex, resultCount })`——插件只在传了 `decorations` 时计数，所以总是传；`SearchAddon({ highlightLimit: 1000 })` 最多数 / 画 1000 处，达到上限时显示 `1000+`，当前匹配在 1000 处之后时 `resultIndex` 是 −1，显示 `?/1000+`。
- **Find all**：开时 `matchBackground` = `--find-other-bg`（较淡），关时不给 `matchBackground`（装饰照样建，用来计数，但不画颜色）。插件只在搜索词或 `caseSensitive / regex / wholeWord` 变化时重画全部匹配，所以切换 Find all 和主题（`refresh()`，下一帧重新读取 `--find-*-bg`）时先 `clearDecorations()` 让它忘掉搜索词，再从当前选区起点 `findNext`，停在同一处匹配。
- **按键**：Enter / F3 下一个，Shift+Enter / Shift+F3 上一个，Esc 关闭（焦点回到终端）。按钮：上一个、下一个、Find all、关闭。没有结果时计数显示 “No results”（`--find-empty-ink`）。
- **新输出**：插件自己在 `onWriteParsed` / `onResize` 后 200 ms 重新搜索（`incremental` + `noScroll`，当前匹配停在原处）；切换到备用屏幕时从 `anchor` 重新搜索。关闭时 `clearDecorations()` 去掉所有色块（也停止重新搜索）。
- **相同文字标记暂停**：插件用终端选区标出当前匹配，查找栏开着时 `onActive` 调 `selectionMarks.setPaused(true)`，否则每处匹配又会被相同文字标记再画一遍；关闭后按当时的选区恢复。
- 色块是 xterm 装饰（`backgroundColor`，插件用 `layer: 'top'`），颜色必须是不透明的 `#rrggbb`（`lib/ui/cssToken.ts` 的 `tokenHex` 读取；插件要求的 overview ruler 颜色也传同样的值，终端没开 overview ruler，不显示）。每个主题一套明显不同的颜色：深色青蓝（`#23718a` / `#1f3f4b`）、浅色黄（`#f0c84a` / `#f6e7b4`）、Gold 琥珀（`#9a7420` / `#4a3d1c`）。

### 终端：网址链接

`TerminalView` 加载 xterm 官方的 **`@xterm/addon-web-links`**（0.11，`WebLinksAddon`），用它默认的网址规则（`http://` / `https://`，不含后行断言，老 WebKit 也能用）。

- **悬停**：xterm 的 linkifier 给网址画下划线并把指针换成手形（`.xterm-cursor-pointer`）。
- **打开**：处理函数只认 **Ctrl+单击**（macOS ⌘+单击，`event.ctrlKey || event.metaKey`）；直接单击照常选中 / 高亮行，不会误开浏览器。`lib/platform/tauri.ts` 的 `openUrl(url)`：桌面版调 Rust 命令 `open_url`（`desktop.rs`，只接受 http(s)、不含空白 / 控制字符、最长 8192 的地址，交给 `cli::open_browser`——Linux `xdg-open`、macOS `open`、Windows `rundll32 url.dll,FileProtocolHandler`，不等待、后台回收子进程）；浏览器版 `window.open(url, '_blank', 'noopener,noreferrer')`。打开失败写一条 warn 日志（“Cannot open the link”）。
- **颜色**：以前关键字高亮给网址着色（`url` 类型），现在去掉了：网址规则改成 `plain`（只占位，网址里的数字 / 路径 / 关键字仍不着色），链接的显示完全交给插件。

### 终端：关键字高亮

`src/lib/terminal/highlight.ts` 的 `attachHighlighter(terminal, colors, enabled)`，颜色在 `lib/terminal/scheme.ts` 每个主题的 `highlight`（`HighlightKind` → `#rrggbb`），开关只有 `TerminalPrefs.highlight`（View → Highlight Keywords，默认开），正常屏幕和备用屏幕（全屏程序）一起开关。

- **规则**（`RULES`，优先级从高到低，重叠时前面的规则赢）：提示符符号、网址和路径（`plain`：只占位不着色，网址 / 路径里的数字 / 关键字都不着色；网址由 `@xterm/addon-web-links` 负责，见上一节）、`ls -l` 权限、命令行选项、UUID、时间、MAC / IPv4 / IPv6、error、warning、success、stopped、info、debug、字符串、数字（版本号整体）、括号和 ` - `。关键字是整词、不区分大小写。不用正则后行断言（老 WebKit 不支持），由 `notAfter` / `when` 代替。
- **只处理默认颜色**：匹配必须整段落在前景、背景都是默认色且不是反显 / 隐藏 / 暗淡的格子上；SGR 设置过的颜色（16 色、xterm-256color 的 `38;5;n` / `48;5;n`、真彩色）一律保留，不会和程序自己的配色冲突。
- **实现（第 64 轮，方案 2：直接给缓冲区里的格子着色）**：匹配到的格子把前景改成高亮色（真彩色 `CM_RGB | rgb`），并在背景字的第 31 位打上标记 `MARK = 0x80000000`（xterm 5.5 的 `BgFlags` 只用到第 30 位，渲染器只读颜色模式 / RGB 位和它认识的标志）。一行再次计算时，先把带标记的格子还原成默认前景（`strip`），再按当前文字重新匹配、着色（`paint`）。程序覆盖写某个格子时写入的是新的背景字（没有标记）和它自己的颜色，所以颜色永远跟着文字走：vim / less 重画、`\r` 覆盖、清屏、插入 / 删除字符都不会留下错位的颜色。没有装饰、marker、DOM 元素，渲染器把这些格子当普通的彩色文字画。用到 xterm 内部结构：`terminal.buffer.active._buffer.lines`、`BufferLine._data`（每格 3 个 Uint32：内容、前景、背景）和 `translateToString(trim, 0, len, outColumns)`（字符下标 → 列，宽字符 / 组合字符都对得上），因此 `package.json` 把 `@xterm/xterm` 固定为 `5.5.0`；`internal()` 检查结构不对时直接不高亮，不会报错。
- **什么时候算**：只算视口里的行；`onWriteParsed` / `onScroll` / `onResize` / `onBufferChange`、`.xterm-viewport` 的 `scroll` 事件（滚轮 / 滚动条不触发 `onScroll`）和 `viewportY` 变化时的 `onRender` 后用一个微任务计算，在下一帧绘制之前完成，新输出出来时已经着色。每行先算一个 FNV-1a 哈希（全部格子的三个字 + 代数 `generation`），和上次着色后的哈希（`WeakMap<行对象, 哈希>`，xterm 回收行对象时哈希自然对不上）相同就跳过，所以没有变化的屏幕每次只花每行一次哈希。滚过去没看过的行，滚回来进入视口时再着色。有格子改动时 `terminal.refresh(first, last)`。规则匹配按行文字缓存（最多 4000 条）。
- **主题切换**：`setColors` 让 `generation` 加一，所有行的哈希都对不上，进入视口时按新颜色重算（还原 + 着色）。**关闭**（`setEnabled(false)`）时立刻把正常屏幕和备用屏幕里所有带标记的格子还原（`stripAll`），回滚里不留颜色。
- **备用屏幕**（vim、less、htop……）：Highlight Keywords 打开时同样处理（第 64 轮起不再有单独的开关），只给程序没设颜色的格子着色：vim 开着语法高亮时几乎不变，纯文本文件、less 看日志会着色，top / htop 里没设颜色的数字列也会着色。功能上没有影响（只改 xterm 缓冲区里格子的颜色属性，不往程序发送任何东西，输入、光标、选区、复制、鼠标、滚动都不变，程序重画会覆盖掉）。
- **性能**（第 64 轮，30k 行日志输出后滚轮滚动，无 GPU 的 headless Chromium，同一台机器先后各跑一次）：开 / 关的差距从装饰实现时的“>100 ms 帧 26 vs 6、滚动 >50 ms 帧 60 vs 29”降到“8 vs 3、68 vs 50”；CPU 剖析里高亮相关的 JS 几乎看不到（装饰实现时 `dispose` 679 ms、`_innerRefresh` 615 ms、GC 667 ms，现在 `_innerRefresh` 89 ms、GC 198 ms）。
- 按行匹配，不按逻辑行：被软换行切开的词不匹配。
- 和相同文字标记、查找色块（装饰的背景色）互不影响。
- 命令行选项（`--help`、`-f`）是橙色：深色 `#fd971f`、浅色 `#b35c00`、Gold `#e8a33d`（和 stopped / UUID 同色）。

### 终端：输入

- **输入延迟**：按键立即发送，不等上一次写入的回复（WebSocket 保证顺序）。键入的文字在最多 8 ms 的窗口内合并成一次 `terminal.write`；Enter、Tab、Ctrl 组合键、Esc / 方向键序列、粘贴和一次多个字符的输入（输入法上屏）立即发送（连同未发出的文字，顺序不变）。
- **调整大小防抖**：尺寸停止变化 150 ms 后才 resize 一次（`RESIZE_DEBOUNCE`），之后等 shell 重画完（输出停下 40 ms，最多 600 ms）再处理下一次，避免折行的输入行留下多份。
- **输入法**：组字由 xterm 自己处理（隐藏的 textarea + composition 事件），`lib/terminal/imeInput.ts` 的 `guardImeInput` 只接管 Linux 桌面版（WebKitGTK）的两种异常情况（第 46 轮）：
  - **只提交、不组字**（fcitx5，以及预编辑显示在输入法自己窗口里的 IBus）：页面收不到 `compositionstart`，每个按键只有 `keydown`（keyCode 229），选词时才有 `input(insertFromComposition / insertText)` 和一个孤立的 `compositionend`。原版 xterm 会重复发送：每个 229 keydown 都安排一次隐藏 textarea 的差异比较（`_handleAnyTextareaChanges`），选词后每一次都比出同一个词（打 `nihao` + 空格得到 5 遍“你好”，还会漏出拼音字母）；孤立的 `compositionend` 又按过期的位置取一段 textarea 文字再发一次（textarea 只在 Enter / Ctrl+C 时清空，前面的文字会跟着重发）。处理：组字之外的 229 keydown 不交给 xterm（`TerminalView` 的自定义按键处理先调用 `ime.keydown()`，返回 false 即跳过），提交的文字由 guard 用 `terminal.input(text, true)` 发送一次——来自孤立的 `compositionend`（`data`，没有时用最近的 `insertFromComposition`，再没有就取这次按键开始后 textarea 新增的部分），或 229 之后的 `insertText`（标点等）；事件随后在捕获阶段停止，不再到 xterm 在 textarea 上的监听；发送后清空 textarea。
  - **组字结束时多一个 `insertText`**（预编辑显示在页面里的 IBus）：xterm 发送组字结果后，`_inputEvent` 会把这个 `insertText` 再发一次；组字中或刚结束且文字相同时把它拦下。
  - 正常组字（Chromium、Firefox、macOS、IBus 页面内预编辑）和普通按键仍由 xterm 处理；100 ms 内两条路径送来相同的提交只发一次。
  - 测试（`.devtools/imeharness.js`，由 `.devtools/ime3.py` 运行；`raw.html` 是不带 guard 的原版 xterm）：按 WebKitGTK + fcitx5 的事件顺序合成（textarea 里已有 `echo abc `，提交“你好”“中”“文”（`compositionend` 不带 data）“，”“你好”）：原版 xterm 发出 `你好`、`ho abc 你好`、`中`、`cho abc 你好中`…；加上 guard 后依次各一次。另外：正常组字两种事件顺序各一次、紧接着的普通按键不受影响；Chromium 用 CDP `Input.imeSetComposition` 输入真实组字一次；普通键入不变。
- **粘贴**：Ctrl+Shift+V 时 Chrome 和 WebKitGTK 自己会触发粘贴，只在浏览器没有粘贴时才读剪贴板。
- **本地 bash 启动文件**：`bash --rcfile ~/.metroterm/shell/bashrc -i`，按登录 shell 的顺序读取 `/etc/profile` 和 `~/.bash_profile`（或 `~/.bash_login`、`~/.profile`），然后 `shopt -u hostcomplete`（否则 `@` 开头的词按主机名补全，会补成 `cd \@babel/`），并关闭 readline 的 `enable-active-region`（粘贴不带反色）。
- **本地 zsh**：`~/.metroterm/shell/zsh/` 的启动文件先读用户自己的 `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin`，再设置 `zle_highlight=(paste:none)`。
- **UTF-8**（`src-rust/src/common/locale.rs`）：继承的环境没有 UTF-8 locale 时（容器、systemd、Finder 启动的 macOS 应用），设置原语言的 UTF-8 版本，否则 `C.UTF-8` / `en_US.UTF-8`。SSH 连接像 OpenSSH `SendEnv` 一样发送 UTF-8 的 `LANG`。
- **本地 shell 列表**：后端 `system.shells` 读 PATH 和 `/etc/shells`（Windows：pwsh、PowerShell、cmd、WSL、Git Bash）。

### 终端：右键菜单

- 复制、粘贴、粘贴选中内容、复制整行、全选、查找（Ctrl+F）、清空回滚（Ctrl+Shift+L，`clearScrollbackRef`：`terminal.clear()` + `gutter.reset()`），以及 App 提供的会话 / 窗格命令。菜单里的快捷键提示来自当前的键盘快捷键设置（`keyHint`）。

### 键盘快捷键

`src/lib/settings/keybindings.ts` + `components/dialogs/KeyBindingsDialog.tsx`（Session → Preferences → Keyboard Shortcuts…）。

- **动作**（`KEY_ACTIONS`）：应用级——New Session（Alt+N）、Save Session As（Ctrl+Shift+S）、Close tab（Ctrl+Shift+W）、Search menus（Ctrl+Shift+P）、Focus Mode（Ctrl+Shift+F）、Full Screen（F11）、Zoom In / Out（Ctrl+= / Ctrl+-，默认时另认 Ctrl+Shift+= 和小键盘 + / -）、Previous / Next Window（Ctrl+Shift+PgUp / PgDn）、Previous / Next Tab (in the pane)（Ctrl+PgUp / PgDn：焦点窗格标签栏里的上一个 / 下一个标签，循环，和 Ctrl+B `p` / `n` 相同，`stepTab`）；终端级（焦点在终端里）——tmux 前缀（Ctrl+B）、Find（Ctrl+F）、Copy（Ctrl+Shift+C）、Paste（Ctrl+Shift+V）、Clear Scrollback（Ctrl+Shift+L）。
- **固定**（`FIXED_BINDINGS`，不能改，但算作已占用）：Ctrl+Shift+1…9 显示窗口、Ctrl+C（有选中时复制，否则发给 shell）、Ctrl+V 粘贴、Alt+F4 退出；tmux 前缀之后的命令键。
- **格式**：`Ctrl+Alt+Shift+Meta+键`，键取自 `KeyboardEvent.code`（与键盘布局和 Shift 无关：`Ctrl+Shift+1` 而不是 `Ctrl+!`）；`''` = 无快捷键。必须带 Ctrl / Alt / Meta，或者是功能键（`isBindable`），否则会占掉一个可输入的字符。
- **冲突检查**（`conflictOf`）：录入的组合已被其他动作占用时拒绝，提示被谁占用，并给出 REASSIGN（移到这里，原动作变为无）；被固定快捷键占用时只提示不可用。Ctrl+字母（无 Shift / Alt）会提示它在终端里不再发给 shell（readline 键）。“恢复默认”时默认键已被别的动作占用也走同样的检查。
- **录入**：点快捷键按钮（`.key-capture`，WebKit 点击按钮不聚焦，所以 `focus()`）后按组合键；单独的修饰键不算，Esc 取消录入（不关闭对话框）。App 的全局快捷键处理在焦点位于 `.key-capture` 时不处理按键。提示和按钮在对话框底部 `position: sticky`，列表滚动时也看得到冲突提示。
- **保存**：settings.json → `keys`，只存和默认不同的项（`keyBindingOverrides`）；读取时 `sanitizeKeyBindings` 丢掉未知动作和不合法的组合。
- **生效**：App 每次渲染 `setKeyBindings(keyBindings)`；App 的捕获阶段处理（`app/hooks/useShortcuts.ts` 的 `shortcutRef`）和 `TerminalView` 的 `attachCustomKeyEventHandler` 都用 `bindingOf(event)` + `matchesKey(action, …)`；菜单提示、工具提示、专注模式和菜单搜索里的说明文字、状态栏的前缀标记都用 `keyHint` / `withKey` / `prefixHint`，改键后立即跟着变。Remote Mode 下终端里的按键照旧全部发给远程。
- **右键菜单 / 保存**：Save Selection As… / Save Output As… 桌面版弹出系统“另存为”对话框，由后端 `file.saveText` 写入；浏览器版用 `showSaveFilePicker`，不支持时退回下载。
- **Session → Disconnect**：只断开当前终端；没有其他终端在用这条 SSH 连接时一起断开。

### 滚动条

所有滚动区域（包括终端）的滚动条由 `src/lib/ui/customScrollbars.ts` 自绘，不依赖 `::-webkit-scrollbar`，各引擎外观一致。

- **终端**：`SCROLL_SELECTOR` 里有 `.xterm-viewport`（xterm 真正滚动的元素，`scrollTop` 和 xterm 的 `viewportY` 双向同步），所以拖动滑块、点轨道翻页、在滚动条上滚轮都直接改 `scrollTop`，由 xterm 自己跟着滚。原生滚动条被 `.sb-custom` 隐藏；FitAddon 按 xterm 打开时量到的滚动条宽度（原生滚动条宽度，量到 0 时用 15px）在右边留出空位，自绘滚动条盖在这块空位上（不加 `--sb-reserve`），不会盖住文字。文档 MutationObserver 已经跳过 `.xterm-screen` / `.xterm-accessibility` 里的变化，回滚增长通过 `.xterm-scroll-area` 的尺寸变化（ResizeObserver）更新滑块。 滚动条贴在窗格右边缘：`.xterm-viewport` 设 `--sb-outset-right: var(--terminal-pad-x)`（= `.xterm-host` 的右内边距 8px），`customScrollbars.ts` 把盖在区域边上的竖直滚动条往右移这么多，正好落在 host 的内边距上。
- 直角，无箭头，10px 宽，滑块 6px；宽度和颜色由 `--sb-size`、`--sb-pad`、`--sb-thumb*` 控制。加上 `data-scrollbar` 属性的元素也会使用。
- 宽度通过透明边框预留；预留了位置的区域用 `--sb-reserve: 1` 标记，滚动条按浏览器实际画出的预留宽度绘制（非 100% 缩放时边框宽度会被取整，不能从宽度反推）。位置按元素的小数边界计算并对齐到屏幕像素。带固定表头的列表从表头下方开始。
- 层级：滚动条放在 `<body>` 下一个不形成层叠上下文的 `.sb-layer` 里，每个滚动条的 `z-index` 取所在表面的层级 + 1；主界面上为 3（面板内容之上、分隔条之下）。
- 点击外部关闭的弹出层（菜单搜索、菜单栏菜单、下拉 / 右键菜单、Select、ComboBox、文件夹选择）判断“外部”时用 `pressTarget(event)`：滚动条不在所属元素里（在 `.sb-layer`），`trackOwners`（WeakMap：track → 滚动元素）把按在滚动条上的点击算作按在它滚动的元素上——以前点菜单搜索结果列表的滚动条会关闭弹窗。
- 系统滚动条：`.sb-custom` 用 `scrollbar-width: none` 和 `::-webkit-scrollbar { display: none }` 隐藏。WebKit（macOS WKWebView、Safari、WebKitGTK）在创建滚动条时决定用系统样式还是 `::-webkit-scrollbar` 样式，之后不再改；加 `sb-custom` 之前已经溢出的区域（列很宽的 Filer 从第一次布局就有横向滚动条）在 macOS 上会在自绘滚动条下面留着系统滚动条。所以加类后 `recreateNativeScrollbars` 把 `overflow` 临时设成 `hidden` 再恢复（各强制一次布局），让引擎按新样式重建滚动条，并恢复滚动位置；只对已经溢出的区域做。
- 每帧只更新一次；仅滚动时只用 `transform` 移动滑块。滚动区域只在启动时搜索一次整个文档，之后只在新加入的元素里查找（离开文档的通过 `isConnected` 发现）。

### 布局与面板

- 布局是可拖拽、可 Split 的面板树（`components/common/SplitPane.tsx`，`SplitState {ratio, collapsed}`）。左侧 Explorer / Filer，右侧终端 + 标签栏在上、Sender 在下。
- 面板小于最小尺寸就隐藏、另一侧占满，句柄留在边缘可拖回。默认最小 180px；Sender 所在的右下面板单独设为 90px（`SENDER_MIN_PANEL_SIZE`），这是面板位置的属性，不跟着 Sender 走。
- **分隔线不被面板内容盖住**：显示缩放为 125% / 150% 时，面板边缘落在半像素上，带 GPU 图层的内容（如 Filer 的 sticky 表头）的裁剪会向外取整 1 个设备像素，盖住分隔线的第一列像素。每条 `.split-handle` 都有自己的合成图层（`will-change: transform; transform: translateZ(0)`）。
- 面板标题栏的 Settings 下拉：Split（上下 / 左右）和添加 Explorer / Filer / Sender / Session 标签（已打开的忽略）。Hide 即销毁面板。下拉用 `MenuButton` 的 `menuClassName="panel-settings-menu"`，最小宽度 132px（普通下拉 180px）；在本面板打开的视图打勾，不再显示 “In another panel” 提示。
- **拖动标签**（`src/lib/ui/tabDrag.ts`）：标签栏标 `data-tab-strip`（id）和 `data-tab-group`（`panel` / `terminal`），竖排列表加 `data-tab-axis="y"`；每个标签标 `data-tab-key`。标签的 `onPointerDown` 调 `startTabDrag`，移动 5px 后才算拖动，所以单击、双击、右键不受影响；关闭按钮（`data-tab-close`）和改名输入框不触发拖动。落点由 `elementFromPoint` 找到同组的标签栏，按标签中线算出“放在哪个标签之前”，结果是 `{strip, before}`；放回原位视为无变化。拖动过程中幽灵标签和落点标记是直接创建、改 `transform` / 位置的 DOM 节点，不经过 React，指针移动不会重渲染 App（react-best-practices 的 rerender-use-ref-transient-values）；只有放下时更新一次状态。拖动结束时吞掉随后的那次 click，避免误激活或误关闭。标签栏可滚动时，拖到边缘会自动滚动。
  - 面板标签：`layout.ts` 的 `moveTab(root, from, view, to, before)`；同一面板是重排，不同面板是移动（源面板按 closeTab 的规则激活相邻标签或变空），被拖的标签成为当前标签。移到别的面板时内容会重新挂载（Filer、Monitor 等按新面板重新加载）。
  - 终端标签：标签栏和 Session 面板同属 `terminal` 组，都用 `moveBefore` 调整 `terminalTabs` 的顺序（Session 面板有过滤时按 key 插入，不受过滤影响）。默认标题里的序号（`bash (2)`）按顺序重新编号。
- **终端全屏**：隐藏其他面板，内容和状态保留，布局不写入 `sessions.json`。分屏时只显示点击的那个窗格（`enterTerminalFull`：聚焦该窗格并打开 tmux 放大），退出时（按钮、切换窗口、最后一个标签关闭，都走 `leaveTerminalFull`）把那个窗口的放大状态恢复成进入前的样子（`fullRestore`）。进入和退出后 `refocusTerminal` 把键盘还给焦点窗格的终端（以前焦点留在按钮上，Ctrl+B 和输入都无效，直到点一下终端）。`TerminalView` 的 `active` 变成 false 时清掉自己的焦点状态：textarea 仍是焦点就 `terminal.blur()`，否则若 xterm 还带 `focus` 类就给 textarea 派发一个 `blur` 事件——WebKit 隐藏有焦点的元素时不发 blur（全屏会隐藏其他窗格），xterm 会一直以为自己有焦点，两个窗格同时显示实心光标。
- 隐藏元素统一用 `[hidden]{display:none!important}`，因为显式 `display` 会盖过 `hidden` 属性。

### Explorer 与 Session 面板

- 会话树（`components/sessions/SessionTree.tsx`）：文件夹无限嵌套，可拖动排序 / 移入；文件夹不能拖进自己或子文件夹，Esc 取消拖动。
- **每种面板视图在一个布局里只开一个**：`layout.ts` 的 `openTab(root, leafId, view)` 先用 `panelOf(root, view)` 找到它已经打开的面板，在那里 `closeTab`，再加到目标面板；拖动用 `moveTab`，本来就是移动。读取保存的布局时 `uniquePanels` 去掉重复（按树的顺序保留第一个，留空的面板变成 empty）。面板 Settings 菜单只在本面板打开时打勾（菜单 `panel-settings-menu`，最小宽度 132px）。
- Explorer 的折叠状态按面板 id 记录（`ExplorerDoc { panels }`，`explorerFolds`、`toggleFolder(panel, id)`），Expand / Collapse all 只作用于当前面板；Explorer 移到别的面板时 `carryPanelState` 把状态带过去；关闭的面板、删除的文件夹会被清理。
- Explorer 的筛选框和 NEW 按钮在同一行（`.session-quickbar` 里的 `input.session-filter`）。Explorer 里没有重连（顶栏、会话行的悬停按钮、右键菜单都没有）；重连在终端标签的右键菜单、终端右键菜单、窗格工具栏的 ↻ 和 Session 菜单里，全部只重连当前这一个标签（`reconnectTab`：`tabEpochs[tab.id]` 加一，`TerminalView` 的 `reconnectToken` 变化时（真实模式）`stop()` 再 `start()`；SSH 的共享连接保留，在它上面开新通道，断了就重新连）。以前按会话计数（`epochs[connection.id]`），分屏里同一会话的所有窗格一起重连，用户要求只重连当前窗格（第 34、35 轮），按会话重连的代码已删除。终端右键菜单的窗格部分（`paneMenuItems`）只有 Split Left / Right、Split Top / Bottom；Move Tab to New Pane 在标签右键菜单，Zoom Pane / Close Pane 在窗格 ⋮ 菜单，另有 Ctrl+B `!` / `z` / `x`（第 35 轮按用户要求从终端右键菜单移除）。每个 Explorer 面板有自己的 “Filter sessions” 筛选文字（`App.tsx` 的 `filters: Record<panelId, string>`），不写入配置。
- “所在文件夹”下拉框是树形组件（`components/sessions/FolderTreeSelect.tsx`），支持 ↑ ↓ Home End → ← Enter Esc。
- Session 面板（`components/sessions/SessionsPanel.tsx`）管理打开的终端标签；提示用左标题、右内容的表格（`TooltipLayer`）。
- **Agent CLI 状态**（第 45 轮）：识别和判断全在 Rust（`src-rust/src/agents/`），界面只接收和显示。
  - 数据来源：`Backend::new` 在 UI 的事件出口前面加一层 `agents::Tap`，每个 `terminal.data` 顺路喂给该终端的屏幕模型（`vt100` crate，不保留回滚），`terminal.start` 先 `agents.open`（第一段输出也不漏），`terminal.resize` 同步尺寸，`terminal.exit` / `terminal.close` / `connection.disconnect` 时 `agents.close`。另外记下程序最后发的 OSC 0/2 标题和 OSC 9 内容（进度 `4;…`）：OSC 0/2 由 vt100 的 `set_window_title` 交来；标题里带 `;` 时 vt100 把它拆成多个参数、不调 `set_window_title`，这种在 `unhandled_osc` 里把第一个 `;` 之后的全部拼回去；空标题清空；只设图标名的 OSC 1 不算。去掉控制字符，最长 256 字符。agent 换掉（或退出）时清空旧的标题和进度，新 agent 不会继承上一个的（`clear_retained`）。规则看的是**可见的那几行纯文本**。
  - 是哪个 agent：本地终端用 PTY 主端的副本 `tcgetpgrp` 取前台进程组（`process.rs`）：组长是终端自己的 shell → 没有 agent；否则读组长的命令行（Linux `/proc/<pid>/cmdline`，macOS/BSD 用 sysinfo），名字查别名表（`claude`/`claude-code`、`codex`、`opencode`/`opencode2`、`copilot`/`ghcs`、`cursor-agent`、`agy`/`antigravity-cli`、`kiro-cli`、`hermes-agent`、`kilo-code`…，去掉 `.exe/.js` 等后缀），`node`/`bun`/`python`/`sh -c` 包装时看脚本参数（跳过带值的运行时选项 `-r`/`--require`/`--import`/`--loader`/`--experimental-loader`/`--inspect-port`/`-W`/`-X`）或 `node_modules/<包名>`；包名不是 agent 名的按入口脚本认（Pi：`@earendil-works/pi-coding-agent/dist/cli.js` 或 `dist/bundle/cli.js`）；cursor-agent 自带的 Node（`…/cursor-agent/versions/<版本>/node` 运行同目录的 `index.js`）；Hermes 安装器的启动方式 `python -I -c "…import hermes_bootstrap…from hermes_cli.main import main…"`（它的 `--run-module` / `--print-runtime-command` 辅助模式不算）；带目录的路径是符号链接时再看它指向的文件名（`~/bin/cc` → `claude`）。组长认不出再看同组的其他进程。SSH / Telnet / 串口 / Windows，或本地 shell 里又 `ssh` 出去时，用 `identify.toml` 的**屏幕特征**（只看屏幕底部：Claude 的 ❯ 输入框 + 底部提示、Codex 的 `›` 输入行 + `context left`、opencode 的 `ctrl+p commands`、Devin 的 `guide devin while it works` / `❭ Ask Devin to build`、Kiro 的 `kiro is working · type to steer`），或 agent 自己写进**窗口标题**的名字（Amp `… - amp - …`、Grok `grok` / `… - grok`、Kiro `◐ kiro: …`；特征都取自清单里的规则，只用带 agent 名字的，`esc to cancel` 这类通用提示不用来认 agent；Debian / Ubuntu 默认的 PS1 等在提示符处设标题的 shell 会让它在 agent 退出后消失）；靠屏幕认出的 agent 连续 3 秒既没有特征也没有命中它自己的屏幕规则就算退出，全屏 agent 离开备用屏幕时立即退出。
  - 什么状态：每个 agent 一个 TOML 清单（`manifests/*.toml`，22 个，`include_str!` 打包）。规则 = 状态 + 优先级 + 区域 + 条件门：`contains`（全部出现，不分大小写）、`regex`（全部匹配区域）、`line_regex`（每个至少匹配一行）、嵌套 `all` / `any` / `not`。区域有 `whole_recent`、`bottom_lines(n)`、`bottom_non_empty_lines(n)`、`top_non_empty_lines(n)`、`osc_title`、`osc_progress`、Claude 式输入框（倒数第二条 `───` 横线到下一条之间）`prompt_box_body` / `above_prompt_box` / `last_non_empty_above_prompt_box` / `after_last_horizontal_rule`、Codex 式 `›` 输入行的几个区域。所有规则都算一遍，命中的取优先级最高的（相同取先出现的）；都不命中 = 空闲；`skip_state_update`（如查看完整记录的界面）保持原状态。引擎在 `manifest.rs`，带区域 / 规则语义的测试。
  - 节奏和去抖：后台线程每 100ms 看一次有变化的屏幕，本地前台进程每 500ms 查一次。工作中 → 普通空闲（没有可见的输入框）要连续 3 次确认（最多等 700ms），避免两步之间短暂没有转圈时闪成空闲。一轮工作结束时如果用户没在看这个终端，状态是**已完成**（done），看到后变空闲：界面用 `agent.focus {sessionId | null}` 告诉后端当前看的是哪个终端（活动标签，窗口失去焦点或隐藏时为 null）。
  - 推送：只在 agent 或状态变化时发 `agent.state {sessionId, agent, name, state}`（`agent: null` = 没有 agent 了）。前端 `lib/terminal/agentStatus.ts` 按标签 id（`sessionId` 的 `#` 之前）保存，`useAgentStatuses()` 给 Session 面板；有 agent 的标签在原来那一行（标题、user@host / shell、连接圆点，不变）下面多一行 “图标 名称 ……… 状态标签”（第 46 轮按用户要求独占一行；`.open-tab.has-agent` 换行显示，`.open-tab-agent` 占满第二行，图标与标签图标同列，名称与标题对齐；面板窄时截掉的是名称，状态保持完整）。第一行的 user@host / shell（`.open-tab-detail`）右对齐，紧挨连接圆点。
  - 版式（第 50 轮，用户要求只调行高、间距、对齐、字号层次，左侧当前标签色条、悬停效果、空状态不动）：`.sessions-pane` 定义 `--open-tab-line: 28px`（每行第一行的高度，有没有 agent 都一样，所以标题、详情、圆点整列对齐）和 `--open-tab-small`（`--ui-font-small` 减 1px）。字号三级：标题用界面字号；agent 名称（`--muted`）和 user@host / shell（`--faint`，`top: 1px` 让它和标题基线对齐）用 `--open-tab-small`。agent 行高 18px，带 agent 的行底部留 6px。状态是 Metro 风格的方块标签 `.open-tab-agent-state`（16px 高、无圆角、大写、600 字重、字号再小 1px），右边与连接圆点对齐；颜色用 `colors.css` 的 `--agent-*`：工作中琥珀色底 + 琥珀字，等待输入实心 `--danger` 红块 + 白字，已完成绿色底 + 绿字，空闲 / 未知只有 1px `--line` 边框 + `--muted` 字。原来 ` · ` 分隔的写法按用户 “符合 Metro 主题” 的要求换成了标签。“N OPEN TABS” 计数大写、0.08em 字距。图标在 `Icon.tsx` 的统一线条图标里（16×16、1.3px、方头）：`agent` 是直边四角星加一个小十字星（工作中 / 空闲），`agent-input` 是实心对话框、镂空 “!”（等待输入；线框加 “!” 在小尺寸下会连在一起），`agent-done` 是对勾（已完成）。第 46 轮按用户要求缩小：显示为 11px（标签图标 14px），所在列宽不变、仍与标签图标同列，线宽加到 1.55 让缩小后粗细不变。动效：工作中四角星每次转 90° 后停一下（同时略缩小再恢复），小星在两次转动之间闪烁，琥珀色；等待输入对话框每 2.8 秒左右轻轻抖一下，红色；已完成时对勾画出一次（`stroke-dashoffset`），绿色；空闲静止、灰色、没有小星。`prefers-reduced-motion` 时都不动。提示表格多一行 Agent。
  - 只看终端输出：状态全部来自屏幕文字和 OSC 标题 / 进度（第 51 轮用户要求“不要自报功能，全部由 OSC 或输出信息解析”），**没有**插件 / hook / socket 自报，不往 agent 的配置目录里装东西，也不给 shell 加环境变量。Amp、Grok、Hermes、Kiro 主要靠标题 / 进度判断状态（Amp 标题开头是盲文转圈 → 工作中，`Plugin confirmation needed` → 等待输入，否则空闲；Grok 同理加 OSC 9 `4;1;-1` / `4;0;0`；Hermes `⏳` / `⚠` / `✓`；Kiro 转圈标题或 `4;3;`）。Cline 的清单有一条兜底规则（`whole_recent` 匹配任意文字 → 工作中），它不算“agent 还在”的证据，Cline 也没有屏幕特征，只按进程识别。第 51 轮按用户给的 17 个 agent 逐个检查过，测试 `wrapped_launchers`、`self_naming_signatures`、`state_from_osc`。
- 覆盖：`~/.metroterm/agents/<agent>.toml`（如 `claude.toml`）替换内置清单，`~/.metroterm/agents/identify.toml` 替换屏幕特征，启动时读一次，解析失败时写日志并用内置的。
- 关闭标签的所有途径都经过 `closeTabs` → `closeConfirm` → `doCloseTabs`。

### MCP 服务（agent CLI 通讯，第 52 轮）

MetroTerm 把终端和 agent 的查询、操作做成 MCP 服务，任何支持 MCP 的 agent CLI 不装东西就能用：列出 agent、读屏幕、发提示并等待、发按键、等输出、打开终端，以及窗口 / 分屏操作（第 54 轮）。

- 代码：`src-rust/src/mcp/`——`mod.rs`（配置、`Hub`、axum 路由、守卫、JSON-RPC）、`tools/`（`definitions.rs` 工具定义和 schema、`terminals.rs` 终端工具、`ui.rs` 窗口 / 窗格 / 标签工具、`mod.rs` 分发和错误码）、`keys.rs`（按键名 → 字节，含应用光标模式）、`caller.rs`（调用方 tty）。`server` / `desktop` 两个 feature 都带上。
- 生命周期：全局一个 `Hub`，自带 2 线程的 `mcp` tokio runtime。`Backend::new` 调 `mcp::register`（第一个后端读 settings.json 的 `"mcp"` 启动服务）；`mcp.configure {enabled, port, token, allowInput}` 立即生效并返回状态，`mcp.status` 返回 `{enabled, running, url, port, error, clients}`。令牌为空不启动（error = "No access token"），端口被占用写进 `error`。Web 模式（`metroterm web`）每个 WebSocket 一个后端，后来的后端终端 id 带前缀（`2/tab-3#1`）。
- 传输：`GET /sse` 先发 `endpoint` 事件（`/messages?sessionId=…`，用 `?token=` 认证的会把令牌带上），`POST /messages` 返回 202，结果从 SSE 流回；`POST /mcp` 是 Streamable HTTP（`initialize` 返回 `mcp-session-id`），`GET /` 是说明。
- 安全：只绑 `127.0.0.1`；Host 必须是回环地址（防 DNS rebinding）；带 `Origin` 的请求 403（浏览器页面不能调）；令牌用 `Authorization: Bearer` 或 `?token=`，常量时间比较，错了 401。
- 工具：

| 工具 | 作用 | 需要“允许输入” |
| --- | --- | --- |
| `list_terminals` | 所有标签（与 Session 面板一致，按界面顺序：窗口 → 窗格 → 标签栏顺序）：id、会话名称、`tab_name`（标签上显示的名字）、`window` / `pane`、传输方式、是否正在看、是否 `self`、agent 和状态、`connected`（会话已结束或还没启动的标签为 false，id 是标签本身如 `tab-5`） | 否 |
| `read_terminal` | `visible`（当前屏幕）或 `recent`（最近 N 行，默认 120，最多 2000） | 否 |
| `wait_for_output` | 等 `match`（字面）或 `regex` 出现，带超时 | 否 |
| `agent_wait` | 等 agent 进入指定状态（默认 idle / done / blocked） | 否 |
| `focus_terminal` | 在界面里切到这个终端（它的窗口显示出来、窗格获得焦点） | 否 |
| `list_windows` | 窗口（`shown` = 正在显示）、分屏树 `layout`（`left_right` / `top_bottom` + 第一侧 `ratio`）、窗格（id、字母、`focused`）和其中的标签（终端 id——还没启动时为 null——名称、`shown`、`self`），`zoomed` | 否 |
| `focus_window` | 显示某个窗口 | 否 |
| `send_text` | 输入文字，可选回车；开了括号粘贴模式时用括号粘贴 | 是 |
| `send_keys` | 按键名（`enter`、`esc`、`ctrl+c`、`up`、`f5`、`+` …），全部校验通过才写 | 是 |
| `agent_prompt` | 给 agent 发提示：blocked 时拒绝（`agent_blocked`），括号粘贴 + 300ms 后回车，5 秒内没进入 working / blocked 报 `agent_prompt_stalled`，再等它做完；默认 600 秒，最多 1 小时 | 是 |
| `open_terminal` | 打开保存的会话（id 或名称，默认第一个本机会话）的新标签，可指定 `window` / `pane`（默认显示中窗口的焦点窗格），带 `terminal` 则克隆该标签（同一会话、同一窗格），默认后台打开 | 是 |
| `split_pane` | 拆分窗格（`pane`、`terminal` 所在窗格，默认显示中窗口的焦点窗格），新窗格在 `direction`（right / down / left / up）一侧，开一个 `session` 的新终端（默认与被拆窗格显示的标签同一会话），等 shell 起来、可执行 `command` | 是 |
| `resize_pane` | 把窗格的边界往 left / right / up / down 移 `amount`（所在分割的比例，默认 0.1），同方向没有分割时 `no_split` | 是 |
| `zoom_pane` | `zoom` true：窗口只显示这个窗格（并获得焦点）；false：恢复 | 是 |
| `move_terminal` | 把标签连同会话移到 `pane`、`window`（其焦点窗格），带 `split` 则移进目标窗格旁新拆的窗格（只给 `split` = 从自己所在窗格拆出）；`before`（放到那个标签前面，即它所在的窗格）/ `last`（目标窗格末尾）调整顺序，只在同一窗格里调整顺序时各窗格显示的标签不变 | 是 |
| `rename_terminal` | 标签改名（≤ 80 字符），`name` 为空 / 不给则恢复默认名，返回显示的名字 | 是 |
| `reconnect_terminal` | 重新启动标签的会话（菜单的 Reconnect，`tabEpochs` + 1），等新会话（`{tab}#k+1`，排除旧的）起来、可执行 `command`，返回新的终端 id | 是 |
| `disconnect_terminal` | 结束会话、保留标签（菜单的 Disconnect）；没连接时 `not_connected`；agent 打开的直接断开，其余弹确认框 | 是 |
| `close_terminal` / `close_pane` / `close_window` | 关闭；agent 打开的直接关，其余弹确认框（取消 / 120 秒超时 → `cancelled`，已有确认框 → `busy`）；不能关自己所在的（`own_terminal`）和最后一个窗口（`last_window`） | 是 |
| `new_window` | 新窗口（固定框架布局 + 一个 `session` 终端，可起名、可执行 `command`），默认不切过去 | 是 |
| `rename_window` | 窗口改名（≤ 40 字符） | 是 |

- 窗口、窗格、标签只存在于界面里，相关工具都走界面（第 54 轮把原来的 `mcp.open` / `mcp.focus` 合并成一个通用请求）：后端发 `mcp.ui {requestId, action, params}`（action：`layout`、`focus`、`focus_window`、`open`、`split`、`new_window`、`resize`、`zoom`、`move`、`rename_window`、`rename`、`reconnect`、`disconnect`、`close`、`close_pane`、`close_window`），界面回 `mcp.reply {requestId, result | error, code}`；一般等 10 秒，关闭类要等用户回答，等 130 秒。
  - 后端 `tools/ui.rs`：`scope()` 把参数换成界面自己的 id——`terminal` / `before` / `terminals` 换成标签 id（session id `#` 之前；会话已结束的标签也行，由界面检查），`window` / `pane` 去掉 `2/` 前缀（几个 id 必须属于同一个浏览器客户端），并加上 `selfTab`（调用方所在标签）；`globalize()` 把回答里的 `terminal`（标签 → 它最新的会话 `current_session()` 的终端 id，没有会话时为标签本身并加 `connected: false`，调用方的加 `self: true`）、`window` / `pane` / `focused_pane` 换回 MCP id。`list_windows` 问每个后端（每个浏览器客户端）再合并。新建类（open / split / new_window）拿到标签 id 后和以前的 `open_terminal` 一样：等 `{tabId}#` 开头的终端出现、shell 输出安静 600ms，再输入 `command`。
  - 界面 `src/lib/workspace/mcpUi.ts`：纯函数，在 `{windows, tabs, shown}` 上做一步（任何窗口，不只是显示中的），抛 `UiError(code)`；App 的 `mcpAction` 调它、`applyUi` 一次写入 windows / allTabs / 显示窗口（同时更新 ref，紧接着的下一个请求看到新状态）。id：窗口 `win-1`，窗格 `win-1:p-2`（窗口 + tmux 树里的窗格 id）。新标签都进 `backgroundStarts`（`TerminalView startHidden` 让隐藏标签按 120×32 直接启动，平时隐藏标签要等显示后才启动）和 `mcpOpened`（关闭时不用确认）。
  - 焦点：不带 `focus` 时不改显示中的窗口和焦点窗格（新窗格显示自己的标签，`move_terminal` 移到焦点窗格时才会变成选中标签）。拆分清除 zoom。
  - 关闭 / 断开确认是单独的 MCP 对话框（`mcpConfirm`，同一时间一个，`mcpConfirmed()`），按确认时按当时的状态重新计算。
  - 第 55 轮（Session 面板的标签操作）：`resolve()` 找不到某个会话时按标签找它最新的会话，所以重连后旧的终端 id（`tab-3#1`）和标签 id（`tab-3`）都还能用；`list_terminals` 会问每个界面要 `layout`（3 秒），补上 `tab_name` / `window` / `pane` 并按界面顺序排列。
- 调用方识别（Linux，其他系统不识别）：从 TCP 连接对端端口在 `/proc/net/tcp` 找到 socket inode → 进程 → 它的控制终端，和本机终端 PTY 的从端设备比；对上的标记 `self: true`，输入类工具对它返回 `own_terminal`（防止 agent 给自己输入造成回环）。
- 错误：工具失败返回 `isError: true`，`structuredContent: {code, message}`（`terminal_not_found`、`invalid_key`、`input_disabled`、`own_terminal`、`agent_not_found`、`agent_blocked`、`agent_prompt_stalled`、`timeout`、`window_not_found`、`pane_not_found`、`session_not_found`、`no_split`、`last_window`、`cancelled`、`busy`、`no_answer`、`not_connected` …），给 agent 看的错误文字是英文。
- 设置界面（`SettingsDialog`）：MCP SERVER 的 OFF / ON、访问令牌（COPY、NEW，`newMcpToken()`）、端口（`MCP_PORT_RANGE`）、允许输入，CLI 选择（Claude Code / Codex / Gemini CLI / JSON）给出配置片段；状态说明来自 `mcp.status`。App 在 Save 时有变化就调 `mcp.configure`，结果写进活动日志。设置保存在 settings.json 的 `"mcp"`（`sanitizeMcp`：令牌 `[A-Za-z0-9._~-]{16,128}`）。
- 和第 51 轮的约束不冲突：agent **状态**仍然只由 OSC / 屏幕解析得出，MCP 没有“自报状态”的工具。

### Filer

- 跟随当前终端标签；本地会话浏览本机，SSH 会话通过 SFTP 浏览远程并共用 SSH 连接。
- **启动 / 切换时不闪字**：在线的 Filer 一开始就是加载中（`useState(live)`），列出之前页脚不会先显示 “0 items”；列表区的 “Connecting…” 和页脚的 “Loading…” 带 `.is-pending`，加载超过 1 s 才淡入，快的列出不会让它们闪一下。
- 表头 `.filer-head` 是 `.filer-list` 滚动容器里的 sticky 行（z-index 1），列宽 CSS 变量 `--filer-cols`；列名靠左，排序箭头 8px、在列名右侧靠近分隔竖线；**Size 和 Date Modified 的列名与数值都右对齐**；排序箭头在所有列都放在列的最后（分隔竖线旁），所以这两列排序时列名紧挨在箭头左边，未排序时列名右端与数值右端对齐。分隔竖线在 12px 列间距的正中（`.filer-col-resizer` 必须 `margin: 0`，否则 `.filer-list i` 给图标的 8px 间距会把竖线拉进本列，右对齐的文字会压在线上）。列宽最小：名称 80px、其它 40px。
- 列宽、排序、自动跳转写入 `sessions.json` 的 `filer`，松开鼠标 / 双击 / 改排序时立即写入。
- 搜索当前目录：名称包含即匹配，匹配部分用中性灰底（深色 `rgba(255,255,255,.17)`，浅色 `rgba(0,0,0,.085)`）。
- **自动跳转原理**：本地终端读 `/proc/<pid>/cwd`（优先前台进程；macOS 用 `lsof`；Windows 见下）。SSH 终端启动 shell 时附带 `LC_METROTERM_SESSION`（多数服务器 `AcceptEnv LANG LC_*`），之后在同一条连接上开临时 exec 通道，按这个变量找到 shell 并读 `/proc/<pid>/cwd`，不往终端输入任何东西。也识别 OSC 7 和 OSC 9;9（ConEmu / Windows Terminal 的当前目录序列）。只在回车后输出停下约 0.25 秒时查询一次（持续输出时最多每 3 秒一次）。
- **Windows 上的自动跳转 / Terminal folder**（`src-rust/src/terminal/wincwd.rs`）：Windows 没有 /proc，进程的当前目录在进程自己的内存里——`NtQueryInformationProcess` 取 PEB，`ReadProcessMemory` 读 `ProcessParameters.CurrentDirectory`（Process Explorer 显示的 “Current directory” 就是它，同一用户的进程都能读）。先用 Toolhelp 快照沿“最新启动、仍在运行的子进程”往下找（终端里又开的 cmd / pwsh；按父进程号**和**启动时间匹配，防止进程号被复用；跳过 conhost / OpenConsole），读不到再读 shell 自己。cmd 的 `cd` 和 Git Bash（MSYS 直接改 PEB）会改进程目录；**PowerShell 的 `cd`（Set-Location）不会**，所以本地 pwsh / powershell 启动时带 `-NoExit -Command <钩子>`（`terminal/mod.rs` 的 `POWERSHELL_HOOK`，在用户 profile 之后执行，包住 profile 里的 prompt，oh-my-posh / starship 照常）：每次提示符把 `[Environment]::CurrentDirectory` 设为当前位置（只限 FileSystem，`HKLM:` 之类不管），并在提示符前输出 OSC 9;9。钩子写成一行、不含双引号：行内命令不受脚本执行策略限制，参数原样传给 PowerShell。WSL 里的 shell 不回答（它的 Windows 目录与 Linux 里的位置无关）。路径统一成 Filer 的写法 `C:/Users/me`（盘符根目录 `C:/`）；前端 `filerPath()` 也把 OSC 7 的 `file:///C:/x`（以前变成 `/C:/x`，`fs.list` 打不开）和 OSC 9;9 的 `C:\x\` 转成同样的形式。
- 复制路径到终端：含特殊字符时单引号括起（`'/tmp/my dir/it'\''s'`）。
- Owner / Group：本地读 `/etc/passwd`、`/etc/group`，SFTP 读服务器上的这两个文件（取不到时显示数字 ID）。
- 错误提示不带重试，25 秒后自动关闭（传输失败另见传输批次，可重试）。
- **多选**：`selected` 是主项（键盘焦点、Enter / F2、Shift+↑↓ 移动的那一项），`pickedPaths` 是选中的路径，`anchorRef` 是 Shift 范围的起点（最近一次不带 Shift 的点击）。`chosen` = 当前列表里被选中的项（列表顺序），没有时为主项；删除（`Dialog.files`）、移动 / 复制（`destination.files`，`FilerDestinationDialog` 收 `files`，对每一项检查同名 / 放进自身）、复制路径、路径到终端、下载（`downloadMany`：桌面版选一次文件夹，浏览器每个文件一次下载）都作用于 `chosen`。在选区内右键保留选区，选区外右键只选那一项。选中项只用背景色表示，不加边框 / 描边（主项也没有单独标记，列表按钮的 focus-visible 描边也去掉了）。不在当前列表里的项（换了目录、被搜索过滤掉）不计入。
- **移动到… / 复制到…**（右键菜单，在 Delete 之后）：`components/filer/FilerDestinationDialog.tsx` 选目标目录（`fs.list` 只列文件夹，路径框回车进入、再回车提交，↑ 上一级）。前端先拦截：目标是自身或在自身里面（`isInside`）、已在该目录、该目录里已有同名项（文件和文件夹都算）。后端 `fs.copy` / `fs.move` 再检查一遍（空路径、`/`、自身内部、目标已存在都拒绝）。
  - 复制 `Fs::copy_tree` 递归：链接按链接复制，权限照搬，目录权限最后设置（只读目录也能先写入内容）；新文件用 create_new / SFTP `CREATE|EXCLUDE`，绝不覆盖。
  - 移动用 rename；本机跨文件系统（EXDEV）时退回复制再删除。SFTP 的 symlink 参数顺序 OpenSSH 与规范相反，`sftp_symlink` 两种顺序都试并用 `read_link` 验证。
  - 进度和结果同样走传输批次（见下一条），遇到第一个失败就停，Retry 继续剩下的；复制后保留原选中项。
- **传输批次**（`components/filer/FilerTransfers.tsx`）：上传（浏览器选择 / 拖入的 File、桌面版本机路径，文件夹先遍历：建好目录，里面每个文件是一项，名称是相对路径）、下载、移动、复制，每次操作是一个批次 `useTransfers().run(direction, folder, jobs)`，文件逐个执行，`transferId` 就是该项的 id，后端的 `transfer.progress` 事件按 id 更新进度。
  - `TransferPanel` 显示在文件列表和底栏之间：标题（“正在上传 3/4” → “已上传 4 个文件” / “上传失败 · 3 个完成 · 1 个失败”）、总进度条（所有大小已知时按字节，否则按文件数）、字节数（面板窄于 340px 时隐藏）；多个文件时可展开逐项列表（等待中 / 转圈 + 百分比 / ✓ 大小 / ✕ 失败原因 / 已取消）。
  - 运行中可 **Cancel**（跳过还没开始的文件，正在传的那个传完）；全部成功的通知 4 秒后自动关闭，有失败或取消的一直保留，带 **Retry**（只重跑失败和取消的项）和 ×。最多同时保留 4 个批次。
  - 每个失败的文件仍写一条日志（`upload failed: 名称 · 原因`）。

### SSH

- 纯 Rust（`russh`），不依赖系统 `ssh`。同一会话配置的多个终端和 Filer 共用一条连接，各开一个通道。
- 认证顺序同 OpenSSH：agent → 私钥（指定文件或 `~/.ssh/id_ed25519`、`id_ecdsa`、`id_rsa`）→ 密码 → keyboard-interactive。
- 会话对话框里 PASSWORD / Remember password 只在认证方式为 **Password** 时显示（`usesPassword = auth === 'password'`）；Auto 不显示，但在 AUTH 提示里记住的密码保存会话时保留。
- Remember password：AES-256-GCM 加密（密钥由 machine-id、主目录和 uid 派生，不存密钥文件），存入 `savedPassword`；登录成功后才保存，被拒绝时改为询问。换机器 / 用户无法解密。WebCrypto 的 `BufferSource` 需要 `Uint8Array<ArrayBuffer>` 类型。
- Host key：先查 `~/.ssh/known_hosts`，再查 `~/.metroterm/known_hosts`；Key 变化直接拒绝。

### Telnet、TCP、串口与代理

- `Transport` 枚举（Rust `remote/ssh.rs`、TS `types.ts`）：`local`、`ssh`、`telnet`、`tcp`、`serial`。会话配置多了 `noProxy`、`localEcho`、`serial`（`device`、`baudRate`、`dataBits`、`parity`、`stopBits`、`flowControl`）。
- `terminal/mod.rs` 的 `Handle::Stream` 只持有一个输入通道（`stream::Input::Data / Resize / Close`）；读写在 `terminal/stream.rs` 的任务 / 线程里。在线 / 离线状态和本地 shell 一样按打开的终端数计算（`local_counts`）。
- Telnet：`Telnet` 结构是纯函数式的协商器（字节进 → 数据 + 回应出，有单元测试）。接受服务器的 ECHO / SGA / BINARY，自己提供 NAWS（窗口大小，0xFF 转义）和 TTYPE（`XTERM-256COLOR`）；其他选项拒绝；状态不变时不回应，避免协商循环。非二进制模式下回车发送为 CR NUL，收到的 CR NUL 还原成 CR。
- 串口：`serialport` 关闭默认 feature（不依赖 libudev，Linux 上通过 /sys 枚举端口）；读线程 100ms 超时轮询关闭标志，写线程从通道取数据。
- 代理：`net::open(route, host, port)`，SSH / Telnet / TCP 共用；`ConnectionSpec::route()`（`remote/ssh.rs`）决定路线：`noProxy` → 直连；会话自己的 `proxy`（`ProxySpec`：`type` socks5 / http / jump）；都没有时用 `settings.json` 的全局 `proxy`（后端每次连接时读取，所以 UI 必须把 `proxy`、`log`、`appearance` 一起写回 settings.json）。
- **跳板机**（`type: "jump"`）：会话里存的是跳板机会话 id 的有序列表（`proxy.jumps`，按连接顺序；更早的 0.0.1 版本写的单个 `proxy.jump` 读成 `[jump]`，`types.ts` 的 `jumpHostsOf`）。UI 发送时（`lib/platform/backend.ts` 的 `wireProxy` / `toSpec`）把列表换成嵌套的配置，后端协议不变：最后一个跳板机的 `proxy.jump` 是前一个跳板机，依此类推；第一个跳板机带它自己的路线（它的代理 / 跳板机 / 全局代理，递归），后面的跳板机忽略自己的路线、一律经前一个连接（和 `ssh -J a,b` 一样）。整条链最多 `MAX_JUMPS = 8` 层；某个跳板机不是 SSH、已不存在、重复或形成循环时发 `null`（后端报错，不会悄悄跳过一层）。SSH 连接池按会话 id 复用连接：链里的某个跳板机已经连着时直接用那条连接。后端 `route()` 拒绝 `null`、非 SSH 或指向自己的跳板机（报错提示去 Session Settings → PROXY 改）；`net::open` 通过 SSH 连接池（`SshPool::get`，和普通 SSH 会话共用连接、照常询问密码和 host key）连上跳板机，再开 `direct-tcpip` 通道连目标，得到的通道当作字节流（`net::Stream`）。因为这里经 `pool.get` 递归，`open` 返回显式的 `Pin<Box<dyn Future + Send>>`（`async fn` 里再 `Box::pin` 时 rustc 证明不了 `Send`）。
- Session Settings（`NewConnectionDialog.tsx`）的 PROXY 下拉：“Session → Proxy…”（全局，括号里是当前全局设置）、No proxy、SOCKS5、HTTP CONNECT（下面出现 PROXY HOST / PORT / USER / PASSWORD）、JUMP HOST（和 SOCKS5 / HTTP CONNECT 一样大写；下面是 JUMP HOSTS (IN ORDER)：`.jump-list` 按顺序列出已选的跳板机，每行是序号、名称、`user@host`、↑ / ↓ / × 按钮（`aria-label` Move up / Move down / Remove），已不存在或会经过本会话的显示为红色、保存时要求移除；下面的 `Add jump host` 下拉添加下一个，只列其他 SSH 会话，去掉已选的和自己的路线经过本会话的；没有可选会话时显示提示）。SOCKS5 用域名方式（ATYP 3）；HTTP CONNECT 逐字节读响应头，不多读隧道数据。总超时 15 秒。
- 软件日志：`applog::init()` 在 `Backend::new` 里执行一次，读取 `settings.json` 的 `log`。info 级别只记录 metroterm 自己和 UI（`ui` target）的记录，依赖库（russh、tokio…）的 info 以下只有 Debug / Trace 时才写。RPC 失败统一在 `Backend::dispatch` 里记 warn。

### Sender

- Line（逐行加回车，Interval 单位秒，是重复之间的间隔）/ Char（逐字符，Interval 单位毫秒、最小 20，每个间隔发一个字符，换行发回车）；Count 重复次数；■ Stop 或 Esc 取消未发送的内容。
- Targets：Current Session / Select Session / All Sessions。Select Session 时 `.sender-editor` 加 `has-targets`，右侧第三列 `.sender-targets` 列出打开的终端标签（`tabTitle` 由 App 传入），勾选状态是标签 id 列表，发送时忽略已关闭的标签。
- 拖入文件：`.sender-editor` 标 `data-file-drop="sender"`，放下时把 `shellQuote` 过的路径（空格分隔）插入到 textarea 光标处（替换选区），再把光标放到插入内容之后。
- 工具栏变窄时换行（`flex-wrap`），不隐藏控件。
- **行号对齐**：行号栏和 textarea 用同一个上内边距（`.sender-editor` 的 `--sender-pad-y: 5px`）、同样的字体 / 字号 / 行高，所以每行的行框完全重合；滚动时移动内层 `.sender-gutter-lines` 的 `transform: translateY(-scrollTop)`（`syncGutter`，文字变化后也同步一次）。以前用行号栏自己的 `scrollTop` 跟随，行号栏没有滚动条、可滚动高度不同，滚到底部时会停在不同位置；上内边距单独微调（第 30 轮 +2px）则让行号整体低了 2–3px。Chromium 和 WebKit 里两列数字的墨迹行完全相同（包括滚动后）。

### Monitor

- `components/monitor/MonitorPanel.tsx` 跟随当前终端标签的会话（与 Filer 相同），按选定间隔调用 `monitor.sample`；用 `setTimeout` 链，上一次返回后才排下一次。面板不可见（`offsetParent === null` 或 `document.hidden`）时不采样，每 0.5 s 检查一次。换会话时清空曲线。
- **第一次采样不显示**：一个主机的第一次采样没有速率（CPU %、每核柱、网络、Disk I/O、进程 CPU 都是空的），面板若先显示它，第二次采样时 Disk I/O 行出现、核心柱出现，下面的行整体下移、进程顺序重排。所以 `cpu === null` 的第一次结果不显示，`PRIME_DELAY`（0.4 s）后再采一次，面板直接以完整内容出现（之后按正常间隔）。每个采样循环（切换会话、暂停 / 继续、改间隔）最多跳过一次，后端的累计值还在时第一次就有速率，不会跳过。
- 等待中的文字（“Reading …”、未连接的提示）带 `.is-pending`（`styles/base.css`：延迟 1 s 再用 0.2 s 淡入），等待短时不出现，面板从空白直接变成内容；不支持的会话类型的说明是固定的，不延迟。
- 本机（`src-rust/src/monitor/local.rs`）：`sysinfo` 0.36（`default-features = false`，只开 `system`、`disk`、`network`、`user`），三个平台都可用。`System` 等对象保存在 `Monitor` 里，CPU / 网络 / 磁盘速率由 sysinfo 两次刷新的差值给出。Linux 上 sysinfo 把线程也列成任务，按 `thread_kind() == Userland` 过滤掉，进程数与 `ps -e` 一致。
- SSH（`src-rust/src/monitor/remote.rs`）：在会话已有的连接上开 exec 通道执行 `sh -s`，脚本从 stdin 发送（不受登录 shell 是 fish / csh 的影响，也不用转义）。输出按 `@name` 分段，10 s 超时。
  - Linux：`/proc/stat`（CPU，空闲 = idle + iowait）、`/proc/meminfo`（已用 = MemTotal − MemAvailable）、`/proc/net/dev`、`/proc/diskstats`（只计 `/sys/block` 里的整盘，跳过 loop / dm / md / zram 等；扇区按 512 字节）、`df -kP`、`/proc/<pid>/stat`。进程列表来自 `ps -eo pid,user,pcpu,rss,args`，名称取 `/proc/<pid>/stat` 的 comm（与 top 一致）。进程 CPU 用两次采样的 utime + stime 差值除以 `CLK_TCK`（`ps` 的 pcpu 是进程整个生命周期的平均值），第一次采样先用 `ps` 的结果。
  - macOS：`sysctl`（boottime、loadavg、hw.ncpu、hw.memsize、vm.swapusage）、`vm_stat`（已用 = 匿名页 − 可清除页 + wired + 压缩，与活动监视器的“已使用内存”一致）、`netstat -ibn` 的 `<Link#n>` 行、`ps -Ao pid,comm`（名称）和 `ps -Ao pid,user,%cpu,rss,args`。总 CPU 为所有进程 `%cpu` 之和除以核数；没有磁盘读写速率（显示为不提供而不是 0）。
  - 不统计回环和容器虚拟网卡（`lo`、`veth*`、`docker*`、`br-*`、`virbr*`、`cni*`、`flannel*`、`cali*`、`kube*`），避免流量重复计算。
  - 上一次的累计值按连接 id 保存在 `Monitor.previous`，`connection.disconnect` 时清掉。
- `SshPool::connected(id)` 只返回已有且未关闭的连接，从不发起连接，所以 Monitor 不会弹出主机密钥或密码询问。
- 进程列表（`components/monitor/MonitorProcesses.tsx`）：排序、搜索都在前端完成（每次采样都带全部进程），先按名称过滤、再排序，最后只渲染前 `LIMIT`（20）行。搜索框平时隐藏（`search` 为 `null`），Ctrl+F 由 `MonitorPanel` 的根元素（`tabIndex=-1`，点面板任意位置后都能收到）处理，通过 `searchRequest` 计数通知列表；搜索行与 Filer 的搜索框共用 `.pane-filter`（同样的高度、边框、聚焦样式、放大镜和 × 按钮），只额外加 `.monitor-procs-searchbar` 处理 sticky 位置；输入框在显示它的那次渲染之后由 effect 聚焦（`requestAnimationFrame` 时输入框可能还没渲染）。`.monitor-body` 带 `data-scrollbar`，与其他面板用同一套自定义滚动条，并在 `--sb-reserve` 规则里留出滚动条宽度；选中按 PID 记住，CPU 排序时行会移动，但选中不丢。只有键盘选择会把行滚进可见区：`ContextMenu` 在滚动时关闭，鼠标右键选中时不能滚动。行的 `scroll-margin-top` 让出两层 sticky 表头。
- `monitor.signal`：
  - 本机 Unix：`kill(2)`，错误取 `last_os_error`，去掉“(os error N)”。拒绝 PID 0 和 MetroTerm 自己的 PID。
  - 本机 Windows：TERM 用 `taskkill /PID`（不加 /F，`CREATE_NO_WINDOW`），KILL 用 sysinfo 的 `Process::kill`（TerminateProcess）。
  - SSH：exec 通道执行 `kill -TERM|-KILL <pid>`（PID 是数字，无需转义），非零退出码时把 stderr 最后一行里 “ - ” 或 “: ” 之后的原因作为错误返回。权限就是 SSH 用户的权限，不用 sudo。
  - 前端在确认框（`TreeDialog`）确认后才调用；成功后状态栏提示，并在 0.3 s 后立即重新采样；失败原因在面板顶部显示 8 秒（采样不会清掉它），同时写到状态栏。

### 隧道（Tunnels）

- 后端 `src-rust/src/remote/tunnel.rs`，`Tunnels` 按隧道 id 保存运行中的任务和计数（当前 / 累计连接、收发字节）。所有隧道都用会话已有的 SSH 连接（`SshPool`，与终端、Filer 共用），没有连接时先连接。
  - **本地**：`TcpListener` 监听，每个连接开 `direct-tcpip` 通道到目标，`copy_bidirectional` 双向转发并计数。
  - **动态**：同样监听，先在本机完成 SOCKS 握手（SOCKS5 无认证，CONNECT，域名 / IPv4 / IPv6；SOCKS4 / 4a），再开 `direct-tcpip`；域名交给 SSH 服务器解析。通道打不开时回 SOCKS 失败码，状态里记下原因。
  - **远程**：`tcpip_forward` 请求服务器监听；服务器发来的 `forwarded-tcpip` 通道（`remote/ssh.rs` 的 `server_channel_open_forwarded_tcpip`）按 (连接 id, 端口) 在 `RemoteForwards` 里找到隧道，再由本机连接目标（经 `remote/net.rs`，不走 Session → Proxy）。停止时 `cancel_tcpip_forward`。
  - SSH 连接断开时隧道任务结束，状态变成 `error` / “SSH connection closed”，保留在 `tunnel.list` 里直到再次启动或停止。错误信息转成可读的句子（端口被占用、需要特权端口、服务器拒绝转发、目标拒绝连接等）。
  - `shutdown`（桌面版关窗、浏览器模式 WebSocket 断开）时 `stop_all`。
- 前端：配置在 `lib/sessions/tunnels.ts`（保存到 sessions.json 的 `tunnels` 段），运行状态在 `lib/sessions/tunnelRuntime.ts`。后者是 React 之外的 store：对话框打开时每秒、有隧道运行时每 5 秒轮询 `tunnel.list`，其余时间不轮询；`starting` 和启动失败的原因只在前端记。菜单栏按钮用 `useSyncExternalStore(tunnelRuntime.subscribe, tunnelRuntime.getRunningCount)` 只订阅运行数，轮询不会重渲染整个 App；对话框订阅 `getViews`。
- `TunnelsDialog.tsx`：列表和表单两种视图，`TunnelRow` 用 `memo`，操作回调用 `useStableCallback` 保持身份不变，轮询时只有状态变了的行重新渲染。保存正在运行的隧道会先停止再按新配置启动。启动时 `autoStartTunnels` 启动勾选了 autoStart 的隧道。

### React 代码规范（react-best-practices）

按 [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) 的 `react-best-practices`（安装在 `~/.agents/skills/vercel-react-best-practices/`，版本记录在 `skills-lock.json`）检查过代码。本项目是 Vite + React 18 的 SPA，服务端、RSC、`next/dynamic` 相关的规则不适用（按需加载用 `React.lazy` + `Suspense`）；`useEffectEvent`、`<Activity>` 需要 React 19，暂不用。已采用、新代码也应遵守的规则：

- **派生状态不放 effect**（rerender-derived-state-no-effect）：能在渲染时算出来的直接算；“某个 prop 变了就重置状态”在渲染时比较并重置（MonitorPanel 换会话时清空曲线：`shownId !== connection.id`），不要用 `useEffect` 再渲染一次。
- **事件引起的状态变化放在事件里**（rerender-move-effect-to-event）：Filer 的路径框和搜索框随目录变化，统一由 `showPath(next)` 设置，不再用两个监听 `path` 的 effect。
- **函数式 setState**（rerender-functional-setstate）：依赖旧值时写 `setX(current => …)`。
- **按 id 查找用 Map / Set**（js-index-maps、js-set-map-lookups）：渲染循环里不要 `array.find`（App 的 `connectionById`、SenderPanel 的 `folderOf`、SessionTree 的 `folderIds`）。
- **合并遍历**（js-combine-iterations）：同一数组的多次 `filter` 合成一次（Filer 的可见文件和隐藏数）。
- **被动监听**（client-passive-event-listeners）：只用来关闭 / 重新定位弹层的 `scroll` 监听加 `passive: true`。
- **外部状态用 `useSyncExternalStore`**，只订阅需要的那一小块；传给 `memo` 子组件的回调保持身份不变（advanced-event-handler-refs，`useStableCallback`）。
- **初始值惰性计算**（rerender-lazy-state-init）：读配置、解析 JSON 的初始值写成 `useState(() => …)`。
- **数字不直接放在 `&&` 前**（rendering-conditional-render）：`{count > 0 && …}` 或三元，避免渲染出 `0`。
- 组件不在组件内部定义（rerender-no-inline-components）；默认值的对象 / 数组提到模块级常量。
- **重组件 memo**（rerender-memo）：`TerminalView` 是 `memo` 组件——App 每次光标移动（状态栏 Ln / Ch）都会重新渲染，终端只在自己的 props 变化时渲染。传给它的 props 必须身份稳定：`menuItems` 是 `useStableCallback` 的 `terminalMenuOf(tabId)`，放大过字号的终端的 prefs 来自 `useMemo` 的 `zoomedPrefs`（没放大就直接用 `terminalPrefs`）；它自己调用 `useTranslation()` 以便切换语言后刷新。
- **纯函数提到模块级**（js / rendering-hoist）：不读状态的帮助函数和常量表（`stamp`、`fileSafe`、`hasTerminal`、`collectLeaves`、`minSizeOf`、`panelClass`）放在 `App` 外面，不在每次渲染时重新创建。
- **不常用的界面按需加载**（bundle-conditional、bundle-preload）：菜单搜索 `CommandPalette` 用 `React.lazy` 单独打包，第一次打开时加载，鼠标移到 / 聚焦 🔍 时预加载。
- **高频事件按帧合并**（js / client）：窗格分隔线拖动时 pointermove 用 `requestAnimationFrame` 合并，每帧最多更新一次布局，松开时写入最终位置。

### 菜单、弹窗与输入框

- 菜单栏（`components/common/MenuBar.tsx`）：Session / View / Mode / Tool / Window / Help。依赖当前终端的项在没有终端时置灰。Tool → Triggers… 是占位（置灰）。Window 菜单见下一条。
- **多窗口（Window 菜单）**：`app/hooks/useWorkspace.ts` 的 `windows: WorkWindow[]`（`{id, name, layout, activeTabId}`）+ 当前 `windowId`；所有终端标签放在 `allTabs`，每个标签带 `windowId`。`layout` / `activeTabId` / `terminalTabs` 由当前窗口派生，`setLayout` / `setActiveTabId` / `setTerminalTabs` 只改当前窗口（通过 `windowIdRef`，回调里也不会拿到旧窗口）。
  - 所有窗口的 TerminalView 都挂在终端面板里（`terminalStack` 按创建顺序，切换窗口不移动 DOM），只显示当前窗口的当前标签；每个窗口的终端叶子 id 固定为 `terminal`，共用同一个 portal host。
  - 其他窗口的内容面板也一直渲染（portal 到不在文档里的 host），用该窗口的 `WindowCtx`（它的标签、当前标签和会话），所以 Sender 文字、Filer 位置等切换后保留。叶子 id 因此在所有窗口间唯一：新窗口和恢复时用 `uniqueLeaves` 给重复的 id 加 `win-N/` 前缀。
  - “Send Selection to Sender” 只发给当前显示窗口里的 Sender（`SenderPanel` 的 `shown()` 检查 `isConnected`）。
  - 删除会话 / 文件夹会关闭所有窗口里的对应标签；共享 SSH 连接的判断（disconnectTab）也看所有窗口。
  - 快捷键 Ctrl+Shift+1…9、Ctrl+Shift+PgUp / PgDn（Remote Mode 下终端里的按键不处理）。状态栏 `.status-windows` 的按钮右键打开 `statusWindowMenuItems`（显示、改名、`moveWindow` 左移 / 右移、新建、关闭），用 `--status-window-*` 变量，三个主题都是中性色。
- Mode 菜单：Full Screen（图标随状态切换：全屏时显示退出全屏的图标；F11；桌面版 `window_set_state` 的 `fullscreen`，浏览器用 Fullscreen API）、Always On Top（桌面版），勾选状态由 `syncWindowModes` 从窗口读取（resize / fullscreenchange / 专注模式进出后）。Local / Remote Mode 保存在 `settings.json` → `terminal.keyMode`：Remote 时 App 的快捷键处理对 `.xterm` 里的按键直接返回，TerminalView 的 `attachCustomKeyEventHandler` 也不拦截任何键；Local 时额外处理 Ctrl+C（有选中才复制）和 Ctrl+V（原生 paste 事件，150ms 内没有才读剪贴板）。
- 下拉 / 右键菜单（`components/common/MenuButton.tsx`）是 `position: fixed`，并且通过 `createPortal` 渲染到 `overlayHost()`（`.metroterm-shell`，保留主题类和字体变量），不会被工具栏的 `overflow` 裁掉，也不会被面板 / 窗格里的层叠上下文（如 `.tmux-splitter`）盖住；层级只低于锁屏（`.lock-screen` z-index 1500）。注意：portal 出去的菜单不再匹配祖先限定的选择器（如 `.sender-pane .ui-select-menu`）。
- 菜单搜索（`components/dialogs/CommandPalette.tsx`，结果列表 `.command-palette-list` 用自绘滚动条，`React.lazy` 按需加载，鼠标移到 🔍 上时预加载）：打开时把 `menuBar` 展平成 `菜单 / 子菜单 / 命令` 列表（跳过禁用项），多个词顺序不限，同时匹配显示的译文、英文原文和快捷键提示，命令名以查询开头的排在前面。🔍 按钮（`data-palette-toggle`）和 Ctrl+Shift+P 切换开关；面板打开时 App 的快捷键处理忽略来自 `.command-palette` 的按键。关闭后焦点回到原来的元素（通常是终端）。
- 弹窗统一结构：标题栏、内容区左右 16px、底部操作栏；控件（输入框、下拉框、数字框、切换按钮、字段旁的按钮）和底部操作栏按钮同高：`--dialog-control: 26px`，`--dialog-button: 26px`（`min-width: 72px`，操作栏上下内边距 10px）。Esc 先关下拉再关弹窗。
- **点击遮罩不关闭**：所有 `.modal-backdrop`（DialogFrame、Settings、会话设置、Focus Mode、锁屏设置、Filer / 会话树的确认框、认证提示）的 `onMouseDown` 都是 `backdropMouseDown`：只在点到遮罩本身时 `preventDefault`，弹窗不关闭，输入框也不失去焦点；关闭只能用关闭按钮、取消 / 保存或 Esc。
- **点击字段标题不聚焦**：字段是 `<label>标题<控件/></label>` 的结构，浏览器默认点标题会把焦点交给控件（自定义 Select 的触发按钮还会被“点击”而打开下拉）。`lib/ui/labelClicks.ts` 的 `installLabelClicks()`（`main.tsx` 调用）在文档上用捕获阶段的 `click` 监听：点在 `<label>` 里、但不在控件或其他可交互元素（input / textarea / select / button / 链接 / 带 role 或 tabindex 的元素）里时 `preventDefault`，取消标签的激活行为；其他处理照常收到这次点击。`label.control` 是复选框 / 单选框时不拦（它们的文字就是控件的一部分，点击照常切换）。
- **对话框里的键盘**（`lib/ui/dialogKeys.ts`，`main.tsx` 里 `installDialogKeys()`，window 捕获阶段一个监听器，所有对话框通用）：最上层的对话框（最后一个未在退场的 `.modal-backdrop`，或锁屏 `.lock-screen`）打开时，Tab / Shift+Tab 被禁止（`preventDefault`，焦点留在原处：既不在对话框里移动，也不会跑到后面的界面；打开着的下拉框照常被 Tab 关掉），字段用鼠标选；← / → 在底部操作栏 `.dialog-actions` 的按钮之间移动焦点（循环），只在焦点位于这些按钮上、或位于对话框本身（里面没有元素获得焦点）时生效，输入框里的方向键不受影响；Enter 在获得焦点的底部按钮上由这里调用 `click()`（Cancel 获得焦点时 Enter 就是取消）。**Ctrl / Shift 按着也有效**（第 64 轮）：用快捷键打开的对话框（Ctrl+Shift+W → Close tab）里，用户往往还没松开 Ctrl+Shift 就按方向键 / Enter，以前方向键要求没有任何修饰键、浏览器自己的 Enter 激活在按着修饰键时也不触发，所以看起来“← → 和回车没用”；现在只排除 Alt / Meta。其他按钮（例如 Select 的触发按钮）的 Enter 照旧由它们自己处理。快捷键对话框正在录入（`.key-capture.is-recording`）时不处理，Tab 也交给录入。
- 密码框：`components/common/PasswordInput.tsx`（用法同 `<input>`，forwardRef），右侧眼睛按钮（`.password-eye`，图标 `eye` / `eyeOff`）切换明文；按钮不进 Tab 顺序、`mousedown` 不抢焦点、随输入框禁用。会话、代理、SSH 认证提示（secret 字段）、锁屏和锁屏密码设置都用它。
- 弹窗边框：深色 `#616161`；浅色 `#8c8c8c`（原来的 `--line` `#cfcfcf` 在变暗的遮罩上几乎看不见），浅色阴影 `rgba(0,0,0,.16)`。
- 输入框：统一 `autocomplete="off"`；不出现浏览器默认右键菜单，改用应用菜单；桌面版开启 WebKitGTK 的 `javascript-can-access-clipboard`，Paste 不弹确认。
- 自绘光标（`src/lib/ui/appCaret.ts`）：原生光标设为透明，用隐藏的镜像元素测量光标位置画 2px 宽、约 1.25 倍字号高的竖线（镜像需要 `overflow: hidden` 和零宽空格标记）。数字 / email 输入框没有 `selectionStart`，所以 PORT 改为只允许数字的文本框。相关 CSS 需要 `!important`。光标条是 `position: fixed` 的元素、在所有内容上面，所以还要检查它所在的位置是否可见（`visibleBox`：窗口和所有裁剪 / 滚动的祖先元素的交集，再减去这些滚动容器里固定的 `position: sticky` 标题 / 按钮栏）；不可见时隐藏。以前对话框滚动时输入框被滚到标题栏下面或对话框外面，光标条仍画在原处（第 34 轮修复，Chromium 和 WebKit 都验证）。
- SHELL 输入框是自定义 ComboBox，不用 datalist。
- 自定义提示框：约 1.5 秒延迟，显示在鼠标右下方并保持在窗口内；带 `title` 的按钮会把它转成 `data-tip`。

### 日志（`lib/platform/log.ts`）

- 所有 UI 消息都用 `log`：`log(msg)` = `log.info`；`log.warn(msg, error?)`、`log.error(msg, error?)` 会拼上错误文本（`errorText`）。info / warn / error 显示在状态栏（`views/StatusBar.tsx` 自己订阅 `useActivity()`，新消息只重绘状态栏、不重绘 App），并通过后端 `log.write` 写入软件日志；`debug` / `trace` 只写日志；`{ quiet: true }` 不改状态栏。开发模式下同时输出到浏览器控制台。
- 组件直接 `import { log }`，不再通过 `onStatus` / `onLog` 属性传递。不要再直接用 `console.*`（vendor 代码除外）。

### 窗格（tmux 风格分屏，每个窗格是一个标签组）

- 数据：每个窗口（`WorkWindow`）有 `tmux`（`TmuxNode` 树，叶子是窗格 id `p-N`；没有 = 一个窗格 `p-1`）、`tmuxActive`（各窗格显示的标签）、`tmuxZoomed`；每个标签（`TerminalTab`）有 `tmuxPane`。窗口的 `activeTabId` 就是焦点窗格显示的标签，焦点窗格 = 它所在的窗格；`setActiveTabId` 切换时把失去焦点的窗格当前标签记进 `tmuxActive`。
- `tmuxView(tree, tabs, activeTabId, tmuxActive)`（`lib/workspace/tmux.ts`）算出要显示的窗格：按树的顺序列出窗格、字母、标签和显示的标签；树里没有的 `tmuxPane` 归第一个窗格，空窗格被裁掉。App 的一个 effect 把裁剪结果写回窗口、把每个标签的 `tmuxPane` 写成实际所在窗格，保存的数据始终一致。
- 渲染：`.tmux-stage` 里每个窗格是绝对定位的 `.tmux-pane`（`tmuxStyle`：不在左 / 上边缘的窗格让出 1px，露出 `--tmux-line` 背景作分隔线），里面是标签栏（`data-tab-strip="tmux:<窗格 id>"`，可互相拖放标签）、工具栏（窄窗格里会换行）和 `.tmux-body` 占位。所有窗口的 `.terminal-instance` 仍然按创建顺序常驻在 stage 里，不随窗格移动 DOM：`measureTmux` 在每次渲染后（以及 ResizeObserver 回调里）量出各 `.tmux-body` 的位置，窗格显示的标签的终端就放到那个框上，其余隐藏。位置用 `getBoundingClientRect` 的小数边缘**向内**取整到整像素（左 / 上 `ceil`、右 / 下 `floor`）：以前用 `offsetLeft` / `offsetWidth` 各自四舍五入，窗格边缘落在小数像素（百分比位置）时终端框会比窗格多出半个像素，不透明的终端背景盖住 1px 的分隔线间隙，分隔线在某些位置消失（4 个窗格拖动扫描时 120 个位置里 33–54 个不可见，改后 0 个）。向内取整留下的不到 1px 缝隙露出的是窗格自己的背景（终端底色）。`.tmux-splitter` 可拖动（`tmuxSetRatio`）；放大时只显示焦点窗格。
- 操作：`splitTerminal`（新窗格 + 同一会话的新标签）、`breakTab`（`!`，标签移到右侧新窗格，窗格里至少要有两个标签）、`moveTabToPane`（拖放）、`closeTmuxPane`（`x`，关闭窗格里的所有标签）、`focusTmuxPane`、`newTabInPane`（Ctrl+B `c`）。`doCloseTabs` 关闭当前标签时先选同一窗格的右 / 左邻居，再选其他窗格显示的标签。
- tmux 前缀：App 的快捷键处理（`app/hooks/useShortcuts.ts`）在 Remote Mode 检查之后、焦点在终端里时处理 Ctrl+B（`prefixRef`，状态栏 `.status-prefix`），下一键交给 `tmuxCommand`，未绑定的键被吞掉。Remote Mode 下 Ctrl+B 发给远程。**调整窗格大小可连按**（同 tmux 的 `bind -r C-arrow`）：Ctrl+B 之后 Ctrl+方向键每次移动 3%、Alt+方向键每次 10%（`resizeKey`）；只要 Ctrl（Alt）一直按着，再按方向键就继续调整，不用重按 Ctrl+B（`resizeRepeatRef`）。松开该修饰键（keyup）、窗口失去焦点或按了别的键就结束，之后的 Ctrl+方向键照常发给终端。
- 颜色变量：`--tmux-line`、`--tmux-focus-line`、`--tmux-letter-ink`、`--tmux-idle-tab-ink`、`--status-prefix-bg/-ink`。分隔线本身不变色：拖动时 `startTmuxDrag` 给 `<html>` 加 `is-tmux-resizing-row/-column`（全局 col-/row-resize 指针、禁止选中），pointermove 按 requestAnimationFrame 合并。
- 窗格工具栏：`tmuxToolbar(pane)` 的 `.toolbar-icons` 依次是全屏、查找（放大镜，`terminalRegistry.get(tab.id).find()`，即 `TerminalHandle.find` → 打开这个标签的查找栏，和 Ctrl+F 相同）、分隔线、克隆会话、重连；`.toolbar-right` 依次是 `.tmux-letter`（`components/terminal/PaneLetter.tsx`，26px 格子里的 SVG `<text>`；只有一个窗格时不显示）、收藏、⋮（`tmuxPaneMenu`：分屏、放大、关闭窗格）。字母与图标对齐：14px 图标的笔画在 16 格里画在 1..12，墨迹中心在 12.5px；用 CSS 让文本框居中不可靠，因为大写字母在行框里的高度取决于字体的 ascent / descent，不同系统的界面字体不同（deb80 的 padding 方案在测试字体下对齐，在用户系统上高了 1–1.5px）。现在用 canvas `measureText` 按同样的计算字体量出字形墨迹（`actualBoundingBoxAscent/Descent/Left/Right`），把墨迹中心放到 (12.5, 12.5)，只依赖字形本身，与行高 / ascent 无关；字体加载完（`document.fonts.ready`）和焦点变化（加粗）时重新测量。Chromium 和 WebKitGTK 在 100% / 125% / 150% 下、换成 DejaVu Sans / Liberation Serif / Noto Sans CJK / monospace 测试，与星形 / 复制图标的墨迹中心相差都不超过半个设备像素。左侧 `.toolbar-icons` 依次是全屏、查找、分隔、克隆会话（原来 Session info 按钮的位置，已删除）、重连。标签栏里只有标签。

### 国际化（react-i18next）

- `src/i18n/index.ts` 初始化 i18next：键就是英文原文（`keySeparator` / `nsSeparator` 关闭），英文没有资源文件，缺少翻译时显示英文；`zh.json` 是英文 → 中文。插值用 `{{name}}`。
- 用法：`t('Close tab')`、`t('{{name}} connected', { name })`；带代码片段的句子用 `tc('Delete <c>{{name}}</c>?', { name })`，`<c>…</c>` 渲染成 `<code>`。`t` 是普通函数，组件外也能用。
- 语言：`settings.json` 的 `language`，`main.tsx` 在首次渲染前 `setLanguage`；Settings → LANGUAGE 保存后 `setLanguage` 并更新 `<html lang>`。App（经 `usePreferences`）调用 `useTranslation()` 订阅语言变化，整个树随之重新渲染；`memo` 组件（`TunnelRow`）自己调用 `useTranslation()`。
- 模块级表格（`PANEL_VIEWS`、`TRANSPORTS`、`TUNNEL_KINDS`、Filer / Monitor 的列名、`TYPE_NAMES` 等）保留英文，在显示的地方 `t(item.label)`；`Select`、`ComboBox`、`MenuButton`、`MenuBar` 对 label / hint 统一调用 `t`（已翻译的文字再 `t` 一次不变）。
- 新增文字：写成完整句子（不要拼接英文片段），然后在 `zh.json` 加对应翻译。会话名、文件名、路径等用户数据不翻译。

### 桌面外壳与窗口

- **字体抗锯齿**：WebKitGTK 只能在不透明像素上画次像素文字，悬停 / 选中时文字会在灰度和彩色次像素之间切换。桌面版启动时把应用内 GTK 字体设置改为灰度抗锯齿 + 轻微 hinting（`desktop.rs` 的 `apply_font_rendering`）。
- **窗口背景**：`html`、`body` 跟随主题（`#171717` / `#ececea`），原生窗口和 WebView 背景同步（`tauri.conf.json` 的 `backgroundColor`、`set_window_background`），调整窗口大小时不露白。
- **标题栏**：FRAMELESS / NATIVE 二选一（`settings.json` 的 `titleBar`），启动时直接以所选样式创建窗口。浏览器模式（`isDesktop()` 为 false）不渲染 `.window-chrome`，Settings 也隐藏 TITLE BAR 一项（`SettingsDialog` 的 `desktop` 属性）；页面标题仍通过 `document.title` 显示当前标签。
- **macOS 的无边框**：不能用 `decorations(false)`——那样是 borderless 窗口，AppKit 不最小化它（没有 miniaturizable 样式），也不让它进全屏空间，之前最小化无效、最大化只是铺满桌面。macOS 上窗口始终带系统边框（`desktop.rs` 的 `apply_frame`）：FRAMELESS 是透明标题栏 + 内容延伸到标题栏下（`TitleBarStyle::Overlay`），用 `setTitleVisibility:` 隐藏标题文字、`standardWindowButton:` 隐藏红黄绿三个按钮；NATIVE 是 `TitleBarStyle::Visible` 并显示它们。AppKit 在调整大小、进出全屏后可能重新显示按钮，所以 `Resized` 时再隐藏一次（`keep_mac_frameless`）。专注模式的 `decorated` 也走 `apply_frame`，`window_get_state` 在 macOS 上报告的是 `NATIVE_FRAME`。最大化按钮（□）在 macOS 上调用 `set_fullscreen`（`toggleFullScreen:`，系统全屏空间），`window_is_maximized` 返回是否全屏，按钮提示为 Full Screen / Exit Full Screen；动画结束后前端再读一次状态。双击标题栏和原生标题栏一样是缩放（最大化 ⇄ 还原）：`window_toggle_zoom`（全屏时不动作）。
- **单实例**：`tauri-plugin-single-instance`（在 `desktop.rs` 里第一个注册）。已有 MetroTerm 在运行时，新进程把启动交给它（Linux：D-Bus 会话总线上按应用 identifier 注册的名字；Windows：命名互斥量；macOS：本地 Unix socket）然后立即退出；运行中的进程调用 `show_running_window`：取消最小化、显示，**临时置顶**（`set_always_on_top(true)`，本来就置顶——专注模式的 always on top——时不动）再 `set_focus`，250 ms 后取消置顶、再聚焦一次，并发出 `backend-event` `{type: 'window.activated'}`。只调 `set_focus` 不够：系统的防抢焦点机制不让后台程序抢焦点（Windows 只闪任务栏按钮，GNOME / KDE 可能只提示“已就绪”）。Windows 上每次启动先调 `AllowSetForegroundWindow(ASFW_ANY)`（`allow_running_instance_to_activate`），用户启动的新进程把前台权限让给正在运行的那个。前端（`App.tsx`）收到 `window.activated` 时，如果没有别的元素有焦点（`document.activeElement` 是 body），就聚焦当前标签的终端，可以直接输入。`metroterm web …`（含 `--daemon` / `--stop`）在 `cli::main` 里就分流，不创建 Tauri 应用，不受影响。
- **关闭确认**：有终端标签时 UI 调 `window_set_close_guard(true)`（`App.tsx`，随 `allTabs.length` 更新）。之后来自 UI 以外的关闭（原生 ✕、系统处理的 Alt+F4 / ⌘Q、任务栏、Dock）被 `desktop.rs` 拦下，改发 `window.closeRequested` 事件；UI 显示 “METROTERM EXIT” 确认框（`TreeDialog`，CANCEL / EXIT，Esc 取消），确认后 `quit(kind, true)` → `close_window` / `exit_app`（先清掉 guard）。Session → Exit 和自带标题栏的 ✕ 直接显示同一个确认框。没有终端或 UI 还没加载时立即关闭。浏览器模式用 `beforeunload`（浏览器自己的离开提示）。
- **记住窗口和标签**：关闭时写入 `window`（不记录最大化，记最大化之前的大小）；Window 菜单的窗口和标签实时写入 `windows`。`window_get_state` / `window_set_state` 在 `desktop.rs`。
- **Zoom**：只作用于当前标签，不保存；浏览器里拦截 Ctrl+= / Ctrl+-。
- **窗口透明度**：`window_set_state` 的 `opacity`（0.3–1.0）。Linux 用 GTK `set_opacity`，Windows 给窗口加 `WS_EX_LAYERED` 后 `SetLayeredWindowAttributes`（100% 时去掉该样式），macOS 设置 `NSWindow.alphaValue`（objc2）。Settings 的值启动时应用；专注模式期间显示专注模式自己的透明度，退出时恢复 Settings 的值。
- **字体**：终端字体写入 `terminal.fontFamily`，xterm 的 `fontFamily` 为“所选字体, 内置字体栈”；内置终端字体栈 `TERMINAL_FONT_STACK` 以 `DejaVu Sans Mono` 开头（Settings → TERMINAL FONT 的 Default，第 55 轮），后面是 Sarasa Mono SC / Source Code Pro 等（中文等 DejaVu 没有的字形、没装 DejaVu 的系统），改字体后重新计算行高并 refit；界面字体通过 `<main>` 上的 `--ui-font-family` 变量生效；没选界面字体时用 `defaultUiFamily()`（按浏览器 / WebView 的 userAgent）：Windows 为 `Microsoft YaHei` 在前，Linux 和 macOS 为 `DejaVu Sans Mono` 在前（Android / iOS 的 userAgent 也含 Linux / Mac OS X，先排除），其他系统为原来的字体栈；字体没有安装时由后面的字体栈接替。
- **菜单**：Session 菜单去掉了 Open Session…（及 Alt+O）和 Session Properties…（属性入口在 Preferences → Session Settings…；终端右键菜单也不再有 Session Properties… 和 Close View）；Log 子菜单改为软件日志设置（保存输出 / 清空回滚在终端右键菜单里）；Help 菜单为 About MetroTerm… 和版本号。

### 锁屏与专注模式

- 锁屏（`components/dialogs/LockScreen.tsx`、`lib/settings/lockScreen.ts`）：密码只存 PBKDF2-SHA256（15 万次、随机盐）的哈希；有密码时锁定状态持久化。空闲自动锁屏：键盘鼠标算活动，终端输出不算；空闲锁定跳过设密码提示。
- 专注模式（`components/dialogs/FocusModeDialog.tsx`、`lib/workspace/focusMode.ts`）：进入前保存 `WindowState`，退出时恢复；Tool Bar 对应 `.terminal-toolbar`；置顶只在桌面版可用。专注模式不改窗口透明度（透明度只在 Settings 里设置）。Show 的面板通过 `focusLayout` 临时加入，不修改保存的布局。

## 已知限制

- zsh 输入行折行时缩窄终端，zsh 重画时可能留下一份旧的输入行（zsh 不考虑终端重排）；bash 没有这个问题。
- 非整数缩放下制表符线条比 100% / 200% 稍虚。
- 浏览器不允许网页关闭自己的标签页，标题栏 ✕ / Exit 只在桌面版有效。

## 设计规则

- 不使用圆角和渐变，所有容器都是 90° 直角（Metro 风格）。
- 只用黑、白、灰，再加一个黄绿色作为状态色；不用紫色；白色主题里不出现黑色样式。
- **Gold 主题**：`ThemeMode` 是 `'dark' | 'light' | 'gold'`，主题列表、名称和轮换顺序在 `src/lib/settings/themes.ts`。Gold 时根元素的类是 `metroterm-shell dark gold`，`<html>` 上是 `theme-dark theme-gold`。样式文件里没有 Gold 专用规则：颜色全部由 `colors.css` 的 `:root.theme-gold` 块覆盖，包括金色调色板（`--gold`、`--gold-bright`、`--gold-dim`、`--gold-line`、`--gold-soft`、`--gold-ink`）和引用它们的组件变量（如 `--ink-active`、`--primary-button-bg`、`--session-tab-active-shadow`）；菜单栏背景是 `--menu-bar-bg` 金色渐变；当前终端标签的 `::before` 是 2px 流光（`--session-tab-flow` 渐变 + `--session-tab-flow-animation`，其他主题这两个变量是 `none`，动画不运行；`prefers-reduced-motion` 时关闭）。流光用 `transform` 移动（`::before` 宽 400%、渐变块 `background-size: 50%`，`translateX(0 → -50%)` = 原来 `background-position` 移动一个 200% 的渐变块，看起来一样；`.session-tab.active { overflow: hidden }` 裁掉多出的部分）：以前动画 `background-position`，每个窗格的当前标签每帧都在主线程重绘，分屏多时空闲也一直耗 CPU；`transform` 动画只在合成器里移动图层。变量定义在 `<html>` 上，滚动条层等 shell 以外的元素自动跟随。Explorer、Session、Filer 的名称和 Filer 的文件 / 文件夹图标不覆盖，与深色主题一致。终端调色板在 `lib/terminal/scheme.ts` 里有单独的 gold 一组。
- 高亮不泛黄。
- 图标统一 16×16 网格、1.3px 线宽、直角端点（`components/common/Icon.tsx`）。

### 弹出层动画

- `lib/ui/popupMotion.ts` 的 `installPopupMotion()`（`main.tsx` 调用）用一个 MutationObserver 统一处理：下拉 / 右键菜单（`.ui-select-menu`）、菜单栏菜单、菜单搜索（`.command-palette`）、提示（`.ui-tip`）、对话框（`.modal-backdrop`，里面的对话框同时轻微上移 + 缩放）、传输通知（`.filer-transfer`）。组件照常挂载 / 卸载，不用改。
- 进入：元素出现时用 Web Animations 播放淡入 + 位移（不用 CSS animation，React 改 class 也打断不了）。
- 离开：React 删掉元素后，在同一个微任务里把同一个元素插回原位置，加 `is-leaving`、`inert`、`aria-hidden`，去掉 id，播放淡出后真正删除。React 已经不认识它，不会再碰；淡出期间不能点击、不能获得焦点，自绘滚动条立即移除（`customScrollbars.ts` 跳过 `.is-leaving`）。判断“有没有对话框”的地方用 `.modal-backdrop:not(.is-leaving)`。
- 同一次更新里同类弹出层一个离开、一个出现（菜单栏左右移动、换子菜单）算切换，两边都不播动画。
- Web Animations 不发 `animationend`，动画结束时补发一个（自绘滚动条靠它重新测量）。
- `prefers-reduced-motion: reduce` 时全部关闭。
- **菜单搜索曾向左跳**：`.command-palette` 原来用 `left: 50%; transform: translateX(-50%)` 居中，进入动画的关键帧也改 `transform`，动画期间覆盖了居中的平移，弹窗先偏右，动画结束才跳回中间。现在用 `left: 0; right: 0; margin-inline: auto` 居中，`transform` 只给动画用。


### 拖入文件的蒙版

- 蒙版（`.file-drop-overlay`）只有半透明遮罩 + 中间一行灰色小字（`--file-drop-ink` = `--muted`），文字不加背景、边框、阴影。
- **指针位置（桌面版）**：Tauri 把拖动位置标成 “physical”，其实只有 WebView2（Windows）给设备像素；WebKitGTK（Linux）和 WKWebView（macOS）给的是窗口坐标，也就是 CSS 像素。以前一律除以 `devicePixelRatio`，在 HiDPI / 125% 以上缩放的 Linux 桌面上（WebKitGTK 的 `devicePixelRatio` 是 2）坐标只有实际的一半：从 Filer 拖到终端时算出来的位置仍在 Filer 里，蒙版就一直留在 Filer 上（这时松手还会传到 Filer）。现在只在 Windows 上除以 `devicePixelRatio`；页面自己也收到 `dragover` 时（WebKitGTK 会发，只是不带文件）优先用它的 `clientX / clientY`。
- **蒙版不会残留**：离开窗口（Tauri `leave` / 浏览器 `dragleave` 无 relatedTarget；Safari 类 WebKit 每次 dragleave 都没有 relatedTarget，所以还要求指针在窗口边缘）、Esc、松手、`dragend`、窗口失焦、任何一次 `mousemove` / `mousedown`（系统拖动期间不会有鼠标事件，出现就说明拖动结束了）都会隐藏蒙版；浏览器里超过 600ms 没收到 `dragover`（文件悬停时即使不动也每 ~50ms 发一次）也会隐藏。所有监听都挂在 window 的捕获阶段，元素阻止冒泡也影响不到。

### 对话框固定标题和按钮

- 所有对话框（`.connection-dialog`：DialogFrame 的各个对话框、Settings、新建 / 属性、密码提示、Filer / Explorer 的确认框、专注模式、锁屏）在窗口太矮需要滚动时，标题栏（`> .dialog-title`，`position: sticky; top: 0`）和底部按钮行（`> .dialog-actions`，`sticky; bottom: 0`）固定不动，只有中间的内容滚动。
- 自绘滚动条只画在两者之间：`customScrollbars.ts` 原来就识别前 3 个子元素里的 sticky 表头（`stickyHeaderHeight`），现在也识别最后 2 个子元素里的 sticky 底栏（`stickyFooterHeight`）。
- `scroll-padding-block: 48px 64px`：Tab 切换焦点时，聚焦的输入框不会停在标题或按钮下面。
- **最大高度**：`max-height: min(var(--dialog-max-height), calc(100vh - 40px))`，`--dialog-max-height: 640px`（`dialogs.css` 的对话框变量）。窗口再高，对话框也不超过 640px（Settings、会话属性这类长对话框在中间滚动），窗口矮于 680px 时仍按窗口高度。

