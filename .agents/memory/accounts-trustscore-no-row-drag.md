---
name: Accounts Trust Score interaction isolation
description: Trust Score badge clicks must not trigger Accounts row drag-to-select or browser focus movement.
---

The Accounts page Trust Score badge is an independent control. Its wrapper and menu options must prevent default mouse-down behavior and stop propagation so selecting a score cannot start the row's drag-to-select interaction or move the page.

**Why:** The Accounts rows use mouse-down drag selection; without isolation, clicking a portal-mounted Trust Score menu can cause an unexpected screen shake.

**How to apply:** When adding or changing controls inside an Accounts row, exclude the control from row selection at the row boundary and suppress default mouse-down behavior only for controls that should not participate in row selection.