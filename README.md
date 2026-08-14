# Prompter

Prompter 是一个 local-first、跨平台的常用 Prompt 启动器与纯文本管理器。你的文件夹就是资料库，目录就是分类，文件名就是标题；正文始终保存在普通的 UTF-8 `.prompt` 文件中，可以直接用 Git 或任意文件同步工具管理。

> 当前版本：`0.1.0`。支持 macOS 13+（Apple Silicon / Intel）与 Windows 10 22H2+ / Windows 11（x64）。

## 产品原则

- 文件系统是唯一事实来源，不在资料库里写数据库、索引、 sidecar 或隐藏元数据。
- 只识别扩展名精确为小写 `.prompt` 的普通文件。
- Rust 独占文件、搜索、监听、剪贴板、快捷键与窗口系统能力；WebView 只传递当前会话内有效的 opaque ID。
- 保存使用内容版本检查和同目录原子替换，不静默覆盖外部编辑器或 Git 已经写入的新版本。
- 删除只进入系统废纸篓或回收站；系统不支持时直接报错。
- 管理器只提供真正的纯文本编辑，不渲染 Markdown，也没有富文本工具栏。

## 界面

| 启动器 | 管理器 | 设置 |
| --- | --- | --- |
| [查看截图](docs/screenshots/launcher.png) | [查看截图](docs/screenshots/manager.png) | [查看截图](docs/screenshots/settings.png) |

## 开发

需要 Node.js 22+、pnpm 11、stable Rust，以及对应平台的 Tauri 2 桌面构建依赖。

```bash
pnpm install
pnpm test
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri dev
```

浏览器中可独立预览三个 React 界面：

- `http://localhost:1420/?surface=launcher`
- `http://localhost:1420/?surface=manager`
- `http://localhost:1420/?surface=settings`

浏览器预览使用确定性的内存示例资料；Tauri 运行时会自动切换到 Rust command adapter。

## 目录

```text
src/                   React 三窗口、i18n 与 DesktopBridge
src-tauri/src/library/ PromptLibrarySession 深模块
src-tauri/src/desktop/ Tauri commands、窗口 presenter 与系统集成
docs/                  架构约束与人工 smoke 清单
promptly/              保留的空参考目录，不属于本项目源码
```

本仓库暂未配置远程、正式发布流水线凭据或开源许可证。
