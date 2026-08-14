use std::fs::Metadata;

const WINDOWS_REPARSE_POINT_ATTRIBUTE: u32 = 0x0000_0400;

pub(crate) fn is_link_like(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    let windows_file_attributes = {
        use std::os::windows::fs::MetadataExt;

        metadata.file_attributes()
    };
    #[cfg(not(windows))]
    let windows_file_attributes = 0;

    is_link_like_parts(metadata.file_type().is_symlink(), windows_file_attributes)
}

fn is_link_like_parts(is_symlink: bool, windows_file_attributes: u32) -> bool {
    // Windows junctions, mount points and other name-surrogate entries are
    // reparse points even when Rust does not classify their FileType as a
    // symbolic link. Treat every reparse point conservatively as link-like:
    // following an unfamiliar tag is never required for a prompt library.
    is_symlink || windows_file_attributes & WINDOWS_REPARSE_POINT_ATTRIBUTE != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_reparse_attribute_is_link_like_even_without_symlink_file_type() {
        assert!(is_link_like_parts(false, WINDOWS_REPARSE_POINT_ATTRIBUTE));
    }

    #[test]
    fn ordinary_entries_are_not_link_like() {
        assert!(!is_link_like_parts(false, 0));
    }
}
