use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::fs::File;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};
use uuid::Uuid;

use super::error::CommandError;

pub const SETTINGS_FILE_NAME: &str = "settings.json";
pub const DEFAULT_SHORTCUT: &str = "CmdOrCtrl+Shift+P";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub root: Option<PathBuf>,
    pub locale: String,
    pub shortcut: String,
    pub launch_at_login: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            root: None,
            locale: "system".to_owned(),
            shortcut: DEFAULT_SHORTCUT.to_owned(),
            launch_at_login: false,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    /// A root can only be granted through `choose_library_root`. Keeping this
    /// field in the DTO lets us return a stable, intentional error if an older
    /// or compromised frontend tries to bypass the native picker.
    pub root: Option<PathBuf>,
    #[serde(alias = "locale")]
    pub language: Option<String>,
    #[serde(alias = "shortcut")]
    pub global_shortcut: Option<String>,
    pub launch_at_login: Option<bool>,
}

impl SettingsPatch {
    pub fn apply(self, current: &AppSettings) -> Result<AppSettings, CommandError> {
        if self.root.is_some() {
            return Err(CommandError::new(
                "rootRequiresPicker",
                "The library root can only be changed with the native folder picker.",
            ));
        }

        let mut next = current.clone();
        if let Some(locale) = self.language {
            let locale = locale.trim();
            validate_locale(locale)?;
            next.locale = locale.to_owned();
        }

        if let Some(shortcut) = self.global_shortcut {
            let shortcut = shortcut.trim();
            if shortcut.is_empty() || shortcut.len() > 128 || shortcut.contains('\0') {
                return Err(CommandError::new(
                    "invalidShortcut",
                    "Shortcut must be a non-empty accelerator of at most 128 bytes.",
                ));
            }
            shortcut
                .parse::<tauri_plugin_global_shortcut::Shortcut>()
                .map_err(|error| {
                    CommandError::new("invalidShortcut", error.to_string())
                        .with_details(serde_json::json!({ "shortcut": shortcut }))
                })?;
            next.shortcut = shortcut.to_owned();
        }

        if let Some(launch_at_login) = self.launch_at_login {
            next.launch_at_login = launch_at_login;
        }

        Ok(next)
    }
}

pub struct SettingsStore {
    path: PathBuf,
    current: RwLock<AppSettings>,
}

impl SettingsStore {
    pub fn load<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, CommandError> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| CommandError::new("appDataUnavailable", error.to_string()))?;
        Self::load_from(directory.join(SETTINGS_FILE_NAME))
    }

    pub(crate) fn load_from(path: PathBuf) -> Result<Self, CommandError> {
        let settings = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<AppSettings>(&bytes).map_err(|error| {
                CommandError::new(
                    "settingsInvalid",
                    format!("Could not parse {}: {error}", path.display()),
                )
            })?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => AppSettings::default(),
            Err(error) => return Err(error.into()),
        };
        validate_locale(&settings.locale).map_err(|error| {
            CommandError::new(
                "settingsInvalid",
                format!("Could not load {}: {}", path.display(), error.message),
            )
            .with_details(serde_json::json!({ "language": settings.locale }))
        })?;

        Ok(Self {
            path,
            current: RwLock::new(settings),
        })
    }

    pub fn get(&self) -> AppSettings {
        self.current.read().clone()
    }

    /// Persists first and only publishes the in-memory value after the durable
    /// replace succeeds. A failed write therefore leaves both views on the old
    /// settings.
    pub fn replace(&self, settings: AppSettings) -> Result<(), CommandError> {
        persist_atomic(&self.path, &settings)?;
        *self.current.write() = settings;
        Ok(())
    }
}

fn validate_locale(locale: &str) -> Result<(), CommandError> {
    if matches!(locale, "system" | "zh-CN" | "en") {
        Ok(())
    } else {
        Err(
            CommandError::new("invalidLocale", "Language must be system, zh-CN, or en.")
                .with_details(serde_json::json!({ "language": locale })),
        )
    }
}

fn persist_atomic(path: &Path, settings: &AppSettings) -> Result<(), CommandError> {
    let parent = path.parent().ok_or_else(|| {
        CommandError::new(
            "settingsPathInvalid",
            "Settings path does not have a parent directory.",
        )
    })?;
    fs::create_dir_all(parent)?;

    let mut bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| CommandError::new("settingsSerialize", error.to_string()))?;
    bytes.push(b'\n');

    let temporary = parent.join(format!(".settings.{}.tmp", Uuid::new_v4()));
    let write_result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        atomic_replace(&temporary, path)?;
        sync_parent(parent)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result.map_err(CommandError::from)
}

#[cfg(not(windows))]
fn atomic_replace(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn atomic_replace(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !destination.exists() {
        return fs::rename(temporary, destination);
    }

    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let temporary: Vec<u16> = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: both pointers refer to NUL-terminated buffers that remain alive
    // for the duration of the call; the optional pointer parameters are null.
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            temporary.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn defaults_and_field_names_are_stable() {
        let value = serde_json::to_value(AppSettings::default()).unwrap();
        assert_eq!(value["root"], Value::Null);
        assert_eq!(value["locale"], "system");
        assert_eq!(value["shortcut"], DEFAULT_SHORTCUT);
        assert_eq!(value["launchAtLogin"], false);
        assert!(value.get("launch_at_login").is_none());
    }

    #[test]
    fn replacement_is_atomic_from_the_stores_point_of_view() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SETTINGS_FILE_NAME);
        let store = SettingsStore::load_from(path.clone()).unwrap();

        let mut changed = store.get();
        changed.locale = "zh-CN".to_owned();
        changed.launch_at_login = true;
        store.replace(changed.clone()).unwrap();

        let reloaded = SettingsStore::load_from(path).unwrap();
        assert_eq!(reloaded.get(), changed);
        assert!(directory.path().read_dir().unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
    }

    #[test]
    fn malformed_settings_are_reported_and_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SETTINGS_FILE_NAME);
        fs::write(&path, b"{not-json").unwrap();

        let error = SettingsStore::load_from(path.clone()).err().unwrap();
        assert_eq!(error.code, "settingsInvalid");
        assert_eq!(fs::read(path).unwrap(), b"{not-json");
    }

    #[test]
    fn root_patch_cannot_bypass_the_native_picker() {
        let patch = SettingsPatch {
            root: Some(PathBuf::from("/tmp/not-a-grant")),
            ..SettingsPatch::default()
        };
        let error = patch.apply(&AppSettings::default()).unwrap_err();
        assert_eq!(error.code, "rootRequiresPicker");
    }

    #[test]
    fn locale_patch_accepts_only_the_public_language_preferences() {
        for language in ["system", "zh-CN", "en"] {
            let next = SettingsPatch {
                language: Some(language.to_owned()),
                ..SettingsPatch::default()
            }
            .apply(&AppSettings::default())
            .unwrap();
            assert_eq!(next.locale, language);
        }

        for language in ["zh", "en-US", "fr", "SYSTEM"] {
            let error = SettingsPatch {
                language: Some(language.to_owned()),
                ..SettingsPatch::default()
            }
            .apply(&AppSettings::default())
            .unwrap_err();
            assert_eq!(error.code, "invalidLocale");
        }
    }
}
