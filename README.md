# Coder Agent

本地编码智能体（local coding agent）。核心逻辑（agent 循环、LLM、工具、会话、审批、上下文压缩、规划）在 **Python**（`coder_agent/`）；界面是 **Electron + TypeScript**（`gui/`）。

为什么用 TS/Electron：Chromium 的 IME 原生支持 ibus/fcitx 中文输入，避开了 PySide6/Qt 的输入法痛点。

## 目录导航

- [项目结构](#项目结构)
- [开发环境搭建](#开发环境搭建)
  - [Linux](#linux)
  - [中国 / 受限网络](#中国--受限网络)
  - [Windows](#windows)
- [测试](#测试)
- [构建与发布](#构建与发布)
- [远程服务器](#远程服务器)
- [开发进度](#开发进度)

## 项目结构

```
.
├── coder_agent/          # Python 包：agent/engine/session/approval/llm/context/tools/orchestrator/prompts
│   └── server.py         #   WebSocket 服务器（与 GUI 的桥）
├── gui/                  # Electron + TypeScript 前端
│   ├── src/main/         #   主进程：窗口 + Python 后端子进程 + IPC
│   ├── src/preload/      #   到渲染进程的类型安全桥
│   ├── src/renderer/     #   UI（HTML/CSS/TS，样式对齐旧 PySide6 外观）
│   └── tests/e2e/        #   CDP 冒烟测试（cdp_*_test.cjs + run_all_tests.cjs）
├── tests/                # 后端 pytest 测试
├── server/               # LLM 推理后端（ollama / vllm / ovms）
├── docs/                 # 文档（发布指南、优化计划等）
├── deploy/               # 部署文件（systemd 服务单元等）
├── pyproject.toml        # 后端 Python 包定义
├── build_standalone.py   # PyInstaller 单文件构建后端
├── start_gui.sh / .bat   # 启动 GUI（含预检：代理/node 依赖/venv/Chromium）
├── run_tests.sh / .bat   # 回归测试套件（后端 pytest + GUI CDP）
└── release.sh / .bat     # 发布构建（Linux AppImage / Windows NSIS）
```

## 开发环境搭建

前置条件：**Python 3.11+** 和 **Node 20+**。GUI 拥有 Python 后端：开发模式下它启动顶层 `.venv` 的 python（见 `gui/src/main/index.ts:backendInfo`），所以两个环境都必须存在。

### Linux

```bash
# 1. 后端（Python venv，在仓库根目录）
python3 -m venv .venv && .venv/bin/pip install -e .
# 2. GUI（Node 20+，例如通过 nvm）
cd gui && npm install

# 运行（回到仓库根目录）
cd .. && ./start_gui.sh                        # 上次使用的项目 / 询问
./start_gui.sh --root /path/to/proj            # 指定项目
```

### 中国 / 受限网络

`npm install` 常常死在 `electron` 的 `postinstall`，而不是 npm 包本身。脚本从 GitHub（`github.com/electron/electron/releases`）下载 `electron.exe`。在本机该连接超时（`ETIMEDOUT`），`https://npmmirror.com/mirrors/electron/` 也超时。返回 HTTP 200 的 URL 是：

```text
https://cdn.npmmirror.com/binaries/electron/v<version>/electron-v<version>-win32-x64.zip
```

涉及两个不同的镜像。不要把 `electron_mirror` 放进 `.npmrc`：npm 11 会警告 `Unknown project config "electron_mirror"`，且该值会覆盖可用的镜像，导致安装仍命中死主机。

1. 包注册表 — 仅本地。`gui/.npmrc` 被 gitignore，需自行创建：

```text
registry=https://registry.npmmirror.com
```

2. Electron 二进制 — 已在 `gui/package.json` 中。`@electron/get` 从这个块读取 `npm_package_config_electron_*`：

```json
"config": {
  "electron_mirror": "https://cdn.npmmirror.com/binaries/electron/",
  "electron_custom_dir": "{{ version }}"
}
```

然后从 `gui/` 目录：

```bat
npm install
node -e "console.log(require('electron'))"
```

第二条命令应打印 `...\gui\node_modules\electron\dist\electron.exe`。

如果 `postinstall` 仍在下载中途重置（`ECONNRESET`），跳过脚本，手动下载 zip 并放到 Electron 期望的位置。把 `31.7.7` 替换为 `node -p "require('./node_modules/electron/package.json').version"`。

```bat
cd gui
set ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm install
curl -L --retry 5 -o %TEMP%\electron.zip https://cdn.npmmirror.com/binaries/electron/v31.7.7/electron-v31.7.7-win32-x64.zip
mkdir node_modules\electron\dist
tar -xf %TEMP%\electron.zip -C node_modules\electron\dist
if exist node_modules\electron\dist\electron.d.ts move /Y node_modules\electron\dist\electron.d.ts node_modules\electron\electron.d.ts
<nul set /p=electron.exe> node_modules\electron\path.txt
node -e "console.log(require('electron'))"
```

`path.txt` 必须恰好是 `electron.exe` 且无尾部换行。Linux 用 `electron-v<version>-linux-x64.zip` 并写 `electron`。macOS 写 `Electron.app/Contents/MacOS/Electron`。

### Windows

```bat
:: 1. 后端（Python venv；python 必须 3.11+，在仓库根目录）
python -m venv .venv
.venv\Scripts\pip install -e .
:: 2. GUI（Node 20+ 在 PATH 上）
cd gui
npm install

:: 运行（从仓库根目录）
start_gui.bat
start_gui.bat --root C:\path\to\project
```

说明：

- GUI 自动在顶层 `.venv\Scripts\python.exe` 定位后端；若缺失则回退到 PATH 上的 `python`（此时 `coder_agent` 包必须可导入）。
- Windows 不需要 `--no-sandbox`（那是 Linux/root 的问题），所以 `start_gui.bat` 不传它。
- CDP 冒烟测试（`cdp_*_test.cjs`）跨平台：Windows 上用 `netstat`/`taskkill` 代替 `ss`/进程组。
- `debug_backtrace` agent 工具需要 `gdb`（仅 Linux）；Windows 上该工具报告友好的 "gdb is not installed" 错误，agent 回退到 `run_command`。

## 测试

```bash
# Linux：全部（后端 pytest + 所有 GUI CDP 冒烟测试）
./run_tests.sh

# Windows：相同，在 cmd 提示符下
run_tests.bat
```

单独目标：`backend`、`gui`、`remote`（需要 `127.0.0.1:8931` 上的独立服务器），或单个 GUI 测试名（`boot`、`theme`、`split`、...）。
`cd gui/tests/e2e && node run_all_tests.cjs [names...]` 直接运行 CDP 套件（`remote` 测试会自行启动远程服务器）。

## 构建与发布

应用以每平台单个自包含二进制分发：

- **Linux**：`coder-agent-<version>.AppImage`（x86_64）
- **Windows**：`coder-agent-<version>.exe`（NSIS 安装器）

目标机器**无需预装任何东西** — 无 Python、无 Node。Python 后端打包为 PyInstaller 单文件可执行，随应用一起分发（`resources/backend/`）；Electron 主进程自动定位并启动它（见 `gui/src/main/index.ts:backendInfo`）。

### 构建安装包

```bash
# 一次性：后端 venv（PyInstaller 是构建期工具而非运行期依赖，
# 缺失时发布脚本会自动安装）
python3 -m venv .venv && .venv/bin/pip install -e .

# Linux（在 Linux x86_64 上构建）
./release.sh           # -> release/coder-agent-<ver>.AppImage

# Windows（在 Windows 上构建；PyInstaller 和 NSIS 不能交叉编译）
release.bat            # -> release/coder-agent-<ver>.exe
```

`release.sh` 不接受参数 — 总是构建 Linux AppImage。Windows 安装器只由 `release.bat` 构建，且必须在 Windows 上运行（PyInstaller 不能交叉编译后端）。

**Windows：从提升权限（管理员）提示符运行 `release.bat`。**
electron-builder 用 7-Zip 解包 winCodeSign 工具，会创建符号链接（如 `darwin/10.12/lib/libcrypto.dylib`）；普通用户缺少该权限，构建会以 `Cannot create symbolic link : A required privilege is not held by the client` 失败。修复：右键 cmd → "以管理员身份运行"，再 `release.bat`（或启用 Windows 开发者模式，授予普通用户创建符号链接的权限）。

脚本做了什么：

1. `build_standalone.py` — PyInstaller 单文件构建 `coder_agent.server`（包数据 `prompts/defaults`、`defaults`、`skills` 被嵌入）到 `gui/build-resources/backend/`。
2. `electron-builder`（配置在 `gui/package.json` 的 `"build"` 下）— 把 `gui/dist` + 后端打包进 AppImage / NSIS 安装器。

### 在目标机器上安装

**Linux**

```bash
chmod +x coder-agent-0.1.0.AppImage
./coder-agent-0.1.0.AppImage
```

（可选：移到 `/opt` 或 `~/Applications` 并创建 `.desktop` 条目。）首次运行：点击工具栏的项目标签选择要处理的项目，然后打开 **Settings** 配置 LLM 提供商和 API key。

**Windows**

运行 `coder-agent-0.1.0.exe` 并按安装器操作（可选择安装目录）。从开始菜单启动 "Coder Agent"。首次运行相同：选择项目，然后在 **Settings** 配置 LLM。

### 应用数据存放位置

| 内容 | Linux | Windows |
|---|---|---|
| 配置、prompts、skills、memory（`~/.coder_agent`） | `~/.coder_agent` | `%USERPROFILE%\.coder_agent` |
| GUI 状态（上次项目、userData） | `~/.config/coder-agent-gui` | `%APPDATA%/coder-agent-gui` |
| 会话 / 快照 | `<project>/.agent` | `<project>\.agent` |

后端是 GUI 进程的子进程：随应用启动，可从工具栏崩溃横幅重启，退出时被杀死。若无法启动，窗口显示 "Backend process exited" 横幅并带 Restart 按钮。

## 远程服务器

GUI 可驱动运行在另一台机器上的 `coder-agent-server`。项目路径在服务器机器上；GUI 是纯界面。Settings > Remote server 提供两种远程模式（SSH 隧道 / 直连）。

## 开发进度

- [x] **Phase 0** — 脚手架：Electron+TS 应用、Python 后端子进程、WS 握手
- [x] **Phase 1** — 后端 WebSocket RPC + 事件协议
- [x] **Phase 2** — 主窗口布局 + 实时事件渲染
- [x] **Phase 3** — 会话、turn、rewind / edit-and-rerun
- [x] **Phase 4** — 对话框（审批、计划审查、stage 确认、编辑 prompt）
- [x] **Phase 5** — 设置（模型 / 上下文 / 任务 prompts / 审批）
- [x] **Phase 6** — 打磨：后端崩溃横幅 + 就地重启、干净退出（后端被 SIGTERM 且应用等待其退出）、IME 安全的 Enter 处理、后端宕机时 fail-fast RPC、英文 UI
