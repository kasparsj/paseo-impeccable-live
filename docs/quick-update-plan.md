# Scoped Impeccable update action

## Objective and scope

Add a quick update action alongside the update notice, with visible scope, progress, errors and post-update verification. Keep update detection from PR #8 intact. The parent owns this plan; one fresh executor owns the implementation and tests. This branch starts at `94b7e05` and is stacked on the open update-notice PR #8.

| Capability | Accepted behavior |
| --- | --- |
| Eligibility | Map the selected launcher to a conventional upstream-recognized copied installation in personal or project scope. Preserve/check the lexical selection and resolved path so links and ancestor links cannot masquerade as copied installations. Marketplace locations, linked checkouts, arbitrary overrides, missing/ambiguous metadata and unsupported paths retain guidance. Conventional location is eligibility for the official installer, not a claim of installation provenance. |
| Scope disclosure | Before execution show the named personal/project scope, discoverable affected installations and the working project. The official updater can change all recognized copies in that scope, provider commands/agents, engine files and existing hook wiring. Do not imply exact-directory targeting or that --no-hooks prevents repair. An explicit Update personal installations / Update project installations action authorizes this described operation. |
| Execution | Use the official npm updater with an explicit scope, noninteractive arguments and --no-hooks; never --force. Pin the updater package to reviewed `impeccable@4.8.2` and bind that exact version into every authorized plan and subprocess argv; do not use @latest or an unpinned package. Display the updater version separately from the target skill version. Do not execute a project-provided npm/npx shim or a project-local matching impeccable package as a trusted installer. Acquire impeccable@4.8.2 in an isolated disposable tool directory outside the target project using the trusted npm runtime, canonical registry and disabled lifecycle scripts; then invoke that package’s known CLI by absolute path with the target project as cwd. Direct npx from the target cwd is forbidden: an independent harmless fixture confirmed that it prefers a matching project-local package even with an exact version. Structured argv, asynchronous bounded/redacted output, timeout and process-group cleanup; no automatic retry or automatic agent reload. |
| Coordination | Reject stale binding/attempt/installation/scope/version plans server-side. Recheck before spawning. Block while Live/startup/cleanup/event work or the attached agent is busy, and prevent a simultaneous connect/reconfigure/update. Serialize duplicate requests without duplicate writes. Serialize scope operations within this plugin runtime; do not claim protection against unrelated external installers. |
| Completion | Re-read the selected skill metadata, probe engine readiness, refresh update availability and show a reload/new-agent-session instruction. Exit 0 is not sufficient proof of update, and partial failures never display success. Do not stop unrelated services or reload agents/plugins automatically. |
| Recovery | Missing tools, unsupported installation, changed scope, download/process failure and timeout are actionable visible states. Preserve ordinary connection/recovery behavior after the operation ends. No new repository dependencies. |
| Evidence | Focused tests, full existing test suite, typecheck, static/diff checks; a real official updater on a disposable project install with isolated cache/engine storage; actual isolated Paseo panel checks for eligibility/disclosure/progress/success/failure/busy/compact/keyboard. Never update the personal installation to test the feature. |

## Acceptance contracts

Shared prerequisites (N1): implementation starts at 94b7e05, Node >=22.14, installed dependencies, and the reviewed official updater package impeccable@4.8.2. npm registry metadata identifies gitHead 035c8f319edd019936525a062fe99e83ca8d12c6 and platform engine dependencies 0.1.21; the engine-v0.1.21 upstream source confirms the same scoped updater/provider semantics. Use this released source, not main, as the implementation baseline.

Real-surface prerequisites (N2): disposable filesystem/project installation, isolated engine/npm cache, separate temporary plugin ID on Paseo 0.15.4, and no mutation of real personal installations or unrelated user agents. Parent owns independent runtime validation. A missing prerequisite is a validation gap, never a passing fixture substitute.

### VAL-QUICK-ELIGIBILITY

- Surface: Filesystem discovery and official updater scope discovery.
- Needs: N1; copied/link/ancestor-link/custom fixtures.
- Behavior: supported conventional copied installs map to the correct explicit upstream scope; symlink, ancestor-link, marketplace/custom/ambiguous paths do not receive automatic update capability.
- Evidence: filesystem fixtures plus official updater discovery behavior.
### VAL-QUICK-DISCLOSURE

- Surface: Rendered Paseo panel.
- Needs: N1, N2; eligible and guidance-only fixtures.
- Behavior: the panel identifies selected installation, named scope, affected paths and working directory, with the hook-repair/shared-installation caveat before the execute button.
- Evidence: rendered panel and source review.
### VAL-QUICK-TARGET

