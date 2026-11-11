# Impeccable Live library showcase — bounded execution plan

Status: planner-produced plan, execution in progress, 2026-11-11. Planning does not establish runtime or recording success. The subsequent official-source check is in [library-video-requirements.md](library-video-requirements.md): MP4/WebM accepted; the 60-second 16:9 format is an editorial choice.

## Result, scope and stop condition

Prepare one isolated fictional app, prove one complete installed-plugin edit workflow, and deliver a captioned real-interaction video plus reset instructions and evidence. Destination: https://paseo.sh/plugins (supplied by user). Target 50–65 seconds, nominally 60 seconds, remains provisional until that library's submission requirements are inspected. No publishing, deploying, software installation, unrelated edits, or interruption of active sessions.

Audience: developers already using Paseo who refine local web applications. Central message: select a UI element in a local preview, let the attached agent improve it, review the result, and keep the accepted change in application source. This is a product demonstration, not installation training. These choices follow `docs/library-video-ideas.md:5`, `:41-61`.

Success requires all workflow gates below. If screen capture or editing cannot operate with installed tools, finish the demo, verification, storyboard and exact remaining production instructions; do not fabricate footage. If the edit workflow fails, retain the failure evidence and report the exact missing gate instead of substituting a communication acknowledgement. The brainstorm's suggestion to publish a shorter fallback (`docs/library-video-ideas.md:77`) is overridden by the user's prohibition on publication and requirement for a complete workflow.

## Evidence and unresolved behavior

- Panel recall, discovery and connection controls: `README.md:7-19`; runtime panel/preview behavior: `docs/panel-ux-verification.md:29-37`.
- Plugin owns background polling and distinguishes delivery from completion: `README.md:13`; exact agent dispatch guidance: `server/live.ts:546-568`.
- Stop/reload boundaries: `README.md:48-52`; a global reload can stop owned resources and is excluded while preserving other sessions.
- Historical real browser event was Steer acknowledgement only: `docs/verification.md:13-17`; accepted design-source integration is unverified in `README.md:58`.
- Latest documented checks: 103 passing tests, two platform skips, typecheck/diff pass (`docs/panel-ux-verification.md:53-55`). Run fresh checks if plugin code changes; do not relabel historical results as current.
- Installed Impeccable `reference/live.md`, inspected by parent, distinguishes element Generate from page-level Steer and requires Accept/carbonize cleanup for persistent source. The demo must exercise selection and Generate, not replace selection with Steer.
- Still unverified: exact installed picker/action labels, one-variant support, generated variant rendering, Accept cleanup, source persistence, source reload without helper, capture permission/output, readability after export, and library technical requirements.

## Demo contract

One component: a fictional **Field Notes** event card on a quiet local event page. Preserve its fictional title/date/location/copy and palette. Baseline has modest spacing and weak date/action hierarchy; it must remain usable, with no intentionally broken controls or misleading production claims.

One request, verbatim:

> Give the date a clear hierarchy, add breathing room, and make the primary action easier to find. Keep the existing colors and copy.

One obvious result: a clearer, more spacious event card with the date and primary action immediately visible. No whole-page redesign, additional feature, external content, or unrelated polish.

Create a dependency-free HTML/CSS app served by an existing Node executable. Suggested permanent resources: `demo/library-showcase/{index.html,styles.css,server.mjs,package.json,PRODUCT.md,DESIGN.md,README.md}`, a live configuration template, and a bounded preparation/reset script. New preparation uses a separate local Git repository at `.demo/library-showcase-app` with a tracked baseline so Impeccable wraps real source. Evidence/raw footage belong under the ignored neutral path `artifacts/library-video/`; deliverable documentation may be copied to `docs/library-video-storyboard.md` and `docs/library-video-verification.md` by the parent. Never include live tokens in distributable artifacts.

The completed 2026-11-11 workflow and recording actually used `.omx/library-showcase-app` and its dedicated Paseo workspace. Those remain unchanged historical provenance; copying the accepted source and selected evidence into the neutral paths does not represent a live workflow re-run. `.omx/` remains ignored only for legacy orchestration privacy, not because preparation, reset, editing, or verification depends on OMX runtime or tools. Any later run must use a new dedicated Paseo workspace and agent attached to `.demo/library-showcase-app`, not retarget the legacy recording workspace.

