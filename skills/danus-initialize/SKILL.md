---
name: danus-initialize
description: Danus 的首次配置访谈。当 runtime/.danus-initialized 不存在、OPERATOR.md 还是空模板，或者操作者说要初始化/重新配置时跑。问清几个只有他能回答的选择（后端、consult 传输、怎么称呼、语言、花费上限），然后真的把东西配好并验证，而不是说"应该可以了"。
---

# 首次配置访谈

你和这个操作者是第一次在这个部署上见面。**问**清楚几个关键选择（不要替他定），
把东西配好，留下一个真的能跑的系统。

上游权威文本：Danus 仓库 `.claude/skills/initialize/SKILL.md`。

## 0. 打招呼（两三句）

Danus 是自动化的数学系统：worker 证、verifier 是唯一的正确性闸门、你编排。
先说清要问几个配置问题，答案会存进 `OPERATOR.md`，所以只问一次。

## 1. 先读现状，别问已经做完的事

用 `danus_doctor`。它一次给出：root、解释器、CLI 能不能跑、网关按角色广告了
哪些工具、verify 服务在不在、skill 装没装。

如果 `danus_doctor` 说 CLI 不可用（Windows 上很常见：`danus/orchestration/cli.py`
第一行 `import fcntl`），**先把这个说清楚再谈别的**——那意味着控制面（起停 worker）
在这台机器上不可用，只有网关能用。别把这个问题留到第 5 步才暴露。

同时看 `git branch --show-current`：在 `main` 上就先建分支（不要直接在主分支上干）。

## 2. 问选择

**用选择的方式问**（能点就点，不能点就用编号列表），把推荐项放第一个：

- **codex 后端**（worker 和 verifier 跑在什么上）
  - *OpenAI 兼容 API key*（推荐）：填 `config/codex.env`，立刻可用
  - *自己的 ChatGPT 订阅*：设备码登录
  - *DeepSeek / dsh*：`CODEX_BACKEND=dsh`，worker 跑 `dsh --profile headless`
- **战略 consult 传输**
  - *付费 OpenAI 兼容 API*（`gpt_pro`，推荐）
  - *Anthropic API*（`claude_api`）
  - *Claude 订阅*（`claude_code`）
  - *关掉*（`off`，你自己想，不外部咨询）

再问几个自由文本的：

- 怎么称呼他，以及**语言**（默认中文）——之后一直用这个语言，记进 `OPERATOR.md`
- git 工作分支名（默认 `deploy/<操作者或主机名>`）
- 如果选了付费 API：**花费上限**（USD），到线要提醒
- 默认 worker 编制（默认 `high:3,xhigh:4`）——这个每次建项目还会再问，但先记默认值

## 3. 真的去配（每一步做完再下一步）

- **分支**：在 `main` 上就 `git checkout -b <branch>`。
- **配置**：`cp -n config/danus.env.example config/danus.env`，把
  `CODEX_BACKEND` 与 `DANUS_CONSULT_TRANSPORT` 设成他选的值。选 API key 的话
  再 `cp -n config/codex.env.example config/codex.env` 填 `CODEX_*` / `OPENAI_*`。
  **密钥只放 `config/*.env`**，绝不写进别的文件、绝不进 git。
- **OPERATOR.md**：就地填名字/语言/传输/上限/编制，不要产生重复段落。
- **codex**：API → 跑 `bash scripts/check-codex.sh` 确认可达；订阅 → 跑
  `bash scripts/setup-codex.sh login`，把打印出的 URL 和设备码给他。
- **consult 传输**：gpt_pro / claude_api 各跑一次**极短**的测试（例如"用一句话
  确认你能回答"），读返回的 envelope：`status:"completed"` 且 `reply` 非空才算通。
- **verify 服务（必须先起）**：`bash scripts/services.sh up verify`。
  **没有它 `fact_submit` 全部失败，而且看起来像"在跑"**。这是最容易被跳过的一步。
  它需要 POSIX（`setsid`），所以在 Windows 上只能在 WSL 里起。
- **确认**：再跑 `danus_doctor`，绿/红如实报。
- **标记完成**：`mkdir -p runtime && date -u +%FT%TZ > runtime/.danus-initialized`
- **提交**：只 commit `OPERATOR.md`（和新分支），**不 push**（push 永远是操作者的动作）。
  `config/*.env` 与 `runtime/` 永不提交。

## 4. 交付

说清选了什么后端/传输、系统确实起来了，然后**要题目**。拿到之后写
`runtime/projects/<p>/PROBLEM.md`，开始战略循环（见 `danus-main`）。

顺带提一句他以后会想要的能力：写论文时，可以把自己的论文放进 write-paper skill
的 `style/anchors/`，输出会贴合他的文风（不放也能生成完整论文）——别让它变成隐藏功能。

## 规则

- **问，不要假设。** "用默认值"可以，但要明确记下来。需要只有他能给的东西
  （key、登录）时，停下来要，不要猜。
- **验证，不要声称没查过的事。** 说"服务起来了"之前先确认。过早的"好了"然后
  发现是坏的，正是要避免的。
- **不在 `main` 上干活。**
- **每条答案先落盘再往下走**；只有在整套检查都绿了之后才写
  `runtime/.danus-initialized`——那个文件就是"别再问一遍"的标志。
- **别假装配好了。** 如果 CLI 或 verify 服务因为平台限制起不来，就说清楚哪一层
  不可用、为什么、要怎么办（通常是搬进 WSL2），然后让操作者决定。
