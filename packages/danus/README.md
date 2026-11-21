# dsh-plugin-danus

把 [Danus](https://github.com/frenzymath/Danus)（北大董彬组的证明搜索编排系统）搬进
dsh 会话，让 dsh 当它的**主智能体**。

Danus 原本的设计里，dsh 只是 worker 的后端（`CODEX_BACKEND=dsh`，每个 worker 跑一次
`dsh --profile headless`）。它的集成文档写得很明确：*"Danus does not register tools in
a dsh web profile."* 这个包补的就是这句没有的那一半。

## 三层，各自解决一个不同的问题

| 层 | 做什么 | 靠什么 |
|---|---|---|
| **A 网关** | 让主智能体看得见"它该看见的"（`gm_*` / `fact_*`） | 自己实现的 MCP stdio 客户端，启动时读一次 `tools/list` |
| **B 控制面** | 让主智能体启停那窝 worker | `danus` CLI 的 7 个 verb + doctor |
| **C 契约** | 让模型知道该怎么用 | 三个 skill（`danus-main` / `danus-elaboration` / `danus-initialize`） |

装上之后 dsh 里是这样（实测输出）：

```
[dsh-plugin-danus] write path correctly absent for role=main (main can read the graph, never write it)
[dsh-plugin-danus] role=main · 13 tools (5 gateway, 8 control) · python: ...\.venv\Scripts\python.exe -m danus.gateway
```

## 为什么 A 不是"在 patch 里多挂一行 mcp-client"

Danus 的权限边界是**角色能看到哪些工具**（`danus/gateway/roles.py`）：

| role | tools |
|---|---|
| `main` | `gm_add` `gm_search` `fact_search` `fact_revoke` `search_arxiv_theorems` —— **没有 `fact_submit`** |
| `worker` | 上面 + `fact_submit`（唯一的写入口，且要过 verifier） |
| `verifier` | 只有 `search_arxiv_theorems` |
| 未设 / 拼错 | fail-closed 到 verifier 那套 |

主智能体不能写事实，这是整个系统的承重墙：它一旦能写，verifier 的判定就自我作废。
如果挂载交给 profile 里另一行配置，插件就拿不到那份清单，也就**无法在测试里断言
这条边界有没有被绕过**。所以这里每次启动读一次 `tools/list`，原样注册——多一个不
注册，少一个不补。测试里那条 `main 看不到 fact_submit` 是这条边界的哨兵。

代价是自己维护约 300 行 MCP 客户端（`lib/mcp.js`）。换来的是：不依赖宿主内部 API、
能报出网关 stderr 里的真实原因、能在进程死掉/挂住时给出可读的话。

## 平台：Windows 原生可用，靠一个四处替换的兼容层

Danus 是 POSIX 项目，但它对 POSIX 的依赖只有四处，而且全在
`danus/orchestration/cli.py` 里。插件带了一个 `pycompat/` 目录，通过 `PYTHONPATH`
排在解释器搜索路径最前面；CPython 启动时会自动 import 里面的 `sitecustomize`，
所以补丁只作用于插件 spawn 的这个子进程，不改上游一行代码，也不影响机器上任何
其他 Python。

| 上游用法 | 在 Windows 上会怎样 | `pycompat` 怎么做 |
|---|---|---|
| `fcntl.flock(lock, LOCK_EX\|LOCK_NB)` | `ModuleNotFoundError`，模块级 import 就失败，整个 CLI 起不来 | `msvcrt.locking` 锁同一字节，把 `OSError` 转成 `BlockingIOError` |
| `os.kill(pid, 0)` | **`TerminateProcess(handle, 0)`——探活会把 worker 杀掉**，然后报告它死了 | `OpenProcess` 只查存在性，`ACCESS_DENIED` 视为活着 |
| `os.getpgid` / `os.killpg` | 属性不存在，`stop --force` 抛 `AttributeError`（上游只捕 `ProcessLookupError`） | 返回 pid 本身 / `taskkill /PID n /T /F` 杀进程树 |
| `Path("/proc/n/stat")` | 读不到 | 上游已有 `except (OSError, IndexError): return True`，自动退化为「活着」 |

`launch.mode` 仍然**按目标分开**：`auto` 在 Windows 上先试原生 Python + `pycompat`，
不行才退到 WSL。`{gateway: python, cli: wsl}` 照旧是合法配置。

实测（Windows 11，仓库自带 venv）：`list`、`new`、`assign`、`status` 全部原生跑通，
`danus_doctor` 的 `cli` 一项是 `ok`；13 个工具在 dsh 里注册成功。

**还剩一件不是平台问题的事**：`danus start` 要拉起 worker，worker 每一轮是一次模型
调用。`CODEX_BACKEND=api` 需要 OpenAI 兼容 key，`CODEX_BACKEND=dsh` 需要 bash 去执行
`bin/codex-dsh`（它把 `codex exec` 翻译成 `dsh --profile headless`）。这一项没有默认
值，`danus_doctor` 也不会替你猜。

## 安装

```bash
# Danus 侧：必须是 main 分支（默认分支 codex 没有 dsh 后端），
# 然后用它自己的 bootstrap 生成 venv（gateway 只额外需要 mcp）
git clone -b main https://github.com/frenzymath/Danus.git ~/Danus
cd ~/Danus && bash scripts/bootstrap.sh
```

Windows 上 `bootstrap.sh` 里的 codex 安装会失败，这没关系：网关与控制面都不需要它。
只要 `python -m venv .venv && ./.venv/Scripts/pip install mcp` 成功即可。

# dsh 侧
node scripts/install.mjs --profile math-flow --with-danus --danus-root ~/Danus
```

`--with-danus` 会做三件事：装这个包、装三个 skill、往 profile 的 `cordis.patch.yml`
追加一条 `- id: danus` 覆写（root 是机器路径，进不了仓库，只能安装时写）。

不加 `--danus-root` 也可以，那就设 `DANUS_ROOT` 环境变量，patch 里的 `root` 留空即读它。

## 工具

控制面（8 个，`danus_` 前缀）：

| 工具 | 说明 |
|---|---|
| `danus_doctor` | 体检：root / 解释器 / CLI / 网关按角色广告的工具 / verify 服务 / skill |
| `danus_list` | 项目花名册：worker 数、几个活着、模型 |
| `danus_new` | 脚手架项目（`--roles high:3,xhigh:4`） |
| `danus_assign` | 写某个 worker 的 `TASK.md`（覆盖不追加） |
| `danus_finalize` | 把 fact 记进 `TARGET.md`；**需要 `approved=true`** |
| `danus_start` | 起 worker 循环（`.pid.lock` 幂等） |
| `danus_status` | 存活 + 轮次 + 最后活动（`stuck?` 是软信号） |
| `danus_stop` | 优雅停；**`force` 需要 `approved=true`** |

网关面（数量由角色决定，`main` 是 5 个）：`danus_gm_add`、`danus_gm_search`、
`danus_fact_search`、`danus_fact_revoke`、`danus_search_arxiv_theorems`。

两个 `approved` 门槛是 Danus 契约里那两个 operator fork 的工具化。契约是**提示词**，
提示词劝不住——所以做成参数，缺了就拒，并说明为什么。

## 配置

```yaml
- id: danus
  config:
    root: ''            # Danus 仓库根；留空读 $DANUS_ROOT
    role: main          # main | worker | verifier | all
    author: dsh
    agentsRoot: ''      # 默认 <root>/runtime/projects
    verifyUrl: ''       # 留空读 $DANUS_VERIFY_URL，再退到 127.0.0.1:$VERIFY_PORT/verify
    launch:
      mode: auto        # 或 {gateway: python, cli: wsl}，或 bash|wsl|python|command
      wslDistro: ''     # 默认发行版没 bash 时要指定（Docker Desktop 的就没有）
      command: { gateway: [], cli: [] }   # mode=command 时的 argv
      startupTimeoutMs: 20000
      callTimeoutMs: 3600000   # fact_submit 要等 verifier 冷启动核验，别调小
    tools: []           # 白名单；空 = 网关广告什么就注册什么
    deny: []            # 黑名单
    policy:
      finalizeRequiresApproval: true
      forceStopRequiresApproval: true
```

## 实测记录

跑在真实 Danus（`frenzymath/Danus` main，MCP SDK `2025-06-18`）上：

- 四个角色的工具面：`main` 5、`worker` 5（含 `fact_submit`）、`verifier` 1、
  拼错角色 → 1（fail-closed 生效）
- `gm_add` 真的写进去了（`{"id": "8c08ddb3f4c6e78a", "kind": "master_guidance"}`），
  `gm_search` 真的跑了 BM25
- 在 dsh 里启动 `danusprobe` profile：13 个工具注册成功，网关用 Windows 原生 venv
- `92` 项确定性测试（`node test/run.mjs`），跑桩网关，不依赖 Python

一个从实测里学到的细节：FastMCP 出错时**只回一句** `Error executing tool fact_search`，
真正的原因（`RuntimeError: no such project: 'ghost'`）打在 stderr。所以客户端在
`isError` 时会等一下 stderr，把最后一条异常行捞回来——否则模型拿到的是一个没有
原因的错误，只能猜。

## 它不做什么

- **不带 Danus**。它需要你自己有一个部署：venv、`mcp`、verify 服务、codex/codex-dsh。
- **不跑 worker**。worker 由 Danus 的 `start` 派生，dsh 只是它们的后端。
- **不做 write-paper**。`paper_*` 工具在另一个 MCP 服务（`bin/write-paper-mcp`）里，
  不在这个网关的角色表内。要搬是另一轮的事。
- **不改 Danus**。没有 patch、没有 monkey-patch；两个平台限制都如实报出来，不绕过。
