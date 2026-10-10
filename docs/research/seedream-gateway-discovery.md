# 当前团队网关 Seedream 模型发现

研究票：[补齐当前网关 Flash/Lite 模型发现与渠道退役事实](https://github.com/TLOBillyQ/kacha/issues/9)。

## 16:28 首次发现（历史快照）

2026-10-09 16:28:34（UTC+8），使用 Kacha 已保存的 Windows 通用凭据，仅调用一次 `GET http://lzxsvn:3001/v1/models`，收到 HTTP 200。凭据读取目标来自 `client/src-tauri/src/secret.rs` 的 `ugc-image-tool`；密钥只在内存中使用，未记录鉴权头或密钥。

证据来源为本次团队网关实际响应的 `data[].id`，完整发现集合如下：

```json
{
  "collected_at": "2026-10-09T08:28:34.7884714+00:00",
  "base_url": "http://lzxsvn:3001",
  "method": "GET",
  "path": "/v1/models",
  "http_status": 200,
  "model_ids": [
    "deepseek-flash",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "doubao-seedream-5-0-lite-260128",
    "doubao-seedream-5-0-pro-260628",
    "kimi/kimi-k3",
    "qwen-image-3.0",
    "qwen-image-3.0-pro",
    "qwen3.8-flash",
    "qwen3.8-max",
    "ZHIPU/GLM-5.3",
    "ZHIPU/GLM-5.3-Flash",
    "ZHIPU/GLM-5.3-FlashX"
  ]
}
```

该时间点的结论（Flash 不可发现已被下方 17:15 复查更新）：

- 当前调用者可发现 `doubao-seedream-5-0-lite-260128` 与 `doubao-seedream-5-0-pro-260628`。
- 本次发现集合没有 `doubao-seedream-5-0-flash-260915`，也没有其他 Seedream Flash ID；Flash 对当前凭据的模型发现为 unavailable。这不证明其他渠道未配置或管理员未配置 Flash。
- 模型发现只证明列表可见性，不证明 Lite/Pro 仍可生成，也不证明实际供应商、版本、别名映射或接入点类型。遵循 `docs/adr/0001-integrate-only-through-team-gateway.md` 与 `docs/adr/0004-use-a-local-model-capability-registry.md`，不能据此启用 Flash 模型能力。
- 本次未核实网关版本，未调用管理员接口、供应商接口或生成接口，未修改网关和产品代码。

本机 Kacha 的 `models-cache.json` 在 2026-10-09 11:00:11（UTC+8）记录相同模型集合；缓存只作旁证，上述新调用是本次发现的依据。进程、用户和机器范围均未设置 `KACHA_GATEWAY_API_KEY`、`KACHA_GATEWAY_KEY_FILE` 或 `UGC_IMAGE_TOOL_GATEWAY_API_KEY`；项目 `.scratch/gateway.key` 不存在，但这不代表系统凭据不存在。

## 17:15 复查：Flash 已可发现

用户提供了网关自身的[模型广场](http://lzxsvn:3001/pricing)。直接查看该页和 Flash 详情后，使用同一 Kacha 保存凭据，于 **2026-10-09 17:15:26（UTC+8）** 再次调用 `GET /v1/models`，HTTP 200。完整模型集合与上方首次发现相比新增：

```json
{
  "collected_at": "2026-10-09T09:15:26.1447493+00:00",
  "http_status": 200,
  "new_model_ids": ["doubao-seedream-5-0-flash-260915"],
  "seedream_model_ids": [
    "doubao-seedream-5-0-flash-260915",
    "doubao-seedream-5-0-lite-260128",
    "doubao-seedream-5-0-pro-260628"
  ]
}
```

**当前结论已更新为 Flash 对当前凭据可发现。** 16:28 的缺失是当时快照，不能继续描述为当前 unavailable。未调查列表变化原因，不推断是配置变更、刷新延迟或权限变化。

模型广场显示“本站当前已启用模型”，总计 14 个；以下为标准价格显示模式下的现场读数，定价不构成未来价格承诺：

| 完整模型 ID | 提供商展示字段 | 分组 | 端点展示字段 | 按次价格 |
| --- | --- | --- | --- | --- |
| `doubao-seedream-5-0-flash-260915` | 字节跳动 | default | openai | ¥0.12/请求 |
| `doubao-seedream-5-0-lite-260128` | 火山引擎 | default | openai | ¥0.22/请求 |
| `doubao-seedream-5-0-pro-260628` | 火山引擎 | default | openai | ¥0.60/请求 |

Flash 详情还显示 default 倍率 1x、价格 ¥0.12。这补齐了网关公开目录与当前凭据模型发现两种一手证据，但“提供商”只是页面展示字段，不能证明后台实际路由供应商或方舟接入点类型。

Flash API 页显示通用 `/v1/chat/completions` 示例（messages/temperature）及聊天参数表；列表端点筛选“图片”为 0。这些展示与 Kacha 图片生成契约需求不匹配，不能据此改用聊天端点、继承聊天参数或宣称图片生成已实测成功。页面成功率/延迟属于聚合展示，缺乏具体请求载荷与结果，不能替代本团队 Flash 图片生成夹具。

本轮仍只读查看页面及模型发现，未执行付费生成、未修改网关或产品代码。

## 仍需维护者提供的一手事实

- Flash/Lite 的脱敏渠道模型映射、实际供应商及版本，以及方舟接入点类型（如适用）。
- Lite 当期渠道服务状态、退役通知及到期处置；官方两种 Lite 拼写与本地 `-lite-` 别名的覆盖关系。
- 首次发现到复查之间模型列表变化的原因，如需追踪；当前 Flash 可发现，此项不再作为“当前不可用”的缺口。

此前官方事实及契约差异见[固定研究资产](https://github.com/TLOBillyQ/kacha/blob/9d76473dfbb09507223451c30ec2d1f20f372b1f/docs/research/seedream-flash-contract.md)。本次未重新调查官方公告，不能把此前官方调查或旧 Lite/Pro 夹具视为当前私有渠道事实。

本研究票完成标准尚未满足，应保持 open。拿到维护者资料后继续本票；[Flash 授权实测证据](https://github.com/TLOBillyQ/kacha/issues/10)及后续人工决策仍依赖本票。
