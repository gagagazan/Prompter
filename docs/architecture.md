# Prompter v0.1 架构约束

## 信任边界

React WebView 只能调用白名单 command，文件操作只能提交当前 `PromptLibrarySession` 发放的 ID。设置页可只读显示用户已经授权的根目录，但不能把任意路径提交给文件 command；前端没有文件系统、shell、Git 或自动粘贴权限。

`PromptLibrarySession` 是文件库唯一入口：

- `snapshot()` 返回一次 revision 下的一致目录与问题视图。
- `read(id)` 返回纯文本及 opaque `ContentVersion`。
- `search(query)` 查询当前 revision 的内存索引。
- `mutate(...)` 串行执行创建、保存、移动、重命名和移入废纸篓。
- `updates()` / `subscribe()` 把 watcher 提示合并为新的完整 revision。

Prompt ID 只在当前进程的当前文件库 session 内有效。因为资料库中明确禁止 metadata，应用重启后无法可靠判断外部 rename 是否仍是同一个逻辑 Prompt；相对路径只能作为重新发现线索，不能当永久身份。

## 文件不变量

1. 根目录在打开时解析并固定；每次 mutation 都重新验证目标仍位于根目录内。
2. 递归时跳过 `.git`、symlink、junction 与 link-like reparse point。
3. 只管理最终扩展名精确为 `.prompt` 的普通文件。其他文件只影响目录删除的安全检查。
4. 文件必须是严格 UTF-8；已有 UTF-8 BOM 在保存时保留。正文不做 Unicode 或换行归一化。
5. 新名称写为 NFC，并通过 portable case-fold key 检查大小写与 Unicode 组合形式冲突；同时拒绝 Windows 非法名称。
6. 所有 mutation 都禁止静默覆盖。
7. 保存携带读取时的 `ContentVersion`，写入同目录临时文件，flush 后再次核对版本，再做平台原子替换。
8. Trash 是唯一删除路径；目录若包含未管理、链接或不可读内容则拒绝。

## 外部变化

watcher 只负责降低延迟，扫描才是事实来源。事件经过 200ms 防抖；丢失、溢出、根目录变化、窗口重新聚焦、系统恢复与 60 秒审计都会触发重新枚举。搜索索引只存在内存中，并和目录快照在同一 revision 提交。

编辑器在 clean 状态收到外部变化时自动重载；dirty 状态保留用户草稿并进入冲突状态。没有不带版本条件的 force save。

跨平台文件 API 没有“按内容版本条件替换”的原语，因此最后一次版本核对与原子替换之间，无法对完全不合作的外部 writer 提供线性化 CAS。Prompter 通过替换前二次核对、周期重扫、dirty 冻结和不提供 force save 缩小并显式管理该边界；这不是文件锁能够对不遵守锁的编辑器消除的竞态。

## 系统集成

所有 launcher、manager、settings 显示都通过一个 window presenter，统一执行显示、恢复、激活和聚焦。全局快捷键注册先撤销旧绑定再注册目标绑定，配置更新与恢复审计可安全重复执行。关闭 manager 只隐藏，托盘的明确“退出”才终止进程。
