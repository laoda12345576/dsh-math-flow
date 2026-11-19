# dsh-plugin-lean-math

DeepSeek Harness 插件：把 **Lean 4 证明助手**接进 harness，让 agent 能像人类数学家那样查询、验证并一步步构造证明。

## 工具

| 工具 | 作用 |
| --- | --- |
| `lean_status` | 检测 elan/lean/lake 与 curl 是否可用 |
| `lean_search_premise` | 在 Mathlib 中检索定理（leansearch / moogle / premise-search） |
| `lean_verify_proof` | 用 Lean 内核严格验证一段完整代码（最终裁判） |
| `lean_axioms` | 检查每个声明依赖的公理；`uses_sorry: true` = 证明其实没做完 |
| `lean_deps` | 依赖图：传递闭包 + 每个依赖的所属模块 + 节点间的边 |
| `lean_open_file` | 开启一个交互式证明会话（常驻 Lean 服务器） |
| `lean_get_goals` | 读取当前目标与诊断（"眼睛"）——通常是瞬时读缓存 |
| `lean_run_tactic` | 追加一步 tactic 并返回新状态（"手"），`bullet: true` 可定位多目标中的一个 |
| `lean_update_source` | 在**同一会话**里整体换掉源码换定理——复用已加载的 imports（~1秒），避免开新会话重付 import（~40–60秒） |
| `lean_undo` | 回退到任意历史检查点，干净地放弃一条思路 |
| `lean_query` | 在会话上下文里 `#check` / `#eval` / `#print` / `#reduce` |
| `lean_sessions` | 列出活跃会话与可恢复的历史会话 |
| `lean_close_session` | 结束交互式会话（`keep: true` 保留可恢复副本） |

## 目标状态是怎么拿到的

**常驻 Lean 语言服务器 + 增量重解析**，不再重跑 CLI、不再用正则抠文本。

每个 project 目录维护一个 `lean --server` 进程：imports 只加载一次，之后每一步 `didChange`
只重新解析改动的部分，目标从 `$/lean/plainGoal` 直接拿到结构化结果：

```json
{"goals":["case zero\n⊢ 0 + 0 = 0","case succ\nn✝ : Nat\n..."],"rendered":"..."}
```

> **更正一处此前的错误结论。** 旧版 README 称 Lean 4.33 的 LSP「不提供 `plainGoal`，实测请求不响应」，
> 并据此放弃了语言服务器。实测下来这个结论是错的：`$/lean/plainGoal` 完全可用（上面就是真实返回）。
> 当初之所以看起来不响应，是因为**查询得太早**——Lean 会先发布一次**空的**诊断集，之后才发布真的；
> 在第一次「版本匹配的诊断」到达时就读，拿到的自然是空目标。代价是白白多付了每步一次全量重启。

两个踩出来的坑，已固化在 `lib/server.js` 里：

1. `didOpen` 之前文档**必须真实存在于磁盘**（服务器自己读文件），但之后**不能**再写磁盘——
   服务器的 file watcher 会重新处理，和我们刚发的 `didChange` 打架。
2. "处理完成"的判据曾经只看「版本匹配的诊断 + 通知静默」，结果被 Lean 的行为骗过：
   `import Mathlib` 时服务器**先发布一批空诊断**（约 6 秒就到），真正的 elaboration 要 ~80 秒，
   期间的静默窗口让 `openDocument` 提前 6 秒假返回。**现在的判据是 `$/lean/fileProgress`**：
   服务器在 elaborate 时持续推送 `processing:[...]`（非空），排空成 `processing:[]` 才算真完成——
   这个信号 Lean 无法伪造。修复后 `openDocument` 会诚实等到加载完毕（~80 秒）才返回，
   返回时 goals 已就绪，第一个 `plainGoal` 只需 ~5 毫秒。

