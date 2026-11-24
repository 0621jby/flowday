# 确定性智能排程设计

[索引](README.md) · [数据库](04-database.md) · [Coach](05-ai-coach.md)

## 输入、约束和输出

输入冻结为带版本快照：now、规划时区、可用区间、固定忙碌、锁定块、已开始任务、叶子任务、依赖 DAG、估计剩余时长、截止语义、习惯统计。默认规划当天，最多前瞻 14 天。输出为新计划候选、未安排列表、原因码、旧新差异、风险与 input_hash，不直接写数据库。

硬约束：时间不重叠；不早于 now/earliest；不越可用区间；不动固定/锁定/进行中；完成/取消/父任务不排；依赖先完成或先排完；不可拆任务必须连续容纳；硬截止不得违反。软约束：优先级、习惯匹配、少碎片、少移动、目标相关性、合理负荷。软截止允许延期但必须标注；硬截止不可行则报告失败，不伪造可行解。

所有区间 `[start,end)`，相邻端点不冲突。内部使用 UTC 整数毫秒，持续时长按真实 elapsed time。按当地时间产生可用区间再转 UTC，跨夜拆段、DST 使用明确 disambiguation。网格 5 分钟，开始向上取整，任务时长向上取整，空闲结束向下取整，绝不能四舍五入越界。单一未知时长需用户估算或以明确暂定值预览；暂定值不隐式确认。

容量：合并可用区间 → 减固定忙碌/锁定/过去 → 得 free minutes；缓冲作为实际占用计入每次放置，默认每连续 50 分钟留 10 分钟休息（用户可改）。计划负荷预算为剩余 free 的 0.8，**缓冲也占预算**，避免重复减两遍。已锁定块不乘系数，也不能被负荷降低移除。

## 排序与放置

先用可用工作分钟计算依赖最长路径耗时与 slack。硬截止可行性不能只看当前任务，必须包含未完成前置链；负 slack 标记风险。就绪集仅包含无未安排前置任务的任务。硬截止链优先按最小 slack；其余候选按分数：

`score = 30P + 25U + 15G + 10A + 10H + 10B - 15F - 20M`

P=priority/3；U=clamp(1-slack/480,0,1)，无截止为 0；G=用户指定目标重要性 0–1；A=min(等待可用工作日/10,1) 防饥饿；H=该时段历史匹配 0–1，冷启动 0.5；B=可解锁下游任务比例；F=候选碎片惩罚 0–1；M=既有块移动惩罚 0–1。系数是初始启发式，须通过回放和用户实验调整，不声称数学最优。

先放依赖链必要任务和硬截止任务，再评估软任务的候选 slot；同分按更早截止、创建时间、UUID 排序，保证可复现。对硬截止链做有界回溯/小集合枚举，找不到可行计划要区分 `proven_capacity_shortage` 与 `heuristic_no_solution`，不能把启发式失败当作无解证明。候选时间段过多时限 500 任务/14 天，超限返回可解释降级到当天。

```text
preview(snapshot):
  validateOwnershipAndVersions(snapshot)
  rejectDependencyCycles()
  windows = toUTCIntervals(snapshot.availability, timezone, dstPolicy)
  free = subtract(merge(windows), union(fixed, locked, inProgress, past))
  budget = floor(totalMinutes(free) * loadFactor)
  candidates = incompleteLeafTasksWithinHorizon()
  markCriticalDependencyChains(candidates)
  while readyTasks exist:
    task = nextByHardDeadlineThenScore(readyTasks)
    duration = calibratedRemaining(task)  # 估计，不从计时直接扣减
    placements = feasibleSlots(task, free, predecessorsFinish)
    chosen = leastCostPlacement(placements, duration, splitRules, budget)
    if none:
      tryBoundedRepair(task, movableBlocks, maxStates=200)
    if still none:
      emitUnscheduled(task, reason)
      markDependentsBlockedByUnscheduledPredecessor()
    else:
      reserve(chosen, buffer); decreaseBudget(); releaseReadySuccessors()
  assertAllHardInvariants()
  return {blocks, unscheduled, risks, diff, inputHash, algorithmVersion}

commit(proposal, expectedPlanVersion):
  begin transaction; lock user planning row
  recheck task/plan versions, current time and calendar snapshot freshness
  revalidate full resulting plan; reject stale preview
  defer block exclusion constraint; cancel replaced future blocks
  insert new blocks and immutable plan revision; increment plan version
  append audit + outbox; commit
```

