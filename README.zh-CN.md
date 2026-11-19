# dsh-math-flow

**一条做数学研究的 agent 工作流。核心不是插件数量，是那份协议：先把前人的天花板摸清楚，把障碍化成一条可判真假的判据，然后才允许开算。**

大多数「agent 栈」仓库发的是一张插件列表的截图。这里发的是：一份 730 行的研究协议（[`skills/research-protocol/`](skills/research-protocol/SKILL.md)）、五个负责拒绝的插件、八个对账脚本、一套测量协议。插件是可以换的零件，协议不是——它是十几轮实验里每次翻车之后剩下的东西。

[English](README.md) · 依靠 DeepSeek Harness（`dsh`）、Lean 4 和 Mathlib。

---

## 它要解决的问题

用 agent 做长时间的数学，会以三种固定方式坏掉，而且全程不报错：

| 坏法 | 长什么样 | 实测 |
|---|---|---|
| **约束衰减** | 一个符号第 5 轮定义，第 40 轮开始漂移，第 60 轮在证关于另一个对象的定理 | 第 3 轮时，议程上只剩「`m` 取到哪」 |
| **立刻开算** | 十分钟能跑出一个数字，读文献十分钟什么都产不出——于是所有人都在算 | 「搜到 10⁵ 没有解」被当成进展交上去 |
| **自证** | 提出断言的人，顺手宣布它成立 | 一句 `theorem trivial_thing : 1 = 1`，`assertion` 写着完全无关的定理，判 P、零公理、全部检查通过 |

三条病对应三条规矩，每条规矩都有人负责执行：

| 规矩 | 谁执行 |
|---|---|
| 凡是能机械判定的，做成函数，不做成 agent | `claim-verify`（`verify_claim`）· `lean-math`（`lean_audit`） |
| 提出断言的人，不能签发断言 | `research-gate` 的三角色工具白名单：`draft` 够不到 `lean_audit` |
| 一份描述有权威性，其余从它生成 | `claim-verify` 用 hash 冻结断言原文；改一个字就是另一条判据 |

## 协议：三步，顺序不可换

```
survey ──→ synthesis ──→ verify
只读文献      只写判据       才开算
```

每一步都必须留下能被下一轮接手的东西，不是一段总结：

| 步骤 | 必须留下 | 缺了会怎样 |
|---|---|---|
| **survey** | 四个问题的答案：谁做过（具体到篇）· 化成了什么（几何/数论问题变成了哪个代数对象）· 用了什么手段 · **卡在哪一步** | 门禁不让你进下一步 |
| | 至少两条**原文引文**，来自不同文献，格式 `[refs/x.txt]「文中的一句话」` | 引文要在文件里子串命中；改写、拼接、翻译都不算 |
| **synthesis** | 一条判据，能直接读成 `judge` + `predicate` + `value`；外加「什么样的结果会推翻它」 | 写不成表的判据是愿望，派不出去 |
| **verify** | 跑之前先写 `prediction` 与 `confidence`；跑完每条断言带 `claim_hash` | 全程 surprise≈0 说明这轮只在公证已知的东西 |

配套的四条也都在协议里：计算分三级（草稿 / 证据 / 探索，只有后两级必须等 verify）；判定只有三种结局，**「无结论」必须存在**，否则「没找到反例」会被写成「成立」；数值结果不许直接当证明（`forall` + `search` 的组合在调用时就被拒）；报告里每条陈述标 `[文献已知]` `[我算出的]` `[scratch]` `[推测]`。

## 谁在强制，谁只是提醒

这是整套东西里最容易含混的一处，所以说清楚：

| | 它是什么 | 它能做什么 | 它不能做什么 |
|---|---|---|---|
| **skill** | 一个 `SKILL.md`，模型按需加载 | 讲清每一步该产出什么，以及为什么 | 不强制任何东西。不加载就等于不存在 |
| **对账脚本**（`skills/research-protocol/tools/`） | 只读 `goal.md` / `state.json` / `claims.jsonl` | 判「这一轮的记录自洽吗」，并把不一致指出来 | 不拦人。要自己跑，自己看结果 |
| **插件** | 挂进宿主的组件 | 真的拒绝：工具调用直接返回失败 | 只能判机械可判的那部分 |

`research-gate` 是唯一会拦住你的那个。它拒的时候必须说清缺什么——拒绝文案按当前会话里**真实可见**的工具渲染，不点名不存在的东西（这一条是修出来的，见 [`docs/03-failure-log.md`](docs/03-failure-log.md)）。

## 安装

一条命令。自建一个 profile（不碰你在用的那个），逐个装包，然后**把 skill 也装进去**——插件装不了 skill，所以安装器有第二步：

```bash
git clone https://github.com/laoda12345576/dsh-math-flow && cd dsh-math-flow
node scripts/install.mjs                 # core：内核 + 冻结断言 + 顺序门禁 + 文献 + 三个 skill
```

```bash
node scripts/install.mjs --with-viz      # + 绘图：Python / MATLAB / TikZ
node scripts/install.mjs --tier full     # + 绘图、记忆、团队、否定知识（第三方包）
node scripts/install.mjs --with-purge    # + dsh-purge（patch 层依赖它；git 托管，需手动放行构建）
node scripts/install.mjs --no-skills     # 只装插件
node scripts/install.mjs --skills-dir <目录>   # skill 装到别处
node scripts/install.mjs --dry-run       # 只打印计划
node scripts/install.mjs --verify-only   # 只校验已有安装
node scripts/doctor.mjs                  # 缺哪个工具链（只读）
```

实测输出（core 档，不是示意）：

