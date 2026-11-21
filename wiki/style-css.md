# MetroTerm 配色表

> 列出 `src/colors.css` 里的全部颜色变量。修改 `colors.css` 时请同步更新本表。

## 规则

- **一个 class 适配所有主题。** `src/styles.css` 里每条规则只写一次，颜色一律写 `var(--token)`；**不写颜色值**（`#hex`、`rgb()`、`hsl()`、颜色关键字），**也不写主题选择器**（`.light`、`.gold`、`html.theme-…`）。各主题的差别全部放在 `src/colors.css`：同一个变量在三个主题块里取不同的值。
- 主题由 `<html>` 上的类决定（`src/lib/tauri.ts` 的 `applyWindowBackground`）：`theme-dark` / `theme-light`，Gold 主题是 `theme-dark theme-gold`。`colors.css` 里有三个块：`:root`（深色，默认值）、`:root.theme-light`、`:root.theme-gold`。某个主题块里没写的变量沿用深色值，Gold 主题只覆盖与深色不同的部分。
- 每个块的顺序：语义变量（底色、文字、分隔线、控件、菜单、强调色……）→ 中性灰阶 → **组件变量**（某个部件在各主题下的取值，例如 `--tab-bar-bg`、`--ink-active`）。
- **新面板怎么写**：先只用语义变量——底色 `--panel` / `--panel-2`，文字 `--ink` / `--muted` / `--faint`，分隔线 `--line` / `--line-soft`，悬停 / 选中 `--hover` / `--active`，表单 `--control-*`，菜单 `--menu-*`。它们在三个主题里都有合适的值，新面板不需要任何主题专用代码。只有当某个部件在某个主题里必须和语义变量不同时，才在 `colors.css` 的组件区加一个变量（名字用部件名，如 `--tunnel-missing-ink`），在需要的主题块里给出值，并在本表加一行。
- 状态（`:hover`、`:focus`、`.active`）如果在某个主题里要有不同效果，也用变量表达（例如 `--field-hover-bg`、`--quickbar-hover-ink`），不要用更高优先级的主题规则去覆盖。
- **中性灰阶 `--n-XX`**：XX 是灰阶的档位（00 = 背景一端，ff = 文字一端）。深色主题的值是 `#XXXXXX`，浅色主题是它的镜像（`#ffffff` − XX，例如 `--n-cc` 深色 `#cccccc`、浅色 `#333333`），所以同一条规则在两个主题里对比度一致。带 `-aNN` 后缀的是 NN% 不透明度的同一档灰色。Gold 主题用深色的值。
- 表中空白表示该主题沿用深色值，“—”表示该主题没有定义；“使用位置”列出使用该变量的选择器和属性（省略开头的 `.metroterm-shell`），或引用它的其他变量，最多列 3 条。

共 281 个颜色变量。

## 页面（html / body）

窗口在重绘前露出的底色、页面默认文字色和浏览器控件的配色方案（`color-scheme`）。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--page-ink` | `#dbdbdb` |  |  | `:root` color |
| `--page-bg` | `#171717` | `#ececea` | `#141310` | `:root` background<br>`html` background |
| `--color-scheme` | `dark` | `light` |  | `html` color-scheme |

## 界面底色与文字

整个界面共用的基础变量：背景、栏、面板、分隔线、正文 / 次要 / 弱化文字、选中和悬停。**新面板优先用这一组。**

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--bg` | `#191919` | `#f3f3f3` | `#171613` | `.metroterm-shell` background |
| `--chrome` | `#292929` | `#e8e8e8` | `#24211b` | `.window-chrome` background<br>`.focus-exit-zone button` background<br>`--dialog-title-bg`<br>…共 4 处 |
| `--chrome-2` | `#202020` | `#eeeeee` | `#1d1b17` | `--menu-bar-bg` |
| `--panel` | `#1d1d1d` | `#fafafa` | `#1b1a17` | `.sender-pane` background<br>`.connection-dialog` background<br>`.panel` background<br>…共 24 处 |
| `--panel-2` | `#171717` | `#f0f0f0` | `#151411` | `.connection-dialog .auth-target` background<br>`.connection-dialog .dialog-note` background<br>`.dialog-actions` background<br>…共 10 处 |
| `--terminal` | `#171717` | `#f3f3f3` | `#141310` | `.terminal-stage` background<br>`.terminal-shell` background<br>`.workbench-split` background<br>…共 13 处 |
| `--line` | `#3a3a3a` | `#cfcfcf` | `#3b3529` | `.filer-head` border-bottom<br>`.sender-controls > i` background<br>`.terminal-empty button` border<br>…共 26 处 |
| `--line-soft` | `#2a2a2a` | `#e1e1e1` | `#2a2720` | `.session-tab` border-right<br>`.pane-filter` border-bottom<br>`.filer-path` border-bottom<br>…共 35 处 |
| `--ink` | `#dedede` | `#1e1e1e` | `#ece5d5` | `.metroterm-shell` color<br>`.pane-filter input` color<br>`.pane-title button:hover` color<br>…共 114 处 |
| `--muted` | `#898989` | `#5c5c5c` | `#998f7a` | `.menu-tools button` color<br>`.pane-filter button` color<br>`.pane-title button` color<br>…共 128 处 |
| `--faint` | `#5a5a5a` | `#8e8e8e` | `#5f584b` | `.sender-targets-head em` color<br>`.sender-targets-list p` color<br>`.ui-select-menu li.is-disabled` color<br>…共 21 处 |
| `--active` | `#333333` | `#e3e3e3` | `#352e21` | `.menu-items button:hover` background<br>`.pane-title button:hover` background<br>`.session-quickbar button:hover` background<br>…共 48 处 |
| `--lime` | `#d2df4e` | `#6f8000` | `#e0bd5c` | — |
| `--violet` | `#8a8a8a` | `#9a9a9a` | `var(--gold-dim)` | `.tree-row.active` border-left-color<br>`.ui-select-menu li.is-active` border-left-color<br>`--split-handle-hover-bg` |
| `--xterm-bg` | `var(--terminal)` | `var(--panel)` |  | `.terminal-gutter` background<br>`.xterm .composition-view` background<br>`.terminal-body .xterm` background |
| `--hover` | `#262626` | `#ececec` | `#27231c` | `.sender-targets-list label:hover` background<br>`.tree-row:hover` background<br>`.filer-list button:hover` background<br>…共 10 处 |

