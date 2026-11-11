# Real Impeccable helper lifecycle evidence

Verified 2026-11-11 at approximately 15:28 UTC, using Node v24.21.0 and the installed Impeccable v4.8.0 CLI from the user skill directory.

Command from the plugin directory:

```sh
node --experimental-strip-types evidence/real-helper-lifecycle.ts
```

Result: **PASS**, exit code 0. The script dynamically imports the implemented `server/live.ts` and calls `LiveBridge.start`, `status`, and `stop`. Workspace and agent handles are local facades; no real agent receives a message.

The temporary project contains an HTML entry, Vite package metadata, `PRODUCT.md`, `DESIGN.md`, and an explicit `.impeccable/live/config.json`. A minimal Node HTTP server serves the current entry file. Vite itself is not installed or run for this lifecycle check.

Observed assertions:

- Start returned `running` with the canonical temporary app root and supplied preview URL.
- The real helper process was alive (PID 80410, port 8400 for this run). Its roots record matched the fixture.
- `/health` returned `ok` with the matching port. Unauthenticated `/status` returned 401; the stored helper token authenticated successfully.
- Authenticated status reported `agentPolling: true`, establishing that the bridge's real `live-poll` subprocess was active.
- The preview served the real injected HTML entry with the helper port. Public bridge status contained no helper token.
- Stop returned `stopped`; the helper process exited, `server.json` was removed, and the entry returned byte-for-byte to its original contents.
- Status remained `stopped`, and the agent send count was zero.
- The script removed its temporary project after successful cleanup. No existing application was accessed or modified.

The plugin TypeScript check also passed after adding the evidence script:

```sh
node node_modules/typescript/bin/tsc --noEmit
```

Scope: this proves the implemented bridge's local helper start, polling, status, injection, and explicit-stop lifecycle against the installed CLI. It does not prove Paseo panel rendering, native embedded-browser interaction, actual Vite behavior, browser-event dispatch to an agent, or agent completion of an Impeccable edit.

Root integration rerun after background dispatch and cancellation changes: PASS, exit 0, Node v24.21.0; helper PID 77265 on port 8400. The same start/poll/injection/token isolation/stop/restoration assertions passed with zero agent messages.
