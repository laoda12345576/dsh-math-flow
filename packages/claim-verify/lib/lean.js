/**
 * lean.js — 把"Lean 编译通过"变成一个有内容的判决。
 *
 * 要挡的错，和 P0-5 是同一个，只是换了个地方发作：
 * **编译通过不等于证明了那个命题**。而这台机器上实测过三种走法，
 * 每一种都能让 `lean file.lean` 返回 0：
 *
 *   1. `theorem t : 1 + 1 = 3 := by sorry`  → 退出码 0，只在 stderr 留一行 warning。
 *      判据是 `#print axioms t` 里有 `sorryAx`，不是退出码。
 *   2. `by native_decide` → 引入公理 `t._native.native_decide.ax_1_1`。
 *      它在 Lean 里就是"拿计算当证明"：信任的是编译器，不是内核。
 *      （`by decide` 不引入公理，是内核归约——两者必须分开判。）
 *   3. `set_option autoImplicit` 开着时 `theorem vac : Foo = Foo := rfl` 编译通过、
 *      不依赖任何公理，因为 `Foo` 被默默绑定成一个隐式变量——**命题变成了恒真式**。
 *      这条最危险：它"机器验证过"，而且看起来在说 Foo 的事。
 *
 * 所以判决不能只看退出码，要看四件事：编译、公理表、选项、以及 Lean 自己
 * 展开出来的语句（`#check`）指纹。后者的意义是：防"证了个别的东西"时，
 * 至少挡得住"悄悄改语句"——它比从源文件正则抽语句可靠，是内核看到的那个类型。
 *
 * 能力边界（说准）：它能保证"这个证明证明了它声称的那句话"，
 * **不能**保证"那句话就是你要的定理"。后者只能由 refute 去攻
 * 语句与命题原文的对应关系——但那两行文本现在都被 hash 钉住了。
 *
 * @module dsh-plugin-claim-verify/lean
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

/** 标准公理。除它们之外出现的公理一律当成"证明不完整"。
 *  `Classical.choice` 是数学界默认接受的；`propext`/`Quot.sound` 是 Lean 的基石。
 *  别的名字（尤其 `sorryAx`、自定义 `axiom`）都不是。 */
export const ALLOWED_AXIOMS = new Set(['propext', 'Classical.choice', 'Quot.sound'])

/** `native_decide` 生成的公理形如 `t._native.native_decide.ax_1_1`。 */
const NATIVE_AXIOM = /native_decide|ofReduceBool|_native\./i

const sha = (s) => crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 12)