## 输入框与控件

输入框、下拉框、单选框等表单控件的底色、边框、焦点和文字。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--control-bg` | `#1b1b1b` | `#ffffff` | `#181612` | `input:not([type='radio'])` background-color<br>`input[type='radio']` background<br>`.ui-select-trigger` background<br>…共 16 处 |
| `--control-hover` | `#222` | `#f6f6f6` | `#221f19` | `input:not([type='radio']):hover` background-color<br>`input:not([type='radio']):focus` background-color<br>`.ui-select-trigger:hover` background<br>…共 18 处 |
| `--control-line` | `#383838` | `#c9c9c9` | `#3e372a` | `input:not([type='radio'])` border<br>`input[type='radio']` border<br>`input:not([type='radio'])` border-color<br>…共 31 处 |
| `--control-focus` | `#626262` | `#707070` | `#a88a45` | `input:not([type='radio']):hover` border-color<br>`input:not([type='radio']):focus` border-color<br>`input[type='radio']:hover` border-color<br>…共 26 处 |
| `--control-text` | `#bcbcbc` | `#1e1e1e` | `#c9bfa9` | `input:not([type='radio'])` color<br>`input:not([type='radio'])` caret-color<br>`.ui-select-trigger` color<br>…共 12 处 |
| `--select-arrow` | `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888888' d='M2 4l4 4 4-4z'/%3E%3C/svg%3E")` | `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666666' d='M2 4l4 4 4-4z'/%3E%3C/svg%3E")` |  | `select` background-image |

## 菜单与提示框

下拉菜单、右键菜单和提示框（Tooltip）。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--menu-bg` | `#1e1e1e` | `#ffffff` | `#1d1b17` | `.ui-select-menu` background<br>`.command-palette` background |
| `--menu-line` | `#3a3a3a` | `#d4d4d4` | `var(--gold-line)` | `.ui-select-menu` border<br>`.ui-select-menu li.ui-menu-separator` background<br>`.command-palette` border<br>…共 5 处 |
| `--menu-hover` | `#2c2c2c` | `#efefef` | `#2f291f` | `.ui-select-menu li.is-active` background<br>`.ui-number-steppers button:hover:not(:disabled)` background<br>`.ui-select-menu.folder-tree-menu li.is-active` background<br>…共 5 处 |
| `--menu-selected` | `#262626` | `#f5f5f5` | `#26221b` | `.ui-select-menu li.is-selected` background<br>`.ui-select-menu.folder-tree-menu li.is-selected` background |
| `--menu-shadow` | `0 6px 18px #0009` | `0 8px 24px rgba(0, 0, 0, 0.12)` |  | `.ui-select-menu` box-shadow<br>`.command-palette` box-shadow |
| `--tip-bg` | `#232323` | `#fbfbf9` | `#221f19` | `.ui-tip` background<br>`.tree-drag-ghost` background<br>`.tab-drag-ghost` background |
| `--tip-line` | `#484848` | `#b4b4af` | `#5c4d2e` | `.ui-tip` border<br>`.ui-tip kbd` border<br>`.tree-drag-ghost` border<br>…共 4 处 |
| `--tip-ink` | `#e2e2e2` | `#1d1d1d` | `#ece5d5` | `.ui-tip` color<br>`.tree-drag-ghost` color<br>`.tab-drag-ghost` color |
| `--tip-key` | `#9a9a9a` | `#6b6b6b` | `#a8997a` | `.ui-tip kbd` color<br>`.ui-tip-table dt` color<br>`.tree-drag-ghost .icon` color |
| `--tip-shadow` | `0 4px 12px #000a` | `0 4px 12px #0002` |  | `.ui-tip` box-shadow<br>`.tree-drag-ghost` box-shadow<br>`.tab-drag-ghost` box-shadow |

## 滚动条

自绘滚动条（`lib/customScrollbars.ts`）。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--sb-track` | `transparent` |  |  | `.sb-track` background |
| `--sb-thumb` | `rgba(255, 255, 255, 0.2)` | `rgba(0, 0, 0, 0.11)` | `rgba(217, 180, 90, 0.22)` | `.sb-thumb` background |
| `--sb-thumb-near` | `rgba(255, 255, 255, 0.3)` | `rgba(0, 0, 0, 0.17)` | `rgba(217, 180, 90, 0.32)` | `.sb-track.is-near .sb-thumb` background |
| `--sb-thumb-hover` | `rgba(255, 255, 255, 0.42)` | `rgba(0, 0, 0, 0.26)` | `rgba(217, 180, 90, 0.45)` | `.sb-track:hover .sb-thumb` background |
| `--sb-thumb-active` | `rgba(255, 255, 255, 0.55)` | `rgba(0, 0, 0, 0.35)` | `rgba(217, 180, 90, 0.6)` | `.sb-track.is-dragging .sb-thumb` background |

## 终端

行号栏当前行、当前行高亮、光标、输入法组合下划线、查找无结果、Filer / Monitor 搜索匹配。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--gutter-current` | `#e06666` | `#c43c3c` | `#e0bd5c` | `.terminal-gutter > div.is-current time` color |
| `--terminal-line-highlight` | `rgba(255, 255, 255, 0.08)` | `rgba(0, 0, 0, 0.06)` | `rgba(232, 191, 90, 0.08)` | `.xterm .terminal-line-highlight` background<br>`.terminal-gutter > .terminal-gutter-band` background |
| `--terminal-cursor-color` | `#ffaa5c` | `#ff8a2e` | `#ffaa5c` | `.xterm .xterm-rows .xterm-cursor.xterm-cursor-outline::before` border<br>`.xterm .xterm-rows .xterm-cursor.xterm-cursor-bar::before` background<br>`.connection-dialog .cursor-sample::before` background |
| `--composition-underline` | `#ffaa5c` | `#ff8a2e` |  | `.xterm .composition-view` text-decoration-color |
| `--match-bg` | `rgba(255, 255, 255, 0.17)` | `rgba(0, 0, 0, 0.085)` |  | `.filer-list mark.filer-match` background<br>`.monitor-procs mark.filer-match` background |
| `--find-empty-ink` | `#d86a6a` |  |  | `.terminal-find-count.is-empty` color |