复杂度：排序 O(n log n)，朴素放置 O(n·s)，s 为有界候选区间数；局部修复有严格状态上限。服务预算目标 100 任务/7 天 p95 <500ms，在声明基准硬件上测量，不含模型请求。服务端超时返回未提交，不应用半份计划。

## 五个必需场景

1. **6 个任务，4 小时**：假设 A90/B60/C45/D30/E30/F20，共 275 分钟，预算 192 分钟。按约束优先可选 A90+B60+D30=180，另留 10 分钟缓冲，共190；其余 85 分钟进入未安排清单。若 C 硬截止更近，则替换任务组合；不能只按最短任务凑完成率。显示“今天容量不足”，让用户选延期、缩小范围、增加真实可用时间。
2. **上午未开始**：先询问是否已在线下做了；已过时间不可补排到过去。保护现在进行中/未来 30 分钟冻结块，对剩余任务做局部重排预览，不自动把任务标记失败或剩余耗时减少。
3. **临时高优先任务**：先用预留容量，后移动低分且未锁定任务；列出被延期项目和截止风险。冲突涉及进行中任务时需用户主动暂停。优先级高也不能占用固定会议。
4. **连续两小时，仅剩一小时**：不可拆则今日不安排，找下一合法连续两小时窗口；截止前不存在就提示不可行。只在用户同意改变任务定义后拆成两个可独立完成的步骤。
5. **连续未完成**：最近至少 5 个有有效记录的日子、且可比任务 ≥10 时，计算已完成承诺工作量/原始承诺工作量（不是改后分母）。连续 3 个有效日 <60%，建议次日 loadFactor 下调 0.1，最低 0.5；连续 5 日 >85% 且用户接受才上调 0.05，最高0.85。每天最多调一次；无记录不判低能力；用户可拒绝或修改可用时间。

## 边界与自动化测试规格

| 编号 | 输入 | 预期 |
|---|---|---|
| S01 | 两块 09:00–10:00/10:00–11:00 | 相邻合法，09:59 开始则冲突 |
| S02 | 6 任务/240 分钟示例 | 不超192预算，剩余原因与总量准确 |
| S03 | A→B→C，A 未安排 | B/C 不越过依赖；环 A→B→A 拒绝 |
| S04 | 不可拆120，空闲60 | 不生成60分钟伪完成块 |
| S05 | 可拆120，两段60，最小块30 | 可安排两段，完成标记仍由执行决定 |
| S06 | 纽约 2027-03-14 当地02:30重复事项 | 按策略移到有效时间，日长23h |
| S07 | 纽约 2027-11-07 当地01:30 | 默认较早 offset，只生成一个实例，日长25h |
| S08 | 上海跨午夜/旅行改时区 | 历史日期冻结，未来重新确认 |
| S09 | 两设备同时提交同版本 | 仅一个成功，另一个409；无重叠 |
| S10 | 紧急任务与锁定块冲突 | 锁定块不动，返回未安排/风险 |
| S11 | 零可用时间/未知时长/超长任务 | 不死循环，不擅自分配，明确原因 |
| S12 | 重复生成重试/本次跳过 | 实例唯一，跳过不再生成 |
| S13 | 耗时超出/补记/完成后重开 | 不自动完成、不双计执行时长 |
| S14 | 原计划之后删除低优先任务 | 原承诺分母不被改小 |
| S15 | 固定事件本身重叠 | 合并占用，展示源冲突，不重复扣时 |

属性测试随机生成至少 10,000 组有种子输入：输出始终满足约束、总占用不超过容量、同输入结果一致、锁定块不变；故障重放保留种子。小规模 ≤8 任务用枚举最优解对比可行性与得分差，量化启发式缺陷。以上是待实现测试规格，当前未运行。