/** 把语句归一化：去多余空白、去行首缩进。指纹只认这个。 */
export function normalizeStatement(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 源文件静态扫描。只看那些**公理表看不出来**的东西。
 *
 * `autoImplicit` 是重点：它不在 axioms 里，但决定了语句是不是恒真式。
 * 必须在声明**之前**关掉——写在后面等于没写。
 */
export function staticScan(code, decl) {
  const src = String(code ?? '')
  const declRe = new RegExp(`^[ \\t]*(?:theorem|lemma|def)[ \\t]+${decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm')
  const m = declRe.exec(src)
  const declAt = m ? m.index : -1

  // 找"声明之前"的 autoImplicit 关闭语句；`set_option ... false` 作用域到文件末尾，
  // 所以只要有一条在声明前面就够。
  let autoImplicitOff = false
  const optRe = /set_option\s+autoImplicit\s+false/g
  let om
  while ((om = optRe.exec(src)) !== null) {
    if (declAt < 0 || om.index < declAt) {
      autoImplicitOff = true
      break
    }
  }

  return {
    decl_found: declAt >= 0,
    auto_implicit_off: autoImplicitOff,
    // 自己声明的公理/常量：等于把命题假设成真的。
    local_axioms: [...src.matchAll(/^[ \t]*(?:axiom|constant)[ \t]+([A-Za-z_][\w'.]*)/gm)].map((x) => x[1]),
    native_decide: /\bnative_decide\b/.test(src),
    unsafe: /^[ \t]*unsafe[ \t]+(?:def|theorem|instance)/m.test(src),
    sorry_in_source: /\bsorry\b/.test(src),
    partial: /^[ \t]*partial[ \t]+def/m.test(src),
  }
}

/** 解析 `#print axioms`：`'t' depends on axioms: [a, b]` / `'t' does not depend on any axioms`。 */
export function parseAxioms(stdout, decl) {
  const text = String(stdout ?? '')
  const esc = decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const dep = new RegExp(`'${esc}'\\s+depends on axioms:\\s*\\[([^\\]]*)\\]`).exec(text)
  if (dep) {
    return {
      declared: true,
      axioms: dep[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }
  }
  if (new RegExp(`'${esc}'\\s+does not depend on any axioms`).test(text)) {
    return { declared: true, axioms: [] }
  }
  return { declared: false, axioms: [] }
}

/** 解析 `#check`：`ok (n : Nat) : n + 0 = n` → `(n : Nat) : n + 0 = n`。 */
export function parseCheck(stdout, decl) {
  const esc = decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // #check 可能被包成 `@ok (n : Nat) : ...`；也可能多行（类型很长）。
  const re = new RegExp(`^(@?${esc}\\b[\\s\\S]*?)(?=\\n[@'A-Za-z_]|\\n\\n|$)`, 'm')
  const m = re.exec(String(stdout ?? ''))
  if (!m) return null
  return normalizeStatement(m[1]).replace(new RegExp(`^@?${esc}\\s*`), '')
}

/**
 * 判决。输入是四份事实，输出只有一个词。
 *
 * `failed` 与 `blocked` 必须分开：工具链没装时返回 blocked，
 * 而 blocked **不是通过**——把它当通过，等于"没验"变成"验过"。
 */
export function judgeLean({ scan, axioms, compileOk, declFoundInLean, statement, stderr }) {
  const reasons = []
  if (!compileOk) reasons.push('compile_error')
  if (!scan.decl_found) reasons.push('decl_not_in_source')
  if (!declFoundInLean) reasons.push('decl_not_elaborated')
  if (!scan.auto_implicit_off) reasons.push('auto_implicit_on')
  if (scan.local_axioms.length) reasons.push(`local_axiom:${scan.local_axioms.join('+')}`)
  if (scan.unsafe) reasons.push('unsafe_decl')
  if (scan.partial) reasons.push('partial_def')

  const natives = axioms.filter((a) => NATIVE_AXIOM.test(a))
  const untrusted = axioms.filter((a) => !ALLOWED_AXIOMS.has(a) && !NATIVE_AXIOM.test(a))
  if (axioms.includes('sorryAx')) reasons.push('sorry')
  if (untrusted.length) reasons.push(`untrusted_axiom:${untrusted.join('+')}`)

  // 真空：`(h : False) → 任意命题`、或结论就是 True。证的是恒真式，不是定理。
  const st = String(statement ?? '')
  if (/\(\s*[A-Za-z_][\w']*\s*:\s*False\s*\)/.test(st)) reasons.push('vacuous_hypothesis')
  if (/:\s*True\s*$/.test(st.trim())) reasons.push('conclusion_is_True')

  let verdict
  if (reasons.length) verdict = 'failed'
  else if (natives.length) verdict = 'computed'
  else verdict = 'proven'

  return {
    verdict,
    reasons,
    axioms,
    native_axioms: natives,
    untrusted_axioms: untrusted,
    // 证据文件里留 stderr 尾部，别只留一个词。
    diagnostics: String(stderr ?? '').split('\n').filter(Boolean).slice(0, 20),
  }
}

function runLean(exe, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(exe, args, { cwd, windowsHide: true })
    } catch (err) {
      resolve({ notFound: true, error: err.message, code: -1, stdout: '', stderr: '', elapsedMs: 0 })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
    }, timeoutMs)
    child.stdout?.on('data', (c) => {
      if (stdout.length < 2_000_000) stdout += c.toString('utf8')
    })
    child.stderr?.on('data', (c) => {
      if (stderr.length < 1_000_000) stderr += c.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ notFound: err.code === 'ENOENT', error: err.message, code: -1, stdout, stderr, timedOut, elapsedMs: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, elapsedMs: Date.now() - started })
    })
  })
}

/**
 * 一次原子判定。
 *
 * 为什么把 `#print axioms` 和 `#check` 追加到**同一个文件**里跑一次，而不是分两次调：
 * 两次调用之间有窗口，文件可以被换掉（A-C4 就是这么翻的面）。一次编译、
 * 一份输出，是这里能拿到的最强一致性。
 *
 * @param {{file:string, decl:string, projectDir?:string, timeoutMs?:number, leanExe?:string, lakeExe?:string}} o
 */
export async function auditLean(o) {
  const file = path.resolve(String(o.file ?? ''))
  const decl = String(o.decl ?? '').trim()
  const timeoutMs = Number(o.timeoutMs) > 0 ? Math.floor(o.timeoutMs) : 240000
  if (!decl) return { verdict: 'failed', reasons: ['missing_decl'], file }

  let code
  try {
    code = await fsp.readFile(file, 'utf8')
  } catch (err) {
    return { verdict: 'failed', reasons: [`file_unreadable:${err.code ?? 'error'}`], file }
  }

  const scan = staticScan(code, decl)
  const probe = file.replace(/\.lean$/i, '') + `.audit-${Date.now().toString(36)}.lean`
  const probeSrc = `${code}\n\n-- audit probe（自动追加，勿手改）\n#print axioms ${decl}\n#check ${decl}\n`
  await fsp.writeFile(probe, probeSrc, 'utf8')

  const hasProject = Boolean(String(o.projectDir ?? '').trim())
  const run = hasProject
    ? await runLean(o.lakeExe || 'lake', ['env', 'lean', probe], { cwd: path.resolve(o.projectDir), timeoutMs })
    : await runLean(o.leanExe || 'lean', [probe], { cwd: path.dirname(file), timeoutMs })

  try {
    await fsp.unlink(probe)
  } catch {
    /* 留着也无害，但别因为清理失败把判决搞丢 */
  }

  if (run.notFound) {
    return {
      verdict: 'blocked',
      reasons: ['lean_not_found'],
      file,
      decl,
      scan,
      hint: hasProject ? 'lake 找不到：projectDir 或 elan 安装有问题。blocked 不是通过。' : 'lean 不在 PATH 里；用 projectDir 走 lake env。blocked 不是通过。',
    }
  }
  if (run.timedOut) {
    return { verdict: 'blocked', reasons: ['timeout'], file, decl, scan, elapsed_ms: run.elapsedMs, hint: `超时 ${timeoutMs}ms。blocked 不是通过。` }
  }

  const combined = `${run.stdout}\n${run.stderr}`
  const { declared, axioms } = parseAxioms(combined, decl)
  const statement = parseCheck(combined, decl)
  // 编译成功与否不看退出码：带 sorry 的文件退出码也是 0。看的是有没有 error 诊断。
  const compileOk = run.code === 0 && !/^\S+:\d+:\d+:\s*error/m.test(combined)

  const verdict = judgeLean({
    scan,
    axioms,
    compileOk,
    declFoundInLean: declared,
    statement,
    stderr: run.stderr,
  })

  return {
    ...verdict,
    file,
    file_sha: sha(code),
    decl,
    statement: statement ?? null,
    statement_sha: statement ? sha(normalizeStatement(statement)) : null,
    scan,
    elapsed_ms: run.elapsedMs,
    exit_code: run.code,
    // 编译失败要分出两种：证明错了，还是环境没配好。
    // `import Mathlib` 在没有 project_dir 时会报 unknown module——那不是定理被推翻，
    // 是判定没跑成。两者都判 failed（没核过就是没核过），但提示必须不同，
    // 否则队会去改一个本来没错的证明。
    ...(verdict.reasons.includes('compile_error') && /unknown module|unknown package|no such file or directory.*lakefile|could not resolve/i.test(run.stderr)
      ? {
          reasons: [...verdict.reasons, 'needs_project_dir'],
          hint: '编译器找不到 import 的模块：这多半是 project_dir 没给（要 import Mathlib 得走 `lake env lean`），不是你证错了。',
        }
      : {}),
  }
}
