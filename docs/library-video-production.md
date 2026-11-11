# Impeccable Live library video production

Audience, message, scenario, storyboard, shot list and rehearsal checklist: [library-video-storyboard.md](library-video-storyboard.md). Official destination constraints: [library-video-requirements.md](library-video-requirements.md). Runtime/source proof and limits: [library-video-verification.md](library-video-verification.md).

## Finished local delivery

- Reviewable repository copies: [showcase video](media/library-showcase/showcase.mp4), [plugin interface image](media/library-showcase/plugin-panel.png), [accepted-result image](media/library-showcase/result.png), and [edit decision list](media/library-showcase/edit.json). Ignored local production artifacts are under `artifacts/library-video/`; rejected private captures remain only in the legacy `.omx/evidence/library-video/excluded-private/` directory.
- Video: `artifacts/library-video/impeccable-live-showcase.mp4` — 62.5 seconds, 1920×1080, 30fps, H.264/yuv420p, no audio, burned-in captions, 1,265,467 bytes.
- Actual-interface image: `artifacts/library-video/production-edit/plugin-panel.png`; accepted-result poster: `production-edit/poster.png` in the same artifact directory.
- Editable timeline: `artifacts/library-video/production-edit/edl.json`; executable shot configurations: `production-edit/shots/*.json`; render order: `production-edit/render-command.txt`. Re-render to fresh output names because the editor refuses overwrites.
- Continuous source: `artifacts/library-video/raw-verified.mov`, 240.011667 seconds. This is a copy of the recording made against the historical `.omx/library-showcase-app` workflow, not evidence that the workflow was run again after the storage change. The final edit uses only this recording and one completed run (`591d2aab`). The opening, connection, selection/request, running agent, review/Accept, helper stop and reload remain in causal order. Generation and acceptance-cleanup waits are explicitly labelled **Waiting shortened**.
- Export SHA-256: `f46025c28717d929bd5313790319b54b373bd1a0d6b6be3d2e7d3dfbbcd07326`. Raw SHA-256: `acfabb4ad3f5101ec80bb44f000a3ab7ec90737568cee591872432176deb1e9b`.

The revised export was completely decoded without errors. Caption/cut frames were reviewed muted, including matched baseline/result framing, the actual running timer/Stop control, acceptance, and the final filled action/bold date with no helper toolbar. An initial edit's premature persistence cut and exposed startup output were rejected and corrected. Raw captures contain local session details and are private production evidence; distribute the reviewed export and clean interface image only.

Independent final review passed for the frozen export hash above and the demo's reproducibility boundary. The fixture live configuration is explicitly included through three narrow `.gitignore` exceptions; runtime helper state stays ignored. No remaining production step is required for local delivery. Hosting/submission would be a separate authorized action.

## Reproduce the starting state

The neutral prepared copy is `.demo/library-showcase-app`; it has its own Git baseline and retains the accepted source. Its helper and development server are stopped. The app used for the recorded run remains unchanged at `.omx/library-showcase-app`, and the existing **Field Notes · Impeccable Live demo** Paseo workspace remains the legacy recording workspace. Do not retarget that workspace. For any new work, create a new dedicated Paseo workspace rooted at `.demo/library-showcase-app` and attach a new demo agent there.

From this repository:

```sh
node scripts/prepare-library-showcase.mjs status
# After the demo agent finishes and its visual session is stopped:
node scripts/prepare-library-showcase.mjs reset --agent-finished
```

Reset archives current explicit fixture files and the diff under `artifacts/library-video/reset-archives/` before restoring baseline. It refuses active helper records or symlinked paths. To create the app on another checkout with existing prerequisites, run `node scripts/prepare-library-showcase.mjs prepare`; the command uses `.demo/` and `artifacts/` and does not depend on `.omx/` or OMX tooling. No package installation is needed.

Open the new dedicated agent attached to `.demo/library-showcase-app`, invoke Command Center → **Open Impeccable Live**, and click **Connect and open preview**. The local server prints an ephemeral URL; use the one opened by the plugin. The app's sole focused target is `article#event-card`.

Select **Pick**, then the card's empty upper-right area. Paste:

> Give the date a clear hierarchy, add breathing room, and make the primary action easier to find. Keep the existing colors and copy.

The count control cycles ×3 → ×4 → ×1. Choose ×1 and click **Generate variants** (the visual arrow says Steer). Watch the actual attached agent, review the variant and click **Accept**. Wait for source cleanup and journal phase `completed`. Stop session, reload the preview, and inspect the source diff before claiming persistence. Stop only this demo's development server when finished.

## Record again without capturing other apps

Use **window-only capture**. Desktop capture follows whichever app is in front and is unsuitable when the desktop is in concurrent use. Window IDs are ephemeral; discover the current Paseo window using ScreenCaptureKit or the OS window selector. The development run's window ID was 3730; do not assume it will remain valid.

After choosing the current window ID, first make and inspect a short probe:

```sh
screencapture -o -lWINDOW_ID -v -V 3 -x /absolute/path/probe.mov
ffmpeg -i /absolute/path/probe.mov -frames:v 1 /absolute/path/probe.png
```

Then record a complete run to a fresh file, using the same window, viewport, zoom and scroll position for before/after:

```sh
screencapture -o -lWINDOW_ID -v -V 240 -x /absolute/path/raw.mov
```

Let the timed recording finish. Interrupting the process can discard the movie. Hide the workspace sidebar for privacy, close the optional DESIGN.md panel, and keep unrelated sessions running. Startup output and dispatched event text may contain absolute paths or tokens: exclude them through framing/cropping. Inspect the saved recording before editing.

## Edit and export

The installed ffmpeg lacks drawtext/ASS filters. `scripts/library-video-caption.swift` uses existing Swift/AppKit to render caption PNGs; `scripts/edit-library-video.mjs` trims actual frames and burns captions into a 1920×1080, 30fps, H.264/yuv420p MP4 with no audio and faststart.

An edit JSON contains `raw`, `output`, optional physical-pixel `crop: {x,y,width,height}`, and `segments: [{start,end,caption,duration?}]`. Paths resolve relative to the JSON. Run:

```sh
node scripts/edit-library-video.mjs /absolute/path/edit.json
```

Outputs are never overwritten. A reduced `duration` must include **Waiting shortened** in its caption. Cut idle periods transparently; preserve action order and one run's causal sequence. Do not insert simulated UI, fabricated agent activity or a result from another run. Use matching card crops before and after. Retain the complete raw capture and edit decisions for a different export.

Verify the result muted at embedded size, decode it completely, inspect each cut, check privacy, and read metadata:

```sh
ffmpeg -v error -i /absolute/path/output.mp4 -f null -
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate,pix_fmt -of json /absolute/path/output.mp4
```

The manifest's `media` array declares the package-relative interface image first and the video second. Both are shipped through the package's `docs/` file rule. The official library supports MP4/WebM and also requires an actual-interface image for visual plugins. Publication, hosting and registry submission remain separate actions.
