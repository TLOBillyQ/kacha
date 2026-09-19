//! API 密钥存系统凭据库（Windows 凭据管理器 / macOS 钥匙串），服务名沿用 v1（产品更名 Kacha 后也不改，否则已保存的密钥读不到）。
//!
//! 凭据库不可用（含 Linux 开发机无接入）时返回错误，由前端降级为本次会话内存保存；密钥永不明文落盘，也不进错误信息。

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod native {
    use keyring::{Entry, Error};

    const SERVICE: &str = "ugc-image-tool";
    const ACCOUNT: &str = "api-key";

    fn entry() -> Result<Entry, String> {
        // Windows 通用凭据的 TargetName 与 v1 一致为服务名；macOS 为 服务名 + 账户 api-key。
        #[cfg(target_os = "windows")]
        let entry = Entry::new_with_target(SERVICE, SERVICE, ACCOUNT);
        #[cfg(target_os = "macos")]
        let entry = Entry::new(SERVICE, ACCOUNT);
        entry.map_err(describe)
    }

    /// 只给出错误类别，避免把平台返回的任何内容（理论上可能含密钥）带出去。
    fn describe(error: Error) -> String {
        match error {
            Error::PlatformFailure(_) | Error::NoStorageAccess(_) => "系统凭据库不可用".into(),
            Error::NoEntry => "凭据不存在".into(),
            _ => "系统凭据库操作失败".into(),
        }
    }

    pub fn get() -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(describe(e)),
        }
    }

    pub fn set(key: &str) -> Result<(), String> {
        entry()?.set_password(key).map_err(describe)
    }

    pub fn delete() -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(describe(e)),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod native {
    const UNAVAILABLE: &str = "本平台未接入系统凭据库";

    pub fn get() -> Result<Option<String>, String> {
        Err(UNAVAILABLE.into())
    }

    pub fn set(_key: &str) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    pub fn delete() -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
}

pub use native::{delete, get, set};
