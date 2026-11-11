# Live panel UX verification

2026-11-11, macOS, Node v22.19.0, Paseo app/daemon and installed SDK 0.15.4.

PR #1 remained open at `71d49d69d7b14cb900ca22ed48e7a2546cc6b1f8` before and after this work. The clean checkout was branched at that verified head to `feat/live-panel-ux-follow-up`. Implementation plan: [panel-ux-plan.md](panel-ux-plan.md). At completion of verification, changes were local and uncommitted. The user subsequently authorized committing, pushing into PR #1, reviewing the full PR and merging after signoff. Deployment remains outside scope.

## Implemented

- Read-only inspection on panel mount discovers targets, local responders and helper setup without executing a development command or the Impeccable CLI. Connection revalidates setup before launch, including after Advanced edits.
- Idle, discovery, selection, startup, connected and error presentations drive one primary action. Existing unassociated responders require explicit selection; only exact URLs with app association can be recommended automatically. Starting another server is secondary.
- Preview app and URL lead. Launch/preview roots and configured command are under Details. Helper readiness failures remain actionable while server choices remain visible.
- Advanced settings precede bounded startup output. Logs carry attempt provenance; previous and current attempts are separated. External server output is explicitly unavailable.
- Session and owned development-server Stop controls remain separate. Cancel cleans a startup's owned process; external development servers never get a Stop control.
- Pending-event delivery retry and completion recheck retain their distinct consequences. Paseo theme tokens, hosted ScrollView/TextInput, persistent field labels, error focus and visible control focus are used.

## Automated evidence

- `npm test`: 88 passed, zero failed/canceled/skipped. Includes original bridge/event tests and targeted inspection, readiness, association, metadata, log-attempt, override and view regressions.
- `npm run typecheck`: passed against existing pinned dependencies.
- `git diff --check`: passed.
- Impeccable context and distill/clarify/polish references informed the scoped refinement. Its final requested mechanical detector returned `[]` for the changed client targets.
- `node --experimental-strip-types evidence/development-server-lifecycle.ts --monorepo`: PASS with the real installed helper. Root command launch/concrete frontend helper separation, served injection, helper-only stop with HTTP survival, same-PID resume, full owned stop, HTML restoration and shutdown cleanup passed. SDK handles in that script are facades; it sends no agent messages.
- A fresh native Codex reviewer independently inspected the final diff. Findings concerning stale choices after edits, ordinal selection reuse, target transitions, helper readiness, stale external metadata, exact URL association, portable paths and keyboard focus were fixed. Final verdict: APPROVE, no remaining findings. The final retry-state precedence correction was separately rechecked with 7/7 targeted view tests, typecheck and diff checks.

## Actual Paseo panel checks

A temporary directory-backed plugin ID `impeccable-ux-fixture` used copies of the implementation, with only its contribution display names/slash command changed for identification. It ran in a separate fixture workspace/idle agent and local HTML app. The existing `impeccable-live` runtime was never reloaded, disabled or stopped.

