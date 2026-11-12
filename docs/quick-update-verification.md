# Scoped quick-update verification

This document records implementation-level and disposable-project evidence for the reviewed quick-update plan. It does not replace independent rendered-panel validation and does not claim that a fixture is a real user agent or external-installer lock.

## Implemented contracts

- **Eligibility and disclosure:** `server/quick-update.ts` maps the lexical selected launcher to upstream-recognized provider locations in personal or project scope. It rejects selected links, linked ancestors, custom/legacy/marketplace locations, relative provider overrides, ambiguous legacy entries, missing metadata, and any unsupported affected entry instead of silently omitting it. Prepared plans name the selected path, working project, scope, affected copies, target skill and updater versions.
- **Trusted execution:** the server acquires exact `impeccable@4.8.2` from `https://registry.npmjs.org` in a new temporary directory with an empty user npm config and isolated cache. It verifies the reviewed main-package integrity and the platform package's pinned `0.1.21` integrity, then invokes the acquired engine by absolute path with `update`, one explicit scope flag, `--yes`, and `--no-hooks`. It never uses a project package, PATH shim, shell string, `@latest`, or `--force`. `IMPECCABLE_BIN`, `IMPECCABLE_DOWNLOAD_BASE`, and `IMPECCABLE_SKILL_DIR` are removed from child environments; `IMPECCABLE_HOME` is intentionally retained because it is the upstream engine-storage setting and is useful for isolated validation.
- **Coordination:** apply reserves the coordinator synchronously before refreshing agent state. Startup, inspection, selection, stop, retry and competing plans are blocked during that reservation. Agent state, current binding, attempt and lifecycle are rechecked after awaited calls and again before mutation. Plugin scope locks serialize updater work; they do not claim to lock external installers.
- **Stale plans:** plan revalidation fingerprints the launcher, `SKILL.md`, `scripts/VERSION`, affected scope paths and content/stat identities. Scope, target, updater, selection, app root and attempt are also bound. The version endpoint must still report the authorized target immediately before native updater spawn.
- **Process and completion:** subprocesses use structured arguments, bounded redacted output, a timeout, process-group termination and shutdown cancellation. Exit zero alone is insufficient: the selected skill must equal the target, engine probe and compatibility must be ready, and a forced version refresh must report `current`. Failure remains visible and explicitly says partial writes are not rolled back; success instructs a reload or new agent session.

## Automated evidence

Run from the repository root with Node 22.19.0:

```sh
npm run typecheck
node --experimental-strip-types --test tests/update.test.ts tests/session.test.ts tests/quick-update.test.ts
npm test
git diff --check
```

The focused quick-update/session run on 2026-11-12 passed 37/37 tests; the documented four-file focused command passed 56/56. Coverage includes copied and linked filesystem fixtures, custom and relative-provider paths, exact structured arguments, local-package shadowing, package/engine integrity, stale content and binding changes, duplicate/scope serialization, coordinator races, busy/unknown agents, shutdown, failure/large-output/timeout subprocesses, exit-zero-but-unchanged detection and independent skill/engine verification.

## Disposable official updater

Reproduce with:

```sh
node --experimental-strip-types evidence/quick-update-disposable.ts
```

The script creates a temporary Git project, temporary npm cache, temporary updater installation and isolated `IMPECCABLE_HOME`. It installs the official project-scoped Codex copy with the reviewed engine, makes only the disposable skill metadata stale, then exercises the production prepared-plan/execution path. It removes the entire temporary root in `finally`; it never selects or updates a personal installation.

Observed on macOS arm64, 2026-11-12:

- official initial skill: `4.8.2`
- disposable pre-update skill: `4.8.1`
- verified post-update skill: `4.8.2`
- independently probed engine: `0.1.21`
- native arguments: `update --project --yes --no-hooks`
- upstream result: one `.agents` skill refreshed and engine `0.1.21` installed into that disposable project
- personal installation touched: no

## Bounded limitations

The upstream native update command downloads its current skill bundle after spawn and exposes no immutable bundle-version argument. The plugin force-checks the authorized target immediately before spawn and rejects a known changed target before mutation, but it cannot eliminate a remote change during the in-flight native command. It also cannot provide rollback or coordinate with unrelated installer processes. These cases are reported as failures/partial states rather than success.

