//! quire-glass: makes the host window translucent.
//!
//! loaded with DYLD_INSERT_LIBRARIES, declared in the app's Info.plist. the app
//! is signed with the hardened runtime, so this only loads because the bundle
//! carries `allow-dyld-environment-variables` and `disable-library-validation`.
//!
//! the window is made non-opaque and given a clear background, the web view is
//! told to stop painting its own, and the blur behind the glass comes from
//! CGSSetWindowBackgroundBlurRadius, a private CoreGraphics call and the only
//! way to set a blur radius on macos. AppKit's NSVisualEffectView has fixed
//! materials and cannot do it. this is the same route ghostty takes.
//!
//! the translucent colour itself is not set here: the page paints it, so the
//! editor can change opacity live without going back through native code.

#![allow(non_snake_case, non_upper_case_globals)]

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::Mutex;

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
unsafe fn send_isize_arg(obj: Id, s: Sel, a: isize) {
    let f: extern "C" fn(Id, Sel, isize) = std::mem::transmute(objc_msgSend as *const ());
    f(obj, s, a)
}
unsafe fn send_rect(obj: Id, s: Sel) -> Rect {
    let f: extern "C" fn(Id, Sel) -> Rect = std::mem::transmute(objc_msgSend as *const ());
    f(obj, s)
}
unsafe fn send_rect_bool(obj: Id, s: Sel, r: Rect, b: bool) {
    let f: extern "C" fn(Id, Sel, Rect, bool) = std::mem::transmute(objc_msgSend as *const ());
    f(obj, s, r, b)
}

/// NSRect. four doubles, which on arm64 is a homogeneous float aggregate and
/// travels in v0..v3, so the plain objc_msgSend is the right entry point. the
/// _stret variant does not exist on this architecture at all.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// an objc string as a rust one. nil comes back empty rather than panicking,
/// because a window with no title is the normal case for half the list.
unsafe fn nsstring(obj: Id) -> String {
    if obj.is_null() {
        return String::new();
    }
    let p = {
        let f: extern "C" fn(Id, Sel) -> *const c_char = std::mem::transmute(objc_msgSend as *const ());
        f(obj, sel("UTF8String"))
    };
    if p.is_null() {
        return String::new();
    }
    CStr::from_ptr(p).to_string_lossy().into_owned()
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

// ---- stickies ---------------------------------------------------------------
//
// a sticky note is the same app in a small window that stays on top. neither
// half of that is reachable from javascript: NSWindow.level and the window frame
// are AppKit, and there is no node here to bridge to them. so the dylib, which
// is already walking every window twice a second, does it.
//
// how it knows which window: the document's own path. NSWindow keeps
// representedFilename for a document window, which is the file itself and cannot
// be confused with anything the user typed. the title is checked too, because a
// window that has not finished loading has the name before it has the path.
const STICKY_MARK: &str = "/.quire/stickies/";
const STICKY_NAME: &str = "sticky-";

/// NSFloatingWindowLevel. above normal windows, below the menu bar and panels.
const FLOATING_LEVEL: isize = 3;
/// NSWindowCollectionBehaviorCanJoinAllSpaces, so a note does not vanish when
/// you switch desktops, which is most of what a note is for.
const JOIN_ALL_SPACES: usize = 1 << 0;
/// NSWindowCollectionBehaviorFullScreenPrimary. the host never sets it, so the
/// window was not a fullscreen candidate at all: the green button zoomed and
/// ctrl-cmd-F did nothing, because there was nothing for either to act on.
const FULLSCREEN_PRIMARY: usize = 1 << 7;
/// NSWindowStyleMaskResizable. a window that cannot be resized cannot be taken
/// fullscreen either, whatever its collection behaviour says.
const RESIZABLE: usize = 1 << 3;

const STICKY_W: f64 = 380.0;
const STICKY_H: f64 = 320.0;

static SIZED: Mutex<Vec<c_int>> = Mutex::new(Vec::new());

unsafe fn is_sticky(window: Id) -> bool {
    let rf = sel("representedFilename");
    if responds(window, rf) {
        let p = nsstring(send(window, rf));
        if p.contains(STICKY_MARK) {
            return true;
        }
    }
    let t = nsstring(send(window, sel("title")));
    t.starts_with(STICKY_NAME) || t.contains(STICKY_MARK)
}

/// float it, and give it a small frame the first time it is seen. the frame is
/// set once and never again: a note you dragged somewhere is a note that stays
/// where you dragged it.
unsafe fn sticky(window: Id, wid: c_int) {
    let level = sel("level");
    if responds(window, level) {
        let cur = send_isize(window, level);
        if cur != FLOATING_LEVEL {
            send_isize_arg(window, sel("setLevel:"), FLOATING_LEVEL);
        }
    }
    let cb = sel("setCollectionBehavior:");
    if responds(window, cb) {
        let f: extern "C" fn(Id, Sel, usize) = std::mem::transmute(objc_msgSend as *const ());
        f(window, cb, JOIN_ALL_SPACES);
    }

    let mut seen = match SIZED.lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    if seen.contains(&wid) {
        return;
    }
    seen.push(wid);
    let n = (seen.len() as f64 - 1.0) % 6.0;
    drop(seen);

    let screen = send(window, sel("screen"));
    if screen.is_null() || !responds(screen, sel("visibleFrame")) {
        return;
    }
    let vis = send_rect(screen, sel("visibleFrame"));
    let r = Rect {
        x: vis.x + vis.w - STICKY_W - 40.0 - n * 26.0,
        y: vis.y + vis.h - STICKY_H - 40.0 - n * 26.0,
        w: STICKY_W,
        h: STICKY_H,
    };
    if responds(window, sel("setFrame:display:")) {
        send_rect_bool(window, sel("setFrame:display:"), r, true);
        // and force the draw. the window is usually still in the background when
        // this runs, and a background window is not asked to repaint, so the
        // titlebar keeps a strip of whatever size it used to be.
        send(window, sel("display"));
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
        if is_sticky(window) {
            sticky(window, wid);
        } else {
            allow_fullscreen(window);
        }
    }
}

/// a sticky deliberately opts out of fullscreen by taking JOIN_ALL_SPACES on its
/// own, so this is only ever applied to ordinary document windows, and it only
/// adds bits: whatever else the host wanted is kept.
unsafe fn allow_fullscreen(window: Id) {
    let sm_get = sel("styleMask");
    let sm_set = sel("setStyleMask:");
    if responds(window, sm_get) && responds(window, sm_set) {
        let cur = send_isize(window, sm_get) as usize;
        if cur & RESIZABLE == 0 {
            let f: extern "C" fn(Id, Sel, usize) = std::mem::transmute(objc_msgSend as *const ());
            f(window, sm_set, cur | RESIZABLE);
        }
    }

    let cb_get = sel("collectionBehavior");
    let cb_set = sel("setCollectionBehavior:");
    if responds(window, cb_get) && responds(window, cb_set) {
        let cur = send_isize(window, cb_get) as usize;
        if cur & FULLSCREEN_PRIMARY == 0 {
            let f: extern "C" fn(Id, Sel, usize) = std::mem::transmute(objc_msgSend as *const ());
            f(window, cb_set, cur | FULLSCREEN_PRIMARY);
        }
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