## 强调色与状态

在线 / 连接中、链接、图标、Sender 播放 / 停止、隧道状态等。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--accent-online` | `#c9d25e` | `#6f8f00` |  | `.session-online` color<br>`.session-tab em.online` background<br>`.status-dot.online` background<br>…共 6 处 |
| `--icon-terminal-tab` | `#e27e39` | `#c8621b` | `var(--gold)` | `.session-tab i` color |
| `--icon-session` | `#db904d` | `#c8621b` |  | `.tree-row i` color |
| `--status-online` | `#c9d25e` |  |  | `.tree-row i.session-online` color<br>`.open-tab-status.online` background |
| `--sender-play` | `#73b26f` | `#2f8a3a` |  | `.sender-controls .play` color<br>`.sender-controls > button.play` color |
| `--link` | `#5787b0` | `#1f6fb2` |  | `.status-bar a` color |
| `--status-connecting` | `#e3a853` |  |  | `.open-tab-status.connecting` background<br>`--session-connecting-ink` |
| `--status-online-glow` | `#c9d22b22` |  |  | `.open-tab-status.online` box-shadow<br>`--status-dot-glow` |
| `--sender-stop` | `#d06a5f` | `#c0392b` |  | `.sender-controls > button.stop` color |
| `--tunnel-running` | `#5fae6e` |  | `var(--gold)` | `.tunnel-row.is-running .tunnel-dot` background |
| `--tunnel-starting` | `#c9a34a` |  |  | `.tunnel-row.is-starting .tunnel-dot` background |
| `--tunnel-error` | `#c45c55` |  |  | `.tunnel-row.is-error .tunnel-dot` background<br>`--tunnel-missing-ink` |
| `--gold-option` | `#d9b45a` | `#a8801f` |  | `.theme-gold-option .icon` color<br>`.theme-gold-option em` color |

## 错误与危险操作

错误提示、危险按钮、窗口关闭按钮。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--window-close-hover` | `#c42b1c` |  |  | `.window-controls button:last-child:hover` background |
| `--window-close-active` | `#a1251a` |  |  | `.window-controls button:last-child:active` background |
| `--error-dot` | `#d9534f` |  |  | `.status-dot.error` background<br>`.file-message.is-error` background |
| `--file-error-ink` | `#d9534f` | `#b52a1c` |  | `.file-message.is-error` color<br>`--transfer-error-ink` |
| `--danger` | `#c4314b` |  |  | `.file-dialog button.danger` border-color<br>`.file-dialog button.danger` background<br>`--danger-button-bg` |
| `--danger-hover` | `#a92a40` |  |  | `.file-dialog button.danger:hover` background<br>`--danger-button-hover-bg` |
| `--error-note-ink` | `#e0796d` | `#b3392b` |  | `.connection-dialog .dialog-note.is-error` color<br>`.tunnel-message.is-error` color<br>`--tunnel-missing-ink` |
| `--error-note-border` | `#6b3a35` | `#e3b2ab` |  | `.connection-dialog .dialog-note.is-error` border-color |
| `--danger-ink` | `#e06666` | `#c4314b` |  | `.lock-error` color<br>`.connection-dialog .dialog-error` color<br>`.is-danger-text` color<br>…共 4 处 |

## 文件夹树

Filer 的目标文件夹对话框和路径下拉。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--ft-guide` | `#3d3d3d` | `#c8c8c4` | `#3e372a` | `.folder-tree-menu .ft-guide.line::before` border-left<br>`.folder-tree-menu .ft-guide.tee::after` border-top<br>`.folder-tree-menu .ft-twisty.is-leaf::before` background |
| `--ft-folder` | `#8a8a8a` | `#7a7a7a` | `#b0924f` | `.folder-tree-select .folder-tree-icon` color<br>`.folder-tree-menu .ft-icon` color |

## Monitor 图表

Monitor 面板的 CPU / 内存 / 网络曲线。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--mon-cpu` | `#6f9a7c` | `#3f7d52` | `#d9b45a` | `.monitor-meter i` background<br>`.monitor-spark.cpu polyline` stroke<br>`.monitor-cores i` background |
| `--mon-mem` | `#6a8fb0` | `#2f6a9a` | `#b89a62` | `.monitor section.mem .monitor-meter i` background<br>`.monitor-spark.mem polyline` stroke |
| `--mon-rx` | `#6a8fb0` | `#2f6a9a` | `#d9b45a` | `.monitor i.rx` color<br>`.monitor-spark.net .s0` stroke |
| `--mon-tx` | `#b88a5c` | `#a5662a` | `#9c8a66` | `.monitor i.tx` color<br>`.monitor-spark.net .s1` stroke |
| `--mon-hot` | `#c45c55` | `#b43c34` | `#c8664a` | `.monitor-error` color<br>`.monitor-meter.hot i` background<br>`.monitor section.mem .monitor-meter.hot i` background<br>…共 5 处 |
| `--mon-track` | `#262626` | `#e6e6e6` | `#2a2720` | `.monitor-meter` background<br>`.monitor-cores span` background |