## Independent parent verification

The parent independently reran `evidence/quick-update-disposable.ts` on 2026-11-12. It reproduced the official project-scoped update: an official 4.8.2 installation was made artificially stale at metadata version 4.8.1, then restored to 4.8.2 by the production updater path. The independently probed engine was 0.1.21. The one affected `.agents` installation and npm/engine storage were under the disposable temporary root, which the script removed afterward. This is an actual official installer/update execution, not a simulated process result; it is not a full migration test of every file from a historical 4.8.1 release.

The final independent full suite passed **149 tests, 2 platform skips, 0 failures** (151 total); typecheck, diff checks and the Impeccable mechanical detector on the changed client files passed. One earlier full parallel run timed out in the unchanged guardian automatic-descendant-cleanup test. Its exact leftover fixture process was identified and removed; the isolated failing case passed five reruns, the guardian file passed three reruns, and the final parent full suite passed. No guardian code change was made. This timing sensitivity remains a test-environment limitation.

The bounded independent review approved the final source after checking the prior targeting, shutdown, operation-scoping, busy recovery, completion, fingerprint and package-shadowing findings. No remaining finding was reported in that review scope.

### Actual installed panel

A separate directory-backed plugin ID `impeccable-quick-smoke` copied the current source into the ignored `.demo/quick-update-panel-parent/` fixture. Contribution/RPC names and default app/launcher settings were changed only in that copy. The disposable nested project contained `.agents` and `.claude` copies at skill 4.8.0 / engine 0.1.18. The fixture kept real dependency inspection, scope preparation, coordinator guards, schema-validated RPCs and the production panel. Its version fetch returned a controlled 4.8.2 response; an injected execute function supplied delayed success, failure or partial-write outcomes. A fixture-only SDK proxy exposed controlled idle/busy agent state without sending agent messages or changing the real agent. These controls establish rendered behavior; they do not replace the actual updater run above or prove a real agent turn's timing.

Observed in Paseo Desktop 0.15.4 on macOS:

| Assertion | Native panel observation |
| --- | --- |
| Scope disclosure | Before execution, the panel showed the selected launcher, project scope/root, both affected provider installations, pinned updater and target versions, and the engine/commands/hooks scope caveat. The action was named **Update project installations**. |
| Pending operation | Delayed execution changed the label to **Updating Impeccable…** and disabled the update and Connect actions. |
| Failure and retry | Controlled failure remained visible with a human-facing message and an explicit no-rollback statement; Connect became available again. Duplicate RPC wrappers found in the first smoke were fixed and final-source checks showed clean messages. |
| Busy refusal/recovery | Switching the fixture agent state to running made apply refuse without changing the disposable skill. **Review update eligibility again** recovered when the controlled state became idle. |
| Partial mutation | The fixture wrote the target metadata and then failed. After availability became current and the notice disappeared, **Impeccable update needs attention** and the failure/no-rollback text remained visible independently. |
| Success and readiness | Final-source success removed the availability notice, showed verified skill 4.8.2 / engine 0.1.21 and the reload/new-session instruction, and re-enabled Connect. Expanded Connection Details independently refreshed its engine from 0.1.18 to 0.1.21. |
| Linked installation | Replacing the selected disposable skill directory with a symlink produced guidance to update the source checkout and an Update instructions link, with no automatic Update button. |
| Compact and keyboard | Full-width and three-column narrow-pane screenshots were inspected. Scope paths, affected-installation rows, side-effect text, actions and recovery text wrapped without horizontal clipping. Keyboard navigation reached the update action with a visible focus ring; Return activated it and immediately disabled competing actions. Accessible text/button/link names were present in the native accessibility tree. |

The temporary plugin was removed and its disposable source/app/skill files deleted. The main `impeccable-live` runtime remained running and was never reloaded, disabled or stopped. No personal installation was updated, no user-agent task was sent and no deployment was performed. Physical mobile clients, alternate-theme rendering and spoken screen-reader announcements were not exercised.
