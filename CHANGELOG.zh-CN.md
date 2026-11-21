# 更新日志

MetroTerm 的重要变更记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)——只有数字和点；候选版是该版本在 GitHub 上的预发布（prerelease），
不加后缀。英文更新日志见 [CHANGELOG.md](CHANGELOG.md)；打标签前两种语言都要写好对应版本的一节
（`node scripts/release-notes.mjs vX.Y.Z --check`）。

## [Unreleased]

### 修复

- Windows：Filer 的“定位到终端目录”和“跟随终端”现在能找到终端所在目录（cmd、PowerShell、Git Bash，包括 PowerShell 的 `cd`）；OSC 7 的 `file:///C:/…` 路径能正确打开，并支持 OSC 9;9。
- macOS：系统 WebKit 较旧的 Mac（多见于 Intel 机型）打开后不再是空白窗口；界面仍然起不来时，窗口里会显示错误信息。

- Windows 安装包：选择没有写入权限的目录（例如只为当前用户安装时选 Program Files 下的目录）不再装到一半报 “Error opening file for writing”；选择目录页会说明原因，并禁用“下一步”。
- macOS：应用图标在 Dock 和启动台里不再比其他应用大一圈。
- macOS：应用自己的滚动条下面不再露出系统的横向滚动条（在列很宽的 Filer 里能看到）。
- macOS：使用应用自带标题栏时，最小化恢复正常；最大化（以及双击标题栏）和系统绿色按钮一样进入 macOS 全屏（独立的全屏空间），不再只是铺满桌面。
- Windows：第一次启动时 Explorer 里建的是 cmd 和 PowerShell，不再是 bash 和 zsh；旧版本在 Windows 上建的、没改过的 bash / zsh 会话会换成 cmd / PowerShell。

### 变更

- macOS：最低版本改为 10.15（Tauri 2 支持的最低版本）。
- Windows 安装包：可以选择只为当前用户安装或为所有用户安装（Program Files）；中文系统上安装界面显示中文。

## [0.0.1] - 2026-11-16

第一个版本。

### 新增

- WindTerm 式布局的终端工作台：左边是 Explorer（会话）和 Filer，右边是多标签终端和 Sender，另有 Monitor 面板；所有面板都可以移动、调整大小和关闭。
- 会话：本地 shell（bash、zsh 等）、SSH、Telnet、原始 TCP 和串口，按文件夹整理；SSH / Telnet / TCP 可以走 SOCKS5 或 HTTP 代理。
- SSH：密码和密钥登录、记住密码（加密保存）、主机密钥校验、本地 / 远程 / 动态隧道（Tool → Tunnels）。
- Filer：SFTP 和本地文件——多选、拖放上传、带进度和通知的传输、移动 / 复制 / 重命名 / 权限。
- 终端：tmux 快捷键（Ctrl+B）的分屏，每个窗格一个标签组；查找、缩放、窗格全屏、时间和行号栏、方块 / 竖线 / 下划线光标、拖入文件写路径。
- 一个程序窗口里的多个“窗口”（Window 菜单，Ctrl+Shift+1…9）。
- Sender：按行或按字符把文本发给一个或多个会话。
- 菜单搜索（Ctrl+Shift+P）、专注模式、锁屏、深色 / 浅色 / Gold 主题、中英文界面。
- 浏览器模式：`metroterm --web` / `--daemon`，以及独立的浏览器版安装包（`metroterm-server` + `www/` 里的界面）。
- 安装包：Linux（deb、rpm、AppImage）、Windows（setup.exe、msi、自带 WebView2 的离线安装包、便携版 zip）和 macOS（dmg），x86_64 和 ARM64。
