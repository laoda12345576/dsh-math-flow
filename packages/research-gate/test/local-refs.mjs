// P1-6：读本地 refs/*.txt 也算读文献（按文件去重）。
//
// 这条测试存在的理由：这个判定曾经只数 paper_* / cnki / zotero 的调用次数，
// 于是模型用 read 把 refs 全文翻了一遍却被记为"没读"，只好补三次 paper_* 走过闸。
// 门禁过了，读的量没变。数"调了哪个工具"和"读没读"不是一回事。
import { localRefPath } from '../lib/gate.js'

let failed = 0
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed += 1
    console.log(`  FAIL ${name}${extra ? `  (${extra})` : ''}`)
  }
}

const N = '\\' // 单个反斜杠，避免 shell/heredoc 转义把测试输入搞坏

ok(localRefPath('read', { path: 'D:/p/refs/a.txt' }) === 'D:/p/refs/a.txt', '正斜杠路径能识别')
ok(
  localRefPath('read_file', { path: `D:${N}p${N}refs${N}a.txt` }) === 'D:/p/refs/a.txt',
  '反斜杠路径归一化后与正斜杠同一份（去重才有意义）',
  localRefPath('read_file', { path: `D:${N}p${N}refs${N}a.txt` }),
)
ok(localRefPath('read', { file_path: '/home/u/proj/refs/b.md' }) === '/home/u/proj/refs/b.md', 'file_path 字段也认')
ok(localRefPath('read', { path: 'D:/p/src/a.js' }) === null, '不在 refs/ 下的读不算')
ok(localRefPath('read', { path: 'D:/p/refsX/a.txt' }) === null, 'refsX/ 不是 refs/')
ok(localRefPath('paper_search', { path: 'D:/p/refs/a.txt' }) === null, '不是读文件类工具就不算')
ok(localRefPath('grep', { path: 'D:/p/refs/a.txt' }) === null, 'grep 不算读')
ok(localRefPath('read', {}) === null, '没有路径不算')

console.log(failed === 0 ? '\nlocal-refs: ok' : `\nlocal-refs: ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
