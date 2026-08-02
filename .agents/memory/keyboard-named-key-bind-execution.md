---
name: Keyboard named-key bind execution
description: Rule for making per-device keyboard calibration binds affect named automation actions
---

Character typing and named keyboard controls are separate execution paths. Named Emoji actions use a verified fallback chain: live IME node, same-device calibrated tap, then visual keyboard geometry; picker-cell selection remains live-node based.

**Why:** Gboard can visibly render controls without exposing usable accessibility nodes. The same-device calibration point is the most direct physical fallback, while verification prevents a stale point from being accepted silently. Unicode `adb input text` also fails on some Android builds with a null key-event array.

**How to apply:** Route every named keyboard action through a shared per-device bind check with aliases such as `emoji`/`emoticon`. For Emoji, try the live IME node, then a same-device saved coordinate bounded to the lower keyboard region, then screenshot geometry; verify that the picker opened after each tap before proceeding. For ordinary text, a partial calibration map must not take over unless it covers every requested character; require a real letter-key cluster before trusting accessibility key nodes. On combined IME/app dumps, explicit labels must be IME-owned; if Gboard exposes the visible Emoji key without a label, resolve it structurally as the live key immediately left of the live Space node in the same row, and log node counts for device diagnosis.

When the combined dump is package-annotated, anchor keyboard nodes to Android's active `default_input_method` package; use package-less lower-window nodes only when the device exposes no package metadata. Structural key selection must not require `clickable`/`focusable` when the live node class or resource-id identifies a keyboard control.

**Why:** The Xiaomi screenshot showed Gboard visibly open while the previous resolver still failed to establish that its lower nodes belonged to the active IME; Gboard can expose visible controls without labels or direct clickable flags.

**How to apply:** Read the active IME package for diagnostics and scoring, record the combined IME dump, and prefer the unlabeled Emoji key from the live Gboard row immediately left of the live Space node. If that tree is incomplete, use the bounded same-device calibration point or visual geometry and require picker-open verification. Never reinterpret Instagram nodes as keyboard controls.