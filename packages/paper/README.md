# dsh-plugin-paper

给 DeepSeek Harness 的**论文获取层**：把"能不能拿到全文、拿到的是不是真的"这件事做成 6 个原生工具。

## 它从哪来

不是想出来的，是从一次真实运行里反推出来的。那天跑一个数学问题，agent 用 22 次网页操作拿到了 3 篇付费期刊论文的**合法开放版本**，靠的是四件事：

1. 从**问题名**检索，而不是从期刊入口进（命中的天然全是开放源）
2. 一条**降级链**：直连 → `r.jina.ai` 文本代理 → 下载到本地用 `pypdf` 解析
3. 每个候选都给**多个 URL**，一个不通换下一个
4. 拿到之后**审计**：它读出一篇 viXra 论文的循环论证并给了反例

这四个动作原本是临场摸索，现在被固化成了工具。

## 六个工具

| 工具 | 干什么 | 为什么需要 |
|---|---|---|
| `paper_search` | 并行查 OpenAlex / Crossref / arXiv / zbMATH，按 DOI + 标题相似度去重合并 | 别凭记忆报引用；OpenAlex 结果自带 `oa_url` 告诉你哪里能免费下 |
| `paper_resolve` | 给 DOI / arXiv 号 / 标题找**合法免费全文**：Unpaywall + OpenAlex locations + arXiv | 付费墙打不开时先走这里，而不是硬碰出版社页面 |
| `paper_fetch` | 抓正文，三级降级 + 本地 PDF 解析（pdftotext → pypdf），落盘并记台账 | PDF 直读失败是常态，关键是换路径而不是放弃 |
| `paper_verify` | 核验一条引用是否真实存在，标题相似度 + 年份/作者一致性 | 防幻觉。这一步比多找十篇论文更能提升可信度 |
| `paper_ledger` | 看/记本地台账 `refs/ledger.jsonl` | 跨会话知道"上次到底从哪拿到的" |
| `paper_channels` | 通道自检：哪个源通、PDF 后端在不在 | "明明有网却抓不到"时先跑它，能立刻分清是限流还是后端缺失 |

判定口径（`paper_verify`）：

- `verified`：标题相似度 ≥ 0.9，无年份/作者冲突
- `probable`：0.75–0.9，需要人工核对卷期，或在正文标"转引"
- `not_found`：< 0.75，视为未验证，**不要写进正文**

## 合规边界（写进代码，不是写进文档）

只走合法公开渠道。盗版镜像（Sci-Hub / LibGen / Z-Library / PDFDrive 等）在 `checkPolicy()` 里被拒，而且：

- 重定向**手动跟随**，每一跳在**发出请求之前**过策略——合法链接跳到镜像站也会被拦，且拦在连接之前
- 命中时返回的不是网络错误，而是明确的策略说明 + 替代建议（去 arXiv / 机构仓储找）

用户上传转载站（doc88 / docin / 百度文库一类）默认也拒：版本不受作者控制，常是残缺件。真要放开，把 `allowRepost` 设为 true。

## 安装

本仓库的安装器会处理它，不需要手动建联接、也不改 `package.json`：

```bash
node scripts/install.mjs                 # core 档就包含 paper
node scripts/install.mjs --tier full     # 再加记忆、团队、否定知识
```

单独装一个包（已有一个能用的 profile 时）：

```bash
dsh plugin --profile <名字> add <本仓库路径>/packages/paper
```

挂载校验看组件 id **`paper`**，不是包名 `dsh-plugin-paper`——两者不同，按包名匹配的校验器会误报。

装好之后先跑一次 `paper_channels`：它会告诉你哪个源通、PDF 后端在不在。这一步能把"有网但抓不到"立刻分成两类——限流，还是后端缺。**不要跳过它去猜。**

`--patch` 临时挂载也行（调用时叠加一行 `cordis.patch.yml` 的 insert 块，profile 一个字节不改，去掉参数即卸载），但本仓库的安装器走的是常规安装路径，不需要它。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `email` | `''` | Unpaywall 要求**真实**邮箱（`test@example.com` 会被 422 拒）。留空则跳过它，只走 OpenAlex |
| `timeoutMs` | `25000` | 元数据接口超时 |
| `downloadTimeoutMs` | `70000` | 下载正文超时。arXiv 偶尔 200 之后慢慢吐 1.8MB，这个必须比元数据宽 |
| `maxChars` | `12000` | 回给模型的正文上限（全文照常落盘） |
| `saveDir` | `''` | 空 = `<工作区>/refs`，于是每个研究目录各自一份台账，天然隔离 |
| `allowRepost` | `false` | 是否允许用户上传转载站 |
| `injectPrompt` | `true` | 是否往系统提示插约 300 字符的"论文获取纪律" |

## 实测

### 一、核心逻辑（`node test/smoke.mjs`，全部真实对象，无 mock）

- 拒绝 sci-hub / libgen / z-lib ✓（重定向到镜像站时**在连接之前**被拒）
- 多源检索命中 Yang Ji 2021《Several special cases of a square problem》✓
- 从 arXiv 直下 PDF，`pdftotext` 抽出 12052 字符 ✓
- 真实引用 → `verified`，score 1.0 ✓
- 编造引用 → `not_found` ✓
- 死通道短路：首次 21.8s，第二次 5.0s（2 级被跳过）✓

### 二、装进 dsh 之后（`paper-mount-test`，19+1 bundle）

dsh 自己调用了 6 个工具，全部成功：

| 工具 | 结果 |
|---|---|
| `paper_channels` | 4/5 通道可用（openalex 9252ms / crossref 2121ms / arxiv 840ms / zbmath 5002ms），PDF 后端 `pdftotext + pypdf` |
| `paper_search` | 2 源各 5 条，合并 10 条，命中 `2105.05250` |
| `paper_resolve` | 2 个候选（pdf + abs） |
| `paper_fetch` | `via: direct+pdftotext`，12052 字符，落盘 `refs/*.pdf` + `.txt` |
| `paper_verify`（真） | `verified`，1.0 |
| `paper_verify`（假） | `not_found`，0.471，flag：作者不符 |

台账 `refs/ledger.jsonl` 自动记下了这次获取的完整路径。

## 已知限制（别指望它做不到的事）

1. **两个降级级在部分网络下不可用**。实测 `r.jina.ai` 与 `web.archive.org` 会被解析到
   Facebook 网段（108.160.169.174 / `2a03:2880::/32`），连接必然超时。在这种网络里，
   真正干活的是**直连 + 本地 PDF 解析**。
   - 插件会把"连不上的主机"记 10 分钟，失败一次就不再白等（实测 21.8s → 5.0s）
   - 换网络、或自建代理时，改 `readerProxy` 就能把这一级重新接上
2. **老刊和书拿不到**。Dodge 1976 的原题、Guy 的《Unsolved Problems in Number Theory》这类没有网络版或只有付费版，工具会明确报"无开放版本"，不会硬凑。
3. **扫描件没有文字层**。`pdftotext` 只能抽到空白，这时 `paper_fetch` 会返回"内容过短"。要么换来源，要么接受它拿不到。
4. **标题相似度不是语义理解**。改写过标题的转引可能掉进 `probable`。这是有意的保守：宁可让你核对一次，也不要放过一条假引用。
5. **Crossref 对 1990 年代以前的数学期刊覆盖有限**，此时以 zbMATH + arXiv 为准。