被拒的 tactic 仍然会**回滚**，保证下一步从上一个正确状态开始；否则一行坏 tactic 会污染之后
所有步骤。现在因为每一步都留了检查点，`lean_undo` 还能退回到更早的任意一步。

## 会话持久化

每一步都会把 `{source, history, projectDir}` 落到 `$DSH_HOME/.lean-sessions/<id>.json`。
重启后 `lean_get_goals` 按 `session_id` 自动恢复会话（重新 open 文档并从落盘的源码继续），
`lean_close_session` 默认清掉副本、传 `keep: true` 则保留。会话不再「重启即失忆」。

## 一个诚实的限制

`lean_query` 走的是 **CLI 而不是常驻服务器**：实测 Lean 4.33 的语言服务器对 `#check` **不发布任何
诊断**（它的输出走的是协议不暴露的 infoview 通道），所以常驻查询只会返回空。CLI 会把它打在
stdout 上。代价是一次 `lean` 运行——纯 Lean 无妨，`import Mathlib` 时会重新加载一遍。
因此 `lean_query` 适合偶尔问一句，不要放在证明主循环里。

## 安装

```powershell
dsh plugin --profile web add D:\tools\dsh-plugin-lean-math
```

然后重启 DSH host，使其注册该插件行（bundle patch 只在 host 启动时应用）。

## 配置

`cordis.patch.yml` 中的行默认值：

- `projectDir` — Mathlib lake 项目绝对路径（`import Mathlib` 的证明会在此用 `lake env lean` 检查）。
  传 `""` 表示用纯 `lean`（不加载 Mathlib）。
- `defaultTimeoutMs` — 一次性验证的运行预算（默认 240000；冷 `import Mathlib` 可能远超这个数）。
- `interactiveTimeoutMs` — 交互式单步的运行预算（默认 300000）。常驻服务器下单步通常 ~1 秒，
  这个预算主要是给**首步加载 imports** 用的——`import Mathlib.Tactic` 约 80 秒，
  全量 `import Mathlib` 可能要十几分钟，加载不完就把它调大。
- `searchTimeoutMs` — 单次检索请求超时。
- `serverIdleMs` — 常驻服务器在无会话引用后可保留多久（默认 600000）。设 0 表示最后一个会话
  一关闭就立刻停（省内存，但下次要重新加载 imports）。

超时都是**强制**的（`AbortSignal`）。注意 `subprocess` 的 `graceMs` 是「优雅终止宽限期」而非运行上限——
早期版本误把 `graceMs` 当超时，导致 Mathlib 慢加载时调用看起来无限挂起，已修。

## 性能（本机实测，Lean 4.33 / Mathlib4）

改造前（每步 spawn 一次 `lean` + 重新加载 imports）：

| 场景 | 单步耗时 |
| --- | --- |
| 无 import | 约 4.2 秒（其中 user+sys 仅 0.53 秒，其余是进程启动开销） |
| `import Mathlib.Tactic` | 约 24–26 秒 |
| `import Mathlib`（全量） | 约 48–69 秒；冷盘时实测超过 10 分钟仍未结束 |

改造后（常驻服务器，imports 只加载一次；本机实测）：

| 场景 | 首步（启动 + 加载 imports） | 之后每一步 |
| --- | --- | --- |
| 无 import | 约 6.6 秒 | **约 1.0 秒** |
| `import Mathlib.Tactic` | 约 80–150 秒（一次性） | **约 0.95 秒** |

几个直接受益的点：

- `lean_get_goals` 默认读缓存，**0–1 毫秒**（原来每次 4 秒起）。
- `lean_undo` 约 1 秒，且不再像旧版那样只能退一步。
- Mathlib 单步 **24–26 秒 → 0.95 秒，约 25 倍**；一个 20 步的证明从「20 × 25 秒 ≈ 8 分钟干等」
  变成「一次加载 + 20 × 1 秒」。
