# 4py 工具链(two-pack Python 工具)

本项目 two-pack(coder + cleaner)的 Python 质量工具,与「4lua 系列」同构:
上游 unclebob 的 crap4clj/go/java、dry4clj/go/java、mutate4java 规格,以
Python 忠实实现(「零本地独有发明」教义;Python 无上游规格的部分以本文档为
规格,对齐不变量逐条列出,偏离注明理由)。

## 安装与入口

```sh
python3 -m venv .venv
.venv/bin/pip install -e '.[test]'   # pytest + coverage
.venv/bin/python tools/cli.py <子命令> [args...]
```

无单独安装步骤:工具随仓库 `tools/` 提供。项目解释器优先取 `.venv/bin/python`。

## 子命令(封闭命令集)

| 子命令 | 用途 | 对应上游 |
| --- | --- | --- |
| `verify` | 质量门禁:slim 跑 pytest;`--coverage` 插桩跑并输出报告 | —(宿主编排) |
| `crap` | CRAP 热点分析(圈复杂度 × 覆盖率) | crap4clj/go/java |
| `dry` | 结构重复检测(AST 归一化 + Jaccard) | dry4clj/go/java |
| `mutate` | 单文件变异测试(manifest 差分) | mutate4java/lua |

退出码约定:顶层 `0` 成功 / `1` 业务失败 / `2` 用法错误(未知子命令、加载失败);
子命令各自追加:mutate `3` = 存在存活 mutant、`2` = baseline 失败;crap `2` =
门禁失败;dry `2` = 未知 `--format`。

## verify

```sh
python tools/cli.py verify            # slim 硬地板:任一测试失败即非 0
python tools/cli.py verify --coverage # coverage.py 插桩 + per-file 报告
```

slim 是迭代与 handoff 前唯一硬地板。coverage 未安装时业务失败(退出码 1),不虚构数据。

## crap(对齐不变量)

- CRAP 公式 `CC² × (1 - cov)³ + CC`;覆盖率缺失时得分为空,显示为 `N/A` ——
  绝不当作 0(JSON 中为 `null`,排序沉底)。
- 风险带 `1-5 low / 5-30 moderate / 30+ high`。
- 五阶段骨架:查找源文件 → 解析函数边界 → 计算圈复杂度 → 覆盖率归因到函数 →
  排序输出。
- 覆盖率仅来自解析生态标准工具的固定产物 — **coverage.py 的 `coverage json`**
  是唯一覆盖率路径(luacov 的 Python 对应)。
- 圈复杂度基于真实 Python AST 计算:基线 1,决策点 +1(if/elif、for/async for、
  while、except handler、with/async with、assert、and/or、三元、推导式、match/case)。

```sh
python tools/cli.py crap [--top N] [--json] [--gate] [--gate-threshold N] [--source PATH]
```

**有意偏离**:lua 版拆 `collect / report / summary / dry-run` 四命令,此处收敛为
单趟(collect 后直接 report);门禁阈值可配置(默认 5.0,同 lua)。
`--gate`:任一非空 CRAP 超过阈值即退出码 2。

## dry(对齐不变量)

- 默认参数 `threshold 0.82 / min-lines 4 / min-nodes 20` 及选项集。
- 指纹 = 序列化后的归一化子树集合;相似度 = Jaccard。
- 检测单位 = 函数作用域(模块级函数 + 类方法)。
- 文本输出骨架(`DUPLICATE score=%.2f` + 两行 `file:start-end`,无候选时输出
  `No duplicate candidates found.`)以及未知格式时的退出码 2。
- 归一化将运算符/关键字保留在标签中,同时剥离标识符和字面量(与 dry4go 最接近)。
- 嵌套函数在父级指纹中折叠为 `(function)` 叶节点;同一文件行号重叠条目排除
  (对齐 dry4java `overlaps` 语义)。

```sh
python tools/cli.py dry [--threshold N] [--min-lines N] [--min-nodes N]
                        [--format text|json] [--limit N] [file-or-directory ...]
```

**有意偏离**:JSON 输出带函数 `name` 字段;文本输出提供 `--limit`(均同 lua 版)。

## mutate(对齐不变量)

- 退出码 `0` 成功 / `1` 用法错误 / `2` baseline 失败 / `3` 存在存活 mutant。
- manifest 以 `# mutate4py-manifest` 注释块形式嵌入目标文件尾部(外部
  `.mutate4py/manifest/` 存储已废除);manifest 只在干净运行后写入。
- 差异化选择:无 manifest → 所有已覆盖位点;模块 hash 未变 → 0 个位点;
  hash 变化 → 仅变动的 scope。
- 变异集合:布尔翻转、比较/算术运算符交换、`and` ↔ `or`、一元 `not`/`-` 移除、
  `0` ↔ `1`、赋值右值 → `None`。
- scope 身份以声明为基准(模块级函数与类方法);worker 操作项目副本,
  原始文件永不在原地变异;超时视为已击杀。
- 测试经项目 pytest 运行(上游「内置构建工具调用」的 Python 对应);
  `--test-command` 为同款逃生舱(禁用覆盖率过滤)。
- scope 语义哈希 = 归一化 AST 序列化结果的 FNV-1a(格式无关)。
- 覆盖率来源仅限 coverage.py 产物(`coverage json`)。

```sh
python tools/cli.py mutate <file.py> [--scan|--update-manifest|--since-last-run|
    --lines N,N|--mutate-all|--reuse-coverage|--max-workers N|--timeout-factor N|
    --test-command CMD|--mutation-warning N|--verbose]
```

**有意偏离**:scope 收集只含模块级函数与类方法(lua 版连匿名/嵌套函数一起收集);
构造性等价变异抑制链为手写谓词(boolop 全操作数相同、`+/-` 含常量 `0` 操作数),
链可扩展,顺序固定便于评审;`--reuse-coverage` 复用按项目哈希判鲜的缓存
(lua 版复用归因矩阵缓存)。

## 布局

```text
tools/
  cli.py                  # 顶层调度(封闭命令集)
  packages/
    common.py             # 项目解释器解析、函数作用域提取
    astnorm.py            # AST 归一化(dry 指纹 / mutate 语义哈希共用)
    verify/               # 质量门禁
    crap/                 # CRAP 热点
    dry/                  # 结构重复
    mutate/               # 变异测试(manifest footer / 差分选择 / worker)
```

规范纪律:manifest 不手改,只用 `--update-manifest` 再生成;CRAP/DRY/变异/覆盖率
一次只跑一个工具;`--max-workers 4`。
