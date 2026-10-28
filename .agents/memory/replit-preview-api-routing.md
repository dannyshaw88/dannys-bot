---
name: Replit preview API routing
description: Diagnoses same-origin API failures when the public preview routes through the component-preview Vite server.
---

In this workspace, the public Replit preview can serve the Aura Farming frontend while routing `/api` requests through the component-preview server mounted at `/__mockup`. That server returns a base-path 404 unless `/api` is forwarded to the top-level API.

**Why:** The login credentials and top-level API were valid, but the public preview failed because its API request reached the wrong Vite server. Restarting the API or frontend alone did not correct the route.

**How to apply:** If `/api` works through the app's local Vite port but the public preview returns a `/__mockup` base-path error, verify the public route and add a narrow `/api` proxy on the component-preview server to the top-level API. Confirm with `/api/license/me` through the exact public preview URL.
