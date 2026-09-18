# 旧口径任务记录夹具

由当时的 `writeSubmission` 实际写出（不是手写）：在对应提交的源码树里跑 `prepareJob` → `writeJob`，
画板为「图1 带一个区域（高亮叠加）+ 图2」，取写出的 `task.json` 原样保存。

| 文件 | 来源提交 | 口径 |
| --- | --- | --- |
| `pre-113.task.json` | `140c3d9`（#113 `6a81935` 的父提交） | `send_text` 为旧口径：叠加图占用户序号，用户提示词写「图3」指第二张用户图；`references[]` 无 `fitted` |
| `pre-116.task.json` | `cd647d2`（#116 `5b8e203` 的父提交） | `send_text` 已是用户序号换算后的新口径；`references[]` 无 `fitted` |

参考图快照（`reference-N.png`）由测试另行放入内存文件系统。
