# -*- coding: utf-8 -*-
"""对任意两份 PDF 做「渲染 + 文本层」等价性校验（用于验证 GC 没有破坏文件）。

用法：
    python tools/compare_pdfs.py a.pdf b.pdf [dpi]

退出码 0 表示：逐像素差异均为抗锯齿噪声，且提取到的文字完全一致。
注意：coding 声明必须在文件首行/次行（不能写在 docstring 之后），
否则 Windows 下 Python 会按 GBK 解码源码而报 SyntaxError。
"""
from __future__ import annotations

import sys

import fitz

MAX_DIFF = 40


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    a_path, b_path = sys.argv[1], sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150

    a, b = fitz.open(a_path), fitz.open(b_path)
    ok = True
    if a.page_count != b.page_count:
        print(f"FAIL 页数不同: {a.page_count} vs {b.page_count}")
        return 1

    for i in range(a.page_count):
        pa, pb = a[i], b[i]
        pm_a = pa.get_pixmap(dpi=dpi, colorspace=fitz.csRGB)
        pm_b = pb.get_pixmap(dpi=dpi, colorspace=fitz.csRGB)
        if (pm_a.width, pm_a.height) != (pm_b.width, pm_b.height):
            print(f"FAIL 第 {i + 1} 页渲染尺寸不同")
            ok = False
            continue
        sa, sb = pm_a.samples, pm_b.samples
        maxd = 0
        over = 0
        diff = 0
        for x, y in zip(sa, sb):
            d = abs(x - y)
            if d:
                diff += 1
                if d > maxd:
                    maxd = d
                if d > MAX_DIFF:
                    over += 1
        ta = pa.get_text("text")
        tb = pb.get_text("text")
        same_text = ta == tb
        status = "OK" if (over == 0 and same_text) else "FAIL"
        if status == "FAIL":
            ok = False
        print(
            f"{status} 第 {i + 1} 页: 像素差异 {diff}/{len(sa)} 最大差值={maxd} 超阈值像素={over} "
            f"文字一致={same_text} (字符数 {len(ta)} vs {len(tb)})"
        )

    a.close()
    b.close()
    print("结果:", "全部一致" if ok else "存在差异")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
