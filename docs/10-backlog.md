# 开发任务清单与验收合同

[索引](README.md) · [路线图](09-roadmap.md) · [质量](11-quality-operations.md)

所有文件路径为未来拟建路径，当前没有应用代码。每项完成定义：实现、测试、迁移（如需）、运行手册、监控、评审均完成；“页面可点”不等于完成。

| 编号/阶段 | 具体任务及涉及文件 | 数据库变化 | 关键逻辑、测试和验收 | 潜在风险 |
|---|---|---|---|---|
| A01 P0 | `docs/adr/*`、原PRD映射、访谈记录 | 无 | 产品范围/市场/主体/数据地区有书面决策，原PRD差异可追踪 | 缺原文导致假设偏差 |
| A02 P1 | `package.json`、CI、环境模板、`src/lib/config.ts` | 建迁移流水线 | lint/typecheck/build/测试通过；密钥扫描；预览不接生产 | 环境串用 |
| A03 P1 | `src/lib/auth/*`、登录回调、`tests/security/auth.*` | profiles/preferences/consents | 过期/撤销会话拒绝；重置流程、OAuth state、CSRF测试 | 会话与缓存泄露 |
| A04 P1 | `src/modules/tasks/*`、任务UI、集成测试 | goals/milestones/tasks/dependencies/events | CRUD、树/DAG、完成/重开；所有变更有版本历史；同用户错误挂载拒绝 | 循环、重复计数 |
| A05 P1 | `supabase/migrations/*`、`tests/security/rls.*` | RLS/复合FK/写角色 | A/B用户+匿名+受限worker分别访问，REST/RPC/嵌套关系/直接SQL均测；越权0 | 管理角色绕过 |
| A06 P2 | `src/lib/time/*`、时间测试fixture | availability/plans | S06–S08、日期截止与23/25h日正确；无隐式本机时区 | DST/旅行 |
| A07 P2 | `planning/domain/scheduler.ts`、属性测试 | 无新表 | S01–S15；10000种子不变量；小规模枚举对比；性能目标达成 | 启发式漏解 |
| A08 P2 | `planning/application/commit-plan.ts` | revisions/items/blocks/outbox | 预览不写事实；两设备同版本仅一成功；事务中断无半计划 | 重叠与过期计划 |
| A09 P2 | `execution/*`、计时组件 | execution_events/sessions/segments | 暂停/恢复/关页/睡眠/重复请求/补记测试；每人一个活跃会话 | 把挂机当执行 |
| A10 P2 | `planning/recurrence/*` | series/exceptions | 幂等实例、跳过、改本次/未来、DST；重试无重复 | 无限展开 |
| A11 P2 | 今日、规划、执行、复盘页面 | daily_reviews | 手机用户3分钟内开始首项；不强制计时；完成率按原始承诺 | 引导负担 |
| A12 P3 | `coach/adapters/*`、`prompts/*`、评测集 | runs/messages/threads | 100案例；结构化≥99%；超时/模型失效规则降级；无秘密日志 | 注入/幻觉 |
| A13 P3 | `coach/application/approve.ts` | proposals/approvals/operations | hash/版本/到期/撤销校验；双击仅一次；篡改任一字段失败 | 审批重放 |
| A14 P3 | `billing/application/quota.ts` | usage_periods/ledger | 100并发抢最后10单位，最多10获准；崩溃恢复对账无负余额 | 超卖额度 |
| A15 P3 | `workers/*`、通知设置、dead-letter工具 | jobs/notifications/deliveries | 至少一次重复不产生重复业务；免打扰/跨设备频控/过时丢弃；积压告警 | 重复轰炸 |
| A16 P4 | `billing/*`、支付Webhook、订阅页 | subscriptions/payments/inbox | 沙盒购买/续费/失败/恢复/取消/退款/争议；重放乱序权益最终正确 | 双扣/误开权益 |
| A17 P4 | `privacy/export.ts`、`privacy/delete.ts` | data_requests/墓碑 | 导出完整且只含本人；删除停token/jobs，备份恢复重放删除 | 删除后复活 |
| A18 P4 | `ops/backup-restore.md`、恢复脚本 | 无业务变更 | 空库恢复后比对行数、约束、抽样及RLS；记录真实RPO/RTO | 备份不可用 |
| A19 P4 | 去敏分析埋点、Beta反馈流程 | daily_metrics（可延后） | 30人4周；指标定义冻结；原始用户正文不进第三方埋点 | 虚荣指标 |
| A20 P4 | 帮助/条款/隐私/客服、成本面板 | 保留期配置 | 权益与真实功能相符；取消能完成；模型实际账单每日核对 | 超预算/误宣传 |
| A21 P5 | `tests/e2e/*`、无障碍审核 | 无 | 关键路径桌面/手机/键盘/读屏；320px与200%缩放可用 | 拖拽不可访问 |
| A22 P5 | `tests/load/*`、连接池/索引 | 按EXPLAIN优化 | 100并发、每人1万任务样本；普通API p95<500ms；错误率<1% | 冷启动/连接耗尽 |
| A23 P5 | 安全测试/依赖审计/事故演练 | 必要最小权限修订 | 无高危未处置；XSS/CSRF/IDOR/限流/日志泄密测试通过 | 越权或供应链 |
| A24 P5 | 灰度/回滚/告警/runbook | 兼容迁移 | 演练关闭AI、回退应用、支付补偿；告警有人接；无P0/P1缺陷 | 无人运营 |

测试分层：领域单测不接模型；集成用真实临时PG与认证策略；E2E覆盖真实用户闭环，支付用沙盒；AI效果评测独立于确定性业务测试。冻结时钟、模型mock不替代真实RLS/事务/供应商契约测试。性能数据需记录机器、区域、样本和冷热条件。
