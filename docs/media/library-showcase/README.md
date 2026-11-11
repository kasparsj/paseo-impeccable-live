# Library showcase assets

- [showcase.mp4](showcase.mp4): reviewed 62.5-second, captioned 1080p H.264 video with no audio.
- [plugin-panel.png](plugin-panel.png): actual installed plugin interface, cropped to exclude startup paths.
- [result.png](result.png): actual accepted result after reload with the helper stopped.
- [edit.json](edit.json): chronological source ranges, crops and captions from one real workflow run. This is the editorial decision list; `scripts/edit-library-video.mjs` consumes per-shot configurations described in the production runbook.
- [accepted-change.patch](accepted-change.patch): the actual accepted stylesheet change against the fictional demo baseline. The HTML and copy remained identical to baseline.

Video SHA-256: `f46025c28717d929bd5313790319b54b373bd1a0d6b6be3d2e7d3dfbbcd07326`.

The private continuous raw recording is intentionally not committed. Its local path and SHA-256, runtime evidence, reset instructions and rendering procedure are documented in [the production runbook](../../library-video-production.md). Editing the video requires that retained recording or a new verified capture; the committed MP4 and images can be reviewed directly.

The plugin manifest declares `plugin-panel.png` first as the listing thumbnail and `showcase.mp4` as the accompanying video. Both are included by the package's `docs/` file rule. This metadata does not itself submit the plugin to the Paseo library.
