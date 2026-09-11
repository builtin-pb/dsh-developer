# dsh-developer

[English](README.md) · **简体中文**

> **The single plugin you need for DSH**

dsh-developer 把创建、诊断、测试和升级检查整合进 DSH 与 Codex 的日常工作流。告诉智能体你想做什么，一起完成实现，并在分享之前确认它能在 DSH 中正常工作。

[![CI](https://github.com/builtin-pb/dsh-developer/actions/workflows/ci.yml/badge.svg)](https://github.com/builtin-pb/dsh-developer/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 用它做什么？

- **把想法变成插件。** 将本地服务、工具或工作流接入 DSH，让智能体直接使用。
- **做出更可靠的插件。** 提前发现安装失败、服务缺失和 Web 集成问题。
- **更从容地升级。** 了解 DSH 的变化，对照正式版与预览版检查插件。
- **参与 DSH 本身的开发。** 调查缺失的能力，验证现有行为，在上游源码中实现有针对性的改进。

已经有插件？直接从现有仓库开始，无需重新生成项目，也无需改用另一套目录结构。

## 安装

一条命令，加入 DSH Web：

```sh
dsh plugin --profile web add 'github:builtin-pb/dsh-developer#v0.1.0' --ignore-scripts
```

打开或重启 DSH Web（`dsh web`）。[还没安装 DSH？](docs/install.md) · [使用 Codex？](docs/workflows.md#use-it-from-codex)

## 然后，直接说你想做什么

> 做一个插件，让智能体能搜索我们的本地文档。

> 这个插件无法在 DSH Web 中启动，找出问题并修好它。

> 检查这个插件是否已经可以分享给别人。

智能体会根据你的请求选择工作流。描述目标、回答必要的问题、检查修改结果即可，无需记住专门的命令。

## 继续探索

- [开发与测试](docs/development.md)：精确版本源码导航、TypeScript 原生工具、打包验证和 Web 开发。
- [会话诊断](docs/session-diagnostics.md)：读取指定日志，定位工具调用、失败和完成状态。
- [详细工作流](docs/workflows.zh-CN.md)：命令、发布检查、升级和浏览器测试。
- [Mac 开发指南](docs/macos.md)：安装、隔离 Build，以及开发 DSH 本身。
- [平台选择](docs/platforms.md)：Windows、Mac 与 Linux 的路线、要求和验证范围。
- [参与贡献](docs/contributing.md)：从 `npm test` 开始，进一步验证与 DSH 的集成。

原生开发面向 Windows、macOS 和 Linux。工具与 Web 工作流已在 macOS 和 Linux ARM64 上使用 **DSH 0.1.5-rc.2** 实测；正式发布审计仍固定在 **0.1.1-rc.2**。验证范围见[实测结果](docs/verification.md)和[平台指南](docs/platforms.md)。

由 [MetaFlow](https://github.com/builtin-pb/metaflow) 设计与实现。采用 [MIT 许可证](LICENSE)。
