# Library showcase verification

Checked 2026-11-11. No plugin code changes, installation, dependency downloads, publishing, deployment, global reload or daemon restart were needed.

## Prepared demo and scope

For the verified 2026-11-11 run, the fictional Field Notes app was at `.omx/library-showcase-app`, a separate Git repository with baseline `e06b2f954b436e0bff863d56dcec3bb77fd6376f`. That historical app remains unchanged. Its durable template is `demo/library-showcase/`; setup/reset instructions are in that directory's README. The parent checkout started at `fadbbe6dd165401ff433a854c0c89a08ff8c92f9`; the existing untracked `docs/library-video-ideas.md` was preserved.

Legacy recording workspace: `wks_6dc5a7f9559431cf`. Demo agent: `36910675-f224-4b9e-aefc-cf1628a7554a`. No existing user agent was assigned the demo. This workspace remains attached to the historical `.omx` app and must not be retargeted to the neutral copy. No agent profiles were configured, so the discovered default Codex model was used. The installed local `impeccable-live` plugin was already enabled on Paseo 0.15.4; its loaded source revision was not independently pinned by the host. This is evidence of that installed runtime, not proof of another release.

## Actual workflow

Three real runs completed from the same committed baseline: `cf02cbe7`, `b88a0036`, and the final recorded run `591d2aab`. Reset archives retain the prior accepted source. AI output is not guaranteed byte-identical between runs.

| Gate | Fresh evidence |
|---|---|
| Open/connect | Command Center → Open Impeccable Live → Connect and open preview. The installed plugin launches/reuses `npm run dev` and automatically opens `http://127.0.0.1:55369/` with actual Impeccable controls. |
| Select/request | Pick selects `article#event-card`. The exact storyboard prompt is entered in Describe the change; count cycles ×3 → ×4 → ×1; Generate variants submits one variant. Its arrow is visually labelled Steer, but this event is element-scoped `generate`, not page-level Steer. |
| Delivery | The real helper journal and attached-agent timeline identify the same event, selected card, count 1 and exact prompt. Delivery alone is not counted as an edit. |
| Completed edits | Agent file operations produce a real variant and reply. Accept dispatches a separate cleanup turn; the journal reaches `completed` only after `live-complete`. |
| Visible result | The actual preview shows stronger date hierarchy, 32px breathing room, and a filled primary action with original copy and palette. Before/after use the same viewport and scroll position within the final run. |
| Persistence | Stop session removes the helper record/injection while retaining the server. HTTP remains 200. Native browser Refresh retains the improved card with no Impeccable toolbar. Only `styles.css` differs from baseline; `index.html` is byte-identical to its baseline blob. No variant/carbonize/data-p/@scope/live.js residue remains. |

Exact request:

> Give the date a clear hierarchy, add breathing room, and make the primary action easier to find. Keep the existing colors and copy.

The run originally wrote its evidence under `.omx/evidence/library-video/`. Neutral local copies of the selected evidence are under `artifacts/library-video/`: `workflow-evidence.json`, `final-completed.snapshot.json` (tokens redacted), `final-source.diff`, `accepted/index.html`, `accepted/styles.css`, and `final-helper-off.html`. Copying these files did not re-run the workflow. Accepted SHA-256: index `ca2673bdaa2c7812203fe90384a750eb146859d73ee0cb90d5633c31ee079ac9`; stylesheet `f65de448c2e692bbeaa8d9e136a728adf2d19da16db9164563ec44c15344df1a`.

The reviewed video, interface images and [accepted source patch](media/library-showcase/accepted-change.patch) are committed under `docs/media/library-showcase/` for pull-request review. Private recordings and local session records are excluded.

## Checks

- `npm run typecheck`: pass.
- `npm test`: 105 checks, 103 pass, 2 platform skips, zero failures. The copied log is `artifacts/library-video/plugin-tests.log`.
- New Node scripts: syntax checks pass. Demo HTTP smoke: HTML/CSS 200 and `no-store`; PRODUCT.md 404.
- Reset exercised between real runs; archives changed source and restores only explicit fixture files. Requires `--agent-finished` and refuses an active helper record.
- Independent review found a potential symlink escape in reset. The fix uses lstat and canonical containment before reading/copying; a disposable safety probe rejects symlinked root, ancestor, source and destination while leaving the external target untouched. The independent recheck passed.
- Swift caption generation, ffmpeg editing, output metadata, and overwrite refusal passed a tool smoke check. The smoke clip is not demonstration footage.
- `git diff --check`: pass. No lint script is defined; no dependencies were added.
- The preserved primary action navigated to `#event-details`. Two real Tab presses reached the wordmark and then the primary action; the accepted action displayed a visible focus outline. The demo's owned development server was stopped after capture, and the workspace sidebar was restored.

