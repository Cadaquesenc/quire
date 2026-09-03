//! quire-glass — makes the host window translucent.
//!
//! loaded with DYLD_INSERT_LIBRARIES, declared in the app's Info.plist. the app
//! is signed with the hardened runtime, so this only loads because the bundle
//! carries `allow-dyld-environment-variables` and `disable-library-validation`.
//!
//! the window is made non-opaque and given a clear background, the web view is
//! told to stop painting its own, and the blur behind the glass comes from
//! CGSSetWindowBackgroundBlurRadius — a private CoreGraphics call, and the only
//! way to set a blur radius on macos. AppKit's NSVisualEffectView has fixed
//! materials and cannot do it. this is the same route ghostty takes.
//!
//! the translucent colour itself is not set here: the page paints it, so the
//! editor can change opacity live without going back through native code.

#![allow(non_snake_case, non_upper_case_globals)]

use std::ffi::{c_char, c_int, c_void, CString};

type Id = *mut c_void;
type Sel = *const c_void;
type Class = *mut c_void;

#[link(name = "AppKit", kind = "framework")]
#[link(name = "CoreGraphics", kind = "framework")]
#[link(name = "Foundation", kind = "framework")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Class;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();

    fn dispatch_after_f(when: u64, queue: *mut c_void, ctx: *mut c_void,
                        work: extern "C" fn(*mut c_void));
    fn dispatch_time(base: u64, delta: i64) -> u64;

    // dispatch_get_main_queue() is an inline in C, not a real symbol. the queue
    // itself is this global, and its address is what the C macro resolves to.
    static _dispatch_main_q: c_void;

    // private, but stable since 10.7 and the only blur-radius control that exists
    fn CGSMainConnectionID() -> c_int;
    fn CGSSetWindowBackgroundBlurRadius(cid: c_int, wid: c_int, radius: c_int) -> c_int;
}

const DISPATCH_TIME_NOW: u64 = 0;
const NSEC_PER_SEC: i64 = 1_000_000_000;

/// how far the blur reaches behind the window. matches the ghostty setup.
const BLUR_RADIUS: c_int = 20;

fn sel(name: &str) -> Sel {
    let c = CString::new(name).unwrap();
    unsafe { sel_registerName(c.as_ptr()) }
}

fn class(name: &str) -> Class {
    let c = CString::new(name).unwrap();
    unsafe { objc_getClass(c.as_ptr()) }
}

// objc_msgSend has no single signature: it is transmuted per call shape.
unsafe fn send(obj: Id, s: Sel) -> Id {
    let f: extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as *const ());
    f(obj, s)
}
unsafe fn send_bool(obj: Id, s: Sel, v: bool) {
    let f: extern "C" fn(Id, Sel, bool) = std::mem::transmute(objc_msgSend as *const ());
    f(obj, s, v)
}
unsafe fn send_id(obj: Id, s: Sel, a: Id) -> Id {
    let f: extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute(objc_msgSend as *const ());
    f(obj, s, a)
}
unsafe fn send_usize(obj: Id, s: Sel, a: usize) -> Id {
    let f: extern "C" fn(Id, Sel, usize) -> Id = std::mem::transmute(objc_msgSend as *const ());
    f(obj, s, a)
}
unsafe fn send_isize(obj: Id, s: Sel) -> isize {
    let f: extern "C" fn(Id, Sel) -> isize = std::mem::transmute(objc_msgSend as *const ());
    f(obj, s)
}
unsafe fn responds(obj: Id, s: Sel) -> bool {
    let f: extern "C" fn(Id, Sel, Sel) -> bool = std::mem::transmute(objc_msgSend as *const ());
    f(obj, sel("respondsToSelector:"), s)
}

/// the web view paints an opaque background of its own. until that is switched
/// off, a transparent window still looks solid. the modern and legacy views
/// spell the same idea differently, and the legacy one is what this app uses.
unsafe fn clear_web_backgrounds(view: Id, depth: u32) {
    if view.is_null() || depth > 12 {
        return;
    }
    // note the sign: drawsBackground NO and drawsTransparentBackground YES mean
    // the same thing. passing the same boolean to both would undo one with the
    // other.
    for name in ["setDrawsBackground:", "_setDrawsBackground:"] {
        let s = sel(name);
        if responds(view, s) {
            send_bool(view, s, false);
        }
    }
    let transparent = sel("_setDrawsTransparentBackground:");
    if responds(view, transparent) {
        send_bool(view, transparent, true);
    }
    let subviews = send(view, sel("subviews"));
    if subviews.is_null() {
        return;
    }
    let n = send_isize(subviews, sel("count"));
    for i in 0..n {
        let child = send_usize(subviews, sel("objectAtIndex:"), i as usize);
        clear_web_backgrounds(child, depth + 1);
    }
}

unsafe fn glass(window: Id) {
    if window.is_null() {
        return;
    }
    // a window with a titlebar and no content is a panel or a sheet; leave those
    let content = send(window, sel("contentView"));
    if content.is_null() {
        return;
    }

    send_bool(window, sel("setOpaque:"), false);

    let clear = send(class("NSColor") as Id, sel("clearColor"));
    send_id(window, sel("setBackgroundColor:"), clear);

    let tat = sel("setTitlebarAppearsTransparent:");
    if responds(window, tat) {
        send_bool(window, tat, true);
    }

    clear_web_backgrounds(content, 0);

    // the content view's own layer is opaque by default; the blur behind the
    // window has nothing to show through until it is not
    let layer_sel = sel("layer");
    if responds(content, layer_sel) {
        let layer = send(content, layer_sel);
        if !layer.is_null() {
            send_bool(layer, sel("setOpaque:"), false);
        }
    }

    let wid = send_isize(window, sel("windowNumber")) as c_int;
    if wid > 0 {
        CGSSetWindowBackgroundBlurRadius(CGSMainConnectionID(), wid, BLUR_RADIUS);
    }
}

unsafe fn apply_to_all_windows() {
    let app_class = class("NSApplication");
    if app_class.is_null() {
        return;
    }
    let app = send(app_class as Id, sel("sharedApplication"));
    if app.is_null() {
        return;
    }
    let windows = send(app, sel("windows"));
    if windows.is_null() {
        return;
    }
    let n = send_isize(windows, sel("count"));
    for i in 0..n {
        glass(send_usize(windows, sel("objectAtIndex:"), i as usize));
    }
}

/// windows are created long after this library loads, and more appear whenever a
/// tab or a second document opens, so this keeps checking rather than running
/// once. it is a handful of pointer reads against a list that is almost always
/// one element long.
extern "C" fn tick(_ctx: *mut c_void) {
    unsafe {
        apply_to_all_windows();
        schedule(0.5);
    }
}

unsafe fn schedule(secs: f64) {
    let when = dispatch_time(DISPATCH_TIME_NOW, (secs * NSEC_PER_SEC as f64) as i64);
    let main_q = &_dispatch_main_q as *const c_void as *mut c_void;
    dispatch_after_f(when, main_q, std::ptr::null_mut(), tick);
}

extern "C" fn init() {
    unsafe { schedule(0.4) }
}

#[used]
#[link_section = "__DATA,__mod_init_func"]
static INIT: extern "C" fn() = init;
