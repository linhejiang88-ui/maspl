# Multi-Agent Self-Play Loop AI Native MVP 计划

## Summary
实现一个 TypeScript + pnpm 的本地 CLI 工具，用 Claude Agent SDK / Codex SDK 驱动四 Agent 协作的本地 self-play loop。MVP 明确包含：

- Orchestrator Agent：只调度，不做具体操作。
- Exec Agent：拆 plan、执行、验证、产出。
- Review Agent：review Exec 的 plan、code、验证和结果，提出质疑。
- Judge Agent：基于 goal、Exec output、Review feedback 判断是否满足。

Runtime 不做业务判断，只承载 CLI、backend SDK、日志、预算、timeout、`ask_human` 边界。是否满足由 Judge Agent 判断，不由 Review Agent 或 Runtime 判断。

## Key Decisions
- 技术栈：TypeScript + 单 pnpm 项目；CLI 使用 `commander`。
- Backend：同时提供 `claude` 和 `codex` 两个 backend；默认按 `agentroles.yaml` 的 agent 级 `backend` 字段选择，Orchestrator / Exec / Judge 使用 `codex`，Review 使用 `claude`。CLI `--backend` 仅作为本次运行的全局 override。
- Agent 配置：使用 `agentroles.yaml`，包含 `orchestrator` / `exec` / `review` / `judge` 四个 prompt、权限和工具范围。
- Orchestrator：只负责分发任务、收集输出、根据 Judge 指令推进，不编辑文件，不执行项目命令。
- Exec：唯一负责具体执行的角色。对于宽泛、发散、高风险或多步骤问题，先以 `PLAN_ONLY` 模式产出规划；只有 Review 明确无 blocking findings 且 Judge 返回 `SATISFIED` 后，才以 `EXECUTE_APPROVED_PLAN` 模式修改 workspace、运行命令、产出结果。
- Review：以问题澄清者、范围收敛者、质疑者和 case builder 的角度只读审查 Exec 输出，主动定位用户真正要解决的问题，收敛 Exec 的工作面，挖掘假设，构造反例和验证 case，不因为“看起来合理”就放行。对于发散问题需要多角度审查；对于确定问题需要提出可执行 test case / 校验命令，并尽可能执行非破坏性验证。
- Review 每次必须使用固定可校验协议：`PROBLEM_FRAMING`、`SCOPE_REDUCTION`、`MUST_HAVE`、`NICE_TO_HAVE`、`OUT_OF_SCOPE`、`ASSUMPTIONS_OR_CLARIFICATIONS`、`CHALLENGE_CASES`、`VALIDATION_CASES`、`BLOCKING_FINDINGS`。Review 需要把 must-have 和 nice-to-have 分开，避免 Exec 变成大而全的执行器。只有会改变范围或正确性的阻塞问题才标为需要人工澄清；`BLOCKING_FINDINGS: none` 只有在已经给出 challenge cases 和 validation cases 后才允许。缺任一字段或字段为空时不算 Review pass。普通情况下 Exec/Review/Judge 改进循环不超过 3 轮；必要测试用例全部通过时应建议收敛交付。
- Judge：裁决 `SATISFIED` / `NOT_SATISFIED` / `NEED_HUMAN`，并把指令返回 Orchestrator。
- Judge 输出使用固定协议：`SATISFIED` 必须带非空 `Reason:`；`NOT_SATISFIED` 必须带不满足原因、修改方向和给 Orchestrator 的下一步指令；`NEED_HUMAN` 必须带阻塞问题、编号选项、空输入默认值和选项影响。
- Human-in-the-Loop：当 Judge 返回 `NEED_HUMAN`，或某个 Agent 返回 `CLARIFICATION_BLOCKED` / `PERMISSION_BLOCKED` 时，由 Orchestrator 输出 `NEXT_AGENT: human`，Runtime 通过 CLI `ask_human(question)` 询问用户。
- 人审交互：Orchestrator 提问必须尽量给可选项；CLI 渲染为编号菜单，用户回车不填时返回空字符串。Agent 需要基于空值继续处理或显式记录默认假设。
- 澄清受阻：`PLAN_ONLY` 阶段如果缺少某个会改变范围、正确性、验收标准、目标环境或验证方式的人工决策，Exec 或 Review 必须停止并返回 `CLARIFICATION_BLOCKED` 给 Orchestrator；Orchestrator 通过 Human-in-the-Loop 让人工选择或澄清后再继续。
- 权限受阻：任一 Agent 遇到权限、审批、sandbox、read-only 等阻塞时，必须停止并返回 `PERMISSION_BLOCKED` 给 Orchestrator；Runtime 会把权限类错误回灌给 Orchestrator，由 Orchestrator 通过 Human-in-the-Loop 让人工确认 approve / deny / modify scope 后再继续。
- 权限控制：优先依赖 SDK 原生权限。Orchestrator 默认无工具，Review/Judge 默认 read-only 或 plan，Exec 默认 workspace-write / acceptEdits。`runtime.allowedTools` 是所有 Agent 工具的硬 allowlist，role tools 必须与它取交集后才传给 backend。
- 日志：实时打印并写入 session log，记录每个 agent 的 start、input、running、output、handoff、end。
- 产出：每次运行必须在目标项目目录下写入 `<workspace>/.maspl/runs/<run-id>/result.md`，说明最终产出、产出位置和使用/验证方式。
- Task name：执行 `maspl run` 必须输入 `--task-name <task_name>` 作为唯一任务区分；默认项目目录为 `~/.maspl/project/<task_name>/`。
- Session：每次 `maspl run` 创建一个 backend 实例；该次运行内每个 Agent 必须保持自己的 backend session，不能每次调用都 new session，也不能跨 Agent 共用 session id。Agent 返回的 session/thread id 必须注册到内存并序列化到 `<workspace>/.maspl/runs/<run-id>/agent-sessions.json`；如果某 Agent 没有返回 session/thread id，则为该 Agent 生成一个 session id 并序列化。

