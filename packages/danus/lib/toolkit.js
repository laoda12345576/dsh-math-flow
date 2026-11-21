/**
 * 解析宿主自己的 defineTool。
 *
 * 为什么不能直接 `import '@deepseek-ai/dsh-tools'`：插件以符号链接方式挂在
 * `$DSH_HOME/profiles/<name>/node_modules/` 下，真实路径在别处，Node 的模块
 * 解析从真实路径出发，找不到 profile 里的依赖。所以按 specifier 和 profile
 * 绝对路径两条路依次试。
 *
 * @module dsh-plugin-danus/toolkit
 */

let implementation = null
let implementationSource = 'unresolved'

export async function resolveDefineTool() {
  if (implementation !== null) return { defineTool: implementation, source: implementationSource }
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') {
      implementation = mod.defineTool
      implementationSource = '@deepseek-ai/dsh-tools'
      return { defineTool: implementation, source: implementationSource }
    }
  } catch {
    /* 走 profile 兜底 */
  }
  for (const candidate of profileCandidates()) {
    try {
      const mod = await import(candidate)
      if (typeof mod.defineTool === 'function') {
        implementation = mod.defineTool
        implementationSource = `${candidate} (profile fallback)`
        return { defineTool: implementation, source: implementationSource }
      }
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    'dsh-plugin-danus: 找不到 defineTool。请把插件装进某个 DSH profile：' +
      '`dsh plugin --profile <name> add <repo>/packages/danus`',
  )
}

function profileCandidates() {
  const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME
  if (typeof home !== 'string' || home === '') return []
  const base = home.replace(/\\/g, '/').replace(/\/+$/, '')
  // DSH_HOME 就是 home；从 USERPROFILE/HOME 退下来时 dsh 装在 .dsh 下。
  const root = base.replace(/^\/+/, '')
  const homes =
    process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? [root]
      : [`${root}/.dsh`, root]
  return homes.map((h) => `file:///${h}/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js`)
}
