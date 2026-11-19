#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""判定器：把「脚本产生了什么」和「这算不算通过」分成两次不同的执行。

为什么要有这个文件，而不是让脚本自己 print("PASS")：

    如果判定由被测脚本自己给出，那么它写的不是证据，是结论。一个能算数的
    脚本可以诚实地算出 0，也可以在末尾补一句 print("PASS")。两者在返回值里
    长得一样，而这一层之差就是全部差别。

所以约定是：**脚本只负责产生数据，判定由本文件按事先声明的规则做。**
脚本 print 的每一行必须是一个 JSON 对象；本文件按 `expect` 决定它算不算通过。
脚本碰不到 `pass` 这个字段，因为它在另一个进程里，而且这个进程才写结论。

用法：judge.py <spec.json>
spec = { "stdout_path": "...", "expect": { "kind": "...", ... } }
"""

import json
import sys

# 判定表达式里允许用的东西。刻意不给 open / __import__ / eval：
# predicate 是控制方写的规则，不该有能力做别的事。
SAFE_BUILTINS = {
    "__builtins__": {},
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
}

MAX_ROWS = 2_000_000
MAX_REPORTED_FAILURES = 5


def load_rows(path):
    """Read the script's stdout as JSON rows.

    Lines starting with '#' are treated as comments so a script may label its
    own output; every other non-empty line must parse. A malformed line is an
    error rather than something silently skipped, because skipping it would
    turn "the script printed garbage" into "the claim holds".
    """
    rows = []
    bad = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for lineno, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if len(rows) >= MAX_ROWS:
                return rows, [{"line": lineno, "reason": "rows_exceeded_limit", "detail": f">{MAX_ROWS}"}]
            try:
                value = json.loads(line)
            except Exception:
                bad.append({"line": lineno, "reason": "not_json", "detail": line[:200]})
                continue
            if not isinstance(value, dict):
                bad.append({"line": lineno, "reason": "not_object", "detail": line[:200]})
                continue
            rows.append(value)
    return rows, bad


def eval_predicate(expr, row):
    """Evaluate one predicate against one row. Returns (ok, error_message)."""
    try:
        return bool(eval(expr, dict(SAFE_BUILTINS), dict(row))), None
    except Exception as exc:  # noqa: BLE001 - the message is the diagnosis
        return False, f"{type(exc).__name__}: {exc}"


def _mutant_rounds(row):
    """给出几组"整行一起变"的候选值。

    单组变异不够：`v > 0` 这种谓词在 `v*3+7` 下仍成立（正数还是正数），
    会被误报成"恒真"。所以给三组——归零、取负、放大——任一组能让结论翻转
    就算这个 predicate 对数据敏感。

    为什么要"整行一起变"而不是逐字段变：逐字段组合会指数爆炸，
    而这里只需要回答一个是非题——"换个数据它还会不会给同一个答案"。
    """
    rounds = []
    for mode in ("zero", "negate", "scale"):
        m = {}
        for k, v in row.items():
            if isinstance(v, bool):
                m[k] = (not v) if mode == "zero" else v
            elif isinstance(v, (int, float)):
                if mode == "zero":
                    m[k] = 0
                elif mode == "negate":
                    m[k] = -abs(v) - 1
                else:
                    m[k] = v * 3 + 7
            elif isinstance(v, str):
                m[k] = "" if mode == "zero" else v + "__mut"
            else:
                m[k] = v
        rounds.append(m)
    return rounds


def mutation_sensitivity(expr, rows, limit=50):
    """把每行数据扰动后重判，数有多少行因此翻转。

    治的是"判据本身是恒真式"（P0-4）：predicate 写成 `True`、`x == x`
    或任何不引用行内数据的表达式时，脚本只要不崩，判定必然通过——PASS 的信息量为零，
    而报告里它和一条真判定长得一模一样。

    返回翻转的行数。0 且 rows 非空 => 这个 predicate 对数据不敏感。
    """
    flips = 0
    for row in rows[:limit]:
        ok_orig, _ = eval_predicate(expr, row)
        for mutated in _mutant_rounds(row):
            ok_mut, _ = eval_predicate(expr, mutated)
            if ok_orig != ok_mut:
                flips += 1
                break
    return flips


def main():
    spec_path = sys.argv[1]
    with open(spec_path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)

    expect = spec.get("expect") or {}
    kind = str(expect.get("kind") or "all")
    rows, bad = load_rows(spec["stdout_path"])

    result = {
        "pass": False,
        "kind": kind,
        "rows": len(rows),
        "expected": expect.get("predicate") or expect.get("value"),
        "failures": [],
        "note": "",
    }

    if bad:
        result["failures"] = bad[:MAX_REPORTED_FAILURES]
        result["note"] = f"{len(bad)} 行不是合法 JSON 对象；判定不能建立在不干净的数据上"
        return print(json.dumps(result, ensure_ascii=False))

    if kind in ("all", "any", "none"):
        predicate = str(expect.get("predicate") or "")
        if not predicate:
            result["note"] = "kind 需要 predicate"
            return print(json.dumps(result, ensure_ascii=False))
        hits = []
        misses = []
        for index, row in enumerate(rows):
            ok, err = eval_predicate(predicate, row)
            if ok:
                hits.append(index)
            else:
                misses.append({"index": index, "row": row, "reason": err or "predicate_false"})
        result["sensitivity"] = mutation_sensitivity(predicate, rows)
        if rows and result["sensitivity"] == 0:
            result["note"] = (
                "判定表达式对数据不敏感：把所有数值扰动成 3v+7、布尔取反之后，"
                "没有一行翻转。这条 PASS 不携带信息——它测的是 predicate 的形状，不是数据。"
            )
        if kind == "all":
            result["pass"] = len(rows) > 0 and len(misses) == 0
            result["failures"] = misses[:MAX_REPORTED_FAILURES]
            result["checked"] = len(rows)
            if not rows:
                result["note"] = "没有任何数据行：空集上的 all 是真空成立，不能算通过"
        elif kind == "any":
            result["pass"] = len(hits) > 0
            result["hits"] = len(hits)
            if not hits:
                result["note"] = "没有任何一行满足条件"
        else:  # none
            # 空集上的 none 同样是真空成立：一行都没扫，不能宣称"没有反例"。
            # 这条和 all 的空集陷阱对称，漏掉它就会把"没搜到"写成"不存在"。
            result["pass"] = len(rows) > 0 and len(misses) == 0
            result["failures"] = misses[:MAX_REPORTED_FAILURES]
            result["checked"] = len(rows)
            if not rows:
                result["note"] = "没有任何数据行：没扫到不等于不存在"
        return print(json.dumps(result, ensure_ascii=False))

    if kind == "count":
        # value 从工具参数来，而工具参数 schema 里它是字符串；这里必须转成整数再比，
        # 否则 `1 == "1"` 恒为假，count 永远不会通过。
        raw = expect.get("value")
        try:
            want = int(str(raw).strip())
        except Exception:
            result["note"] = f"count 的 value 不是整数：{raw!r}"
            return print(json.dumps(result, ensure_ascii=False))
        result["pass"] = len(rows) == want
        result["expected"] = want
        result["observed_count"] = len(rows)
        if not result["pass"]:
            result["note"] = f"行数 {len(rows)} != 期望 {want}"
        return print(json.dumps(result, ensure_ascii=False))

    if kind == "equals":
        want = str(expect.get("value"))
        got = "\n".join(json.dumps(r, ensure_ascii=False, sort_keys=True) for r in rows)
        result["pass"] = got == want
        result["observed"] = got[:500]
        if not result["pass"]:
            result["note"] = "整体输出与期望值不等"
        return print(json.dumps(result, ensure_ascii=False))

    result["note"] = f"未知的 kind：{kind}"
    return print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
