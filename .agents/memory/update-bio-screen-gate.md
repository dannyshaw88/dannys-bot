---
name: Update Bio screen gate
description: Prevents the Edit Profile form from being mistaken for Instagram's dedicated Bio editor
---

The generic `prism_form_field_container` marker appears on both Edit Profile and dedicated field editors. Update Bio must require the dedicated `edit_bio_layout` marker before scanning or tapping an EditText.

**Why:** Without the strict marker, the first EditText on Edit Profile is the Name field, so a Bio update can clear or type into Name.

**How to apply:** Treat ambiguous screen detection as an abort condition; never choose the target field by global EditText order until the dedicated editor screen is positively identified.