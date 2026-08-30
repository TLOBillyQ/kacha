"""mutate4py —— 单文件变异测试引擎(mutate4lua/mutate4java 的 Python 移植)。

对齐不变量:
- 退出码 0 成功 / 1 用法错误 / 2 baseline 失败 / 3 存在存活 mutant
- manifest 以注释块形式嵌入目标文件尾部
- 差异化选择:无 manifest -> 全部已覆盖位点;模块 hash 未变 -> 0 个位点;
  hash 变化 -> 仅变动的 scope;manifest 仅在干净运行后写入
- 变异集合:布尔翻转、比较/算术运算符交换、and <-> or、一元 not/- 移除、
  0 <-> 1、赋值右值 -> None
- scope 身份以声明为基准(模块级函数与类方法);worker 操作模块副本,
  原始文件永不在原地变异;超时视为已击杀
- 测试经项目 pytest 运行(内置构建工具调用的 Python 对应);
  --test-command 为逃生舱(同时禁用覆盖率过滤)
- scope 语义哈希 = 归一化 AST 序列化的 FNV-1a(格式无关)
"""

from __future__ import annotations

import ast
import dataclasses
import os

from ..astnorm import fnv1a64, normalize_node
from . import manifest

_SWAP_COMPARE = {ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.Lt: ast.Gt,
                 ast.Gt: ast.Lt, ast.LtE: ast.GtE, ast.GtE: ast.LtE,
                 ast.Is: ast.IsNot, ast.IsNot: ast.Is, ast.In: ast.NotIn,
                 ast.NotIn: ast.In}
_SWAP_BINOP = {ast.Add: ast.Sub, ast.Sub: ast.Add, ast.Mult: ast.Div,
               ast.Div: ast.Mult}

_IGNORED_SEGMENTS = ("/.git/", "/.swarmforge/", "/.worktrees/", "/.venv/",
                     "/__pycache__/", "/.toolcache/", "/.mutate4py/", "/tmp/")


@dataclasses.dataclass
class Scope:
    id: str
    kind: str  # function | method
    start_line: int
    end_line: int
    semantic_hash: str
    node: ast.FunctionDef


@dataclasses.dataclass
class Site:
    scope_id: str
    line: int
    description: str
    kind: str
    path: tuple  # ((field, index), ...) 相对模块根
    meta: dict

    def apply(self, tree: ast.Module) -> None:
        parent, field, index, node = _resolve(tree, self.path)
        if self.kind == "bool-flip":
            node.value = not node.value
        elif self.kind == "int-swap":
            node.value = 1 - node.value
        elif self.kind == "compare-swap":
            node.ops[self.meta["index"]] = _SWAP_COMPARE[type(node.ops[self.meta["index"]])]()
        elif self.kind == "binop-swap":
            node.op = _SWAP_BINOP[type(node.op)]()
        elif self.kind == "boolop-swap":
            node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()
        elif self.kind == "unary-remove":
            _assign(parent, field, index, node.operand)
        elif self.kind == "rhs-none":
            _assign(parent, field, index, ast.Constant(value=None))
        else:  # pragma: no cover - unknown kind is a programming error
            raise ValueError(f"unknown site kind: {self.kind}")

    def mutated_source(self, source: str) -> str:
        stripped = manifest.strip(source)
        tree = ast.parse(stripped)
        self.apply(tree)
        return ast.unparse(tree) + "\n"


def _assign(parent, field, index, value) -> None:
    if index is None:
        setattr(parent, field, value)
    else:
        getattr(parent, field)[index] = value


def _resolve(tree, path: tuple):
    """path 的最后一个元素指向目标节点;返回 (parent, field, index, node)。"""
    node = tree
    if not path:
        return None, None, None, node
    for field, index in path[:-1]:
        value = getattr(node, field)
        node = value[index] if index is not None else value
    field, index = path[-1]
    value = getattr(node, field)
    target = value[index] if index is not None else value
    return node, field, index, target