## Agent Flow
```text
User Goal
  -> Orchestrator Agent
      -> NEXT_AGENT + TASK
  -> selected Agent
      -> output
  -> Orchestrator Agent
      -> NEXT_AGENT + TASK
  -> ...
  -> done / ask_human
```

### Responsibilities
- Orchestrator Agent：
  - 接收用户目标。
  - 接收所有其他 Agent 的输出。
  - 决定下一步由哪个 Agent 执行：Exec / Review / Judge / Human / Done。
  - 决定该 Agent 执行什么具体任务。
  - 根据 Judge 指令结束、重试或问人，但具体下一步仍由 Orchestrator 输出调度指令。
  - 对宽泛、发散、高风险或多步骤问题，必须先调度 Exec Agent 做 `PLAN_ONLY`，再调度 Review 和 Judge 审查计划；Judge 通过前不能进入执行。
  - 不进行具体实现，不编辑文件，不运行项目命令。
- Exec Agent：
  - 接收 Orchestrator 指令。
  - `PLAN_ONLY`：只读理解 workspace，输出可审查计划，不编辑文件，不执行实现。
  - `EXECUTE_APPROVED_PLAN`：执行已通过的计划，修改文件、运行命令、验证结果。
  - 输出变更、验证、产出和剩余风险。
- Review Agent：
  - review Exec 的 plan、code、验证过程和结果。
  - 定位用户真正要解决的问题，帮助 Orchestrator 收敛 Exec 的结果范围。
  - 明确哪些是本轮 must-have，哪些是 out of scope / nice-to-have。
  - 以质疑者视角澄清隐藏问题、挖掘假设、构造反例和验证 case。
  - 从正确性、测试覆盖、回归风险、假设、可维护性角度提出质疑，不能只因为方案看起来合理就通过。
  - 只挑出会影响范围或正确性的阻塞问题给人工澄清；非阻塞信息使用默认假设继续推进。
  - 发散问题多角度审查：目标匹配、范围、拆解、可行性、数据/文件依赖、验证计划、风险、边界情况、回滚和人工决策点。
  - 确定问题构建 test case 或校验命令；能无副作用执行的就执行，需要落盘的测试交给 Exec 添加或运行。
  - 不判断最终是否满足。
- Judge Agent：
  - 比较用户目标、Exec 输出、Review 反馈。
  - 输出 `SATISFIED` / `NOT_SATISFIED` / `NEED_HUMAN`。
  - 给出发回 Orchestrator 的下一步指令。

## CLI Interface
- `maspl init-roles`：生成默认 `agentroles.yaml`，包含四个 agent。
- `maspl run --task-name <task_name> --goal "<目标>" --workspace ~/.maspl/project --roles agentroles.yaml --max-turns 30`：按 `agentroles.yaml` 的 agent backend 配置启动一次四 Agent self-play session。`--backend claude|codex` 可覆盖所有 agent。
- `--task-name` 必填，且只能是单个路径段；Runtime 使用 `<workspace>/<task_name>/` 作为实际项目目录。
- `--workspace` 表示 workspace root，默认 `~/.maspl/project`；不是最终项目目录。
- 默认运行记录写入 `<workspace>/.maspl/runs/<run-id>/session.md`。
- Agent session registry 写入 `<workspace>/.maspl/runs/<run-id>/agent-sessions.json`。
- 最终交付物写入 `<workspace>/.maspl/runs/<run-id>/result.md`，该文件位于具体项目 workspace 内。

## Backend Implementation
The orchestration loop is backend-agnostic. Runtime owns:

- asking Orchestrator for `NEXT_AGENT` and `TASK`;
- invoking the selected agent through that agent's configured backend;
- appending that agent output to context;
- giving all outputs back to Orchestrator for the next decision.

Backends only implement `runAgent(agent, task)`.

每次 `maspl run` 必须通过 backend factory 创建独立 backend 实例。Runtime 按 agent 的 `backend` 配置选择 Claude 或 Codex；backend 实例内部按 agent 维度维护 session：

