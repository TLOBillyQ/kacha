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

读取以"最后一个 marker 之后只剩注释/空行"的位置为准:真 footer 总在文件末尾,
所以文档示例或字符串里出现的 marker 文本不会被当成 footer,更不会截断源文件;
解析不到任何条目视为"无 manifest"。写入走临时文件 + rename,中断不会截断用户
源文件。strip 只折叠 marker 之前的多余换行,不改变文件头(行号不偏移)。
"""

from __future__ import annotations

import os
import re

MARKER = "# mutate4py-manifest"

#: marker 行的完整文本;"^" + MULTILINE 保证 marker 独占一行(行首)。
MARKER_LINE = MARKER + "\n"
_MARKER_LINE = re.compile("^" + re.escape(MARKER_LINE), re.MULTILINE)

#: scope 条目键形如 "scope.<序号>.<字段>"
_SCOPE_KEY = re.compile(r"scope\.(\d+)\.(.+)")


def _last_marker_index(source: str) -> int | None:
    """最后一个真 footer marker 的下标;没有 footer 时为 None。

    真 footer 一直延伸到文件末尾且 marker 独占一行,所以文档示例里引用的 marker
    (其后还有代码)不会被当成 footer,源文件也就不会被 strip 截断。
    """
    found = None
    for match in _MARKER_LINE.finditer(source):
        if _is_footer(source, match.start()):
            found = match.start()
    return found


def _footer_body(source: str, index: int) -> str:
    """index 处 marker 行之后的正文(丢掉 marker 行自身)。"""
    return source[index:].partition(MARKER_LINE)[2]


def _is_footer(source: str, index: int) -> bool:
    """footer 正文必须到文件末尾为止只剩注释行与空行。"""
    return all(not line or line.startswith("#")
               for line in _footer_body(source, index).splitlines())


def strip(source: str) -> str:
    """去掉 manifest footer;头部字节不变,仅折叠 marker 前多余换行。"""
    index = _last_marker_index(source)
    if index is None:
        return source
    return source[:index].rstrip("\n") + "\n"


def parse_text(text: str) -> dict | None:
    """解析 marker 之后的 manifest 注释块;一个键都解析不到视为"无 manifest"。"""
    index = _last_marker_index(text)
    if index is None:
        return None
    keys = _assignments(_footer_body(text, index))
    if not keys:
        return None
    return {"version": _version(keys), "project_hash": keys.get("projectHash", ""),
            "scopes": _scope_list(keys)}


def _assignments(text: str) -> dict[str, str]:
    """收集 "# key=value" 注释行;其余行(含非注释)一律忽略,后出现的覆盖先出现的。"""
    entries = {}
    for line in text.splitlines():
        if line.startswith("# ") and "=" in line[2:]:
            key, _sep, value = line[2:].partition("=")
            entries[key] = value
    return entries


def _version(keys: dict) -> int | None:
    raw = keys.get("version")
    return None if raw is None else int(raw)


def _scope_list(keys: dict) -> list[dict]:
    """按 scope 序号聚合字段,序号升序输出。"""
    grouped: dict[int, dict] = {}
    for key, value in keys.items():
        match = _SCOPE_KEY.fullmatch(key)
        if match:
            grouped.setdefault(int(match.group(1)), {})[match.group(2)] = value
    return [_scope_entry(grouped[index]) for index in sorted(grouped)]


def _scope_entry(fields: dict) -> dict:
    return {"id": fields.get("id", ""),
            "kind": fields.get("kind", "function"),
            "start_line": int(fields.get("startLine", "0")),
            "end_line": int(fields.get("endLine", "0")),
            "semantic_hash": fields.get("semanticHash", "")}


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

# mutate4py-manifest
# version=4
# projectHash=bff7297d8491ac19
# scope.0.id=manifest._last_marker_index
# scope.0.kind=function
# scope.0.startLine=34
# scope.0.endLine=44
# scope.0.semanticHash=52269e128b1b2fd9
# scope.1.id=manifest._footer_body
# scope.1.kind=function
# scope.1.startLine=47
# scope.1.endLine=49
# scope.1.semanticHash=e943300cb372a1c7
# scope.2.id=manifest._is_footer
# scope.2.kind=function
# scope.2.startLine=52
# scope.2.endLine=55
# scope.2.semanticHash=e7098d06d25fb386
# scope.3.id=manifest.strip
# scope.3.kind=function
# scope.3.startLine=58
# scope.3.endLine=63
# scope.3.semanticHash=d127dd6678a7d1f9
# scope.4.id=manifest.parse_text
# scope.4.kind=function
# scope.4.startLine=66
# scope.4.endLine=75
# scope.4.semanticHash=227dd7395568b742
# scope.5.id=manifest._assignments
# scope.5.kind=function
# scope.5.startLine=78
# scope.5.endLine=85
# scope.5.semanticHash=8487b014ef2581af
# scope.6.id=manifest._version
# scope.6.kind=function
# scope.6.startLine=88
# scope.6.endLine=90
# scope.6.semanticHash=884ab24069e34c23
# scope.7.id=manifest._scope_list
# scope.7.kind=function
# scope.7.startLine=93
# scope.7.endLine=100
# scope.7.semanticHash=b7a7af2c80fb3579
# scope.8.id=manifest._scope_entry
# scope.8.kind=function
# scope.8.startLine=103
# scope.8.endLine=108
# scope.8.semanticHash=d1286b5e5c2a542d
# scope.9.id=manifest.read
# scope.9.kind=function
# scope.9.startLine=111
# scope.9.endLine=116
# scope.9.semanticHash=3b6531b38303203a
# scope.10.id=manifest.serialize
# scope.10.kind=function
# scope.10.startLine=119
# scope.10.endLine=129
# scope.10.semanticHash=9e58c9006d1ef6ff
# scope.11.id=manifest.write
# scope.11.kind=function
# scope.11.startLine=132
# scope.11.endLine=137
# scope.11.semanticHash=e2170bf7034e1cd2
