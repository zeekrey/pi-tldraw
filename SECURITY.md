# Security policy

## Supported releases

Security fixes are made for the latest tagged release. Upgrade older releases before reporting a bug that may already be fixed.

## Report privately

Please use [GitHub's private vulnerability reporting](https://github.com/zeekrey/pi-tldraw/security/advisories/new) for vulnerabilities. Do not post exploit details, capability URLs, tokens, or private canvas data in public issues.

Include the affected version, OS and Node/Pi versions, impact, and a minimal reproduction. There is no guaranteed response SLA for this community-maintained project.

## Trust boundaries

- Pi extensions run with the same OS permissions as Pi. Review the code before installing it.
- The configured tldraw MCP endpoint receives code, searches, and checkpoints. It must be trusted. The default upstream service is not operated by this repository's maintainer.
- The app runs in an opaque-origin iframe sandbox. The parent host bridges only selected app methods and callback/checkpoint tools; it exposes no general shell or filesystem API.
- The local server binds to loopback, validates Host/Origin, and protects API access with a random bearer capability. The full URL's fragment is private. Do not publish it or expose this server to the Internet.
- Canvas text and app context are untrusted drawing data. Prompt guidance is not a security sandbox for the agent; use Pi/T3 approval controls as appropriate.
- Local checkpoints can contain private text, images, and bindings. Keep `.pi/tldraw/` out of source control and delete snapshots when no longer needed.
- The app can send explicit follow-up messages to Pi. Do not use an untrusted app deployment.

The README describes data flow, persistence, upstream service dependencies, and limitations in more detail.
