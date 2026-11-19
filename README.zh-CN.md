# dsh-math-flow

**一条做数学研究的 agent 流水线 —— 它的目标是能被测量，而不是能被安装。**

大多数「agent 栈」仓库其实就是一张插件列表的截图。这个仓库给的是列表、配置、插件，以及真正重要的那部分：**一套能回答「这些到底有没有用」的实验协议。**

[English](README.md) · 依靠 DeepSeek Harness（`dsh`）、Lean 4 和 Mathlib。

> **今天仓库里实际有什么。** 五个插件、一个安装器、一套测量协议。下面的架构是八层，共点名十四个插件：五个在 `packages/` 里（四个在主路径上，一个可选），三个是按版本锁定的第三方包，其余六个仍留在作者的单机环境里——清单和原因都写在 [`packages/README.md`](packages/README.md)。这个仓库不装作它们都在，因为一份点名了不存在的包的清单，比一个诚实的缺口更糟。

---

## 它要解决的问题

用 agent 做长时间的数学会以一种固定方式失败：**约束会衰减。** 一个符号在第 5 轮定义，第 40 轮开始漂移，第 60 轮 agent 已经在证关于另一个对象的定理。全程没有任何东西崩溃，输出只是悄悄地变成了别的东西。

这条流水线存在的目的，就是在一个会话里让四样东西活着：

| 会衰减的东西 | 这里由谁负责 |
|---|---|
| 符号定义 | `lean-math` —— 内核会拒绝一个关于错误对象的证明。除此之外靠人工约定：**没有符号表插件**，最初的设计以为会有 |
| 否定结果（「这条路死了」） | `misakanet` —— 从失败里取教训，不是做检索 |
| 压缩之后的任务归属 | `agent-teams` —— 常驻成员、依赖 DAG、信箱 |
| 一切，在上下文被压缩时 | `meow-memory` —— 压缩后重新注入 |

插件列表不是流水线。**顺序和禁令才是流水线。** 详见 [`docs/01-architecture.md`](docs/01-architecture.md)。

---

## 三条设计规则

这不是口号，每一条都是先失败过一次之后剩下的东西。完整的复盘在 [`docs/03-failure-log.md`](docs/03-failure-log.md)。

**一、凡是能被机械判定的，就做成函数，不要做成 agent。**
一个叫 `check` 的角色去跑脚本，活了 103 秒，返回零条判定——它死在五步循环的第三步（读上下文 → 理解 → 写脚本 → 执行 → 报告）。同一个检查做成工具调用是 300 毫秒，而且不会忘记报告。agent 用来做判断，不用来做比对。

**二、提出断言的人，不能同时是签发断言的人。**
形式化成员被刻意做成另一个成员，工具集也被刻意收窄：它能把命题翻成 Lean 并编译，但它不能生成策略，也不能审计断言。自我认证是机器能拿到的最便宜的作弊方式。

**三、一份描述有权威性，其余的都是从它生成的。**
最初的失败是同时维护四份互相独立、各自看起来都合理、且都没人核对过的同一份数学（散文报告 / Lean / 脚本 / 状态表）。解法不是上四个 linter，解法是把其中三份降级。

---

## 架构

八层，一层一个插件家族。**同一层里放两个插件会打架**——尤其是记忆，每个候选都在抢同一个系统提示注入位。

```
执行    agent-teams
计算    lean-math · proof-harness* · math-strategies* · ollama*
观察    watchdog* · mm-toolkit（绘图 / 反例，可选）
记忆    meow-memory            ← 只能有一个，绝不放两个
否定    misakanet              ← 失败教训，不是通用检索
文献    paper · zotero*        ← 证据库，不是通用 RAG
输出    wps-bridge*            ← 通往 .docx/.xlsx/.pptx 的唯一路径
运维    hotloader* · market · purge · web
```

`*` —— 已设计、在作者机器上运行、**尚未进入本仓库**。[`packages/README.md`](packages/README.md) 按依赖顺序列出它们以及各自在等什么。这里选择把布局写全而不是裁剪掉，因为一张带洞的分层图，比一张更小但撒谎的图有用。

一个任务的流转，以及那条不可协商的顺序约束：

