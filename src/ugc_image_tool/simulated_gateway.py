from __future__ import annotations

import base64
import time

from .generation import GeneratedImage, TextToImageRequest


_PREVIEW_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78"
    "AAAAVElEQVR4nO3PQQ0AIBDAsAP/nuGNAvZoFSzZOjNnyNi1dwfgUQCeBeBZAB4F4FkAHgXg"
    "WQAeBeBZAB4F4FkAHgXgWQAeBeBZAB4F4FkAHgXgWQAeBeBZAB4F4F0Bvs8BfK4vA10AAAAA"
    "SUVORK5CYII="
)


class SimulatedGateway:
    """模拟网关：返回占位图片，配合能力驱动界面完成本地任务闭环。"""

    # 与脱敏契约夹具中的网关模型列表保持一致。
    AVAILABLE_MODELS = ("qwen-image-3.0-pro", "wan2.7-image", "z-image-turbo")

    def __init__(self, delay_seconds: float = 0.6) -> None:
        self._delay_seconds = delay_seconds

    def list_models(self) -> tuple[str, ...]:
        return self.AVAILABLE_MODELS

    def generate_text(self, request: TextToImageRequest) -> GeneratedImage:
        time.sleep(self._delay_seconds)
        return GeneratedImage(content=_PREVIEW_PNG, media_type="image/png")
