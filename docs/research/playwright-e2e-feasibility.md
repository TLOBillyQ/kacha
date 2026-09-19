# 用 Playwright 自动化手测清单的可行性（2026-09-19）

> 范围：`client/` 桌面客户端（Tauri 2 + React 19 + @xyflow/react 12.11.6 + Vite 8），主平台 macOS。手测清单来自近期 PR 附带的接线验收项（ADR 0014 写明「`ui/` 无 jsdom 测试，接线靠 PR 附的手测清单兜底」）。
> 来源：Playwright 官方文档、Tauri v2 官方文档与 tauri-apps 仓库、WebdriverIO 官方文档与 `webdriverio/desktop-mobile` 源码（2026-09-19 浅克隆，`94cba50`）、React Flow 官方文档与 `xyflow/xyflow` 仓库（`0a1f957`），以及本仓库 `client/node_modules` 里实际安装版本的源码（`@tauri-apps/api` 2.11.1、`plugin-http` 2.6.1、`plugin-dialog` 2.7.3）。标「推测」的没有找到一手来源。
> 本文不装依赖、不改代码。

## 1. 结论

1. **Playwright 不能直接驱动 macOS 上的 Tauri 应用。** Playwright 只能用 CDP 挂到已经在跑的浏览器上，且 CDP 连接「只支持 Chromium 系浏览器」；它的 WebKit 是自己打过补丁的构建，不是系统 WKWebView。所以只有 Windows 的 WebView2 能被 Playwright 原生接管。macOS 上可行的真应用 e2e 是 WebdriverIO 的 `@wdio/tauri-service`，配合嵌进应用的 `tauri-plugin-wdio-webdriver`。Tauri 官方文档现在推荐这条路，但它由 WebdriverIO 维护，不是 tauri-apps。tauri-apps 自己的 `tauri-driver` 在 macOS 上仍然不可用（#7068 从 2023 年开到现在）。
2. **推荐做法：让 Playwright 跑 Vite dev server，同时在页面里整体替换 Tauri IPC。** 本仓库的接缝很集中：前端对壳的调用全部经过 `window.__TAURI_INTERNALS__.invoke`，包括 `shell/ipc.ts` 的直通表、dialog / http / opener 三个插件、event、window、webview、app。所以在页面里注入一个「假壳」，就能在不改业务代码的前提下跑完整个 React 界面。有两个细节要自己处理：官方 `mockIPC` 会丢掉 `invoke` 的第三个参数，而 `write_new_file` 的路径就放在 header 里；`plugin-http` 是四条命令组成的流式协议。
3. **React Flow 在 Playwright 里能正常操作。** 官方推荐用 Playwright 或 Cypress 做 e2e，xyflow 仓库自己的 e2e 也用 Playwright，写法是 `page.mouse.down/move/up` 加 `.react-flow__node[data-id=…]` 定位。拉连线可以用 Handle 上的 `data-handleid` / `data-nodeid` 定位。
4. **手测清单 26 条的归类：(a) 可在「Vite + 假壳」下由 Playwright 自动化 12 条；(b) 主体已经被或应该被 core 的 vitest 覆盖 13 条；(c) 必须用真 Tauri、真系统，仍需手测 1 条。** 另外，(a) 里有 3 条的「真实环境那一半」需要发版前冒烟，见第 5 节。
5. **最小落地**：加 `@playwright/test`，加一个 e2e 专用入口 `client/e2e/app.html`（先装假壳，再 `import` 真正的 `main.tsx`）和一个 `vite.e2e.config.ts`（另开端口），测试放在 `client/e2e/*.spec.ts`。假壳大约 300–500 行，主要维护成本在它与 Rust 命令契约的同步上。

## 2. Playwright 能否驱动真实的 Tauri webview

