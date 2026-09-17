//! 画板包（ADR 0013）的 zip 读写与合并导入。包格式（清单、画板路径改写、版本判定）由前端 core/boardPack.ts 决定，
//! 这里只按路径约定搬字节：包内结构照搬输出根目录，`<日期>/<task_id>/` 为任务目录，`画板/` 下是画板文件。
//!
//! 导出：流式写同目录临时文件，图片 store、JSON deflate，完成后 rename 覆盖目标。
//! 导入：先整包解压到输出根目录下的临时目录并校验，再逐个任务目录原子 rename 移入；已存在的任务目录
//! task.json 一致则跳过、不一致记冲突，均不覆盖。失败 / 取消时清理临时目录，已移入的保留。

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

use crate::store;

pub const MANIFEST_NAME: &str = "manifest.json";
pub const BOARDS_DIR: &str = "画板";
pub const CANCELLED: &str = "已取消";
const TASK_RECORD: &str = "task.json";
const CHUNK: usize = 1 << 20;

#[derive(Debug, Deserialize)]
pub struct PackFile {
    /// 本机绝对路径。
    pub source: String,
    /// 包内路径（正斜杠）。
    pub entry: String,
}

#[derive(Debug, Deserialize)]
pub struct ExportSpec {
    pub manifest: String,
    /// 包内画板路径（`画板/<文件名>`）与内容。
    pub board_entry: String,
    pub board_text: String,
    /// 相对输出根目录的任务目录；本机不存在的跳过。
    pub task_dirs: Vec<String>,
    pub files: Vec<PackFile>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ExportReport {
    pub task_dirs: usize,
    pub bytes: u64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Inspected {
    pub manifest: Option<String>,
    /// 包内画板路径 → 内容。
    pub boards: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ImportReport {
    pub imported: usize,
    pub skipped: usize,
    pub conflicts: Vec<String>,
    pub bytes: u64,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, CANCELLED)
}

fn check_cancel(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(cancelled())
    } else {
        Ok(())
    }
}

/// 包内路径只允许正斜杠分隔的普通相对段：不含 `..`、`.`、空段、反斜杠、盘符与控制字符。
fn safe_segments(name: &str) -> Option<Vec<&str>> {
    let segments: Vec<&str> = name.split('/').collect();
    let ok = !segments.is_empty()
        && segments.iter().all(|s| !s.is_empty() && *s != "." && *s != ".." && !s.chars().any(|c| c == '\\' || c == ':' || c.is_control()));
    ok.then_some(segments)
}

fn join_segments(base: &Path, name: &str) -> io::Result<PathBuf> {
    let segments = safe_segments(name).ok_or_else(|| invalid(format!("包内路径无效：{name}")))?;
    Ok(segments.iter().fold(base.to_path_buf(), |p, s| p.join(s)))
}

fn is_date_dir(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// 任务目录内全部文件（相对任务目录，正斜杠，排序）；不跟随符号链接。
fn files_under(dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    let mut stack = vec![(String::new(), dir.to_path_buf())];
    while let Some((prefix, path)) = stack.pop() {
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
            let kind = entry.file_type()?;
            if kind.is_dir() {
                stack.push((format!("{name}/"), entry.path()));
            } else if kind.is_file() {
                out.push((name, entry.path()));
            }
        }
    }
    out.sort();
    Ok(out)
}

fn copy_chunks(reader: &mut impl Read, writer: &mut impl Write, done: &mut u64, total: u64, progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<()> {
    let mut buf = vec![0u8; CHUNK];
    loop {
        check_cancel(cancel)?;
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        writer.write_all(&buf[..n])?;
        *done += n as u64;
        progress(*done, total);
    }
}

pub fn export(root: &Path, spec: &ExportSpec, target: &Path, progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<ExportReport> {
    let mut sources: Vec<(String, PathBuf)> = Vec::new();
    let mut task_dirs = 0;
    for dir in &spec.task_dirs {
        let path = join_segments(root, dir)?;
        if !path.is_dir() {
            continue;
        }
        task_dirs += 1;
        sources.extend(files_under(&path)?.into_iter().map(|(name, p)| (format!("{dir}/{name}"), p)));
    }
    for file in &spec.files {
        safe_segments(&file.entry).ok_or_else(|| invalid(format!("包内路径无效：{}", file.entry)))?;
        sources.push((file.entry.clone(), PathBuf::from(&file.source)));
    }
    safe_segments(&spec.board_entry).ok_or_else(|| invalid(format!("包内路径无效：{}", spec.board_entry)))?;
    let total = sources.iter().map(|(_, p)| fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum::<u64>();

    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = store::temp_path_for(target);
    let result = (|| {
        let mut zip = zip::ZipWriter::new(File::create_new(&tmp)?);
        let zip_err = |e: zip::result::ZipError| io::Error::other(e.to_string());
        let deflate = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let store = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, text) in [(MANIFEST_NAME, &spec.manifest), (spec.board_entry.as_str(), &spec.board_text)] {
            zip.start_file(name, deflate).map_err(zip_err)?;
            zip.write_all(text.as_bytes())?;
        }
        let mut done = 0;
        for (name, path) in &sources {
            let mut file = File::open(path)?;
            let size = file.metadata()?.len();
            let options = if name.to_lowercase().ends_with(".json") { deflate } else { store };
            zip.start_file(name.as_str(), options.large_file(size >= u32::MAX as u64)).map_err(zip_err)?;
            copy_chunks(&mut file, &mut zip, &mut done, total, progress, cancel)?;
        }
        let file = zip.finish().map_err(zip_err)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)?;
        Ok(ExportReport { task_dirs, bytes: done })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn open_archive(pack: &Path) -> io::Result<zip::ZipArchive<File>> {
    zip::ZipArchive::new(File::open(pack)?).map_err(|e| invalid(format!("不是有效的画板包：{e}")))
}

fn read_entry_text(file: &mut impl Read) -> io::Result<String> {
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(|_| invalid("包内 JSON 不是 UTF-8"))?;
    Ok(text)
}

/// 只读清单与画板，不写任何文件；版本判定由前端做。
pub fn inspect(pack: &Path) -> io::Result<Inspected> {
    let mut archive = open_archive(pack)?;
    let mut inspected = Inspected { manifest: None, boards: Default::default() };
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| invalid(e.to_string()))?;
        let name = file.name().to_string();
        if name == MANIFEST_NAME {
            inspected.manifest = Some(read_entry_text(&mut file)?);
        } else if name.starts_with(&format!("{BOARDS_DIR}/")) && !file.is_dir() {
            inspected.boards.insert(name, read_entry_text(&mut file)?);
        }
    }
    Ok(inspected)
}

/// 合并单元：任务目录整目录移入，其余文件逐个移入。
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Unit {
    TaskDir(String),
    File(String),
}

fn unit_of(name: &str) -> Unit {
    let segments: Vec<&str> = name.split('/').collect();
    if segments.len() >= 3 && is_date_dir(segments[0]) {
        Unit::TaskDir(format!("{}/{}", segments[0], segments[1]))
    } else {
        Unit::File(name.to_string())
    }
}

/// 临时目录守卫：离开作用域时删除（成功时里面已空）。
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn same_bytes(a: &Path, b: &Path) -> bool {
    match (fs::read(a), fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

pub fn import(pack: &Path, root: &Path, progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<ImportReport> {
    let mut archive = open_archive(pack)?;
    let mut entries = Vec::new();
    let mut total = 0;
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(|e| invalid(e.to_string()))?;
        let name = file.name().to_string();
        if file.is_dir() || name == MANIFEST_NAME || name.starts_with(&format!("{BOARDS_DIR}/")) {
            continue;
        }
        safe_segments(&name).ok_or_else(|| invalid(format!("包内路径无效：{name}")))?;
        total += file.size();
        entries.push((i, name));
    }

    fs::create_dir_all(root)?;
    let temp = TempDir(store::temp_path_for(&root.join(".ugcpack-import")));
    fs::create_dir(&temp.0)?;
    let mut done = 0;
    for (index, name) in &entries {
        let mut file = archive.by_index(*index).map_err(|e| invalid(e.to_string()))?;
        let dest = join_segments(&temp.0, name)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = File::create_new(&dest)?;
        copy_chunks(&mut file, &mut out, &mut done, total, progress, cancel)?;
    }

    let mut units: Vec<Unit> = entries.iter().map(|(_, name)| unit_of(name)).collect();
    units.sort();
    units.dedup();
    // 校验：每个任务目录都要有 task.json；不合格时一个都不移入。
    for unit in &units {
        if let Unit::TaskDir(dir) = unit {
            if !join_segments(&temp.0, dir)?.join(TASK_RECORD).is_file() {
                return Err(invalid(format!("任务目录 {dir} 缺少 {TASK_RECORD}")));
            }
        }
    }

    let mut report = ImportReport { imported: 0, skipped: 0, conflicts: Vec::new(), bytes: done };
    for unit in &units {
        check_cancel(cancel)?;
        let (name, is_task) = match unit {
            Unit::TaskDir(dir) => (dir, true),
            Unit::File(file) => (file, false),
        };
        let from = join_segments(&temp.0, name)?;
        let to = join_segments(root, name)?;
        if to.exists() {
            let identical = if is_task { same_bytes(&from.join(TASK_RECORD), &to.join(TASK_RECORD)) } else { same_bytes(&from, &to) };
            if !identical {
                report.conflicts.push(name.clone());
            } else if is_task {
                report.skipped += 1;
            }
            continue;
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&from, &to)?;
        if is_task {
            report.imported += 1;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TASK_A: &str = "2026-09-16/20260916T010000Z-0000000a";
    const TASK_B: &str = "2026-09-16/20260916T020000Z-0000000b";

    fn no_progress(_: u64, _: u64) {}

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    struct Fixture {
        tmp: tempfile::TempDir,
        root: PathBuf,
        external: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("输出 A");
        for dir in [TASK_A, TASK_B] {
            write(&root.join(dir).join("task.json"), format!("{{\"task_id\":\"{dir}\"}}").as_bytes());
            write(&root.join(dir).join("result.png"), &[0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        }
        write(&root.join(TASK_B).join("layers/01.png"), b"layer");
        write(&root.join("2026-09-16/20260916T030000Z-0000000c/task.json"), b"{}");
        let external = tmp.path().join("别处/猫.png");
        write(&external, b"cat");
        Fixture { tmp, root, external }
    }

    fn spec(f: &Fixture) -> ExportSpec {
        ExportSpec {
            manifest: "{\"pack_format_version\":1}".into(),
            board_entry: "画板/千问测试.ugcboard.json".into(),
            board_text: "{\"title\":\"千问测试\"}".into(),
            task_dirs: vec![TASK_A.into(), TASK_B.into(), "2026-09-17/20260917T000000Z-missing".into()],
            files: vec![PackFile { source: f.external.to_string_lossy().into_owned(), entry: "导入参考图/abc.png".into() }],
        }
    }

    fn zip_entries(path: &Path) -> Vec<(String, zip::CompressionMethod)> {
        let mut archive = open_archive(path).unwrap();
        (0..archive.len())
            .map(|i| {
                let f = archive.by_index(i).unwrap();
                (f.name().to_string(), f.compression())
            })
            .collect()
    }

    fn names_in(dir: &Path) -> Vec<String> {
        fs::read_dir(dir).map(|it| it.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
    }

    #[test]
    fn export_mirrors_root_layout_and_stores_images() {
        let f = fixture();
        let target = f.tmp.path().join("出/千问测试.ugcpack");
        let report = export(&f.root, &spec(&f), &target, &no_progress, &AtomicBool::new(false)).unwrap();
        let task_json_bytes: u64 = [TASK_A, TASK_B].iter().map(|d| fs::metadata(f.root.join(d).join("task.json")).unwrap().len()).sum();
        assert_eq!(report, ExportReport { task_dirs: 2, bytes: 7 + 7 + 5 + 3 + task_json_bytes });
        let entries = zip_entries(&target);
        let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "manifest.json",
                "画板/千问测试.ugcboard.json",
                &format!("{TASK_A}/result.png"),
                &format!("{TASK_A}/task.json"),
                &format!("{TASK_B}/layers/01.png"),
                &format!("{TASK_B}/result.png"),
                &format!("{TASK_B}/task.json"),
                "导入参考图/abc.png",
            ]
        );
        for (name, method) in &entries {
            let expected = if name.ends_with(".json") { zip::CompressionMethod::Deflated } else { zip::CompressionMethod::Stored };
            assert_eq!(*method, expected, "{name}");
        }
        assert!(!names_in(target.parent().unwrap()).iter().any(|n| n.ends_with(".tmp")));
    }

    #[test]
    fn export_rejects_unsafe_entries() {
        let f = fixture();
        let mut bad = spec(&f);
        bad.task_dirs = vec!["../outside".into()];
        let target = f.tmp.path().join("bad.ugcpack");
        assert!(export(&f.root, &bad, &target, &no_progress, &AtomicBool::new(false)).is_err());
        assert!(!target.exists());
    }

    #[test]
    fn cancelled_export_leaves_no_file() {
        let f = fixture();
        let target = f.tmp.path().join("c.ugcpack");
        let err = export(&f.root, &spec(&f), &target, &no_progress, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err.to_string(), CANCELLED);
        assert!(names_in(f.tmp.path()).iter().all(|n| !n.contains("c.ugcpack")));
    }

    fn exported(f: &Fixture) -> PathBuf {
        let target = f.tmp.path().join("p.ugcpack");
        export(&f.root, &spec(f), &target, &no_progress, &AtomicBool::new(false)).unwrap();
        target
    }

    #[test]
    fn inspect_reads_manifest_and_boards_only() {
        let f = fixture();
        let inspected = inspect(&exported(&f)).unwrap();
        assert_eq!(inspected.manifest.as_deref(), Some("{\"pack_format_version\":1}"));
        assert_eq!(inspected.boards.keys().collect::<Vec<_>>(), vec!["画板/千问测试.ugcboard.json"]);
    }

    #[test]
    fn import_moves_task_dirs_and_files_then_is_idempotent() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        let report = import(&pack, &other, &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!((report.imported, report.skipped, report.conflicts.len()), (2, 0, 0));
        assert_eq!(fs::read(other.join(TASK_B).join("layers/01.png")).unwrap(), b"layer");
        assert_eq!(fs::read(other.join("导入参考图/abc.png")).unwrap(), b"cat");
        // 画板不由壳写入（前端按改名规则写）。
        assert!(!other.join(BOARDS_DIR).exists());
        assert_eq!(names_in(&other).len(), 2, "临时目录应已清理：{:?}", names_in(&other));

        let again = import(&pack, &other, &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!((again.imported, again.skipped, again.conflicts), (0, 2, vec![]));
        assert_eq!(names_in(&other).len(), 2);
    }

    #[test]
    fn differing_task_json_is_a_conflict_and_not_overwritten() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        write(&other.join(TASK_A).join("task.json"), b"{\"local\":true}");
        write(&other.join("导入参考图/abc.png"), b"dog");
        let report = import(&pack, &other, &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(report.conflicts, vec![TASK_A.to_string(), "导入参考图/abc.png".to_string()]);
        assert_eq!(fs::read(other.join(TASK_A).join("task.json")).unwrap(), b"{\"local\":true}");
        assert!(!other.join(TASK_A).join("result.png").exists());
        assert_eq!(fs::read(other.join("导入参考图/abc.png")).unwrap(), b"dog");
    }

    #[test]
    fn cancelled_import_cleans_temp_dir_and_writes_nothing() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        let err = import(&pack, &other, &no_progress, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err.to_string(), CANCELLED);
        assert!(names_in(&other).is_empty(), "{:?}", names_in(&other));
    }

    #[test]
    fn cancel_after_extraction_moves_nothing_and_cleans_temp() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        let cancel = AtomicBool::new(false);
        // 解压完最后一个字节时取消：解压阶段已结束，移入阶段第一次检查即中止。
        let progress = |done: u64, all: u64| {
            if done == all {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        assert!(import(&pack, &other, &progress, &cancel).is_err());
        assert!(names_in(&other).is_empty(), "{:?}", names_in(&other));
    }

    #[test]
    fn import_rejects_unsafe_or_invalid_packs_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("输出");
        let make = |name: &str, entries: &[&str]| {
            let path = tmp.path().join(name);
            let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
            for e in entries {
                zip.start_file(*e, SimpleFileOptions::default()).unwrap();
                zip.write_all(b"x").unwrap();
            }
            zip.finish().unwrap();
            path
        };
        let traversal = make("t.ugcpack", &["manifest.json", "../evil.png"]);
        assert!(import(&traversal, &root, &no_progress, &AtomicBool::new(false)).is_err());
        let no_record = make("n.ugcpack", &["manifest.json", &format!("{TASK_A}/result.png")]);
        assert!(import(&no_record, &root, &no_progress, &AtomicBool::new(false)).is_err());
        assert!(names_in(&root).is_empty(), "{:?}", names_in(&root));
        fs::write(tmp.path().join("junk.ugcpack"), b"not a zip").unwrap();
        assert!(inspect(&tmp.path().join("junk.ugcpack")).is_err());
    }
}
