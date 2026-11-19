# mm-toolkit

把「画图」当成一次可以检查的执行，而不是一次观感。

十二个工具，三组：**执行器**（Python / MATLAB / LaTeX-TikZ，各自返回 stdout、stderr、退出码，图只是副产物）、**观察**（列出产物、读图）、**自动化**（有状态浏览器、知网、多轮审辩）。

## 先看这张表，再决定要不要装

**十二个工具里，五个开箱能用，七个需要你自己提供桥脚本。** 这是这个包的真实状态，不是免责声明。

| 工具 | 干什么 | 需要什么 | 现状 |
|---|---|---|---|
| `viz_python` | 跑 Python，有 figure 就存 PNG | `python` + numpy（画图需 matplotlib） | ✅ 开箱 |
| `viz_matlab` | 跑 MATLAB 批处理 | 本机 MATLAB + 配 `matlabExe` | ✅ 配了就能用 |
| `viz_tex` | TikZ 编译成 PDF | `xelatex`（自动探测 MiKTeX） | ✅ 出 PDF；PNG 预览见下 |
| `viz_list` | 列出 `viz_out` 里全部产物 | — | ✅ 开箱 |
| `viz_doctor` | 体检上面这些 | — | ✅ 开箱 |
| `viz_see` | 让本机豆包客户端读图 | `scriptsDir/doubao_bridge.py` + Windows 豆包客户端 | ⚠️ 需自备 |
| `viz_gen` | nano banana 生成位图 | `scriptsDir/nanobanana_bridge.py` + 网页登录态 | ⚠️ 需自备 |
| `browser` | 常驻真 Chrome，跨调用保留状态 | `scriptsDir/browserd.py`（Python + Playwright） | ⚠️ 需自备 |
| `browser_read` / `browser_status` | 读网页 / 看守护进程 | 同上 | ⚠️ 需自备 |
| `cnki` | 知网研学检索 | 同上 + 知网账号 | ⚠️ 需自备 |
| `think` | 五个角色的多轮审辩 | 同上 + DeepSeek 网页登录态 | ⚠️ 需自备 |

**为什么不全打包进来**：`browserd.py` 这些脚本依赖 Playwright、持久化的 Chrome profile、本机桌面客户端的窗口自动化，本质是**替这台机器定制的**。塞进仓库会让克隆者装上一个必然跑不起来的工具，然后花两小时 debug——这比明确说"没有"更伤人。

**缺失时的行为**：不会崩，也不会假装成功。每个工具检查自己的桥是否存在，缺了就返回一句能照着做的话：

```json
{
  "ok": false,
  "error": "viz_gen 依赖外部桥脚本 nanobanana_bridge.py，但 scriptsDir 未配置。详见 packages/mm-toolkit/README.md「外部桥脚本」一节。",
  "missing": "nanobanana_bridge.py"
}
```

## 安装

```bash
node scripts/install.mjs --with-viz        # 已有 profile 上加这个包
node scripts/install.mjs --tier full       # 或者整档一起装
```

装完先跑一次体检，它会告诉你哪一项缺、缺了怎么补：

```
（在会话里）viz_doctor
```

## 配置

每一项的默认值都是空的，意思是「运行时再解析」。只有你知道自己机器长什么样，所以这里不替你猜。

| 键 | 空值时 | 说明 |
|---|---|---|
| `workspace` | `<tmpdir>/mm-toolkit` | 产物写到 `<workspace>/viz_out`、`<workspace>/browse_out`。**建议显式设成实验目录**，否则图和脚本散在临时目录里 |
| `pythonExe` | Windows 用 `python`，其他用 `python3` | PATH 上的 python 常常没有 matplotlib。缺了不会失败，纯计算照常，只是画不了图，并返回 `VIZ_WARN` |
| `matlabExe` | `viz_matlab` 直接回「未配置」 | 不猜安装路径 |
| `xelatexExe` | 自动探测（`%LOCALAPPDATA%` 下的 MiKTeX，再查 PATH） | |
| `scriptsDir` | 所有桥工具报缺失 | 桥脚本所在目录 |
| `doubaoExe` | —— | 只在体检时用于报告 |
| `cnkiUser` / `cnkiPass` | 读 `MM_CNKI_USER` / `MM_CNKI_PASS` | **不要把密码写进 patch 文件**。写进入库文件，就等于写进仓库 |
| `daemonPort` | `8731` | 浏览器守护进程的回环端口 |

设置凭据的正确方式：

```bash
export MM_CNKI_USER='...'
export MM_CNKI_PASS='...'
dsh --profile math-flow
```

也可以先 `browser` 用 `start headed=true` 手动登录一次——登录态存在持久化的 Chrome profile 里，后续 `cnki` 直接复用，不需要密码。

## 外部桥脚本

七个工具共用三个约定好的 Python 脚本。如果你要用它们，按下表实现即可，接口是稳定的：

| 脚本 | 调用方式 | 约定 |
|---|---|---|
| `doubao_bridge.py` | `--image <path> --question-file <path> --json --timeout 240` | 最后一行输出 JSON：`{ok, reply, blank, image_attached, seconds}` |
| `nanobanana_bridge.py` | `--generate-file <path> --out <png> --timeout 300` | 成功时在 `--out` 落一张 PNG，最后一行输出 JSON |
| `pdf2png.py` | `<pdf> <png> <dpi>` | 用于 `viz_tex` 的预览图；**没有它也不影响出 PDF** |
| `browserd.py` | `--serve [--headed]` | 监听 `daemonPort`，JSON line 协议，命令：`ping / goto / eval / fill / click / tabs / screenshot / quit` |

`viz_tex` 的设计值得单独说：PDF 是真正的产物，PNG 只是方便预览。所以 `pdf2png.py` 缺失时返回 `ok: true` + `preview_skipped`，而不是把一次成功的编译报成失败。**判据是产物，不是截图。**

## 一个设计上的选择

`viz_python` 和 `viz_matlab` 都返回 `stdout` 和 `exit_code`，而不是只返回图片名。因为最常见的用法是**纯计算**——算一个数、跑一次扫描、验一个反例。早期版本把「成功」绑在「有没有 PNG」上，于是纯计算返回 `ok: false`，模型据此判断自己失败了，开始瞎改代码。这条教训也写在仓库的 `docs/03-failure-log.md` 里。

同样地，输出超过 8000 字符会掐掉中间、保留头尾——只 print 统计量和关键行，不要逐条打印。

## 测试

```bash
node test/smoke.mjs                      # 12 个工具是否注册
MM_PYTHON=/path/to/python node test/exec.mjs   # 真实执行：纯计算 / 画图 / 异常 / 长输出
node test/exec.mjs --matlab              # 再加一次 MATLAB 实跑（慢，20-40s）
```

`MM_PYTHON` 指向一个带 numpy 和 matplotlib 的解释器。不给就用 PATH 上的，那样画图用例会被跳过为失败——这是环境问题，不是代码问题。

## 已知边界

- **MATLAB 只在 Windows 上测过**，`-sd` 指定工作目录的做法在其他平台未验证。
- **豆包视觉桥只在 Windows 上成立**，它驱动的是桌面客户端。
- **`think` 依赖 DeepSeek 网页的 DOM 结构**，站点改版会失效，这属于设计如此。
- **守护进程的登录态绑定一个 Chrome profile 目录**，换机器要重新登录。
