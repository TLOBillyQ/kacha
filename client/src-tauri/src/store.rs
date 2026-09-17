//! 文件系统原子写与画板文件的 `.bak`（规格第 9.5 节）。
//!
//! 原子写 = 同目录临时文件完整写入并 fsync，再 rename 覆盖目标；失败时清理临时文件。
//! 画板写前把当前主文件复制成单份 `.bak`——只在主文件本身是有效 JSON 时才复制，
//! 避免把损坏的主文件覆盖掉仍然完好的备份。

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

pub const BOARD_EXTENSION: &str = ".ugcboard.json";

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn temp_path_for(target: &Path) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = target.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    target.with_file_name(format!(".{name}.{}-{nanos}-{n}.tmp", std::process::id()))
}

/// 临时文件 + fsync + rename；目标目录不存在时创建。
pub fn atomic_write(target: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = temp_path_for(target);
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 任务目录文件（参考图快照、结果图、task.json）提交后不可变：目标已存在时拒绝，不覆盖。
/// 先写临时文件，再硬链接到目标（目标已存在时由文件系统原子地拒绝），最后删临时文件。
pub fn write_new_file(target: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = temp_path_for(target);
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::hard_link(&tmp, target)
    })();
    let _ = fs::remove_file(&tmp);
    result
}

pub fn bak_path(board: &Path) -> PathBuf {
    let mut name = board.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    board.with_file_name(name)
}

fn is_valid_json(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde::de::IgnoredAny>(bytes).is_ok()
}

