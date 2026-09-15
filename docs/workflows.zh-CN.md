# 工作流参考

[快速开始](../README.zh-CN.md) · [English](workflows.md)

## 直接告诉它你要什么

在插件工作区打开 DSH 或 Codex agent，像平时一样描述目标：

```text
做一个 DSH 插件，把本地搜索服务变成模型工具。
修好这个插件，让它能在 web profile 中冷启动。
升级这个仓库，但不能破坏当前正式版通道。
审计这个插件，修完所有 blocker，再给我安装命令。
检查这些 Claude hooks 在这套 DSH 上是否仍会拒绝工具调用。
```

自然语言就是主入口。DSH 与 Codex 会选择 dsh-developer、提取目标与约束，并直接完成问答和只读审计。实现请求会得到一份简洁计划，agent 随后完成已获授权的修改、测试和修复；只有尚未明确的重要选择或额外权限需要询问。

需要确定性选择时，DSH 中的 `/dsh-developer` 与 Codex 中的 `$dsh-developer` 可以直接锁定它；用户不必学习命令词汇。

## 开发现有项目

用 `project` 定位实际 package、工具链和脚本，用 `knowledge` 查询精确安装版本或源码 checkout。通过宿主正常的执行策略使用 `run`、`verify` 和 `dev`；依赖保留在原生工作区。`verify` 在临时 profile 中调用真实全局工具并比较结果，`dev` 管理临时 Web 服务及退出清理。它们不是不可信代码沙箱。详见[开发指南](development.md)，包含 TypeScript 示例、打包产物验证和 DSH 自身开发。

在 DSH 内的 POSIX shell 中使用 `node "$DSH_DEVELOPER_BIN" <操作>`，PowerShell 中使用 `node "$env:DSH_DEVELOPER_BIN" <操作>`。DSH 提供已安装插件的绝对入口，并默认选择当前运行时。下文的 `node bin/dsh-developer.js` 和 npm 脚本示例要求以 dsh-developer checkout 为工作目录；安装到 profile 不会创建全局 CLI 命令。

## 交付插件

从你手里的东西开始：

| 你已经有 | 运行 | 直接得到 |
| --- | --- | --- |
| 一个普通插件 | `doctor --skip-runtime`，然后 `verify` | 静态检查，以及所选 DSH 上的真实原生调用结果 |
| 一个要装进受审通道 profile 的插件 | 安装前运行 `preflight` | 启动前证明所需 Cordis 服务全部存在 |
| 一份 Creator 导出 | `promote` | 字节可复现、经过测试的 DSH + Codex bundle |
| 受审通道之间的 DSH 升级 | 修改前运行 `impact` | 这个插件真正需要重验的上游契约 |
| 本产品或 promotion 生成的发布 bundle | `compatibility` | 正式版与预览版 DSH 上的运行实证 |
| 一套陌生的 DSH 安装 | `capabilities` | 精确的运行时身份与可用开发路径 |
| 一个已安装的 profile | `attest-profile` | 你实际测试过的静态字节的规范 receipt |
| Codex 或 Claude Code hooks | `hook-doctor` | 任何 hook 命令运行前的静态兼容性 |

`hook-doctor` 把配置绑定到受审字节，不导入、执行、展开或声称激活。正式版 `0.1.1-rc.2` 没有 bridge；精确 `0.1.2-alpha.3` 仅有部分支持。

不启动 profile、也不加载 package，即可证明一个现有物理 profile：

```powershell
node bin/dsh-developer.js attest-profile --profile C:\Users\you\.dsh\profiles\web --dsh D:\path\to\dsh.cmd --json
```

receipt 把 DSH 可执行文件绑定到你测试过的精确静态 profile 字节。两次扫描会在不启动 package 的前提下捕获 link、越界、变化、未解析状态与凭据。正式版 `0.1.1-rc.2` 阻断，预览版 `0.1.2-alpha.3` 仅提示。

在 DSH Web 中静态检查普通插件仓库：

```text
/dsh-developer-doctor {"source":"C:/path/to/plugin","skipRuntime":true}
```

随后按[开发指南](development.md)使用 `verify --profile <名称>` 验证目标运行时，用 `dev` 检查实际 Web 界面，并通过 `--patch` 验证文档中的配置。Doctor 默认运行时审计与 preflight 要求受审通道。对于 0.1.5-rc.2 等其他精确版本，使用静态 Doctor 和上述普通验证路线。本产品和 promotion bundle 继续使用认证发布门禁；安装版本较新本身并不是普通插件的缺陷。

Doctor 检查 package 与 bundle 契约、冷启动依赖被错标为 optional、Host/Client 注入混用、Client 服务冲突、上游 connection 服务之外的插件自建原始 Web 路由，以及无效的 Web 产物。通过 connection 注册并不等于已经证明认证有效：不同 DSH 版本的 API 和保护机制有所不同，必须验证实际部署的版本和配置。本产品和 promotion bundle 还会检查可复现性及获准的干净 profile 生命周期。检查保持目标仓库只读；静态结果不能证明运行行为。

