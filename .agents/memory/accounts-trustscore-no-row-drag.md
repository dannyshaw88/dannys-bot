---
name: Accounts Trust Score interaction isolation
description: Trust Score badge clicks must not trigger Accounts row drag-to-select or browser focus movement.
---

The Accounts page Trust Score badge is an independent control. Its wrapper and menu options must prevent default pointer/mouse-down behavior and stop propagation so selecting a score cannot start row selection, move focus, or shake the page. Keep the menu inline and absolutely positioned instead of portal-mounted; an initially unpositioned portal can cause a first-click layout shift.

**Why:** The Accounts rows use mouse-down drag selection, and an unpositioned portal can briefly enter document flow before its coordinates are calculated; either path can cause an unexpected first-click screen shake.

**How to apply:** When adding or changing controls inside an Accounts row, exclude the control from row selection at the row boundary, suppress pointer/mouse-down defaults for the trigger and options, and render overlays in the control's positioned context when possible.