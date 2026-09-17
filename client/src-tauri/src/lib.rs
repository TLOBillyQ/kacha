//! Tauri 壳：只承担日志器、凭据库、单实例、文件系统原子写与系统对话框等原生职责；业务逻辑在前端 TypeScript（规格第 2 节）。

mod board_pack;
mod diagnostics;
mod image_info;
mod logger;
mod redact;
mod secret;
mod store;
#[cfg(windows)]
mod webview2;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager};

const UI_STATE_FILE: &str = "ui-state.json";
pub(crate) const CAPABILITY_OVERRIDE_FILE: &str = "capabilities.override.json";
pub(crate) const SETTINGS_FILE: &str = "settings.json";
const MODELS_CACHE_FILE: &str = "models-cache.json";
const PRESETS_FILE: &str = "presets.json";
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
fn read_settings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    store::read_text(&app_data_dir(&app)?.join(SETTINGS_FILE)).map_err(err)
}

#[tauri::command]
fn write_settings(app: tauri::AppHandle, text: String) -> Result<(), String> {
    store::atomic_write(&app_data_dir(&app)?.join(SETTINGS_FILE), text.as_bytes()).map_err(err)
}

#[tauri::command]
fn read_models_cache(app: tauri::AppHandle) -> Result<Option<String>, String> {
    store::read_text(&app_data_dir(&app)?.join(MODELS_CACHE_FILE)).map_err(err)
}

#[tauri::command]
fn write_models_cache(app: tauri::AppHandle, text: String) -> Result<(), String> {
    store::atomic_write(&app_data_dir(&app)?.join(MODELS_CACHE_FILE), text.as_bytes()).map_err(err)
}

#[tauri::command]
fn read_presets(app: tauri::AppHandle) -> Result<Option<String>, String> {
    store::read_text(&app_data_dir(&app)?.join(PRESETS_FILE)).map_err(err)
}

#[tauri::command]
fn write_presets(app: tauri::AppHandle, text: String) -> Result<(), String> {
    store::atomic_write(&app_data_dir(&app)?.join(PRESETS_FILE), text.as_bytes()).map_err(err)
}

/// 前端写日志的唯一入口；日志器未就绪（app-data 目录不可用）时静默丢弃。
#[tauri::command]
fn log_event(logger: tauri::State<Option<logger::Logger>>, kind: String, fields: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    match logger.inner() {
        Some(l) => l.log(&kind, &fields),
        None => Ok(()),
    }
}

fn diagnostic_sources(app: &tauri::AppHandle, output_root: Option<String>, open_boards: Vec<String>) -> Result<diagnostics::Sources, String> {
    Ok(diagnostics::Sources {
        app_data_dir: app_data_dir(app)?,
        output_root: output_root.map(PathBuf::from),
        open_boards: open_boards.into_iter().map(PathBuf::from).collect(),
    })
}

#[tauri::command]
fn diagnostics_preview(app: tauri::AppHandle, output_root: Option<String>, open_boards: Vec<String>) -> Result<Vec<diagnostics::PackageEntry>, String> {
    Ok(diagnostics::preview(&diagnostic_sources(&app, output_root, open_boards)?))
}

/// 导出诊断包；include = 用户勾选的可选条目名。返回实际打包的条目。
#[tauri::command]
fn diagnostics_export(
    app: tauri::AppHandle,
    output_root: Option<String>,
    open_boards: Vec<String>,
    target: String,
    include: Vec<String>,
) -> Result<Vec<diagnostics::PackageEntry>, String> {
    let version = app.package_info().version.to_string();
    diagnostics::export(&diagnostic_sources(&app, output_root, open_boards)?, Path::new(&target), &include, &version).map_err(err)
}

/// 画板包导出 / 导入的取消标记；同一时间只有一个模态进度，开始时复位。
#[derive(Default)]
struct PackCancel(AtomicBool);

#[derive(Clone, Serialize)]
struct PackProgress {
    done: u64,
    total: u64,
}

