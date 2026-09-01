# dsh-developer

[English](README.md) · **简体中文**

> **The single plugin you need for DSH**
>
> **开发 DSH 插件，只需要这一个。**

Proudly designed and implemented by [MetaFlow](https://github.com/builtin-pb/metaflow). **dsh-developer** 把 DSH 插件开发收进一条原生工作流：从 DSH 或 Codex 里创建、诊断、验证、隔离执行，直到交付。

DSH 插件最棘手的问题，普通 linter 根本看不到：Host 和 Client 服务混在一起、Web bundle 引用了错误模块、目标 profile 缺少依赖服务，或一次 DSH 升级悄悄改变了原有契约。dsh-developer 会在这些问题抵达用户之前拦住它们，用正式版与预览版 DSH 的精确运行环境证明结果，并把同一份结构化证据交给人和 agent。

[![CI](https://github.com/builtin-pb/dsh-developer/actions/workflows/ci.yml/badge.svg)](https://github.com/builtin-pb/dsh-developer/actions/workflows/ci.yml) [![Node.js 22.18+](https://img.shields.io/badge/Node.js-22.18%2B-339933?logo=nodedotjs&logoColor=white)](package.json) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

```text
想法或现有仓库  ->  Doctor + profile 实证  ->  可安装、已测试的 DSH 插件
可信候选版本    ->  正式版 + 预览版通道    ->  经得起升级的证据
DSH 或 Codex agent -> 一条原生工作流       ->  安全的自主迭代
```

Doctor、promotion、profile preflight、compatibility、upstream impact、capability inspection 与 isolation check 均不需要模型或供应商 API Key。

## 安装

已验证环境：Windows、Node.js 22.18+、pnpm 11.7.0、DSH 0.1.1-rc.2。

```powershell
git clone https://github.com/builtin-pb/dsh-developer.git
cd dsh-developer
npm ci --ignore-scripts
npm test
dsh plugin --profile web add .
dsh web
```

安装完成后，你得到的是一个真正的 DSH bundle：共享 Agent Skill、覆盖所有 agent 表面的紧凑 `dsh_developer` 工具，以及 DSH Web 中可以直接调用的命令。

## 直接告诉它你要什么

在插件工作区打开 DSH 或 Codex agent，像平时一样描述目标：

```text
做一个 DSH 插件，把本地搜索服务变成模型工具。
修好这个插件，让它能在 web profile 中冷启动。
升级这个仓库，但不能破坏当前正式版通道。
审计这个插件，修完所有 blocker，再给我安装命令。
检查这些 Claude hooks 在这套 DSH 上是否仍会拒绝工具调用。
```

自然语言就是主入口。DSH 与 Codex 会为这些插件意图选择 dsh-developer；它读取工作区并提取目标与约束。问答和只读审计直接执行；修改任务先给出一份紧凑的影响与验证计划。批准修改范围后，agent 会接管修改、测试、诊断、修复、Doctor、profile 实证与精确版本通道验证。它只会在真正的权限边界——隔离执行、应用暂存变化、发布——或明确的外部 blocker 前暂停。

需要确定性选择时，DSH 中的 `/dsh-developer` 与 Codex 中的 `$dsh-developer` 可以直接锁定它；用户不需要学习一套命令词汇。

## 交付插件

从你手里的东西开始：

| 你已经有 | 运行 | 直接得到 |
| --- | --- | --- |
| 一个现有插件 | `doctor` | 只读的正式版审计，以及能直接执行的修复建议 |
| 一个要装进 profile 的插件 | `preflight` | 启动前证明所需 Cordis 服务全部存在 |
| 一份 Creator 导出 | `promote` | 字节可复现、经过测试的 DSH + Codex bundle |
| 一次即将到来的 DSH 升级 | `impact` | 这个插件真正需要重验的上游契约 |
| 一个可信的发布候选 | `compatibility` | 正式版与预览版 DSH 上的运行实证 |
| 一套陌生的 DSH 安装 | `capabilities` | 精确的运行时身份与可用开发路径 |
| 一个已安装的 profile | `attest-profile` | 你实际测试过的静态字节的规范 receipt |
| Codex 或 Claude Code hooks | `hook-doctor` | 任何 hook 命令运行前的静态兼容性 |

`hook-doctor` 把配置绑定到受审字节，不导入、执行、展开或声称激活。正式版 `0.1.1-rc.2` 没有 bridge；精确 `0.1.2-alpha.3` 仅有部分支持。

不启动 profile、也不加载 package，即可证明一个现有物理 profile：

```powershell
node bin/dsh-developer.js attest-profile --profile C:\Users\you\.dsh\profiles\web --dsh D:\path\to\dsh.cmd --json
```

receipt 把 DSH 可执行文件绑定到你测试过的精确静态 profile 字节。两次扫描会在不启动 package 的前提下捕获 link、越界、变化、未解析状态与凭据。正式版 `0.1.1-rc.2` 阻断，预览版 `0.1.2-alpha.3` 仅提示。

在 DSH Web 中审计仓库：

```text
/dsh-developer-doctor {"source":"C:/path/to/plugin","skipRuntime":false}
/dsh-developer-preflight {"source":"C:/path/to/plugin","profile":"web"}
```

不管插件是手写还是生成，直接交给 Doctor。它只盯住真正影响 DSH 的问题，不会让另一套工具链的规则淹没结果；进入正式版 promotion 的 bundle 仍必须过完整的来源证明门禁。

Doctor 会在插件拖垮真实 DSH profile 前发现问题：错误的 package 与 bundle 契约、冷启动必需的 package 被错标为 optional、Host/Client 注入混用、会让 Web 白屏的 Client 服务冲突、位于宿主认证 connection 边界之外的插件自建原始 Web 路由、浏览器端模块泄漏、不可复现的输出，以及无法通过干净 profile 生命周期验证的构建。整个审计过程保持目标仓库只读。

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

升级前先运行影响分析：

```powershell
node bin/dsh-developer.js impact --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
```

它只追踪插件真正触及的 package 与 Cordis 服务，再比较两个通道中的公开声明、入口、依赖和 DSH 元数据。它会离线证明声明的 DSH peer/dev 范围是否覆盖实际安装的正式版与预览版精确版本，并严格遵循 npm 的预发布版本规则；registry 发布状态与项目 lockfile 仍由安装证据单独确认。

对于精确的 `0.1.1-rc.2` → `0.1.2-alpha.3` 源码走廊，可用只读 migration ledger 获取文件与行号级行动项：

```powershell
node bin/dsh-developer.js migration --source C:\path\to\plugin --from-dsh 0.1.1-rc.2 --to-dsh 0.1.2-alpha.3
```

v1 只报告两个已安装契约规则族：已移除 Web Client runtime 的 dependency、Client inject、字面量 module 触点及已验证 owner 映射；以及直接具名的 `CallId` → `ToolCallId` binding。它绝不修改源码；其他走廊在读取前失败，未映射符号保留 pending，目标端已消失的变化不生成行动项。

Compatibility 随后把同一份可信字节分别放进两套精确运行时：

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

在 DSH 启动前配置精确的 Playwright CLI 入口、Chrome 或 Edge 可执行文件，以及绝对状态目录。完整配置与操作契约见 [Agent 原生 UI](skills/dsh-developer/references/agent-native-ui.md)。

Codex 和其他具备 shell 的 agent 直接使用同一个控制器：

```powershell
node bin/dsh-developer.js ui --session codex-task --action open --url http://127.0.0.1:4173/ --json
node bin/dsh-developer.js ui --session codex-task --action snapshot --depth 6 --json
node bin/dsh-developer.js ui --session codex-task --action close --json
```

## 为自主开发而生的隔离

只读分析不执行目标代码。受控执行只用于本产品和逐字节可复现的 promotion 输出；凭据不进入子进程或证据。

执行任务使用已准入的 WSL2 + Bubblewrap cell：一次性、断网、无凭据、有界、串行、封存且清理可验证。

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

将 JavaScript API 嵌入其他系统前，请阅读 [execution-lab](skills/dsh-developer/references/execution-lab.md)、[isolated-cell](skills/dsh-developer/references/isolated-cell.md) 与 [safety](skills/dsh-developer/references/safety.md) 契约。

## 在 Codex 中使用

这个仓库本身也是原生 Codex 插件。用 `$plugin-creator` 把现有目录加入个人 marketplace，安装 **dsh-developer**，然后调用 `$dsh-developer`。DSH 与 Codex 共用同一条工作流和同一套安全规则。

## 兼容性

- 正式版通道：DSH 0.1.1-rc.2
- 预览版通道：DSH 0.1.2-alpha.3
- Node.js：22.18 或更高
- 平台：Windows 优先；最强执行边界使用 WSL2 + Bubblewrap

正式版失败会阻止交付；预览版漂移会持续可见，并在下一版 DSH 正式发布前完成修复。

## 开发 dsh-developer

完整测试套件确定性运行，不需要 API Key：

```powershell
npm run validate
npm pack --dry-run
```

## 许可证

[MIT](LICENSE)
