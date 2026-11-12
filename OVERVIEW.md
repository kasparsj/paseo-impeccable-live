# Impeccable Live

A panel for starting Impeccable Live in a local web project. Open it from an agent with `/impeccable-live` or the Command Center action **Open Impeccable Live**, then select **Connect and open preview**. Opening the panel checks the app, local servers and helper readiness without starting processes. Connection starts or reuses the selected development server, verifies its local URL, starts Impeccable and opens the preview in Paseo Desktop. Servers without an established app association require an explicit choice. Startup can be canceled; connected sessions offer **Open preview**.

Impeccable supplies element picking, visual variants and annotations. The plugin listens for browser requests in the background and sends them to the agent attached to the panel, so the chat does not need to stay in a polling turn. Advanced settings contain app, executable, structured JSON arguments, URL and Impeccable executable overrides.

Requires Paseo app and daemon versions 0.15.4 or later in the 0.15 series. Helper automation requires a Linux, macOS or FreeBSD development host, an installed Impeccable CLI and engine, existing Product/Design and Live configuration, and the app's package manager and dependencies already installed. The plugin does not install or bootstrap dependencies; Corepack network access is blocked. Preview remains local HTTP on the development machine. A same-machine web client can use an external link. Phone preview and remote forwarding are not included.

Each plugin installation supports one active workspace and agent at a time. Stop both the session and its development server before switching to another workspace or agent.

**Stop session** removes the owned Impeccable helper while retaining the app server. **Stop development server** also stops only the process tree this integration started. Reused external servers are never stopped. Reload cleans owned resources even when startup is in progress. Development-server recovery retains Impeccable's pending-event state; uncertain delivery still requires an explicit retry, which may duplicate accepted work.

The plugin changes project HTML through Impeccable's injection and cleanup commands. Design requests, selected page content and screenshots can be sent to the configured agent provider. It does not install software, publish projects or deploy changes. Impeccable's Live Mode is beta.
