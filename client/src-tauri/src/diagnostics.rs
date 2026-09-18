//! 诊断包：导出前列清单，默认只含脱敏日志、manifest、脱敏 settings.json、能力表覆盖文件；
//! 画板文件与任务目录 task.json / outcome.json 默认排除，用户在清单里勾选后才带上（标「含提示词」）。
//! 导出时对全部内容二次脱敏，zip 在内存里组好后原子写。只读，不改任何任务或设置状态。

use std::fs;
use std::io::{self, Cursor, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::json;
use zip::write::SimpleFileOptions;

use crate::{logger, redact, store};

pub const MANIFEST_NAME: &str = "manifest.json";
use crate::{CAPABILITY_OVERRIDE_FILE, SETTINGS_FILE};
/// 可选带上的任务目录数（按任务编号倒序取最近的）。
pub const RECENT_TASK_DIRS: usize = 20;

pub struct Sources {
    /// 日志、settings.json、能力表覆盖文件所在的 app-data 目录。
    pub app_data_dir: PathBuf,
    /// 输出根目录；画板在其下「画板」目录，任务目录为 `<UTC 日期>/<task_id>/`。
    pub output_root: Option<PathBuf>,
    /// 当前打开的画板；不在输出根目录「画板」目录下的也可勾选带上。
    pub open_boards: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PackageEntry {
    /// 包内路径（正斜杠）。
    pub name: String,
    pub description: String,
    pub size: u64,
    /// 可选条目默认不勾选。
    pub optional: bool,
    pub contains_prompt: bool,
    #[serde(skip)]
    source: Option<PathBuf>,
}

#[derive(Clone, Copy)]
enum Kind {
    Log,
    Settings,
    Json,
}

fn entry(name: String, description: String, source: &Path, optional: bool) -> PackageEntry {
    let size = fs::metadata(source).map(|m| m.len()).unwrap_or(0);
    PackageEntry { name, description, size, optional, contains_prompt: optional, source: Some(source.to_path_buf()) }
}

fn sorted_dir(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut items: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    items.sort();
    items
}

fn is_date_dir(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && name.chars().filter(|c| c.is_ascii_digit()).count() == 8
}

/// 导出前的完整清单；`export` 只从这份清单里取文件。
pub fn preview(src: &Sources) -> Vec<PackageEntry> {
    let mut entries = Vec::new();
    for (index, path) in logger::segment_paths(&src.app_data_dir).iter().enumerate() {
        let name = path.file_name().unwrap().to_string_lossy();
        let description = if index == 0 { "脱敏轮转日志（最新）".to_string() } else { format!("脱敏轮转日志（较早，第 {} 段）", index + 1) };
        entries.push(entry(format!("logs/{name}"), description, path, false));
    }
    entries.push(PackageEntry {
        name: MANIFEST_NAME.into(),
        description: "诊断包说明与文件清单（导出时生成）".into(),
        size: 0,
        optional: false,
        contains_prompt: false,
        source: None,
    });
    let settings = src.app_data_dir.join(SETTINGS_FILE);
    if settings.is_file() {
        entries.push(entry(SETTINGS_FILE.into(), "高级设置（脱敏，保留网关地址，不含密钥）".into(), &settings, false));
    }
    let overrides = src.app_data_dir.join(CAPABILITY_OVERRIDE_FILE);
    if overrides.is_file() {
        entries.push(entry(CAPABILITY_OVERRIDE_FILE.into(), "能力表覆盖文件".into(), &overrides, false));
    }
    let mut boards: Vec<PathBuf> = src.output_root.iter().flat_map(|root| sorted_dir(&root.join("画板"))).map(|(_, p)| p).collect();
    for extra in &src.open_boards {
        if !boards.iter().any(|b| fs::canonicalize(b).ok() == fs::canonicalize(extra).ok()) {
            boards.push(extra.clone());
        }
    }
    let mut board_names: Vec<String> = Vec::new();
    for path in boards {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        if !name.ends_with(store::BOARD_EXTENSION) || !path.is_file() {
            continue;
        }
        // 输出根目录外的画板可能与目录内的重名：包内名加序号区分。
        let unique = (1..).map(|i| if i == 1 { name.clone() } else { format!("{i}-{name}") }).find(|n| !board_names.contains(n)).unwrap();
        entries.push(entry(format!("boards/{unique}"), format!("画板文件（{}）", path.display()), &path, true));
        board_names.push(unique);
    }
    let Some(root) = &src.output_root else { return entries };
    let mut task_dirs: Vec<(String, String, PathBuf)> = sorted_dir(root)
        .into_iter()
        .filter(|(date, path)| is_date_dir(date) && path.is_dir())
        .flat_map(|(date, path)| sorted_dir(&path).into_iter().filter(|(_, p)| p.is_dir()).map(move |(id, p)| (id, date.clone(), p)))
        .collect();
    task_dirs.sort_by(|a, b| b.0.cmp(&a.0));
    for (id, date, dir) in task_dirs.into_iter().take(RECENT_TASK_DIRS) {
        for file in ["task.json", "outcome.json"] {
            let path = dir.join(file);
            if path.is_file() {
                entries.push(entry(format!("tasks/{date}/{id}/{file}"), format!("任务记录 {id}"), &path, true));
            }
        }
    }
    entries
}

fn kind_of(name: &str) -> Kind {
    if name.starts_with("logs/") {
        Kind::Log
    } else if name == SETTINGS_FILE {
        Kind::Settings
    } else {
        Kind::Json
    }
}

/// 读源文件并二次脱敏；读不了（期间被删、非 UTF-8）记为空内容，不中断导出。
fn redacted_content(entry: &PackageEntry) -> String {
    let text = entry.source.as_ref().and_then(|p| fs::read(p).ok()).and_then(|b| String::from_utf8(b).ok()).unwrap_or_default();
    match kind_of(&entry.name) {
        Kind::Log => redact::redact_log_text(&text),
        Kind::Settings => redact::redact_settings(&text),
        Kind::Json => redact::redact_json_text(&text),
    }
}

/// 按清单导出：必含条目全带，可选条目只带 `include` 里点名的；返回实际包含的条目。
pub fn export(src: &Sources, target: &Path, include: &[String], app_version: &str) -> io::Result<Vec<PackageEntry>> {
    let chosen: Vec<PackageEntry> = preview(src).into_iter().filter(|e| !e.optional || include.contains(&e.name)).collect();
    let contents: Vec<(String, String)> =
        chosen.iter().filter(|e| e.source.is_some()).map(|e| (e.name.clone(), redacted_content(e))).collect();
    let files: Vec<_> = chosen
        .iter()
        .map(|e| {
            let size = contents.iter().find(|(n, _)| *n == e.name).map_or(0, |(_, c)| c.len());
            json!({"name": e.name, "description": e.description, "size": size, "contains_prompt": e.contains_prompt})
        })
        .collect();
    let manifest = json!({
        "schema_version": 1,
        "app_version": app_version,
        "exported_at": logger::utc_timestamp(SystemTime::now()),
        "note": "本诊断包只含下列文件，导出时已对全部内容二次脱敏；不含 API 密钥、认证头、图片与临时下载地址。标 contains_prompt 的文件由用户勾选带上，含提示词。",
        "files": files,
    });

    let mut buffer = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buffer);
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let io_err = |e: zip::result::ZipError| io::Error::other(e.to_string());
        zip.start_file(MANIFEST_NAME, options).map_err(io_err)?;
        zip.write_all(format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap_or_default()).as_bytes())?;
        for (name, content) in &contents {
            zip.start_file(name.as_str(), options).map_err(io_err)?;
            zip.write_all(content.as_bytes())?;
        }
        zip.finish().map_err(io_err)?;
    }
    store::atomic_write(target, buffer.get_ref())?;
    Ok(chosen)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    struct Fixture {
        _tmp: tempfile::TempDir,
        src: Sources,
        out: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let root = tmp.path().join("输出");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("diagnostics.log"), "{\"event\":\"system\",\"message\":\"Bearer abc\"}\n").unwrap();
        fs::write(data.join("diagnostics.1.log"), "{\"event\":\"system\"}\n").unwrap();
        fs::write(data.join("settings.json"), r#"{"format_version":1,"base_url":"http://lzxsvn:3001","api_key":"sk-abcdefghijkl"}"#).unwrap();
        fs::write(data.join("capabilities.override.json"), "{\"models\":[]}").unwrap();
        fs::write(data.join("ui-state.json"), "{}").unwrap();
        fs::create_dir_all(root.join("画板")).unwrap();
        fs::write(root.join("画板/a.ugcboard.json"), r#"{"nodes":[{"text":"一只猫"}]}"#).unwrap();
        fs::write(root.join("画板/a.ugcboard.json.bak"), "{}").unwrap();
        for (date, id) in [("2026-09-16", "20260916T010000Z-00000001"), ("2026-09-17", "20260917T010000Z-00000002")] {
            let dir = root.join(date).join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("task.json"), r#"{"prompt":"猫","url":"https://oss/x"}"#).unwrap();
            fs::write(dir.join("result.png"), [0x89, 0x50]).unwrap();
        }
        let out = tmp.path().join("导出/diag.zip");
        let elsewhere = tmp.path().join("别处");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("a.ugcboard.json"), "{}").unwrap();
        let open_boards = vec![root.join("画板/a.ugcboard.json"), elsewhere.join("a.ugcboard.json")];
        Fixture { src: Sources { app_data_dir: data, output_root: Some(root), open_boards }, out, _tmp: tmp }
    }

    fn names(entries: &[PackageEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    fn read_zip(path: &Path) -> Vec<(String, String)> {
        let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut f = archive.by_index(i).unwrap();
                let mut s = String::new();
                f.read_to_string(&mut s).unwrap();
                (f.name().to_string(), s)
            })
            .collect()
    }

    #[test]
    fn preview_lists_defaults_then_optional_prompt_files() {
        let f = fixture();
        let entries = preview(&f.src);
        assert_eq!(
            names(&entries),
            vec![
                "logs/diagnostics.log",
                "logs/diagnostics.1.log",
                "manifest.json",
                "settings.json",
                "capabilities.override.json",
                "boards/a.ugcboard.json",
                "boards/2-a.ugcboard.json",
                "tasks/2026-09-17/20260917T010000Z-00000002/task.json",
                "tasks/2026-09-16/20260916T010000Z-00000001/task.json",
            ]
        );
        assert!(entries.iter().all(|e| e.optional == e.contains_prompt));
        assert!(entries.iter().filter(|e| e.optional).all(|e| e.name.starts_with("boards/") || e.name.starts_with("tasks/")));
    }

    #[test]
    fn export_default_excludes_optional_and_redacts() {
        let f = fixture();
        let included = export(&f.src, &f.out, &[], "0.2.0").unwrap();
        assert!(included.iter().all(|e| !e.optional));
        let files = read_zip(&f.out);
        let got: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(got, vec!["manifest.json", "logs/diagnostics.log", "logs/diagnostics.1.log", "settings.json", "capabilities.override.json"]);
        let all: String = files.iter().map(|(_, c)| c.as_str()).collect();
        assert!(!all.contains("sk-abcdefghijkl") && !all.contains("Bearer abc"), "{all}");
        assert!(all.contains("http://lzxsvn:3001"));
        let manifest: serde_json::Value = serde_json::from_str(&files[0].1).unwrap();
        assert_eq!(manifest["app_version"], "0.2.0");
        assert_eq!(manifest["files"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn export_includes_only_named_optional_entries() {
        let f = fixture();
        let pick = vec!["boards/a.ugcboard.json".to_string(), "tasks/2026-09-16/20260916T010000Z-00000001/task.json".to_string(), "../ui-state.json".to_string()];
        export(&f.src, &f.out, &pick, "0.2.0").unwrap();
        let files = read_zip(&f.out);
        let task = files.iter().find(|(n, _)| n.ends_with("00000001/task.json")).unwrap();
        assert!(task.1.contains("猫") && task.1.contains("[REDACTED_URL]"), "{}", task.1);
        assert!(files.iter().any(|(n, _)| n == "boards/a.ugcboard.json"));
        assert!(!files.iter().any(|(n, _)| n.contains("ui-state") || n.contains("00000002")));
        assert!(fs::read_dir(f.out.parent().unwrap()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn works_without_output_root_or_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let src = Sources { app_data_dir: tmp.path().join("none"), output_root: None, open_boards: Vec::new() };
        assert_eq!(names(&preview(&src)), vec!["manifest.json"]);
        let out = tmp.path().join("d.zip");
        export(&src, &out, &[], "0.2.0").unwrap();
        assert_eq!(read_zip(&out).len(), 1);
    }
}
