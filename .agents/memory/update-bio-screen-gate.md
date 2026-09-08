---
name: Update Bio screen gate
description: Prevents the Edit Profile form from being mistaken for Instagram's dedicated Bio editor
---

The generic `prism_form_field_container` marker appears on both Edit Profile and dedicated field editors. Update Bio must require the dedicated `edit_bio_layout` marker before scanning or tapping an EditText.

**Why:** Without the strict marker, the first EditText on Edit Profile is the Name field, so a Bio update can clear or type into Name.

**How to apply:** Treat ambiguous screen detection as an abort condition; never choose the target field by global EditText order until the dedicated editor screen is positively identified.

### 2026-09-08 — Slow Edit Profile render needs bounded readiness polling

The real-device trace showed Update Bio tapping the verified Edit profile node, while the phone still displayed the Edit Profile loading spinner. The operation made one dump after a short fixed wait, logged `Edit Profile page did not load`, pressed Back, and never reached the Bio editor.

The flow now polls boundedly until the Edit Profile form marker and Bio field are both present, then separately polls for `edit_bio_layout` before selecting an EditText. The dedicated Bio marker remains mandatory; polling must not relax that safety gate.

**Why:** A single accessibility dump races slow Instagram/MIUI rendering, but accepting the generic form marker alone can target the wrong EditText.

**How to apply:** Use one-dump-per-attempt readiness polling with a hard timeout, require the target field before tapping, and fail closed after the timeout.