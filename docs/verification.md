# Verification checkpoint

## Submission-readiness follow-up, 2026-11-12

This follow-up addresses the intermittent backend-fixture JSON read and guardian raced-shutdown failures recorded in [the showcase verification](library-video-verification.md#neutral-local-storage-follow-up). Those historical results remain unchanged.

- The backend fixture truncated its state file before writing replacement JSON while tests read it concurrently. A new real child-process reader regression reproduced `Unexpected end of JSON input` before the fix. Fixture state and event-control updates now use a temporary sibling file and atomic rename. Test-owned control updates use the same publication pattern.
- Backend tests now register teardown before starting a bridge. Teardown quiesces every bridge, including custom lifecycle bridges, before removing temporary directories, so an assertion failure does not leave a polling child keeping the test command open. The new reader regression also bounds and cleans up its child processes.
- Guardian cleanup previously treated process-group disappearance as sufficient before the exact owned child had closed and been reaped. It now tracks and awaits that child's close event before clearing ownership. The race regression retains the exact-PID disappearance assertion and also requires the guardian's exit notification before shutdown resolves when the fixture recorded a PID. No existing timeout or safety assertion was relaxed.
- `npm run typecheck` and `git diff --check`: passed on macOS, Node v22.19.0.
- Two full `npm test` runs after the fixes: **111 passed, zero failed, two platform skips** across 113 tests. The skips cover unsupported helper hosts and Windows command scripts; they are not Windows runtime evidence.
- Separate backend/session suites: **41 passed, zero failed**. Guardian suite: **17 passed, zero failed, two platform skips**. The raced-shutdown test passed 50 consecutive isolated runs.
- `npm pack --dry-run --ignore-scripts`: passed. No lint script is defined. No dependencies were added.

The overview now states supported development-host operating systems, the supported Paseo version range and the one-workspace/agent session limit, and explicitly names selected page content and screenshots in provider data disclosure. The README scopes verification to recorded revisions and environments.

These checks exercise fixtures and real child processes. They do not establish a fresh installed-plugin or real Impeccable engine acceptance run for this revision. No plugin reload, registry submission or deployment was performed.

## Earlier checkpoints

2026-11-11 library showcase follow-up: three real selected-element Generate → agent edit → Accept → cleanup workflows completed in a separate fictional static-HTML app. Reload after helper stop retained the accepted stylesheet. See [the scoped evidence and recording record](library-video-verification.md). Historical statements below about unverified source acceptance describe the earlier checkpoint.

Development-server automation is now implemented locally. See [the current automation verification record](development-server-verification.md) for the current 77-test suite, actual installed-plugin checks, monorepo target regression, independent review, cleanup evidence and platform/UI limits. The historical evidence below describes the earlier helper-only release.

2026-11-11: installed local Paseo plugin, prepared for authorized public GitHub publication.

- Strict SDK TypeScript check passed against Paseo 0.15.4.
- 15 backend integration tests passed using real child-process protocol fixtures. Coverage includes helper collision/ownership, local path/URL/agent validation, concurrent start, explicit retry, permission pause, wait-before-repoll, pending completion gate, malformed output, and stop races during refresh/send/wait/retry.
- The installed Impeccable helper passed isolated start, authenticated status, actual background polling, HTML injection, stop, helper exit, and byte-for-byte HTML restoration. Workspace/agent handles were facades; no real agent edits occurred.
- Independent source review approved the package-ready lane after fixes.
- npm pack produces the source archive. Runtime helper tokens, node_modules and application answers are excluded. No npm/plugin-registry publication or deployment occurred.

The plugin was installed into Paseo 0.15.4 and reported running. Command Center opened its panel; the configured app folder and URL were accepted, Start reached running, and Open preview loaded the real local app with Impeccable controls. A real Steer connection-check request reached the bound agent and received `steer_done` with a Connected toast. No application source edit was requested for that check.

The first host load rejected camel-case RPC names; lowercase names corrected it. The panel inputs use local form state and save to tab state on blur/start. Configuration restoration across a newly restored app session, slash-command interaction, and a generated design variant accepted into source remain unverified. The Steer acknowledgement is not proof of accepted-source integration.

Stop does not cancel agent work already accepted. Delivery and completion failures remain visible; explicit uncertain-delivery retry can duplicate a request and is labeled accordingly. Completion-gate rechecking does not resend an edit.


## Guided dependency readiness (2026-11-12)

The panel now reports launcher, engine, compatibility, project setup and helper ownership independently. It offers installation/update links, an explicit selection for a detected project-local executable, executable overrides, copyable engine/project setup instructions with selectable fallback, and rechecking. Checks do not install or update software. Automatically discovered project launchers are not executed until explicitly selected; existing trusted personal launchers are probed with downloads suppressed.

Validation on macOS, Node v22.19.0, against the installed Impeccable engine 0.1.18:

- `npm run typecheck` and `git diff --check`: passed. No lint script exists and no dependencies were added.
- `npm test`: 127 passed, zero failed, two platform skips (129 tests). Coverage includes launcher discovery and explicit project selection, malformed/failed probes, version mismatch, output redaction, timeout/cancellation including child processes, recovery instructions, repair/recheck/connect, external-server preservation, and existing lifecycle behavior. The delayed-boot cleanup test now waits for the fixture to enter boot before requesting stop, rather than assuming the public starting phase proves the child has begun executing.
- A cold copy of the actual installed launcher, with empty HOME/cache and probe mode enabled, exited 127 without creating a cache or home files. The populated installation reported `impeccable-engine 0.1.18`, matching its scripts/VERSION.
- `npm run test:live`: passed with the real installed helper. Start, authenticated status, background polling, served injection, helper exit and byte-for-byte source restoration succeeded. Agent/workspace handles were facades; no agent request was sent.
- `node --experimental-strip-types evidence/development-server-lifecycle.ts`: passed with a real owned HTTP child and installed helper. Stop-session retained the app, resume reused its process/URL, stop-development and coordinator shutdown cleaned owned resources and injection. Agent handles were facades; no agent request was sent.
- The local plugin reloaded and reported running in Paseo 0.15.4. Fresh visual/compact-layout/clipboard interaction validation was not completed: native UI inspection was interrupted by changes to the active workspace, so it is not claimed here.

Engine identity and matching local VERSION metadata do not establish compatibility with every Live protocol version, nor do launcher checks establish that the attached agent can load the skill. These limits are shown in connection details and setup documentation. No automatic installation, publication or deployment occurred.


### Installed-panel recovery smoke check (2026-11-12)

Closed the UI gap above using the actual local plugin in Paseo Desktop 0.15.4 on macOS, on implementation commit `c434512`. A disposable app under the ignored `.demo/` directory supplied controlled missing-installation, cold-engine and missing-project-setup states. No agent request was sent and no installer was run.

- An unavailable explicit launcher displayed installation instructions and **Locate existing installation**; Connect remained disabled. Locate opened Advanced settings and focused the executable field, both when already expanded and when collapsed.
- A wrapper around a cold copy of the installed upstream launcher, using an empty engine cache, displayed the missing-engine guidance and **Copy engine setup command**. Rechecking did not create that cache.
- Both Copy actions succeeded. Pasting into an unsent chat draft confirmed the exact quoted engine command and full app-specific project setup prompt, including the CSP and plugin-owned helper instructions. Each draft was cleared without sending.
- Tab moved from the engine Copy button to the project Copy button and then **Check again**; Return activated project copying. Native screenshots showed wrapping and accessible controls in full-width and narrow desktop split panes, including the long executable path and multiline prompt. Temporary panes were closed afterward. This is narrow desktop evidence, not a physical-phone test.
- Clipboard rejection was exercised for both controls by temporarily replacing only the awaited clipboard call with a rejecting promise in the local source and reloading. The actual panel displayed **Copy was unavailable. Select and copy the text below.** and retained the command/prompt text. The exact production file was restored, verified unchanged against Git, and reloaded before subsequent checks. This is controlled fault-injection evidence, not an observed OS clipboard denial.
- Selecting the existing prepared launcher and adding factual context/configuration for the disposable app made **Check again** clear the blockers and enable Connect. Connection opened the real local preview with the Impeccable toolbar. The panel reported **Connected** and engine `0.1.18` in Details.
- **Stop session** removed the helper record and injection while the app continued returning HTTP 200. **Stop development server** then stopped the HTTP service. The empty engine cache remained absent. The fixture, preview tab and panel were removed, automatic settings restored, and the original chat left with an empty draft.

No product code fixes were needed. This closes the recorded macOS panel, narrow-layout, keyboard and clipboard recovery smoke-test gap. Physical mobile behavior and additional engine/host versions remain outside this check.

### Skill update notice (2026-11-12)

The update notice uses the selected launcher's sibling skill metadata and a separate `check-updates` RPC. Requests identify the originating attempt, launcher and preview root; stale identities return unknown before invoking the checker. Readiness and development/helper lifecycle do not wait for upstream. No dependencies were added.

- `npm run typecheck` and `git diff --check` pass. Impeccable's mechanical detector reports no findings for `client/live-panel.tsx`.
- The full Node suite passes: 140 tests, 138 passed, 2 existing platform skips. New checker tests cover metadata versus engine versions, legacy metadata, unknown/invalid versions, semantic version precedence, offline/malformed/oversized responses, full-request and stalled-body timeouts, cache/backoff/forced retry, concurrency and opt-outs. Coordinator coverage proves a pending check does not block connection, foreign bindings are refused and stale installation identities never reach the checker.
- A direct execution of the new checker against the existing personal launcher and real upstream endpoint returned `available`, installed skill `4.8.0`, latest skill `4.8.2`. This performed a metadata GET without installing or updating anything.
- The existing installed plugin was not reloaded, so this change has no new installed-panel, compact-layout, keyboard or screen-reader evidence. The UI uses the existing panel styles, link component and focusable controls, but rendered behavior remains a smoke-test gap. Earlier installed-panel verification above applies to its recorded revision only.
