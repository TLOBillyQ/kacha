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
    """作用域语义哈希:不折叠嵌套定义(内层结构变了要重跑外层位点)。

    哈希口径沿用归一化序列化(标识符 -> ident,字面量 -> literal/<kind>),所以
    纯改名与纯改字面量取值不会触发差分重跑 —— 已知限制,README 与测试里都有记录。
    """
    return fnv1a64(normalize_node(node, fold=False))


def _should_suppress(node, site_kind: str) -> bool:
    """构造性等价变异抑制链:按位点 kind 查谓词表,任一命中即抑制。"""
    return any(test(node) for test in _EQUIVALENT_PREDICATES.get(site_kind, ()))


def _boolop_operands_identical(node: ast.BoolOp) -> bool:
    """操作数按完整 AST 结构比较:全部逐字相同,and/or 互换才是构造性等价变异。

    这里不能用 semantic_hash_for_node:那个哈希按归一化口径掩蔽标识符与字面量
    取值,会把 `a and b` 误判成同操作数,从而丢掉一条真实的变异。
    """
    return len({ast.dump(item, include_attributes=False)
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
            self.sites.append(Site(scope_id=scope_id, line=node.lineno,
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

# mutate4py-manifest
# version=4
# projectHash=9b197a7cd635cf5f
# scope.0.id=engine.Site.apply
# scope.0.kind=method
# scope.0.startLine=71
# scope.0.endLine=81
# scope.0.semanticHash=3ee4b0f5e56b1ae2
# scope.1.id=engine.Site.mutated_source
# scope.1.kind=method
# scope.1.startLine=83
# scope.1.endLine=87
# scope.1.semanticHash=94a83e3f4fafd0fe
# scope.2.id=engine._flip_bool
# scope.2.kind=function
# scope.2.startLine=90
# scope.2.endLine=91
# scope.2.semanticHash=0af31c6d2490a290
# scope.3.id=engine._swap_int
# scope.3.kind=function
# scope.3.startLine=94
# scope.3.endLine=95
# scope.3.semanticHash=982b9f2c919a6296
# scope.4.id=engine._swap_compare
# scope.4.kind=function
# scope.4.startLine=98
# scope.4.endLine=100
# scope.4.semanticHash=2f4bca15cdfb680d
# scope.5.id=engine._swap_binop
# scope.5.kind=function
# scope.5.startLine=103
# scope.5.endLine=104
# scope.5.semanticHash=67b311511b024dfe
# scope.6.id=engine._swap_boolop
# scope.6.kind=function
# scope.6.startLine=107
# scope.6.endLine=108
# scope.6.semanticHash=45840280d9b9294b
# scope.7.id=engine._assign
# scope.7.kind=function
# scope.7.startLine=127
# scope.7.endLine=131
# scope.7.semanticHash=aca4acf5854940b7
# scope.8.id=engine._resolve
# scope.8.kind=function
# scope.8.startLine=134
# scope.8.endLine=145
# scope.8.semanticHash=dfa63f1dba99c190
# scope.9.id=engine._collect_scopes
# scope.9.kind=function
# scope.9.startLine=148
# scope.9.endLine=158
# scope.9.semanticHash=6a9c860d1a79652c
# scope.10.id=engine._class_scopes
# scope.10.kind=function
# scope.10.startLine=161
# scope.10.endLine=167
# scope.10.semanticHash=02263cae95284ae1
# scope.11.id=engine._make_scope
# scope.11.kind=function
# scope.11.startLine=170
# scope.11.endLine=173
# scope.11.semanticHash=f166b540c8b2afb1
# scope.12.id=engine.semantic_hash
# scope.12.kind=function
# scope.12.startLine=176
# scope.12.endLine=177
# scope.12.semanticHash=8e3c18dcf9ae37cb
# scope.13.id=engine.semantic_hash_for_node
# scope.13.kind=function
# scope.13.startLine=180
# scope.13.endLine=186
# scope.13.semanticHash=6a543dab06d23400
# scope.14.id=engine._should_suppress
# scope.14.kind=function
# scope.14.startLine=189
# scope.14.endLine=191
# scope.14.semanticHash=f78351556b7d4a22
# scope.15.id=engine._boolop_operands_identical
# scope.15.kind=function
# scope.15.startLine=194
# scope.15.endLine=201
# scope.15.semanticHash=30839c41f694fa65
# scope.16.id=engine._operates_on_zero
# scope.16.kind=function
# scope.16.startLine=204
# scope.16.endLine=205
# scope.16.semanticHash=bf0d932e99fb2cd7
# scope.17.id=engine._is_zero
# scope.17.kind=function
# scope.17.startLine=208
# scope.17.endLine=209
# scope.17.semanticHash=ec6ef1c57805ea1c
# scope.18.id=engine._assigns_none
# scope.18.kind=function
# scope.18.startLine=212
# scope.18.endLine=215
# scope.18.semanticHash=02a88d769ff0bc67
# scope.19.id=engine._no_sites
# scope.19.kind=function
# scope.19.startLine=227
# scope.19.endLine=228
# scope.19.semanticHash=5a2c54d610a44ecd
# scope.20.id=engine._constant_sites
# scope.20.kind=function
# scope.20.startLine=231
# scope.20.endLine=236
# scope.20.semanticHash=914f0d5c8c47d5b2
# scope.21.id=engine._compare_sites
# scope.21.kind=function
# scope.21.startLine=239
# scope.21.endLine=247
# scope.21.semanticHash=1ee8446afd35644d
# scope.22.id=engine._binop_sites
# scope.22.kind=function
# scope.22.startLine=250
# scope.22.endLine=254
# scope.22.semanticHash=8c5e54a16de77983
# scope.23.id=engine._boolop_sites
# scope.23.kind=function
# scope.23.startLine=257
# scope.23.endLine=260
# scope.23.semanticHash=35dd81a7e1a4e570
# scope.24.id=engine._unary_sites
# scope.24.kind=function
# scope.24.startLine=263
# scope.24.endLine=268
# scope.24.semanticHash=aab104cb56c7646b
# scope.25.id=engine._assign_sites
# scope.25.kind=function
# scope.25.startLine=271
# scope.25.endLine=274
# scope.25.semanticHash=8812eedea97456ab
# scope.26.id=engine._swap_description
# scope.26.kind=function
# scope.26.startLine=277
# scope.26.endLine=278
# scope.26.semanticHash=94b5c93c5fb34e80
# scope.27.id=engine._Sink.visit
# scope.27.kind=method
# scope.27.startLine=301
# scope.27.endLine=305
# scope.27.semanticHash=75dbf8b13180eb80
# scope.28.id=engine._Sink.visit_scope
# scope.28.kind=method
# scope.28.startLine=307
# scope.28.endLine=308
# scope.28.semanticHash=a709634ac1700ffd
# scope.29.id=engine._Sink._record
# scope.29.kind=method
# scope.29.startLine=310
# scope.29.endLine=318
# scope.29.semanticHash=3da684f662276200
# scope.30.id=engine._Sink._visit_children
# scope.30.kind=method
# scope.30.startLine=320
# scope.30.endLine=323
# scope.30.semanticHash=37068480c8570d11
# scope.31.id=engine._op_name
# scope.31.kind=function
# scope.31.startLine=326
# scope.31.endLine=327
# scope.31.semanticHash=c33ad8f01f54adcb
# scope.32.id=engine.scan_module
# scope.32.kind=function
# scope.32.startLine=330
# scope.32.endLine=339
# scope.32.semanticHash=6ea273e68da150e0
# scope.33.id=engine.find_root
# scope.33.kind=function
# scope.33.startLine=342
# scope.33.endLine=350
# scope.33.semanticHash=7291114dc849f35b
# scope.34.id=engine._is_project_root
# scope.34.kind=function
# scope.34.startLine=353
# scope.34.endLine=356
# scope.34.semanticHash=a5deb576cb96bc0f
# scope.35.id=engine._project_files
# scope.35.kind=function
# scope.35.startLine=359
# scope.35.endLine=366
# scope.35.semanticHash=3bfebe57e43eeb60
# scope.36.id=engine._hashable_files
# scope.36.kind=function
# scope.36.startLine=369
# scope.36.endLine=371
# scope.36.semanticHash=60baca0fdf10845d
# scope.37.id=engine.project_hash
# scope.37.kind=function
# scope.37.startLine=374
# scope.37.endLine=384
# scope.37.semanticHash=3a0ff1eb13b36790
# scope.38.id=engine._hash_content
# scope.38.kind=function
# scope.38.startLine=387
# scope.38.endLine=394
# scope.38.semanticHash=67b3f0aac7600c81
# scope.39.id=engine.scope_changed
# scope.39.kind=function
# scope.39.startLine=397
# scope.39.endLine=402
# scope.39.semanticHash=656548b6989df2fb
# scope.40.id=engine._manifest_scopes
# scope.40.kind=function
# scope.40.startLine=405
# scope.40.endLine=406
# scope.40.semanticHash=7549bae80d8b14d6
# scope.41.id=engine.changed_scope_ids
# scope.41.kind=function
# scope.41.startLine=409
# scope.41.endLine=413
# scope.41.semanticHash=cd4b5a6e9bca8db9
# scope.42.id=engine.select_sites
# scope.42.kind=function
# scope.42.startLine=416
# scope.42.endLine=425
# scope.42.semanticHash=0d3558d88bcd43a5
# scope.43.id=engine._sites_on_lines
# scope.43.kind=function
# scope.43.startLine=428
# scope.43.endLine=429
# scope.43.semanticHash=2a3417fa705f34ed
# scope.44.id=engine._sites_in_scopes
# scope.44.kind=function
# scope.44.startLine=432
# scope.44.endLine=433
# scope.44.semanticHash=2a3417fa705f34ed
# scope.45.id=engine._module_untouched
# scope.45.kind=function
# scope.45.startLine=436
# scope.45.endLine=439
# scope.45.semanticHash=fd5ca255cdf0792b
# scope.46.id=engine.surface_areas
# scope.46.kind=function
# scope.46.startLine=442
# scope.46.endLine=450
# scope.46.semanticHash=e7d007c0c4b52af1
# scope.47.id=engine._area_state
# scope.47.kind=function
# scope.47.startLine=453
# scope.47.endLine=460
# scope.47.semanticHash=f7cfcf144cf3fdd5
