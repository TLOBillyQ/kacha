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
- 项目哈希与 worker 副本共用同一份排除目录表(见 IGNORED_DIRECTORIES)

位点(kind)与算子的对应关系集中在 _NODE_EDITS / _NODE_REPLACEMENTS 两张表里,
新增算子 = 生成一条位点 + 登记一条表项,不改控制流。
"""

from __future__ import annotations

import ast
import dataclasses
import os

from ..astnorm import FUNCTION_NODES, child_nodes, fnv1a64, normalize_node
from . import manifest

_SWAP_COMPARE = {ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.Lt: ast.Gt,
                 ast.Gt: ast.Lt, ast.LtE: ast.GtE, ast.GtE: ast.LtE,
                 ast.Is: ast.IsNot, ast.IsNot: ast.Is, ast.In: ast.NotIn,
                 ast.NotIn: ast.In}
_SWAP_BINOP = {ast.Add: ast.Sub, ast.Sub: ast.Add, ast.Mult: ast.Div,
               ast.Div: ast.Mult}

#: 参与项目哈希的构建清单文件名。
PROJECT_MARKER = "pyproject.toml"

#: 项目哈希与 worker 副本共同排除的目录名(单一事实来源)。
IGNORED_DIRECTORIES = (".git", ".venv", ".venv-win", ".swarmforge", ".worktrees",
                       ".toolcache", ".mutate4py", "__pycache__", "tmp",
                       "node_modules", ".pytest_cache")

#: 作用域根的声明字段:不是可执行体,不产位点。
_DECLARATION_FIELDS = ("name", "args", "decorator_list", "returns", "type_params")

#: 嵌套定义(函数/类)不属于外层作用域
_DEFINITION_NODES = FUNCTION_NODES + (ast.ClassDef,)


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
        """在解析后的模块上就地施加本变异。"""
        parent, field, index, node = _resolve(tree, self.path)
        edit = _NODE_EDITS.get(self.kind)
        if edit is not None:
            edit(node, self.meta)
            return
        replacement = _NODE_REPLACEMENTS.get(self.kind)
        if replacement is None:  # pragma: no cover - 未知 kind 是编程错误
            raise ValueError(f"unknown site kind: {self.kind}")
        _assign(parent, field, index, replacement(node))

    def mutated_source(self, source: str) -> str:
        stripped = manifest.strip(source)
        tree = ast.parse(stripped)
        self.apply(tree)
        return ast.unparse(tree) + "\n"


def _flip_bool(node, meta: dict) -> None:
    node.value = not node.value


def _swap_int(node, meta: dict) -> None:
    node.value = 1 - node.value


def _swap_compare(node, meta: dict) -> None:
    position = meta["index"]
    node.ops[position] = _SWAP_COMPARE[type(node.ops[position])]()


def _swap_binop(node, meta: dict) -> None:
    node.op = _SWAP_BINOP[type(node.op)]()


def _swap_boolop(node, meta: dict) -> None:
    node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()


#: 就地改写节点属性的算子。
_NODE_EDITS = {
    "bool-flip": _flip_bool,
    "int-swap": _swap_int,
    "compare-swap": _swap_compare,
    "binop-swap": _swap_binop,
    "boolop-swap": _swap_boolop,
}

#: 用另一个节点替换目标位置的算子。
_NODE_REPLACEMENTS = {
    "unary-remove": lambda node: node.operand,
    "rhs-none": lambda node: ast.Constant(value=None),
}


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
        if isinstance(node, FUNCTION_NODES):
            found.append((_make_scope(node, module_name + "." + node.name,
                                      "function"), node, (("body", index),)))
        elif isinstance(node, ast.ClassDef):
            found.extend(_class_scopes(node, module_name, index))
    return found


def _class_scopes(class_node: ast.ClassDef, module_name: str,
                  outer_index: int) -> list[tuple[Scope, ast.FunctionDef, tuple]]:
    prefix = f"{module_name}.{class_node.name}."
    return [(_make_scope(item, prefix + item.name, "method"),
             item, (("body", outer_index), ("body", inner)))
            for inner, item in enumerate(class_node.body)
            if isinstance(item, FUNCTION_NODES)]


def _make_scope(node: ast.FunctionDef, scope_id: str, kind: str) -> Scope:
    return Scope(id=scope_id, kind=kind, start_line=node.lineno,
                 end_line=getattr(node, "end_lineno", node.lineno),
                 semantic_hash=semantic_hash_for_node(node), node=node)


def semantic_hash(scope: Scope) -> str:
    return scope.semantic_hash


def semantic_hash_for_node(node: ast.AST) -> str:
    return fnv1a64(normalize_node(node, outer=True, fold=False))


def _should_suppress(node, site_kind: str) -> bool:
    """构造性等价变异抑制链:按位点 kind 查谓词表,任一命中即抑制。"""
    return any(test(node) for test in _EQUIVALENT_PREDICATES.get(site_kind, ()))


def _boolop_operands_identical(node: ast.BoolOp) -> bool:
    return len({normalize_node(item, False, False)
                for item in node.values}) == 1


def _operates_on_zero(node) -> bool:
    return any(_is_zero(operand) for operand in (node.left, node.right))


def _is_zero(operand) -> bool:
    return isinstance(operand, ast.Constant) and operand.value == 0


def _assigns_none(node) -> bool:
    """右值本来就是 None 字面量:rhs-none 变异写回同一个节点,构造性等价。"""
    value = getattr(node, "value", None)
    return isinstance(value, ast.Constant) and value.value is None


#: 位点 kind -> 构造性等价谓词(链可扩展:新增一类"改回去等价"的算子就在这里登记
#: 一条谓词;表内顺序固定,便于逐条评审)。
_EQUIVALENT_PREDICATES = {
    "boolop-swap": (_boolop_operands_identical,),
    "binop-swap": (_operates_on_zero,),
    "rhs-none": (_assigns_none,),
}


def _no_sites(node) -> list:
    return []


def _constant_sites(node: ast.Constant) -> list:
    if isinstance(node.value, bool):
        return [("bool-flip", "bool-flip", {}, ())]
    if isinstance(node.value, int) and node.value in (0, 1):
        return [("int-swap", "int-swap", {}, ())]
    return []


def _compare_sites(node: ast.Compare) -> list:
    sites = []
    for index, op in enumerate(node.ops):
        target = _SWAP_COMPARE.get(type(op))
        if target is not None:
            sites.append(("compare-swap",
                          _swap_description("compare", op, target),
                          {"index": index}, ()))
    return sites


def _binop_sites(node: ast.BinOp) -> list:
    target = _SWAP_BINOP.get(type(node.op))
    if target is None:
        return []
    return [("binop-swap", _swap_description("binop", node.op, target), {}, ())]


def _boolop_sites(node: ast.BoolOp) -> list:
    return [("boolop-swap",
             "boolop/and->or" if isinstance(node.op, ast.And)
             else "boolop/or->and", {}, ())]


def _unary_sites(node: ast.UnaryOp) -> list:
    if not isinstance(node.op, (ast.Not, ast.USub)):
        return []
    return [("unary-remove",
             "unary/not-remove" if isinstance(node.op, ast.Not)
             else "unary/usub-remove", {}, ())]


def _assign_sites(node) -> list:
    if getattr(node, "value", None) is None:
        return []
    return [("rhs-none", "rhs->none", {}, (("value", None),))]


def _swap_description(family: str, op, target) -> str:
    return f"{family}/{_op_name(type(op))}->{_op_name(target)}"


#: 节点类型 -> 位点生成器(封闭集;未登记的类型不产位点)。
_SITE_GENERATORS = {
    ast.Constant: _constant_sites,
    ast.Compare: _compare_sites,
    ast.BinOp: _binop_sites,
    ast.BoolOp: _boolop_sites,
    ast.UnaryOp: _unary_sites,
    ast.Assign: _assign_sites,
    ast.AugAssign: _assign_sites,
    ast.AnnAssign: _assign_sites,
}


@dataclasses.dataclass
class _Sink:
    """位点收集器:sites 累加,构造性等价位点计入 suppressed。"""

    sites: list[Site] = dataclasses.field(default_factory=list)
    suppressed: int = 0

    def visit(self, node, scope_id: str, path: tuple) -> None:
        if isinstance(node, _DEFINITION_NODES):
            return  # 嵌套定义不是本作用域的位点
        self._record(node, scope_id, path)
        self._visit_children(node, scope_id, path)

    def visit_scope(self, node, scope_id: str, path: tuple) -> None:
        self._visit_children(node, scope_id, path, skip=_DECLARATION_FIELDS)

    def _record(self, node, scope_id: str, path: tuple) -> None:
        generate = _SITE_GENERATORS.get(type(node), _no_sites)
        for kind, description, meta, extra_path in generate(node):
            if _should_suppress(node, kind):
                self.suppressed += 1
                continue
            self.sites.append(Site(scope_id=scope_id,
                                   line=getattr(node, "lineno", 0),
                                   description=description, kind=kind,
                                   path=path + extra_path, meta=meta))

    def _visit_children(self, node, scope_id: str, path: tuple,
                        skip: tuple = ()) -> None:
        for field, index, child in child_nodes(node, skip):
            self.visit(child, scope_id, path + ((field, index),))


def _op_name(op_class) -> str:
    return op_class.__name__.lower()


def scan_module(source: str, module_name: str = "mod"
                ) -> tuple[list[Scope], list[Site], int]:
    """返回 (scopes, sites, 构造性等价抑制数)。"""
    tree = ast.parse(source)
    sink = _Sink()
    scopes: list[Scope] = []
    for scope, node, scope_path in _collect_scopes(tree, module_name):
        scopes.append(scope)
        sink.visit_scope(node, scope.id, scope_path)
    return scopes, sink.sites, sink.suppressed


def find_root(workspace_root: str, target_abs: str) -> str:
    cursor = os.path.dirname(os.path.abspath(target_abs))
    while cursor and cursor != os.path.dirname(cursor):
        if _is_project_root(cursor):
            return cursor
        if os.path.abspath(cursor) == os.path.abspath(workspace_root):
            break
        cursor = os.path.dirname(cursor)
    return workspace_root


def _is_project_root(path: str) -> bool:
    return (os.path.isdir(os.path.join(path, ".git"))
            or os.path.isfile(os.path.join(path, "pyproject.toml"))
            or os.path.isdir(os.path.join(path, "tests")))


def _project_files(project_root: str) -> list[str]:
    """参与内容哈希的文件:.py 与 pyproject.toml,跳过 IGNORED_DIRECTORIES。"""
    ignored = frozenset(IGNORED_DIRECTORIES)
    files: list[str] = []
    for root, dirs, names in os.walk(project_root):
        dirs[:] = [name for name in dirs if name not in ignored]
        files.extend(_hashable_files(root, names))
    return sorted(files)


def _hashable_files(root: str, names) -> list[str]:
    return [os.path.join(root, name) for name in sorted(names)
            if name.endswith(".py") or name == PROJECT_MARKER]


def project_hash(project_root: str, target_abs: str, stripped_source: str) -> str:
    """项目内容哈希:目标文件以"去掉 manifest 后的源码"参与,页边稳定。"""
    parts: list[str] = []
    target_abs = os.path.abspath(target_abs)
    for path in _project_files(project_root):
        content = _hash_content(path, target_abs, stripped_source)
        if content is None:
            continue
        relative = os.path.relpath(path, project_root).replace(os.sep, "/")
        parts += [relative, "\n", content, "\n\0\n"]
    return fnv1a64("".join(parts))


def _hash_content(path: str, target_abs: str, stripped_source: str) -> str | None:
    if os.path.abspath(path) == target_abs:
        return stripped_source.replace("\r\n", "\n")
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().replace("\r\n", "\n")
    except OSError:
        return None


def scope_changed(scope: Scope, old_manifest: dict) -> bool:
    """manifest 中同名 scope 的语义哈希是否与当前不同(缺失也算变更)。"""
    recorded = _manifest_scopes(old_manifest).get(scope.id)
    if recorded is None:
        return True
    return recorded.get("semantic_hash", "") != scope.semantic_hash


def _manifest_scopes(old_manifest: dict) -> dict:
    return {scope.get("id"): scope for scope in old_manifest.get("scopes", [])}


def changed_scope_ids(scopes: list[Scope], old_manifest: dict | None) -> set[str]:
    """需要重新变异的 scope 身份;无 manifest 时全部视为变更。"""
    if old_manifest is None:
        return {scope.id for scope in scopes}
    return {scope.id for scope in scopes if scope_changed(scope, old_manifest)}


def select_sites(sites: list[Site], scopes: list[Scope], old_manifest: dict | None,
                 options: dict, module_hash_changed: bool) -> list[Site]:
    """差分选择变异位点:行号 / 全集 / 变更 scope / 模块哈希未变则空跑。"""
    if options.get("line_set"):
        return _sites_on_lines(sites, options["line_set"])
    if options.get("mutate_all"):
        return list(sites)
    if _module_untouched(options, old_manifest, module_hash_changed):
        return []
    return _sites_in_scopes(sites, changed_scope_ids(scopes, old_manifest))


def _sites_on_lines(sites: list[Site], line_set: set[int]) -> list[Site]:
    return [site for site in sites if site.line in line_set]


def _sites_in_scopes(sites: list[Site], scope_ids: set[str]) -> list[Site]:
    return [site for site in sites if site.scope_id in scope_ids]


def _module_untouched(options, old_manifest, module_hash_changed: bool) -> bool:
    """manifest 在、模块内容哈希未变、且调用方没有强制看 diff -> 无事可做。"""
    return (old_manifest is not None and not module_hash_changed
            and not options.get("since_last_run"))


def surface_areas(sites: list[Site], scopes: list[Scope],
                  old_manifest: dict | None) -> tuple[int, int]:
    """differential = 不在 manifest 中 scope 的位点数;violating = 语义哈希失配的位数。"""
    if not old_manifest:
        return len(sites), 0
    recorded = _manifest_scopes(old_manifest)
    current = {scope.id: scope for scope in scopes}
    states = [_area_state(site, recorded, current) for site in sites]
    return states.count("differential"), states.count("violating")


def _area_state(site: Site, recorded: dict, current: dict) -> str:
    """单个位点相对 manifest 的表面面积归类。"""
    previous, present = recorded.get(site.scope_id), current.get(site.scope_id)
    if previous is None or present is None:
        return "differential"
    if previous.get("semantic_hash", "") != present.semantic_hash:
        return "violating"
    return "matched"
