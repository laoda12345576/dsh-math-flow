# dsh-plugin-research-gate

把研究的**顺序**做成工具层面的硬约束，而不是提示词里的劝告。

```
survey ──→ synthesis ──→ verify
只读文献     只写判据      才允许取证（且须委派）
```

## 为什么需要它

实测出来的问题：给模型一个开放问题（"单位正方形内是否存在点到四顶点距离都有理"），
它读了 0 篇文献、调用了 0 次论文工具，花 5 分钟设计数值搜索算法，准备跑 `c ≤ 10^5`。

对高度无界的问题，小范围搜索的信息量接近于零：搜不到不说明任何事，搜到了靠的是运气。
真正的信息在"为什么这里应该没有解"里，而那只能从前人的方法结构读出来。

提示词劝不住这件事——把"先读文献"写进任务，它照样跳过。所以改成：
**证据级计算在前两个阶段物理上不可用**。

## 计算分三级，按规模而不按学科

v0.1 把所有计算一律拦在前两阶段。这修好了一个病，犯下了另一个：模型在 survey 阶段
想核对文献里的一个数（`1+1` 这种），也会被拦，于是它要么编 400 字废话骗开锁，
要么放弃验算。**这是在惩罚理解行为。**

v0.2 起按规模分级，v0.3 拆出探索级：

| 级别 | 判定信号 | 谁执行 | 何时 |
|---|---|---|---|
| `scratch` 草稿级 | 无循环、无上界、无枚举语义的单次求值 | 主智能体自己 | **任何阶段**；输出须标 `[scratch]`，不能当论据 |
| `evidence` 证据级 | `for + range(...)`、C 风格 `for(;;)`、`range` 里的 `**` 上界（<10⁵）、搜索/枚举语义、`itertools.product/permutations/combinations`、显式 `N_MAX/bound` | **子智能体** | `verify` 之后 |
| `explore` 探索级 | `while(true)`、上界 ≥10⁵、蒙特卡洛、`grid search`/参数空间探索 | **子智能体**（任务书须带预算与停止条件） | `verify` 之后 |

再加一条**频次规则**：同一个问题里草稿级算满 `scratchLimit`（默认 8）次后，
后续调用一律升格为证据级。反复小算累积起来就是一次扫描。

## 为什么批量计算必须外包

因为它的**产物和过程不匹配**：一次扫描的产物是"结论 + 脚本"，过程却是几万行中间输出。
主智能体亲自跑，等于用上下文换它根本不需要的东西；而上下文一旦被日志填满，
它后面就没法思考了。

所以 v0.3 起 `evidence` / `explore` 在 `verify` 之后仍然不由主智能体执行，一律派出去。
门禁检查子会话标识（`origin` / `parentSession` / `delegationDepth`）：子智能体里放行，
主智能体里拦截并给出任务书模板（判据 / 算法与规模 / 反证条件 / 交付物）。

**v0.4 起改为组队（`agent_teams_create`），并按角色做工具硬隔离。** 单纯"派一个子智能体"
不够——同一个 agent 既能查文献又能算，它就会在两者之间摇摆，而摆动的方向总是偏向"能立刻
出数字"的那边（这正是本文开头那个病的成因）。所以分三个角色，工具在子会话的 schema 里
根本不存在，无从违背：

| 角色 | `tool_policy` | 拿不到 | 派它干什么 |
|---|---|---|---|
| 文献官 | `surveyor` | `viz_python` / `viz_matlab` / `browser` | 查前人做到哪、卡在哪 |
| 计算官 | `computer` | `paper_*` / `cnki` / `zotero_search` / `zotero_browse` | 实现判据、跑、回报数字 |
| 复核官 | `adversary` | `paper_search` / `cnki` / `wps_write` | 独立审结论，专门找反例 |

策略声明在 profile 的 `cordis.patch.yml` 里（见"角色工具策略"一节），门禁只负责在拒绝时
把这三个 id 报给模型。

**任务书本身也过分级器。** 否则主智能体可以把一次大扫描包装成"给成员的调研任务"，
绕过前面全部约束。判据没写出来之前派批量计算，一样被拦。

还有一条是实测换来的：**任务书里计算工具要写死，不能给选项**。曾经写过
"用 `viz_python` 或 `browser` 的 eval"，成员挑了 `browser`，而那个环境浏览器没开，
它查了一次状态就放弃了，一个数字都没算出来。

## 没有委派工具时降级，不卡死

实测发现：某些 profile（比如当前这个 headless 用的）工具表里**既没有 `subagent` 也没有 shell**，
只有 `viz_python` 这类计算通道。真机日志里模型自己说 `"subagent" isn't in my tool list`。

这时如果仍然强制委派，evidence 计算就永远做不成——门禁从"约束"变成"死锁"。
所以门禁会先探测 `tools.view(agent).visible` 里有没有可用委派工具：

| 情况 | 行为 |
|---|---|
| 有 `subagent` / `subagent_fork` / `task` / `agent_teams_create` | 拦截主智能体的批量计算，要求派出去 |
| 都没有 | 放行，但计入 `directRuns` 并在状态里显示"降级直跑 N"，同时提示模型主动限制输出体积 |

**宁可放宽，不可卡死。** 降级是可见的、可统计的，不是悄悄失效。

默认已认 `subagent` / `subagent_fork` / `task` / `agent_teams_create`。别的通道用配置加：

```yaml
config:
  delegationTools: ['^my_delegate$']   # 正则列表，追加到默认之上
```

