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
    /// PNG 按色彩类型判定；WebP 按 VP8X 扩展头的 alpha 标志判定；其他格式为 false。
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

/// WebP：RIFF 容器里找 VP8X 扩展块，flags 字节的 0x10 位 = 带 alpha。
/// 不带 VP8X 的 VP8L 无损流（其实总有 alpha）识别不到——保守判 false，等需要时再解析 VP8L 头。
fn webp_has_alpha(bytes: &[u8]) -> bool {
    if bytes.len() < 20 || !bytes.starts_with(b"RIFF") || &bytes[8..12] != b"WEBP" {
        return false;
    }
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let fourcc = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        if fourcc == b"VP8X" {
            return size >= 1 && bytes.len() > offset + 8 && bytes[offset + 8] & 0x10 != 0;
        }
        // 块数据按偶数字节对齐。
        offset += 8 + size + (size % 2);
    }
    false
}

/// JPEG：按段遍历到 SOS 为止，找 APP1 `Exif\0\0` 段，读 IFD0 的 Orientation（0x0112）。
/// 任何截断、越界、格式非法都返回 None（调用方按未旋转处理）。
fn jpeg_exif_orientation(bytes: &[u8]) -> Option<u16> {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut offset = 2;
    loop {
        if *bytes.get(offset)? != 0xFF {
            return None;
        }
        // 段标记前允许任意个 0xFF 填充字节。
        while *bytes.get(offset + 1)? == 0xFF {
            offset += 1;
        }
        let marker = bytes[offset + 1];
        if matches!(marker, 0xDA | 0xD9) {
            return None;
        }
        let len = u16::from_be_bytes(bytes.get(offset + 2..offset + 4)?.try_into().ok()?) as usize;
        if len < 2 {
            return None;
        }
        let data = bytes.get(offset + 4..(offset + 2 + len).min(bytes.len()))?;
        if marker == 0xE1 && data.starts_with(b"Exif\0\0") {
            return tiff_orientation(&data[6..]);
        }
        offset += 2 + len;
    }
}