```
  ok   lean-math  (dsh-plugin-lean-math)
  ok   claim-verify  (dsh-plugin-claim-verify)
  ok   research-gate  (dsh-plugin-research-gate)
  ok   paper  (dsh-plugin-paper)
  profile math-flow: 156 components, 0 of 4 expected plugins missing

  ok   skill research-protocol
  ok   skill cordis-plugin-development
  ok   skill editing-cordis-compositions
  skills: 3 of 3 present in <DSH_HOME>/skills
```

校验读的是 `dsh --profile <名字> --dump-config`，核对每个插件的**实际组件 id**——不是包名，因为 `misakanet@3.5.0` 挂载成 `misakanet-mcp`，按包名匹配的校验器会把健康的安装报成坏的。

## 环境要求

| 需要 | 怎么装 | 说明 |
|---|---|---|
| Node ≥ 22.5 | 任意方式 | 插件是 ESM，`engines` 已声明 |
| `dsh` | `npm i -g @deepseek-ai/dsh` | **验证于 0.1.5-rc.2。** npm 上的 `latest` 是 0.2.2-rc.5，未针对这套锁定版本测过 |
| `pnpm` | `npm i -g pnpm` | `dsh plugin` 会转发给它 |
| Lean 4 + Lake | `elan default leanprover/lean4:stable` | 内核；没有它判定会返回错误，而不是假通过 |
| Mathlib | `git clone` 后 `lake exe cache get` | `import Mathlib` 需要，约 4 GB |

只有 Lean 和 Mathlib 算可选，而且「可选」的意思是流水线能装起来：插件会挂载，之后每次判定返回错误而不是假通过。`node scripts/doctor.mjs` 报告缺哪项以及修复命令；它刻意不替你装 Mathlib，因为那是 4 GB 的磁盘决策。

## 仓库里有什么

| | 数量 | 在哪 |
|---|---|---|
| 插件：`lean-math`（内核判定，13 工具）· `claim-verify`（冻结断言，4）· `research-gate`（顺序门禁，1）· `paper`（文献，6） | 4 | [`packages/`](packages/) |
| 可选插件：`mm-toolkit`（绘图 / 反例，12 工具，5 个开箱可用） | 1 | [`packages/mm-toolkit`](packages/mm-toolkit) |
| skill：`research-protocol`（协议本体）· `cordis-plugin-development` · `editing-cordis-compositions` | 3 | [`skills/`](skills/README.md) |
| 对账脚本：目标/状态对账、收工判定、报告审计、定义域审计、交接、团队指标、编码读取、时钟锚点 | 8 | [`skills/research-protocol/tools/`](skills/research-protocol/tools/) |
| 第三方**包**：`meow-memory`（记忆）· `dsh-agent-teams`（团队）· `misakanet`（否定知识） | 3 | 按版本锁定、不打包，见 [`docs/05-dependencies.md`](docs/05-dependencies.md) |
| 第三方**skill**：`paper-writing` · `math-beamer` · `loogle-search` · `rigorous-paper-reviewer` · `lean-probe` | 5 | 别人的，只声明不打包，见 [`skills/README.md`](skills/README.md) |

**还有一部分留在作者的单机上，没有进这个仓库**：`watchdog`、`wps-bridge`、`hotloader`、`ollama`、`math-strategies`、`proof-harness`。清单和各自缺什么写在 [`packages/README.md`](packages/README.md)。它们不在这里，是因为还没脱敏、还依赖特定宿主构建，或者实测下来没有收益——不是因为忘了。

如果你只装 `packages/` 里的东西，你得到的是一个内核加一道门：没有记忆、没有团队、没有失败日志。流水线是上面这几行的组合。

## 怎么测

`lab/` 放的是协议，不是跑分。四个有答案的问题：

1. **记忆有效性** —— 同一个三天任务，开/关记忆：冷启动到可工作状态要几轮？
2. **重复调用率** —— 长会话里完全相同（工具+参数）的调用占比（实测基线：26%）。
3. **约束存活率** —— 60 轮会话里抽 5 个符号，第 50 轮时它们还是第 5 轮的意思吗？
4. **否定知识复用** —— 同一个错误出现第二次：找到已有教训要几轮，从零调试要几轮？

最小可行设计：三条臂（基线 / +记忆 / 全流水线），同一个人、同一个任务、同一个初始状态，每次运行一行写进 [`lab/metrics.csv`](lab/metrics.csv)。

**不要在同一个会话里既跑实验又写结论。** 压缩之后，复审者继承的是同一套错误前提。这是失败日志第 5 条，而且真实发生过。

## 它不做什么

- 它不能让一个弱模型证出难题。内核是法官，不是生成器。
- 它不能代替你读文献。`paper` 取回并核对引用，不替你理解；`survey` 要求引文是原文子串，就是为了挡「我知道」冒充「我读到」。
- 它不保证跨宿主版本可用。版本漂移是头号故障源。
- 它没有可以宣传的跑分。测量协议是诚实的替代品。

## 状态

Alpha。插件、skill、脚本三条线今天都能装；第三方包按版本锁定；单机上的六个只列清单。`profiles/` 里的配置已脱敏。依赖特定 `dsh` 构建的宿主补丁放在 [`patches/`](patches/README.md)，该目录当前刻意为空。

读两个文件就够了：[`skills/research-protocol/SKILL.md`](skills/research-protocol/SKILL.md)（协议本体，也是唯一一份从实验里长出来的文档）和 [`docs/03-failure-log.md`](docs/03-failure-log.md)（十条复盘，其中三条变成了上面的规矩）。

**增加一次测量的贡献，比增加一个插件的贡献更受欢迎。**

## 许可

MIT，见 [`LICENSE`](LICENSE)。
