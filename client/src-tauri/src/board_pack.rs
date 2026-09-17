//! 画板包（ADR 0013）的 zip 读写与合并搬运。包格式的规则（带哪些条目、布局是否合法、合并单元怎么比对、
//! 结果怎么计数）全部在前端 core/boardPack.ts；这里只按给定条目与合并单元搬字节，并守住路径安全。
//!
//! 导出：流式写同目录临时文件，JSON deflate、其余 store，完成后 rename 覆盖目标。
//! 导入：只解压属于给定合并单元的条目到输出根目录下的临时目录，校验后逐个单元原子 rename 移入；
//! 目标已存在时按单元的身份文件（或整文件）比对，一致为跳过、不一致为冲突，均不覆盖。
//! 失败 / 取消时清理临时目录，已移入的保留；进程被杀留下的临时目录在下次导入开始时清理。

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

use crate::store;

pub const CANCELLED: &str = "已取消";
const CHUNK: usize = 1 << 20;
/// 导入临时目录名 `.ugcpack-import.<pid>-<纳秒>-<序号>.tmp`（由 store::temp_path_for 生成）。
const IMPORT_TEMP_STEM: &str = "ugcpack-import";

#[derive(Debug, Deserialize)]
pub struct PackText {
    pub entry: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct PackFile {
    /// 本机绝对路径。
    pub source: String,
    /// 包内路径（正斜杠）。
    pub entry: String,
}

#[derive(Debug, Deserialize)]
pub struct ExportSpec {
    /// 直接写入的文本条目（清单、画板）。
    pub texts: Vec<PackText>,
    /// 相对输出根目录的目录，整目录写入；本机不存在的跳过。
    pub task_dirs: Vec<String>,
    pub files: Vec<PackFile>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ExportReport {
    pub task_dirs: usize,
    pub bytes: u64,
}

/// 合并单元：`identity` 为目录内判定「同一份」的相对文件；为 None 时单元本身是文件，按整文件比对。
#[derive(Debug, Deserialize)]
pub struct MergeUnit {
    pub path: String,
    pub identity: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum MergeOutcome {
    Moved,
    Identical,
    Conflict,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct UnitOutcome {
    pub path: String,
    pub outcome: MergeOutcome,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ImportReport {
    pub outcomes: Vec<UnitOutcome>,
    pub bytes: u64,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn zip_err(e: zip::result::ZipError) -> io::Error {
    invalid(e.to_string())
}

fn check_cancel(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(io::Error::new(io::ErrorKind::Interrupted, CANCELLED))
    } else {
        Ok(())
    }
}

/// 包内路径只允许正斜杠分隔的普通相对段：不含 `..`、`.`、空段、反斜杠、盘符与控制字符。
fn safe_join(base: &Path, name: &str) -> io::Result<PathBuf> {
    let ok = name.split('/').all(|s| !s.is_empty() && s != "." && s != ".." && !s.chars().any(|c| c == '\\' || c == ':' || c.is_control()));
    if !ok {
        return Err(invalid(format!("包内路径无效：{name}")));
    }
    Ok(name.split('/').fold(base.to_path_buf(), |p, s| p.join(s)))
}

/// 目录内全部文件（相对该目录，正斜杠，排序）；不跟随符号链接。
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

/// 流式 sha256：导出时给任务目录外的文件算包内名，不要求是可解码的图片。
pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            return Ok(format!("{:x}", hasher.finalize()));
        }
        hasher.update(&buf[..n]);
    }
}

pub fn export(root: &Path, spec: &ExportSpec, target: &Path, progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<ExportReport> {
    let mut sources: Vec<(String, PathBuf)> = Vec::new();
    let mut task_dirs = 0;
    for dir in &spec.task_dirs {
        let path = safe_join(root, dir)?;
        if !path.is_dir() {
            continue;
        }
        task_dirs += 1;
        sources.extend(files_under(&path)?.into_iter().map(|(name, p)| (format!("{dir}/{name}"), p)));
    }
    sources.extend(spec.files.iter().map(|f| (f.entry.clone(), PathBuf::from(&f.source))));
    let mut names = BTreeSet::new();
    for name in spec.texts.iter().map(|t| &t.entry).chain(sources.iter().map(|(n, _)| n)) {
        safe_join(Path::new(""), name)?;
        if !names.insert(name.as_str()) {
            return Err(invalid(format!("包内路径重复：{name}")));
        }
    }
    let total = sources.iter().map(|(_, p)| fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum::<u64>();

    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = store::temp_path_for(target);
    let result = (|| {
        let mut zip = zip::ZipWriter::new(File::create_new(&tmp)?);
        let deflate = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let store = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for text in &spec.texts {
            zip.start_file(text.entry.as_str(), deflate).map_err(zip_err)?;
            zip.write_all(text.text.as_bytes())?;
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

/// 包内全部文件条目名（不含目录条目）。
pub fn entries(pack: &Path) -> io::Result<Vec<String>> {
    let archive = open_archive(pack)?;
    Ok(archive.file_names().filter(|n| !n.ends_with('/')).map(str::to_string).collect())
}

/// 读指定条目的 UTF-8 文本；包内没有的条目不出现在结果里。
pub fn read_texts(pack: &Path, names: &[String]) -> io::Result<BTreeMap<String, String>> {
    let mut archive = open_archive(pack)?;
    let mut texts = BTreeMap::new();
    for name in names {
        let mut file = match archive.by_name(name) {
            Ok(file) => file,
            Err(zip::result::ZipError::FileNotFound) => continue,
            Err(e) => return Err(zip_err(e)),
        };
        let mut text = String::new();
        file.read_to_string(&mut text).map_err(|_| invalid(format!("包内 {name} 不是 UTF-8 文本")))?;
        texts.insert(name.clone(), text);
    }
    Ok(texts)
}

/// 临时目录守卫：离开作用域时删除（成功时里面只剩未移入的单元）。
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// 清理进程被杀时留下的导入临时目录。单实例应用、导入是模态的，开始导入时不会有别的导入在进行。
fn sweep_stale_imports(root: &Path) {
    let prefix = format!(".{IMPORT_TEMP_STEM}.");
    for entry in fs::read_dir(root).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name.ends_with(".tmp") && entry.file_type().is_ok_and(|t| t.is_dir()) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// 逐块比对两个文件；任一读不了视为不同。
fn same_file(a: &Path, b: &Path) -> bool {
    let compare = || -> io::Result<bool> {
        let (mut x, mut y) = (File::open(a)?, File::open(b)?);
        if x.metadata()?.len() != y.metadata()?.len() {
            return Ok(false);
        }
        let (mut bx, mut by) = (vec![0u8; CHUNK], vec![0u8; CHUNK]);
        loop {
            let n = x.read(&mut bx)?;
            if n == 0 {
                return Ok(true);
            }
            y.read_exact(&mut by[..n])?;
            if bx[..n] != by[..n] {
                return Ok(false);
            }
        }
    };
    compare().unwrap_or(false)
}

fn belongs_to_unit(units: &[MergeUnit], name: &str) -> bool {
    units.iter().any(|u| name == u.path || name.strip_prefix(u.path.as_str()).is_some_and(|rest| rest.starts_with('/')))
}

pub fn import(pack: &Path, root: &Path, units: &[MergeUnit], progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<ImportReport> {
    for unit in units {
        safe_join(root, &unit.path)?;
        if let Some(identity) = &unit.identity {
            safe_join(root, identity)?;
        }
    }
    let mut archive = open_archive(pack)?;
    let mut extract = Vec::new();
    let mut total = 0;
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(zip_err)?;
        let name = file.name().to_string();
        if file.is_dir() || !belongs_to_unit(units, &name) {
            continue;
        }
        safe_join(root, &name)?;
        total += file.size();
        extract.push((i, name));
    }

    fs::create_dir_all(root)?;
    sweep_stale_imports(root);
    let temp = TempDir(store::temp_path_for(&root.join(IMPORT_TEMP_STEM)));
    fs::create_dir(&temp.0)?;
    let mut done = 0;
    for (index, name) in &extract {
        let mut file = archive.by_index(*index).map_err(zip_err)?;
        let dest = safe_join(&temp.0, name)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = File::create_new(&dest)?;
        copy_chunks(&mut file, &mut out, &mut done, total, progress, cancel)?;
    }

    // 校验：每个单元都在包里（目录单元还要有身份文件）；不合格时一个都不移入。
    for unit in units {
        let from = safe_join(&temp.0, &unit.path)?;
        let present = match &unit.identity {
            Some(identity) => safe_join(&from, identity)?.is_file(),
            None => from.is_file(),
        };
        if !present {
            return Err(invalid(format!("包内缺少 {}", unit.path)));
        }
    }

    let mut outcomes = Vec::new();
    for unit in units {
        check_cancel(cancel)?;
        let from = safe_join(&temp.0, &unit.path)?;
        let to = safe_join(root, &unit.path)?;
        let outcome = if to.exists() {
            let same = match &unit.identity {
                Some(identity) => same_file(&safe_join(&from, identity)?, &safe_join(&to, identity)?),
                None => same_file(&from, &to),
            };
            if same {
                MergeOutcome::Identical
            } else {
                MergeOutcome::Conflict
            }
        } else {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&from, &to)?;
            MergeOutcome::Moved
        };
        outcomes.push(UnitOutcome { path: unit.path.clone(), outcome });
    }
    Ok(ImportReport { outcomes, bytes: done })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TASK_A: &str = "2026-09-16/20260916T010000Z-0000000a";
    const TASK_B: &str = "2026-09-16/20260916T020000Z-0000000b";
    const REF: &str = "导入参考图/abc.png";

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

    fn text(entry: &str, text: &str) -> PackText {
        PackText { entry: entry.into(), text: text.into() }
    }

    fn spec(f: &Fixture) -> ExportSpec {
        ExportSpec {
            texts: vec![text("manifest.json", "{\"pack_format_version\":1}"), text("画板/千问测试.ugcboard.json", "{\"title\":\"千问测试\"}")],
            task_dirs: vec![TASK_A.into(), TASK_B.into(), "2026-09-17/20260917T000000Z-missing".into()],
            files: vec![PackFile { source: f.external.to_string_lossy().into_owned(), entry: REF.into() }],
        }
    }

    fn units() -> Vec<MergeUnit> {
        let dir = |p: &str| MergeUnit { path: p.into(), identity: Some("task.json".into()) };
        vec![dir(TASK_A), dir(TASK_B), MergeUnit { path: REF.into(), identity: None }]
    }

    fn outcomes(report: &ImportReport) -> Vec<(&str, MergeOutcome)> {
        report.outcomes.iter().map(|o| (o.path.as_str(), o.outcome)).collect()
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
        let mut names: Vec<String> = fs::read_dir(dir).map(|it| it.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        names.sort();
        names
    }

    fn make_zip(path: &Path, entries: &[&str]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        for e in entries {
            zip.start_file(*e, SimpleFileOptions::default()).unwrap();
            zip.write_all(b"x").unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn export_writes_texts_dirs_and_files_storing_images() {
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
                REF,
            ]
        );
        for (name, method) in &entries {
            let expected = if name.ends_with(".json") { zip::CompressionMethod::Deflated } else { zip::CompressionMethod::Stored };
            assert_eq!(*method, expected, "{name}");
        }
        assert!(!names_in(target.parent().unwrap()).iter().any(|n| n.ends_with(".tmp")));
    }

    #[test]
    fn export_rejects_unsafe_or_duplicate_entries() {
        let f = fixture();
        let target = f.tmp.path().join("bad.ugcpack");
        let mut traversal = spec(&f);
        traversal.task_dirs = vec!["../outside".into()];
        assert!(export(&f.root, &traversal, &target, &no_progress, &AtomicBool::new(false)).is_err());
        let mut duplicate = spec(&f);
        duplicate.files.push(PackFile { source: f.external.to_string_lossy().into_owned(), entry: "manifest.json".into() });
        let err = export(&f.root, &duplicate, &target, &no_progress, &AtomicBool::new(false)).unwrap_err();
        assert!(err.to_string().contains("重复"), "{err}");
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

    #[test]
    fn sha256_of_any_file() {
        let f = fixture();
        assert_eq!(sha256_file(&f.external).unwrap(), format!("{:x}", Sha256::digest(b"cat")));
        assert!(sha256_file(&f.tmp.path().join("没有")).is_err());
    }

    fn exported(f: &Fixture) -> PathBuf {
        let target = f.tmp.path().join("p.ugcpack");
        export(&f.root, &spec(f), &target, &no_progress, &AtomicBool::new(false)).unwrap();
        target
    }

    #[test]
    fn lists_entries_and_reads_requested_texts() {
        let f = fixture();
        let pack = exported(&f);
        assert_eq!(entries(&pack).unwrap().len(), 8);
        let texts = read_texts(&pack, &["manifest.json".into(), "画板/没有.ugcboard.json".into()]).unwrap();
        assert_eq!(texts.into_iter().collect::<Vec<_>>(), vec![("manifest.json".to_string(), "{\"pack_format_version\":1}".to_string())]);
        fs::write(f.tmp.path().join("junk.ugcpack"), b"not a zip").unwrap();
        assert!(entries(&f.tmp.path().join("junk.ugcpack")).is_err());
    }

    #[test]
    fn import_moves_units_only_then_is_idempotent() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        let report = import(&pack, &other, &units(), &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(outcomes(&report), vec![(TASK_A, MergeOutcome::Moved), (TASK_B, MergeOutcome::Moved), (REF, MergeOutcome::Moved)]);
        assert_eq!(fs::read(other.join(TASK_B).join("layers/01.png")).unwrap(), b"layer");
        assert_eq!(fs::read(other.join(REF)).unwrap(), b"cat");
        // 清单与画板不属于合并单元，不解压（画板由前端按改名规则写）；临时目录已清理。
        assert_eq!(names_in(&other), vec!["2026-09-16", "导入参考图"]);

        let again = import(&pack, &other, &units(), &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(outcomes(&again), vec![(TASK_A, MergeOutcome::Identical), (TASK_B, MergeOutcome::Identical), (REF, MergeOutcome::Identical)]);
        assert_eq!(names_in(&other), vec!["2026-09-16", "导入参考图"]);
    }

    #[test]
    fn differing_identity_is_a_conflict_and_not_overwritten() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        write(&other.join(TASK_A).join("task.json"), b"{\"local\":true}");
        write(&other.join(REF), b"dog");
        let report = import(&pack, &other, &units(), &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(outcomes(&report), vec![(TASK_A, MergeOutcome::Conflict), (TASK_B, MergeOutcome::Moved), (REF, MergeOutcome::Conflict)]);
        assert_eq!(fs::read(other.join(TASK_A).join("task.json")).unwrap(), b"{\"local\":true}");
        assert!(!other.join(TASK_A).join("result.png").exists());
        assert_eq!(fs::read(other.join(REF)).unwrap(), b"dog");
    }

    #[test]
    fn cancelled_import_cleans_temp_dir_and_writes_nothing() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        let err = import(&pack, &other, &units(), &no_progress, &AtomicBool::new(true)).unwrap_err();
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
        assert!(import(&pack, &other, &units(), &progress, &cancel).is_err());
        assert!(names_in(&other).is_empty(), "{:?}", names_in(&other));
    }

    #[test]
    fn import_sweeps_temp_dirs_left_by_a_killed_process() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        write(&other.join(".ugcpack-import.123-456-0.tmp/导入参考图/abc.png"), b"cat");
        write(&other.join(".别的.tmp/x"), b"x");
        import(&pack, &other, &units(), &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(names_in(&other), vec![".别的.tmp", "2026-09-16", "导入参考图"]);
    }

    #[test]
    fn import_rejects_unsafe_or_missing_units_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("输出");
        let traversal = tmp.path().join("t.ugcpack");
        make_zip(&traversal, &["manifest.json", &format!("{TASK_A}/../../evil.png"), &format!("{TASK_A}/task.json")]);
        let task = || vec![MergeUnit { path: TASK_A.into(), identity: Some("task.json".into()) }];
        assert!(import(&traversal, &root, &task(), &no_progress, &AtomicBool::new(false)).is_err());
        let unsafe_unit = vec![MergeUnit { path: "../x".into(), identity: None }];
        assert!(import(&traversal, &root, &unsafe_unit, &no_progress, &AtomicBool::new(false)).is_err());
        let no_record = tmp.path().join("n.ugcpack");
        make_zip(&no_record, &["manifest.json", &format!("{TASK_A}/result.png")]);
        let err = import(&no_record, &root, &task(), &no_progress, &AtomicBool::new(false)).unwrap_err();
        assert!(err.to_string().contains("缺少"), "{err}");
        assert!(names_in(&root).is_empty(), "{:?}", names_in(&root));
    }
}
