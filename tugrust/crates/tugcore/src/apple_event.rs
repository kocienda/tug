//! Sending an Apple Event to a process by pid, from Rust.
//!
//! A Tug instance is quit the way the OS quits any app: with the
//! `'aevt'/'quit'` Apple Event, which AppKit turns into
//! `applicationShouldTerminate` and the deck's termination pipeline. A signal
//! skips all of that, so this module is the only quit sender `tugtool` has.
//!
//! The event is addressed by **kernel process id** (`typeKernelProcessID`),
//! taken from the instance registry — never by bundle id or name, so the
//! wrong instance is unreachable — and sent with `AESendMessage`, waiting for
//! the reply up to a timeout and never interacting with the user. What comes
//! back is numbers: the send's `OSStatus`, any error the handler put in the
//! reply, and how long the reply took. [`describe`] names a status, so a
//! failure reads as `errAEEventNotPermitted (-1743): …` with its fix, not as a
//! bare number.
//!
//! This is the first link to an Apple framework under `tugrust/`, so the
//! `extern` block and its link attribute live here alone, behind
//! `cfg(target_os = "macos")`; everything else in the module is a safe wrapper.

use std::ffi::c_void;
use std::time::{Duration, Instant};

/// A four-character code, as the Apple Event Manager spells its types,
/// classes, ids and keywords.
pub const fn four_cc(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

/// `'aevt'` — the core event class.
pub const CORE_EVENT_CLASS: u32 = four_cc(b"aevt");
/// `'quit'` — quit the application.
pub const QUIT_APPLICATION: u32 = four_cc(b"quit");

const TYPE_KERNEL_PROCESS_ID: u32 = four_cc(b"kpid");
const TYPE_SINT32: u32 = four_cc(b"long");
const KEY_ERROR_NUMBER: u32 = four_cc(b"errn");
#[cfg(test)]
const KEY_EVENT_CLASS_ATTR: u32 = four_cc(b"evcl");
#[cfg(test)]
const KEY_EVENT_ID_ATTR: u32 = four_cc(b"evid");
#[cfg(test)]
const TYPE_TYPE: u32 = four_cc(b"type");

const K_AUTO_GENERATE_RETURN_ID: i16 = -1;
const K_ANY_TRANSACTION_ID: i32 = 0;
const K_AE_WAIT_REPLY: i32 = 0x0000_0003;
const K_AE_NEVER_INTERACT: i32 = 0x0000_0010;

/// Ticks are sixtieths of a second.
const TICKS_PER_SECOND: u128 = 60;

/// `AEDesc`, laid out as the Apple headers declare it: under
/// `#pragma pack(2)`, so the handle sits at offset 4 and the struct is 12
/// bytes on a 64-bit target. Natural alignment would put it at offset 8 and
/// hand CoreServices a descriptor it reads garbage from.
#[repr(C, packed(2))]
struct AEDesc {
    descriptor_type: u32,
    data_handle: *mut c_void,
}

impl AEDesc {
    const fn null() -> Self {
        Self {
            descriptor_type: four_cc(b"null"),
            data_handle: std::ptr::null_mut(),
        }
    }
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn AECreateDesc(
        type_code: u32,
        data_ptr: *const c_void,
        data_size: isize,
        result: *mut AEDesc,
    ) -> i16;
    fn AECreateAppleEvent(
        event_class: u32,
        event_id: u32,
        target: *const AEDesc,
        return_id: i16,
        transaction_id: i32,
        result: *mut AEDesc,
    ) -> i16;
    fn AESendMessage(
        event: *const AEDesc,
        reply: *mut AEDesc,
        send_mode: i32,
        timeout_in_ticks: std::os::raw::c_long,
    ) -> i32;
    fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
    fn AEGetParamPtr(
        event: *const AEDesc,
        keyword: u32,
        desired_type: u32,
        actual_type: *mut u32,
        data_ptr: *mut c_void,
        maximum_size: isize,
        actual_size: *mut isize,
    ) -> i16;
    #[cfg(test)]
    fn AEGetDescDataSize(desc: *const AEDesc) -> isize;
    #[cfg(test)]
    fn AEGetDescData(desc: *const AEDesc, data_ptr: *mut c_void, maximum_size: isize) -> i16;
    #[cfg(test)]
    fn AEGetAttributePtr(
        event: *const AEDesc,
        keyword: u32,
        desired_type: u32,
        actual_type: *mut u32,
        data_ptr: *mut c_void,
        maximum_size: isize,
        actual_size: *mut isize,
    ) -> i16;
}

/// An owned descriptor, disposed when dropped.
struct Desc(AEDesc);

impl Desc {
    fn empty() -> Self {
        Self(AEDesc::null())
    }

    /// The descriptor that addresses the process `pid`.
    fn target_pid(pid: i32) -> Result<Self, i32> {
        let mut desc = Self::empty();
        // SAFETY: `pid` outlives the call, which copies its four bytes into a
        // handle the descriptor owns.
        let status = unsafe {
            AECreateDesc(
                TYPE_KERNEL_PROCESS_ID,
                (&pid as *const i32).cast(),
                std::mem::size_of::<i32>() as isize,
                &mut desc.0,
            )
        };
        if status == 0 {
            Ok(desc)
        } else {
            Err(status.into())
        }
    }

    /// A new Apple Event of `class`/`id` addressed to `target`.
    fn event(class: u32, id: u32, target: &Desc) -> Result<Self, i32> {
        let mut event = Self::empty();
        // SAFETY: `target` is a live descriptor; the event copies it.
        let status = unsafe {
            AECreateAppleEvent(
                class,
                id,
                &target.0,
                K_AUTO_GENERATE_RETURN_ID,
                K_ANY_TRANSACTION_ID,
                &mut event.0,
            )
        };
        if status == 0 {
            Ok(event)
        } else {
            Err(status.into())
        }
    }

    /// The descriptor's raw data bytes.
    #[cfg(test)]
    fn data(&self) -> Vec<u8> {
        // SAFETY: the buffer is sized from the descriptor itself.
        unsafe {
            let size = AEGetDescDataSize(&self.0).max(0);
            let mut bytes = vec![0u8; size as usize];
            if AEGetDescData(&self.0, bytes.as_mut_ptr().cast(), size) != 0 {
                bytes.clear();
            }
            bytes
        }
    }

    /// A 32-bit integer parameter, coerced to `typeSInt32`, if present.
    fn param_i32(&self, keyword: u32) -> Option<i32> {
        let mut value: i32 = 0;
        let mut actual_type = 0u32;
        let mut actual_size = 0isize;
        // SAFETY: the out-pointers are live and sized for one i32.
        let status = unsafe {
            AEGetParamPtr(
                &self.0,
                keyword,
                TYPE_SINT32,
                &mut actual_type,
                (&mut value as *mut i32).cast(),
                std::mem::size_of::<i32>() as isize,
                &mut actual_size,
            )
        };
        (status == 0).then_some(value)
    }

    #[cfg(test)]
    fn attribute_four_cc(&self, keyword: u32) -> Option<u32> {
        let mut value: u32 = 0;
        let mut actual_type = 0u32;
        let mut actual_size = 0isize;
        // SAFETY: the out-pointers are live and sized for one u32.
        let status = unsafe {
            AEGetAttributePtr(
                &self.0,
                keyword,
                TYPE_TYPE,
                &mut actual_type,
                (&mut value as *mut u32).cast(),
                std::mem::size_of::<u32>() as isize,
                &mut actual_size,
            )
        };
        (status == 0).then_some(value)
    }
}

impl Drop for Desc {
    fn drop(&mut self) {
        // SAFETY: disposing a null descriptor is a no-op, and a filled one is
        // owned by this value alone.
        unsafe {
            AEDisposeDesc(&mut self.0);
        }
    }
}

/// What one send came back with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SendOutcome {
    /// `AESendMessage`'s status, or the status of building the event when
    /// that failed first. `0` means the target replied.
    pub status: i32,
    /// The `errn` the target's handler put in its reply, when it replied with
    /// one — the target answered, and the answer was a failure.
    pub reply_error: Option<i32>,
    /// From the send to its return: the reply, the timeout, or the failure.
    pub elapsed: Duration,
}

