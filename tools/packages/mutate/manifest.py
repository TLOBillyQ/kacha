"""mutate4py manifest —— 嵌入目标文件尾部的注释块(mutate4lua --[[ ]] footer 的 Python 对应)。

格式:
# mutate4py-manifest
# version=4
# projectHash=<fnv1a64>
# scope.0.id=<dotted name>
# scope.0.kind=function|method
# scope.0.startLine=N
# scope.0.endLine=N
# scope.0.semanticHash=<fnv1a64>

读取以最后一次出现的 marker 为准(marker 文本出现在更早的注释/字符串中不得截断
源文件);解析不到任何条目视为"无 manifest"。写入走临时文件 + rename,中断不会
截断用户源文件。strip 只折叠 marker 之前的多余换行,不改变文件头(行号不偏移)。
"""

from __future__ import annotations

import os

MARKER = "# mutate4py-manifest"


def _last_marker_index(source: str) -> int | None:
    found = None
    start = 0
    while True:
        index = source.find(MARKER + "\n", start)
        if index == -1:
            return found
        # marker 行必须独占一行(行首)
        if index == 0 or source[index - 1] == "\n":
            found = index
        start = index + 1


def strip(source: str) -> str:
    """去掉 manifest footer;头部字节不变,仅折叠 marker 前多余换行。"""
    index = _last_marker_index(source)
    if index is None:
        return source
    return source[:index].rstrip("\n") + "\n"


def parse_text(text: str) -> dict | None:
    import re

    index = _last_marker_index(text)
    if index is None:
        return None
    data = {"version": None, "project_hash": "", "scopes": []}
    scope_map: dict[int, dict] = {}
    parsed_keys = 0
    for line in text[index + len(MARKER) + 1:].splitlines():
        if not line.startswith("# "):
            continue
        body = line[2:]
        key, sep, value = body.partition("=")
        if not sep:
            continue
        parsed_keys += 1
        if key == "version":
            data["version"] = int(value)
        elif key == "projectHash":
            data["project_hash"] = value
        else:
            match = re.fullmatch(r"scope\.(\d+)\.(.+)", key)
            if not match:
                continue
            index = int(match.group(1))
            entry = scope_map.setdefault(index, {})
            entry[match.group(2)] = value
    if parsed_keys == 0:
        return None
    for index in sorted(scope_map):
        scope = scope_map[index]
        data["scopes"].append({
            "id": scope.get("id", ""),
            "kind": scope.get("kind", "function"),
            "start_line": int(scope.get("startLine", "0")),
            "end_line": int(scope.get("endLine", "0")),
            "semantic_hash": scope.get("semanticHash", ""),
        })
    return data


def read(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as handle:
            return parse_text(handle.read())
    except OSError:
        return None


def serialize(data: dict) -> str:
    lines = [MARKER, f"# version={data.get('version', 4)}",
             f"# projectHash={data.get('project_hash', '')}"]
    for index, scope in enumerate(data.get("scopes", [])):
        key = f"scope.{index}."
        lines.append(f"# {key}id={scope.get('id', '')}")
        lines.append(f"# {key}kind={scope.get('kind', 'function')}")
        lines.append(f"# {key}startLine={scope.get('start_line', 0)}")
        lines.append(f"# {key}endLine={scope.get('end_line', 0)}")
        lines.append(f"# {key}semanticHash={scope.get('semantic_hash', '')}")
    return "\n".join(lines) + "\n"


def write(path, stripped_source: str, data: dict) -> None:
    output = stripped_source.rstrip("\n") + "\n\n" + serialize(data)
    part_path = str(path) + ".part"
    with open(part_path, "w", encoding="utf-8") as handle:
        handle.write(output)
    os.replace(part_path, str(path))
