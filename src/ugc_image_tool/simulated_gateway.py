from __future__ import annotations

import base64
import time

from .generation import GeneratedImage


_PREVIEW_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78"
    "AAAAVElEQVR4nO3PQQ0AIBDAsAP/nuGNAvZoFSzZOjNnyNi1dwfgUQCeBeBZAB4F4FkAHgXg"
    "WQAeBeBZAB4F4FkAHgXgWQAeBeBZAB4F4FkAHgXgWQAeBeBZAB4F4F0Bvs8BfK4vA10AAAAA"
    "SUVORK5CYII="
)


class SimulatedGateway:
    def __init__(self, delay_seconds: float = 0.6) -> None:
        self._delay_seconds = delay_seconds

    def generate_text(self, prompt: str) -> GeneratedImage:
        time.sleep(self._delay_seconds)
        return GeneratedImage(content=_PREVIEW_PNG, media_type="image/png")
