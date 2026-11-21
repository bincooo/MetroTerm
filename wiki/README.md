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
  - [终端：输入](#终端输入)
  - [终端：查找、选区与菜单](#终端查找选区与菜单)
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

技术栈：**React + TypeScript**（前端），**Rust**（后端），终端渲染用 `@xterm/xterm` 5.5（DOM 渲染器，带若干补丁，见下文）。

后端只有一套 RPC（`src-rust/src/backend.rs`），可以用两种方式运行：

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| 桌面应用（推荐） | `npm run tauri dev` | Tauri，通过 `invoke('rpc')` 和 `backend-event` 事件通信 |
| 浏览器 + 本地后端 | 终端 1：`npm run server`；终端 2：`npm run dev` | `metroterm-server` 监听 `127.0.0.1:7681`，Vite 把 `/api` 代理过去（HTTP + WebSocket） |

> `metroterm-server` 可以获得本机 shell 权限，所以默认只监听 localhost。不要把它暴露到公网。

安装好的桌面应用也能以浏览器方式运行：`metroterm --web[=ADDR]`（见下文“命令行参数”）。

### 命令行参数（`src-rust/src/cli.rs`）

- `desktop::run` 先调用 `cli::parse()`：`--help` / `-h`、`--version` / `-V` 打印后退出；未知参数打印错误、退出码 2；macOS 的 `-psn_…` 忽略。Windows release 版是 GUI 子系统，有参数时先 `AttachConsole(ATTACH_PARENT_PROCESS)`，输出才会出现在启动它的控制台里。
- `--log DIR`（或 `--log=DIR`）：`applog::set_dir` 把目录记在 `OnceLock` 里（相对路径按当前目录解析，先创建目录并试写 `metroterm.log`，失败退出码 1）。之后 `LogConfig::file()` 和 `default_path()` 都返回这个目录下的 `metroterm.log`，Log Settings 里保存的路径在本次运行中不生效。
- `--web[=ADDR]`：不创建 Tauri 应用。`tauri::generate_context!()` 只调用一次，Web 模式把其中的 `assets`（打包进二进制的前端文件，`get` 时解压）交给 `server::serve_web`，同一个 axum 服务既提供 `/api`（和 metroterm-server 相同），也用 fallback 提供静态文件（`/` 和没有扩展名的路径 → `index.html`；`/assets/` 带哈希，长缓存）。默认 `127.0.0.1:7681`，被占用时改用随机端口；指定 ADDR 时绑定失败直接报错。用 `xdg-open` / `open` / `rundll32 url.dll,FileProtocolHandler` 打开浏览器。debug 构建没有嵌入前端，会提示改用 release 构建。
- Web 模式的 `/api` 有同源检查（`api_guard` 中间件，只在 `serve_web` 时启用）：Host 必须是 `localhost` 或 IP 地址（防 DNS rebinding），浏览器带的 Origin 必须和 Host 相同（防其他网站打开 WebSocket，WebSocket 不受 CORS 限制）；不带 Origin 的请求（curl）放行。metroterm-server 不检查（Vite 代理会改写 Host）。
- 为此 `desktop` feature 包含 `server`（axum），桌面二进制大一些。
- `--daemon[=ADDR]`（`cli::start_daemon`）：本进程只负责启动——用 `current_exe()` 再启动自己，参数 `--daemon-child --web[=ADDR] [--log DIR]`，标准输入输出都接到 null；Unix 在子进程里 `setsid()`（新会话，关掉终端的 SIGHUP、终端里的 Ctrl+C 都到不了它），Windows 用 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`。子进程走 `run_web(addr, files, daemon = true)`：不打开浏览器，监听成功后写 `~/.metroterm/daemon.json`（`{pid, url, addr}`）。父进程最多等 10 s，读到 PID 相同的状态文件就打印网址退出；子进程提前退出则报错（看日志）。已有状态文件且该地址能连上时只打印已在运行的那个（连不上就当作过期文件）。
- `--stop`（`cli::stop_daemon`）：读 `daemon.json`，地址能连上才停：Unix `kill(pid, SIGTERM)`，Windows `taskkill /PID … /T /F`；等端口关闭（最多 5 s）后删掉状态文件。

### 前置条件

- Node.js 20+
- Rust stable 1.85+
- 桌面版需要安装 Tauri 2 的平台依赖：<https://v2.tauri.app/start/prerequisites/>

```bash
npm install
npm run tauri dev                 # 桌面版
npm run tauri build               # 打包

# 浏览器模式
npm run server                    # = cargo run --no-default-features --features server --bin metroterm-server
npm run dev                       # 另开一个终端；可用 METROTERM_BACKEND=http://host:port 指定后端地址
```

常用检查：

```bash
npm run typecheck                 # TypeScript 类型检查（含 vite.config.ts）
npm run format                    # Prettier 格式化前端代码（不含 src/styles.css）
npm run check                     # 类型检查 + 格式检查 + cargo fmt --check（提交前运行）
npm run build                     # 前端构建（会清空 dist/）
```

## 代码规范

- **TypeScript / CSS**：Prettier 统一格式（`.prettierrc.json`：单引号、分号、尾逗号、单参数箭头函数不加括号、行宽 140），`.editorconfig` 统一缩进和换行。`src/lib/vendor/`（从 xterm 拷贝的代码）不格式化。
- **`src/styles.css` 不用 Prettier**（已列入 `.prettierignore`），采用紧凑写法：每条规则一行（`选择器 { 属性: 值; … }`），`@media` / `@keyframes` 内的规则缩进两格、各占一行，只在顶层注释（分节标题）前空一行，修改时请手工保持这种排版。
- **类型检查**：`strict`，并开启 `noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`；没用到的变量、参数、import 会直接报错。
- **Rust**：`cargo fmt` 格式化；`cargo clippy --no-default-features --features server` 应当没有警告（`desktop.rs` 只能在 chroot 里编译，随 `npm run build:deb` 一起检查；Windows 版用 `npm run build:windows` 检查 `cfg(windows)` 分支）。
- **模块划分**：组件放 `src/components/`，与 React 无关的逻辑放 `src/lib/`。只在文件内部使用的函数、常量、类型不要 `export`。访问 xterm 私有字段统一通过 `src/lib/xtermInternals.ts`，不在各处写 `as unknown as { _core … }`。
- **样式**：`src/styles.css` 是唯一的样式表（布局、字体、尺寸），**颜色统一在 `src/colors.css`**（在 `main.tsx` 里先于 styles.css 引入）。`colors.css` 只有三个块：`:root`（深色，默认值）、`:root.theme-light`、`:root.theme-gold`，主题由 `<html>` 的 `theme-*` 类切换。**一个 class 适配所有主题**：`styles.css` 里每条规则只写一次，只写 `var(--token)`，不写颜色值，也不写 `.light` / `.gold` / `html.theme-*` 这类主题选择器；某个部件在某个主题里要不同，就在 `colors.css` 的组件区给它一个变量（如 `--tab-bar-bg`、`--ink-active`），在对应主题块里赋值。新面板只用语义变量（`--panel`、`--ink`、`--muted`、`--line`、`--hover`、`--active`、`--control-*` 等）即可自动适配三个主题。普通灰色用中性灰阶 `--n-XX`（深色 `#XXXXXX`、浅色为其镜像，代替了原来自动生成浅色规则的 `light-theme-twins` 插件），其余用语义名称。改了颜色后同步更新 [`wiki/style-css.md`](style-css.md)（完整配色表）。新增规则时先查是否已有同一选择器的规则，避免同一属性被后面的规则覆盖而成为死代码。
- **清理样式时的回归检查**：把改动前的构建放在另一个端口，对两个版本在多种界面状态（深色 / 浅色 / Gold、各菜单、各对话框、查找、提示框等）下逐个元素比较全部计算样式（含 `::before` / `::after`），结果必须完全一致。注意 Chromium 列出自定义属性（`--*`）的顺序在不同启动之间不固定，比较前要先按属性名排序。

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
4. **web**（`.github/workflows/web-package.yml`，可复用，也能在 Actions 页单独运行）：浏览器版 `_linux-x86_64-web.tar.gz` / `_linux-aarch64-web.tar.gz`。界面在 `ubuntu-latest` 上 `npm run build` 一次；`metroterm-server`（`--no-default-features --features server`，不需要 GTK / WebKit）在 `debian:10` 容器里编译，所以只需要 glibc 2.28（Debian 10+、Ubuntu 18.10+、RHEL 8+），编完用 `objdump -T` 检查最高的 GLIBC 符号版本不超过 2.28。包里是 `metroterm-server`、`www/`（界面）、LICENSE、README、README-web.txt。`metroterm-server` 发现旁边有 `www/index.html`（或 `--www DIR`）就同时提供界面，和 `metroterm --web` 一样只接受自己页面发来的 `/api` 请求（`server::dir_files` 只读 `www` 里的普通相对路径，拒绝 `..`、以点开头、带 `\` / `:` 的路径段）；`--no-www` 只当后端（配合 Vite 开发）。
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
- **界面跑在系统自带的 WebKit 上**（WKWebView），WebKit 版本跟着系统 / Safari 更新走：Intel Mac 常停在较老的 macOS（10.15 最多 Safari 15.6），新语法在那里会让整个界面起不来、只剩空窗口。`vite.config.ts` 的 `build.target` 含 `safari13`，esbuild 能降级的语法会自动降级，但**正则后行断言 `(?<!…)` / `(?<=…)`（Safari 16.4 起才支持）降不了**——esbuild 只把它改成 `new RegExp(…)`，模块加载时照样抛 `SyntaxError`。前端代码不要用后行断言（`terminalScheme.ts` 的高亮规则改用 `notAfter` / `when` 检查前一个字符，结果与原来的写法逐一相同）。其它要注意的：`structuredClone`、`Array.prototype.at`、`Object.hasOwn` 是 Safari 15.4，`crypto.randomUUID` 要带回退（`sessionTree.ts`）。界面启动失败时 `index.html` 里的一小段老式脚本把错误和 User-Agent 显示在窗口里，不再是空白。

## 架构

```text
src/                              React + TypeScript UI
  App.tsx                         主界面：布局树、标签、菜单、锁屏 / 专注模式状态
  types.ts                        共用类型（Connection、TerminalTab、RemoteFile …）
  colors.css                      配色：所有颜色变量（深色 / 浅色 / Gold 三个块），见 wiki/style-css.md
  styles.css                      全部样式规则（只用 colors.css 的变量，没有主题选择器）
  layout.ts                       面板布局树的纯函数操作
  i18n/index.ts                   国际化（react-i18next）：初始化、t / tc、LANGUAGES、setLanguage
  i18n/zh.json                    中文翻译（键是英文原文）
  lib/log.ts                      统一日志工具：log / log.info / warn / error / debug / trace、errorText、useActivity（状态栏）
  lib/tmux.ts                     tmux 窗格（标签组）树的纯函数（拆分、裁剪、移动焦点、调整比例、交换、布局）和 tmuxView
  lib/windows.ts                  Window 菜单：窗口类型、恢复 / 保存 sessions.json 的 windows、新窗口布局、叶子 id 去重
  lib/backend.ts                  后端访问层：desktop / server / preview 三种模式
  lib/config.ts                   sessions.json / settings.json 读写
  lib/hostOs.ts                   后端所在系统（system.os）：首次启动的内置 shell、Windows 路径引号
  lib/preferences.ts              偏好：终端（字号、字体、回滚、光标、左侧栏）、外观（透明度、界面字体）、代理、日志
  lib/transports.ts               会话类型：名称、图标、默认端口、描述（describeConnection）、串口参数
  lib/fileDrop.ts                 系统文件拖入：桌面版 Tauri onDragDropEvent（路径 + 位置），浏览器用页面拖放事件（File）；落点 [data-file-drop] 加 is-file-over 并盖上共用的 .file-drop-overlay（fixed，蒙版 + data-file-drop-label 文字），放下时派发 metroterm:file-drop；shellQuote
  lib/fonts.ts                    Settings → FONTS：canvas 测宽检测本机已安装的常用字体
  lib/version.ts                  版本号（取自 package.json）
  lib/terminalScheme.ts           黑白两套终端配色和输出高亮
  lib/terminalFind.ts             终端查找
  lib/selectionMatches.ts         选中文字的相同内容高亮
  lib/xtermInternals.ts           xterm 私有字段的统一访问（渲染尺寸、DOM 渲染器、装饰服务、viewport）
  lib/domRendererSpeed.ts         xterm DOM 渲染器性能补丁
  lib/boxGlyphs.ts                制表符 / 方块字符画成图片
  lib/exactCharWidths.ts          精确字宽（中文严格两格）
  lib/textCentering.ts            终端文字垂直居中
  lib/imeInput.ts                 输入法上屏去重
  lib/customScrollbars.ts         自绘滚动条
  lib/tunnels.ts                  隧道配置：类型、读写 sessions.json 的 tunnels、校验（validateTunnel）、描述和对应的 ssh 参数
  lib/tunnelRuntime.ts            隧道运行状态的外部 store（轮询 tunnel.list），useSyncExternalStore 订阅；autoStartTunnels
  lib/tabDrag.ts                  标签拖动：startTabDrag（重排 / 跨面板移动，幽灵标签和落点标记直接改 DOM）、moveBefore
  lib/useStableCallback.ts        身份不变、总是调用最新闭包的回调（传给 memo 子组件）
  lib/appCaret.ts                 输入框自绘光标
  lib/popupMotion.ts              所有弹出层的进入 / 离开动画（菜单、菜单搜索、提示、对话框、传输通知）
  lib/lockScreen.ts, focusMode.ts 锁屏、专注模式
  components/TerminalView.tsx     xterm、会话生命周期、按顺序写入、重连、行号栏
  components/Filer.tsx            Filer：本地 / SFTP 文件浏览、文件操作、传输
  components/FilerTransfers.tsx   Filer 传输批次：useTransfers（逐个执行、进度、取消、重试）和列表上方的 TransferPanel（进度 + 结果通知）
  components/MonitorPanel.tsx     Monitor：CPU / 内存 / 网络 / 磁盘 / 进程，按间隔调用 monitor.sample
  components/MonitorProcesses.tsx Monitor 的进程列表：排序（前 20）、名称搜索（Ctrl+F）、选择、Stop / Kill（确认后调用 monitor.signal）
  components/SplitPane.tsx        可拖拽分隔的面板
  components/SenderPanel.tsx      Sender 面板（以及 Send Selection to Sender 的入口）
  components/SessionDialogs.tsx   新建 / 属性 / 另存为会话对话框、Default Session Settings
  components/SettingsDialog.tsx   Preferences → Settings… 对话框
  components/AppDialogs.tsx       Session → Proxy…、Session → Log → Log Settings…、Help → About
  components/DialogFrame.tsx      弹窗外壳：遮罩、标题栏、Esc 关闭、初始聚焦
  components/TunnelsDialog.tsx    菜单栏 Tunnels：隧道列表（启动 / 停止 / 编辑 / 删除、流量）和编辑表单
  components/dialog.ts            对话框共用的键盘处理（Esc 关闭）
  components/MenuBar.tsx          菜单栏
  components/MenuButton.tsx       下拉菜单 / 右键菜单（portal 到 overlayHost）
  components/CommandPalette.tsx   菜单搜索（🔍 / Ctrl+Shift+P）
  components/AuthPromptDialog.tsx 密码、口令、keyboard-interactive、host key 确认弹窗
src-rust/src/
  backend.rs                      RPC 分发（与传输方式无关）
  ssh.rs                          russh 连接池、认证、known_hosts
  terminal.rs                     本地 PTY、SSH shell 通道，Telnet / TCP / 串口交给 stream.rs
  stream.rs                       Telnet（RFC 854 + ECHO/SGA/BINARY/TTYPE/NAWS）、原始 TCP、串口（serialport）
  net.rs                          出站 TCP：直连或经 SOCKS5 / HTTP CONNECT 代理
  tunnel.rs                       SSH 端口转发：本地（-L）、远程（-R，tcpip-forward）、动态（-D，SOCKS 4/4a/5 服务端）
  applog.rs                       软件日志：log crate 的 Logger，级别 / 文件 / 文本或 JSON / 按大小轮转
  files.rs                        SFTP 和本地文件系统共用的一套接口，以及带进度的传输
  monitor.rs                      Monitor 面板的采样：本机用 sysinfo，SSH 主机经 exec 通道跑一段 sh 脚本
  events.rs                       事件定义、交互式询问（prompt）分发
  utf8.rs                         流式 UTF-8 解码，避免中文或 emoji 被截断
  locale.rs                       本地 shell 的 UTF-8 locale
  config.rs                       ~/.metroterm 配置读写
  desktop.rs                      Tauri 外壳（feature "desktop"，默认启用）
  cli.rs                          桌面应用的命令行参数：--web / --daemon / --stop / --log / --version / --help
  server.rs, bin/metroterm-server.rs   axum WebSocket/HTTP 服务（feature "server"）；`--www DIR` / 旁边的 `www/` 时同时提供界面（浏览器版）
```

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
| `proxy.test` | `{proxy, host, port, path?}` | `{ms, status}`：建立隧道（有 `path` 时再经隧道发 HTTP GET）的耗时，`status` 是 HTTP 状态码，只建隧道时为 `null` |
| `ping` | — | `{version}` |

事件：`terminal.data`、`terminal.exit`、`connection.state`、`auth.prompt`、`auth.done`、`transfer.progress`。隧道状态靠 `tunnel.list` 轮询，没有事件。

浏览器模式另外提供两个 HTTP 端点：`GET /api/fs/download` 和 `PUT /api/fs/upload`，用于流式传输文件。

## 配置文件

配置保存在 `~/.metroterm/`（Windows 为 `%USERPROFILE%\.metroterm\`）。桌面版和浏览器 + 本地后端模式都写到这里；静态预览则写到 localStorage 的 `metroterm:*`。程序旁边有 `portable.metroterm` 标记文件时（Windows 便携版），改用程序旁边的 `data/`（`config::config_dir()`，启动时查一次）。

| 文件 | 内容 |
| --- | --- |
| `settings.json` | `language`（`en` 默认 / `zh`）、`theme`、`titleBar`、面板标题色块 `swatches`、`recent`（最近 10 个会话）、`terminal`（`fontSize` / `scrollback` / `cursorBlink` / `cursorStyle` / `gutterTime` / `gutterLine` / `keyMode`）、`sessionDefaults`、`lock`（密码哈希、空闲分钟、是否提示）、`focus`（专注模式设置）、`appearance`（`windowOpacity`、`uiFontFamily`）、`proxy`（`type` none/socks5/http、`host`、`port`、`username`、加密的 `savedPassword`）、`log`（`level`、`path`、`format`、`maxSizeMb`、`keep`）。`terminal` 另有 `fontFamily` |
| `logs/metroterm.log` | 软件日志（默认位置；轮转后为 `.1` … `.N`） |
| `sessions.json` | 见下 |
| `known_hosts` | 在 MetroTerm 里接受的 SSH host key（OpenSSH 格式） |
| `shell/bashrc`、`shell/zsh/` | 本地 bash / zsh 的启动文件，每次启动时重写（见[终端：输入](#终端输入)） |

`sessions.json`（version 4）：

- 没有 `sessions.json` 时（第一次启动）只建内置的本地 shell 会话，按后端所在系统决定（`App.tsx` 的 `builtinShells`）：Windows 是 `cmd` 和 `powershell`（Windows PowerShell 每台 Windows 都有；pwsh 由用户自己添加），其他系统是 `bash` 和 `zsh`。系统来自后端的 `system.os`（Rust `std::env::consts::OS`，`lib/hostOs.ts` 在首次渲染前读取），所以浏览器模式下看的是服务器的系统，不是浏览器的；静态预览退回到浏览器的 userAgent。Filer / Sender 的路径加引号方式和 Monitor 的 Windows 判断也用它。
- version 3 → 4（只在 Windows 上）：旧版本在 Windows 上也建了 bash / zsh。id 为 `local` / `local-zsh`、名称和 shell 仍是原样的内置会话改成 cmd / PowerShell（id、位置、文件夹、收藏不变，打开的标签和最近列表仍然有效）；用户改过或自己建的会话不动，已经有 cmd / PowerShell 会话时也不动。

- `folders` / `sessions`：会话配置（名称、主机、端口、用户、认证方式、私钥路径、所在文件夹、收藏；勾选 Remember password 时含加密的 `savedPassword`，无明文密码）。
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

### 终端：渲染与性能

xterm 5.5 的 DOM 渲染器有几处让滚动卡顿的地方，在 `src/lib/domRendererSpeed.ts` 里用原型补丁修正：

- **多余的整屏重绘**：每次滚动，选区服务都会请求重绘选区，渲染器因此同步地把整屏的行再生成一遍，而滚动本身已经安排了同一帧的整屏渲染。现在没有选区（或选区没变）时跳过这次行渲染；有选区时只重画选区层。
- **span 合并**：带装饰的单元格从不和相邻单元格合并，一行日志约 100 个节点。现在每行生成后把类名和内联样式完全相同的相邻 span 合并（光标所在的 span 除外），文字、字符间距和网格对齐都不变。
- **行池，上下滚动不重新渲染**：已生成的行按缓冲区行号保留（移出文档、只留在内存里，最多 5000 行，超出时丢弃离屏幕最远的），滚动时只移动已有的行，内容、颜色、选区、光标都没变就不重新生成。输出停止 0.3 秒后，在空闲时分小段（每段不超过 8 ms）预生成屏幕上下的回滚行（WebKitGTK 测试：`ls /bin/* -alh` 1689 行，整程拖动重建行数 558–792 → 0）。主题切换、选区变化、改变大小、切换备用屏幕时重新生成。注意：行池中 DOM 顺序 ≠ 屏幕顺序。
- **行间细线 / 竖线断开**：125% / 150% / 110% 等缩放下行的上下边落在非整数设备像素上。Chromium 给每一行被裁剪的边缘单独做抗锯齿，相邻两行在同一个设备像素里各画一半透明度，叠起来不到 100%，下面的终端背景会透出一条细线（btop 的高亮行、浅色主题里全屏程序上的白线），`│` 边框在行交界处断开 1px；WebKitGTK 则把 `top` 和 `height` 分别取整，偶尔留下 1px 空隙。**不靠涂背景遮挡**（以前的 `fillRowBackground` / `fillScreenBackground` 已删除）：`domRendererSpeed.ts` 让行按 1/64px 网格精确首尾相接（`rowEdge`），每行再向下多盖 `ROW_OVERLAP` = 1px，按屏幕顺序设 `z-index`（下面一行盖住上一行多出的那 1px），交界处总有一行完全不透明，缝隙就不存在了；行容器 `z-index: 2` 隔开层叠（必须高于 xterm 选区层的 1：xterm 让选中的格子带 `.xterm-decoration-top`（z-index 2，选区颜色作背景）浮到不透明的选区层上面，行容器若是 0，这些格子出不去，选中的文字就被选区层盖住看不见了），CSS 变量 `--xterm-row-overlap` 让光标的 8 条 `calc` 规则减去这 1px，光标高度不变。Chromium 110% / 125% / 150% 和 WebKitGTK 各缩放下测得的缝隙都是 0。
- **选区只让相关行失效**：每行只比较选区落在这一行上的部分，选中、改变或取消选区时只重建旧选区和新选区覆盖的行。左右滚动对终端不起作用，也不触发渲染。
- **选区层错误**：选中的文字完全滚出屏幕后，xterm 的选区模型被清零（第 0 行），DOM 渲染器却仍按它在第一行画一个灰色矩形。现在选区不在屏幕内时清空选区层。
- **切换标签**：保留的行不留在文档里（以前用 `visibility: hidden` 留在原处，每次显示都要重新计算样式和布局，切换一次 120–200 ms），滚到屏幕里时才放回去。`boxGlyphs.ts` 对放回的、没有重新生成的行直接跳过。测试（两个标签各有 `ls /bin/* -alh` 的输出）：Chromium 120–205 ms → 19–36 ms；WebKitGTK（软件渲染）105–131 ms → 77–101 ms，剩下的主要是绘制。
- **输出高亮不用 decoration**：以前每个着色片段都是一个 xterm 装饰，屏幕附近有几百个装饰元素，xterm 在滚动后另外重新摆放它们，拖动滚动条时顶部会出现一块块颜色。现在颜色在生成行时直接写进文字（`terminalScheme.ts` 的 `attachHighlighter` 接管 `forEachDecorationAtCell`，按行文本缓存匹配结果），不创建任何装饰元素。
- 提示框（tooltip）和关闭自动填充用的 MutationObserver 不处理终端行、行号栏和滚动条层的 DOM 变化。
- 测试（6000 行带高亮的日志，连续滚动 240 帧，无头 Chromium）：每帧中位数 60 ms → 25 ms，超过 50 ms 的长任务 206 次 → 0 次。
- xterm 5.5 的 `onScroll` 不会因为用户滚动触发，需要用 `onViewportScroll`；避免 `scrollIntoView`。

### 终端：外观

- **配色**（`src/lib/terminalScheme.ts`）：黑、白、金三套（Gold 是深色的 Monokai 调色板换成暖黑背景 `#141310` 和金色选中，光标与深色一样是橙色 `#ffaa5c`，黄色 / 亮黄改为 `#c9a33a` / `#f0cf6a`），各含 16 色 ANSI 调色板和输出高亮颜色。深色默认是 VS Code 的 Monokai（Molokai）：前景 `#f8f8f2`，目录（粗体蓝）`#819aff`，符号链接（粗体青）`#66d9ef`，亮红 `#f92672`、亮绿 `#a6e22e`、亮黄 `#e2e22e`、亮紫 `#ae81ff`；背景 `#171717`（ANSI 黑调成 `#2c2c2c`）。浅色主题用同一套色相加深，背景 `#fafafa`。输出高亮：错误 / 警告 / 成功 / 信息 / 调试关键字、URL、路径、IP 和 MAC、日期时间、UUID、字符串、数字和单位、`ls -l` 权限列；只给程序没设置颜色的文字上色，备用屏幕不做高亮。
- **不加粗**：`fontWeightBold: normal`，粗体文字只保留亮色。
- **光标**：橘色，默认闪烁的方块，深色 `#ffaa5c`、浅色 `#ff8a2e`。高度由 `src/styles.css` 的 `--terminal-cursor-height`（17px，行高 19px 时）控制，上下居中后再下移 `--terminal-cursor-shift`（1px，视觉上与文字居中），顶部用 `round(down, …, 1px)` 对齐到整像素（带不支持 `round()` 时的 `calc` 回退）。未聚焦的空心框和实心方块用同一个框，用 1px `border` 画在框内——以前用 `outline` 时 WebKitGTK 会多算 1 行像素，空心框比方块高 1px。**样式**（`TerminalPrefs.cursorStyle`：`block` 默认 / `bar` / `underline`，Settings 的 CURSOR 第一排）：竖线和下划线也画在 `::before` 里、与方块同一个居中的 17px 框（竖线 2px 宽在格子左边；下划线 2px，比框底高 `--terminal-cursor-underline-lift: 1px`，正好贴在文字基线下面，再高会压住字母底部），关掉 xterm 自己的 box-shadow / border-bottom，闪烁用自己的 `metro-cursor-blink` 动画；xterm 给下划线格子设的 `height: calc(100% - 1px)` 要改回 `100%`，否则框会上移 1px。失去焦点：方块 → 空心框（`cursorInactiveStyle: 'outline'`），竖线 / 下划线隐藏：`cursorInactiveStyle` 仍是同一样式（xterm 照常画出光标格子），由 `styles.css` 的 `.xterm-rows:not(.xterm-focus) .xterm-cursor.xterm-cursor-bar::before`（及 `-underline`）`display: none` 隐藏——DOM 渲染器只在终端聚焦时给 `.xterm-rows` 加 `xterm-focus`。样式和闪烁只听 Preferences 的 CURSOR：xterm 5.5 允许程序直接改选项（DECSET/DECRST 12 `ESC[?12h`/`ESC[?12l`——`tput cvvis`/`tput cnorm`、vim、less 等都会发；DECSCUSR `ESC[n q` 改形状和闪烁），`TerminalView.tsx` 注册了这三个 CSI 处理器，让 xterm 照常处理（返回 false）后在微任务里用 `applyCursor` 把 `cursorBlink`、`cursorStyle`、`cursorInactiveStyle` 改回设置值，所以下一帧绘制前就已恢复。
- **行号栏**（`TerminalView.tsx` 的 `gutter`）：每行显示 `[时间]` 和行号；光标所在行为红色（`--gutter-current`）；自动换行的续行不显示。用光标移动画出的行在第一次显示时补上时间，反复重画的行只保留最新时间。备用屏幕里显示每行最后一次变化的时间和屏幕行号。
  - 两列可以分别关闭（终端工具栏 ⋮，`settings.json` → `terminal.gutterTime` / `gutterLine`）：`.terminal-gutter.no-time` / `.no-line` 改 grid 列，两项都关时设置 `hidden`，终端 fit 后列数随之变化。
  - 宽度按整个缓冲区的行数决定（不按屏幕里的行号），否则跨越 999/1000 行时宽度变化会导致整屏重排。
  - 对齐：行高取 xterm 的精确（小数）行高，并按终端第一行的实际位置对齐（`--gutter-shift`），在 125% / 150% 缩放下也不累积偏差。
- **点击行高亮**：终端和行号栏一起显示整宽横条，按终端实际渲染的行定位；长行换行时整个逻辑行一起高亮，输出滚动时跟随（xterm marker）；备用屏幕不启用。
  - 行号栏部分是独立的一条（`.terminal-gutter-band`，绝对定位在行号文字下面），和终端里的横条（`.terminal-line-highlight`）在 `placeBand` 中用**同一个渲染行的位置**同时设置。不要再用行号栏行的背景（`.is-picked` 只改文字颜色）：那是按「行高 × 序号 + shift」另算的，小数缩放下行越靠下偏差越大（150% 时第 33 行约 0.3px），滚动后会和横条错开。
  - 终端区域内任何元素滚动（捕获阶段的 `scroll` 监听）都会重新放置横条。
- **内边距**：终端区域四周没有留白，文字区内部上下 4px、左右 8px（`--xterm-inset-y` / `--xterm-inset-x`）。
- **表格和方块字符**（`src/lib/boxGlyphs.ts`，画法来自 `src/lib/vendor/xtermCustomGlyphs.ts`）：行高大于字体时 `│ ┌ ┼ █` 等字符上下有缝。U+2500–U+259F 和 Powerline 符号改用 xterm WebGL 渲染器的画法画成一格大小的图片，上下各多伸出一个设备像素。文字本身不变，选择、复制、搜索不受影响。非整数缩放下线条略虚。
- **中文严格占两格**（`src/lib/exactCharWidths.ts`）：xterm 用取整的 `offsetWidth` 量字宽，误差沿一行累积；Chromium 还会压缩相邻全角标点。现在按小数精确量宽并设置 `text-spacing-trim: space-all`；含制表符的行把每段文字对齐到格子（`boxGlyphs.ts` 的 `snapRow`）。
- **垂直居中**（`src/lib/textCentering.ts`）：DejaVu Sans Mono、Liberation Mono 等在 125%/150%/200% 下比行中线高 1–2px。启动和字号 / 缩放变化时实测大写字母的位置，把字形移到行中间（按设备像素取整），背景、光标、制表符不动。行号栏同样处理。
- **字体**：优先 `"RobotoMono Nerd Font"`，然后 Cascadia Mono / SF Mono / Consolas / 系统等宽字体。RobotoMono 行高比 DejaVu 高约 20%，`densityLineHeight` 自动调整系数，13px 下每行仍是 19px。

### 终端：输入

- **输入延迟**：按键立即发送，不等上一次写入的回复（WebSocket 保证顺序）。键入的文字在最多 8 ms 的窗口内合并成一次 `terminal.write`；Enter、Tab、Ctrl 组合键、Esc / 方向键序列、粘贴和输入法上屏立即发送（连同未发出的文字，顺序不变）。
- **调整大小防抖**：尺寸停止变化 150 ms 后才 resize 一次（`RESIZE_DEBOUNCE`），之后等 shell 重画完（输出停下 40 ms，最多 600 ms）再处理下一次，避免折行的输入行留下多份。
- **输入法**（`src/lib/imeInput.ts`）：xterm 从隐藏输入框的内容推算上屏文字，而这个输入框从不清空，除了 Chrome 的事件顺序都会重复发送（WebKitGTK + fcitx5 / ibus：“你好今天” → “你好今天今天”）。现在上屏文字取自 `compositionend`（或没有组字事件时的 `insertText`），两条路径同时到达时只发一次，每次上屏后清空输入框。组字文字显示在光标处，带橙色下划线。fcitx5 在 WebKitGTK 里可能不发 `compositionstart`；ibus-hangul 会发空的 `compositionend`。
- **粘贴**：Ctrl+Shift+V 时 Chrome 和 WebKitGTK 自己会触发粘贴，只在浏览器没有粘贴时才读剪贴板。
- **本地 bash 启动文件**：`bash --rcfile ~/.metroterm/shell/bashrc -i`，按登录 shell 的顺序读取 `/etc/profile` 和 `~/.bash_profile`（或 `~/.bash_login`、`~/.profile`），然后 `shopt -u hostcomplete`（否则 `@` 开头的词按主机名补全，会补成 `cd \@babel/`），并关闭 readline 的 `enable-active-region`（粘贴不带反色）。
- **本地 zsh**：`~/.metroterm/shell/zsh/` 的启动文件先读用户自己的 `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin`，再设置 `zle_highlight=(paste:none)`。
- **UTF-8**（`src-rust/src/locale.rs`）：继承的环境没有 UTF-8 locale 时（容器、systemd、Finder 启动的 macOS 应用），设置原语言的 UTF-8 版本，否则 `C.UTF-8` / `en_US.UTF-8`。SSH 连接像 OpenSSH `SendEnv` 一样发送 UTF-8 的 `LANG`。
- **本地 shell 列表**：后端 `system.shells` 读 PATH 和 `/etc/shells`（Windows：pwsh、PowerShell、cmd、WSL、Git Bash）。

### 终端：查找、选区与菜单

- **查找**（`src/lib/terminalFind.ts`）：在整个回滚记录里不区分大小写查找，折行的行接起来查，中文按实际格子框选。匹配用 1px 实线边框框住、不填背景（`TerminalView.tsx` 的 `FIND_COLORS`：深色当前 `#9a9a9a` / 其它 `#5e5e5e`，浅色 `#707070` / `#a8a8a8`）。第一次查找从打开时看到的位置开始；有新输出时自动重查，当前匹配保持在原文字上；“查所有”只画屏幕附近的框，最多统计 10000 个。打开查找框用 `flushSync` + 同步 focus。
- **相同内容高亮**（`src/lib/selectionMatches.ts`）：单行、2–200 个字符的选区，屏幕上相同的文字（区分大小写）用灰底标出（深色 `#3a3a3a`，浅色 `#e2e2e2`），无边框；只处理视口附近的行。
- **右键菜单 / 保存**：Save Selection As… / Save Output As… 桌面版弹出系统“另存为”对话框，由后端 `file.saveText` 写入；浏览器版用 `showSaveFilePicker`，不支持时退回下载。
- **Session → Disconnect**：只断开当前终端；没有其他终端在用这条 SSH 连接时一起断开。

### 滚动条

所有滚动区域的滚动条由 `src/lib/customScrollbars.ts` 自绘，不依赖 `::-webkit-scrollbar`，各引擎外观一致。

- 直角，无箭头，10px 宽，滑块 6px；宽度和颜色由 `--sb-size`、`--sb-pad`、`--sb-thumb*` 控制。加上 `data-scrollbar` 属性的元素也会使用。
- 宽度通过透明边框预留；预留了位置的区域用 `--sb-reserve: 1` 标记，滚动条按浏览器实际画出的预留宽度绘制（非 100% 缩放时边框宽度会被取整，不能从宽度反推）。位置按元素的小数边界计算并对齐到屏幕像素。带固定表头的列表从表头下方开始。
- 层级：滚动条放在 `<body>` 下一个不形成层叠上下文的 `.sb-layer` 里，每个滚动条的 `z-index` 取所在表面的层级 + 1；主界面上为 3（面板内容之上、分隔条之下）。
- 点击外部关闭的弹出层（菜单搜索、菜单栏菜单、下拉 / 右键菜单、Select、ComboBox、文件夹选择）判断“外部”时用 `pressTarget(event)`：滚动条不在所属元素里（在 `.sb-layer`），`trackOwners`（WeakMap：track → 滚动元素）把按在滚动条上的点击算作按在它滚动的元素上——以前点菜单搜索结果列表的滚动条会关闭弹窗。
- 系统滚动条：`.sb-custom` 用 `scrollbar-width: none` 和 `::-webkit-scrollbar { display: none }` 隐藏。WebKit（macOS WKWebView、Safari、WebKitGTK）在创建滚动条时决定用系统样式还是 `::-webkit-scrollbar` 样式，之后不再改；加 `sb-custom` 之前已经溢出的区域（列很宽的 Filer 从第一次布局就有横向滚动条）在 macOS 上会在自绘滚动条下面留着系统滚动条。所以加类后 `recreateNativeScrollbars` 把 `overflow` 临时设成 `hidden` 再恢复（各强制一次布局），让引擎按新样式重建滚动条，并恢复滚动位置；只对已经溢出的区域做。
- 每帧只更新一次；仅滚动时只用 `transform` 移动滑块。滚动区域只在启动时搜索一次整个文档，之后只在新加入的元素里查找（离开文档的通过 `isConnected` 发现）。

### 布局与面板

- 布局是可拖拽、可 Split 的面板树（`components/SplitPane.tsx`，`SplitState {ratio, collapsed}`）。左侧 Explorer / Filer，右侧终端 + 标签栏在上、Sender 在下。
- 面板小于最小尺寸就隐藏、另一侧占满，句柄留在边缘可拖回。默认最小 180px；Sender 所在的右下面板单独设为 90px（`SENDER_MIN_PANEL_SIZE`），这是面板位置的属性，不跟着 Sender 走。
- **分隔线不被面板内容盖住**：显示缩放为 125% / 150% 时，面板边缘落在半像素上，带 GPU 图层的内容（如 Filer 的 sticky 表头）的裁剪会向外取整 1 个设备像素，盖住分隔线的第一列像素。每条 `.split-handle` 都有自己的合成图层（`will-change: transform; transform: translateZ(0)`）。
- 面板标题栏的 Settings 下拉：Split（上下 / 左右）和添加 Explorer / Filer / Sender / Session 标签（已打开的忽略）。Hide 即销毁面板。
- **拖动标签**（`src/lib/tabDrag.ts`）：标签栏标 `data-tab-strip`（id）和 `data-tab-group`（`panel` / `terminal`），竖排列表加 `data-tab-axis="y"`；每个标签标 `data-tab-key`。标签的 `onPointerDown` 调 `startTabDrag`，移动 5px 后才算拖动，所以单击、双击、右键不受影响；关闭按钮（`data-tab-close`）和改名输入框不触发拖动。落点由 `elementFromPoint` 找到同组的标签栏，按标签中线算出“放在哪个标签之前”，结果是 `{strip, before}`；放回原位视为无变化。拖动过程中幽灵标签和落点标记是直接创建、改 `transform` / 位置的 DOM 节点，不经过 React，指针移动不会重渲染 App（react-best-practices 的 rerender-use-ref-transient-values）；只有放下时更新一次状态。拖动结束时吞掉随后的那次 click，避免误激活或误关闭。标签栏可滚动时，拖到边缘会自动滚动。
  - 面板标签：`layout.ts` 的 `moveTab(root, from, view, to, before)`；同一面板是重排，不同面板是移动（源面板按 closeTab 的规则激活相邻标签或变空，目标面板已有该视图时拒绝），被拖的标签成为当前标签。移到别的面板时内容会重新挂载（Filer、Monitor 等按新面板重新加载）。
  - 终端标签：标签栏和 Session 面板同属 `terminal` 组，都用 `moveBefore` 调整 `terminalTabs` 的顺序（Session 面板有过滤时按 key 插入，不受过滤影响）。默认标题里的序号（`bash (2)`）按顺序重新编号。
- **终端全屏**：隐藏其他面板，内容和状态保留，布局不写入 `sessions.json`。分屏时只显示点击的那个窗格（`enterTerminalFull`：聚焦该窗格并打开 tmux 放大），退出时（按钮、切换窗口、最后一个标签关闭，都走 `leaveTerminalFull`）把那个窗口的放大状态恢复成进入前的样子（`fullRestore`）。进入和退出后 `refocusTerminal` 把键盘还给焦点窗格的终端（以前焦点留在按钮上，Ctrl+B 和输入都无效，直到点一下终端）。`TerminalView` 的 `active` 变成 false 时清掉自己的焦点状态：textarea 仍是焦点就 `terminal.blur()`，否则若 xterm 还带 `focus` 类就给 textarea 派发一个 `blur` 事件——WebKit 隐藏有焦点的元素时不发 blur（全屏会隐藏其他窗格），xterm 会一直以为自己有焦点，两个窗格同时显示实心光标。
- 隐藏元素统一用 `[hidden]{display:none!important}`，因为显式 `display` 会盖过 `hidden` 属性。

### Explorer 与 Session 面板

- 会话树（`components/SessionTree.tsx`）：文件夹无限嵌套，可拖动排序 / 移入；文件夹不能拖进自己或子文件夹，Esc 取消拖动。
- 每个 Explorer 面板各自记录折叠状态（`ExplorerDoc { panels }`，`explorerFolds`、`toggleFolder(panel, id)`），Expand / Collapse all 只作用于当前面板；关闭的面板、删除的文件夹会被清理。
- Explorer 的筛选框和 NEW 按钮在同一行（`.session-quickbar` 里的 `input.session-filter`）。Explorer 里没有重连（顶栏、会话行的悬停按钮、右键菜单都没有）；重连在终端标签的右键菜单、窗格的 ⋮ 菜单和 Session 菜单里。每个 Explorer 面板有自己的 “Filter sessions” 筛选文字（`App.tsx` 的 `filters: Record<panelId, string>`），不写入配置。
- “所在文件夹”下拉框是树形组件（`components/FolderTreeSelect.tsx`），支持 ↑ ↓ Home End → ← Enter Esc。
- Session 面板（`components/SessionsPanel.tsx`）管理打开的终端标签；提示用左标题、右内容的表格（`TooltipLayer`）。
- 关闭标签的所有途径都经过 `closeTabs` → `closeConfirm` → `doCloseTabs`。

### Filer

- 跟随当前终端标签；本地会话浏览本机，SSH 会话通过 SFTP 浏览远程并共用 SSH 连接。
- 表头 `.filer-head` 是 `.filer-list` 滚动容器里的 sticky 行（z-index 1），列宽 CSS 变量 `--filer-cols`；列名靠左，排序箭头 8px、在列名右侧靠近分隔竖线；**Size 和 Date Modified 的列名与数值都右对齐**；排序箭头在所有列都放在列的最后（分隔竖线旁），所以这两列排序时列名紧挨在箭头左边，未排序时列名右端与数值右端对齐。分隔竖线在 12px 列间距的正中（`.filer-col-resizer` 必须 `margin: 0`，否则 `.filer-list i` 给图标的 8px 间距会把竖线拉进本列，右对齐的文字会压在线上）。列宽最小：名称 80px、其它 40px。
- 列宽、排序、自动跳转写入 `sessions.json` 的 `filer`，松开鼠标 / 双击 / 改排序时立即写入。
- 搜索当前目录：名称包含即匹配，匹配部分用中性灰底（深色 `rgba(255,255,255,.17)`，浅色 `rgba(0,0,0,.085)`）。
- **自动跳转原理**：本地终端读 `/proc/<pid>/cwd`（优先前台进程；macOS 用 `lsof`；Windows 见下）。SSH 终端启动 shell 时附带 `LC_METROTERM_SESSION`（多数服务器 `AcceptEnv LANG LC_*`），之后在同一条连接上开临时 exec 通道，按这个变量找到 shell 并读 `/proc/<pid>/cwd`，不往终端输入任何东西。也识别 OSC 7 和 OSC 9;9（ConEmu / Windows Terminal 的当前目录序列）。只在回车后输出停下约 0.25 秒时查询一次（持续输出时最多每 3 秒一次）。
- **Windows 上的自动跳转 / Terminal folder**（`src-rust/src/wincwd.rs`）：Windows 没有 /proc，进程的当前目录在进程自己的内存里——`NtQueryInformationProcess` 取 PEB，`ReadProcessMemory` 读 `ProcessParameters.CurrentDirectory`（Process Explorer 显示的 “Current directory” 就是它，同一用户的进程都能读）。先用 Toolhelp 快照沿“最新启动、仍在运行的子进程”往下找（终端里又开的 cmd / pwsh；按父进程号**和**启动时间匹配，防止进程号被复用；跳过 conhost / OpenConsole），读不到再读 shell 自己。cmd 的 `cd` 和 Git Bash（MSYS 直接改 PEB）会改进程目录；**PowerShell 的 `cd`（Set-Location）不会**，所以本地 pwsh / powershell 启动时带 `-NoExit -Command <钩子>`（`terminal.rs` 的 `POWERSHELL_HOOK`，在用户 profile 之后执行，包住 profile 里的 prompt，oh-my-posh / starship 照常）：每次提示符把 `[Environment]::CurrentDirectory` 设为当前位置（只限 FileSystem，`HKLM:` 之类不管），并在提示符前输出 OSC 9;9。钩子写成一行、不含双引号：行内命令不受脚本执行策略限制，参数原样传给 PowerShell。WSL 里的 shell 不回答（它的 Windows 目录与 Linux 里的位置无关）。路径统一成 Filer 的写法 `C:/Users/me`（盘符根目录 `C:/`）；前端 `filerPath()` 也把 OSC 7 的 `file:///C:/x`（以前变成 `/C:/x`，`fs.list` 打不开）和 OSC 9;9 的 `C:\x\` 转成同样的形式。
- 复制路径到终端：含特殊字符时单引号括起（`'/tmp/my dir/it'\''s'`）。
- Owner / Group：本地读 `/etc/passwd`、`/etc/group`，SFTP 读服务器上的这两个文件（取不到时显示数字 ID）。
- 错误提示不带重试，25 秒后自动关闭（传输失败另见传输批次，可重试）。
- **多选**：`selected` 是主项（键盘焦点、Enter / F2、Shift+↑↓ 移动的那一项），`pickedPaths` 是选中的路径，`anchorRef` 是 Shift 范围的起点（最近一次不带 Shift 的点击）。`chosen` = 当前列表里被选中的项（列表顺序），没有时为主项；删除（`Dialog.files`）、移动 / 复制（`destination.files`，`FilerDestinationDialog` 收 `files`，对每一项检查同名 / 放进自身）、复制路径、路径到终端、下载（`downloadMany`：桌面版选一次文件夹，浏览器每个文件一次下载）都作用于 `chosen`。在选区内右键保留选区，选区外右键只选那一项。选中项只用背景色表示，不加边框 / 描边（主项也没有单独标记，列表按钮的 focus-visible 描边也去掉了）。不在当前列表里的项（换了目录、被搜索过滤掉）不计入。
- **移动到… / 复制到…**（右键菜单，在 Delete 之后）：`components/FilerDestinationDialog.tsx` 选目标目录（`fs.list` 只列文件夹，路径框回车进入、再回车提交，↑ 上一级）。前端先拦截：目标是自身或在自身里面（`isInside`）、已在该目录、该目录里已有同名项（文件和文件夹都算）。后端 `fs.copy` / `fs.move` 再检查一遍（空路径、`/`、自身内部、目标已存在都拒绝）。
  - 复制 `Fs::copy_tree` 递归：链接按链接复制，权限照搬，目录权限最后设置（只读目录也能先写入内容）；新文件用 create_new / SFTP `CREATE|EXCLUDE`，绝不覆盖。
  - 移动用 rename；本机跨文件系统（EXDEV）时退回复制再删除。SFTP 的 symlink 参数顺序 OpenSSH 与规范相反，`sftp_symlink` 两种顺序都试并用 `read_link` 验证。
  - 进度和结果同样走传输批次（见下一条），遇到第一个失败就停，Retry 继续剩下的；复制后保留原选中项。
- **传输批次**（`components/FilerTransfers.tsx`）：上传（浏览器选择 / 拖入的 File、桌面版本机路径，文件夹先遍历：建好目录，里面每个文件是一项，名称是相对路径）、下载、移动、复制，每次操作是一个批次 `useTransfers().run(direction, folder, jobs)`，文件逐个执行，`transferId` 就是该项的 id，后端的 `transfer.progress` 事件按 id 更新进度。
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

- `Transport` 枚举（Rust `ssh.rs`、TS `types.ts`）：`local`、`ssh`、`telnet`、`tcp`、`serial`。会话配置多了 `noProxy`、`localEcho`、`serial`（`device`、`baudRate`、`dataBits`、`parity`、`stopBits`、`flowControl`）。
- `terminal.rs` 的 `Handle::Stream` 只持有一个输入通道（`stream::Input::Data / Resize / Close`）；读写在 `stream.rs` 的任务 / 线程里。在线 / 离线状态和本地 shell 一样按打开的终端数计算（`local_counts`）。
- Telnet：`Telnet` 结构是纯函数式的协商器（字节进 → 数据 + 回应出，有单元测试）。接受服务器的 ECHO / SGA / BINARY，自己提供 NAWS（窗口大小，0xFF 转义）和 TTYPE（`XTERM-256COLOR`）；其他选项拒绝；状态不变时不回应，避免协商循环。非二进制模式下回车发送为 CR NUL，收到的 CR NUL 还原成 CR。
- 串口：`serialport` 关闭默认 feature（不依赖 libudev，Linux 上通过 /sys 枚举端口）；读线程 100ms 超时轮询关闭标志，写线程从通道取数据。
- 代理：`net::connect(host, port, proxy)`，SSH / Telnet / TCP 共用；代理配置由后端每次连接时从 `settings.json` 的 `proxy` 读取（所以 UI 必须把 `proxy`、`log`、`appearance` 一起写回 settings.json）。SOCKS5 用域名方式（ATYP 3）；HTTP CONNECT 逐字节读响应头，不多读隧道数据。总超时 15 秒。
- 软件日志：`applog::init()` 在 `Backend::new` 里执行一次，读取 `settings.json` 的 `log`。info 级别只记录 metroterm 自己和 UI（`ui` target）的记录，依赖库（russh、tokio…）的 info 以下只有 Debug / Trace 时才写。RPC 失败统一在 `Backend::dispatch` 里记 warn。

### Sender

- Line（逐行加回车，Interval 单位秒，是重复之间的间隔）/ Char（逐字符，Interval 单位毫秒、最小 20，每个间隔发一个字符，换行发回车）；Count 重复次数；■ Stop 或 Esc 取消未发送的内容。
- Targets：Current Session / Select Session / All Sessions。Select Session 时 `.sender-editor` 加 `has-targets`，右侧第三列 `.sender-targets` 列出打开的终端标签（`tabTitle` 由 App 传入），勾选状态是标签 id 列表，发送时忽略已关闭的标签。
- 拖入文件：`.sender-editor` 标 `data-file-drop="sender"`，放下时把 `shellQuote` 过的路径（空格分隔）插入到 textarea 光标处（替换选区），再把光标放到插入内容之后。
- 工具栏变窄时换行（`flex-wrap`），不隐藏控件。

### Monitor

- `components/MonitorPanel.tsx` 跟随当前终端标签的会话（与 Filer 相同），按选定间隔调用 `monitor.sample`；用 `setTimeout` 链，上一次返回后才排下一次。面板不可见（`offsetParent === null` 或 `document.hidden`）时不采样，每 0.5 s 检查一次。换会话时清空曲线。
- 本机（`src-rust/src/monitor.rs`）：`sysinfo` 0.36（`default-features = false`，只开 `system`、`disk`、`network`、`user`），三个平台都可用。`System` 等对象保存在 `Monitor` 里，CPU / 网络 / 磁盘速率由 sysinfo 两次刷新的差值给出。Linux 上 sysinfo 把线程也列成任务，按 `thread_kind() == Userland` 过滤掉，进程数与 `ps -e` 一致。
- SSH：在会话已有的连接上开 exec 通道执行 `sh -s`，脚本从 stdin 发送（不受登录 shell 是 fish / csh 的影响，也不用转义）。输出按 `@name` 分段，10 s 超时。
  - Linux：`/proc/stat`（CPU，空闲 = idle + iowait）、`/proc/meminfo`（已用 = MemTotal − MemAvailable）、`/proc/net/dev`、`/proc/diskstats`（只计 `/sys/block` 里的整盘，跳过 loop / dm / md / zram 等；扇区按 512 字节）、`df -kP`、`/proc/<pid>/stat`。进程列表来自 `ps -eo pid,user,pcpu,rss,args`，名称取 `/proc/<pid>/stat` 的 comm（与 top 一致）。进程 CPU 用两次采样的 utime + stime 差值除以 `CLK_TCK`（`ps` 的 pcpu 是进程整个生命周期的平均值），第一次采样先用 `ps` 的结果。
  - macOS：`sysctl`（boottime、loadavg、hw.ncpu、hw.memsize、vm.swapusage）、`vm_stat`（已用 = 匿名页 − 可清除页 + wired + 压缩，与活动监视器的“已使用内存”一致）、`netstat -ibn` 的 `<Link#n>` 行、`ps -Ao pid,comm`（名称）和 `ps -Ao pid,user,%cpu,rss,args`。总 CPU 为所有进程 `%cpu` 之和除以核数；没有磁盘读写速率（显示为不提供而不是 0）。
  - 不统计回环和容器虚拟网卡（`lo`、`veth*`、`docker*`、`br-*`、`virbr*`、`cni*`、`flannel*`、`cali*`、`kube*`），避免流量重复计算。
  - 上一次的累计值按连接 id 保存在 `Monitor.previous`，`connection.disconnect` 时清掉。
- `SshPool::connected(id)` 只返回已有且未关闭的连接，从不发起连接，所以 Monitor 不会弹出主机密钥或密码询问。
- 进程列表（`components/MonitorProcesses.tsx`）：排序、搜索都在前端完成（每次采样都带全部进程），先按名称过滤、再排序，最后只渲染前 `LIMIT`（20）行。搜索框平时隐藏（`search` 为 `null`），Ctrl+F 由 `MonitorPanel` 的根元素（`tabIndex=-1`，点面板任意位置后都能收到）处理，通过 `searchRequest` 计数通知列表；搜索行与 Filer 的搜索框共用 `.pane-filter`（同样的高度、边框、聚焦样式、放大镜和 × 按钮），只额外加 `.monitor-procs-searchbar` 处理 sticky 位置；输入框在显示它的那次渲染之后由 effect 聚焦（`requestAnimationFrame` 时输入框可能还没渲染）。`.monitor-body` 带 `data-scrollbar`，与其他面板用同一套自定义滚动条，并在 `--sb-reserve` 规则里留出滚动条宽度；选中按 PID 记住，CPU 排序时行会移动，但选中不丢。只有键盘选择会把行滚进可见区：`ContextMenu` 在滚动时关闭，鼠标右键选中时不能滚动。行的 `scroll-margin-top` 让出两层 sticky 表头。
- `monitor.signal`：
  - 本机 Unix：`kill(2)`，错误取 `last_os_error`，去掉“(os error N)”。拒绝 PID 0 和 MetroTerm 自己的 PID。
  - 本机 Windows：TERM 用 `taskkill /PID`（不加 /F，`CREATE_NO_WINDOW`），KILL 用 sysinfo 的 `Process::kill`（TerminateProcess）。
  - SSH：exec 通道执行 `kill -TERM|-KILL <pid>`（PID 是数字，无需转义），非零退出码时把 stderr 最后一行里 “ - ” 或 “: ” 之后的原因作为错误返回。权限就是 SSH 用户的权限，不用 sudo。
  - 前端在确认框（`TreeDialog`）确认后才调用；成功后状态栏提示，并在 0.3 s 后立即重新采样；失败原因在面板顶部显示 8 秒（采样不会清掉它），同时写到状态栏。

### 隧道（Tunnels）

- 后端 `src-rust/src/tunnel.rs`，`Tunnels` 按隧道 id 保存运行中的任务和计数（当前 / 累计连接、收发字节）。所有隧道都用会话已有的 SSH 连接（`SshPool`，与终端、Filer 共用），没有连接时先连接。
  - **本地**：`TcpListener` 监听，每个连接开 `direct-tcpip` 通道到目标，`copy_bidirectional` 双向转发并计数。
  - **动态**：同样监听，先在本机完成 SOCKS 握手（SOCKS5 无认证，CONNECT，域名 / IPv4 / IPv6；SOCKS4 / 4a），再开 `direct-tcpip`；域名交给 SSH 服务器解析。通道打不开时回 SOCKS 失败码，状态里记下原因。
  - **远程**：`tcpip_forward` 请求服务器监听；服务器发来的 `forwarded-tcpip` 通道（`ssh.rs` 的 `server_channel_open_forwarded_tcpip`）按 (连接 id, 端口) 在 `RemoteForwards` 里找到隧道，再由本机连接目标（经 `net.rs`，不走 Session → Proxy）。停止时 `cancel_tcpip_forward`。
  - SSH 连接断开时隧道任务结束，状态变成 `error` / “SSH connection closed”，保留在 `tunnel.list` 里直到再次启动或停止。错误信息转成可读的句子（端口被占用、需要特权端口、服务器拒绝转发、目标拒绝连接等）。
  - `shutdown`（桌面版关窗、浏览器模式 WebSocket 断开）时 `stop_all`。
- 前端：配置在 `lib/tunnels.ts`（保存到 sessions.json 的 `tunnels` 段），运行状态在 `lib/tunnelRuntime.ts`。后者是 React 之外的 store：对话框打开时每秒、有隧道运行时每 5 秒轮询 `tunnel.list`，其余时间不轮询；`starting` 和启动失败的原因只在前端记。菜单栏按钮用 `useSyncExternalStore(tunnelRuntime.subscribe, tunnelRuntime.getRunningCount)` 只订阅运行数，轮询不会重渲染整个 App；对话框订阅 `getViews`。
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

- 菜单栏（`components/MenuBar.tsx`）：Session / View / Mode / Tool / Window / Help。Session 菜单参照 WindTerm；依赖当前终端的项在没有终端时置灰。Tool → Triggers… 是占位（置灰）。Window 菜单见下一条。
- **多窗口（Window 菜单）**：App 的 `windows: WorkWindow[]`（`{id, name, layout, activeTabId}`）+ 当前 `windowId`；所有终端标签放在 `allTabs`，每个标签带 `windowId`。`layout` / `activeTabId` / `terminalTabs` 由当前窗口派生，`setLayout` / `setActiveTabId` / `setTerminalTabs` 只改当前窗口（通过 `windowIdRef`，回调里也不会拿到旧窗口）。
  - 所有窗口的 TerminalView 都挂在终端面板里（`terminalStack` 按创建顺序，切换窗口不移动 DOM），只显示当前窗口的当前标签；每个窗口的终端叶子 id 固定为 `terminal`，共用同一个 portal host。
  - 其他窗口的内容面板也一直渲染（portal 到不在文档里的 host），用该窗口的 `WindowCtx`（它的标签、当前标签和会话），所以 Sender 文字、Filer 位置等切换后保留。叶子 id 因此在所有窗口间唯一：新窗口和恢复时用 `uniqueLeaves` 给重复的 id 加 `win-N/` 前缀。
  - “Send Selection to Sender” 只发给当前显示窗口里的 Sender（`SenderPanel` 的 `shown()` 检查 `isConnected`）。
  - 删除会话 / 文件夹会关闭所有窗口里的对应标签；共享 SSH 连接的判断（disconnectTab）也看所有窗口。
  - 快捷键 Ctrl+Shift+1…9、Ctrl+Shift+PgUp / PgDn（Remote Mode 下终端里的按键不处理）。状态栏 `.status-windows` 的按钮右键打开 `statusWindowMenuItems`（显示、改名、`moveWindow` 左移 / 右移、新建、关闭），用 `--status-window-*` 变量，三个主题都是中性色。
- Mode 菜单：Full Screen（图标随状态切换：全屏时显示退出全屏的图标；F11；桌面版 `window_set_state` 的 `fullscreen`，浏览器用 Fullscreen API）、Always On Top（桌面版），勾选状态由 `syncWindowModes` 从窗口读取（resize / fullscreenchange / 专注模式进出后）。Local / Remote Mode 保存在 `settings.json` → `terminal.keyMode`：Remote 时 App 的快捷键处理对 `.xterm` 里的按键直接返回，TerminalView 的 `attachCustomKeyEventHandler` 也不拦截任何键；Local 时额外处理 Ctrl+C（有选中才复制）和 Ctrl+V（原生 paste 事件，150ms 内没有才读剪贴板）。
- 下拉 / 右键菜单（`components/MenuButton.tsx`）是 `position: fixed`，并且通过 `createPortal` 渲染到 `overlayHost()`（`.metroterm-shell`，保留主题类和字体变量），不会被工具栏的 `overflow` 裁掉，也不会被面板 / 窗格里的层叠上下文（如 `.tmux-splitter`）盖住；层级只低于锁屏（`.lock-screen` z-index 1500）。注意：portal 出去的菜单不再匹配祖先限定的选择器（如 `.sender-pane .ui-select-menu`）。
- 菜单搜索（`components/CommandPalette.tsx`，结果列表 `.command-palette-list` 用自绘滚动条，`React.lazy` 按需加载，鼠标移到 🔍 上时预加载）：打开时把 `menuBar` 展平成 `菜单 / 子菜单 / 命令` 列表（跳过禁用项），多个词顺序不限，同时匹配显示的译文、英文原文和快捷键提示，命令名以查询开头的排在前面。🔍 按钮（`data-palette-toggle`）和 Ctrl+Shift+P 切换开关；面板打开时 App 的快捷键处理忽略来自 `.command-palette` 的按键。关闭后焦点回到原来的元素（通常是终端）。
- 弹窗统一结构：标题栏、内容区左右 16px、底部操作栏；控件同高 `--dialog-control: 32px`。Esc 先关下拉再关弹窗。
- 弹窗边框：深色 `#616161`；浅色 `#8c8c8c`（原来的 `--line` `#cfcfcf` 在变暗的遮罩上几乎看不见），浅色阴影 `rgba(0,0,0,.16)`。
- 输入框：统一 `autocomplete="off"`；不出现浏览器默认右键菜单，改用应用菜单；桌面版开启 WebKitGTK 的 `javascript-can-access-clipboard`，Paste 不弹确认。
- 自绘光标（`src/lib/appCaret.ts`）：原生光标设为透明，用隐藏的镜像元素测量光标位置画 2px 宽、约 1.25 倍字号高的竖线（镜像需要 `overflow: hidden` 和零宽空格标记）。数字 / email 输入框没有 `selectionStart`，所以 PORT 改为只允许数字的文本框。相关 CSS 需要 `!important`。
- SHELL 输入框是自定义 ComboBox，不用 datalist。
- 自定义提示框：约 1.5 秒延迟，显示在鼠标右下方并保持在窗口内；带 `title` 的按钮会把它转成 `data-tip`。

### 日志（`lib/log.ts`）

- 所有 UI 消息都用 `log`：`log(msg)` = `log.info`；`log.warn(msg, error?)`、`log.error(msg, error?)` 会拼上错误文本（`errorText`）。info / warn / error 显示在状态栏（`useActivity()`），并通过后端 `log.write` 写入软件日志；`debug` / `trace` 只写日志；`{ quiet: true }` 不改状态栏。开发模式下同时输出到浏览器控制台。
- 组件直接 `import { log }`，不再通过 `onStatus` / `onLog` 属性传递。不要再直接用 `console.*`（vendor 代码除外）。

### 窗格（tmux 风格分屏，WindTerm 式标签组）

- 数据：每个窗口（`WorkWindow`）有 `tmux`（`TmuxNode` 树，叶子是窗格 id `p-N`；没有 = 一个窗格 `p-1`）、`tmuxActive`（各窗格显示的标签）、`tmuxZoomed`；每个标签（`TerminalTab`）有 `tmuxPane`。窗口的 `activeTabId` 就是焦点窗格显示的标签，焦点窗格 = 它所在的窗格；`setActiveTabId` 切换时把失去焦点的窗格当前标签记进 `tmuxActive`。
- `tmuxView(tree, tabs, activeTabId, tmuxActive)`（`lib/tmux.ts`）算出要显示的窗格：按树的顺序列出窗格、字母、标签和显示的标签；树里没有的 `tmuxPane` 归第一个窗格，空窗格被裁掉。App 的一个 effect 把裁剪结果写回窗口、把每个标签的 `tmuxPane` 写成实际所在窗格，保存的数据始终一致。
- 渲染：`.tmux-stage` 里每个窗格是绝对定位的 `.tmux-pane`（`tmuxStyle`：不在左 / 上边缘的窗格让出 1px，露出 `--tmux-line` 背景作分隔线），里面是标签栏（`data-tab-strip="tmux:<窗格 id>"`，可互相拖放标签）、工具栏（窄窗格里会换行）和 `.tmux-body` 占位。所有窗口的 `.terminal-instance` 仍然按创建顺序常驻在 stage 里，不随窗格移动 DOM：`measureTmux` 在每次渲染后（以及 ResizeObserver 回调里）量出各 `.tmux-body` 的位置，窗格显示的标签的终端就放到那个框上，其余隐藏。位置用 `getBoundingClientRect` 的小数边缘**向内**取整到整像素（左 / 上 `ceil`、右 / 下 `floor`）：以前用 `offsetLeft` / `offsetWidth` 各自四舍五入，窗格边缘落在小数像素（百分比位置）时终端框会比窗格多出半个像素，不透明的终端背景盖住 1px 的分隔线间隙，分隔线在某些位置消失（4 个窗格拖动扫描时 120 个位置里 33–54 个不可见，改后 0 个）。向内取整留下的不到 1px 缝隙露出的是窗格自己的背景（终端底色）。`.tmux-splitter` 可拖动（`tmuxSetRatio`）；放大时只显示焦点窗格。
- 操作：`splitTerminal`（新窗格 + 同一会话的新标签）、`breakTab`（`!`，标签移到右侧新窗格，窗格里至少要有两个标签）、`moveTabToPane`（拖放）、`closeTmuxPane`（`x`，关闭窗格里的所有标签）、`focusTmuxPane`、`newTabInPane`（Ctrl+B `c`）。`doCloseTabs` 关闭当前标签时先选同一窗格的右 / 左邻居，再选其他窗格显示的标签。
- tmux 前缀：App 的快捷键处理在 Remote Mode 检查之后、焦点在终端里时处理 Ctrl+B（`prefixRef`，状态栏 `.status-prefix`），下一键交给 `tmuxCommand`，未绑定的键被吞掉。Remote Mode 下 Ctrl+B 发给远程。
- 颜色变量：`--tmux-line`、`--tmux-focus-line`、`--tmux-letter-ink`、`--tmux-idle-tab-ink`、`--status-prefix-bg/-ink`。分隔线本身不变色：拖动时 `startTmuxDrag` 给 `<html>` 加 `is-tmux-resizing-row/-column`（全局 col-/row-resize 指针、禁止选中），pointermove 按 requestAnimationFrame 合并。
- 窗格工具栏：`tmuxToolbar(pane)` 的 `.toolbar-right` 依次是 `.tmux-letter`（`components/PaneLetter.tsx`，26px 格子里的 SVG `<text>`；只有一个窗格时不显示）、收藏、⋮（`tmuxPaneMenu`：分屏、放大、关闭窗格；时间 / 行号的开关在 View 菜单）。字母与图标对齐：14px 图标的笔画在 16 格里画在 1..12，墨迹中心在 12.5px；用 CSS 让文本框居中不可靠，因为大写字母在行框里的高度取决于字体的 ascent / descent，不同系统的界面字体不同（deb80 的 padding 方案在测试字体下对齐，在用户系统上高了 1–1.5px）。现在用 canvas `measureText` 按同样的计算字体量出字形墨迹（`actualBoundingBoxAscent/Descent/Left/Right`），把墨迹中心放到 (12.5, 12.5)，只依赖字形本身，与行高 / ascent 无关；字体加载完（`document.fonts.ready`）和焦点变化（加粗）时重新测量。Chromium 和 WebKitGTK 在 100% / 125% / 150% 下、换成 DejaVu Sans / Liberation Serif / Noto Sans CJK / monospace 测试，与星形 / 复制图标的墨迹中心相差都不超过半个设备像素。左侧 `.toolbar-icons` 依次是全屏、查找、分隔、克隆会话（原来 Session info 按钮的位置，已删除）、重连。标签栏里只有标签。

### 国际化（react-i18next）

- `src/i18n/index.ts` 初始化 i18next：键就是英文原文（`keySeparator` / `nsSeparator` 关闭），英文没有资源文件，缺少翻译时显示英文；`zh.json` 是英文 → 中文。插值用 `{{name}}`。
- 用法：`t('Close tab')`、`t('{{name}} connected', { name })`；带代码片段的句子用 `tc('Delete <c>{{name}}</c>?', { name })`，`<c>…</c>` 渲染成 `<code>`。`t` 是普通函数，组件外也能用。
- 语言：`settings.json` 的 `language`，`main.tsx` 在首次渲染前 `setLanguage`；Settings → LANGUAGE 保存后 `setLanguage` 并更新 `<html lang>`。App 调用 `useTranslation()` 订阅语言变化，整个树随之重新渲染；`memo` 组件（`TunnelRow`）自己调用 `useTranslation()`。
- 模块级表格（`PANEL_VIEWS`、`TRANSPORTS`、`TUNNEL_KINDS`、Filer / Monitor 的列名、`TYPE_NAMES` 等）保留英文，在显示的地方 `t(item.label)`；`Select`、`ComboBox`、`MenuButton`、`MenuBar` 对 label / hint 统一调用 `t`（已翻译的文字再 `t` 一次不变）。
- 新增文字：写成完整句子（不要拼接英文片段），然后在 `zh.json` 加对应翻译。会话名、文件名、路径等用户数据不翻译。

### 桌面外壳与窗口

- **字体抗锯齿**：WebKitGTK 只能在不透明像素上画次像素文字，悬停 / 选中时文字会在灰度和彩色次像素之间切换。桌面版启动时把应用内 GTK 字体设置改为灰度抗锯齿 + 轻微 hinting（`desktop.rs` 的 `apply_font_rendering`）。
- **窗口背景**：`html`、`body` 跟随主题（`#171717` / `#ececea`），原生窗口和 WebView 背景同步（`tauri.conf.json` 的 `backgroundColor`、`set_window_background`），调整窗口大小时不露白。
- **标题栏**：FRAMELESS / NATIVE 二选一（`settings.json` 的 `titleBar`），启动时直接以所选样式创建窗口。浏览器模式（`isDesktop()` 为 false）不渲染 `.window-chrome`，Settings 也隐藏 TITLE BAR 一项（`SettingsDialog` 的 `desktop` 属性）；页面标题仍通过 `document.title` 显示当前标签。
- **macOS 的无边框**：不能用 `decorations(false)`——那样是 borderless 窗口，AppKit 不最小化它（没有 miniaturizable 样式），也不让它进全屏空间，之前最小化无效、最大化只是铺满桌面。macOS 上窗口始终带系统边框（`desktop.rs` 的 `apply_frame`）：FRAMELESS 是透明标题栏 + 内容延伸到标题栏下（`TitleBarStyle::Overlay`），用 `setTitleVisibility:` 隐藏标题文字、`standardWindowButton:` 隐藏红黄绿三个按钮；NATIVE 是 `TitleBarStyle::Visible` 并显示它们。AppKit 在调整大小、进出全屏后可能重新显示按钮，所以 `Resized` 时再隐藏一次（`keep_mac_frameless`）。专注模式的 `decorated` 也走 `apply_frame`，`window_get_state` 在 macOS 上报告的是 `NATIVE_FRAME`。最大化按钮和双击标题栏在 macOS 上调用 `set_fullscreen`（`toggleFullScreen:`，系统全屏空间），`window_is_maximized` 返回是否全屏，按钮提示为 Full Screen / Exit Full Screen；动画结束后前端再读一次状态。
- **记住窗口和标签**：关闭时写入 `window`（不记录最大化，记最大化之前的大小）；Window 菜单的窗口和标签实时写入 `windows`。`window_get_state` / `window_set_state` 在 `desktop.rs`。
- **Zoom**：只作用于当前标签，不保存；浏览器里拦截 Ctrl+= / Ctrl+-。
- **窗口透明度**：`window_set_state` 的 `opacity`（0.3–1.0）。Linux 用 GTK `set_opacity`，Windows 给窗口加 `WS_EX_LAYERED` 后 `SetLayeredWindowAttributes`（100% 时去掉该样式），macOS 设置 `NSWindow.alphaValue`（objc2）。Settings 的值启动时应用；专注模式期间显示专注模式自己的透明度，退出时恢复 Settings 的值。
- **字体**：终端字体写入 `terminal.fontFamily`，xterm 的 `fontFamily` 为“所选字体, 内置字体栈”，改字体后重新计算行高并 refit；界面字体通过 `<main>` 上的 `--ui-font-family` 变量生效。
- **菜单**：Session 菜单去掉了 Open Session…（及 Alt+O）和 Session Properties…（属性入口在 Preferences → Session Settings…；终端右键菜单也不再有 Session Properties… 和 Close View）；Log 子菜单改为软件日志设置（保存输出 / 清空回滚在终端右键菜单里）；Help 菜单为 About MetroTerm… 和版本号。

### 锁屏与专注模式

- 锁屏（`components/LockScreen.tsx`、`lib/lockScreen.ts`）：密码只存 PBKDF2-SHA256（15 万次、随机盐）的哈希；有密码时锁定状态持久化。空闲自动锁屏：键盘鼠标算活动，终端输出不算；空闲锁定跳过设密码提示。
- 专注模式（`components/FocusModeDialog.tsx`、`lib/focusMode.ts`）：进入前保存 `WindowState`，退出时恢复；Tool Bar 对应 `.terminal-toolbar`；置顶只在桌面版可用。专注模式不改窗口透明度（透明度只在 Settings 里设置）。Show 的面板通过 `focusLayout` 临时加入，不修改保存的布局。

## 已知限制

- zsh 输入行折行时缩窄终端，zsh 重画时可能留下一份旧的输入行（zsh 不考虑终端重排）；bash 没有这个问题。
- 非整数缩放下制表符线条比 100% / 200% 稍虚。
- 浏览器不允许网页关闭自己的标签页，标题栏 ✕ / Exit 只在桌面版有效。

## 设计规则

- 不使用圆角和渐变，所有容器都是 90° 直角（Metro 风格），参考 WindTerm 的布局。
- 只用黑、白、灰，再加一个黄绿色作为状态色；不用紫色；白色主题里不出现黑色样式。
- **Gold 主题**（Pro Max，暂不区分用户）：`ThemeMode` 是 `'dark' | 'light' | 'gold'`，主题列表、名称和轮换顺序在 `src/lib/themes.ts`。Gold 时根元素的类是 `metroterm-shell dark gold`，`<html>` 上是 `theme-dark theme-gold`。`styles.css` 里没有 Gold 专用规则：颜色全部由 `colors.css` 的 `:root.theme-gold` 块覆盖，包括金色调色板（`--gold`、`--gold-bright`、`--gold-dim`、`--gold-line`、`--gold-soft`、`--gold-ink`）和引用它们的组件变量（如 `--ink-active`、`--primary-button-bg`、`--session-tab-active-shadow`）；菜单栏背景是 `--menu-bar-bg` 金色渐变；当前终端标签的 `::before` 是 2px 流光（`--session-tab-flow` 渐变 + `--session-tab-flow-animation`，其他主题这两个变量是 `none`，动画不运行；`prefers-reduced-motion` 时关闭）。变量定义在 `<html>` 上，滚动条层等 shell 以外的元素自动跟随。Explorer、Session、Filer 的名称和 Filer 的文件 / 文件夹图标不覆盖，与深色主题一致。终端的 Find 边框、相同文字高亮在 `TerminalView.tsx` 的 `FIND_COLORS` / `MATCH_COLORS` 里各有一组 gold 颜色。以后区分付费用户时，只需在 Settings 的 GOLD 选项和状态栏轮换里加判断。
- 高亮不泛黄；选中文字的相同内容高亮不加边框；终端查找的匹配用 1px 边框框住。
- 图标统一 16×16 网格、1.3px 线宽、直角端点（`components/Icon.tsx`）。

### 弹出层动画

- `lib/popupMotion.ts` 的 `installPopupMotion()`（`main.tsx` 调用）用一个 MutationObserver 统一处理：下拉 / 右键菜单（`.ui-select-menu`）、菜单栏菜单、菜单搜索（`.command-palette`）、提示（`.ui-tip`）、对话框（`.modal-backdrop`，里面的对话框同时轻微上移 + 缩放）、传输通知（`.filer-transfer`）。组件照常挂载 / 卸载，不用改。
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

