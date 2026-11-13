# Contributing

Thanks for helping improve pi-tldraw!

## Local development

Use Node.js 22+ and Git:

```sh
git clone https://github.com/zeekrey/pi-tldraw.git
cd pi-tldraw
npm ci
npm run check
```

Pi loads the TypeScript entry point directly. For a terminal test, use `pi -e "$PWD"`. Do not install a second copy of the package at the same time.

`npm run check` runs TypeScript checks, deterministic tests, and a clean production tarball test loaded into Pi's real RPC runtime. The package smoke test requires npm and tar, installs production dependencies into a temporary directory, and makes no model or tldraw MCP requests. It does not touch your Pi settings or drawings.

For browser layout checks (offline) and the opt-in live test:

```sh
npx playwright install chromium
npm run test:browser
npm run test:live
```

This contacts the configured MCP service, starts a headless Chromium browser, and creates a temporary isolated canvas. It verifies real app initialization, API discovery, mutations, manual sketch feedback, checkpoints, and restart/restore. It never uses project drawings. Network/service failures can make it fail even when offline tests pass.

## Pull requests

- Keep the integration lightweight: do not bundle another editor or add a required build step.
- Add regression tests for behavior changes and update the changelog/docs.
- Preserve the opaque iframe sandbox, capability-token boundary, app-tool allowlist, and sequential mutation semantics.
- Start session resources lazily; close them on Pi session shutdown.
- Keep Pi and TypeBox as host-provided peer dependencies, not runtime dependencies.
- Do not commit `node_modules`, `.pi` snapshots, capability URLs, secrets, tarballs, or test output.

## Releases

1. Update the version, changelog, and README's pinned install/uninstall commands.
2. Run `npm ci`, `npm run check`, and the live test.
3. Commit the changes and create a matching `vX.Y.Z` Git tag.
4. Push the commit and tag, then create a GitHub release. A source install uses the tag; no npm publication is required.
5. Optionally attach the distributable produced by `npm pack`.

The CI workflow runs offline/package checks on Node 22 and 24 and a Chromium layout regression test on Node 22. Its manual dispatch can additionally run the live test. Do not put credentials in a workflow or run live tests against a sensitive deployment.

Report ordinary bugs through GitHub issues. For security issues, follow [SECURITY.md](SECURITY.md).
