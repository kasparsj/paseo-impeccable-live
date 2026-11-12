# Impeccable Live for Paseo

An unofficial community [Paseo](https://paseo.sh/) integration for [Impeccable Live](https://impeccable.style/docs/live/): visual editing, live preview, and background agent dispatch. This project is independent of both upstream projects and reuses your installed Impeccable skill; it does not bundle its engine.

## Recall

In an existing workspace agent, enter `/impeccable-live`, or use Command Center → **Open Impeccable Live**. Opening the panel performs read-only app discovery, local-server checks and Impeccable readiness checks. Select **Connect and open preview** to start or reuse a development server and connect visual editing. Only servers associated with the selected app are recommended automatically; otherwise select a clearly labeled server or use the secondary action to start another server. It verifies the local HTTP URL before starting Impeccable and opens the ready page in Paseo Desktop's browser. When several apps, package managers, commands or preview URLs are plausible, the panel asks which one to use. Startup exposes **Cancel**. A connected session exposes **Open preview** and separate session/server Stop controls; external development servers cannot be stopped by this plugin. Settings and absolute paths are available above bounded startup output. Output is grouped by attempt and never represents external server logs.

New panels use automatic discovery. App folder, development executable, development arguments, preview URL and Impeccable executable are under **Advanced settings**. Development arguments are a JSON string array, so they are passed as structured arguments rather than parsed as a shell command. Overrides are saved with the panel tab; process ownership is not persisted or reconstructed from saved process IDs.

In a monorepo, the launch directory and preview app can differ. A root command can start the full stack while Impeccable targets a detected web app such as `frontend`. When several web apps qualify, the target choices identify which preview belongs to each launch command.

The plugin owns the long-running listener. Browser requests wake the attached agent; the agent performs the requested work and replies through the installed Impeccable CLI. Starting the plugin does not itself request a redesign. Delivery accepted by Paseo is distinct from work completed by the agent.

### Starting from a new workspace

Impeccable Live currently requires an existing agent session. In Paseo 0.15.4, the **New workspace** composer excludes plugin slash commands, and plugins have no handoff that creates the workspace and agent before opening an agent panel. Switching this plugin's command to workspace context would not resolve that limitation.

Create the workspace and an agent first, then enter `/impeccable-live` in that agent's composer. The workspace can be newly created; the requirement is an available agent and project directory.

Native launch from **New workspace** is blocked on a Paseo API change. See the [implementation plan and pinned upstream evidence](docs/plans/new-workspace-launch.md) for the proposed creation handoff, plugin follow-up and acceptance checks. This flow is not implemented.

## Setup

Requires Paseo app and daemon 0.15.4, Impeccable installed as a local skill with its engine already available, and the application's package manager and dependencies already installed. The first release is pinned below 0.16 pending compatibility checks. The plugin discovers npm, pnpm, Yarn or Bun from project metadata and lockfiles. It blocks Corepack network access and does not run package installation, bootstrap, preparation, publication or deployment commands. Missing tools or dependencies are shown as startup errors rather than installed automatically.

The panel checks the launcher, engine and project setup separately before starting the app. It shows recovery actions for missing installation, engine preparation, project setup and existing helper conflicts. **Check again** reruns discovery after repairs. Connection details show the selected executable and detected engine version; a successful engine identity probe is not a guarantee of Live protocol compatibility or proof that the attached agent can load the skill. Discovery follows the documented directory order, not the attached agent provider; select an explicit launcher if another installation should be used.

### First-time Impeccable setup

Run setup on the **host running Paseo's daemon**, using the coding tool attached to the panel:

1. Follow the [official installation guide](https://impeccable.style/tutorials/getting-started/): run `npx impeccable install`, choose your coding tool and project or global scope, then reload the agent. Installing this Paseo plugin does not install the skill.
2. If the panel finds the launcher but its engine is unavailable, use **Copy engine setup command** and run that command in a terminal on the daemon host. It invokes the selected launcher with `engine-probe`; upstream may download and cache its engine. Panel checks and connection commands suppress that download path. Offline installations should prepare the engine beforehand using upstream's supported preinstalled binary/cache configuration.
3. If project context or Live configuration is missing, use **Copy project setup prompt**, paste it into the attached agent, and let the installed skill guide setup for the selected app. The plugin currently requires nonempty `PRODUCT.md`, `DESIGN.md` and an object-valued `.impeccable/live/config.json`; Impeccable performs its full Live configuration validation at connection. Preserve existing context and follow upstream's CSP consent workflow rather than creating placeholder records.
4. Return to the panel, select **Check again**, then **Connect and open preview**. Setup commands/prompts remain selectable if clipboard access is denied.

Discovery prefers an explicit absolute executable override. Otherwise it searches the preview app and its ancestors through the workspace root for `.agents/skills/impeccable/scripts/impeccable` and `.claude/skills/impeccable/scripts/impeccable`, followed by the personal `.agents`, `.codex` and `.claude` skill directories. Project candidates must resolve within the workspace and are displayed without execution until you select **Use project installation**. This grants the selected launcher the daemon user's normal permissions, just like an explicit executable override; the no-download environment is not a sandbox for arbitrary launchers. Trusted personal installations are probed automatically. **Locate existing installation** opens the executable setting; it does not install anything. Details show which installation was selected.

The plugin does not automatically install, bootstrap, repair or update Impeccable. For updates, follow the installation method's [upstream update instructions](https://impeccable.style/tutorials/getting-started/), then recheck. Impeccable Doctor can change project records and is not used as a readiness probe.

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

**Stop session** stops the owned Impeccable helper and retains the development server for a later resume. **Stop development server** first cleans up the bound helper, then stops only the development process tree started by this integration. A development server reused from outside the plugin is labelled external and is never stopped by either control. Closing the panel does not stop either resource.

Disabling or reloading the plugin cleans its owned helper and development process tree, including startup that is still in progress. A separate guardian completes identity-checked cleanup if the plugin process is interrupted during normal reload. Reload does not silently restart either service. The plugin does not claim cleanup after an operating-system crash or a project command that deliberately detaches itself from the owned process group.

Upstream Impeccable journals retain unfinished work. A development-server crash leaves the helper and any pending event visible; **Connect and open preview** can reconnect on the same or a newly selected local port without automatically resending the event. If delivery is uncertain, inspect the bound agent and upstream status before **Retry event delivery**; retry may duplicate a request whose send was accepted before a transport error. Stopping either service does not cancel a design edit already accepted by the agent. Existing externally started Impeccable helpers remain refused and must be stopped through their owning session.

The browser runs on the client desktop. This release supports local HTTP URLs only and does not tunnel remote development servers or helpers. A web client on the development machine can open an external URL. Phone preview is not supported because loopback addresses refer to the phone itself.

## Verification boundary

Verification results apply to the revisions and environments recorded in the [verification details](docs/verification.md). Earlier showcase checks exposed intermittent backend-fixture JSON reads and a guardian shutdown race; the [submission-readiness follow-up](docs/verification.md#submission-readiness-follow-up-2026-11-12) records their fixes and fresh checks separately. The plugin has loaded in Paseo 0.15.4; its panel, start action, preview opener, and a browser → agent → browser Steer acknowledgement have been exercised. The isolated installed-helper lifecycle also passes. Platform-specific and current development-server automation evidence is recorded separately from unit and facade-backed tests; see [verification details](docs/verification.md). A selected-element variant has also been generated by a real attached agent, accepted, cleaned into source, and verified after helper removal and reload in the isolated static-HTML [library showcase demo](docs/library-video-verification.md).

The repository is public. `package.json` keeps `private: true` to prevent accidental npm publication; this does not prevent installation from GitHub or a local checkout.

## Data and trust

The daemon-side plugin can access local files and processes as its user. It launches the selected existing package-manager script as structured executable arguments and starts the installed Impeccable executable. Development output is bounded, stripped of terminal controls and redacted for common credential forms before it reaches the panel. It does not install software, publish projects or deploy changes. Requests, selected page content and screenshots can reach the configured agent provider. Helper tokens remain server-side and are not package contents.

Helper automation requires a Linux, macOS or FreeBSD development host. These hosts allow the guardian to verify a boot-specific process marker and clean up partial failed starts without adopting unrelated helpers. Other hosts fail readiness before starting a development process or helper. Windows `.cmd` and `.bat` launches are refused; shell interpolation is never used. Windows runtime support is not claimed for this release.
