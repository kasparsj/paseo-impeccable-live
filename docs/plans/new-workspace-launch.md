# Launch Impeccable Live from a new workspace

Status: blocked on a Paseo host API change. No plugin implementation or runtime reload performed.

## Outcome and scope

Offer `/impeccable-live` in Paseo's New workspace composer and in a new-agent draft inside an existing workspace. Submission creates the workspace/agent through Paseo's normal creation flow, then opens the existing agent-bound Live panel. Opening the panel remains read-only discovery; connecting remains an explicit panel action.

Retain the selected host, project, provider, model, agent options and isolation. Preserve the existing-agent slash command and Command Center action. Keep the backend's workspace/agent binding, single-session ownership, app discovery and setup recovery behavior.

This change does not create application scaffolds, install dependencies, start Live automatically, or introduce a separate plugin-owned project/provider creation screen. Global Command Center access is not a substitute for the requested native composer entry point. Adding a draft Command Center action would require its own host context contract; the existing agent action remains in scope for regression checks.

## Verified feasibility

The plugin baseline is `a2484229ccf1886c767d599b4b963511636c6aaa`, branch `feat/impeccable-quick-update`, repository `https://github.com/kasparsj/paseo-impeccable-live`. The checkout was clean at investigation start. Installed SDK and local Paseo CLI are 0.15.4; the manifest requires `>=0.15.4 <0.16.0`. The enabled local plugin points to this checkout and reports `running`.

Local anchors:

- `index.client.tsx:5-14`: agent panel and agent-context entry points.
- `shared/live.ts:14-17`: both workspace and agent IDs are required.
- `server/session.ts:299-309`: discovery requires an available workspace directory and a matching agent.
- `server/live.ts:421-425,551-552`: verify binding and deliver browser requests to that agent.
- Installed `@getpaseo/plugin/dist/client/contracts.d.ts:146-168,278-288`: no composer/new-workspace contribution or draft submission API; slash contexts are workspace/agent only.

Paseo v0.15.4 resolves to `1c00b365c9e0b74c1580eba33d905d693125ae21`. Pinned upstream evidence:

- [New workspace Composer](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/app/src/screens/new-workspace-screen.tsx#L1555-L1584) supplies a draft agent ID but no workspace ID.
- [Plugin command filtering](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/app/src/plugins/client-slash-commands/index.ts#L15-L34) returns no plugin commands without a workspace ID and requires a cached agent for agent-context commands.
- [Existing-workspace agent draft](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/app/src/composer/draft/workspace-tab.tsx#L644-L650) supplies a workspace ID, but no real agent exists yet.
- [Plugin submission interception](https://github.com/getpaseo/paseo/blob/1c00b365c9e0b74c1580eba33d905d693125ae21/packages/app/src/composer/index.tsx#L1457-L1473) consumes a recognized plugin command before normal draft submission. Changing the plugin to workspace context does not create an agent.

The [current plugin reference](https://paseo.sh/docs/plugins/reference.md#composer-items) describes newer composer controls, but these are absent from the pinned SDK, and the documented setters do not provide a create-and-open handoff. Do not upgrade the dependency or widen the manifest based on these docs alone.

## Implementation route

Use direct, sequential implementation after the upstream prerequisite is available. This bounded change does not require Team or a durable goal run.

1. In a Paseo checkout, add an explicit opt-in for an agent-bound plugin command to run from a draft. The exact public field/API name is an upstream design decision, not an existing SDK capability. Keep other agent-bound commands unavailable until an agent exists.
2. Make eligible commands discoverable in both draft surfaces without inventing workspace or agent IDs. Preserve command precedence, host ownership and the existing attachment restriction.
3. On submission, use the host's normal creation path with the selected configuration, without sending the slash command or its arguments as an initial provider prompt. After creation, invoke the plugin with the actual agent/workspace context and its normal `openPanel` capability.
4. Use the host's pending/locking and creation identity mechanisms to prevent duplicate creation. Preserve the draft on failure before creation. If creation succeeds but the plugin callback fails, retain the created workspace/agent and expose a retry against those identities rather than recreating them. An abandoned draft must not open a panel in another host or workspace. Define cancellation at each creation boundary without claiming that completed worktree/setup operations are rolled back.
5. Publish the upstream API contract/types and determine the first compatible app and daemon versions. This plan authorizes no upstream publication or release.
6. In this plugin, adopt the released opt-in on `/impeccable-live` and retain `openPanel("live")`. Pin compatible SDK types and update manifest bounds only after verifying the supported runtime. No backend relaxation is required.
7. Update README and OVERVIEW with the verified new-workspace flow and minimum version. Reload only after typechecking; reload cleans owned resources, so check active session state first.

## Acceptance and verification

| Target | Surface and prerequisite | Required evidence |
| --- | --- | --- |
| VAL-NEW-RECALL | Real New workspace composer on compatible Paseo | `/impeccable-live` appears and submits with a selected project/host/provider; no existing workspace is needed. |
| VAL-NEW-BINDING | Real creation and Live panel | Exactly one workspace and agent are created with selected configuration; panel uses their real IDs; slash text is absent from provider messages. |
| VAL-NEW-DRAFT | Real new-agent draft in existing workspace | Create only the agent in that workspace and open its Live panel. |
| VAL-NEW-RECOVERY | Host tests plus real failure/retry flow | Creation failure preserves usable draft state; callback failure after creation reuses identities on retry; repeated submission cannot duplicate creation; abandonment/cancellation cannot bind another context. |
| VAL-NEW-SETUP | Real Live panel with missing app/setup | Existing actionable setup errors remain visible; opening alone starts no development server or helper. |
| VAL-NEW-REGRESSION | Host routing tests and existing-agent real UI | Existing command and Command Center action still open the correct panel; precedence, attachments and unrelated plugin commands retain their behavior. |
| VAL-NEW-COMPATIBILITY | SDK typecheck, manifest and real desktop/compact UI | Both app and daemon meet the chosen minimum; unsupported versions fail clearly; entry flow remains usable at compact width. |

Add host regression tests around command eligibility and draft creation/submission, plus a plugin registration test for the final opt-in and existing callback. Run `npm run typecheck`, appropriate host checks and targeted plugin tests. Run the broader plugin suite if runtime integration changes justify it. Typechecking, mocked callbacks and `paseo plugin ls` alone do not prove new-workspace behavior.

## Current evidence and limits

Source inspection establishes the host blocker; no runtime behavior has been changed. The plugin's existing `running` state was read back through `paseo plugin ls --json`. Native UI access was available, but concurrent user navigation prevented an isolated new-workspace reproduction; no draft was submitted and no workspace was created. New-flow validation is blocked until the host API exists. No test result should be presented as implementation completion.

## Implementation handoff

- Original issue: this conversation; no canonical GitHub issue supplied or created.
- Inspected baseline: plugin repository/ref/SHA and pinned Paseo source above.
- Intended PR base: plugin `feat/impeccable-quick-update` at the inspected baseline; revalidate if it moves. Upstream Paseo base is unresolved until a checkout and delivery scope are selected.
- Final delivery target: local working implementation in this plugin plus a compatible Paseo runtime. Remote landing branches, publication, merging and deployment are outside this local delivery.
- Decisions: preserve native creation UX and existing backend binding; do not substitute a custom creation screen or a workspace-context command. Upstream API shape and first compatible version remain prerequisites.
- Acceptance: the seven targets above must pass before calling this fixed. Continue with `$implement-plan docs/plans/new-workspace-launch.md --local` when the host prerequisite is available; recheck feasibility first.
