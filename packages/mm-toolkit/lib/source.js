/**
 * Source-file builders for the two execution tools.
 *
 * Kept in their own module so they can be tested without a DSH context: the
 * wrappers decide whether a run "succeeded", and that decision depends on what
 * these templates do. A pure numeric run must exit 0 without touching
 * matplotlib, so the plotting import is guarded and the auto-save only fires
 * when a figure actually exists.
 *
 * @module dsh-plugin-mm-toolkit/source
 */

/**
 * Build the Python file that viz_python runs.
 *
 * Paths go in through JSON.stringify rather than hand-quoted string literals:
 * a Windows path with a backslash is fine either way, but a path with a quote
 * or a trailing backslash is not.
 * @param {string} outFile - absolute PNG path exposed as OUT.
 * @param {string} code - caller's code, run after the preamble.
 * @returns {string} full script text.
 */
export function pythonSource(outFile, code) {
  const outLiteral = JSON.stringify(outFile ?? '')
  return [
    '# -*- coding: utf-8 -*-',
    'import os, sys',
    "sys.stdout.reconfigure(encoding='utf-8')",
    "sys.stderr.reconfigure(encoding='utf-8')",
    'plt = None',
    'try:',
    '    import matplotlib',
    "    matplotlib.use('Agg')",
    '    import matplotlib.pyplot as plt',
    "    matplotlib.rcParams['font.sans-serif'] = ['Microsoft YaHei','SimHei','DejaVu Sans']",
    "    matplotlib.rcParams['axes.unicode_minus'] = False",
    "    matplotlib.rcParams['figure.dpi'] = 120",
    'except Exception as _mpl_err:',
    "    print('VIZ_WARN: matplotlib 不可用（不影响纯计算）: %s' % _mpl_err, file=sys.stderr)",
    'import numpy as np',
    `OUT = ${outLiteral}`,
    '',
    String(code ?? ''),
    '',
    '# 只有真的画了图才导出；纯计算不产生图片，这是正常情况，不是失败。',
    'if plt is not None:',
    '    try:',
    '        if plt.get_fignums():',
    '            plt.gcf().savefig(OUT, dpi=150, bbox_inches="tight", facecolor="white")',
    '            print("VIZ_SAVED: " + OUT)',
    '    except Exception as e:',
    '        import traceback; traceback.print_exc()',
    '        print("VIZ_SAVE_ERROR: " + str(e), file=sys.stderr)',
    '',
  ].join('\n')
}

/**
 * Build the MATLAB script that viz_matlab runs.
 * @param {string} outFile - absolute PNG path exposed as `out`.
 * @param {string} code - caller's code, run after the preamble.
 * @returns {string} full script text.
 */
export function matlabSource(outFile, code) {
  const outLiteral = String(outFile ?? '').replace(/'/g, "''")
  return [
    "set(0,'DefaultFigureColor','w');",
    "set(0,'DefaultAxesFontName','Microsoft YaHei');",
    `out = '${outLiteral}';`,
    '',
    String(code ?? ''),
    '',
    '% 有图才导出；纯计算不产生图片是正常情况。',
    'try',
    "    f = findall(0,'Type','figure');",
    '    if ~isempty(f)',
    "        exportgraphics(f(1), out, 'Resolution', 150);",
    "        fprintf('VIZ_SAVED: %s\\n', out);",
    '    end',
    'catch e',
    "    fprintf(2, 'VIZ_SAVE_ERROR: %s\\n', e.message);",
    'end',
    '',
  ].join('\n')
}