## Ordered execution

1. **Confirm prerequisites and library constraints.** Read the submission link/docs reachable from the supplied library, record the URL/date and exact found requirements or explicit unknowns. Inventory installed capture/edit tools, installed plugin state and existing sessions. Preserve the original untracked `docs/library-video-ideas.md`. No plugin install or global reload.
2. **Prepare reproducible demo.** Author the small baseline and actual product/design records. Supply `npm run dev` using Node with a local HTTP URL; avoid dependencies, downloads and setup hooks. Create the disposable tracked copy at `.demo/library-showcase-app` and a new separate Paseo workspace/agent bound only to it. Save baseline source hashes under `artifacts/library-video/`. Reset must check the exact demo root, require its helper/agent work to be finished, preserve evidence, and restore only explicitly listed demo files; never reset the parent checkout or use broad cleanup.
3. **Rehearse the real workflow.** In the dedicated agent open `/impeccable-live` or Command Center → Open Impeccable Live; select the demo app if necessary; click Connect and open preview. In the installed picker select the whole event card, choose the freeform improvement control, paste the exact request, choose one variant if supported, and activate the observed Go/Generate control. Show the bound Paseo agent receiving that same event and actually working. Review the rendered variant; select the appropriate result and click the observed Accept control. Wait for agent cleanup and completion. Record exact labels and any required settings in the runbook after observation.
4. **Prove each gate and repair only necessary gaps.** Save redacted event/agent evidence, completed source diff, matching before/after screenshots and fresh reload result. Stop only this demo's helper via its panel and reload the app again to prove the result survives removal of injection. Check no variant/carbonize residue remains and no unrelated files changed. Verify primary action/keyboard focus and no overflow at the recording viewport. If a plugin defect blocks this path, reproduce it, add a focused regression, make the smallest repair and run relevant checks; do not reload the active global plugin if that would disturb other sessions. Escalate that exact limitation if no isolated existing test surface can exercise the fix without installation.
5. **Record and edit.** After one successful rehearsal, reset the demo safely and record a second coherent run; retain the continuous raw recording and a source/event timeline. Capture opening/connection, selection/request, agent activity, review/Accept and persistence. Cut only idle periods, display “Waiting shortened” at those edits, and use concise captions. Preserve real action ordering. Before/after must be from this successful run with matching viewport, zoom and scroll. Export to confirmed requirements; if none are specified, export a clearly provisional 60-second 1920×1080 30 fps H.264/yuv420p MP4 without audio plus caption/edit source.
6. **Verify deliverables and leave a safe handoff.** Watch the export muted at likely embedded size; inspect frames at every cut and verify metadata/duration with ffprobe. Record file hashes, limitations and exact remaining actions. Stop only task-owned helper/server if leaving them running is unnecessary, preserve the demo and evidence, and report paths. Do not submit the video or plugin.

## Storyboard and shot list — provisional 60-second edit

| Time | Real picture and interaction | Caption | Required proof |
|---|---|---|---|
| 0–4 | Matching baseline/result card views, drawn only from the successful recorded run | Refine your UI from inside Paseo | Real before and accepted after |
| 4–11 | Open Impeccable Live panel; click Connect and open preview; local app appears | Connect your local app | Installed panel and app URL |
| 11–22 | Select whole card; show exact focused request; activate Go/Generate | Point at what needs work | Selected card outline and submitted request |
| 22–32 | Switch to attached Paseo agent; show matching request and actual edit activity | Your Paseo agent makes the change · Waiting shortened | Same event, real work, transparent time cut |
| 32–43 | Return to preview; inspect the changed card with matching framing | Review the result | Rendered variant and legible hierarchy |
| 43–49 | Click Accept; show completion, not only button feedback | Keep the version you choose | Acceptance and cleanup completed |
| 49–56 | Reload; briefly show small real source diff; hold on retained result | Saved in your app's source | Reload and source persistence |
| 56–60 | Hold on accepted card with small name overlay | Impeccable Live for Paseo · Community integration | No extra product claims |