- Codex：`Map<agent, Thread>`，同一个 Agent 后续 turn 复用同一个 Codex thread。
- Claude：`Map<agent, sessionId>`，同一个 Agent 后续 turn 使用 `resume` 复用同一个 Claude session。
- Backend 返回的 session/thread id 写入运行级 session registry；未返回时生成 `maspl-<run-id>-<agent>-<uuid>`。
- 不同 Agent 不共享 session id；如果不同 Agent 返回同一个 backend session/thread id，Runtime 必须 fail fast。不同 `maspl run` 不复用 session。
- Exec Agent 的 `PLAN_ONLY` 任务在 backend 层强制只读：Claude 使用 `permissionMode: plan` 和只读工具；Codex 使用 read-only sandbox。

### Claude Backend
- 接收 Runtime 选择的 agent 和 task。
- 使用该 agent 的 prompt、model、permissionMode、tools 调用 Claude Agent SDK。
- 流式记录 SDK event。
- 不包含编排逻辑。

### Codex Backend
- 接收 Runtime 选择的 agent 和 task。
- 使用该 agent 的 prompt、model、sandbox、workspace 调用 Codex SDK。
- Exec Agent 使用 workspace-write；其他 agent 使用 read-only。
- 流式记录 Codex event。
- 不包含编排逻辑。

## Orchestrator Dispatch Protocol
- Orchestrator 每轮输出：

```text
NEXT_AGENT: exec | review | judge | human | done
TASK:
<具体任务>
```

- Runtime 只解析 `NEXT_AGENT` 和 `TASK`，调用对应 Agent，并把输出回灌给 Orchestrator。
- Runtime 不写死 Exec -> Review -> Judge 顺序，不做是否满足判断。若 Orchestrator 选择 `human`，Runtime 调用 `ask_human`，再把人工回答交回 Orchestrator。
- 当 `NEXT_AGENT: done` 时，`TASK` 必须说明最终产出、产出在 workspace 中的位置、以及如何使用或验证。Runtime 会把该内容写入 `<workspace>/.maspl/runs/<run-id>/result.md`。
- 如果 Orchestrator 输出不符合协议，Runtime 只允许重试一次并要求它重新输出固定格式；重试后仍不合法则 fail fast，不能静默当作 done。
- 如果 `PLAN_ONLY` 阶段 Agent 输出 `CLARIFICATION_BLOCKED`，Runtime 不直接问人、不替 Agent 填默认值，只把该输出回灌给 Orchestrator；Orchestrator 必须决定是否 `NEXT_AGENT: human`，以及问题和选项如何呈现。
- 如果 Agent 执行时抛出权限类错误，Runtime 不直接终止 self-play，而是记录 `PERMISSION_BLOCKED`，把 blocked action 和错误原因作为该 Agent 输出交回 Orchestrator。Orchestrator 必须询问人工后才能重试或改 scope。

## Logging
日志必须实时 print，并同步写入 `<workspace>/.maspl/runs/<run-id>/session.md`。

最终结果必须同步写入 `<workspace>/.maspl/runs/<run-id>/result.md`。

Agent session registry 必须同步写入 `<workspace>/.maspl/runs/<run-id>/agent-sessions.json`。

每个关键流转至少包含 bracket line：

```text
- [time]-[agent name]-[type]-[start run]
- [time]-[agent name]-[type]-[input preview]
- [time]-[agent name]-[type]-[running]
- [time]-[agent name]-[type]-[output preview]
- [time]-[agent name]-[type]-[end]
```

要求：
- `agent name` 必须明确显示 `Orchestrator Agent` / `Exec Agent` / `Review Agent` / `Judge Agent` / `Human`。
- input/output 短行使用真实消息预览；超过 100 字符时保留前 50 和后 50，中间标注 omitted 字符数。
- 完整 input/output 写入 `session.md`；长内容中间压缩。
- handoff 要清晰显示，例如 `Orchestrator Agent -> Exec Agent`。

## Test Plan
- 单元测试：四 Agent `agentroles.yaml` 解析、缺失 required agent 报错、session log 写入。
- Tool 测试：`ask_human(question)` 能记录 `Orchestrator Agent -> Human -> Orchestrator Agent`。
- Orchestration loop 测试：fake backend 覆盖 Orchestrator 动态选择 Exec、Review、Judge、Done 的流转。
- Backend adapter 测试：fake SDK 覆盖单 agent 执行、事件日志、错误冒泡、单次运行内每个 agent 的 session/thread 复用，以及不同 agent 共享 session/thread id 时 fail fast。
- CLI 测试：`init-roles` 生成合法四 Agent 配置；`run` 能创建 session log。
- 手工验收：运行 `print hello`，确认实时日志出现 Orchestrator、Exec、Review、Judge 四个 Agent，Judge 返回 SATISFIED 后 Orchestrator 输出最终结果。

## Assumptions
- MVP 先不接飞书、Telegram gateway，但 Orchestrator 的职责边界为后续 gateway 保留。
- MVP 不做长期记忆、test case 管理和超参搜索工具集成。
- Review 不负责裁决是否满足；Judge 是唯一裁决角色。
- Runtime 不重造 agent framework，不做业务判断，只做 SDK/thread/tool/log plumbing。
