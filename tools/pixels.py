# -*- coding: utf-8 -*-
"""把 PDF 指定页渲染成原始 RGB 数据（供 Node 测试做逐像素比对）。

用法：
    python pixels.py <输入.pdf> <输出前缀> [dpi]

对第 1..N 页分别写出 <输出前缀>.p<i>.raw，文件头 12 字节为
magic(b"DSHPIX1\0") + uint32 宽 + uint32 高，其后是 RGB 原始像素。
"""
from __future__ import annotations

import struct
import sys

import fitz

MAGIC = b"DSHPIX1\0"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    pdf, prefix = sys.argv[1], sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    doc = fitz.open(pdf)
    for i in range(doc.page_count):
        pix = doc[i].get_pixmap(dpi=dpi, colorspace=fitz.csRGB)
        path = f"{prefix}.p{i + 1}.raw"
        with open(path, "wb") as f:
            f.write(MAGIC)
            f.write(struct.pack("<II", pix.width, pix.height))
            f.write(pix.samples)
        print(f"{path} {pix.width}x{pix.height} {len(pix.samples)}")
    doc.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
