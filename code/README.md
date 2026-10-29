# 代码节选

这里收录 A / B 两条线的 **19 个核心模块（2,035 行）**，按原仓库目录结构存放，方便对照阅读。

> 只是节选，不是可运行工程。缺少共享模块、配置与数据，直接运行会失败——这是有意的。见下方"为什么跑不起来"。

## 收录范围

### A 线 · 智能体与前台对话

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `server/intent-recognizer/context.mjs` | 152 | 组装路由输入：本轮脱敏消息 + 精简 `router_state`，不传全量历史 |
| `server/intent-recognizer/prompt.mjs` | 20 | 路由系统提示词，约束模型只分类不回答 |
| `server/intent-recognizer/schema.mjs` | 69 | 输出契约与拒绝原因，含"预约必须有原文证据"等硬规则 |
| `server/intent-recognizer/recognize.mjs` | 125 | 模型提议 → 程序校验 → 澄清判断的完整入口 |
| `server/intent-recognizer/reconcile.mjs` | 93 | 模型结果与规则结果对账，防止把明确提问降级成追问 |
| `server/intent-recognizer/clarify.mjs` | 41 | 缺槽位时"只问一个问题"的映射表 |
| `server/intent-recognizer/compose.mjs` | 11 | 把校验后的候选组装成识别结果 |
| `server/intent-recognizer/action-capability.mjs` | 10 | 子任务的可执行能力声明 |
| `server/acquisition-turn-plan.mjs` | 143 | 回合规划：只有本轮原文证据能改槽位 |
| `server/chat-stream.mjs` | 80 | 分段流式协议：段落事件 + 完整回执 |
| `server/orchestration/answer-policy.mjs` | 35 | 回答载荷构造与稳定的助手消息标识 |
| `server/orchestration/intent-policy.mjs` | 63 | 哪些意图可以独立作答，哪些必须转人工 |
| `server/orchestration/handover-policy.mjs` | 105 | 接管状态判定与交接单窗口 |
| `server/orchestration/audit-events.mjs` | 71 | 审计事件结构 |
| `server/chat-contact-capture.mjs` | 59 | 联系方式的确定性识别，不经过模型 |
| `apps/acquisition-advisor/src/chat-stream-client.mjs` | 98 | 前台流式客户端：分段渲染、失败重试 |

### B 线 · 客户与人工接待

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `server/contact-vault.mjs` | 148 | 联系方式加密存储、一次性查看与审计 |
| `server/acquisition-operations-store.mjs` | 543 | 运营态存储：队列、快照、分页与窗口合并 |
| `server/local-conversation-store.mjs` | 169 | 本地会话存储，与前台轮询同源 |

## 脱敏处理

对外发布前做了以下替换，**逻辑没有改动**：

| 原文 | 替换为 |
| --- | --- |
| 机构名称 | 某机构 |
| 医生姓名 | 张院长 |
| 具体项目名 | 某项目 / 某项目方向 |
| 环境变量前缀 `HUAMEI_` | `DEMO_` |
| 数据 schema 前缀 `huamei.` | `presales.` |
| 本地库文件名 | `demo-local.sqlite` |

## 为什么跑不起来

这份节选刻意**没有**包含：

- `server/acquisition-intent.mjs`：项目与医生的本体、别名表和匹配规则——这是业务资产的核心；
- `server/platform/*`、`server/persistence/*`：租户、鉴权、加密、数据库访问；
- `graphrag-service/`、`agent-orchestrator/`：知识检索与编排服务；
- `package.json`、环境配置、知识包、任何数据。

所以它只能读，不能跑，也不能照着直接拼出一个同类产品。

## 使用限制

本目录代码仅用于作品展示与面试评审，著作权归作者所有。

未经书面许可，不得复制、二次分发，或用于任何商业产品与同类服务。

The code in this directory is provided for portfolio and interview review only. All rights reserved. Redistribution or commercial use is not permitted.

## 对应文档

- 意图识别与任务推进 → [../docs/02-intent-routing.md](../docs/02-intent-routing.md)
- 证据约束与回答策略 → [../docs/03-grounded-answer.md](../docs/03-grounded-answer.md)
- 流式回答与人工接管 → [../docs/04-handover-loop.md](../docs/04-handover-loop.md)
