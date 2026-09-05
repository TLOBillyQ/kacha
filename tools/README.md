# 工具链入口(two-pack Python 工具)

本项目 two-pack(coder + cleaner)的质量工具由 `tools/cli.py` 统一调度:

| 子命令 | 用途 | 实现 |
| --- | --- | --- |
| `verify` | 质量门禁:slim 跑 pytest;`--coverage` 插桩跑并输出报告 | 本仓 `tools/packages/verify/` |
| `crap` | CRAP 热点分析(圈复杂度 × 覆盖率) | [crap4py](http://lzxsvn:3000/qinyuanj/crap4py) |
| `dry` | 结构重复检测(AST 归一化 + Jaccard) | [dry4py](http://lzxsvn:3000/qinyuanj/dry4py) |
| `mutate` | 单文件变异测试(manifest 差分) | [mutate4py](http://lzxsvn:3000/qinyuanj/mutate4py) |

「4py 系列」与 monopoly 消费的「4lua 系列」(eggy/crap4lua 等)同构:上游 unclebob 的
crap/dry/mutate 规格以 Python 忠实实现。对齐不变量、有意偏离与已知问题都写在各自仓的
README,本文件不再复述。

## 安装与入口

```sh
python3 -m venv .venv
.venv/bin/pip install -e '.[test]'   # pytest + coverage + crap4py/dry4py/mutate4py
.venv/bin/python tools/cli.py <子命令> [args...]
```

三个 4py 工具作为 `test` extra 的 git 依赖安装,跟随各仓 `main` HEAD(同 monopoly
`tools/tools.lock` 的“工具跟主干”约定)。要拉到上游最新:
`.venv/bin/pip install --upgrade --force-reinstall --no-deps crap4py dry4py mutate4py`
不会生效,用 `.venv/bin/pip install -e '.[test]' --upgrade` 重装 extra。

退出码约定:顶层 `0` 成功 / `1` 业务失败 / `2` 用法错误(未知子命令、加载失败;
4py 包未安装也是这一类,报错会附安装提示)。子命令各自的退出码见其 `--help`。

## verify

```sh
python tools/cli.py verify            # slim 硬地板:任一测试失败即非 0
python tools/cli.py verify --coverage # coverage.py 插桩 + per-file 报告
```

slim 是迭代与 handoff 前唯一硬地板。coverage 未安装时业务失败(退出码 1),不虚构数据。

## 纪律

manifest(`# mutate4py-manifest` footer)不手改,只用 `mutate --update-manifest`
再生成。CRAP/DRY/变异/覆盖率一次只跑一个工具;`--max-workers 4`;变异是差分的,
不传 `--mutate-all`。跑工具链自身时 mutate 用逃生舱
`--test-command "$PWD/.venv/bin/python -m pytest tests/test_tools_*.py -x -q"`。

## 已知问题

- 本仓库 `tests/test_task_queue.py` 的两个用例(`test_default_limit_*_fifo_order`、
  `test_lowering_limit_does_not_cancel_running_tasks`)断言 3 个并发 gateway worker
  的**精确调用顺序**,曾在基线提交 b3636a2 上失败(2026-09-05 迁移 4py 时全量跑为绿,
  视为间歇性),与工具链无关,但失败时会让 `verify` slim 非绿。建议改断言「前三任务的集合 + 启动顺序」而不是全局顺序。
- 未实现 python `arch-view`(依赖边界扫描,lua 版有):cleaner 的架构审查暂靠角色自查。
