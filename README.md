# Impeccable Live for Paseo

An unofficial community [Paseo](https://paseo.sh/) integration for [Impeccable Live](https://impeccable.style/docs/live/): visual editing, live preview, and background agent dispatch. This project is independent of both upstream projects and reuses your installed Impeccable skill; it does not bundle its engine.

## Recall

In an existing workspace agent, enter `/impeccable-live`, or use Command Center → **Open Impeccable Live**. Set the app's relative folder and local preview URL, then **Start / resume** and **Open preview**. A workspace containing a `frontend` app can use automatic discovery from `.`.

Configuration is saved with the panel tab for session restoration; creating a new tab starts with defaults.

The plugin owns the long-running listener. Browser requests wake the attached agent; the agent performs the requested work and replies through the installed Impeccable CLI. Starting the plugin does not itself request a redesign. Delivery accepted by Paseo is distinct from work completed by the agent.

## Setup

Requires Paseo app and daemon 0.15.4, Impeccable installed as a local skill, and a working local development server. The first release is pinned below 0.16 pending compatibility checks. The CLI is discovered from the usual personal skill directories, or set an absolute executable path under advanced settings. Product/Design records and `.impeccable/live/config.json` must already exist; missing setup is shown without inventing project context.

Build/check locally:

```sh
npm ci
npm run typecheck
npm test
npm pack
```

Install from GitHub on the intended daemon:

```sh
paseo plugin install https://github.com/kasparsj/paseo-impeccable-live.git
paseo plugin ls impeccable-live
```

Or install a local checkout:

```sh
paseo plugin install /absolute/path/to/paseo-impeccable-live
paseo plugin ls impeccable-live
```

Plugins must first be explicitly enabled on that daemon. No automatic config changes or daemon restarts are performed. After editing plugin source, use `paseo plugin reload impeccable-live`.

## Lifecycle and recovery

Stop the session with the panel before switching projects. Closing the panel does not stop the listener; disabling/reloading the plugin cleans up its owned helper. Stopping the helper does not cancel a design edit already accepted by the agent. Existing externally started helpers are refused. Stop them through their owning session before starting this wrapper.

Reloads do not silently restart design sessions. Reopen the panel and start explicitly. Upstream Impeccable journals retain unfinished work. If delivery is uncertain, inspect the bound agent and upstream status before **Retry event delivery**; retry may duplicate a request whose send was accepted before a transport error.

The browser runs on the client desktop. This release supports local HTTP URLs only and does not tunnel remote development servers or helpers. A web client on the development machine can open an external URL. Phone preview is not supported because loopback addresses refer to the phone itself.

## Verification boundary

TypeScript checks and 15 child-process integration tests pass. The plugin has loaded in Paseo 0.15.4; its panel, start action, preview opener, and a browser → agent → browser Steer acknowledgement have been exercised. The isolated installed-helper lifecycle also passes. A generated design variant accepted into source remains untested. See [verification details](docs/verification.md).

The repository is public. `package.json` keeps `private: true` to prevent accidental npm publication; this does not prevent installation from GitHub or a local checkout.

## Data and trust

The daemon-side plugin can access local files/processes as its user. It launches only the installed Impeccable executable, without a shell. It does not install software or publish anything. Requests, selected page content, and screenshots can reach the configured agent provider. Helper tokens remain server-side and are not package contents.
