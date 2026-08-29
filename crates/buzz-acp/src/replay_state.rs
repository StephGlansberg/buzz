//! Small durable cursor for accepted ACP requests.
//!
//! The relay remains the event store. This file only remembers which signed
//! triggering IDs are still open, which have closed, and the per-channel
//! replay floor needed to recover open work after a process restart.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const STATE_VERSION: u8 = 1;
const MAX_OPEN_PER_CHANNEL: usize = 4_096;
const MAX_HANDLED_PER_CHANNEL: usize = 4_096;

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
        let document = match std::fs::read(&path) {
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

    /// Persist the receive cursor before any asynchronous admission checks.
    /// `subscribe_channel_from` reuses it (with the relay's skew) on restart.
    pub(crate) fn record_cursor(&mut self, channel_id: Uuid, created_at: u64) -> io::Result<()> {
        let prior = self.document.clone();
        let channel = self
            .document
            .channels
            .entry(channel_id.to_string())
            .or_default();
        if created_at > channel.last_seen {
            channel.last_seen = created_at;
            if let Err(error) = self.persist() {
                self.document = prior;
                return Err(error);
            }
        }
        Ok(())
    }

    /// Persist an accepted request before it enters the in-memory queue.
    /// Re-observation preserves (ORs) the original reply requirement.
    pub(crate) fn record_open(
        &mut self,
        channel_id: Uuid,
        event_id: String,
        created_at: u64,
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
        channel.last_seen = channel.last_seen.max(created_at);
        channel
            .open
            .entry(event_id)
            .and_modify(|request| request.requires_reply |= requires_reply)
            .or_insert(OpenRequest {
                created_at,
                requires_reply,
            });
        if let Err(error) = self.persist() {
            self.document = prior;
            return Err(error);
        }
        Ok(true)
    }

    pub(crate) fn close(&mut self, channel_id: Uuid, event_ids: &[String]) -> io::Result<()> {
        let prior = self.document.clone();
        let Some(channel) = self.document.channels.get_mut(&channel_id.to_string()) else {
            return Ok(());
        };
        for event_id in event_ids {
            if channel.open.remove(event_id).is_some()
                && !channel.handled.iter().any(|handled| handled == event_id)
            {
                channel.handled.push_back(event_id.clone());
            }
        }
        while channel.handled.len() > MAX_HANDLED_PER_CHANNEL {
            channel.handled.pop_front();
        }
        if let Err(error) = self.persist() {
            self.document = prior;
            return Err(error);
        }
        Ok(())
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
            std::fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec(&self.document).map_err(io::Error::other)?;
        let temp_path = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&temp_path, bytes)?;
        #[cfg(windows)]
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        std::fs::rename(temp_path, path)
    }
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
            .record_open(channel, "event-open".into(), 100, true)
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
            .record_open(channel, "newer".into(), 200, false)
            .unwrap();
        state
            .record_open(channel, "older".into(), 100, false)
            .unwrap();
        assert_eq!(state.replay_since(channel), Some(100));
    }

    #[test]
    fn receive_cursor_survives_restart_before_admission() {
        let dir = std::env::temp_dir().join(format!(
            "buzz-acp-replay-cursor-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let channel = Uuid::new_v4();

        let mut first = ReplayState::load(path.clone()).unwrap();
        first.record_cursor(channel, 500).unwrap();
        drop(first);

        let restarted = ReplayState::load(path).unwrap();
        assert_eq!(restarted.replay_since(channel), Some(500));
        std::fs::remove_dir_all(dir).ok();
    }
}
