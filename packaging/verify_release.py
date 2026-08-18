"""发布物验收：无密钥扫描 + SHA-256 校验值核对。

见 packaging/security_scan.py。用法：

    python packaging/verify_release.py <文件或目录>... [--checksums <路径>]

- 对每个输入递归扫描，任何疑似 API 密钥/认证信息都会打印并导致非零退出。
- 若扫描根目录存在 SHA256SUMS，则核对其中相对路径的哈希值；缺失或不一致
  同样导致非零退出。
- 全部通过时退出码为 0。

build_release.py 在产出 zip 后会自动调用本脚本做发布检查。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from security_scan import (
    scan_tree,
    verify_sha256,
)


def _render_path(path: Path) -> str:
    text = str(path)
    try:
        return text.replace("\\", "/")
    except TypeError:  # pragma: no cover
        return text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="verify_release",
        description="无密钥发布检查与 SHA-256 校验值核对",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        default=["release/dist"],
        help="要扫描的文件或目录；默认扫描 release/dist。",
    )
    parser.add_argument(
        "--checksums",
        default=None,
        help="SHA256SUMS 文件路径；默认在每个扫描根目录查找同名文件。",
    )
    args = parser.parse_args(argv)

    failed = False
    checksums_to_verify: dict[Path, Path] = {}
    for raw in args.paths:
        root = Path(raw)
        if not root.exists():
            print(f"[FAIL] 路径不存在：{root}")
            failed = True
            continue
        findings = scan_tree(root)
        if findings:
            failed = True
            for finding in findings:
                print(
                    f"[FAIL] {_render_path(finding.path)}："
                    f"发现疑似 {finding.kind}（偏移 {finding.offset}）… {finding.snippet}"
                )
        else:
            print(f"[OK]   扫描通过：{root}")

        if args.checksums:
            checksums_path = Path(args.checksums)
            checksums_to_verify.setdefault(checksums_path, checksums_path.parent)
        elif root.is_dir() and (root / "SHA256SUMS").is_file():
            checksums_to_verify.setdefault(root / "SHA256SUMS", root)

    for checksums_path, base_dir in checksums_to_verify.items():
        verified, missing, mismatch = verify_sha256(base_dir, checksums_path)
        if missing:
            failed = True
            print(f"[FAIL] {checksums_path}：校验值列表中缺失文件：{', '.join(missing)}")
        if mismatch:
            failed = True
            print(f"[FAIL] {checksums_path}：SHA-256 不一致：{', '.join(mismatch)}")
        if verified:
            print(f"[OK]   SHA-256 核对通过：{checksums_path}")

    print("发布检查通过。" if not failed else "发布检查失败。")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