真机里还观察到一件事值得记下来：门禁拦下 `viz_python` 之后，模型**主动**想过三条绕道——
`browser eval`、不写显式循环的 numpy 向量化、把任务包装成"调研"——然后自己否掉了：
*"That would be circumventing the gate. Better to comply."* / *"That's gaming."*
它最后选择了去读文献、写 prior_art、推进阶段。**这正是这个插件想要的效果：不是禁止它思考，
是让它绕不过去，只能往正路上走。**

## verify 是一张票据，不是一次买断

v0.1 一旦推进到 verify，全会话的计算永久解锁。于是第 2、3、4 个子问题都能零文献工作
直接开算——**原来的病只是被推迟，没被治**。

v0.2 起 `verify` 绑定一个问题（ticket）。换子问题要
`research_stage(action=open, question=...)`，回到 `survey`，不继承上一张票的 `prior_art`。

同时允许**回退**：verify 里读到新证据发现判据站不住，可以退回 survey。
回退会清空 `prior_art` 与 `plan`——否则"退回去再立刻推回来"就是零成本洗白。

## 两层机制

| 层 | 文件 | 作用 | 能不能被忽略 |
|---|---|---|---|
| 架构层 | `lib/index.js` + `lib/gate.js` | `tools.guard` 拦截证据级调用，返回带解锁条件的拒绝理由 | 不能 |
| 协议层 | `~/.dsh/skills/research-protocol/SKILL.md` | 讲清楚每个阶段该产出什么、什么算读懂了、怎么标注来源 | 能被忽略 |

架构层保证顺序，协议层保证质量。缺了架构层，skill 是建议；缺了 skill，门禁只是让人排队。

## 阶段与解锁条件

| 阶段 | 允许 | 拦截 | 进入下一阶段的条件 |
|---|---|---|---|
| `survey` | 论文检索/抓取/阅读、web 检索、草稿级计算 | 证据级计算 | 文献类工具调用 ≥3 次 **且** 提交 ≥400 字 prior_art |
| `synthesis` | 推理、写作、草稿级计算、`research_stage` | 证据级计算 | 提交 ≥300 字 plan（判据 + 来源 + 推翻条件） |
| `verify` | 草稿级计算、委派子智能体、推理写作 | 主智能体亲自跑 evidence/explore | — |

`prior_art` 必须写清：谁做过、把问题化成了什么代数对象、用什么降维手段、卡在哪一步。
只写"某某研究过"不算——这是摘要，不是理解。

## 拦截不是按名字，还看参数

实测撞出来的一个洞：门禁拦住 `viz_python` 后，模型改用 `browser` 的 `eval` 在浏览器里跑 JS，
把 `1+1` 算了出来。工具名字是调研工具，干的事是计算。

`classify()` 之后还有 `inspectSurveyCall()`：browser 类调用只要参数里带
`cmd: eval|js|execute`、或 `code/script/javascript` 字段，就被送进分级器——
里面是 `print(1+1)` 就放行，是 `for (let c=0; c<1e5; c++)` 就拦。

## 配置

```yaml
- insert:
    - id: research-gate
      name: 'dsh-plugin-research-gate'
      config:
        enabled: true
        minReads: 3
        minPriorArtChars: 400
        minPlanChars: 300
        minQuestionChars: 8
        scratchLimit: 8      # 单问题内草稿级计算的预算
        evidenceExtra: []    # 追加的证据级识别正则（字符串）
        exploreExtra: []     # 追加的探索级识别正则（字符串）
        allowExtra: []       # 误判为计算类的工具名放这里
        denyExtra: []        # 名字像调研、实际在算的工具名放这里
        injectPrompt: true
```

## 角色工具策略（配套 profile 配置）

门禁只负责"不许主智能体自己跑"，**角色隔离要靠 profile 侧的 `toolPolicies`**。
策略写错一个工具名会让成员启动失败（插件的 owner deny 不做宽松回退），所以工具名要
从实际注册表里取，不要凭印象写。本 profile 的做法见
`~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: agent-teams
  config:
    toolPolicies:
      surveyor:
        deny: [viz_python, viz_matlab, browser]
      computer:
        deny: [paper_search, paper_fetch, paper_resolve, paper_verify,
               paper_channels, cnki, zotero_search, zotero_browse]
      adversary:
        deny: [paper_search, cnki, wps_write]
```

建队时成员在计划里带 `tool_policy: computer` 之类的 id 即可。实测证据：成员会话的
`subagent/descriptor` 里 `toolFilter.deny` 确实带上了上面这张表，成员也真的只调到了
`viz_python`。

## 测试

```bash
node test/smoke.mjs   # 86 项，覆盖三级分档、阶段机、回退、票据制、角色委派文案、子智能体判定、参数级拦截
```

## 已知边界

- 状态按会话存在内存里，dsh 重启即归零——这是有意的，门禁管的是单次研究流程。
- 分级器看的是代码文本特征，不是语义。它会对 `for x in range(3)` 这种无害小循环
  误判为证据级（保守方向），也会被刻意改写的等价代码绕过。它是**提高作弊成本**，不是不可绕过。
- 它拦不住"在纸上想清楚"这件事做不到的模型：可以编一段 prior_art 过关。
  但编造的成本高于阅读，而且 skill 会要求标注 `[文献已知]` 的出处，编的在交付时会被抓住。
- `verify` 阶段不限制算多大的范围，但 skill 要求报告里写清"这个界相对文献已有的搜索处于什么位置"。