- 跨会话复用：同一个 project 的 server 在 `serverIdleMs`（默认 10 分钟）内保留，
  开第二个证明不用再付加载费。
  ⚠️ 代价是内存：一个 Mathlib 镜像是几个 GB。本机实测可用内存约 4 GB 时，
  `import Mathlib` 全量加载会慢到十几分钟（swap 所致），窄 `import Mathlib.Tactic`
  约 80 秒。内存紧张时把 `serverIdleMs` 设小（或 0）让它用完即退。

- **换定理别开新会话，用 `lean_update_source`。** Lean 的 import 是**按文件**重新 elaboration 的：
  哪怕模块已在内存，开一个新文件 `import Mathlib.Tactic` 仍要 ~40–60 秒；而在**同一会话**里
  整体替换源码（import 行不变）只要 ~1 秒（本机实测 0.92–0.96 秒）。做定理搜索/批量尝试时，
  这是「N × 60 秒」和「N × 1 秒」的差别——开一个会话，反复 `lean_update_source` 换定理，
  配合 `lean_undo` 回退，而不是每个候选都 `lean_open_file`。

> **更正一处关于全量 import 的说法。** 前文（及旧版）称全量 `import Mathlib`「约 48–69 秒，冷盘
> 超 10 分钟」。在**交互式常驻 server** 下实测更准确的情况是：全量 `import Mathlib`（聚合全部
> 8700+ 模块）会把 server 推到 1.2 GB 后对 `plainGoal` 查询**持续无响应**（实测 4 分钟不答），
> 基本不可用。交互式请用 `import Mathlib.Tactic` 或更窄的精确模块；全量聚合文件 `Mathlib.lean`
> 本就是给构建用的，不是给人 import 的。CLI 的 `lean_verify_proof` 不受影响（独立进程，跑完即退）。

窄 import 依然值得推荐（能大幅缩短**首次**加载：`import Mathlib` 全量在本机冷盘实测
超过 10 分钟仍未结束，而 `import Mathlib.Tactic` 约 80 秒），但它**不再是每一步都要付的成本**。

覆盖方式：在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里对同一个 `id`（`lean-math`）重写 `config`。

## 依赖

- Lean 4 工具链（elan）。纯 Lean 无需项目；`import Mathlib` 需要一个 Mathlib lake 项目。
- `curl`（检索用）。Windows 10+ 自带。

## 测试

```powershell
node test/run-all.mjs                  # 全部
node test/smoke.mjs        # 加载插件 + 注册 13 个工具
node test/patch-check.mjs  # 校验 bundle patch 的 YAML
node test/loop.mjs         # 交互闭环（回滚 + 接受 + 证明完成）
node test/goals.mjs        # 目标提取：多目标 / 单目标 / 失败回滚后目标
node test/axioms.mjs       # 公理检查：抓 sorry 作弊
node test/deps.mjs         # 依赖图：传递闭包 / 直接依赖 / 模块过滤
node test/mathlib.mjs      # Mathlib 交互步 + 超时强制生效
node test/diagnostics.test.mjs  # 诊断解析
node test/timeout.test.mjs      # 超时强制生效
```

慢速脚本（`run-all` 默认跳过，需手动跑）：

```powershell
node test/bench-interactive.mjs  # 完整回归 + 计时：open / get_goals / 多步 tactic / 回滚 /
                                 # undo / query / bullet 多目标 / sessions / verify_proof
node test/bench-mathlib.mjs      # Mathlib 场景：imports 只加载一次，之后每步增量（分钟级）
node test/probe-lsp.mjs          # 当初用于确认 plainGoal 可用的探测
node test/probe-incremental.mjs  # 当初用于确认 didChange 增量可行的探测
```

> 这些脚本里的 mock 必须把 `spec.env` 传给 `spawn`，否则 lake 项目的 `LEAN_PATH`
> 传不到 `lean`，Mathlib 相关断言会假失败（报 `unknown module prefix 'Mathlib'`）。

## 许可

MIT
