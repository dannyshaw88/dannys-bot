---
name: Reel automation fix history
description: Internal ledger of attempted Reel fixes, organized by source file, tool, and every tool sub-setting/action.
---

# Purpose

Before changing Reel automation, read this file. An entry marked **rejected**, **superseded**, or **insufficient** must not be repeated without new evidence. A new attempt must record what evidence justified it and what it changed.

## `artifacts/api-server/src/mobile/androidManager.ts`

### `findReelActionIcons`

#### `right-column inventory`

- **Attempt:** Use the accessibility resource ID and semantic label to resolve each action independently.
- **Status:** **Insufficient**.
- **Evidence:** A device dump produced a Save coordinate that landed on the Direct Share control; the log recorded `saved at (998,1967)` while the DM sheet opened.
- **Rule:** Resource ID alone is not proof of action identity. Cross-check the resolved point against competing action bounds.

#### `Save`

- **Attempt:** Accessibility-only `save_button` resolution; visual bookmark fallback removed.
- **Status:** **Retained, hardened**.
- **Reason:** Visual matching previously hit the Likes/statistics area, but accessibility metadata can also be stale or reused.
- **Current guard:** Reject Save when its resolved point lies inside a `direct_share_button` node; skip Save only.

#### `Share via DM`

- **Attempt:** Resolve `direct_share_button` and tap its stored coordinate when `wantShareDm` is true.
- **Status:** **Retained, hardened**.
- **Reason:** DM sharing is independently requested, but its coordinate must not overlap Save.
- **Current guard:** Reject Share-via-DM when its resolved point lies inside a `save_button` node; skip DM sharing only.

### `action coordinate freshness`

- **Attempt:** Reuse one player-ready UIAutomator dump for all Reel actions.
- **Status:** **Known risk; not yet replaced**.
- **Rule:** A future freshness change must re-scan immediately before each requested action and retain the same cross-action collision guard. Do not remove the collision guard when adding freshness.

## `artifacts/api-server/src/mobile/hst/operations/viewReels.ts`

### `Like`

- **Attempt:** Tap the stored validated Like node after the initial action-column scan.
- **Status:** **Retained**.
- **Rule:** Do not replace with a guessed coordinate or generic visual fallback.

### `Share to Feed`

- **Attempt:** Tap only when `shareFeed` is exposed by the action detector.
- **Status:** **Retained**.
- **Rule:** Missing Share-to-Feed skips only that action.

### `Save`

- **Attempt:** Tap only when `icons.save` exists and the action is requested.
- **Status:** **Retained with detector guard**.
- **Rule:** If detector identity conflicts, `icons.save` must be null and this branch must skip without trying another coordinate.

### `Share via DM`

- **Attempt:** Tap only when `wantShareDm` is true and `icons.shareDm` exists.
- **Status:** **Retained**.
- **Rule:** A DM sheet appearing without a DM log line indicates another action tapped the DM coordinate; inspect detector identity and action logs before changing the DM branch.

## `artifacts/api-server/src/mobile/hst/operations/viewStories.ts`

### `findStoryLikeButtonViaA11y`

- **Attempt:** Prefer explicit Like labels; allow `toolbar_like_button` only with Comment-overlap protection.
- **Status:** **Retained**.
- **Rule:** Do not relax the Comment identity guard without a new device dump proving the node mapping.

## How to add future entries

Use this exact nesting:

1. Source filename
2. Tool/function
3. Every sub-setting or action
4. Attempt
5. Status
6. Evidence
7. Rule for future agents

Never record a fix as successful merely because it compiles. Record device evidence separately from build evidence.