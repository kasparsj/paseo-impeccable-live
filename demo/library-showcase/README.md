# Field Notes showcase fixture

This dependency-free local app is the reproducible starting state for the Impeccable Live library video. It contains fictional content and one edit target: `#event-card`.

The exact live request is:

> Give the date a clear hierarchy, add breathing room, and make the primary action easier to find. Keep the existing colors and copy.

## Prepare the disposable app

From the plugin repository root:

```sh
node scripts/prepare-library-showcase.mjs prepare
```

The command creates `.demo/library-showcase-app` as a separate local Git repository, commits only the explicit fixture files, records its baseline under `artifacts/library-video/`, and prints the directory and baseline commit. It does not install packages, start a server, create a Paseo workspace, or start Impeccable. Neither this command nor reset requires OMX runtime or tools; `.omx/` is reserved only for ignored legacy orchestration data.

For Impeccable work, create a new dedicated Paseo workspace rooted at `.demo/library-showcase-app` and attach a new demo agent. Do not retarget the legacy recording workspace, which remains bound to the historical `.omx/library-showcase-app` copy.

In the prepared app, run:

```sh
npm run dev
```

The server binds to `127.0.0.1` on an ephemeral port and prints `FIELD_NOTES_URL=...`. The Paseo plugin can discover the conventional `dev` script and connect to that URL.

## Reset after rehearsal

First finish the demo agent's turn and stop this demo's Impeccable session from its panel. Confirm `.impeccable/live/server.json` is gone. Then, from the plugin repository root, run:

```sh
node scripts/prepare-library-showcase.mjs reset --agent-finished
```

Reset refuses to run without the acknowledgement flag or while a helper record exists. Before restoring, it archives the current explicit fixture files, Git status, and binary diff under `artifacts/library-video/reset-archives/`. It restores only the named fixture source files from `demo/library-showcase`; it does not reset the parent repository, delete live journals, or touch another workspace.

Use `node scripts/prepare-library-showcase.mjs status` to inspect the disposable app without changing it.