```
记忆重注入 → lean_status →（失败时）misakanet_search
   → 生成策略 → 内核判定 → 可视化 → 文档
```

**先内核，后文字。** 反过来的产物是一份描述未验证结果的文档——这是 agent 辅助数学里最常见的失败方式。

逐工具的说明：[`docs/02-tool-reference.md`](docs/02-tool-reference.md)。

---

## 快速开始

一条命令。它会自建一个 profile（`math-flow`），不碰你正在用的那个；按锁定版本逐个装包；最后校验到底挂上了什么：

```bash
git clone https://github.com/laoda12345576/dsh-math-flow && cd dsh-math-flow
node scripts/install.mjs                 # core：内核 + 冻结断言 + 顺序门禁 + 文献
```

```bash
node scripts/install.mjs --with-viz      # 再加绘图：Python / MATLAB / TikZ，12 个工具
node scripts/install.mjs --tier full     # 再加绘图、记忆、团队、否定知识
node scripts/install.mjs --dry-run       # 只打印计划，不动任何东西
node scripts/install.mjs --verify-only   # 只校验已有 profile
node scripts/doctor.mjs                  # 缺哪个工具链（只读）
```

`--with-viz` 单独开关、不放进 core，是因为 `mm-toolkit` 那 12 个工具里有 7 个需要本仓库不带的外部桥脚本。它们会按文件名报缺失，而不是在 spawn 处失败——哪 5 个开箱能用，见 [`packages/mm-toolkit/README.md`](packages/mm-toolkit/README.md)。

缺 `node`、`dsh` 或 `pnpm` 时，安装器会拒绝启动；它逐个包安装，所以中途失败会留下一个可续跑的 profile；已经装到锁定版本的会跳过。最后一步读 `dsh --profile <名字> --dump-config`，核对每个插件的**实际组件 id**——不是包名，因为 `misakanet@3.5.0` 实际挂载成 `misakanet-mcp`，一个按包名匹配的校验器会把健康的安装报成坏的。

core 档最后一步的输出（实测，不是示意）：

```
  ok   lean-math  (dsh-plugin-lean-math)
  ok   claim-verify  (dsh-plugin-claim-verify)
  ok   research-gate  (dsh-plugin-research-gate)
  ok   paper  (dsh-plugin-paper)
  profile math-flow: 156 components, 0 of 4 expected plugins missing
```

`--with-viz` 会多一行 `mm-toolkit`（157 个组件）；`--tier full` 再多三行：`agent-teams`、`meow-memory`、`misakanet-mcp`。

然后：

```bash
dsh --profile math-flow        # 启动
```

## 环境要求

| 需要 | 怎么装 | 说明 |
|---|---|---|
| Node ≥ 22.5 | 任意方式 | 插件是 ESM，`engines` 已声明 |
| `dsh` | `npm i -g @deepseek-ai/dsh` | **验证于 0.1.5-rc.2。** npm 上的 `latest` 是 0.2.2-rc.5，未针对这套锁定版本测过 |
| `pnpm` | `npm i -g pnpm` | `dsh plugin` 会转发给它 |
| Lean 4 + Lake | `elan default leanprover/lean4:stable` | 内核；没有它判定会返回错误，而不是假通过 |
| Mathlib | `git clone` 后 `lake exe cache get` | `import Mathlib` 需要，约 4 GB |

只有 Lean 和 Mathlib 算可选，而且「可选」的意思是流水线能装起来：插件会挂载，之后每次判定返回错误而不是假通过。`node scripts/doctor.mjs` 会报告缺哪项以及对应的修复命令；它刻意不替你装 Mathlib，因为那是一个 4 GB 的磁盘决策，不是前置条件。

如果在新版本宿主上挂载检查报 `MISS`，那是版本漂移，不是插件坏了——见失败日志第 7 条。

## 仓库里有什么，你需要另外装什么

一条能跑的流水线里会出现三类东西，它们来自三个不同的地方。把它们混为一谈，正是大多数「agent 栈」仓库无法复现的原因：

