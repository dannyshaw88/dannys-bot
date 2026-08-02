---
name: Phone Farm local wallpapers
description: How custom wallpapers selected from a PC are persisted and shared across Phone Farm views
---

Phone Farm custom wallpapers selected from a local PC are stored as resized image data URLs in the shared `slot-customizations` localStorage record, so both the device grid and device detail view can render them without retaining an inaccessible local file path.

**Why:** Electron renderer code cannot safely render arbitrary Windows paths, while browser preview cannot use the native picker. A shared data URL gives both environments the same persisted result.

**How to apply:** Keep the native Electron picker and browser file-input fallback behind the shared wallpaper picker helper. Normalize images before persistence, recognize `data:image/` values when rendering, and preserve built-in filename-based wallpaper paths.