## 遮罩、锁屏与阴影

对话框遮罩、锁屏底色和各种阴影。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--backdrop` | `#000a` | `rgba(30, 30, 30, 0.28)` |  | `.modal-backdrop` background |
| `--shadow-dialog` | `#0008` | `rgba(0, 0, 0, 0.16)` | `#000a` | `.connection-dialog` box-shadow |
| `--file-dialog-backdrop` | `rgba(0, 0, 0, 0.35)` | `rgba(30, 30, 30, 0.18)` |  | `.file-dialog` background |
| `--file-drop-mask` | `rgba(0, 0, 0, 0.42)` | `rgba(255, 255, 255, 0.6)` |  | `.file-drop-overlay` background |
| `--file-drop-ink` | `var(--muted)` |  |  | `.file-drop-overlay` color |
| `--transfer-bar` | `var(--control-focus)` |  |  | `.filer-transfer-icon` color<br>`.filer-transfer-bar i` background<br>`.filer-transfer-list li.is-running > i::before` border-top-color<br>…共 4 处 |
| `--transfer-track` | `var(--line-soft)` |  |  | `.filer-transfer-bar` background<br>`.filer-transfer-list li.is-running > i::before` border |
| `--transfer-ok-ink` | `var(--accent-online)` |  |  | `.filer-transfer.is-done .filer-transfer-icon` color<br>`.filer-transfer.is-done .filer-transfer-bar i` background<br>`.filer-transfer-list li.is-done > i` color |
| `--transfer-error-ink` | `var(--file-error-ink)` |  |  | `.filer-transfer.is-error .filer-transfer-icon` color<br>`.filer-transfer.is-error .filer-transfer-bar i` background<br>`.filer-transfer-list li.is-error` color<br>…共 4 处 |
| `--shadow-file-form` | `rgba(0, 0, 0, 0.25)` |  |  | `.file-dialog form` box-shadow |
| `--shadow-find` | `rgba(0, 0, 0, 0.35)` | `rgba(0, 0, 0, 0.12)` |  | `.terminal-find` box-shadow |
| `--lock-screen-bg` | `#101010` | `#ececea` |  | `.lock-screen` background |
| `--shadow-focus-exit` | `#0007` | `#0003` |  | `.focus-exit-zone button` box-shadow |

## 中性灰阶

