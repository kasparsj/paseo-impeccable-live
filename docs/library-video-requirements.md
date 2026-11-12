# Paseo library video requirements

Checked 2026-11-11 for the user-supplied destination <https://paseo.sh/plugins>.

The [official publishing guide](https://paseo.sh/docs/plugins/publishing#icons-and-screenshots) supports MP4 and WebM. Media may be a package-relative file shipped with the plugin or a public HTTPS URL. Public video URLs must end in `.mp4` or `.webm`, return HTTP 200 and the corresponding video content type.

A visual plugin also needs at least one image showing its actual current interface. Video supplements that image; the first image is the listing thumbnail. Use fictional sample data and hide private details.

No duration, aspect ratio, resolution, frame rate, codec, file-size or audio limits were found in the guide, [submission form](https://github.com/getpaseo/plugins/blob/2363de595b239edca107df0fbb16f3b65e35397a/.github/ISSUE_TEMPLATE/submit-plugin.yml), [review policy](https://github.com/getpaseo/plugins/blob/2363de595b239edca107df0fbb16f3b65e35397a/REVIEW.md#L100-L115), or [media validator](https://github.com/getpaseo/plugins/blob/2363de595b239edca107df0fbb16f3b65e35397a/scripts/lib/media.ts#L1-L39).

Production choice: approximately 60 seconds (user target 50–65), 1920×1080, 30 fps, H.264 MP4, yuv420p, no audio, concise burned-in captions. These are editorial/export choices, not library rules. Keep the raw capture and edit map for alternate exports.

The reviewed assets are committed for pull-request review, and `paseo-plugin.json` declares their package-relative paths in `media`. The screenshot is first, followed by the video. Registry submission, publishing and deployment have not been performed.
