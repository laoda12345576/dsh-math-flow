// 读任意编码的文本文件，输出 UTF-8。
//
// 为什么需要它：Windows 上 shell 的 `>` 重定向写出的是 UTF-16LE（带 BOM FF FE）。
// team5 那一轮 refute-1 用这种方式写证据，`r_refute.out.txt` 于是成了一片乱码——
// 队长全程只提过它一次，就是临死前那句"仍在跑"，它没读、也读不了。
// 证据文件读不了，等于没交。
//
// 用法：
//   node tools/read-any.mjs <file>            整份输出
//   node tools/read-any.mjs <file> -n 40      前 40 行
//   node tools/read-any.mjs <file> --tail 40  后 40 行
//   node tools/read-any.mjs <file> --info     只报编码与统计，不输出正文

import fs from 'node:fs'

const argv = process.argv.slice(2)
const file = argv.find(a => !a.startsWith('-'))
if (!file) {
  console.error('用法: node tools/read-any.mjs <file> [-n 行数 | --tail 行数 | --info]')
  process.exit(2)
}
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 ? Number(argv[i + 1]) : fallback
}

const buf = fs.readFileSync(file)

/**
 * 判定编码。顺序很重要：BOM 优先，然后按 NUL 字节的分布猜 UTF-16，
 * 最后才当 UTF-8 —— 因为 UTF-16 的中文在 UTF-8 视角下也是"合法字节"，
 * 先试 UTF-8 会把乱码当成功。
 */
function decode(b) {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: b.subarray(2).toString('utf16le'), enc: 'utf-16le' }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    // UTF-16BE 在 Node 里没有现成解码器，换字节序后按 LE 解。
    const swapped = Buffer.from(b.subarray(2))
    swapped.swap16()
    return { text: swapped.toString('utf16le'), enc: 'utf-16be' }
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: b.subarray(3).toString('utf8'), enc: 'utf-8 bom' }

  // 没有 BOM：看 NUL 落在奇数位还是偶数位。ASCII 文本逐字节存成 UTF-16LE 时，
  // 高位字节全是 0，于是偶数位（或奇数位）几乎全是 NUL。
  const probe = b.subarray(0, Math.min(b.length, 4096))
  let evenNul = 0
  let oddNul = 0
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] !== 0) continue
    if (i % 2 === 0) evenNul++
    else oddNul++
  }
  const half = probe.length / 2
  if (oddNul > half * 0.3 && evenNul < half * 0.05) return { text: b.toString('utf16le'), enc: 'utf-16le（无 BOM）' }
  if (evenNul > half * 0.3 && oddNul < half * 0.05) {
    const swapped = Buffer.from(b)
    swapped.swap16()
    return { text: swapped.toString('utf16le'), enc: 'utf-16be（无 BOM）' }
  }
  return { text: b.toString('utf8'), enc: 'utf-8' }
}

const { text, enc } = decode(buf)
const bad = (text.match(/\uFFFD/g) ?? []).length
const lines = text.split(/\r?\n/)

if (argv.includes('--info')) {
  console.log(`文件    ${file}`)
  console.log(`大小    ${buf.length} 字节`)
  console.log(`编码    ${enc}`)
  console.log(`行数    ${lines.length}`)
  console.log(`乱码字符 ${bad}${bad ? '  ← 解错了，别按 utf-8 硬读' : ''}`)
  process.exit(0)
}

const head = flag('-n', null)
const tail = flag('--tail', null)
const out = head ? lines.slice(0, head) : tail ? lines.slice(-tail) : lines
if (bad > 0) process.stderr.write(`注意：解出 ${bad} 个替换字符，可能是混合编码或非文本文件\n`)
process.stdout.write(out.join('\n'))
if (!out.length || out[out.length - 1] !== '') process.stdout.write('\n')