- Surface: RPC/coordinator and spawned process argv.
- Needs: N1; stale selection/scope/version fixtures.
- Behavior: scope/version/selection/attempt changes invalidate an update plan before mutation. Do not send user-controlled executable names or shell strings to an installer. Isolated package acquisition and absolute CLI invocation must defeat project-local package and registry shadowing.
- Evidence: adversarial coordinator/RPC/process tests.
### VAL-QUICK-COORDINATION

- Surface: Coordinator concurrency and rendered panel.
- Needs: N1, N2; deferred updater and busy-agent fixtures.
- Behavior: no duplicate update, no update during active Live or busy agent, no connect/reconfigure race while update is pending.
- Evidence: coordinated deferred-process tests and rendered busy state.
### VAL-QUICK-PROCESS

- Surface: Official npm subprocess and fixture subprocesses.
- Needs: N1, N2; failure/hang/large-output fixtures; exact package-version binding.
- Behavior: structured official updater invocation, bounded/redacted output, timeout/shutdown cleanup and visible failure without automatic retries.
- Evidence: real subprocess fixtures, source review and actual failing panel action.
### VAL-QUICK-VERIFY

- Surface: Disposable official project update and rendered panel.
- Needs: N1, N2; version/engine before-after records.
- Behavior: independently re-read selected skill and engine after completion, distinguish unchanged/skipped/partial failure, refresh the notice and require a new/reloaded coding-agent session.
- Evidence: disposable official project update plus regression fixtures and success panel state.
### VAL-QUICK-PRESERVE

- Surface: Existing test suite and readiness/update panel.
- Needs: N1, N2; baseline tests and panel state matrix.
- Behavior: update notices, readiness, dev/helper lifecycle, unknown/offline/opt-out behavior and existing dirty work remain intact.
- Evidence: full suite/typecheck and focused panel checks.

## Upstream evidence

Investigation reference: `pbakaus/impeccable@b4bff1626c344067788c2679f048a20057c7cc5a`. Execution baseline: official `impeccable@4.8.2` using released engine `0.1.21`, source tag `engine-v0.1.21`. npm package metadata was fetched read-only; the released source was checked for the scoped flags and provider path mapping. Exact package pinning is mandatory.

- `crates/skills/src/commands.rs`: update supports `--user`, `--project`, `--yes`, `--no-hooks`; it has no exact path/provider update selector. All recognized copied providers in the scope may be refreshed. Linked installs are skipped. Hook repair can run even with --no-hooks and even when skill files are current.
- `crates/skills/src/providers.rs`: source of truth for recognized provider paths and scope resolution. Do not equate the plugin's wider launcher discovery with upstream update eligibility.
- `cli/bin/cli.js`: npm entry forwards update arguments to the native engine. First-party package: `impeccable` on npm, official metadata `https://impeccable.style/api/version`.
- https://impeccable.style/tutorials/getting-started/ : npm installs use `npx impeccable update`, marketplace installs use the coding tool's plugin menu, linked installs refresh their source/link; reload the coding tool after updating.

Released source: https://github.com/pbakaus/impeccable/blob/engine-v0.1.21/crates/skills/src/commands.rs and https://github.com/pbakaus/impeccable/blob/engine-v0.1.21/crates/skills/src/providers.rs . npm metadata: https://registry.npmjs.org/impeccable/4.8.2 .

## Validation and boundaries

Commands: `npm run typecheck`, `node --experimental-strip-types --test tests/update.test.ts tests/session.test.ts` plus new focused tests, `npm test`, `git diff --check`. Add a reproducible disposable real-update evidence script/runbook if useful. The parent independently verifies the implementation and real panel.

Do not install dependencies in this repository, update the real personal Impeccable installation, reload the main plugin, restart the daemon, send work to an existing user agent, merge, publish or deploy. A temporary directory-backed plugin and disposable local fixtures are authorized; remove them after verification. Preserve PR #8 as a separate branch. Physical mobile clients and spoken screen-reader announcements remain outside the desktop validation claim.


## Reviewed upstream limitation

The exact updater executable is pinned, but that released updater downloads upstream's current skill bundle when it runs. There is no verified exact-version bundle selector or server lock. The plugin must force-check the disclosed target immediately before native mutation and refuse a known-stale plan. A release changing during the native request remains an external race; a different/partial result must be reported as unverified/failure, with no rollback claim. “Target skill” means the version observed and authorized at the latest check, not an atomic remote-version guarantee. This preserves the requested scoped latest-update behavior without inventing an upstream transaction contract.
