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