把 Creator 中保存的导出直接变成可安装 bundle：

```text
/dsh-developer-promote {"source":"C:/path/to/hello-dsh.creator.json","output":"C:/path/to/hello-dsh"}
```

Promotion 只创建一个全新目标目录，逐字节复现导出内容，并跑完正式版门禁。失败时，暂存目录会完整保留，供你定位问题。通过后直接安装：

```powershell
dsh plugin --profile headless add C:\path\to\hello-dsh
dsh --profile headless --dump-config
```

## DSH 升级，插件照常交付

对于受审的 0.1.1-rc.2 → 0.1.2-alpha.3 通道，在升级修改前先运行影响分析：

```powershell
node bin/dsh-developer.js impact --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
```

它只追踪插件真正触及的 package 与 Cordis 服务，再比较两个通道中的公开声明、入口、依赖和 DSH 元数据。它会离线证明声明的 DSH peer/dev 范围是否覆盖实际安装的正式版与预览版精确版本，并严格遵循 npm 的预发布版本规则；registry 发布状态与项目 lockfile 仍由安装证据单独确认。

对于其他目标，先用 `knowledge` 检查两个精确安装或源码 checkout，沿受影响的源码与调用方确认变化，再修改。随后在每个目标运行时上使用静态 Doctor 和 `verify`/`dev`。这条普通开发路线不扩大受审通道的认证范围。

对于精确的 `0.1.1-rc.2` → `0.1.2-alpha.3` 源码走廊，可用只读 migration ledger 获取文件与行号级行动项：

```powershell
node bin/dsh-developer.js migration --source C:\path\to\plugin --from-dsh 0.1.1-rc.2 --to-dsh 0.1.2-alpha.3
```

v1 只报告两个已安装契约规则族：已移除 Web Client runtime 的 dependency、Client inject、字面量 module 触点及已验证 owner 映射；以及直接具名的 `CallId` → `ToolCallId` binding。它绝不修改源码；其他走廊在读取前失败，未映射符号保留 pending，目标端已消失的变化不生成行动项。

对于本产品或 promotion bundle，Compatibility 把同一份可信字节分别放进两套精确运行时。普通插件应在每个目标版本上分别使用 `verify`：

```powershell
node bin/dsh-developer.js compatibility --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
```

每份报告都以稳定 digest 收尾，并绑定最终未变更的源码树。

## 每个 DSH agent 都用同一条工作流

全局 `dsh_developer` 工具通过 DSH 原生工具注册表覆盖 Web、headless、ACP、Code Mode 与 JSON-RPC agent：

```json
{"operation":"doctor","source":"C:/path/to/plugin","skipRuntime":true}
```

一个 schema 覆盖全部审计、Build 和 Apply 操作。被阻塞的结果最多附带三个封闭的 `nextActions`，文本只显示第一个；它们不能执行、授予权限、改变 digest 或把预览证据当成发布证据。

被委派的 agent 与固定权限边界的 agent 也能拿到真实的 shell 和文件 schema：不可能获批的升级参数不会出现，过期参数会在执行前被删除，真实拒绝会明确说明不可跨越的边界，不再让模型掉进无效重试。

```text
dsh_developer {"operation":"authority"}
dsh_developer {"operation":"delegation"}
```

## Agent 原生 UI 验证

dsh-developer 为每个 agent 提供独立、紧凑、受保护的浏览器会话，用于本地插件 UI 开发。它使用固定版本的 Playwright CLI，以语义动作代替任意浏览器代码，把导航限制在 loopback，并保存有明确上限的视觉证据。

```text
dsh_developer {"operation":"ui"}
dsh_ui {"operation":"open","url":"http://127.0.0.1:4173/"}
dsh_ui {"operation":"snapshot","depth":6}
dsh_ui {"operation":"fill","target":"e5","text":"Ada"}
dsh_ui {"operation":"click","target":"e6"}
dsh_ui {"operation":"wait","text":"Saved"}
dsh_ui {"operation":"close"}
```

先在 DSH 的 POSIX shell 中运行 `node "$DSH_DEVELOPER_BIN" ui-setup`（PowerShell：`node "$env:DSH_DEVELOPER_BIN" ui-setup`），再重启 DSH 并检查 UI 能力。配置命令会查找常规位置中已安装的 Chrome/Edge 和固定版本 CLI。若缺少 CLI，在该命令后显式加上 `--install-cli`，将 `@playwright/cli@0.1.18` 安装到专用本地目录。普通启动和只读能力检查绝不自动安装。