`--n-XX`：XX 是档位（00 = 背景一端，ff = 文字一端），深色为 `#XXXXXX`，浅色为镜像值，Gold 沿用深色。规则只需要一个普通灰色时使用。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--n-00` | `#000000` | `#fff` |  | `--window-close-ink`<br>`--dialog-title-span-ink` |
| `--n-05` | `#050505` | `#fafafa` |  | — |
| `--n-11` | `#111` | `#eeeeee` |  | `--primary-button-ink`<br>`--window-chrome-line`<br>`--status-bar-line`<br>…共 6 处 |
| `--n-17` | `#171717` | `#e8e8e8` |  | `--field-bg` |
| `--n-1a` | `#1a1a1a` | `#e5e5e5` |  | `--tab-bar-bg`<br>`--terminal-breadcrumb-bg`<br>`--sender-bg` |
| `--n-20` | `#202020` | `#dfdfdf` |  | `--pane-title-bg`<br>`--terminal-toolbar-bg` |
| `--n-22` | `#222` | `#dddddd` |  | `--sender-field-bg` |
| `--n-23` | `#232323` | `#dcdcdc` |  | `--status-bar-bg` |
| `--n-26` | `#262626` | `#d9d9d9` |  | `.tree-row:hover` background |
| `--n-28` | `#282828` | `#d7d7d7` |  | `--field-line`<br>`--group-row-hover-bg` |
| `--n-2b` | `#2b2b2b` | `#d4d4d4` |  | `.filer-list button:hover` background |
| `--n-2f` | `#2f2f2f` | `#d0d0d0` |  | `--window-button-hover-bg` |
| `--n-30` | `#303030` | `#cfcfcf` |  | `--tree-row-active-bg` |
| `--n-33` | `#333` | `#cccccc` |  | `--terminal-breadcrumb-line` |
| `--n-3d` | `#3d3d3d` | `#c2c2c2` |  | `--window-button-hover-bg` |
| `--n-42` | `#424242` | `#bdbdbd` |  | `--window-button-active-bg` |
| `--n-48` | `#484848` | `#b7b7b7` |  | `--sender-field-line` |
| `--n-4a` | `#4a4a4a` | `#b5b5b5` |  | `--window-button-active-bg`<br>`--status-dot-bg`<br>`--sender-stop-disabled-ink` |
| `--n-55` | `#555555` | `#aaa` |  | `--sender-field-line` |
| `--n-5a` | `#5a5a5a` | `#a5a5a5` |  | `--gutter-ink` |
| `--n-5c` | `#5c5c5c` | `#a3a3a3` |  | `--gutter-ink` |
| `--n-61` | `#616161` | `#9e9e9e` |  | `--dialog-line` |
| `--n-65` | `#656565` | `#9a9a9a` |  | `--gutter-time-ink` |
| `--n-66` | `#666` | `#999999` |  | `.pane-filter input::placeholder` color<br>`.session-quickbar .session-filter::placeholder` color |
| `--n-69` | `#696969` | `#969696` |  | `.open-tab-status` background<br>`--status-dot-bg` |
| `--n-6a` | `#6a6a6a` | `#959595` |  | `--sender-span-ink` |
| `--n-72` | `#727272` | `#8d8d8d` |  | `--group-row-small-ink` |
| `--n-73` | `#737373` | `#8c8c8c` |  | `--dialog-line` |
| `--n-74` | `#747474` | `#8b8b8b` |  | `--gutter-time-ink` |
| `--n-77` | `#777` | `#888888` |  | `--tree-row-small-ink` |
| `--n-7a` | `#7a7a7a` | `#858585` |  | `.pane-title i` color<br>`.status-bar span:first-child` color |
| `--n-85` | `#858585` | `#7a7a7a` |  | `.filer-head` color<br>`--filer-sort-ink`<br>`--filer-icon-ink` |
| `--n-8a` | `#8a8a8a` | `#757575` |  | `--filer-icon-ink` |
| `--n-90` | `#909090` | `#6f6f6f` |  | `--filer-foot-ink` |
| `--n-91` | `#919191` | `#6e6e6e` |  | `--checkbox-mark`<br>`--radio-dot` |
| `--n-93` | `#939393` | `#6c6c6c` |  | `--terminal-breadcrumb-ink` |
| `--n-95` | `#959595` | `#6a6a6a` |  | `--menu-check` |
| `--n-98` | `#989898` | `#676767` |  | `--session-tab-ink` |
| `--n-9a` | `#9a9a9a` | `#656565` |  | `--sender-controls-ink` |
| `--n-a0` | `#a0a0a0` | `#5f5f5f` |  | `.sender-controls input[type='radio']` accent-color<br>`--status-bar-ink` |
| `--n-a4` | `#a4a4a4` | `#5b5b5b` |  | `.sender-editor` color |
| `--n-a6` | `#a6a6a6` | `#595959` |  | `--group-row-ink` |
| `--n-a7` | `#a7a7a7` | `#585858` |  | `--pane-title-ink` |
| `--n-a9` | `#a9a9a9` | `#565656` |  | `.filer-list button` color<br>`--filer-path-ink` |
| `--n-aa` | `#aaa` | `#555555` |  | `.filer-path span` color<br>`--checkbox-mark`<br>`--radio-dot` |
| `--n-b0` | `#b0b0b0` | `#4f4f4f` |  | `.filer-foot span` color |
| `--n-b5` | `#b5b5b5` | `#4a4a4a` |  | `--sender-field-ink` |
| `--n-b8` | `#b8b8b8` | `#474747` |  | `--strong-ink` |
| `--n-b9` | `#b9b9b9` | `#464646` |  | `.filer-list button` color<br>`--row-ink`<br>`--menu-item-ink`<br>…共 4 处 |
| `--n-bb` | `#bbbbbb` | `#444` |  | `--window-button-ink`<br>`--group-row-ink` |
| `--n-bd` | `#bdbdbd` | `#424242` |  | `--window-button-ink` |
| `--n-c2` | `#c2c2c2` | `#3d3d3d` |  | `--window-chrome-ink` |
| `--n-c5` | `#c5c5c5` | `#3a3a3a` |  | `--dialog-title-span-bg` |
| `--n-c7` | `#c7c7c7` | `#383838` |  | `--focus-ring` |
| `--n-c9` | `#c9c9c9` | `#363636` |  | `--primary-button-bg` |
| `--n-cc` | `#cccccc` | `#333` |  | `--row-ink`<br>`--caret`<br>`--menu-item-ink`<br>…共 5 处 |
| `--n-cf` | `#cfcfcf` | `#303030` |  | — |
| `--n-d0` | `#d0d0d0` | `#2f2f2f` |  | `--dialog-title-span-bg` |
| `--n-d3` | `#d3d3d3` | `#2c2c2c` |  | `--window-name-ink` |
| `--n-e0` | `#e0e0e0` | `#1f1f1f` |  | `.app-mark` color |
| `--n-e6` | `#e6e6e6` | `#191919` |  | `--composition-ink` |
| `--n-ed` | `#ededed` | `#121212` |  | `--tree-row-active-ink` |
| `--n-ee` | `#eee` | `#111111` |  | `--primary-button-hover-bg`<br>`--primary-button-disabled-hover-bg`<br>`--window-button-hover-ink` |
| `--n-ff` | `#fff` | `#000000` |  | `.window-controls button:active` color<br>`.file-dialog button.danger` color<br>`--window-button-hover-ink`<br>…共 6 处 |

## 组件：多处共用