def _collect_scopes(tree: ast.Module, module_name: str
                    ) -> list[tuple[Scope, ast.FunctionDef, tuple]]:
    """返回 (scope, node, 从模块根到该节点的 path)。"""
    found: list[tuple[Scope, ast.FunctionDef, tuple]] = []
    for index, node in enumerate(tree.body):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found.append((_make_scope(node, module_name + "." + node.name,
                                      "function"), node, (("body", index),)))
        elif isinstance(node, ast.ClassDef):
            for inner, item in enumerate(node.body):
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    found.append((_make_scope(
                        item, f"{module_name}.{node.name}.{item.name}",
                        "method"), item, (("body", index), ("body", inner))))
    return found


def _make_scope(node: ast.FunctionDef, scope_id: str, kind: str) -> Scope:
    return Scope(id=scope_id, kind=kind, start_line=node.lineno,
                 end_line=getattr(node, "end_lineno", node.lineno),
                 semantic_hash=semantic_hash_for_node(node), node=node)


def semantic_hash(scope: Scope) -> str:
    return scope.semantic_hash


def semantic_hash_for_node(node: ast.AST) -> str:
    return fnv1a64(normalize_node(node, outer=True, fold=False))


def _should_suppress(node, site_kind: str) -> bool:
    """构造性等价变异抑制链(首条命中即抑制;顺序固定便于评审)。"""
    if site_kind == "boolop-swap":
        operands = [normalize_node(item, False, False) for item in node.values]
        if len(set(operands)) == 1:
            return True
    if site_kind == "binop-swap":
        for operand in (node.left, node.right):
            if isinstance(operand, ast.Constant) and operand.value == 0:
                return True
    return False


def _walk_scope(scope_node, scope_id, sites, path) -> int:
    """遍历作用域并收集位点;返回本作用域的抑制数。"""
    suppressed = 0
    for field, value in ast.iter_fields(scope_node):
        if field in ("name", "args", "decorator_list", "returns", "type_params"):
            continue
        if field == "body":
            for index, stmt in enumerate(value):
                suppressed += _walk_node(stmt, scope_id, sites,
                                         path + ((field, index),))
        elif isinstance(value, ast.AST):
            suppressed += _walk_node(value, scope_id, sites,
                                     path + ((field, None),))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                if isinstance(item, ast.AST):
                    suppressed += _walk_node(item, scope_id, sites,
                                             path + ((field, index),))
    return suppressed


def _walk_node(node, scope_id, sites, path) -> int:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return 0  # 嵌套定义不是本作用域的位点
    generated: list[tuple[str, str, dict, tuple]] = []

    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool):
            generated.append(("bool-flip", "bool-flip", {}, ()))
        elif isinstance(node.value, int) and node.value in (0, 1):
            generated.append(("int-swap", "int-swap", {}, ()))
    elif isinstance(node, ast.Compare):
        for index, op in enumerate(node.ops):
            if type(op) in _SWAP_COMPARE:
                generated.append(("compare-swap",
                                  f"compare/{_op_name(type(op))}->{_op_name(_SWAP_COMPARE[type(op)])}",
                                  {"index": index}, ()))
    elif isinstance(node, ast.BinOp):
        if type(node.op) in _SWAP_BINOP:
            generated.append(("binop-swap",
                              f"binop/{_op_name(type(node.op))}->{_op_name(_SWAP_BINOP[type(node.op)])}",
                              {}, ()))
    elif isinstance(node, ast.BoolOp):
        generated.append(("boolop-swap",
                          "boolop/and->or" if isinstance(node.op, ast.And)
                          else "boolop/or->and", {}, ()))
    elif isinstance(node, ast.UnaryOp):
        if isinstance(node.op, (ast.Not, ast.USub)):
            generated.append(("unary-remove",
                              "unary/not-remove" if isinstance(node.op, ast.Not)
                              else "unary/usub-remove", {}, ()))
    elif isinstance(node, (ast.Assign, ast.AugAssign)):
        generated.append(("rhs-none", "rhs->none", {}, (("value", None),)))
    elif isinstance(node, ast.AnnAssign):
        if node.value is not None:
            generated.append(("rhs-none", "rhs->none", {}, (("value", None),)))

    suppressed = 0
    for kind, description, meta, extra_path in generated:
        if _should_suppress(node, kind):
            suppressed += 1
            continue
        line = getattr(node, "lineno", 0)
        sites.append(Site(scope_id=scope_id, line=line, description=description,
                          kind=kind, path=path + extra_path, meta=meta))
    total = suppressed

    for field, value in ast.iter_fields(node):
        if isinstance(value, ast.AST):
            total += _walk_node(value, scope_id, sites, path + ((field, None),))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                if isinstance(item, ast.AST):
                    total += _walk_node(item, scope_id, sites,
                                        path + ((field, index),))
    return total


