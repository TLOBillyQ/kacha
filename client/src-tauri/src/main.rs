// Windows 发布版不弹控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ugc_image_tool_lib::run()
}