Essential capture takes: A panel-open/connect; B selection/full request/Go; C event arrival and agent edits; D variant/review/Accept; E completed source diff and reload; F matching before/after holds. Take boundaries must preserve one run's causal sequence. Avoid exposing other workspace titles, user paths, tokens, personal notifications or unrelated code. Crop to the dedicated workspace content and keep captions outside controls. Record enough clean hold at each end to support trimming without invented cursor motion.

## Rehearsal checklist

- [ ] Installed plugin enabled; current revision/load limitation documented; other active sessions inventoried read-only.
- [ ] Fictional demo tracked baseline, product/design/live configuration, command and URL confirmed; no install required.
- [ ] New dedicated agent idle and bound to a new workspace rooted at `.demo/library-showcase-app`; no user agent or legacy recording workspace reused.
- [ ] Palette/copy baseline captured; exact viewport and scroll recorded.
- [ ] Native panel opens and connects; preview has the actual Impeccable picker.
- [ ] Correct card selected; exact prompt visible; actual variant-count behavior recorded.
- [ ] Request ID and bound agent arrival match; actual file edit activity observed.
- [ ] Variant visibly improves spacing/date/action while preserving copy/colors.
- [ ] Accept completes; cleanup is terminal; no leftover wrappers/carbonize markers.
- [ ] Source diff contains the accepted design; fresh reload retains it, including with demo helper stopped.
- [ ] Primary action/focus still work; no clipping at capture width.
- [ ] Reset only demo source; reproduce connect-to-accepted-result once more for recording.
- [ ] Recording probe contains real frames; export captions readable muted; shortened waits disclosed.
- [ ] Final metadata, hashes, output paths and remaining limitations recorded; no publication/deployment.

## Acceptance and evidence map

| Gate | Passing evidence |
|---|---|
| Preparation | Baseline files, setup/reset instructions, source hashes; reset reproduction |
| Open/connect | Native panel/preview capture and local HTTP success in dedicated workspace |
| Request delivery | Browser event ID/prompt and corresponding attached-agent timeline |
| Completed edits | Agent completion plus actual changed source; acknowledgement alone fails |
| Visible result | Real rendered accepted card and matching before/after framing |
| Persistence | Source diff/hash, clean completion status, reload after helper stop |
| Safety/scope | Parent git diff/status comparison; only named demo resources and necessary fixes; other sessions preserved |
| Code quality | `node --check` on new scripts; HTTP/functional smoke; `npm run typecheck`, `npm test`, `git diff --check` for plugin changes |
| Production | Real raw capture and edit map, 50–65s provisional export or confirmed library format; ffprobe; muted visual review |

## Risks and bounded recovery

- Static server lacks HMR: verify Impeccable's source-fetch preview path in rehearsal; manually reload only where the real workflow supports it. Do not simulate updates.
- Variant generation is nondeterministic: use narrow prompt/context and choose an actually successful result. Reset reproduces starting state, not identical AI output.
- Installed code may differ from checkout: record this boundary; do not disturb running sessions to make a version claim.
- Accept may require a second agent turn: wait for terminal source cleanup before persistence proof or caption.
- Capture may produce no frames or be blocked: try existing OS capture tooling once; preserve the diagnostic and provide exact remaining recording steps without installing tools or claiming success.
- Library may specify only a hosted URL or omit encoding requirements: deliver the local provisional master and document the upload/link requirement; publishing remains unauthorized.

## Production fallback and executor handoff

Executor owns demo preparation; parent owns native interaction, integration, final evidence and video. An independent reviewer can check the final evidence boundaries and caption claims after source/render proof exists.

If capture/edit remains unavailable: leave the demo baseline plus verified accepted result, then provide exact steps: open dedicated workspace/agent; start installed OS screen recorder at documented crop/viewport; record takes A–F in order from a fresh reset; retain raw footage; trim to storyboard times, insert captions exactly above and “Waiting shortened” at each removed wait; export with documented requirements (or provisional H.264 1080p/30fps); run `ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate -of json OUTPUT.mp4`; inspect muted at embedded size. Distinguish actions already verified from production steps still outstanding.
