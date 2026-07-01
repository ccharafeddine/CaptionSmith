// A small cancellation primitive shared by long-running sidecar operations
// (audio extraction + transcription). One handle can guard a sequence of child
// processes: whichever child is currently registered gets killed on cancel.
//
// std::process (not tokio) because we spawn sidecars via std::process::Command
// to avoid the shell plugin's stream corruption (#3090). This plays the role of
// ClipSmith's tokio::select! cancel race, adapted to synchronous child I/O.

use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct Cancellation {
    flag: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

impl Cancellation {
    /// Clear the flag and forget any prior child. Call at the start of a run.
    pub fn reset(&self) {
        self.flag.store(false, Ordering::SeqCst);
        let _ = self.child.lock().unwrap().take();
    }

    /// Request cancellation and kill the currently registered child, if any.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Register the child that a cancel should kill.
    pub fn set_child(&self, child: Child) {
        *self.child.lock().unwrap() = Some(child);
    }

    /// Reclaim the child for waiting (None if cancel already took/killed it).
    pub fn take_child(&self) -> Option<Child> {
        self.child.lock().unwrap().take()
    }
}