impl SendOutcome {
    /// The status that decides the outcome: the send's when it failed, else
    /// the reply's error, else none.
    pub fn error_code(&self) -> Option<i32> {
        if self.status != 0 {
            Some(self.status)
        } else {
            self.reply_error.filter(|&code| code != 0)
        }
    }
}

/// Send `class`/`id` to the process `pid` and wait for its reply, at most
/// `timeout`.
///
/// Never interacts: no permission prompt is raised and no app is launched.
/// A process that cannot take Apple Events, or that is gone, fails with the
/// matching status — and is sent nothing else. This function never signals.
pub fn send(pid: i32, class: u32, id: u32, timeout: Duration) -> SendOutcome {
    let started = Instant::now();
    let failed = |status: i32| SendOutcome {
        status,
        reply_error: None,
        elapsed: started.elapsed(),
    };
    let target = match Desc::target_pid(pid) {
        Ok(target) => target,
        Err(status) => return failed(status),
    };
    let event = match Desc::event(class, id, &target) {
        Ok(event) => event,
        Err(status) => return failed(status),
    };
    let mut reply = Desc::empty();
    let ticks = (timeout.as_millis() * TICKS_PER_SECOND / 1000).max(1);
    let ticks = std::os::raw::c_long::try_from(ticks).unwrap_or(std::os::raw::c_long::MAX);
    // SAFETY: `event` is a live Apple Event and `reply` an empty descriptor
    // the call fills; both are disposed by their owners.
    let status = unsafe {
        AESendMessage(
            &event.0,
            &mut reply.0,
            K_AE_WAIT_REPLY | K_AE_NEVER_INTERACT,
            ticks,
        )
    };
    SendOutcome {
        status,
        reply_error: if status == 0 {
            reply.param_i32(KEY_ERROR_NUMBER)
        } else {
            None
        },
        elapsed: started.elapsed(),
    }
}