配置默认保存在 `~/.dsh-developer/ui/config.json`。临时验证可使用 `ui-setup --config <绝对文件路径>`，并在 DSH 启动和 shell UI 环境中将 `DSH_DEVELOPER_UI_CONFIG` 设置为同一文件。也可用 `--cli-entry` 和 `--browser-executable` 显式指定绝对路径；原有入口、浏览器和状态环境变量仍可覆盖保存值。配置命令不启动浏览器，也不证明 UI 行为。完整配置与操作契约见 [Agent 原生 UI](../skills/dsh-developer/references/agent-native-ui.md)。

对于正在运行的 `dev` 服务，将返回的 `ui` 对象传给 `dsh_ui`；shell 使用 `ui --session <名称> --action open --development-server <dev 返回的 home>`。浏览器在内部完成 DSH 登录，工具参数和输出不包含登录令牌。保持 `dev` 运行，完成后关闭浏览器。普通 `url` 导航仍拒绝凭据。信任边界与热更新说明见 [Web 开发](development.md#work-with-web)。

Codex 和其他具备 shell 的 agent 直接使用同一个控制器：

```powershell
node bin/dsh-developer.js ui --session codex-task --action open --url http://127.0.0.1:4173/ --json
node bin/dsh-developer.js ui --session codex-task --action snapshot --depth 6 --json
node bin/dsh-developer.js ui --session codex-task --action close --json
```

## 为自主开发而生的隔离

只读分析不执行目标代码。认证运行时审计仅执行本产品和逐字节可复现的 promotion 输出；凭据不进入这些审计的子进程或证据。普通可信开发遵循上文的宿主执行策略。

隔离 Build/Apply 要求当前运行的 DSH 属于受审通道（0.1.1-rc.2 或仅供提示的 0.1.2-alpha.3），并使用已准入的隔离 cell（Windows 使用 WSL2 + Bubblewrap，支持的 Mac 使用 Apple container）：一次性、断网、无凭据、有界、串行、封存且清理可验证。DSH 0.1.5-rc.2 尚无隔离准入；见 [Mac 运行时配置](macos.md#enable-isolated-build-and-apply)。为 CLI 审计指定另一个 `--dsh` 不会切换当前 agent 的运行时。

在顶层 DSH Agent 中，隔离 Build 原生且不接收路径。控制器从当前存活的根 Agent 推导源码，把命令和安全策略绑定到会过期的 digest，再由 DSH 发起可审计的一次性批准：

```json
{"operation":"cell-plan","outcome":"运行聚焦测试和仓库检查","commands":[{"command":"node --test","timeoutMs":60000},{"command":"npm run check","timeoutMs":60000}]}
{"operation":"cell-run","planDigest":"sha256:<cell-plan 返回的 digest>"}
```

如果运行封存了变化，只能二选一：

```json
{"operation":"cell-apply","planDigest":"sha256:<同一个 digest>"}
```

或者

```json
{"operation":"cell-discard","planDigest":"sha256:<同一个 digest>"}
```

`cell-run` 封存获批的隔离变化。`cell-apply` 重证所有者、源码、stage、检查和路径，再次请求批准。私有备份在不执行代码的前提下应用变化；失败恢复并验证原始字节，成功完成最终 Doctor 并清理。Discard 保持幂等；Apply 已提交后，它只完成清理，绝不会撤销源码变化。回滚含糊或崩溃证据会阻断复用。调用方路径不授予任何权限。

```powershell
node bin/dsh-developer.js lab --wsl-distro Ubuntu-22.04
node bin/dsh-developer.js admit-cell --dsh D:\path\to\dsh.cmd --wsl-distro Ubuntu-22.04
```

将 JavaScript API 嵌入其他系统前，请阅读 [execution-lab](../skills/dsh-developer/references/execution-lab.md)、[isolated-cell](../skills/dsh-developer/references/isolated-cell.md) 与 [safety](../skills/dsh-developer/references/safety.md) 契约。

## 在 Codex 中使用

这个仓库本身也是原生 Codex 插件。用 `$plugin-creator` 把现有目录加入个人 marketplace，安装 **dsh-developer**，然后调用 `$dsh-developer`。DSH 与 Codex 共用同一条工作流和同一套安全规则。

## 兼容性

- 普通开发：所选精确运行时，包括 DSH 0.1.5-rc.2；见[实测结果](verification.md)。
- 受审审计与隔离通道：DSH 0.1.1-rc.2（阻断发布）及 0.1.2-alpha.3（仅供提示）。
- Node.js：`^22.18.0 || >=24.11.0`
- 原生开发：Windows、macOS 与 Linux。实测边界和独立的 Windows/macOS 隔离 Build 要求详见[平台支持](platforms.md)。

正式版失败会阻止交付；预览版漂移会持续可见，并在下一版 DSH 正式发布前完成修复。

## 开发 dsh-developer

完整测试套件确定性运行，不需要 API Key：

```powershell
npm run validate
npm pack --dry-run
```

## 许可证

[MIT](../LICENSE)
