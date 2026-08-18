"""发布物安全性检查测试（issue #13 无密钥发布验收）。

验证 packaging/security_scan.py 能发现泄漏、放行脱敏占位符，并核对
SHA-256；再通过 packaging/verify_release.py CLI 验证干净目录通过、含
泄漏目录失败。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGING_DIR = REPO_ROOT / "packaging"
sys.path.insert(0, str(PACKAGING_DIR))

from security_scan import (  # noqa: E402
    sha256_of,
    scan_bytes,
    scan_directory,
    scan_tree,
    verify_sha256,
)

SK_KEY = "sk-PROD-REAL-SECRET-KEY-0123456789ABCDEF"
BEARER_TOKEN = "PROD-REAL-BEARER-TOKEN-9876543210"
API_KEY_VALUE = "PROD-REAL-API-KEY-VALUE-1234567890"


def test_detects_sk_api_key() -> None:
    findings = scan_bytes(f"误存密钥：{SK_KEY}".encode("utf-8"))
    assert any("sk-" in finding.kind for finding in findings)


def test_detects_authorization_bearer() -> None:
    findings = scan_bytes(f"Authorization: Bearer {BEARER_TOKEN}".encode("utf-8"))
    kinds = {finding.kind for finding in findings}
    assert "Bearer 令牌" in kinds
    # 直接放在认证头里的长令牌由“认证头”规则捕获。
    direct = scan_bytes(f"Authorization: {BEARER_TOKEN}".encode("utf-8"))
    assert "认证头" in {finding.kind for finding in direct}


def test_detects_api_key_assignment() -> None:
    findings = scan_bytes(f"api_key={API_KEY_VALUE}".encode("utf-8"))
    assert any("API 密钥" in finding.kind for finding in findings)
    assert any("API 密钥" in finding.kind for finding in
               scan_bytes(f"X-Api-Key: {API_KEY_VALUE}".encode("utf-8")))


def test_ignores_redacted_placeholders() -> None:
    for text in ("[REDACTED]", "[REDACTED_URL]"):
        assert not scan_bytes(
            f"Authorization: {text}; Bearer {text}".encode("utf-8")
        ), text


def test_ignores_plain_text_and_short_values() -> None:
    assert not scan_bytes("普通文本，不含密钥".encode("utf-8"))
    assert not scan_bytes(b"api_key=short")  # 值过短，不算密钥
    assert not scan_bytes(b"Authorization: Bearer")  # 无令牌内容


def test_scan_directory_is_recursive() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        nested = root / "a" / "b"
        nested.mkdir(parents=True)
        nested.joinpath("leak.txt").write_text(
            f"token {SK_KEY}", encoding="utf-8"
        )
        root.joinpath("clean.txt").write_text("clean", encoding="utf-8")
        findings = scan_directory(root)
        assert len(findings) == 1
        assert findings[0].path == nested / "leak.txt"
        assert scan_tree(root, nested / "clean.txt") == findings


def read_clean_tree(root: Path, name: str = "config") -> Path:
    target = root / name
    target.write_text("普通配置，不含密钥", encoding="utf-8")
    return target


def write_checksums(root: Path, *files: Path) -> Path:
    lines = [f"{sha256_of(path)}  {path.name}" for path in files]
    checksums = root / "SHA256SUMS"
    checksums.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return checksums


def test_verify_sha256_matches() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        target = read_clean_tree(root)
        checksums = write_checksums(root, target)
        verified, missing, mismatch = verify_sha256(root, checksums)
        assert verified
        assert not missing and not mismatch


def test_verify_sha256_reports_mismatch() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        target = read_clean_tree(root)
        checksums = write_checksums(root, target)
        target.write_text("变了内容", encoding="utf-8")
        verified, missing, mismatch = verify_sha256(root, checksums)
        assert not verified
        assert mismatch == ["config"]


def _run_verify(*paths: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(PACKAGING_DIR / "verify_release.py"),
            *(str(path) for path in paths),
        ],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )


def test_verify_cli_accepts_clean_tree() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        target = read_clean_tree(root)
        write_checksums(root, target)
        result = _run_verify(root)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "发布检查通过" in result.stdout


def test_verify_cli_rejects_leaked_file() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        target = read_clean_tree(root)
        write_checksums(root, target)
        root.joinpath("log.txt").write_text(
            f"Bearer {BEARER_TOKEN}", encoding="utf-8"
        )
        result = _run_verify(root)
        assert result.returncode != 0
        assert "发布检查失败" in result.stdout
        assert "Bearer 令牌" in result.stdout
