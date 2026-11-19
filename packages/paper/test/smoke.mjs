/**
 * 核心逻辑的真实端到端自检（不需要 dsh，不需要 cordis）。
 * 跑法：node test/smoke.mjs
 *
 * 测的是"能不能真的拿到一篇论文"，用的是已知真实存在的对象：
 *   Yang Ji, "Several special cases of a square problem", arXiv:2105.05250
 */

import { searchAll, resolveOpenAccess, fetchDocument, verifyReference, checkPolicy, extractPdfText, httpGet, markDead, isKnownDead, clearDead } from '../lib/core.js'

const ok = (b) => (b ? 'PASS' : 'FAIL')
let fails = 0
const check = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`[${ok(cond)}] ${label}${extra ? '  ' + extra : ''}`)
}

// 0. 策略：盗版镜像必须被拒
for (const bad of ['https://sci-hub.se/10.1007/x', 'https://libgen.is/scimag/x', 'https://z-lib.io/x']) {
  const r = checkPolicy(bad)
  check(`拒绝盗版镜像 ${new URL(bad).hostname}`, r.allowed === false, r.reason ? `(${r.reason.slice(0, 40)}...)` : '')
}
check('允许 arXiv', checkPolicy('https://arxiv.org/pdf/2105.05250').allowed === true)
check('允许 numdam', checkPolicy('http://www.numdam.org/item/ASNSP_1990_4_17_3_405_0.pdf').allowed === true)

// 1. 检索
console.log('\n--- search ---')
const s = await searchAll('special cases of a square problem rational distance', { sources: ['openalex', 'crossref', 'arxiv'], limit: 6 })
console.log('sources:', s.sources.map((x) => `${x.source}:${x.ok ? x.count : 'ERR(' + x.reason + ')'}`).join('  '))
console.log('merged:', s.count)
for (const r of s.results.slice(0, 4)) {
  console.log(`  · ${r.title?.slice(0, 70)} | ${r.year || '?'} | oa=${r.oa_url ? r.oa_url.slice(0, 50) : 'none'} | in=${r.also_in.join(',')}`)
}
check('检索有结果', s.count > 0)
check('至少一个源可用', s.sources.some((x) => x.ok))

// 2. 定位开放版本
console.log('\n--- resolve (arxiv id) ---')
const rv = await resolveOpenAccess({ arxiv_id: '2105.05250' })
console.log('candidates:', rv.candidates.length, rv.candidates.map((c) => c.via).join(' | '))
check('给 arxiv_id 能给出候选', rv.candidates.length > 0)

// 3. 抓取 + PDF 抽取
console.log('\n--- fetch (PDF) ---')
const doc = await fetchDocument('https://arxiv.org/pdf/2105.05250')
if (doc.ok) {
  check('拿到正文', doc.chars > 1000, `via=${doc.via} chars=${doc.chars} bytes=${doc.bytes}`)
  console.log('  开头:', doc.text.slice(0, 180).replace(/\n/g, ' '))
  check('抽出的文本像数学论文', /square|rational|distance|Abstract/i.test(doc.text.slice(0, 3000)))
} else {
  check('拿到正文', false, `reason=${doc.reason} tried=${JSON.stringify(doc.tried)}`)
}

// 4. 引用审计：真的 vs 编的
console.log('\n--- verify ---')
const real = await verifyReference({ text: 'Yang Ji, Several special cases of a square problem, 2021' })
console.log('real  ->', real.verdict, real.score, real.best?.title?.slice(0, 60))
check('真实引用被验证', real.verdict === 'verified' || real.verdict === 'verified_with_flags' || real.verdict === 'probable')

const fake = await verifyReference({ text: 'A. Nakamoto 2019 Complete proof of the rational distance problem for all polygons, Annals of Mathematics' })
console.log('fake  ->', fake.verdict, fake.score, fake.best?.title?.slice(0, 60) || '(no match)')
check('编造的引用被判为可疑', fake.verdict !== 'verified')

// 5. 重定向策略：**连接之前**就要拦住。用本地服务器做，才是确定性的测法
//    （之前用 httpbin 不可达，只会走失败分支，属于假通过）。
console.log('\n--- redirect policy ---')
const { createServer } = await import('node:http')
const srv = createServer((req, res) => {
  if (req.url === '/to-mirror') {
    res.writeHead(302, { location: 'https://sci-hub.se/10.1007/x' })
    res.end()
  } else if (req.url === '/self') {
    res.writeHead(302, { location: '/ok' })
    res.end()
  } else {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body><p>hello from local page</p></body></html>')
  }
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port
const red = await httpGet(`http://127.0.0.1:${port}/to-mirror`)
console.log('to-mirror ->', JSON.stringify({ refused: red.refused, reason: (red.reason || '').slice(0, 50), hops: red.hops }))
check('重定向到镜像站被拒', red.refused === true)
// 拒绝发生在"下一跳发起之前"的证据：返回的是策略判定（盗版），而不是 DNS/连接错误；
// hops 只记录了那条把我们指向镜像站的重定向，之后没有任何请求发出。
check('拒绝来自策略判定而非网络失败', /盗版论文镜像/.test(red.reason || '') && Array.isArray(red.hops) && red.hops.length === 1)
const self = await httpGet(`http://127.0.0.1:${port}/self`)
check('同站重定向仍能正常跟随', self.ok === true && /hello from local/.test(self.text || ''), `hops=${self.hops?.length}`)
srv.close()

// 6. 死通道短路：同一个连不上的降级级，第二次不该再白等
console.log('\n--- dead channel short-circuit ---')
check('markDead/isKnownDead 生效', (() => {
  markDead('https://web.archive.org/x')
  return isKnownDead('https://web.archive.org/y') === true
})())
clearDead()
const bad = 'https://arxiv.org/pdf/9999.99999'
const t1 = Date.now()
const d1 = await fetchDocument(bad)
const ms1 = Date.now() - t1
const t2 = Date.now()
const d2 = await fetchDocument(bad)
const ms2 = Date.now() - t2
const skipped = (d2.tried || []).filter((x) => x.skipped).length
console.log(`first=${ms1}ms tried=${d1.tried?.length}  second=${ms2}ms skipped=${skipped}`)
check('第二次不再重试已确认连不上的通道', skipped > 0)

console.log(`\n===== ${fails === 0 ? 'ALL PASS' : fails + ' FAILED'} =====`)
process.exit(fails === 0 ? 0 : 1)
