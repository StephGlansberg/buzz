//! Small durable cursor for accepted ACP requests.
//!
//! The relay remains the event store. This file only remembers which signed
//! triggering IDs are still open, which have closed, and the per-channel
//! replay floor needed to recover open work after a process restart.

use std::collections::{HashMap, VecDeque};
use std::fs;
#[cfg(unix)]
use std::io::Read;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const STATE_VERSION: u8 = 1;
const MAX_OPEN_PER_CHANNEL: usize = 4_096;
const MAX_HANDLED_PER_CHANNEL: usize = 4_096;

/// A signed sender timestamp may be old, but it must never move a reconnect
/// cursor ahead of the local receive wall clock.
pub(crate) fn safe_replay_timestamp(event_created_at: u64, received_at: u64) -> u64 {
    event_created_at.min(received_at)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OpenRequest {
    created_at: u64,
    #[serde(default)]
    requires_reply: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ChannelReplayState {
    #[serde(default)]
    last_seen: u64,
    #[serde(default)]
    open: HashMap<String, OpenRequest>,
    #[serde(default)]
    handled: VecDeque<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReplayDocument {
    version: u8,
    #[serde(default)]
    channels: HashMap<String, ChannelReplayState>,
}

impl Default for ReplayDocument {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            channels: HashMap::new(),
        }
    }
}

/// Durable replay state. `path=None` is an in-memory instance for unit tests.
#[derive(Debug, Default)]
pub(crate) struct ReplayState {
    path: Option<PathBuf>,
    document: ReplayDocument,
}

impl ReplayState {
    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Self::default()
    }

    pub(crate) fn path_for(config_path: &Path, agent_pubkey_hex: &str) -> PathBuf {
        let parent = config_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let stem = config_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("buzz-acp");
        let identity = agent_pubkey_hex.get(..16).unwrap_or(agent_pubkey_hex);
        parent.join(format!(".{stem}.replay-{identity}.json"))
    }

    pub(crate) fn load(path: PathBuf) -> io::Result<Self> {
        let document = match read_private_state(&path) {
            Ok(bytes) => {
                let document: ReplayDocument = serde_json::from_slice(&bytes)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                if document.version != STATE_VERSION {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "unsupported replay state version {} (expected {STATE_VERSION})",
                            document.version
                        ),
                    ));
                }
                document
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => ReplayDocument::default(),
            Err(error) => return Err(error),
        };
        Ok(Self {
            path: Some(path),
            document,
        })
    }

    /// Return the oldest open request timestamp, or the latest accepted cursor
    /// when no request is open. The relay applies its existing skew window.
    pub(crate) fn replay_since(&self, channel_id: Uuid) -> Option<u64> {
        let channel = self.document.channels.get(&channel_id.to_string())?;
        channel
            .open
            .values()
            .map(|request| request.created_at)
            .min()
            .or((channel.last_seen > 0).then_some(channel.last_seen))
    }

    pub(crate) fn is_handled(&self, channel_id: Uuid, event_id: &str) -> bool {
        self.document
            .channels
            .get(&channel_id.to_string())
            .is_some_and(|channel| channel.handled.iter().any(|handled| handled == event_id))
    }

    pub(crate) fn requires_reply(&self, channel_id: Uuid, event_id: &str) -> bool {
        self.document
            .channels
            .get(&channel_id.to_string())
            .and_then(|channel| channel.open.get(event_id))
            .is_some_and(|request| request.requires_reply)
    }

    /// Persist an accepted request before it enters the in-memory queue.
    /// Re-observation preserves (ORs) the original reply requirement. The
    /// replay cursor never trusts a sender-controlled future timestamp: it is
    /// capped at the local receive wall clock before being persisted.
    pub(crate) fn record_open(
        &mut self,
        channel_id: Uuid,
        event_id: String,
        event_created_at: u64,
        received_at: u64,
        requires_reply: bool,
    ) -> io::Result<bool> {
        let prior = self.document.clone();
        let channel = self
            .document
            .channels
            .entry(channel_id.to_string())
            .or_default();
        if channel.handled.iter().any(|handled| handled == &event_id) {
            return Ok(false);
        }
        if !channel.open.contains_key(&event_id) && channel.open.len() >= MAX_OPEN_PER_CHANNEL {
            return Err(io::Error::other(format!(
                "open replay request limit reached for channel {channel_id}"
            )));
        }
        let replay_at = safe_replay_timestamp(event_created_at, received_at);
        channel.last_seen = channel.last_seen.max(replay_at);
        channel
            .open
            .entry(event_id)
            .and_modify(|request| request.requires_reply |= requires_reply)
            .or_insert(OpenRequest {
                created_at: replay_at,
                requires_reply,
            });
        if let Err(error) = self.persist() {
            self.document = prior;
            return Err(error);
        }
        Ok(true)
    }

    /// Mark source events terminal, whether they were accepted/open or rejected
    /// before admission. Returns true when at least one new terminal id was
    /// recorded. This is the durable idempotency gate for reconnect/restart.
    pub(crate) fn terminalize(
        &mut self,
        channel_id: Uuid,
        event_ids: &[String],
    ) -> io::Result<bool> {
        let prior = self.document.clone();
        let channel = self
            .document
            .channels
            .entry(channel_id.to_string())
            .or_default();
        let mut changed = false;
        for event_id in event_ids {
            changed |= channel.open.remove(event_id).is_some();
            if !channel.handled.iter().any(|handled| handled == event_id) {
                channel.handled.push_back(event_id.clone());
                changed = true;
            }
        }
        while channel.handled.len() > MAX_HANDLED_PER_CHANNEL {
            channel.handled.pop_front();
        }
        if changed {
            if let Err(error) = self.persist() {
                self.document = prior;
                return Err(error);
            }
        }
        Ok(changed)
    }

    pub(crate) fn close(&mut self, channel_id: Uuid, event_ids: &[String]) -> io::Result<()> {
        self.terminalize(channel_id, event_ids).map(|_| ())
    }

    pub(crate) fn remove_channel(&mut self, channel_id: Uuid) -> io::Result<()> {
        let prior = self.document.clone();
        if self
            .document
            .channels
            .remove(&channel_id.to_string())
            .is_some()
        {
            if let Err(error) = self.persist() {
                self.document = prior;
                return Err(error);
            }
        }
        Ok(())
    }

    fn persist(&self) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec(&self.document).map_err(io::Error::other)?;
        write_private_atomic(path, &bytes)
    }
}