/// 写画板：主文件存在且是有效 JSON 时先原子写一份 `.bak`，再原子写主文件。
pub fn write_board(path: &Path, text: &str) -> io::Result<()> {
    match fs::read(path) {
        Ok(current) if is_valid_json(&current) => atomic_write(&bak_path(path), &current)?,
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    atomic_write(path, text.as_bytes())
}

#[derive(Debug, Serialize, PartialEq)]
pub struct BoardTexts {
    pub main: Option<String>,
    pub bak: Option<String>,
}

fn read_optional(path: &Path) -> io::Result<Option<String>> {
    match fs::read(path) {
        // 非 UTF-8 视为损坏，交给前端按损坏处理（回退 .bak）。
        Ok(bytes) => Ok(Some(String::from_utf8(bytes).unwrap_or_default())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// 读主文件与 `.bak` 原文；是否损坏、是否回退由前端按格式判断。
pub fn read_board(path: &Path) -> io::Result<BoardTexts> {
    Ok(BoardTexts { main: read_optional(path)?, bak: read_optional(&bak_path(path))? })
}

pub fn read_text(path: &Path) -> io::Result<Option<String>> {
    read_optional(path)
}

/// 重命名画板文件（连同 `.bak`）；目标已存在时拒绝，不覆盖别的画板。
pub fn rename_board(from: &Path, to: &Path) -> io::Result<()> {
    if from == to {
        return Ok(());
    }
    // 仅大小写不同的改名在大小写不敏感文件系统上 to 会「已存在」，此时允许。
    let same_file_case_only = from.parent() == to.parent()
        && from.file_name().map(|s| s.to_string_lossy().to_lowercase())
            == to.file_name().map(|s| s.to_string_lossy().to_lowercase());
    // 孤立的 .bak 也占住名字（打开时可从它恢复），不能被覆盖。
    if (to.exists() || bak_path(to).exists()) && !same_file_case_only {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} 已存在", to.display())));
    }
    if from.exists() {
        fs::rename(from, to)?;
    }
    let (from_bak, to_bak) = (bak_path(from), bak_path(to));
    if from_bak.exists() {
        fs::rename(from_bak, to_bak)?;
    }
    Ok(())
}

/// 目录下已被占用的画板文件名（只有 `.bak` 的也算，去掉后缀）；目录不存在时为空。
pub fn list_board_names(dir: &Path) -> io::Result<Vec<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter_map(|n| {
            let main = n.strip_suffix(".bak").unwrap_or(&n);
            main.ends_with(BOARD_EXTENSION).then(|| main.to_string())
        })
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn atomic_write_creates_dirs_and_leaves_no_tmp() {
        let dir = tmpdir();
        let target = dir.path().join("画板").join("a.ugcboard.json");
        atomic_write(&target, "你好".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "你好");
        assert!(leftovers(target.parent().unwrap()).is_empty());
    }

    #[test]
    fn atomic_write_replaces_existing() {
        let dir = tmpdir();
        let target = dir.path().join("a.json");
        atomic_write(&target, b"1").unwrap();
        atomic_write(&target, b"2").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "2");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn atomic_write_failure_keeps_target_and_cleans_tmp() {
        let dir = tmpdir();
        // 目标是一个非空目录：rename 失败。
        let target = dir.path().join("occupied");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("x"), b"x").unwrap();
        assert!(atomic_write(&target, b"data").is_err());
        assert!(target.is_dir());
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn write_new_file_refuses_to_overwrite() {
        let dir = tmpdir();
        let target = dir.path().join("2026-09-16").join("t").join("result.png");
        write_new_file(&target, b"1").unwrap();
        assert_eq!(write_new_file(&target, b"2").unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&target).unwrap(), b"1");
    }

    #[test]
    fn first_write_has_no_bak() {
        let dir = tmpdir();
        let board = dir.path().join("a.ugcboard.json");
        write_board(&board, "{\"v\":1}").unwrap();
        assert!(!bak_path(&board).exists());
    }

    #[test]
    fn write_keeps_single_bak_of_previous_version() {
        let dir = tmpdir();
        let board = dir.path().join("a.ugcboard.json");
        write_board(&board, "{\"v\":1}").unwrap();
        write_board(&board, "{\"v\":2}").unwrap();
        write_board(&board, "{\"v\":3}").unwrap();
        assert_eq!(fs::read_to_string(&board).unwrap(), "{\"v\":3}");
        assert_eq!(fs::read_to_string(bak_path(&board)).unwrap(), "{\"v\":2}");
        let baks: Vec<_> = fs::read_dir(dir.path()).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".bak")).collect();
        assert_eq!(baks.len(), 1);
    }

    #[test]
    fn corrupt_main_does_not_overwrite_good_bak() {
        let dir = tmpdir();
        let board = dir.path().join("a.ugcboard.json");
        fs::write(&board, "{broken").unwrap();
        fs::write(bak_path(&board), "{\"v\":1}").unwrap();
        write_board(&board, "{\"v\":2}").unwrap();
        assert_eq!(fs::read_to_string(bak_path(&board)).unwrap(), "{\"v\":1}");
        assert_eq!(fs::read_to_string(&board).unwrap(), "{\"v\":2}");
    }

    #[test]
    fn read_board_returns_main_and_bak() {
        let dir = tmpdir();
        let board = dir.path().join("a.ugcboard.json");
        assert_eq!(read_board(&board).unwrap(), BoardTexts { main: None, bak: None });
        write_board(&board, "{\"v\":1}").unwrap();
        write_board(&board, "{\"v\":2}").unwrap();
        assert_eq!(
            read_board(&board).unwrap(),
            BoardTexts { main: Some("{\"v\":2}".into()), bak: Some("{\"v\":1}".into()) }
        );
    }

    #[test]
    fn rename_moves_main_and_bak_and_refuses_existing() {
        let dir = tmpdir();
        let a = dir.path().join("a.ugcboard.json");
        let b = dir.path().join("b.ugcboard.json");
        write_board(&a, "{\"v\":1}").unwrap();
        write_board(&a, "{\"v\":2}").unwrap();
        rename_board(&a, &b).unwrap();
        assert!(!a.exists() && !bak_path(&a).exists());
        assert_eq!(fs::read_to_string(&b).unwrap(), "{\"v\":2}");
        assert_eq!(fs::read_to_string(bak_path(&b)).unwrap(), "{\"v\":1}");

        write_board(&a, "{}").unwrap();
        let err = rename_board(&a, &b).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&b).unwrap(), "{\"v\":2}");
    }

    #[test]
    fn orphan_bak_occupies_the_name() {
        let dir = tmpdir();
        let a = dir.path().join("a.ugcboard.json");
        let c = dir.path().join("c.ugcboard.json");
        write_board(&a, "{}").unwrap();
        fs::write(bak_path(&c), "{\"orphan\":true}").unwrap();
        assert_eq!(rename_board(&a, &c).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(bak_path(&c)).unwrap(), "{\"orphan\":true}");
        assert_eq!(list_board_names(dir.path()).unwrap(), vec!["a.ugcboard.json", "c.ugcboard.json"]);
    }

    #[test]
    fn list_board_names_filters_and_tolerates_missing_dir() {
        let dir = tmpdir();
        assert!(list_board_names(&dir.path().join("none")).unwrap().is_empty());
        write_board(&dir.path().join("b.ugcboard.json"), "{}").unwrap();
        write_board(&dir.path().join("b.ugcboard.json"), "{}").unwrap();
        fs::write(dir.path().join("a.ugcboard.json"), "{}").unwrap();
        fs::write(dir.path().join("note.txt"), "").unwrap();
        assert_eq!(list_board_names(dir.path()).unwrap(), vec!["a.ugcboard.json", "b.ugcboard.json"]);
    }
}
