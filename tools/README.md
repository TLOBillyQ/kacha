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
  嵌套函数/类方法体里的决策点算在自己的作用域,不重复计入外层。
- 覆盖率归因分母 = coverage.py 认定的语句行(`executed ∪ missing`),不是 scope 的
  行号跨度:多行语句的续行、docstring 与 `# pragma: no cover` 行都不计入,
  否则分母虚高、CRAP 会被系统性高估。

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
- footer 识别:marker 必须**独占一行**且其后一直到文件末尾只剩注释/空行;文档或
  字符串里引用的 marker 不会被当成 footer,源文件也不会被 strip 截断。
- manifest 登记范围诚实:只有「位点全部跑完」「无位点」「整体未触及且旧记录语义哈希
  一致」三类 scope 才写回;被 `--lines`/覆盖率过滤切走的位点不会被一次局部运行
  记成「已验证」(全量登记只由 `--update-manifest` 做)。
- 判定可信的三个前提(每个位点都在项目副本里跑):副本**租约**(同一副本同一时刻
  只跑一个位点;按「位点序号 % worker 数」分副本会互相改写同一文件)、写变异文件前
  清掉目标包目录的 `__pycache__`(.pyc 按「整秒 mtime + 字节数」判鲜,同尺寸 mutant
  会被旧字节码顶替)、worker **私有 `TMPDIR/TEMP/TMP`**(并发 pytest 在同一条系统临时
  目录上会串台,读到别人的 `tmp_path`)。
- scope 语义哈希 = 归一化 AST 序列化结果的 FNV-1a(格式无关)。**掩蔽口径**:归一化
  把标识符归为 `ident`、字面量归为 `literal/<kind>`,所以纯改名与纯改字面量取值的
  编辑不会被差分感知(有测试钉死这条口径;要换口径是设计变更,见「已知问题」)。
- 覆盖率取数口径固定 `--source=src`(与 crap/verify 同一份 `covdata` 流水线):目标
  在 `tools/` 下时产物里没有它的条目,自动退化为「不过滤,全部位点都跑」。跑工具链
  自身时用逃生舱:`--test-command "$PWD/.venv/bin/python -m pytest tests/test_tools_*.py -x -q"`
  (单位点约 1 s;默认路径每次都要付一整遍覆盖率流水线 ~28 s)。
- `--test-command` 交给 `/bin/sh -c`,必须是**单条简单命令**:多语句命令(`a; b`)
  超时时只有 `sh` 被 kill,pytest 孙进程会成为孤儿。
- 覆盖率来源仅限 coverage.py 产物(`coverage json`)。

```sh
python tools/cli.py mutate <file.py> [--scan|--update-manifest|--since-last-run|
    --lines N,N|--mutate-all|--reuse-coverage|--max-workers N|--timeout-factor N|
    --test-command CMD|--mutation-warning N|--verbose]
```

**有意偏离**:scope 收集只含模块级函数与类方法(lua 版连匿名/嵌套函数一起收集);
构造性等价变异抑制链按位点 kind 查谓词表(可扩展,表内顺序固定便于评审):boolop
要求操作数**完整 AST 逐字相同**(不能用语义哈希比较——它掩蔽标识符,会把
`a and b` 误判成同操作数而丢掉一条真实变异)、`+/-` 含常量 `0` 操作数、`rhs->none`
右值已是 `None` 字面量;`--reuse-coverage` 复用按项目哈希判鲜的缓存
(lua 版复用归因矩阵缓存)。

## 布局

```text
tools/
  cli.py                  # 顶层调度(封闭命令集)
  packages/
    common.py             # 项目解释器解析、命令行 token、作用域提取
    covdata.py            # coverage.py 三步流水线与产物行级事实(crap/mutate 共用)
    astnorm.py            # AST 归一化(dry 指纹 / mutate 语义哈希共用)
    verify/               # 质量门禁
    crap/                 # CRAP 热点
    dry/                  # 结构重复
    mutate/               # 变异测试(manifest footer / 差分选择 / worker)
```

规范纪律:manifest 不手改,只用 `--update-manifest` 再生成;要让某条 claim 作废,
用工具自己的 `manifest.strip`,不手写编辑。CRAP/DRY/变异/覆盖率一次只跑一个工具;
`--max-workers 4`;变异是差分的,不传 `--mutate-all`。

## 未覆盖与已知问题

- 未实现 python `arch-view`(依赖边界扫描,lua 版有):two-pack cleaner 的
  架构审查暂靠角色自查;需要时另行补建。
- 本仓库 `tests/test_task_queue.py` 的两个用例(`test_default_limit_*_fifo_order`、
  `test_lowering_limit_does_not_cancel_running_tasks`)断言 3 个并发 gateway worker
  的**精确调用顺序**,单独跑也失败(在基线提交 b3636a2 上同样失败),与本工具链无关,
  但会让 `verify` slim 非绿 —— 也就是 handoff 硬地板当前无法达成。建议改断言
  「前三任务的集合 + 启动顺序」而不是全局顺序。
- 位点超时只 kill 直接子进程(`sh`);多语句 `--test-command` 会留下孤儿 pytest。
  要彻底修需要进程组 kill(`start_new_session=True` + `os.killpg`)。
- scope 语义哈希掩蔽标识符与字面量取值(见 mutate 段「掩蔽口径」):纯改名/纯改值
  的编辑不会触发差分重跑。改成值敏感的序列化能消除这个盲区,但会让所有 footer 失配
  并触发一次全量重跑 —— 属于口径变更,留给 coder 决定。
- worker 私有 `TMPDIR` 位于副本内部,因此依赖「祖先目录没有项目 marker」的测试
  在变异运行里不成立(已把唯一受影响用例改成显式 monkeypatch)。
- `--test-command` 走 `/bin/sh`(硬编码):Windows 上不可用,需要在该平台上跑
  变异时改成 `sh`/`cmd /c` 适配层。工具链自身的其余部分与平台无关。
