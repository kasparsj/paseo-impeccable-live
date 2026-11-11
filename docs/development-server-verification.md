# Development-server automation verification

2026-11-11. Local implementation on `feat/development-server-automation`, based on `b70be04`. Plan: `.omx/plans/development-server-automation.md`. Paseo app/daemon and pinned plugin SDK: 0.15.4. Host: macOS; verification Node: v22.19.0.

## Implemented behavior

Start discovers the app, package manager and development script, asks for unresolved choices, then reuses an associated server or launches an owned process. It verifies a loopback HTTP HTML page before starting Impeccable and opening the desktop preview. App, executable/argv, URL and CLI overrides are advanced settings. Development output and helper status are independent. Stop session keeps the app; Stop development server cleans its helper and the integration-owned app tree. External servers are never stopped by these controls.

The guardian owns launch resources before asynchronous spawn acknowledgement. It remains independent of the plugin process, shares one cleanup promise across shutdown/disconnect/signals, and retains ownership when cleanup cannot be confirmed. Its POSIX stop uses 500 ms TERM grace followed by SIGKILL and a bounded 2-second group-disappearance check. Windows has a bounded 5-second taskkill path, without a Windows runtime acceptance claim.

## Automated checks

- `npm run typecheck`: passed against the pinned SDK.
- `npm test`: 77 tests passed after the monorepo-target regression fix; zero failed, canceled or skipped on this macOS host. The original implementation milestone had 70 tests.
- `git diff --check`: passed.
- Independent fresh Codex review: approved the final local/POSIX implementation after the reported issues were fixed. The final guardian timing adjustment was separately reviewed and approved.
- A parent-first child-tree test initially failed once under concurrent load. The guardian now requires actual group disappearance with the bounded post-KILL allowance above. The final targeted real-process stress passed 10 consecutive runs, and subsequent full suites passed. Assertions were retained.

New suites cover discovery/metadata and no-install guards, real HTTP/readiness/redirects/output, real process-tree ownership, coordinator cancellation/recovery, and tab configuration/preview state. The original 15 bridge regressions remain intact.

The no-install guard rejects known direct, option-prefixed, absolute-CLI and quoted/nested-shell package mutations before launch, including pre/post hooks and advanced manager commands. Corepack network access is disabled; declared exact manager versions are checked from already-installed metadata, and missing known framework runners fail before owned launch. External reuse does not require installing local dependencies. Project scripts remain trusted executable code: arbitrary code inside a Node script or framework plugin is not statically proven free of side effects.

## Real engine and installed host

`node --experimental-strip-types evidence/development-server-lifecycle.ts` passed with the installed Impeccable engine and real HTTP app subprocesses. It proves readiness before helper boot, served injection, token-free public status, helper-only stop while HTTP remains available, resume with the same app PID/URL, full stop and byte-for-byte HTML restoration, and coordinator shutdown. Workspace/agent handles in that script are facades; it sends zero agent messages.

Separate actual Paseo desktop interactions exercised the installed local plugin:

1. Opened the panel through Command Center. The initial form exposed Start and independent statuses, with overrides inside Advanced. New defaults were automatic.
2. Discovered the isolated app and npm dev command, launched it on an emitted ephemeral loopback port, started the real helper, and automatically opened the native preview with Impeccable controls. Visible logs included the selected command and app URL.
3. Stop session removed the real helper/injection while the same app process continued serving HTTP 200. Resume reused that app process rather than launching a duplicate.
4. Reload during a ready owned session removed the app process, helper record and injection; the app URL stopped responding.
5. An armed watcher triggered reload immediately after a fresh delayed-helper boot marker, before any helper record existed. The wrapper delayed `live` four seconds. Paseo stopped the old plugin after about two seconds; the independent guardian completed the attributable late boot cleanup after about 4.2 seconds. Guardian diagnostics ended with `cleanup-finished errors=none`; app PID, helper record and injected markup were gone. The new plugin was running and did not resume automatically.
6. A Node app started by the verification harness was reused through an explicit local URL override. The panel labeled it external and disabled its development-server Stop control. Helper-only Stop, plugin reload, and disable/enable all left that external app serving HTTP 200. The harness subsequently stopped its own test process.
7. A real browser Steer request reached the bound Paseo agent. Event `da9e75f4` received exactly one `steer_done` reply with toast text `Connected`; the CLI returned `{ok:true, status:"steer_done"}` and the browser Steer field cleared/unlocked. No source edit was requested or performed for this event. The plugin correctly retained its agent-completion wait until the session was stopped; acknowledgement is distinct from completed design work.

The task-created app directory, overrides and browser tabs were cleaned up after checking that its helper and app processes had stopped. No dependencies were installed, package versions changed, software published, or deployment performed. The local plugin remains enabled.

## Acceptance evidence and limits

