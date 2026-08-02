---
name: Keyboard named-key bind execution
description: Rule for making per-device keyboard calibration binds affect named automation actions
---

Character typing and named keyboard controls are separate execution paths. Saving a bind for Emoji/Emoticon only enables that named action; execution must resolve the current keyboard control and picker cell from the live IME accessibility tree, never reuse saved device coordinates.

**Why:** The story-reply flow first bypassed the calibration map with direct text injection, then used saved coordinates that cannot transfer between devices. Unicode `adb input text` also fails on some Android builds with a null key-event array.

**How to apply:** Route every named keyboard action through a shared per-device bind check with aliases such as `emoji`/`emoticon`, then resolve and tap the live IME accessibility node and a live picker-cell node. Do not use saved coordinates, screenshot detection, or Unicode text injection for named Emoji actions. For ordinary text, a partial calibration map must not take over unless it covers every requested character; require a real letter-key cluster before trusting accessibility key nodes. On combined IME/app dumps, explicit labels must be IME-owned; if Gboard exposes the visible Emoji key without a label, resolve it structurally as the live key immediately left of the live Space node in the same row, and log node counts for device diagnosis.

When the combined dump is package-annotated, anchor keyboard nodes to Android's active `default_input_method` package; use package-less lower-window nodes only when the device exposes no package metadata. Structural key selection must not require `clickable`/`focusable` when the live node class or resource-id identifies a keyboard control.

**Why:** The Xiaomi screenshot showed Gboard visibly open while the previous resolver still failed to establish that its lower nodes belonged to the active IME; Gboard can expose visible controls without labels or direct clickable flags.

**How to apply:** Read the active IME package for diagnostics and scoring, record the combined IME dump, and choose the unlabeled Emoji key from the live Gboard row immediately left of the live Space node. Never reinterpret Instagram nodes as keyboard controls.