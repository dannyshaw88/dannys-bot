---
name: AI library installer network resilience
description: Requirements for reliable first-time Windows AI library installation
---

The first-time installer downloads multi-gigabyte CUDA Torch wheels. A default pip read timeout of 15 seconds is too aggressive for this transfer and can repeatedly restart a partially downloaded wheel. The installer must use a persistent AppData pip cache, a long read timeout, and retries.

**Why:** A real Windows setup repeatedly timed out while downloading a 2.4 GB CUDA wheel, leaving the AI Images page stuck in an installation state.

**How to apply:** Pass a persistent `--cache-dir`, `--timeout 600`, and `--retries 10` to every large pip install, preserve setup state in the Electron main process, and restore it when the AI page remounts.