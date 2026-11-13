# Changelog

## [0.1.1] - 2026-11-13

### Fixed

- Dedicated canvas pages now use the entire available height instead of the upstream app's 600px inline cap.
- Negotiate MCP fullscreen mode by default and correctly acknowledge inline/fullscreen mode requests (MCP display mode does not trigger browser/OS fullscreen).
- Track actual iframe dimensions with `ResizeObserver`, including pane changes that do not emit a window resize event.
- Keep the host in control of its size; repeated app size hints cannot shrink the canvas or create a feedback loop.
- Add an offline browser layout regression test and real-app tall/short/resize assertions.

## [0.1.0] - 2026-11-13

Initial public release.

- Installable Pi package with a TypeScript entry point; no build step.
- Official tldraw MCP App hosted in a capability-protected loopback browser page.
- `/tldraw` command and `tldraw_open`, `tldraw_search`, `tldraw_scene`, and `tldraw_exec` tools.
- Shared canvas feedback for user edits, selections, and freehand sketches.
- Atomic, per-session local checkpoints and restore after restart.
- Opaque-origin widget sandbox, app-tool allowlist, Host/Origin validation, bounded requests, and sequential canvas calls.
- Setup, privacy, remote-port-forwarding, and troubleshooting documentation.
- Offline tests, production-package Pi RPC smoke test, and opt-in live browser test.

### Known boundaries

- The canvas is a browser page, not an inline Pi/T3 chat widget.
- The official hosted MCP service is required by default; this is not an offline editor.
- This is a purpose-built tldraw host, not a general MCP Apps renderer.
- Upstream app protocol changes may require an extension update.
