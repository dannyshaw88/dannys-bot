# Gnirehtet relay

The Rust relay and Android client are based on Genymobile Gnirehtet v2.5.1,
licensed under Apache-2.0. The Windows build compiles the locally patched Rust
relay and downloads the matching upstream Android APK from the official GitHub
release, checking its published SHA-256 before packaging.

Aura Farming's relay changes:

- An unassigned device's IPv4 TCP/UDP traffic exits through the Windows laptop's
  normal network connection.
- With an HTTP proxy assigned, TCP uses HTTP CONNECT with optional Basic
  authentication. DNS uses the laptop's resolver (so DNS is not proxied), and
  other UDP is blocked so it cannot silently bypass the proxy.
- With a SOCKS5 proxy assigned, TCP and UDP use the proxy (including optional
  username/password authentication).
- The Windows app temporarily disables the phone's Wi-Fi and mobile data while
  the USB tunnel is active, and restores their prior states when it stops or
  the phone disconnects.

This integration is IPv4-only. HTTP proxies do not support arbitrary UDP;
non-DNS UDP is deliberately blocked for those assignments. The project does
not claim that an HTTP proxy can carry UDP.

Upstream source: https://github.com/Genymobile/gnirehtet  
Upstream release: https://github.com/Genymobile/gnirehtet/releases/tag/v2.5.1  
License text: `gnirehtet-LICENSE`
