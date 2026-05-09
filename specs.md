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
1. 每个agent通过，agentroles.md控制，里面列出了所有的agent，每个agent 用一个prompt控制
2. 核心agent包括：
-- 调度 Agent：核心 Agent，涉及注册和调度 multi Agent，和 gateway交互（如飞书、telegram）
-- Exec Agent：接收目标，拆解 plan，执行 plan，需要分拆细步,最终给出产出
-- Review Agent：基于目标，Review plan、review code，验证exec结果，从各个角度提出质疑
-- Judge Agent：解决分歧，看哪些达成一致，哪些没有，没有达成一致的点需要暴露出来，由调度 Agent回传用户确定

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