| 平台 / 途径 | 能否用 Playwright | 依据 |
|---|---|---|
| Windows WebView2 + CDP | **能**。设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，然后 `chromium.connectOverCDP('http://localhost:9222')` | [Playwright: WebView2](https://playwright.dev/docs/webview2)；Tauri 窗口配置 `additionalBrowserArgs` 也能传同样的参数，schema 描述是「Defines additional browser arguments on Windows」（本地 `client/node_modules/@tauri-apps/cli/config.schema.json`） |
| macOS WKWebView + CDP | **不能**。CDP「only supported for Chromium-based browsers」 | [Playwright: BrowserType.connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) |
| macOS 用 Playwright 自带 WebKit 挂系统 WKWebView | **不能**。Playwright 的 WebKit「derived from the latest WebKit main branch sources」，并且「doesn't work with the branded version of Safari since it relies on patches」，也就不存在挂接系统 WKWebView 的途径 | [Playwright: Browsers](https://playwright.dev/docs/browsers) |
| macOS `tauri-driver`（tauri-apps 官方） | **不支持**。文档原话：「only Windows and Linux are supported on desktop, as macOS has no WKWebView driver tool available」 | [Tauri: WebDriver](https://v2.tauri.app/develop/tests/webdriver/)；[tauri#7068「MacOSX Support for tauri-driver」](https://github.com/tauri-apps/tauri/issues/7068) 仍然开着；[tauri#15295「tauri-driver: add macOS scaffold and design doc」](https://github.com/tauri-apps/tauri/pull/15295)（2026-04 开的 PR，未合并） |
| macOS WebdriverIO `@wdio/tauri-service` + `tauri-plugin-wdio-webdriver`（嵌入式 WebDriver 服务器） | **能用 WebdriverIO，不能用 Playwright**。Tauri 文档：「by default the service runs an embedded WebDriver server inside your app … and this is how macOS is supported」。这段是 2026-06-29 的 tauri-docs 提交 [`713ca27`](https://github.com/tauri-apps/tauri-docs/commit/713ca27667)（#3922）改成推荐 wdio 的 | [Tauri: WebDriver](https://v2.tauri.app/develop/tests/webdriver/)；[Tauri: Tests](https://v2.tauri.app/develop/tests/)；[WebdriverIO: Tauri](https://webdriver.io/docs/desktop-testing/tauri)；[Plugin Setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup)；[Platform Support](https://webdriver.io/docs/desktop-testing/tauri/platform-support) |
| macOS 第三方 `tauri-plugin-playwright`（srsholmes） | 只是「Playwright-compatible API」，不是 Playwright 本身。它通过 Unix socket 在 webview 里执行 JS，README 自己也说「Standard Playwright integration is impossible on macOS and Linux」 | [srsholmes/tauri-playwright README](https://github.com/srsholmes/tauri-playwright/blob/main/README.md)；crate 0.4.1，最近发布于 2026-06 |

### 2.1 `tauri-plugin-wdio-webdriver` 在 macOS 上怎么工作（源码）

- 它 fork 自 [Choochmeque/tauri-plugin-webdriver](https://github.com/Choochmeque/tauri-plugin-webdriver)。在应用进程里起一个 axum HTTP 服务器，实现 W3C WebDriver 端点。macOS 实现（`packages/tauri-plugin-webdriver/src/platform/macos.rs`）通过 `WKWebView.evaluateJavaScript` / `callAsyncJavaScript` 执行脚本，截图走原生 API。版本 1.4.0，crates.io 最近发布于 2026-09-06。
- **输入事件是 JS 合成的**：`src/platform/executor.rs` 的指针动作用 `document.elementFromPoint` 找到元素，再 `dispatchEvent(new MouseEvent('mousedown'|'mouseup'|'mousemove'|'click'))`，**不会发 `pointerdown` / `pointermove`**。对本项目的影响（据源码推断）：
  - React Flow 的 Handle 用 `onMouseDown` 起连线（本地 `@xyflow/react/dist/esm/index.js` 的 `HandleComponent`），合成的 mouse 事件大概能用。
  - 画布框选走 `onPointerDownCapture`，悬浮信息走 `onPointerMove`（`client/src/ui/hoverInfo.tsx`），悬浮动作条走 `onPointerEnter`（`client/src/ui/ActionBar.tsx`）。这几处收不到合成的 mouse 事件，只能用 `execute` 自己派发 PointerEvent。**推测**，没有实测。
- README 明确要求它不能进生产构建：`[target.'cfg(debug_assertions)'.dependencies]` 加 `#[cfg(debug_assertions)]` 注册，并加 `wdio-webdriver:default` 权限。命令 mock 由另一个 crate `tauri-plugin-wdio` 配合前端 `import '@wdio/tauri-plugin'` 完成，原理是拦截 `invoke`（「Mocking is implemented entirely on the JavaScript side via invoke interception」）。所以即便走真应用，想测失败分支还是要 mock，原生对话框也照样绕不过去；wdio 文档没有提到怎么处理原生文件对话框。

**判断**：真应用 e2e 在 macOS 上可行，但工具链是 WebdriverIO 而不是 Playwright；它要改 Cargo 依赖、改 capabilities、在前端入口加 import；输入是合成事件，原生对话框也无能为力。对本项目来说，它比「Vite + 假壳」多出来的收益只有一样：真 Rust 命令加真 WKWebView 渲染。这部分更便宜的替代是 `cargo test`（`board_pack.rs` 11 个、`store.rs` 11 个、`image_info.rs` 7 个用例已经在覆盖）加发版冒烟。现阶段不建议引入。

## 3. 退一步：Playwright + Vite dev server + 页面内假壳

### 3.1 官方 mock 能力及其限制

- Tauri 文档把 `@tauri-apps/api/mocks`（`mockIPC` / `mockWindows` / `mockConvertFileSrc` / `clearMocks`，以及 2.7.0 起的 `shouldMockEvents`）定位为前端单元测试工具，示例用的是 Vitest + jsdom；e2e 则指向 `@wdio/tauri-service`。见 [Tauri: Mocking](https://v2.tauri.app/develop/tests/mocking/)。文档没有提 Playwright，但这些函数只是改 `window.__TAURI_INTERNALS__`，在真浏览器里一样生效。
- 读本地安装的 `@tauri-apps/api` 2.11.1 源码（`client/node_modules/@tauri-apps/api/core.js`、`mocks.js`），得到三条关键事实：
  1. 所有 `invoke(cmd, args, options)` 最后都调用 `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`（`core.js:202`），`convertFileSrc` 调用 `__TAURI_INTERNALS__.convertFileSrc`（`core.js:235`），`getCurrentWindow()` / `getCurrentWebview()` 读 `__TAURI_INTERNALS__.metadata`（`window.js:85`、`webview.js:28`）。**只要在页面脚本运行前把这个对象装好，前端就察觉不到自己不在 Tauri 里。**
  2. **`mockIPC` 的 `invoke(cmd, args, _options)` 丢掉了 `options`，回调只收到 `(cmd, args)`。** 本仓库的 `ipc.writeNewFile` 把目标路径放在 `options.headers["x-path"]` 里、请求体是原始字节（`client/src/shell/ipc.ts`）。用官方 `mockIPC` 会拿不到写入路径，所以**要自己实现 `__TAURI_INTERNALS__.invoke`**，不能直接套 `mockIPC`。
  3. `shouldMockEvents` 只转发前端自己 `emit` 的事件，不支持 `emitTo`。Rust 侧推送的事件，比如 `board-pack-progress`、`second-instance`、`tauri://drag-drop`、窗口 resize / close-requested，都得由假壳保存 `plugin:event|listen` 注册的回调 id，再由测试主动调用 `runCallback`。
- Playwright 侧可以用这些：`page.addInitScript` 在「document 创建后、任何页面脚本运行前」执行（[Page.addInitScript](https://playwright.dev/docs/api/class-page#page-add-init-script)）；`page.route` 拦截并伪造网络响应（[Mock APIs](https://playwright.dev/docs/mock)）；`webServer` 负责拉起 dev server（[Web server](https://playwright.dev/docs/test-webserver)）。

### 3.2 本仓库前端调用壳的全部接缝

用 `grep '@tauri-apps' client/src` 核对：

| 接缝 | 位置 | 假壳需要实现的 IPC 命令 |
|---|---|---|
| 自家 Rust 命令直通表 `ipc` | `client/src/shell/ipc.ts` | `app_paths`、`startup_args`、`read_board` / `write_board` / `rename_board` / `list_board_names`、`read_ui_state` / `write_ui_state`、`read_capability_override`、`inspect_image`、`read_settings` / `write_settings`、`read_models_cache` / `write_models_cache`、`log_event`、`diagnostics_preview` / `diagnostics_export`、`board_pack_export` / `entries` / `read_texts` / `import` / `cancel`、`secret_get` / `set` / `delete`、`list_dir`、`file_sha256`、`is_file`、`read_file_bytes`、`write_new_file`（路径在 `options.headers["x-path"]`，body 是 `Uint8Array`） |
| 网关 HTTP | `ipc.ts` 的 `httpFetch` → `@tauri-apps/plugin-http` | `plugin:http|fetch`（返回 rid）→ `fetch_send`（返回 `{status, statusText, url, headers, rid}`）→ 反复 `fetch_read_body`（返回字节，**最后一个字节是结束标志：1 表示结束**）/ `fetch_cancel` / `fetch_cancel_body`（`plugin-http/dist-js/index.js` 第 92–160 行） |
| 原生对话框 | `plugin-dialog` 的 `open` / `save` / `message` / `ask`（`App.tsx`、`BoardCanvas.tsx`、`useBoardPack.ts`、`SettingsPanel.tsx`、`PreviewDialog.tsx`、`DiagnosticsSection.tsx`、`useBoardSessions.ts`、`shell/saveFile.ts`） | `plugin:dialog|open`、`plugin:dialog|save`、`plugin:dialog|message`。`ask` 同样走 `message`，按钮是 `YesNo` 或自定义 `{ok, cancel}`，返回值等于 okLabel 才算「是」 |
| 外链 | `plugin-opener` 的 `openUrl`（`nodes.tsx`、`useUpdateCheck.ts`） | `plugin:opener|open_url` |
| 事件 | `listen`（`App.tsx` 的 `second-instance`，`BoardPackDialog.tsx` 的 `board-pack-progress`）、`getCurrentWebview().onDragDropEvent`（`BoardCanvas.tsx`）、`getCurrentWindow().onResized` / `onCloseRequested`（`App.tsx`） | `plugin:event|listen` / `unlisten`，外加由测试触发的回调 |
| 窗口 / 应用 | `getCurrentWindow().setSize` / `isMaximized` / `scaleFactor`，`getVersion()` | `plugin:window|*`、`plugin:app|version` |
| 图片显示 | `ipc.fileUrl` → `convertFileSrc`（`nodes.tsx`、`PreviewDialog.tsx` 的 `<img src>`） | 假壳把 `convertFileSrc` 实现为 `http://asset.localhost/<encoded path>`（与官方 `mockConvertFileSrc("windows")` 同形），再由 `page.route('http://asset.localhost/**')` 从夹具目录回文件 |

可以直接复用的现有资产：

- `shell/adapters.ts` 已经把 core 端口的真实现集中在一处，core 端口的语义就是假壳要遵守的契约。`core/testing/memoryTaskFs.ts` 的「writeNewFile 已存在即抛、readFile 缺失即抛」可以直接当作假文件系统的内核。
- `client/fixtures/output-root/`（一块画板加一个任务目录）和 `core/__fixtures__/pre-113.task.json`、`pre-116.task.json` 可以当 e2e 的初始磁盘。
- `imageCodec.ts` / `overlay.ts` 用的是浏览器自带的 `createImageBitmap` 和 canvas，在 Playwright 的 Chromium 里是真实执行的，不需要 mock。

### 3.3 网关的两种 mock 方式

- **方式一：在假壳里实现 `plugin:http|*` 四条命令。** 优点是完全不动构建。缺点是要复刻 `plugin-http` 2.6.1 的流式协议；插件升级改了协议，假壳就会悄悄失效。
- **方式二（推荐）：在 e2e 的 Vite 配置里把 `@tauri-apps/plugin-http` 别名到一个一行的 shim（`export const fetch = globalThis.fetch`）。** 网关基础地址在测试设置里填成与 dev server **同源**的路径，例如 `http://localhost:1421/gw`，避开 CORS。然后用 `page.route('**/gw/**')` 伪造网关响应，并用 `route.request().postDataJSON()` 取出真实请求体来断言「请求文本」。Playwright 的网络拦截是第一方能力（[Mock APIs](https://playwright.dev/docs/mock)）。同源这一点是为了省掉预检请求；跨源时 `route.fulfill` 能不能处理预检，本文没有核实，属于推测。

### 3.4 限制

- 测的是 Chromium（可以另开一个 Playwright WebKit project 做近似），**不是 WKWebView**。WKWebView 独有的问题测不出来，比如 canvas `toBlob` 支持哪些编码格式、`asset:` 协议、CSP（`tauri.conf.json` 生产用 `csp`，开发 `devCsp: null`）。
- 假壳就是一份 Rust 行为的手写副本。比如取消时 reject 的文案必须等于 `board_pack.rs` 的 `CANCELLED = "已取消"`，core 的 `runCancellable` 靠它区分「已取消」和「失败」。Rust 端一改，e2e 可能仍然是绿的，所以契约要另有 `cargo test` 守着。
- 原生对话框的内容只能从 `plugin:dialog|message` 的参数里断言文字，看不到真实弹窗。

## 4. React Flow 画布的可操作性

- 官方测试页原文：「we recommend to use Cypress or Playwright」，而且不需要额外配置。jsdom 下要 mock ResizeObserver、DOMMatrixReadOnly 等，还得关掉 d3-drag，这也说明在真浏览器里跑 e2e 最省事。见 [React Flow: Testing](https://reactflow.dev/learn/advanced-use/testing)。
- xyflow 仓库自己的 e2e 就是 Playwright（`tests/playwright/e2e/nodes.spec.ts` 等，[xyflow/xyflow tests/playwright](https://github.com/xyflow/xyflow/tree/main/tests/playwright)）。拖节点的写法：
  ```ts
  const node = page.locator('.react-flow__node').and(page.locator('[data-id="n1"]'));
  await node.hover(); await page.mouse.down(); await page.mouse.move(500, 500); await page.mouse.up();
  ```
- 拉连线：Handle 渲染成 `<div data-handleid data-nodeid data-handlepos class="react-flow__handle">`（本地 `@xyflow/react` 12.11.6 `index.js:1963`），起点用 `onMouseDown`。所以写法是 `hover(源 handle) → mouse.down → mouse.move(目标 handle 中心, {steps: 5}) → mouse.up`。Playwright 文档提示依赖 dragover 的页面「need at least two mouse moves」（[Input: Drag and drop](https://playwright.dev/docs/input#drag-and-drop)）；React Flow 的连线不走 HTML5 DnD，多移几步是保险做法。
- 本项目可以绕开大部分拖拽：上下文菜单、拖线建节点、悬浮动作条都有 DOM 入口。建议 spec 优先用 `role` / `aria-label` 定位（`ui/` 下已有 23 处 `aria-label`，如 `SendTextDialog` 的 `role="dialog" aria-label="查看发送文本"`），节点用 `.react-flow__node[data-id=…]` 定位。更好的做法是直接用夹具画板开场，把连线状态预先写进 `.ugcboard.json`，拖拽只留给专门测连线交互的少数用例。
- 从 Finder 拖文件进窗口走的是 Tauri 的 `tauri://drag-drop` 事件，不是 DOM drop，只能由假壳 emit 模拟。

## 5. 手测清单逐条归类

归类口径：(a) 可在「Vite + 假壳」下由 Playwright 自动化，风险在界面接线；(b) 逻辑是纯的，已被 core vitest 覆盖或应该下沉到那里，e2e 最多加一条冒烟；(c) 只有真 Tauri 或真系统才有意义，仍需手测。「已覆盖」以 `client/src/core/*.test.ts` 的用例名为证。

| # | 手测项 | 类 | 理由 / 现有覆盖 |
|---|---|---|---|
| 1 | 带区域的图片编辑：「查看发送文本」、`task.json` 的 `send_text`、请求文本三者一致 | a | core 已证 `task.json` 与请求一致（`run.test.ts`「用户序号换算：task.json 存用户原文与换算后的发送文本，请求文本与之一致」），也已证二次确认与任务视图同源（`taskView.test.ts`「节点标红 ≡ 运行被拦」）。剩下的风险是 UI 接线，e2e 可以一次对照三者：对话框文本、假壳 `write_new_file` 写出的 `task.json`、`page.route` 截到的请求体。**注意**：诊断日志会脱敏 `send_text`（`src-tauri/src/redact.rs` 的测试断言 `extra.send_text` 被替换），日志里本来就不该出现发送文本，这一项里的「诊断日志」应理解为实际请求体（推测） |
| 2 | 模型下架后二次确认显示「模型不可用，无法生成发送文本」 | a | 分支在 `ui/SendTextDialog.tsx:57`；core 只证了「没有发送计划」（`submission.test.ts`「模型不在能力表内：没有发送计划，任务标红」）。e2e 用 `read_capability_override` 或模型缓存让模型下架即可 |
| 3 | 新建空任务不标红 | b | `taskView.test.ts`「正向提示词未连接：未就绪」「正向提示词为空：未就绪」，未就绪不标红是 CONTEXT 定义的规则。e2e 冒烟可以顺带看一次节点有没有标红的 class |
| 4 | 选请求形态未接入的模型，节点标红 | b | `taskView.test.ts`「请求形态尚未接入：错误」，`submission.test.ts`「标红任务列出原因：…请求形态未接入…」 |
| 5 | 英文提示词 + 参考图 + 英文序号未验证的模型，出现黄色提示 | b | `taskView.test.ts`「英文提示词 + 参考图 + 英文序号未验证的模型：黄色警告，不阻断」，`submission.test.ts`「英文序号未验证的模型：英文提示词带参考图时提示」 |
| 6 | 透明背景开关置灰 / 提示（0 或 2 条图片线、源图无透明通道、有透明通道、打开后条件变坏） | b | `taskView.test.ts`「任务开关的可用性」用 `it.each` 穷举了线数 × 透明通道；「打开后条件变坏」对应「可开为假 ⇔ 打开后必有对应原因」，也有标红用例。透明通道的判定在 Rust `image_info.rs`（含 `webp_alpha_via_vp8x_flag` 等 7 个用例）。开关置灰的渲染可放进 e2e 冒烟 |
| 7 | 单个标红任务点运行，提示「无法运行：…」 | b | `submission.test.ts`「恰好一个标红任务：提示第一条原因」「…多条原因：追加『等另外 N 项』」。e2e 冒烟断言 toast 就够 |
| 8 | 旧任务「重新生成」 | b | `run.test.ts`「重新生成旧 task.json（按旧口径存的 send_text）…」，`taskDir.test.ts`「读回旧任务目录（真实旧夹具）」用了 `core/__fixtures__/pre-113` / `pre-116`。e2e 也可以拿这两个夹具做一条冒烟 |
| 9 | 画板包导入：正常 | a | core（`boardPack.test.ts`「成功：先复位取消再进入进度再导入…」）和 Rust（`import_moves_units_only_then_is_idempotent`）两侧都有；缺的是对话框 → 进度 → 打开新画板 → toast 这条接线 |
| 10 | 画板包导入：包版本较新 | b | `boardPack.test.ts`「包版本更高：不写任何文件，不进入进度，日志记 newer」。界面上只是一个 `message` 对话框（`useBoardPack.ts:81`） |
| 11 | 画板包导入：损坏 | b | `boardPack.test.ts`「包损坏（布局不合法或读不了条目）…」「清单缺失 / 损坏…」 |
| 12 | 画板包导入：进度中取消 | a | core 已证「导入中取消：返回 cancelled，已移入的任务目录保留，不写画板」，Rust 已证 `cancelled_import_cleans_temp_dir_and_writes_nothing`。缺的是 `board-pack-progress` 事件 → 进度条 → 取消按钮 → `board_pack_cancel(true)` 这条接线。做法是假壳让 `board_pack_import` 挂起，等到取消后 reject `"已取消"` |
| 13 | 画板包导入：冲突 | b | `boardPack.test.ts`「只按任务目录计导入与跳过数；参考图冲突也列出」，Rust 有 `differing_identity_is_a_conflict_and_not_overwritten` |
| 14 | 画板包导入：写画板失败 | b | `boardPack.test.ts`「第 2 个画板写失败：第 1 个保留、第一个失败即停…」 |
| 15 | 画板包导出 | a | 导出计划由 core 覆盖（`boardPack.test.ts`「导出计划」6 条），zip 写出由 Rust 覆盖（`export_writes_texts_dirs_and_files_storing_images`）。e2e 断言 `save` 对话框 → `board_pack_export` 参数 → toast |
| 16 | 画板包导出中取消 | a | 同 #12，Rust 有 `cancelled_export_leaves_no_file` |
| 17 | 运行前缺图判定 | b | `submission.test.ts`「运行前事实采集：逐张探测参考图…探测抛任何错（缺失或不可解码）都算缺失」，`taskView.test.ts`「参考图文件缺失」 |
| 18 | 运行前透明通道判定 | b | 同 #6，外加 `submission.test.ts`「透明背景：二次确认标红」；解析本身在 Rust `image_info.rs` |
| 19 | 重开画板后显示失败 / 已取消 / 已中断徽标 | a | 规则已由 `submission.test.ts`「已存状态」覆盖。需要验证的是关标签 → 再打开 → `useStoredStatuses` 读 `outcome.json` → 徽标渲染（`nodes.tsx:378`）。假壳的内存文件系统预置 `outcome.json` 即可 |
| 20 | 中断日志只记一次 | a | 去重逻辑在 `ui/context.ts` 的模块级 `loggedInterrupted` Set，**core 测不到**（core 只证「产出一条事件」）。e2e 统计假壳收到的 `log_event` 次数，同时反复关开画板。**更好的做法是把去重下沉到 core 转成 (b)**，需要单独开 issue |
| 21 | 设置：保存密钥（写进系统凭据库） | c | `secret.rs` 没有测试，真正要验证的是 macOS Keychain 的读写、权限弹窗和重启后仍在。假壳下只能验 UI 调了 `secret_set` |
| 22 | 设置：测试连接成功 / 失败 | a | `settings.test.ts`「刷新模型列表」覆盖了成功、失败回落缓存和日志。e2e 用 `page.route` 回 200 或 401 / 超时，断言界面文案。连真网关放到发版冒烟 |
| 23 | 设置文件较新时只存密钥 | b | `settings.test.ts`「文件由更新版本写入（newer）时不写 settings.json，但仍存密钥」「更新版本拒开…界面禁止覆盖保存」 |
| 24 | 系统凭据库不可用时显示「会话内保存」 | a | 逻辑见 `settings.test.ts`「凭据库 set 抛错时密钥退回会话内存（session）」。e2e 让假壳的 `secret_set` reject，断言界面文案。真实的凭据库不可用在 macOS 上很难构造，不值得手测 |
| 25 | 重定位参考图：自动查找 | a | `relocate.test.ts` 覆盖了按 sha256 / task_id 查找；e2e 验证菜单 → 找到 → 节点恢复，假壳的 `list_dir` / `file_sha256` 从内存文件系统出结果 |
| 26 | 重定位参考图：手动选择 | a | `plugin:dialog|open` 返回预置路径即可 |

计数：**(a) 12 条**（1、2、9、12、15、16、19、20、22、24、25、26），**(b) 13 条**（3–8、10、11、13、14、17、18、23），**(c) 1 条**（21）。

另有一张发版前冒烟清单（真 Tauri + 真网关，每次发版手点一遍，不必每个 PR 都做）：#21 真 Keychain；#22 连真网关测试连接；#1 的一次真实生成（请求真的发出、结果真的落盘）；#15 导出的 zip 在另一台机器上导入；原生文件对话框和从 Finder 拖入。

## 6. 推荐方案与最小落地步骤

**推荐**：Playwright + Vite dev server + 页面内假壳，只覆盖 (a) 类；(b) 类继续放在 vitest，把 #20 的去重下沉到 core；(c) 类和真环境部分进发版冒烟清单。WebdriverIO 真应用 e2e 暂不引入，等以后真出现只有 WKWebView 才有的回归再评估。

最小步骤：

1. **依赖**：`client/` 下加开发依赖 `@playwright/test`（npm 上的 latest 是 1.63.0），执行 `npx playwright install chromium`（可选再装 webkit）。
2. **目录**：
   ```
   client/
     playwright.config.ts        # webServer: vite --config vite.e2e.config.ts, port 1421
     vite.e2e.config.ts          # 继承 vite.config.ts；alias '@tauri-apps/plugin-http' → e2e/shim/http.ts；端口 1421，避开 tauri dev 的 1420
     e2e/
       app.html                  # <script type="module" src="./harness.ts">
       harness.ts                # 装 window.__TAURI_INTERNALS__（invoke / transformCallback / runCallback / convertFileSrc / metadata），再 import('../src/main.tsx')
       fakeShell/                # 按 ipc.ts 的命令表实现：内存文件系统（复用 memoryTaskFs 语义）、settings / secret / uiState / log 记录、board_pack_* 可挂起可取消、dialog 队列
       shim/http.ts              # export const fetch = globalThis.fetch
       fixtures/                 # 复用 client/fixtures/output-root 与 core/__fixtures__
       sendText.spec.ts
   ```
   `app.html` 只在 dev server 下可访问；生产 `vite build` 的入口仍然只有 `index.html`，假壳不会进包。
3. **测试如何控制假壳**：`harness.ts` 暴露 `window.__e2e`，提供 `seedFiles`、`queueDialog`、`emit(event, payload)`、`calls(cmd)`、`fail(cmd, error)`。spec 通过 `page.evaluate` 调用；需要在页面脚本运行前完成的预置用 `page.addInitScript` 写入。
4. **示例 spec 轮廓**（清单 #1）：
   ```ts
   test("带区域任务：查看发送文本 ≡ task.json.send_text ≡ 请求体", async ({ page }) => {
     let body: any;
     await page.route("**/gw/**", async (route) => {
       if (route.request().method() === "POST") body = route.request().postDataJSON();
       await route.fulfill({ json: /* 契约夹具里的成功响应 */ });
     });
     await page.route("http://asset.localhost/**", (r) => r.fulfill({ path: fixturePath(r.request().url()) }));
     await page.addInitScript(seedBoard, { board: "带区域任务.ugcboard.json", baseUrl: "http://localhost:1421/gw" });
     await page.goto("/e2e/app.html");

     const task = page.locator('.react-flow__node[data-id="t"]');
     await task.click({ button: "right" });
     await page.getByRole("menuitem", { name: "查看发送文本" }).click();   // 以实际 role 为准
     const shown = await page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text").innerText();
     await page.keyboard.press("Escape");

     await page.getByRole("button", { name: "运行" }).click();            // 单个干净任务直接提交
     await expect.poll(() => body).toBeTruthy();
     const taskJson = await page.evaluate(() => window.__e2e.readJson("**/task.json"));
     expect(taskJson.send_text).toBe(shown);
     expect(extractPrompt(body)).toBe(shown);                              // 按模型请求形态取字段
   });
   ```
5. **CI**：本仓库在 Gitea 上，spec 不依赖 Tauri 和 Rust，Linux runner 上装好 Chromium 就能跑，比 cargo 构建轻得多。

### 维护成本与风险

- **假壳与 Rust 契约漂移**（主要风险）：参数名、返回形状、错误文案（例如 `"已取消"`）一旦改了，假壳不会自动跟着变。缓解办法：假壳直接 import `shell/ipc.ts` 导出的类型（`AppPaths`、`ImageInfo`、`PackageEntry` 等），让 TS 编译期对齐形状；错误文案之类的常量在假壳里集中写一次，并注明对应的 Rust 位置。
- **插件协议漂移**：dialog 的 `ask` 走 `message`、返回值要等于按钮标签，这类细节会随插件版本变化。http 用 shim 别名后就不受协议影响。
- **选择器脆弱**：现有 `aria-label` 只有 23 处，写 spec 时可能需要补一些 `aria-label` 或 role。这是对 `ui/` 的小改动，同时也改善了可访问性。
- **覆盖错觉**：e2e 是绿的，不代表 macOS 真机没问题（WKWebView 渲染、`asset:` 协议、CSP、Keychain、原生对话框）。发版冒烟清单必须保留。
- **成本估计（推测）**：假壳首版约 300–500 行 TS，12 条 (a) 类 spec 各 30–80 行。之后每新增一条 Rust 命令，假壳要同步加一个分支。

## 7. 一手来源没有覆盖的点

- `tauri-plugin-wdio-webdriver` 的合成 MouseEvent 对 React Flow 框选、悬浮等 pointer 事件无效：这是从源码推断的，没有实测。
- `page.route` 在跨源、带自定义头的 POST 下能否处理 CORS 预检：没有核实，所以方案改用同源地址规避。
- `page.exposeFunction` 传 `Uint8Array` 时的序列化形态：文档只说参数要可序列化，没有细说。方案把文件系统放在页面内，不走这条路。
- 手测清单里「诊断日志里的请求文本」具体指什么：代码表明本地日志会脱敏 `send_text`，这里按「实际请求体」理解，属于推测。
- WKWebView 与 Chromium 在 canvas 编码（如 webp）上的差异对 `imageCodec.ts` 的影响：没有查到一手对照资料。

## 来源

- Playwright：[BrowserType](https://playwright.dev/docs/api/class-browsertype)、[WebView2](https://playwright.dev/docs/webview2)、[Browsers](https://playwright.dev/docs/browsers)、[Page](https://playwright.dev/docs/api/class-page)、[Mock APIs](https://playwright.dev/docs/mock)、[Web server](https://playwright.dev/docs/test-webserver)、[Input](https://playwright.dev/docs/input)
- Tauri：[Tests](https://v2.tauri.app/develop/tests/)、[WebDriver](https://v2.tauri.app/develop/tests/webdriver/)、[Mocking](https://v2.tauri.app/develop/tests/mocking/)、[tauri-docs `713ca27`](https://github.com/tauri-apps/tauri-docs/commit/713ca27667)、[tauri#7068](https://github.com/tauri-apps/tauri/issues/7068)、[tauri#15295](https://github.com/tauri-apps/tauri/pull/15295)；本地源码 `client/node_modules/@tauri-apps/api/{core,mocks,event,window,webview}.js`、`plugin-http/dist-js/index.js`、`plugin-dialog/dist-js/index.js`、`@tauri-apps/cli/config.schema.json`
- WebdriverIO：[Tauri](https://webdriver.io/docs/desktop-testing/tauri)、[Plugin Setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup)、[Usage Examples](https://webdriver.io/docs/desktop-testing/tauri/usage-examples)、[Platform Support](https://webdriver.io/docs/desktop-testing/tauri/platform-support)、[webdriverio/desktop-mobile](https://github.com/webdriverio/desktop-mobile)（`packages/tauri-plugin-webdriver`）、[Choochmeque/tauri-plugin-webdriver](https://github.com/Choochmeque/tauri-plugin-webdriver)
- 第三方参考：[srsholmes/tauri-playwright](https://github.com/srsholmes/tauri-playwright)
- React Flow：[Testing](https://reactflow.dev/learn/advanced-use/testing)、[xyflow/xyflow tests/playwright](https://github.com/xyflow/xyflow/tree/main/tests/playwright)；本地 `client/node_modules/@xyflow/react/dist/esm/index.js`

## 已落地（2026-09-19）

按第 6 节的推荐方案落地于 `client/e2e/`，`npm run test:e2e` 运行（Vite 开发服务器 1421 端口，Chromium）：

- `e2e/harness.ts`：页面内假壳，内存文件系统实现 `ipc.ts` 全部命令、对话框 / 事件 / 窗口插件；`convertFileSrc` 直接返回 blob URL（未采用 3.2 节的 `asset.localhost` 路由）。`@tauri-apps/plugin-http` 由 `vite.e2e.config.ts` 别名到浏览器 `fetch`，网关用 `page.route` 同源伪造（3.3 节的做法之一）。
- `e2e/specs/`：`task.spec.ts`（#1–#8）、`pack.spec.ts`（#9–#16）、`misc.spec.ts`（#17–#26）、`smoke.spec.ts`，共 37 条，首轮验收全部通过，未发现应用缺陷。实际把第 5 节的 (b) 类也各做了一条 UI 冒烟。
- 验收中发现的口径不一致：测试连接失败只显示网关原文、不带错误类别，见 #129。
- 仍需手测：#21 的真 Keychain；真实 zip 读写、真网关由 Rust 单测与发版冒烟承担。