几个部件共用的、各主题取值不同的变量：激活文字（Gold 下为亮金色）、栏分隔线、列表行文字、筛选输入框、焦点框、复选框、主按钮等。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--ink-active` | `var(--ink)` |  | `var(--gold-bright)` | `.menu-items button:hover` color<br>`.session-tab.active` color<br>`.sender-targets-list label.is-current span` color<br>…共 12 处 |
| `--strong-ink` | `var(--n-b8)` | `var(--ink)` |  | `.terminal-breadcrumb strong` color<br>`.session-quickbar button:first-child` color |
| `--button-hover-bg` | `var(--active)` | `var(--hover)` |  | `.toolbar-icons button:hover` background<br>`.panel-empty button:hover` background<br>`.pane-title .pane-tab:hover` background |
| `--bar-line` | `var(--line)` | `var(--line-soft)` |  | `.tab-bar` border-bottom<br>`.pane-title` border-bottom<br>`.filer-foot` border-top<br>…共 6 处 |
| `--row-ink` | `var(--n-b9)` | `var(--n-cc)` |  | `.tree-row` color<br>`.filer-list button` color<br>`.filer-list > button:hover:not(.selected)` color<br>…共 4 处 |
| `--row-dim-ink` | `var(--muted)` | `var(--faint)` |  | `.tree-row-actions button` color<br>`.filer-list time` color |
| `--field-bg` | `var(--n-17)` | `var(--control-bg)` | `#141310` | `.pane-filter input` background<br>`.connection-dialog input` background<br>`.session-quickbar .session-filter` background<br>…共 7 处 |
| `--field-line` | `var(--n-28)` | `var(--control-line)` | `#2f2a20` | `.pane-filter input` border<br>`.session-quickbar .session-filter` border<br>`.command-palette-field button` border<br>…共 5 处 |
| `--field-focus-line` | `var(--control-focus)` | `var(--control-line)` | `var(--gold-dim)` | `.session-quickbar .session-filter:focus` border-color<br>`.command-palette-field input` border |
| `--field-hover-bg` | `var(--control-hover)` | `var(--control-bg)` | `var(--field-bg)` | `.session-quickbar .session-filter:hover` background-color |
| `--field-hover-line` | `var(--control-focus)` | `var(--control-line)` | `var(--field-line)` | `.session-quickbar .session-filter:hover` border-color<br>`.command-palette-field button:hover` border-color |
| `--field-focus-bg` | `var(--control-hover)` | `var(--control-bg)` | `var(--field-bg)` | `.session-quickbar .session-filter:focus` background-color |
| `--filter-bg` | `var(--control-bg)` |  | `var(--field-bg)` | `.pane-filter input` background-color |
| `--filter-line` | `var(--control-line)` |  | `var(--field-line)` | `.pane-filter input` border-color |
| `--focus-ring` | `var(--n-c7)` |  | `var(--gold)` | `button:focus-visible` outline |
| `--focus-ring-control` | `var(--control-focus)` |  | `var(--gold)` | `input[type='radio']:focus-visible` outline<br>`input[type='radio']:focus-visible` outline-color<br>`.dialog-actions > .primary-button:focus-visible` outline<br>…共 4 处 |
| `--caret` | `var(--ink)` | `var(--n-cc)` |  | `input` caret-color |
| `--checkbox-mark` | `var(--n-91)` | `var(--n-aa)` | `var(--gold)` | `input[type='checkbox']:checked::after` background |
| `--checkbox-checked-line` | `var(--control-focus)` |  | `var(--gold-dim)` | `input[type='checkbox']:checked` border-color |
| `--radio-dot` | `var(--n-91)` | `var(--n-aa)` |  | `input[type='radio']:checked::after` background |
| `--range-thumb` | `var(--ink)` |  | `var(--gold)` | `.opacity-slider input[type='range']::-webkit-slider-thumb` background<br>`.opacity-slider input[type='range']::-moz-range-thumb` background |
| `--primary-button-bg` | `var(--n-c9)` |  | `var(--gold)` | `.primary-button` background |
| `--primary-button-ink` | `var(--n-11)` |  | `var(--gold-ink)` | `.primary-button` color |
| `--primary-button-hover-bg` | `var(--n-ee)` |  | `var(--gold-bright)` | `.primary-button:hover` background |
| `--primary-button-disabled-hover-bg` | `var(--n-ee)` |  | `var(--gold)` | `.primary-button:hover:disabled` background |
| `--choice-active-shadow` | `none` |  | `inset 0 -2px 0 var(--gold)` | `.connection-dialog .segmented button.is-active` box-shadow<br>`.focus-choice button.is-active` box-shadow |
| `--focus-choice-active-bg` | `var(--active)` | `#d6d6d2` |  | `.focus-choice button.is-active` background |
| `--status-dot-bg` | `var(--n-69)` | `var(--n-4a)` |  | `.session-tab em` background |
| `--status-dot-glow` | `var(--status-online-glow)` | `rgba(111, 143, 0, 0.15)` |  | `.session-tab em.online` box-shadow |
| `--session-connecting-ink` | `var(--status-connecting)` | `#b7791f` |  | `.session-connecting` color<br>`.session-tab em.connecting` background |
| `--menu-check` | `currentColor` | `var(--n-95)` | `var(--gold)` | `.ui-menu-check` background<br>`.command-palette-check` background |

## 组件：标题栏、菜单栏、状态栏

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--window-chrome-line` | `var(--n-11)` | `var(--line)` | `#0d0c0a` | `.window-chrome` border-bottom |
| `--window-chrome-ink` | `var(--n-c2)` | `var(--muted)` | `#cfc6b3` | `.window-chrome` color |
| `--window-name-ink` | `var(--n-d3)` | `var(--ink)` | `var(--gold-bright)` | `.window-name` color |
| `--window-button-ink` | `var(--n-bd)` | `var(--n-bb)` |  | `.window-controls button` color |
| `--window-button-hover-bg` | `var(--n-3d)` | `var(--n-2f)` |  | `.window-controls button:hover` background |
| `--window-button-hover-ink` | `var(--n-ff)` | `var(--n-ee)` |  | `.window-controls button:hover` color |
| `--window-button-active-bg` | `var(--n-4a)` | `var(--n-42)` |  | `.window-controls button:active` background |
| `--window-close-ink` | `var(--n-ff)` | `var(--n-00)` |  | `.window-controls button:last-child:hover` color<br>`.window-controls button:last-child:active` color |
| `--menu-bar-line` | `var(--line)` | `var(--line-soft)` | `var(--gold-line)` | `.menu-bar` border-bottom |
| `--menu-bar-bg` | `var(--chrome-2)` |  |  | `.menu-bar` background |
| `--menu-item-ink` | `var(--n-b9)` | `var(--n-cc)` | `#c3baa6` | `.menu-items button` color<br>`--menu-item-open-ink` |
| `--menu-item-open-ink` | `var(--ink)` |  | `var(--menu-item-ink)` | `.menu-items button.is-open` color |
| `--status-bar-bg` | `var(--n-23)` | `var(--chrome)` | `#1f1c17` | `.status-bar` background |
| `--status-bar-line` | `var(--n-11)` | `var(--line)` | `var(--gold-line)` | `.status-bar` border-top |
| `--status-bar-ink` | `var(--n-a0)` | `var(--muted)` | `#a89e88` | `.status-bar` color<br>`--status-window-ink` |
| `--status-theme-ink` | `var(--muted)` |  | `var(--gold)` | `.status-bar .status-theme` color |
| `--status-theme-hover-ink` | `var(--ink)` |  | `var(--gold)` | `.status-bar .status-theme:hover` color |
| `--status-window-ink` | `var(--status-bar-ink)` |  |  | `.status-bar .status-window` color |
| `--status-window-hover-ink` | `var(--ink)` |  |  | `.status-bar .status-window:hover` color |
| `--status-window-hover-bg` | `var(--hover)` |  |  | `.status-bar .status-window:hover` background |
| `--status-window-active-ink` | `var(--ink)` |  |  | `.status-bar .status-window.is-active` color |
| `--status-window-active-bg` | `var(--active)` |  |  | `.status-bar .status-window.is-active` background |
| `--split-handle-hover-bg` | `var(--violet)` |  | `var(--gold)` | `.split-handle:hover` background |

