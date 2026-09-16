//! 参考图导入时的一次性检查：sha256、字节数、像素尺寸、格式与是否带 alpha。

use std::fs;
use std::io;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize, PartialEq)]
pub struct ImageInfo {
    pub sha256: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    /// 小写格式名（png / jpeg / webp …）；无法识别为空串。
    pub format: String,
    /// 仅按 PNG 色彩类型判定（带 alpha 的灰度 / RGBA）；其他格式为 false。
    pub has_alpha: bool,
}

fn format_name(t: imagesize::ImageType) -> &'static str {
    use imagesize::ImageType::*;
    match t {
        Png => "png",
        Jpeg => "jpeg",
        Webp => "webp",
        Bmp => "bmp",
        Tiff => "tiff",
        Gif => "gif",
        Heif(_) => "heif",
        _ => "",
    }
}

fn png_has_alpha(bytes: &[u8]) -> bool {
    // IHDR 固定位于签名后：长度(4) 类型(4) 宽(4) 高(4) 位深(1) 色彩类型(1) → 偏移 25。
    bytes.len() > 25 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") && matches!(bytes[25], 4 | 6)
}

pub fn inspect(path: &Path) -> io::Result<ImageInfo> {
    let bytes = fs::read(path)?;
    let (width, height, format) = match (imagesize::blob_size(&bytes), imagesize::image_type(&bytes)) {
        (Ok(size), Ok(kind)) => (size.width as u32, size.height as u32, format_name(kind)),
        _ => (0, 0, ""),
    };
    Ok(ImageInfo {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes: bytes.len() as u64,
        width,
        height,
        format: format.to_string(),
        has_alpha: format == "png" && png_has_alpha(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_header(width: u32, height: u32, color_type: u8) -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&[8, color_type, 0, 0, 0]);
        v.extend_from_slice(&[0, 0, 0, 0]);
        v
    }

    #[test]
    fn inspects_png_size_hash_and_alpha() {
        let dir = tempfile::tempdir().unwrap();
        let rgba = dir.path().join("a.png");
        fs::write(&rgba, png_header(640, 480, 6)).unwrap();
        let info = inspect(&rgba).unwrap();
        assert_eq!((info.width, info.height, info.format.as_str(), info.has_alpha), (640, 480, "png", true));
        assert_eq!(info.bytes, 33);
        assert_eq!(info.sha256.len(), 64);
        assert_eq!(info.sha256, format!("{:x}", Sha256::digest(png_header(640, 480, 6))));

        let rgb = dir.path().join("b.png");
        fs::write(&rgb, png_header(10, 10, 2)).unwrap();
        assert!(!inspect(&rgb).unwrap().has_alpha);
    }

    #[test]
    fn unknown_bytes_still_hashed() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.bin");
        fs::write(&p, b"not an image").unwrap();
        let info = inspect(&p).unwrap();
        assert_eq!((info.width, info.height, info.format.as_str()), (0, 0, ""));
    }
}
