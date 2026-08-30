"""工具包共享小工具:项目解释器解析与函数作用域提取。"""

from __future__ import annotations

import ast
import os
import sys


def project_python(repo_root: str) -> str:
    """优先取仓库 .venv/bin/python,否则当前解释器。"""
    venv_python = os.path.join(repo_root, ".venv", "bin", "python")
    if os.path.isfile(venv_python) and os.access(venv_python, os.X_OK):
        return venv_python
    return sys.executable


def functions_from_source(source: str) -> list[tuple[str, str, ast.FunctionDef]]:
    """返回 [(name, kind, node)],kind 为 function | method;含模块级函数与类方法。"""
    tree = ast.parse(source)
    found: list[tuple[str, str, ast.FunctionDef]] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found.append((node.name, "function", node))
        elif isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    found.append((item.name, "method", item))
    return found