def _op_name(op_class) -> str:
    return op_class.__name__.lower()


def scan_module(source: str, module_name: str = "mod"
                ) -> tuple[list[Scope], list[Site], int]:
    """返回 (scopes, sites, 构造性等价抑制数)。"""
    tree = ast.parse(source)
    scopes: list[Scope] = []
    sites: list[Site] = []
    suppressed = 0
    for scope, node, scope_path in _collect_scopes(tree, module_name):
        scopes.append(scope)
        suppressed += _walk_scope(node, scope.id, sites, scope_path)
    return scopes, sites, suppressed


def find_root(workspace_root: str, target_abs: str) -> str:
    cursor = os.path.dirname(os.path.abspath(target_abs))
    while cursor and cursor != os.path.dirname(cursor):
        markers = (os.path.isdir(os.path.join(cursor, ".git")),
                   os.path.isfile(os.path.join(cursor, "pyproject.toml")),
                   os.path.isdir(os.path.join(cursor, "tests")))
        if any(markers):
            return cursor
        if os.path.abspath(cursor) == os.path.abspath(workspace_root):
            break
        cursor = os.path.dirname(cursor)
    return workspace_root


def _project_files(project_root: str) -> list[str]:
    files: list[str] = []
    for root, dirs, names in os.walk(project_root):
        dirs[:] = [d for d in dirs if "/" + d + "/" not in _IGNORED_SEGMENTS]
        for name in sorted(names):
            if name.endswith(".py") or name == "pyproject.toml":
                files.append(os.path.join(root, name))
    return sorted(files)


def project_hash(project_root: str, target_abs: str, stripped_source: str) -> str:
    parts: list[str] = []
    target_abs = os.path.abspath(target_abs)
    for path in _project_files(project_root):
        relative = os.path.relpath(path, project_root)
        if any(segment in "/" + relative for segment in _IGNORED_SEGMENTS):
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                content = handle.read().replace("\r\n", "\n")
        except OSError:
            continue
        if os.path.abspath(path) == target_abs:
            content = stripped_source.replace("\r\n", "\n")
        parts += [relative.replace(os.sep, "/"), "\n", content, "\n\0\n"]
    return fnv1a64("".join(parts))


def scope_changed(scope: Scope, old_manifest: dict) -> bool:
    for old in old_manifest.get("scopes", []):
        if old.get("id") == scope.id:
            return old.get("semantic_hash", "") != scope.semantic_hash
    return True


def select_sites(sites: list[Site], scopes: list[Scope], old_manifest: dict | None,
                 options: dict, module_hash_changed: bool) -> list[Site]:
    line_set = options.get("line_set")
    if line_set:
        return [site for site in sites if site.line in line_set]
    if options.get("mutate_all"):
        return sites
    changed = {scope.id for scope in scopes
               if old_manifest is None or scope_changed(scope, old_manifest)}
    if options.get("since_last_run"):
        return [site for site in sites if site.scope_id in changed]
    if old_manifest and not module_hash_changed:
        return []
    return [site for site in sites if site.scope_id in changed]


def surface_areas(sites: list[Site], scopes: list[Scope],
                  old_manifest: dict | None) -> tuple[int, int]:
    """differential = 不在 manifest 中 scope 的位点数;violating = 语义哈希失配的位数。"""
    if not old_manifest:
        return len(sites), 0
    by_id = {scope.id: scope for scope in scopes}
    differential, violating = 0, 0
    for site in sites:
        old = next((scope for scope in old_manifest.get("scopes", [])
                    if scope.get("id") == site.scope_id), None)
        current = by_id.get(site.scope_id)
        if old is None or current is None:
            differential += 1
        elif old.get("semantic_hash", "") != current.semantic_hash:
            violating += 1
    return differential, violating
