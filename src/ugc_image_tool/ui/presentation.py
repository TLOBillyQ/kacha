"""界面共用的中文文案与格式化工具。"""

from __future__ import annotations

from typing import Any

from ..discovery import ConnectionStage
from ..generation import GenerationStatus, SizeMode

STATUS_LABELS = {
    GenerationStatus.QUEUED: "排队中",
    GenerationStatus.RUNNING: "生成中",
    GenerationStatus.SUCCEEDED: "成功",
    GenerationStatus.PARTIALLY_SUCCEEDED: "部分成功",
    GenerationStatus.FAILED: "失败",
    GenerationStatus.UNKNOWN: "结果未知",
    GenerationStatus.CANCELLED: "已取消",
}

CUSTOM_SIZE_LABEL = "自定义…"

UI_SPACING = 8
UI_CARD_MARGIN = 10
UI_TEXT_MUTED = "#616161"
UI_BORDER = "#d6d6d6"
UI_ERROR = "#c62828"
UI_SUCCESS = "#2e7d32"
UI_WARNING = "#f9a825"
SUBMIT_BUTTON_STYLE = """
QPushButton#submit {
    background-color: #1565c0;
    color: white;
    font-weight: bold;
    padding: 6px 16px;
    border-radius: 4px;
}
QPushButton#submit:hover { background-color: #1976d2; }
QPushButton#submit:disabled { background-color: #90a4ae; }
"""

STAGE_LABELS = {
    ConnectionStage.DNS_OR_CONNECT: "DNS/连接",
    ConnectionStage.AUTH: "鉴权",
    ConnectionStage.MODEL_LIST: "模型列表",
    ConnectionStage.CAPABILITY: "能力匹配",
}


def combo_size_mode(data: Any) -> SizeMode:
    """读取尺寸下拉框数据中的模式；无选择时按模型自动决定。"""
    return data[0] if data is not None else SizeMode.AUTO


def combo_preset_size(data: Any) -> tuple[int, int] | None:
    """读取尺寸下拉框数据中的常用预设宽高；非预设模式返回 None。"""
    if data is None or data[0] is not SizeMode.PRESET:
        return None
    return data[1]


def connection_check_mark(ok: bool | None) -> str:
    """连接检查单阶段结果的用户可见标记。"""
    if ok is True:
        return "通过"
    if ok is False:
        return "失败"
    return "跳过"


def format_bytes(size: int) -> str:
    """把字节数格式化为可读文本；日志容量通常不超过 1 MB。"""
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size} B"