## PR #4 preparation and privacy follow-up — 2026-11-12

Review of `e3327e0` found two blockers: fresh-checkout preparation required `.omx` to exist, and private evidence was excluded only through a workstation-global Git ignore. `prepare` now creates `.omx` using the existing containment-checked helper; other commands retain their non-creating validation. The repository now owns the `/.omx/` exclusion.

Five disposable CLI/Git regression tests cover fresh preparation and repeat preparation, non-mutating status before preparation, existing session preservation, symlinked `.omx` rejection without target writes, and private-path exclusion without global Git settings while the public media/config stay visible. Before the fix, the two corresponding regressions failed; after the fix all five pass. The real demo, private captures and active sessions were not used as test fixtures.

Fresh follow-up checks: typecheck, script syntax, diff whitespace, and the existing symlink safety probe pass. The full suite reports **107 passed, 1 failed, 2 skipped** (110 tests, including the five additions). The sole failure remains `tests/process-guardian.test.ts:302`, timing out on recorded process exit after raced shutdown. The preceding independent review reproduced that failure on the base revision; the guardian implementation and test remain unchanged here. This follow-up does not claim to repair that baseline failure, and does not describe the full suite as green.

## Neutral local-storage follow-up — 2026-11-12

New preparation targets `.demo/library-showcase-app`, while baseline records, reset archives, the raw recording, and selected final evidence target `artifacts/library-video/`. The accepted source is copied into the new prepared app without replaying the live workflow. The historical `.omx/library-showcase-app`, its Paseo workspace, and rejected captures under `.omx/evidence/library-video/excluded-private/` remain untouched. `.omx/` stays ignored for legacy orchestration privacy only; the preparation script and production instructions no longer depend on OMX runtime or tools.

Seven focused storage tests pass. They cover fresh and repeated preparation, a non-mutating missing-demo status, preservation of unrelated `.omx` and `.demo` data, reset archival to `artifacts/`, refusal of symlinked `.demo` and `artifacts` paths, and repository ignore behavior for the neutral local paths. Typecheck, script syntax, the symlink safety probe, and package checks also pass.

The full `npm test` command was bounded after more than two minutes: `backend.test.ts` printed 17 results (16 passed and one failed with `Unexpected end of JSON input` at `backend.test.ts:189`), but an owned backend-fixture `live-poll` process kept the command open. Running the remaining six files with a 30-second test timeout reported **92 passed, 1 failed, 2 skipped** across 95 tests. The failure is the same previously base-reproduced `tests/process-guardian.test.ts:302` timeout described above; this follow-up does not claim a full green suite. The backend JSON-read failure and hang have not been reproduced on the base revision and remain separate validation gaps. A later live run must create a new dedicated Paseo workspace and agent rooted at `.demo/library-showcase-app`; the legacy recording workspace is provenance, not a reusable target.

## Recording and evidence limits

The first long rehearsal recording was interrupted and did not save; its workflow evidence comes from native observations, source and the journal. Two desktop-capture attempts followed the foreground desktop rather than background Paseo and were rejected during review. Those files remain in the legacy `.omx/evidence/library-video/excluded-private/` directory and are not copied to neutral artifacts or used as edit inputs.

A three-second window-only probe proved `screencapture -l3730` captures just the intended Paseo window. The final continuous recording used `screencapture -o -l3730 -v -V 240 -x …/raw-verified.mov`, beginning 21:17:55 UTC, against the historical `.omx` demo and workspace. Its neutral copy is `artifacts/library-video/raw-verified.mov`. All final edit inputs come from this single real run; the copied path does not imply a new capture. Retain the complete raw and edit decisions; label shortened waits. Record-to-duration is required: interrupting screencapture can discard the output. Window IDs are ephemeral and must be rediscovered for a later recording.

The toolbar expands on hover and shifts controls; move onto it before choosing Pick. DESIGN.md's optional token panel can be closed for framing; this fixture has prose design context, not a generated token sidecar. Static source preview works without adding an HMR dependency. This proves the local macOS desktop/static-HTML scenario; mobile, other frameworks, and other operating systems were not exercised.

Video encoding requirements and official references are in [library-video-requirements.md](library-video-requirements.md). The manifest declares the bundled screenshot and MP4 for the listing; no registry submission was performed. The finished 62.5-second export, hashes, edit map and review are recorded in [the production runbook](library-video-production.md).
