// e2e 下 @tauri-apps/plugin-http 的替身：直接用浏览器 fetch，网关由 page.route 伪造。
export const fetch = globalThis.fetch.bind(globalThis);
