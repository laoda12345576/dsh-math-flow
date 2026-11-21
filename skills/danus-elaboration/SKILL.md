---
name: danus-elaboration
description: 把一个 Danus 项目的共享状态（全局记忆 + 事实图）写成一份高信噪比的数学综合，五节固定模板，然后交给战略 consult，把回复记成 master_guidance。每个战略周期、consult 之前用；worker 交了一轮、有真发现/死路/新事实、或者卡住了，就该跑一次。
---

# Elaboration → consult → master_guidance

一个战略周期由两半组成：**你写综合**（elaboration），**强模型给方向**（consult）。
前者是输入，后者是回复，永远不要把两者混为一谈。

上游权威文本：Danus 仓库 `.claude/skills/elaboration/SKILL.md` 与 `consult/SKILL.md`。

## 输入只读共享存储

- **全局记忆**：`danus_gm_search`（`project=<p>`），或直接读
  `<project>/global_memory/<kind>.jsonl`。看发现、死路、最近的 `verification`
  轨迹、当前的 `master_guidance`。
- **事实图**：`danus_fact_search`，或读 `<project>/fact_graph/facts/*.md`。
- **问题陈述**：固定的目标（以及子任务分解，如果有）。

**绝不读 worker 的本地记忆。** 那是层边界，也是"综合"比"抓日志"干净的原因。

## 目标不可改

引用目标原文，**不弱化、不重定义、不缩到特例、不换成更简单的替代**。如果证据表明
目标可能是假的、或当前路线够不到，**在保持目标不动的前提下直说**。

## 模板：五节，顺序固定

小节为空时写它的空状态行，**绝不删标题**。

### §0 数学裁决

开头**一行加粗裁决**，然后是状态仪表板表、子任务状态表、当前最佳证明骨架、
中心缺失引理。

### §1 已闭合的部分与废弃路线

- **已签署闭合的组件**：项目符号列表（"<数学内容> — `fact_id` …"），或
  `_(no signed-closed components yet)_`
- **失败/废弃路线**：表格（Route | FALSE AS STATED / OBSOLETE | 一行的理由，引 `fact_id`），
  或 `_(no failed or obsolete routes recorded; absence here does not mean the strategy is unique)_`

### §2 接口契约表（最重要的一张）

人读这份综合，就是为了找"哪个输入/输出假设在实际对象上没被验证"。证明架构里
**每个**接口都要一行，用问题里原有的子任务名：

> ### <接口名> — <它在证明里的一句作用>
> **需要的输入。** <第 i+1 步对第 i 步输出的精确数学要求：正规性、Q-factorial、K 是否 Q-Cartier、维数……不是"相容">
> **声称的输出。** <现有条件包在它自己的假设下保证了什么>
> **可用事实。** `fact_id` — 一行陈述；…
> **在实际对象上缺失的验证。** <编号列出：还没在实际构造上做的假设匹配>
> **忽略会怎样。** <一两句：下游具体哪里断——"若 K_W+B_W 非 Q-Cartier，'由负性引理'是空的">
> **状态。** <七个标签之一>

**CLOSED 的严格规则**：只要"缺失的验证"非空，状态最多 SUBSTANTIAL。平凡匹配也要写
一行并标注，让冷读者知道你想过。

### §3 危险启发式与不要走的路线

- **危险启发式**：3–8 条策略大纲或旧笔记里的**原话（或极近的转述）**，保留措辞以便
  定位。每条给状态（"不是自动的" / "按陈述在数学上错误" / "只是条件性的" /
  "方法论捷径，不是证明步骤" / "与更强命题混为一谈"）和 2–4 句说明为什么不成立，
  引 `fact_id`。
- **不要走的路线**：4–8 条具体反路线，"不要 <具体动作>：<一行理由>"。禁止"避免薄弱"这类空话。

### §4 缺失的桥接引理

2–4 条，按**杠杆**排序（Bridge 1 解锁最多下游）。每条：

> ### Bridge k — <短名>
> **目标陈述。** <完整精确的数学陈述>
> **前提。** <输入要满足什么才能类型检查>
> **可用事实。** `fact_id` — 一行；…（只写真实存在的 id）
> **缺失的检查。** <编号>
> **闭合判据。** <一段：哪个证明义务一解决，这条桥就通了>

并标明它是**独立**（可并行）还是**依赖**——这决定你能不能把不同 worker 派到不同桥上。

## 七个状态标签（只准用这七个，全大写）

**CLOSED · SUBSTANTIAL · PARTIAL · DANGEROUS · FALSE AS STATED · OBSOLETE · UNKNOWN**

## 纪律（硬规则）

- **猜想材料不是已核验**——没有 `fact_id` 的断言只是"知晓"，不是"真"。
- **不写数值化距离**。不许"大约还差 8–12 个 fact"、"再跑 2–4 次"、"完成 80%"。
  距离只能是定性的。
- **不写过程遥测**。不写 worker 数、服务状态、mtime、调度。这是纯数学文档。
- **不给智能体下指令**。综合不是派活单；把综合变成指令是 consult 的事（→ `master_guidance`），
  派活是你之后的事。
- **诚实，不是安慰**。暴露隐藏假设、可能为假的陈述、状态标签可能误导的地方。
  不要把 SUBSTANTIAL 四舍五入成"快好了"。

## 输出

用 `danus_gm_add` 发布：

- `kind`: `elaboration`
- `claim`: §0 的裁决行
- `evidence`: 完整五节 markdown
- `links`: `{"fact_ids": [...]}`——只写真实存在的 id
- `verifiable` 留空（这类是综合/判断，不是可判真假的陈述）

## 然后 consult

把这份 elaboration 喂给强模型（Danus 的 consult 机制：`gpt_pro` / `claude_api` /
`claude_code` / `off`，在 `config/*.env` 里配）。拿到的回复**就是**
`master_guidance`——用 `danus_gm_add kind=master_guidance` 记下来，然后据此
`danus_assign` 派活。

**不要在这个 skill 里 consult 或派活**，也不要在没有新状态时 consult：
没变化的轮次只会烧钱，并且会把上一次的方向重写一遍。
