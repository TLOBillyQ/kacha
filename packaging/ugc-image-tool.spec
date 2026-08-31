# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 规格：UGC AI 生图工具 Windows x64 便携目录（onedir）。

构建流程由 build_release.py 驱动；版本号从环境变量 UGC_IMAGE_TOOL_VERSION
注入（未设置时回退到 0.1.0），并用于压缩包命名与 build-info.json 记录。
注意：当前 PyInstaller 6.22 在本环境写入的版本资源会被 Windows 读取为
损坏，因此不向 EXE() 注入版本资源；发布验收不依赖 exe 文件版本资源。

正式发布只允许目录模式（onedir）：
- 目录模式产出以本规格命名的目录（ugc-image-tool），build_release.py 再按
  版本号重命名并压缩。
- 应用不写程序目录，用户数据始终位于用户数据目录与图片目录，覆盖升级安全。

入口使用 packaging/launcher.py 顶层脚本从包绝对导入，确保分析阶段能跟随
整个 ugc_image_tool 包及其第三方依赖。界面中文名称由窗口标题承担。

版本号通过环境变量 UGC_IMAGE_TOOL_VERSION 注入（未设置时回退到
0.1.0）。注意：当前 PyInstaller 6.22 内置的版本资源写入（VS_VERSION_INFO）
在本环境生成的资源会被 Windows 读取为损坏，因此不向 EXE() 注入版本资源，
版本与提交信息记录在 build-info.json——发布验收不依赖 exe 文件版本资源，
而是依赖代码签名与 SHA-256 校验值。
"""

import os
import sys
from pathlib import Path


SPEC_DIR = Path(SPECPATH).resolve()  # packaging/
ROOT = SPEC_DIR.parent  # 仓库根

# keyring 通过 entry points 动态加载后端，PyInstaller 静态分析抓不到，
# 必须复制包元数据并显式收集后端子模块，否则 macOS 构建运行时找不到钥匙串后端。
if sys.platform == "darwin":
    from PyInstaller.utils.hooks import collect_submodules, copy_metadata

    extra_datas = copy_metadata("keyring")
    extra_hiddenimports = collect_submodules("keyring.backends")
else:
    extra_datas = []
    extra_hiddenimports = []


a = Analysis(
    [str(SPEC_DIR / "launcher.py")],
    pathex=[str(ROOT / "src")],
    binaries=[],
    datas=extra_datas,
    hiddenimports=extra_hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ugc-image-tool",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
    version=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ugc-image-tool",
)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="ugc-image-tool.app",
        icon=None,
        bundle_identifier="com.swarmforge.ugc-image-tool",
        version=os.environ.get("UGC_IMAGE_TOOL_VERSION", "0.1.0"),
    )