/// TIFF 头（`II` 小端 / `MM` 大端）+ IFD0 里找 Orientation；类型不是 SHORT 按非法处理。
fn tiff_orientation(tiff: &[u8]) -> Option<u16> {
    let big_endian = match tiff.get(0..2)? {
        b"II" => false,
        b"MM" => true,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b: [u8; 2] = tiff.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(if big_endian { u16::from_be_bytes(b) } else { u16::from_le_bytes(b) })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b: [u8; 4] = tiff.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(if big_endian { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;
    for i in 0..count {
        let entry = ifd.checked_add(2 + i * 12)?;
        if u16_at(entry)? == 0x0112 {
            // SHORT 值左对齐放在条目的 4 字节值域里。
            if u16_at(entry.checked_add(2)?)? != 3 {
                return None;
            }
            return u16_at(entry.checked_add(8)?);
        }
    }
    None
}

pub fn inspect(path: &Path) -> io::Result<ImageInfo> {
    let bytes = fs::read(path)?;
    let (mut width, mut height, kind) = match (imagesize::blob_size(&bytes), imagesize::image_type(&bytes)) {
        (Ok(size), Ok(kind)) => (size.width as u32, size.height as u32, Some(kind)),
        _ => (0, 0, None),
    };
    let format = kind.map_or("", format_name);
    // Orientation 5–8 带 90° 旋转：宽高按转正后的口径返回，与 WebView / createImageBitmap 的显示一致。
    if matches!(kind, Some(imagesize::ImageType::Jpeg)) && matches!(jpeg_exif_orientation(&bytes), Some(5..=8)) {
        std::mem::swap(&mut width, &mut height);
    }
    Ok(ImageInfo {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes: bytes.len() as u64,
        width,
        height,
        format: format.to_string(),
        has_alpha: (format == "png" && png_has_alpha(&bytes)) || (format == "webp" && webp_has_alpha(&bytes)),
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

    /// RIFF/WEBP 容器，按序装 VP8X（10 字节数据，flags 可调）与 VP8 块。
    fn webp_with_vp8x(flags: u8) -> Vec<u8> {
        let mut v = b"RIFF\0\0\0\0WEBP".to_vec();
        v.extend_from_slice(b"VP8X");
        v.extend_from_slice(&10u32.to_le_bytes());
        v.extend_from_slice(&[flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        v.extend_from_slice(b"VP8 ");
        v.extend_from_slice(&3u32.to_le_bytes());
        v.extend_from_slice(&[0, 0, 0, 0]); // 奇数长度块 + 1 字节对齐
        v
    }

    #[test]
    fn webp_alpha_via_vp8x_flag() {
        assert!(webp_has_alpha(&webp_with_vp8x(0x10)));
        assert!(!webp_has_alpha(&webp_with_vp8x(0x00)));
        assert!(!webp_has_alpha(&webp_with_vp8x(0x20))); // ICC 位不算
        // 没有 VP8X 块的简易 WebP 判 false。
        let mut simple = b"RIFF\0\0\0\0WEBP".to_vec();
        simple.extend_from_slice(b"VP8 ");
        simple.extend_from_slice(&2u32.to_le_bytes());
        simple.extend_from_slice(&[0, 0]);
        assert!(!webp_has_alpha(&simple));
    }

    /// APP1 Exif 段：TIFF 头 + IFD0 只放一条 Orientation（SHORT）。
    fn exif_app1(big_endian: bool, orientation: u16) -> Vec<u8> {
        let u16b = |n: u16| if big_endian { n.to_be_bytes() } else { n.to_le_bytes() };
        let u32b = |n: u32| if big_endian { n.to_be_bytes() } else { n.to_le_bytes() };
        let mut tiff = if big_endian { b"MM".to_vec() } else { b"II".to_vec() };
        tiff.extend_from_slice(&u16b(42));
        tiff.extend_from_slice(&u32b(8));
        tiff.extend_from_slice(&u16b(1));
        tiff.extend_from_slice(&u16b(0x0112));
        tiff.extend_from_slice(&u16b(3));
        tiff.extend_from_slice(&u32b(1));
        tiff.extend_from_slice(&u16b(orientation));
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&u32b(0));
        let mut seg = b"Exif\0\0".to_vec();
        seg.extend_from_slice(&tiff);
        let mut v = vec![0xFF, 0xE1];
        v.extend_from_slice(&((seg.len() + 2) as u16).to_be_bytes());
        v.extend_from_slice(&seg);
        v
    }

    /// SOI + 给定段 + SOF0（存储宽高）+ EOI。
    fn jpeg_with_sof(segments: &[u8], width: u16, height: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(segments);
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 8]);
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    fn inspect_bytes(bytes: &[u8]) -> (u32, u32, String) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jpg");
        fs::write(&p, bytes).unwrap();
        let info = inspect(&p).unwrap();
        (info.width, info.height, info.format)
    }

    #[test]
    fn jpeg_exif_orientation_swaps_size() {
        for big_endian in [false, true] {
            for (orientation, expected) in [(0, (4000, 3000)), (1, (4000, 3000)), (3, (4000, 3000)), (5, (3000, 4000)), (6, (3000, 4000)), (7, (3000, 4000)), (8, (3000, 4000)), (9, (4000, 3000))] {
                let bytes = jpeg_with_sof(&exif_app1(big_endian, orientation), 4000, 3000);
                let (w, h, format) = inspect_bytes(&bytes);
                assert_eq!(format, "jpeg");
                assert_eq!((w, h), expected, "big_endian={big_endian} orientation={orientation}");
            }
        }
    }

    #[test]
    fn jpeg_exif_after_app0_is_found() {
        let mut segs = vec![0xFF, 0xE0, 0x00, 0x10];
        segs.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        segs.extend_from_slice(&exif_app1(false, 6));
        assert_eq!(inspect_bytes(&jpeg_with_sof(&segs, 4000, 3000)).0, 3000);
    }

    #[test]
    fn jpeg_without_exif_keeps_stored_size() {
        let (w, h, _) = inspect_bytes(&jpeg_with_sof(&[], 4000, 3000));
        assert_eq!((w, h), (4000, 3000));
    }

    #[test]
    fn broken_exif_falls_back_without_panic() {
        let full = exif_app1(false, 6);
        // TIFF 内 Orientation 值位于偏移 18..20，对应 APP1 段内 28..30；截在它之前都读不出方向。
        // 文件在此之前任意位置截断（段长照旧声明完整长度）：不 panic、读不出方向。
        for cut in 0..30 {
            let mut bytes = vec![0xFF, 0xD8];
            bytes.extend_from_slice(&full[..cut]);
            assert_eq!(jpeg_exif_orientation(&bytes), None, "cut={cut}");
        }
        // Exif 数据被截短、段长如实声明、后面仍有 SOF：Orientation 值不完整时宽高不变。
        for cut in 4..30 {
            let mut app1 = full[..cut].to_vec();
            app1[2..4].copy_from_slice(&((cut - 2) as u16).to_be_bytes());
            assert_eq!(inspect_bytes(&jpeg_with_sof(&app1, 4000, 3000)).0, 4000, "cut={cut}");
        }
        // IFD0 偏移越界。
        let mut bad_offset = full.clone();
        bad_offset[14..18].copy_from_slice(&0xFFFF_FF00u32.to_le_bytes());
        assert_eq!(inspect_bytes(&jpeg_with_sof(&bad_offset, 4000, 3000)).0, 4000);
        // 条目数声明很大但数据不够（唯一的条目也不是 Orientation，得一路读到越界）。
        let mut bad_count = full.clone();
        bad_count[18..20].copy_from_slice(&0xFFFFu16.to_le_bytes());
        bad_count[20..22].copy_from_slice(&0x010Fu16.to_le_bytes());
        assert_eq!(jpeg_exif_orientation(&[&[0xFF, 0xD8][..], &bad_count].concat()), None);
        // 字节序标记非法。
        let mut bad_order = full;
        bad_order[10..12].copy_from_slice(b"XX");
        assert_eq!(inspect_bytes(&jpeg_with_sof(&bad_order, 4000, 3000)).0, 4000);
    }
}