| 层 | 来自哪里 | 状态 |
|---|---|---|
| 内核（`lean-math`）、证据（`claim-verify`）、顺序（`research-gate`）、文献（`paper`） | 本仓库 `packages/` | 已发布 |
| 绘图（`mm-toolkit`） | 本仓库 `packages/`，`--with-viz` | 已发布，可选——12 个工具里 5 个不需要桥脚本 |
| 记忆、执行、否定知识 | 第三方 npm 包，**只声明不打包** | 锁定在 [`docs/05-dependencies.md`](docs/05-dependencies.md) |
| 看门狗、文档输出、运维 | 仍在作者的单机环境里 | 列在 [`packages/README.md`](packages/README.md)，暂时装不了 |

这个区分很要紧：如果你只装 `packages/` 里的东西，你得到的是一个内核加一道门，但没有记忆、没有团队、没有失败日志。流水线是它们的组合。

每个插件的说明——写的是它**拒绝**做什么，不只是它能做什么——在各 `packages/*/README.md` 里。

## 目录结构

```
packages/     5 个已发布插件；另外 6 个只列清单，不在仓库里
profiles/     core 和 full 两份清单，以及编码团队策略的 patch 层
scripts/      install.mjs（一条命令）和 doctor.mjs（只读体检）
docs/         01 架构 · 02 工具表 · 03 失败日志 · 04 测量 · 05 依赖
lab/          测量协议与 metrics.csv 表头 —— 没有编造的数字
patches/      依赖特定宿主的补丁，连同目标版本一起隔离
```

如果只读两个文件，读 [`docs/03-failure-log.md`](docs/03-failure-log.md) 和 [`docs/04-measurement.md`](docs/04-measurement.md)。前者是十条复盘——其中三条变成了上面的设计规则，另外七条解释了配置为什么长成这样。后者是你怎么检验这套东西到底有没有用。插件是最不重要的一部分：它们可以被替换，日志不能。

---

## 怎么测

这是通常缺失的部分。`lab/` 放的是协议，不是跑分。

四个有答案的问题：

1. **记忆有效性** —— 同一个三天任务，开/关记忆：冷启动到可工作状态要几轮？
2. **重复调用率** —— 长会话里完全相同（工具+参数）的调用占比（实测基线：26%）。
3. **约束存活率** —— 60 轮会话里抽 5 个符号，第 50 轮时它们还是第 5 轮的意思吗？
4. **否定知识复用** —— 同一个错误出现第二次：找到已有教训要几轮，从零调试要几轮？

最小可行设计：三条臂、同一个人、同一个任务、同一个初始状态。

| 臂 | 配置 | 隔离出什么 |
|---|---|---|
| A | 只有 base + web app | 无记忆、无协作、无否定知识 |
| B | A + 记忆 | 记忆单独的贡献 |
| C | 完整流水线 | 整体 |

每次运行记录：轮数、工具调用、重复调用、压缩次数、人工介入、可复现性。`lab/metrics.csv` 每行一次运行。

**不要在同一个会话里既跑实验又写结论。** 压缩之后，复审者继承的是同一套错误前提。这是失败日志第 5 条，而且真实发生过。

---

## 它不做什么

- 它不能让一个弱模型证出难题。内核是法官，不是生成器。
- 它不能代替你读文献。`paper` 负责取回并核对引用，不负责替你理解。
- 它不保证跨宿主版本可用。锁定版本在 `profiles/full/package.json` 里；版本漂移是头号故障源。
- 它没有可以宣传的跑分。测量协议是诚实的替代品。

---

## 状态

Alpha。`packages/` 里有五个插件且今天就能装——`lean-math`、`claim-verify`、`research-gate`、`paper`，以及可选的 `mm-toolkit`；另外六个按依赖顺序列在 [`packages/README.md`](packages/README.md)，写明各自在等什么，并且是刻意缺席的——一份引用了它们的清单会解析失败，那比一个诚实的缺口更糟。`profiles/` 里的配置已脱敏。依赖特定 `dsh` 构建的宿主补丁应该放在 [`patches/`](patches/README.md)，该目录当前刻意为空。

**增加一次测量的贡献，比增加一个插件的贡献更受欢迎。**

## 许可

MIT，见 [`LICENSE`](LICENSE)。
