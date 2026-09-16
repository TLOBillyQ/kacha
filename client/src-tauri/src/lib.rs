//! Tauri 壳：只承担单实例、文件系统原子写与系统对话框等原生职责；业务逻辑在前端 TypeScript（规格第 2 节）。

mod image_info;
mod store;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager};

const UI_STATE_FILE: &str = "ui-state.json";
const CAPABILITY_OVERRIDE_FILE: &str = "capabilities.override.json";
/// 与 v1 保持一致的默认输出根目录名（图片目录下）。
const DEFAULT_OUTPUT_DIR_NAME: &str = "UGC AI 生图工具";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(err)
}

#[derive(Serialize)]
struct AppPaths {
    default_output_root: String,
    app_data_dir: String,
}

#[tauri::command]
fn app_paths(app: tauri::AppHandle) -> Result<AppPaths, String> {
    let pictures = app.path().picture_dir().or_else(|_| app.path().home_dir()).map_err(err)?;
    Ok(AppPaths {
        default_output_root: pictures.join(DEFAULT_OUTPUT_DIR_NAME).to_string_lossy().into_owned(),
        app_data_dir: app_data_dir(&app)?.to_string_lossy().into_owned(),
    })
}

/// macOS 双击文件不走命令行参数，而是 `RunEvent::Opened`；前端就绪前到达的先暂存在这里。
#[derive(Default)]
struct OpenedPaths(Mutex<Vec<String>>);

/// 启动时要打开的路径：命令行参数（不含程序路径，Windows 双击即在此）+ 已暂存的系统「打开文件」事件。
#[tauri::command]
fn startup_args(opened: tauri::State<OpenedPaths>) -> Vec<String> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    args.append(&mut opened.0.lock().unwrap());
    args
}

#[tauri::command]
fn read_board(path: String) -> Result<store::BoardTexts, String> {
    store::read_board(Path::new(&path)).map_err(err)
}

#[tauri::command]
fn write_board(path: String, text: String) -> Result<(), String> {
    store::write_board(Path::new(&path), &text).map_err(err)
}

#[tauri::command]
fn rename_board(from: String, to: String) -> Result<(), String> {
    store::rename_board(Path::new(&from), Path::new(&to)).map_err(err)
}

#[tauri::command]
fn list_board_names(dir: String) -> Result<Vec<String>, String> {
    store::list_board_names(Path::new(&dir)).map_err(err)
}

#[tauri::command]
fn read_ui_state(app: tauri::AppHandle) -> Result<Option<String>, String> {
    store::read_text(&app_data_dir(&app)?.join(UI_STATE_FILE)).map_err(err)
}

#[tauri::command]
fn write_ui_state(app: tauri::AppHandle, text: String) -> Result<(), String> {
    store::atomic_write(&app_data_dir(&app)?.join(UI_STATE_FILE), text.as_bytes()).map_err(err)
}

#[tauri::command]
fn read_capability_override(app: tauri::AppHandle) -> Result<Option<String>, String> {
    store::read_text(&app_data_dir(&app)?.join(CAPABILITY_OVERRIDE_FILE)).map_err(err)
}

#[tauri::command]
fn inspect_image(path: String) -> Result<image_info::ImageInfo, String> {
    image_info::inspect(Path::new(&path)).map_err(err)
}

pub fn run() {
    tauri::Builder::default()
        .manage(OpenedPaths::default())
        // 单实例必须最先注册：第二实例把参数转交第一实例后直接退出，不用锁文件。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("second-instance", &args);
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            app_paths,
            startup_args,
            read_board,
            write_board,
            rename_board,
            list_board_names,
            read_ui_state,
            write_ui_state,
            read_capability_override,
            inspect_image,
        ])
        .build(tauri::generate_context!())
        .expect("启动 Tauri 应用失败")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths: Vec<String> = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                // 窗口已在就转发（前端对已打开的画板去重）；同时暂存，覆盖前端尚未监听的冷启动。
                _app.state::<OpenedPaths>().0.lock().unwrap().extend(paths.iter().cloned());
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.emit("second-instance", &paths);
                }
            }
        });
}