## 组件：面板

面板底色、面板标题栏、空面板。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--terminal-main-bg` | `var(--terminal)` | `var(--panel)` |  | `.panel.terminal-main` background |
| `--pane-title-bg` | `var(--n-20)` | `var(--panel-2)` |  | `.pane-title` background |
| `--pane-title-ink` | `var(--n-a7)` | `var(--muted)` |  | `.pane-title` color |
| `--pane-swatch` | `var(--muted)` | `#8a8a86` |  | `.pane-swatch` background |
| `--panel-empty-button-line` | `var(--line-soft)` | `var(--line)` |  | `.panel-empty button` border |

## 组件：终端标签、工具栏、行号栏

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--tab-bar-bg` | `var(--n-1a)` | `var(--panel-2)` | `#181713` | `.tab-bar` background |
| `--session-tab-ink` | `var(--n-98)` | `var(--muted)` | `#a0967f` | `.session-tab` color<br>`--session-tab-hover-ink`<br>`--tmux-idle-tab-ink` |
| `--session-tab-hover-bg` | `var(--panel)` | `var(--hover)` |  | `.session-tab:hover` background |
| `--session-tab-hover-ink` | `var(--session-tab-ink)` | `var(--ink)` |  | `.session-tab:hover` color |
| `--session-tab-active-bg` | `var(--active)` | `var(--panel)` |  | `.session-tab.active` background |
| `--session-tab-active-shadow` | `none` |  | `none` | `.session-tab.active` box-shadow |
| `--tmux-line` | `var(--line)` |  |  | `.tmux-stage` background |
| `--tmux-focus-line` | `var(--accent-online)` |  |  | `.tmux-stage.is-split .tmux-pane.is-focused .tmux-letter` color |
| `--tmux-letter-ink` | `var(--muted)` |  |  | `.tmux-letter` color |
| `--tmux-idle-tab-ink` | `var(--session-tab-ink)` |  |  | `.tmux-stage.is-split .tmux-pane:not(.is-focused) .session-tab.active` color |
| `--status-prefix-bg` | `var(--accent-online)` |  |  | `.status-bar .status-prefix` background |
| `--status-prefix-ink` | `var(--n-11)` |  |  | `.status-bar .status-prefix` color |

## Active tab: a light running along its top edge (animation off while the name is none).

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--session-tab-flow` | `none` |  |  | `.session-tab.active::before` background |
| `--session-tab-flow-animation` | `none` |  | `session-tab-flow` | `.session-tab.active::before` animation-name |
| `--tab-close-hover-bg` | `var(--line)` | `var(--active)` |  | `.session-tab b:hover` background |
| `--tab-close-hover-ink` | `var(--n-ff)` | `var(--ink)` |  | `.session-tab b:hover` color |
| `--terminal-toolbar-bg` | `var(--n-20)` | `var(--panel)` |  | `.terminal-toolbar` background |
| `--terminal-breadcrumb-line` | `var(--n-33)` | `var(--control-line)` |  | `.terminal-breadcrumb` border |
| `--terminal-breadcrumb-bg` | `var(--n-1a)` | `var(--control-bg)` |  | `.terminal-breadcrumb` background |
| `--terminal-breadcrumb-ink` | `var(--n-93)` | `var(--muted)` |  | `.terminal-breadcrumb` color |
| `--gutter-ink` | `var(--n-5a)` | `var(--n-5c)` |  | `.terminal-gutter` color<br>`.sender-gutter` color |
| `--gutter-time-ink` | `var(--n-74)` | `var(--n-65)` |  | `.terminal-gutter time` color |
| `--composition-ink` | `var(--ink)` | `var(--n-e6)` |  | `.xterm .composition-view` color |

## 组件：Explorer

会话树、快捷栏和分组行。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--session-quickbar-bg` | `color-mix(in srgb, var(--panel) 88%, var(--n-11))` | `var(--panel)` | `#1a1814` | `.session-quickbar` background |
| `--quickbar-first-ink` | `var(--muted)` |  | `var(--gold)` | `.session-quickbar button:first-of-type` color |
| `--quickbar-hover-ink` | `var(--ink)` | `var(--muted)` | `var(--gold-bright)` | `.session-quickbar button:hover` color |
| `--group-row-ink` | `var(--n-a6)` | `var(--n-bb)` |  | `.group-row` color |
| `--group-row-small-ink` | `var(--n-72)` | `var(--faint)` |  | `.group-row small` color |
| `--group-row-hover-bg` | `var(--n-28)` | `var(--hover)` | `var(--hover)` | `.group-row:hover` background |
| `--tree-row-small-ink` | `var(--n-77)` | `var(--faint)` |  | `.tree-row small` color |
| `--tree-row-hover-ink` | `var(--row-ink)` | `var(--ink)` |  | `.tree-row:hover` color |
| `--tree-row-active-bg` | `var(--n-30)` | `var(--active)` |  | `.tree-row.active` background |
| `--tree-row-active-ink` | `var(--n-ed)` | `var(--ink)` |  | `.tree-row.active` color |
| `--row-action-hover-ink` | `var(--ink)` | `#b7791f` |  | `.tree-row-actions button:hover` color |
| `--row-action-hover-bg` | `var(--active)` | `var(--line-soft)` |  | `.tree-row-actions button:hover` background |

