# Impeccable Live

A panel for starting and stopping Impeccable Live in a local web project. Open it from an agent with `/impeccable-live` or the Command Center action **Open Impeccable Live**.

The panel opens your running app in Paseo's desktop browser. Impeccable supplies element picking, visual variants and annotations. The plugin listens for browser requests in the background and sends them to the agent attached to the panel, so the chat does not need to stay in a polling turn.

Requires Paseo 0.15.4, an installed Impeccable CLI, an existing Product/Design record and Live configuration, and a running local development server. Start the development server separately. A web client on the same development machine can use an external link. Phone preview and remote preview forwarding are not included.

The plugin starts local helper processes and changes the project's HTML through Impeccable's injection and cleanup commands. Design requests and their context are sent to the configured agent provider. It does not install Impeccable, publish projects, or deploy changes. Impeccable's Live Mode is beta. A failed or uncertain event delivery pauses the listener; check the agent before retrying to avoid duplicate work.
