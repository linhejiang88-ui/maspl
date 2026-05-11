# Multi-Agent Self-Play Loop 的AI Native工作流工具
## 面向优化任务需求场景
1. 我们在写代码时，需要在 Claude code 里面写代码，在 Codex 里面 Review，然后不断的交互使用，直到满意验收
2. 我们在编写 prompt 迭代应用时流程：分析文档 -> 编写 Prompt -> TestCase -> 优化 Prompt -> TestCase 重复，直到达到要求
3. 算法工程训练点击率模型：寻找最优超参、最优特征处理方式；预设方案 -> 跑模型 -> 评估 AUC/F1 ，重复搜索
中间虽然可能用了 AI Coding，但是串联、评估都是人工来做，不是 Agent 自发驱动的。需要有个简易的Multi-Agent Self-Play Loop工具，把执行 、评估、判断、和人工交互，都交给 Agent 驱动，人只负责审核和验收，做的更加彻底，实现自我优化。

## 原则
1. Agent 为核心：从一开始就把AI 作为核心决策与执行层来设计的流程，而非在传统流程上外挂 AI 工具；它以智能体（Agent）为核心，具备主动感知、动态决策、自动执行、持续学习的能力。
2. 极简的 Agent 管理框架：最好直接用 cli 的模式接入 codex 和 cc 的 Agent，以及飞书等通信工具，避免框架涉及到重复实现 bot，coding agent 这些能力
3. Human-in-the-Loop：AI 自动干活，但关键节点必须人来确认、审批、纠错；AI 负责执行、辅助、推荐，人掌握最终决策权。


## 核心依赖
1. 只依赖本地命令行command line，通过 https://github.com/openai/codex/tree/main/sdk 实现，复用本地的环境；
2. codex，claude code都这样；

## agent
1. 每个 agent 通过 `agentroles.yaml` 控制，里面列出所有 agent，每个 agent 用 prompt、权限、工具范围控制。
2. 核心agent包括：
-- 调度 Agent（Orchestrator Agent）：核心调度 Agent，涉及注册和调度 multi Agent，和 gateway 交互（如飞书、telegram）。调度 Agent 不做具体实现操作，不编辑文件，不执行项目命令，只负责分发任务、接收各 Agent 输出、根据 Judge 指令推进下一步或回传用户。
-- Exec Agent：接收调度 Agent 分配的目标，拆解 plan，执行 plan，需要分拆细步，允许进行具体实现操作，最终给出产出、变更说明、验证结果和剩余风险。
-- Review Agent：基于目标，Review Exec Agent 的 plan、code、验证过程和结果，从正确性、测试覆盖、回归风险、假设和可维护性等角度提出质疑。Review Agent 不判断最终是否满足，只输出问题和风险。
-- Judge Agent：基于用户目标、Exec Agent 输出、Review Agent 反馈，判断结果是否满足。Judge Agent 输出 `SATISFIED` / `NOT_SATISFIED` / `NEED_HUMAN`，并把指令返回给调度 Agent。没有达成一致或需要人判断的点，由调度 Agent 回传用户确定。

## agent 协作逻辑
1. 用户目标进入调度 Agent。
2. 调度 Agent 接收用户目标和所有已有 Agent 输出，决定下一步：
   - 由哪个 Agent 执行：Exec / Review / Judge / Human / Done。
   - 执行什么具体任务。
3. Runtime 只执行调度 Agent 的调度指令，不做业务顺序判断。
4. 被调度 Agent 执行任务后，将输出返回调度 Agent。
5. 调度 Agent 基于所有输出继续决定下一步。常见路径是 Exec -> Review -> Judge，但不是 Runtime 写死的固定流程。
6. Judge Agent 判断：
   - `SATISFIED`：目标已满足，调度 Agent 汇总最终结果给用户。
   - `NOT_SATISFIED`：目标未满足，调度 Agent 将 Judge 指令重新发给 Exec Agent 继续执行。
   - `NEED_HUMAN`：需要人判断，调度 Agent 通过 Human-in-the-Loop 向用户确认，再继续调度。
7. “是否满足”只能由 Judge Agent 判断，不由 Review Agent 判断。Review 负责质疑，Judge 负责裁决，调度 Agent 负责根据 Judge 指令决定下一步。
8. 当调度 Agent 判断完成时，最终结果必须说明：
   - 产出了什么；
   - 产出位于具体项目 workspace 的哪个路径；
   - 用户如何使用或验证该产出。

调度 Agent 的最小调度输出协议：

```text
NEXT_AGENT: exec | review | judge | human | done
TASK:
<给该 agent 的具体任务，或最终返回给用户的结果>
```

调度 Agent 输出不符合协议时，Runtime 只能要求调度 Agent 重试输出固定格式；重试后仍不合法必须失败，不能默认当作 done。

## 运行与产出约束
1. 执行命令必须输入 `task_name` 作为唯一任务区分。默认 workspace root 为 `~/.maspl/project`，实际项目目录必须是 `~/.maspl/project/<task_name>/`。
2. 如果命令允许传入 workspace root，则实际项目目录必须是 `<workspace-root>/<task_name>/`；`task_name` 只能是单个路径段，不能包含 `/` 或 `\`。
3. Backend 只负责执行某个 Agent 的一次任务，不负责整体协作逻辑。Claude 和 Codex 都是对齐的 backend，不能影响 Orchestrator -> selected Agent -> Orchestrator 的 loop 语义。
4. 每次运行必须在目标项目目录下创建：
   - `<workspace>/.maspl/runs/<run-id>/session.md`：完整 session log；
   - `<workspace>/.maspl/runs/<run-id>/agent-sessions.json`：本次运行内每个 Agent 的 session registry；
   - `<workspace>/.maspl/runs/<run-id>/result.md`：最终交付物，包含产出说明、产出位置、使用/验证方式。
5. 单次运行内，每个 Agent 必须保持自己的 backend session：
   - Orchestrator Agent 有自己的 session；
   - Exec Agent 有自己的 session；
   - Review Agent 有自己的 session；
   - Judge Agent 有自己的 session。
6. 同一个 Agent 在一次运行的多次调用中必须复用自己的 session，不能每次 new 一个 session id。Agent 返回的 session/thread id 必须注册到内存和 `agent-sessions.json`；如果该 Agent 没有返回 session/thread id，Runtime 必须为该 Agent 生成一个 session id 并序列化。不同 Agent 之间不能共用 session id；如果不同 Agent 返回同一个 backend session/thread id，Runtime 必须 fail fast。不同 `maspl run` 之间不要求复用 session。
7. Runtime 可以负责 CLI、日志、timeout、backend factory、`ask_human` 等 plumbing，但不能写死业务顺序，也不能替代 Orchestrator/Judge 做业务判断。
8. `runtime.allowedTools` 是 Agent 工具权限的全局硬 allowlist；role tools 只有出现在 `runtime.allowedTools` 中才会传给 backend。Human-in-the-Loop 通过 `NEXT_AGENT: human` 协议进入 Runtime，不依赖 backend MCP tool 注册。

## gatewary
1. 飞书
2. telegram

## tools
1. 不需要，核心利用本地codex，claude code的能力


## Workspace-[project]
1. Session
2. Test case
3. Judge result
4. Human feedback
5. result
