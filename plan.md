# Multi-Agent Self-Play Loop AI Native MVP 计划

## Summary
实现一个 TypeScript + pnpm 的本地 CLI 工具，用 Claude Agent SDK / Codex SDK 驱动一个最小 AI Native self-play loop。MVP 的完整体验以 Claude Agent SDK 为主：一个主 Agent、一个 reviewer subagent、一个 `ask_human(question)` CLI tool；主 Agent 自己决定何时修改代码、何时自查、何时调用 reviewer、何时问用户、何时交付。Codex SDK 先作为可选 backend 接入本地 thread/runStreamed 能力。

这个版本不做传统 `exec -> review -> judge` 状态机，不自造 subagent 调用协议，不实现 Judge。目标是先把“Agent 自主驱动执行与评审”跑通，而不是搭一个 workflow 框架。

## Key Decisions
- 技术栈：TypeScript + 单 pnpm 项目；CLI 使用 `commander` 或 `citty`。
- Backend：MVP 同时提供 `claude` 和 `codex` 两个 backend；默认 `claude`。Claude backend 提供 reviewer subagent 与 `ask_human` tool 的完整 AI Native 闭环；Codex backend 先接入 SDK thread、sandbox、approval 与流式事件日志。
- Agent 配置：使用 `agentroles.yaml`，只包含 `main` 和 `reviewer` 两个 prompt。
- 调度方式：主 Agent 同时承担 specs 里的“调度 + Exec”职责，拥有 workspace 修改权限，并自主决定下一步动作。
- Review：`reviewer` 是 Claude Agent SDK 原生 subagent，prompt-only、只读，用来从目标、diff、实现风险和测试角度提出质疑。
- Human-in-the-Loop：通过 `ask_human(question)` tool 实现，由主 Agent 主动调用；Runtime 不根据业务规则强制判定何时问人。
- 预算控制：使用 `--max-turns` 和 SDK 超时作为兜底，不使用 `max-rounds`。
- 权限控制：依赖 Claude Agent SDK 的 `permissionMode`、allowed tools / hooks 等原生能力；不做事后 diff 检测式权限判断。
- 日志：只保留一次运行的 session log，记录目标、Agent 轨迹、reviewer 反馈、用户回答和最终摘要；不预铺长期 workspace 记忆。

## CLI Interface
- `maspl init-roles`：生成默认 `agentroles.yaml`，包含 `main` 和 `reviewer`。
- `maspl run --goal "<目标>" --workspace <path> --roles agentroles.yaml --backend claude --max-turns 30`：启动一次 AI Native self-play session。
- 默认运行记录写入 `<workspace>/.maspl/runs/<run-id>/session.md`。

## Agent Definitions
- Main Agent：核心执行者，默认使用 Claude Agent SDK，也可切换 Codex SDK。输入为用户目标、workspace 路径、最近 session 摘要、reviewer 能力说明和 `ask_human` tool。Claude backend 下它可以读取/修改 workspace、运行命令、调用 reviewer、调用 `ask_human`、继续迭代或交付最终结果。
- Reviewer Subagent：审查者，使用 Claude Agent SDK 原生 subagent/agent 定义。输入由 Main Agent 决定，通常包括目标、关键文件、diff 摘要、测试结果和当前实现说明。它只输出自由文本 review，不修改 workspace，不决定下一步。
- ask_human Tool：CLI 交互工具，入参只有 `question: string`，通过 readline 向用户提问并把回答返回 Main Agent。所有人工回答写入 session log。
- Codex Backend：使用 `@openai/codex-sdk` 的 `Codex.startThread().runStreamed()` 运行本地 agent，配置 workspace、sandbox、approval、model 并记录流式事件。当前公开 SDK 类型未暴露原生 subagent 或 in-process tool 注册能力，因此 Codex backend 不伪造 reviewer/ask_human 工具；reviewer prompt 以内联审查纪律注入主 prompt。

## Implementation Plan
- 搭建 TypeScript 项目骨架：pnpm、CLI 入口、tsconfig、基础测试框架。
- 实现 `agentroles.yaml` 解析与基础校验：必须包含 `main.prompt` 和 `reviewer.prompt`；可选配置 `permissionMode`、allowed tools、timeout、model。
- 实现 Backend 抽象：`AgentBackend.run()` 接收 goal、workspace、roles、session log、askHuman、预算参数。
- 实现 Claude Agent SDK adapter：
  - 初始化 Claude Agent SDK session。
  - 注册 reviewer subagent。
  - 注册 `ask_human(question)` tool。
  - 配置 workspace、permission mode、allowed tools、timeout、max turns。
  - 收集流式输出、tool 调用、subagent 结果、错误信息并写入 session log。
- 实现 Codex SDK adapter：
  - 通过 `@openai/codex-sdk` 启动 thread。
  - 配置 workspace、sandbox、approval、model。
  - 收集 `runStreamed()` 事件、agent message、错误信息并写入 session log。
  - 不重造 subagent/tool 协议；SDK 暴露原生能力后再补 reviewer/ask_human 注册。
- 实现 `maspl run`：
  - 校验 workspace 存在且可访问。
  - 检查 Claude SDK / Claude Code 可用性，清晰报告未登录、API key 缺失、binary 不在 PATH、SDK 初始化失败。
  - 构造主 Agent system prompt：要求其 self-play 到目标达成，可自由修改代码、调用 reviewer 质疑、必要时调用 `ask_human`，最终给出结果摘要。
  - 将 goal 交给主 Agent，Runtime 只负责预算、超时、日志和 CLI 工具执行。
- 实现 `maspl init-roles`：生成最小 `agentroles.yaml`，包含 main prompt、reviewer prompt 和默认权限配置。
- 实现 session log：写入 `<workspace>/.maspl/runs/<run-id>/session.md`，包含 goal、turn 摘要、reviewer 输出、human Q&A、最终输出和错误。
- 上下文策略：不维护长期记忆；单次 session 内由 Claude SDK 管理上下文，Runtime 只在日志中记录摘要。
- 失败处理：SDK 初始化失败、运行超时、tool 执行失败、用户中断时直接停止并输出可读错误；不让 Runtime 接管业务调度。

## Test Plan
- 单元测试：`agentroles.yaml` 解析、缺失 main/reviewer 报错、CLI 参数校验、session log 写入。
- Tool 测试：`ask_human(question)` 能通过 mocked readline 返回答案，并写入 session log。
- Claude adapter 测试：用 fake SDK 覆盖初始化成功、未登录/API key 缺失、binary 缺失、超时、tool 调用、subagent 调用、错误冒泡。
- CLI 测试：`init-roles` 生成合法配置；`run` 能创建 `.maspl/runs/<run-id>/session.md`。
- 手工验收：在一个小型代码任务上运行，确认 Main Agent 能修改 workspace、主动调用 reviewer、根据 reviewer 反馈继续修改或交付，并能在不确定时调用 `ask_human`。

## Assumptions
- MVP 优先守住 AI Native 原则：主 Agent 是核心决策与执行层，Runtime 只做边界和工具承载。
- specs 中四角色在 MVP 中收敛为：调度 + Exec = Main Agent，Review = reviewer subagent，Judge = Main Agent 的自检/决策过程。
- 第一版默认用 Claude Agent SDK；Codex SDK 已接入基础 backend。飞书、Telegram、长期记忆、test case 管理和超参搜索场景都留到后续版本。
- 第一版不要求结构化输出，除 `ask_human(question)` 的 tool 入参外，Agent 和 reviewer 都使用自由文本。