| Target | Evidence |
| --- | --- |
| VAL-DEV-APP | Root/nested/monorepo, ambiguity, stable/stale IDs, symlink containment and bounded traversal fixtures; installed app discovery. |
| VAL-DEV-MANAGER | npm/pnpm/Yarn/Bun metadata fixtures, exact version/missing/Corepack cases without executing discovery commands; actual npm launch. Other managers were not live-launched. |
| VAL-DEV-COMMAND | Unique dev and ambiguous/orchestrated scripts; forbidden mutations in scripts/hooks/advanced argv, global-option and quoted-shell regressions; real npm dev launch. |
| VAL-DEV-SETTINGS | Legacy/new configuration tests; actual advanced controls and automatic defaults. Compact/light-theme rendering and restoration across a full client restart remain unverified. |
| VAL-DEV-START | Immediate snapshots, concurrent Start, readiness ordering, canceled SDK preflight and helper boot tests; actual native start. |
| VAL-DEV-URL | Redirect-before-fetch boundary, HTML/auth/errors/timeouts, bounded reads, ANSI/IPv6/split URL tests; actual emitted ephemeral URL. |
| VAL-DEV-REUSE | Explicit and retained external reuse, app A→B fingerprint regression; installed external ownership controls and HTTP survival. |
| VAL-DEV-PORT | Real occupied listeners with fallback/strict failure; listeners survive. A framework default URL cannot silently identify a silent owned child. |
| VAL-DEV-ERROR | Spawn/exit/readiness/helper failure and retries, stale callbacks, server loss and retained-server fixtures; actual unavailable-server status. |
| VAL-DEV-LOGS | Byte/line/cursor/redaction/control/large-output tests and installed visible output. External output unavailability is explicit. |
| VAL-DEV-STOP | Separate control tests and installed helper-only stop; real engine script exercises full owned stop and HTML restoration. |
| VAL-DEV-TREE | Real parent/grandchild, TERM resistance, parent-first exit, PID/group disappearance and foreign identity fixtures. POSIX directly exercised; Windows runtime unverified. |
| VAL-DEV-RESUME | Same/fallback-port restart with unchanged helper and retained event/no resend fixtures; actual same-PID app resume. |
| VAL-DEV-RELOAD | Installed owned ready/delayed-boot reload, guardian disconnect/signal tests and no silent restart. Disable/enable exercised external survival; owned disable uses the same cleanup entry but was not separately exercised with live owned resources. |
| VAL-DEV-PREVIEW | Actual automatic native preview and manual opener, one-attempt guards, transient selection persistence fixes. Web fallback and compact client are implemented but not runtime-verified. |
| VAL-DEV-PRESERVE | Original bridge suite, real installed-engine injection/stop/restoration and fresh browser→agent→browser Steer acknowledgement. Accepted-source design variant remains the existing separate unverified boundary. |

These are scoped evidence statements, not a claim that every platform and every UI variant passed. Normal reload/disconnect cleanup is covered. Simultaneous OS/guardian termination and intentionally daemonizing project scripts remain outside the cleanup guarantee; no persisted PID is used to reclaim ownership.

## Monorepo target regression

The first real UniMeet root launch exposed a missing boundary: the full-stack `pnpm run dev` correctly emitted Vite's fallback URL at port 5174, but bare `impeccable live` at the monorepo root returned `target_selection_required`. The development command directory had been reused as the helper directory.

Discovery now carries a separate contained preview root/path, expands multiple web apps into explicit target choices, and includes the preview identity/metadata in saved-choice validation. The launch command and cwd remain unchanged. Helper boot passes `live --target <concrete app root>` and its subsequent polling/stop operations use that same app root. The guardian validates the explicit target before launch and excludes boot-only flags from its stop commands.

Fresh evidence:

- Discovery tests cover a unique child frontend, multiple web previews, root configuration precedence, symlink boundaries and stale metadata. Coordinator coverage verifies root launch + frontend helper, URL preservation, helper-only stop and full owned stop. Guardian coverage verifies explicit target containment and stop argv.
- `node --experimental-strip-types evidence/development-server-lifecycle.ts --monorepo` passed against the installed engine. Its root Node process served `frontend/index.html`; Product/Design records were at the temporary Git root, while helper state and injection stayed in the frontend. Resume, stop and shutdown checks passed without agent messages or dependencies being installed.
- The actual UniMeet panel was resumed with `matching-platform — dev → frontend` and its full-stack root command. The existing server on 5173 was left alone; the owned Vite server chose 5174. The helper's persisted `roots.appRoot` was `/Users/kasparsj/Work2/unimeet/matching-platform/frontend`. HTTP 5174 returned 200 with live injection, the existing 5173 server still returned 200, and Paseo automatically opened UniMeet with working Impeccable controls. The user's development session was left running for use.

## Existing-server reuse follow-up (historical, before panel UX changes)

After the owned UniMeet session was stopped, reopening the panel showed its retained stopped status. Selecting **Start / resume** reran discovery and offered **Reuse http://localhost:5173/**. Selecting that option reused the existing server and automatically opened UniMeet with Impeccable controls at port 5173. No additional development process was launched. At that revision, opening the panel alone did not trigger discovery. The subsequent panel UX follow-up adds read-only discovery on opening; see [the current panel verification](panel-ux-verification.md).

## Verification process deviation

A later independent reviewer ran `pnpm run typecheck && pnpm test` rather than the requested existing npm checks. It reported cached dependency preparation (307 packages reused, zero downloaded) and created a transient `pnpm-lock.yaml`, which the reviewer removed. Changes to ignored dependency contents were not established; existing `node_modules` was preserved. Tracked dependency manifests and lockfiles remain unchanged. The final parent checks used `npm run typecheck` and `npm test` and passed all 77 tests.
