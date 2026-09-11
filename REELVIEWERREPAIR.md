# Reel Viewer Repair Log

This is the permanent “already tried” record for the Reel Viewer tool.

Before changing Reel Viewer behavior:

1. Read this file.
2. Do not repeat an entry marked **rejected**, **superseded**, or **insufficient** unless new device evidence justifies it.
3. Record every new attempt under the exact source filename, tool/function, and sub-setting/action.
4. Separate build evidence from real-device evidence.

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
- **Current guard:** Reject Save when its resolved point lies inside a `direct_share_button` node, is not below the resolved DM action, or is less than 80 px from it; skip Save only.

#### `Share via DM`

- **Attempt:** Resolve `direct_share_button` and tap its stored coordinate when `wantShareDm` is true.
- **Status:** **Retained, hardened**.
- **Reason:** DM sharing is independently requested, but its coordinate must not overlap Save.
- **Current guard:** Reject Share-via-DM when its resolved point lies inside a `save_button` node; skip DM sharing only.

### `action coordinate freshness`

- **Attempt:** Reuse one player-ready UIAutomator dump for all Reel actions.
- **Status:** **Superseded for Save**.
- **Evidence:** `image_1789146059843.png` and `image_1789146088573.png` show `saved at (998,1967)` immediately followed by the DM Send sheet.
- **Current behavior:** Save performs a fresh action-column scan immediately before tapping and retains the cross-action collision/order guard.
- **Rule:** Never restore the original shared scan coordinate for Save. Other actions still need separate real-device evidence before changing their freshness behavior.

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

- **Attempt:** Tap only when a fresh `icons.save` exists and the action is requested.
- **Status:** **Retained with fresh scan and post-tap recovery; build-validated, real-device validation pending**.
- **Evidence:** The prior branch counted Save before checking the resulting surface, so the intermittent DM mis-target was logged as a successful save.
- **Current behavior:** Re-scan immediately before Save; after tapping, inspect the resulting dump. If a DM share sheet opened, close it with Back and do not increment the Save metric.
- **Rule:** If detector identity conflicts, fresh Save is missing, or the resulting surface is a DM sheet, skip/fail that Save without trying another coordinate.

### `Share via DM`

- **Attempt:** Tap only when `wantShareDm` is true and `icons.shareDm` exists.
- **Status:** **Retained**.
- **Rule:** A DM sheet appearing without a DM log line indicates another action tapped the DM coordinate; inspect detector identity and action logs before changing the DM branch.

## `artifacts/api-server/src/mobile/hst/operations/viewStories.ts`

### `findStoryLikeButtonViaA11y`

- **Attempt:** Prefer explicit Like labels; allow `toolbar_like_button` only with Comment-overlap protection.
- **Status:** **Retained**.
- **Rule:** Do not relax the Comment identity guard without a new device dump proving the node mapping.

## Required format for new entries

```text
## source filename
### tool/function
#### sub-setting/action
- Attempt:
- Status:
- Evidence:
- Rule:
```