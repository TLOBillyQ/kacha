"""「旗舰 | 经济」分段开关：上架档位的展示与选择控件。

未上架的档位隐藏；已上架但当前无法解析（网关未发现该档模型）的档位禁用
并给出原因。控件只表达档位，解析出的模型 ID 由页面在提交时读取。
"""

from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QButtonGroup, QHBoxLayout, QPushButton, QWidget

from ..capabilities import ModelTier

TIER_SWITCH_STYLE = """
QPushButton#tierSegment {
    padding: 4px 18px;
    border: 1px solid #d6d6d6;
    background-color: #fafafa;
}
QPushButton#tierSegment:checked {
    background-color: #1565c0;
    color: white;
    border-color: #1565c0;
    font-weight: bold;
}
QPushButton#tierSegment:disabled {
    color: #9e9e9e;
    background-color: #f0f0f0;
}
"""


@dataclass(frozen=True)
class TierSegment:
    """一个档位分段的展示状态；reason 为禁用原因，model_id 为解析结果。"""

    visible: bool
    enabled: bool
    reason: str | None = None
    model_id: str | None = None


class TierSwitch(QWidget):
    """按档位分段的模型选择开关；只持有展示状态，不感知网关与能力表。"""

    tier_changed = Signal(ModelTier)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._segments: dict[ModelTier, TierSegment] = {}
        self._buttons: dict[ModelTier, QPushButton] = {}
        group = QButtonGroup(self)
        group.setExclusive(True)
        # 独占分组不允许取消所有选中；用隐藏占位按钮承载“无选择”状态。
        self._no_selection = QPushButton()
        self._no_selection.setVisible(False)
        group.addButton(self._no_selection)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        for tier in ModelTier:
            button = QPushButton(tier.label)
            button.setObjectName("tierSegment")
            button.setCheckable(True)
            button.setVisible(False)
            button.setStyleSheet(TIER_SWITCH_STYLE)
            button.clicked.connect(lambda _checked=False, t=tier: self.tier_changed.emit(t))
            group.addButton(button)
            layout.addWidget(button)
            self._buttons[tier] = button
        layout.addStretch(1)

    def apply(self, segments: dict[ModelTier, TierSegment]) -> None:
        """刷新各分段的可见性、可用性与原因；失效的选中档位被取消。"""
        self._segments = dict(segments)
        for tier, button in self._buttons.items():
            segment = segments.get(tier)
            if segment is None or not segment.visible:
                button.setVisible(False)
                if button.isChecked():
                    self._no_selection.setChecked(True)
                continue
            button.setVisible(True)
            button.setEnabled(segment.enabled)
            button.setToolTip(
                segment.reason
                or (f"当前模型：{segment.model_id}" if segment.model_id else "")
            )
            if not segment.enabled and button.isChecked():
                self._no_selection.setChecked(True)

    def select(self, tier: ModelTier | None) -> None:
        """程序化选择档位；不触发 tier_changed。"""
        if tier is None:
            self._no_selection.setChecked(True)
            return
        self._buttons[tier].setChecked(True)

    def current_tier(self) -> ModelTier | None:
        for tier, button in self._buttons.items():
            if button.isChecked() and button.isEnabled():
                return tier
        return None

    def resolved_model_id(self, tier: ModelTier | None) -> str | None:
        """该档位当前解析到的模型 ID；未解析或不可用时返回 None。"""
        if tier is None:
            return None
        segment = self._segments.get(tier)
        if segment is None or not segment.enabled:
            return None
        return segment.model_id
