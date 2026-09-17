//! 启动时 WebView2 运行时缺失的说明（规格第 13 节）：Win10 21H2+ / Win11 均预装，缺失时 Tauri 窗口无法创建，
//! 只能用系统原生对话框解释，并可直接打开官方下载页。

use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONERROR, MB_YESNO, SW_SHOWNORMAL};

pub const DOWNLOAD_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn explain_missing() {
    let text = wide(&format!(
        "本机缺少 Microsoft Edge WebView2 运行时，UGC AI 生图工具无法启动。\n\n\
         请从微软官方下载并安装「Evergreen Bootstrapper」后重新打开本工具：\n{DOWNLOAD_URL}\n\n\
         现在打开下载页吗？"
    ));
    let caption = wide("UGC AI 生图工具：缺少 WebView2");
    // SAFETY：两个字符串都以 NUL 结尾且在调用期间存活；无父窗口。
    let answer = unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_YESNO | MB_ICONERROR) };
    if answer == IDYES {
        let (verb, url) = (wide("open"), wide(DOWNLOAD_URL));
        // SAFETY：同上，参数为 NUL 结尾的宽字符串或空指针。
        unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), url.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    }
}
