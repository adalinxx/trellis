//! Transaction-scope validity policy for the Trellis chain.
//!
//! Base consensus lets any signer write any general-state key. This policy
//! attributes every key to its writer, in one of two shapes:
//!
//! - `user/<owner>/...`: the owner's own records.
//! - `index/.../<owner>`: the owner's entry under a shared topic, so a topic
//!   can be listed by prefix without knowing who wrote to it.
//!
//! The owner segment must be one of the transaction's signers. Whoever owns a
//! key may create, overwrite or delete it. What the records mean is up to
//! clients; the chain only says whose they are.
//!
//! Coin actions (transfers, deposits, receipts, withdrawals) are not this
//! policy's business and pass untouched.
#![cfg_attr(not(test), no_std)]

const MAGIC: &[u8] = b"LWPCTX";
const CONTEXT_ENCODING_VERSION: u16 = 2;
/// Magic, encoding version, ABI version, scope, height, timestamp.
const HEADER_BYTES: usize = 6 + 2 + 2 + 1 + 8 + 8;

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8]) -> bool {
    transaction_body(context).and_then(check_body).is_some()
}

fn transaction_body(context: &[u8]) -> Option<&[u8]> {
    if context.get(..MAGIC.len())? != MAGIC {
        return None;
    }
    if u16::from_be_bytes(context.get(6..8)?.try_into().ok()?) != CONTEXT_ENCODING_VERSION {
        return None;
    }
    let mut at = HEADER_BYTES;
    let (_spec, next) = length_prefixed(context, at)?;
    at = next;
    let path_items = u32_at(context, at)?;
    at += 4;
    for _ in 0..path_items {
        at = length_prefixed(context, at)?.1;
    }
    if *context.get(at)? != 1 {
        return None;
    }
    Some(length_prefixed(context, at + 1)?.0)
}

fn check_body(body: &[u8]) -> Option<()> {
    if skip(body, 0)? != body.len() {
        return None;
    }
    let signers = map_value(body, 0, b"signers")?;
    let actions = map_value(body, 0, b"actions")?;
    let (major, count, mut at) = head(body, actions)?;
    if major != ARRAY {
        return None;
    }
    for _ in 0..count {
        let key = text(body, map_value(body, at, b"key")?)?;
        check_key(body, signers, key)?;
        at = skip(body, at)?;
    }
    Some(())
}

fn check_key(body: &[u8], signers: usize, key: &[u8]) -> Option<()> {
    let mut segments = key.split(|&byte| byte == b'/');
    let owner = match segments.next()? {
        b"user" => segments.next()?,
        b"index" => {
            segments.next()?; // at least one topic segment
            segments.last()?
        }
        _ => return None,
    };
    is_signer(body, signers, owner)
}

fn is_signer(body: &[u8], signers: usize, owner: &[u8]) -> Option<()> {
    let (major, count, mut at) = head(body, signers)?;
    if major != ARRAY {
        return None;
    }
    for _ in 0..count {
        if text(body, at)? == owner {
            return Some(());
        }
        at = skip(body, at)?;
    }
    None
}

fn u32_at(bytes: &[u8], at: usize) -> Option<usize> {
    let raw = bytes.get(at..at.checked_add(4)?)?;
    Some(u32::from_be_bytes(raw.try_into().ok()?) as usize)
}

fn length_prefixed(bytes: &[u8], at: usize) -> Option<(&[u8], usize)> {
    let start = at.checked_add(4)?;
    let end = start.checked_add(u32_at(bytes, at)?)?;
    Some((bytes.get(start..end)?, end))
}

// DAG-CBOR: definite lengths only, text-keyed maps.

const BYTES: u8 = 2;
const TEXT: u8 = 3;
const ARRAY: u8 = 4;
const MAP: u8 = 5;
const TAG: u8 = 6;

/// The item head at `at`: `(major type, argument, offset after the head)`.
fn head(bytes: &[u8], at: usize) -> Option<(u8, u64, usize)> {
    let first = *bytes.get(at)?;
    let width = match first & 0x1f {
        small @ 0..=23 => return Some((first >> 5, small as u64, at + 1)),
        24 => 1,
        25 => 2,
        26 => 4,
        27 => 8,
        _ => return None,
    };
    let end = (at + 1).checked_add(width)?;
    let argument = bytes
        .get(at + 1..end)?
        .iter()
        .fold(0u64, |value, &byte| (value << 8) | byte as u64);
    Some((first >> 5, argument, end))
}

/// The offset just past the item at `at`.
fn skip(bytes: &[u8], mut at: usize) -> Option<usize> {
    let mut pending: u64 = 1;
    while pending > 0 {
        let (major, argument, next) = head(bytes, at)?;
        at = next;
        pending -= 1;
        match major {
            BYTES | TEXT => {
                at = at.checked_add(usize::try_from(argument).ok()?)?;
                if at > bytes.len() {
                    return None;
                }
            }
            ARRAY => pending = pending.checked_add(argument)?,
            MAP => pending = pending.checked_add(argument.checked_mul(2)?)?,
            TAG => pending += 1,
            _ => {}
        }
    }
    Some(at)
}

/// The offset of the value stored under `key` in the map at `at`.
fn map_value(bytes: &[u8], at: usize, key: &[u8]) -> Option<usize> {
    let (major, pairs, mut next) = head(bytes, at)?;
    if major != MAP {
        return None;
    }
    for _ in 0..pairs {
        let name = text(bytes, next)?;
        let value = skip(bytes, next)?;
        if name == key {
            return Some(value);
        }
        next = skip(bytes, value)?;
    }
    None
}

fn text(bytes: &[u8], at: usize) -> Option<&[u8]> {
    let (major, length, start) = head(bytes, at)?;
    if major != TEXT {
        return None;
    }
    bytes.get(start..start.checked_add(usize::try_from(length).ok()?)?)
}

#[cfg(target_arch = "wasm32")]
mod abi {
    use core::arch::wasm32::{memory_grow, memory_size, unreachable};

    const PAGE_BYTES: usize = 65536;

    extern "C" {
        static __heap_base: u8;
    }

    /// The host calls this once per evaluation, on a fresh instance, so the
    /// allocation is simply the memory above the module's own data.
    #[no_mangle]
    pub extern "C" fn lattice_alloc(length: i32) -> i32 {
        let base = unsafe { &__heap_base as *const u8 as usize };
        let Some(end) = usize::try_from(length).ok().and_then(|length| base.checked_add(length))
        else {
            return -1;
        };
        let have = memory_size(0) * PAGE_BYTES;
        if end > have && memory_grow(0, (end - have).div_ceil(PAGE_BYTES)) == usize::MAX {
            return -1;
        }
        base as i32
    }

    #[no_mangle]
    pub extern "C" fn lattice_validate_transaction(pointer: i32, length: i32) -> i32 {
        if pointer < 0 || length < 0 {
            return 0;
        }
        let context =
            unsafe { core::slice::from_raw_parts(pointer as usize as *const u8, length as usize) };
        super::validate(context) as i32
    }

    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo) -> ! {
        unreachable()
    }
}