1. Opening the fixture panel settled at Ready to connect. Its RPC snapshot showed ownership none, PID null, inactive helper and a deferred launch choice. No app/helper had started.
2. Connect launched an owned app, showed Connecting and Cancel with live output, started the real installed helper and automatically opened the native preview with Impeccable controls. Connected showed Open preview and both Stop controls.
3. Stop session removed the helper/injection while the same fixture server continued returning HTTP 200. The remaining owned-server Stop control then stopped that server; its URL stopped responding.
4. With a 20-second delayed fixture command, Cancel interrupted startup before helper boot. Final snapshot: stopped, ownership none, PID null, inactive helper. Logs recorded the attributable process exit and cleanup.
5. A separately harness-started server was discovered from a configured command port. With DESIGN.md temporarily moved aside, the panel still showed its server choice, an actionable helper setup error, disabled connection and Refresh checks. Restoring the file and rechecking recovered without starting a process.
6. That unassociated responder remained unselected until explicitly chosen. Tab moved to Connect with a visible focus ring; Return connected and opened the preview. Status identified ownership external and PID null. Only Stop session appeared. The external server continued returning HTTP 200 after helper stop, fixture plugin reload and fixture plugin removal.
7. Retained output from the canceled owned attempt was labeled Previous attempt 1. External connection output was separately labeled Current attempt, with an explicit notice that external server logs were unavailable. Details/Advanced remained above the log viewport.
8. Advanced fields had persistent labels and help. Invalid JSON produced a field-level correction. Invalid remote/HTTPS preview input produced the local-HTTP error and focused the URL field on submit. Correcting values and refreshing restored fresh choices after settings edits.
9. Screenshots were visually inspected in Light and Dark, at full desktop width and a narrowed desktop window. The narrow panel wrapped choice descriptions and actions without horizontal clipping; the log viewport stayed bounded. Keyboard focus and the light-theme primary action were visibly distinct. Final-source narrow Dark rendering and field recovery were rechecked after review fixes.

The original System theme setting and maximized desktop window were restored. The fixture plugin was removed, workspace archived, fixture-only project registration removed, and the harness's own external server stopped after proving plugin removal left it alive. Temporary fixture source/app files were removed after confirming no helper record remained. Active user sessions and other plugins were untouched.

## Limits

This is desktop macOS verification. Physical iOS/Android, Windows runtime, screen-reader operation and a full client restart were not exercised. Cross-platform path parsing has regression coverage; that is not Windows runtime evidence. No new browser-event design request was sent to a user agent; preserved delivery/completion semantics are covered by the existing bridge regressions. The original installed plugin continues serving its previously loaded version until a later reload, allowing active sessions to continue.

No dependencies were installed. Tracked dependency manifests/lockfiles are unchanged. Current plugin API guidance was checked against the [Paseo reference](https://paseo.sh/docs/plugins/reference.md); the implementation remains compatible with the installed 0.15.4 SDK.

## Full PR review and remediation

After the user authorized pushing this work into PR #1 and merging after signoff, fresh code-review and architecture lanes reviewed the complete 26-file PR, including the earlier server automation. That review found cancellation gaps in repeated workspace refreshes, missing-record helper cleanup bypassing guardian ownership, stale deferred launch metadata/hooks, an occupied URL incorrectly reused by the secondary launch, partial helper boot leaks, stream-chunk redaction gaps, unsafe Windows shell interpolation and the historical discovery sentence above. All received targeted repairs and regression coverage.

Every binding refresh is bounded and abortable. Deferred launches rediscover and revalidate target identity and hooks; deferred preview choices cannot restart an exited process. Secondary launches exclude a responding external URL. Missing records use guardian lifecycle cleanup. Failed helper boots are attributed by a random inherited process marker before cleanup; preexisting, concurrent foreign and replacement helpers remain untouched. Logs reassemble bounded stdout/stderr lines before redaction, including partial lines at process exit. Oversized logical lines are discarded in full rather than exposing a truncated credential value.

Fresh remediation validation: typecheck and diff checks pass; 103 tests pass, zero fail, and two platform-specific checks skip on this macOS host. The real installed-helper monorepo lifecycle check passes again after the process-marker change. Final merge signoff is performed against the pinned PR head after these checks; the PR discussion records the review evidence separately from any GitHub human approval.

Helper automation is explicitly limited to Linux, macOS and FreeBSD hosts where failed-boot ownership can be verified. Other hosts fail readiness before launching the app or helper; the guardian independently refuses helper boot. Commands always use shell-free argument passing; Windows .cmd/.bat commands are refused. The two skipped checks exercise unsupported-host rejection and Windows command-script rejection; they do not constitute Windows runtime acceptance. Existing desktop visual evidence above remains applicable because remediation changes server/cleanup/log boundaries rather than panel presentation.