fn emit_pack_progress(app: &tauri::AppHandle) -> impl Fn(u64, u64) + '_ {
    move |done, total| {
        let _ = app.emit("board-pack-progress", PackProgress { done, total });
    }
}

#[tauri::command(async)]
fn board_pack_export(
    app: tauri::AppHandle,
    cancel: tauri::State<'_, PackCancel>,
    output_root: String,
    target: String,
    spec: board_pack::ExportSpec,
) -> Result<board_pack::ExportReport, String> {
    cancel.0.store(false, Ordering::Relaxed);
    board_pack::export(Path::new(&output_root), &spec, Path::new(&target), &emit_pack_progress(&app), &cancel.0).map_err(err)
}

#[tauri::command(async)]
fn board_pack_inspect(pack: String) -> Result<board_pack::Inspected, String> {
    board_pack::inspect(Path::new(&pack)).map_err(err)
}

#[tauri::command(async)]
fn board_pack_import(app: tauri::AppHandle, cancel: tauri::State<'_, PackCancel>, pack: String, output_root: String) -> Result<board_pack::ImportReport, String> {
    cancel.0.store(false, Ordering::Relaxed);
    board_pack::import(Path::new(&pack), Path::new(&output_root), &emit_pack_progress(&app), &cancel.0).map_err(err)
}

#[tauri::command]
fn board_pack_cancel(cancel: tauri::State<PackCancel>) {
    cancel.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn secret_get() -> Result<Option<String>, String> {
    secret::get()
}

#[tauri::command]
fn secret_set(key: String) -> Result<(), String> {
    secret::set(&key)
}

#[tauri::command]
fn secret_delete() -> Result<(), String> {
    secret::delete()
}

/// 原始字节直接走 IPC 响应体，不经 JSON 数组编码。
#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(err)
}

/// 请求体是原始字节，目标路径放在 `x-path` 头（百分号编码，头部只能是 ASCII）；目标已存在时拒绝。
#[tauri::command]
fn write_new_file(request: tauri::ipc::Request) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("请求体必须是二进制".into());
    };
    let header = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("缺少目标路径")?;
    let path = percent_encoding::percent_decode_str(header).decode_utf8().map_err(err)?;
    store::write_new_file(Path::new(path.as_ref()), bytes).map_err(err)
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    is_dir: bool,
}

/// 重新定位在输出根目录内搜索时逐层列目录；不跟随符号链接进目录。
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    std::fs::read_dir(&path)
        .map_err(err)?
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Ok(DirEntry { name: entry.file_name().to_string_lossy().into_owned(), is_dir })
        })
        .collect()
}

#[tauri::command]
fn is_file(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
fn inspect_image(path: String) -> Result<image_info::ImageInfo, String> {
    image_info::inspect(Path::new(&path)).map_err(err)
}

pub fn run() {
    #[cfg(windows)]
    if tauri::webview_version().is_err() {
        webview2::explain_missing();
        return;
    }
    tauri::Builder::default()
        .manage(OpenedPaths::default())
        .manage(PackCancel::default())
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
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            let version = app.package_info().version.to_string();
            let logger = app.path().app_data_dir().ok().map(|dir| logger::Logger::new(dir, version));
            if let Some(l) = &logger {
                let _ = l.log("system", &serde_json::json!({"message": "启动", "os": std::env::consts::OS, "arch": std::env::consts::ARCH}).as_object().cloned().unwrap_or_default());
            }
            app.manage(logger);
            Ok(())
        })
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
            read_settings,
            write_settings,
            read_models_cache,
            write_models_cache,
            read_presets,
            write_presets,
            log_event,
            diagnostics_preview,
            diagnostics_export,
            board_pack_export,
            board_pack_inspect,
            board_pack_import,
            board_pack_cancel,
            secret_get,
            secret_set,
            secret_delete,
            read_file_bytes,
            write_new_file,
            list_dir,
            is_file,
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
