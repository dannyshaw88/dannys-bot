---
name: WhatsApp contact automation safety
description: Safety rules for selecting WhatsApp contacts and sending configured messages through native Android UI automation.
---

The WhatsApp automation must discover the New Chat control, contact row, composer, and Send control from the current UI hierarchy before tapping. It must skip or stop when any expected target is missing, ambiguous, or stale, rather than falling back to guessed coordinates.

**Why:** WhatsApp accessibility labels and contact-picker layouts vary across app versions and devices; a guessed tap can message the wrong person.

**How to apply:** Re-dump the live hierarchy after every navigation step, keep contact selection distinct within a process, and generate the spintax message only after the selected contact is confirmed.