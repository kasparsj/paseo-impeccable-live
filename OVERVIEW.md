# Impeccable Live

A panel for starting Impeccable Live in a local web project. Open it from an agent with `/impeccable-live` or the Command Center action **Open Impeccable Live**, then select **Connect and open preview**. Opening the panel checks the app, local servers and helper readiness without starting processes. Connection starts or reuses the selected development server, verifies its local URL, starts Impeccable and opens the preview in Paseo Desktop. Servers without an established app association require an explicit choice. Startup can be canceled; connected sessions offer **Open preview**.

Impeccable supplies element picking, visual variants and annotations. The plugin listens for browser requests in the background and sends them to the agent attached to the panel, so the chat does not need to stay in a polling turn. Advanced settings contain app, executable, structured JSON arguments, URL and Impeccable executable overrides.

Requires Paseo 0.15.4, an installed Impeccable CLI and engine, existing Product/Design and Live configuration, and the app's package manager and dependencies already installed. The plugin does not install or bootstrap dependencies; Corepack network access is blocked. Preview remains local HTTP on the development machine. A same-machine web client can use an external link. Phone preview and remote forwarding are not included.

**Stop session** removes the owned Impeccable helper while retaining the app server. **Stop development server** also stops only the process tree this integration started. Reused external servers are never stopped. Reload cleans owned resources even when startup is in progress. Development-server recovery retains Impeccable's pending-event state; uncertain delivery still requires an explicit retry, which may duplicate accepted work.

The plugin changes project HTML through Impeccable's injection and cleanup commands. Design requests and their context are sent to the configured agent provider. It does not install software, publish projects or deploy changes. Impeccable's Live Mode is beta.