/// Read a replay document without following a destination symlink and reject
/// state readable by group/other users.
#[cfg(unix)]
fn read_private_state(path: &Path) -> io::Result<Vec<u8>> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "replay state is not a regular file",
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "replay state must be owner-only (0600)",
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(not(unix))]
fn read_private_state(path: &Path) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "replay state is not a regular file",
        ));
    }
    fs::read(path)
}

struct TempFileGuard(Option<PathBuf>);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn write_private_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("buzz-acp-replay");
    let temp_path = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4().as_simple()));
    let mut guard = TempFileGuard(Some(temp_path.clone()));
    let mut file = create_private_temp_file(&temp_path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);

    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&temp_path, path)?;
    guard.0 = None;

    // Persist the directory entry as well as the file contents so a clean
    // return cannot leave a rename vulnerable to a power-loss rollback.
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn create_private_temp_file(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn create_private_temp_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_config_places_state_in_current_directory() {
        let path = ReplayState::path_for(Path::new("buzz-acp.toml"), &"a".repeat(64));
        assert_eq!(
            path,
            PathBuf::from("./.buzz-acp.toml.replay-aaaaaaaaaaaaaaaa.json")
        );
    }

    #[test]
    fn restart_replays_open_and_skips_closed_requests() {
        let dir = std::env::temp_dir().join(format!(
            "buzz-acp-replay-state-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let channel = Uuid::new_v4();

        let mut first = ReplayState::load(path.clone()).unwrap();
        assert!(first
            .record_open(channel, "event-open".into(), 100, 100, true)
            .unwrap());
        assert_eq!(first.replay_since(channel), Some(100));
        drop(first);

        let mut restarted = ReplayState::load(path.clone()).unwrap();
        assert!(!restarted.is_handled(channel, "event-open"));
        assert!(restarted.requires_reply(channel, "event-open"));
        assert_eq!(restarted.replay_since(channel), Some(100));
        restarted
            .close(channel, &["event-open".to_string()])
            .unwrap();
        drop(restarted);

        let closed = ReplayState::load(path).unwrap();
        assert!(closed.is_handled(channel, "event-open"));
        assert!(!closed.requires_reply(channel, "event-open"));
        assert_eq!(closed.replay_since(channel), Some(100));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn replay_floor_is_oldest_open_request() {
        let channel = Uuid::new_v4();
        let mut state = ReplayState::in_memory();
        state
            .record_open(channel, "newer".into(), 200, 200, false)
            .unwrap();
        state
            .record_open(channel, "older".into(), 100, 100, false)
            .unwrap();
        assert_eq!(state.replay_since(channel), Some(100));
    }

    #[test]
    fn future_event_timestamp_is_clamped_to_local_receive_clock() {
        let dir = std::env::temp_dir().join(format!(
            "buzz-acp-replay-cursor-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let channel = Uuid::new_v4();

        let mut first = ReplayState::load(path.clone()).unwrap();
        first
            .record_open(channel, "future".into(), 50_000, 500, false)
            .unwrap();
        drop(first);

        let restarted = ReplayState::load(path).unwrap();
        assert_eq!(restarted.replay_since(channel), Some(500));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn terminal_rejection_is_idempotent_across_restart() {
        let dir = std::env::temp_dir().join(format!(
            "buzz-acp-replay-terminal-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let channel = Uuid::new_v4();
        let event_id = "rejected-event".to_string();

        let mut first = ReplayState::load(path.clone()).unwrap();
        assert!(first
            .terminalize(channel, std::slice::from_ref(&event_id))
            .unwrap());
        drop(first);

        let mut restarted = ReplayState::load(path).unwrap();
        assert!(restarted.is_handled(channel, &event_id));
        assert!(!restarted
            .terminalize(channel, std::slice::from_ref(&event_id))
            .unwrap());
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn persistence_is_owner_only_fsynced_and_leaves_no_temp_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "buzz-acp-replay-private-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let channel = Uuid::new_v4();
        let mut state = ReplayState::load(path.clone()).unwrap();
        state
            .record_open(channel, "accepted".into(), 100, 100, false)
            .unwrap();

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
        ReplayState::load(path).unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn state_and_temp_symlinks_are_rejected_without_touching_targets() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join(format!(
            "buzz-acp-replay-symlink-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target");
        std::fs::write(&target, b"unchanged").unwrap();

        let state_link = dir.join("state.json");
        symlink(&target, &state_link).unwrap();
        assert!(ReplayState::load(state_link).is_err());

        let temp_link = dir.join("predictable.tmp");
        symlink(&target, &temp_link).unwrap();
        assert!(create_private_temp_file(&temp_link).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"unchanged");
        std::fs::remove_dir_all(dir).ok();
    }
}
