"""PyInstaller 启动器：以顶层脚本方式入口，避免入口脚本的相对导入问题。

ugc_image_tool/__main__.py 使用包内相对导入（from .ui import run）；
PyInstaller 会把入口当作独立脚本，相对导入无法解析，导致整个应用包与
PySide6/httpx 依赖不被收集。这里在顶层从包绝对导入，等价于 python -m
ugc_image_tool 的启动语义。
"""

from ugc_image_tool.ui import run

if __name__ == "__main__":
    raise SystemExit(run())