## 组件：Filer

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--filer-head-ink` | `var(--muted)` |  | `#a89e88` | `.filer-head` color |
| `--filer-foot-ink` | `var(--n-90)` | `var(--muted)` |  | `.filer-foot` color |
| `--filer-path-ink` | `var(--n-a9)` | `var(--n-cc)` |  | `.filer-path b` color |
| `--filer-icon-ink` | `var(--n-8a)` | `var(--n-85)` |  | `.filer-list i` color |
| `--filer-row-hover-ink` | `var(--n-b9)` | `var(--ink)` |  | `.filer-list button:hover` color |
| `--filer-selected-bg` | `var(--active)` |  | `var(--gold-soft)` | `.filer-list button.selected` background |
| `--filer-sort-ink` | `var(--faint)` | `var(--n-85)` |  | `.filer-sort` color |
| `--filer-sorted-ink` | `var(--ink)` |  |  | `.filer-head .filer-th.is-sorted` color |

## 组件：Sender

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--sender-controls-ink` | `var(--n-9a)` | `var(--muted)` |  | `.sender-controls` color |
| `--sender-button-hover-ink` | `var(--ink)` | `var(--muted)` |  | `.sender-controls > button:hover` color |
| `--sender-field-line` | `var(--n-48)` | `var(--n-55)` |  | `.sender-controls .counter` border |
| `--sender-field-bg` | `var(--n-22)` | `#f4f4f1` |  | `.sender-controls .counter` background |
| `--sender-field-ink` | `var(--n-b5)` | `var(--n-cc)` |  | `.sender-controls .counter` color |
| `--sender-bg` | `var(--n-1a)` | `var(--panel)` |  | `.sender-editor > span` background<br>`.sender-gutter` background |
| `--sender-text-bg` | `var(--control-bg)` | `var(--panel)` |  | `.sender-editor textarea` background-color |
| `--sender-text-active-bg` | `var(--control-hover)` | `var(--panel)` |  | `.sender-editor textarea:hover` background-color |
| `--sender-span-ink` | `var(--n-6a)` | `var(--ink)` |  | `.sender-editor > span` color |
| `--sender-stop-disabled-ink` | `var(--faint)` | `var(--n-4a)` |  | `.sender-controls > button.stop:disabled` color |

## 组件：对话框

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--dialog-line` | `var(--n-61)` | `var(--n-73)` | `var(--gold-dim)` | `.connection-dialog` border |
| `--dialog-title-bg` | `var(--chrome)` | `var(--panel-2)` |  | `.dialog-title` background |
| `--dialog-title-b-ink` | `currentColor` |  | `var(--gold-bright)` | `.dialog-title b` color |
| `--dialog-title-span-ink` | `var(--n-11)` | `var(--n-00)` | `var(--gold-ink)` | `.dialog-title span` color |
| `--dialog-title-span-bg` | `var(--n-d0)` | `var(--n-c5)` | `var(--gold)` | `.dialog-title span` background |
| `--dialog-input-line` | `var(--line)` | `var(--control-line)` |  | `.connection-dialog input` border |
| `--danger-button-bg` | `var(--danger)` |  | `var(--gold)` | `.file-op-dialog .primary-button.is-danger` background<br>`.dialog-actions > .primary-button.is-danger` background |
| `--danger-button-ink` | `var(--n-ff)` |  | `var(--gold-ink)` | `.file-op-dialog .primary-button.is-danger` color<br>`.dialog-actions > .primary-button.is-danger` color |
| `--danger-button-hover-bg` | `var(--danger-hover)` |  | `var(--gold-bright)` | `.file-op-dialog .primary-button.is-danger:hover` background<br>`.dialog-actions > .primary-button.is-danger:hover` background |

## 组件：Tunnels

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--tunnel-missing-ink` | `var(--tunnel-error)` | `var(--error-note-ink)` |  | `.tunnel-missing` color |

## Gold 金色系

Gold 主题的金色调色板，只在 Gold 主题块里定义，供下面的组件变量引用。

| 变量 | 深色 | 浅色 | Gold | 使用位置 |
| --- | --- | --- | --- | --- |
| `--gold` | — |  | `#d9b45a` | `--icon-terminal-tab`<br>`--tunnel-running`<br>`--focus-ring`<br>…共 16 处 |
| `--gold-bright` | — |  | `#f0d48a` | `--ink-active`<br>`--primary-button-hover-bg`<br>`--window-name-ink`<br>…共 6 处 |
| `--gold-dim` | — |  | `#8a6f35` | `--violet`<br>`--field-focus-line`<br>`--checkbox-checked-line`<br>…共 4 处 |
| `--gold-line` | — |  | `#4a3f28` | `--menu-line`<br>`--menu-bar-line`<br>`--status-bar-line` |
| `--gold-soft` | — |  | `rgba(217, 180, 90, 0.14)` | `--filer-selected-bg` |
| `--gold-ink` | — |  | `#1a1408` | `--primary-button-ink`<br>`--dialog-title-span-ink`<br>`--danger-button-ink` |

## 不在 CSS 里的颜色

- 终端配色（16 色、前景 / 背景、选中、光标）：`src/lib/terminalScheme.ts`，黑、白、金三套，交给 xterm 的 `theme`。
- 终端查找边框和相同文字高亮：`src/components/TerminalView.tsx` 的 `FIND_COLORS` / `MATCH_COLORS`（xterm 装饰只接受颜色值）。
- 面板标题色块：用户在面板 Settings 里选的颜色，保存在 `settings.json` 的 `swatches`。