/// An Apple Event status, named and explained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status {
    pub code: i32,
    /// The constant's name in the Apple headers, or `"unknown"`.
    pub name: &'static str,
    /// What it means for a quit sender, and the fix where there is one.
    pub meaning: &'static str,
}

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}): {}", self.name, self.code, self.meaning)
    }
}

/// Name the status `code`.
pub fn describe(code: i32) -> Status {
    let (name, meaning) = match code {
        0 => ("noErr", "the target replied"),
        -50 => (
            "paramErr",
            "the event or its target descriptor was malformed",
        ),
        -128 => (
            "userCanceledErr",
            "the target's handler cancelled the event",
        ),
        -600 => (
            "procNotFound",
            "no process with that pid takes Apple Events — it has exited, or it is not an app",
        ),
        -609 => (
            "connectionInvalid",
            "the connection closed before a reply — the target exited while handling the event",
        ),
        -903 => (
            "noPortErr",
            "the target has no Apple Event port — it is not a GUI app",
        ),
        -1701 => (
            "errAEDescNotFound",
            "the reply lacks a parameter that was asked for",
        ),
        -1708 => (
            "errAEEventNotHandled",
            "the target received the event and has no handler for it — it was dispatched",
        ),
        -1712 => (
            "errAETimeout",
            "the target did not reply within the timeout — it may not be dispatching Apple Events",
        ),
        -1743 => (
            "errAEEventNotPermitted",
            "this terminal lacks Automation permission to control Tug; allow it under System Settings ▸ Privacy & Security ▸ Automation, then retry",
        ),
        -1744 => (
            "errAEEventWouldRequireUserConsent",
            "sending needs a one-time Automation consent this non-interactive send cannot ask for; run `osascript -e 'tell application id \"<bundle id>\" to get name'` once from this terminal and allow it",
        ),
        _ => ("unknown", "an Apple Event Manager status with no name here"),
    };
    Status {
        code,
        name,
        meaning,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_character_codes_are_big_endian() {
        assert_eq!(CORE_EVENT_CLASS, 0x6165_7674);
        assert_eq!(QUIT_APPLICATION, 0x7175_6974);
    }

    #[test]
    fn the_descriptor_has_the_headers_packed_layout() {
        assert_eq!(std::mem::size_of::<AEDesc>(), 12);
        assert_eq!(std::mem::offset_of!(AEDesc, data_handle), 4);
    }

    #[test]
    fn a_pid_target_carries_the_kernel_process_id_type_and_the_pid() {
        let target = Desc::target_pid(4242).unwrap();
        let descriptor_type = target.0.descriptor_type;
        assert_eq!(descriptor_type, TYPE_KERNEL_PROCESS_ID);
        assert_eq!(target.data(), 4242i32.to_ne_bytes());
    }

    #[test]
    fn an_event_carries_its_class_and_id() {
        let target = Desc::target_pid(std::process::id() as i32).unwrap();
        let event = Desc::event(CORE_EVENT_CLASS, QUIT_APPLICATION, &target).unwrap();
        assert_eq!(
            event.attribute_four_cc(KEY_EVENT_CLASS_ATTR),
            Some(CORE_EVENT_CLASS)
        );
        assert_eq!(
            event.attribute_four_cc(KEY_EVENT_ID_ATTR),
            Some(QUIT_APPLICATION)
        );
    }

    #[test]
    fn permission_failures_are_named_with_their_fix() {
        let denied = describe(-1743);
        assert_eq!(denied.name, "errAEEventNotPermitted");
        assert!(denied.meaning.contains("Automation"));
        assert!(
            denied
                .to_string()
                .starts_with("errAEEventNotPermitted (-1743): ")
        );
        assert_eq!(describe(-1744).name, "errAEEventWouldRequireUserConsent");
        assert_eq!(describe(-1712).name, "errAETimeout");
        assert_eq!(describe(-600).name, "procNotFound");
        assert_eq!(describe(-12345).name, "unknown");
    }

    #[test]
    fn the_outcome_error_is_the_send_failure_else_the_reply_error() {
        let ok = SendOutcome {
            status: 0,
            reply_error: None,
            elapsed: Duration::ZERO,
        };
        assert_eq!(ok.error_code(), None);
        assert_eq!(
            SendOutcome {
                reply_error: Some(-1708),
                ..ok
            }
            .error_code(),
            Some(-1708)
        );
        assert_eq!(
            SendOutcome {
                reply_error: Some(0),
                ..ok
            }
            .error_code(),
            None
        );
        assert_eq!(
            SendOutcome {
                status: -600,
                reply_error: Some(-1708),
                ..ok
            }
            .error_code(),
            Some(-600)
        );
    }

    /// A quit sent to a process that cannot take Apple Events fails with a
    /// named status, promptly, and the process is still running afterwards —
    /// the sender never falls back to a signal.
    #[test]
    fn a_quit_to_a_process_without_an_event_port_fails_and_signals_nothing() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let outcome = send(
            child.id() as i32,
            CORE_EVENT_CLASS,
            QUIT_APPLICATION,
            Duration::from_secs(2),
        );
        let alive = child.try_wait().expect("try_wait").is_none();
        let _ = child.kill();
        let _ = child.wait();

        let code = outcome
            .error_code()
            .expect("a send to `sleep` cannot succeed");
        assert_eq!(
            describe(code).name,
            "procNotFound",
            "a send to `sleep` came back {}",
            describe(code)
        );
        assert!(alive, "the `sleep` child died — something signalled it");
    }
}
