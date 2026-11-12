# Plugin library video ideas

## Working brief

Audience assumption: developers already using Paseo who want a smoother way to refine a local web app with Impeccable. Desired outcome: viewers understand the plugin's value and want to try it. Lead with the result, then demonstrate the connection between preview and agent. Treat this as a short product demonstration, not an installation tutorial.

Library duration, aspect ratio, file size and audio requirements have not been supplied. The durations below are creative proposals, not submission requirements.

## Fifteen starting ideas

### Product manager perspective

1. **From preview to improvement:** one visible UI problem, one visual request, one improved result.
2. **Your existing app, ready to edit:** open the panel, connect, and land in the working preview.
3. **Stay in Paseo:** show the preview and attached agent together throughout a design iteration.
4. **Another pass:** follow a first change with a precise refinement, emphasizing an iterative workflow.
5. **Fits your running project:** connect to an existing development server and begin work.

### Product designer perspective

1. **One small, satisfying fix:** correct a cramped card, weak hierarchy or awkward spacing, with a legible before/after.
2. **Point, describe, watch:** follow the cursor from an element to a short visual instruction and its result.
3. **A quiet walkthrough:** clean screen recording, deliberate cursor movement, short captions, minimal visual clutter.
4. **Before/after opening:** start with the outcome comparison, then replay how it happened.
5. **Make it feel finished:** show two or three coherent refinements to the same component rather than unrelated transformations.

### Software engineer perspective

1. **Close the loop:** show the visual request reaching the agent and the resulting application change.
2. **Changes that stick:** after a successful edit, reload the page and briefly show the actual source diff.
3. **One panel handles startup:** demonstrate discovery, connection and automatic preview opening.
4. **Pause and resume:** stop the visual session, retain the server, then reconnect.
5. **A real monorepo:** show a root launch command opening the intended frontend preview.

## Ranked top five

Ranked by relevance to the audience, clarity of the benefit, recording effort, and how clearly each demonstrates the integration's contribution. These are judgments to validate, not measured conversion predictions.

| Rank | Concept | Description | Why selected | Assumptions to validate |
| --- | --- | --- | --- | --- |
| 1 | Point → request → result | Select a visible UI element, request a focused improvement, and show the changed preview with the attached agent. | Combines a satisfying outcome with a clear explanation of how the integration works. Moderate production effort. | The full edit loop works reliably; viewers can follow the selection and result at the chosen crop. |
| 2 | From panel to live preview | Open Impeccable Live, connect, and arrive in the local preview. | Shows the plugin's own contribution clearly and is comparatively easy to record. | Reduced setup friction is compelling to the intended audience; demo prerequisites are prepared. |
| 3 | One more refinement | Make a first improvement, then a second precise adjustment in the same session. | Communicates collaboration and control instead of a single lucky generation. Higher rehearsal effort. | Follow-up edits preserve the first change; two results remain understandable in a short clip. |
| 4 | Changes that stick | Show before/after, reload the page, then briefly show the source change. | Gives technical viewers concrete evidence that the result belongs to their app. | The demonstrated flow really persists the change to source; the diff is small and readable. |
| 5 | Already running? Connect | Start with an existing local server, connect through the plugin, and open the editing preview. | Addresses a practical existing-project scenario with little setup footage. | The supported server choice is easy to explain visually; this matters enough to justify screen time. |

## Recommended first video: a 50–65 second hybrid

Use concept 1 as the story and concept 2 as its introduction. Incorporate concept 4 only after verifying source persistence. One component and one improvement are enough.

| Time | Picture/action | Suggested caption |
| --- | --- | --- |
| 0–4 s | Clear before/after of the same component, captured from a real successful run. | “Refine your UI from inside Paseo.” |
| 4–12 s | Open the plugin panel and choose Connect and open preview. | “Connect your local app.” |
| 12–22 s | In the preview, select one element and enter a focused request using the installed Impeccable controls. | “Point at what needs work.” |
| 22–32 s | Show the request appearing in the attached Paseo agent and the agent working. Shorten the wait with an explicit edit. | “The request reaches your agent.” / “Waiting shortened” |
| 32–47 s | Return to the changed component, with matching framing for comparison. | “Review the result in the live preview.” |
| 47–55 s | If validated: reload and briefly show the resulting source diff. Otherwise, hold on the visible result. | “Changes in your app.” only if demonstrated |
| 55–65 s | Hold on the result with the plugin name and a clear end card. | “Impeccable Live for Paseo” / “Community integration” |

Example demo subject: an event card with cramped spacing, weak date hierarchy and an easily overlooked primary action. Example request: “Give the date a clear hierarchy, add breathing room, and make the primary action easier to find. Keep the existing colors and copy.” Use a prepared, intentionally modest starting design so the improvement is obvious without suggesting the plugin supplies the agent's design ability.

## How to create it

1. **Prepare a dedicated demo app or branch.** Use fictional content and a small page you control. Have dependencies, Product/Design records and Impeccable configuration ready before recording. Keep the source changes isolated and easy to reset.
2. **Rehearse the entire loop.** Connect, make the request, let the agent finish, inspect the result, and verify any persistence claim by reloading and checking source. Existing repository evidence establishes launch and communication; it does not establish a completed accepted-source design variant.
3. **Arrange Paseo for legibility.** Use one theme, a readable UI scale and a focused workspace. Show the preview and agent together when possible. Avoid unrelated sessions, notifications, private paths and credentials in the capture.
4. **Record real interactions.** A desktop screen recorder is sufficient. Capture at a resolution that supports the final export, keeping essential actions centrally framed if later crops are needed. Record the before and after at exactly the same viewport and scroll position.
5. **Capture in short sections.** Record connection, selection/request, agent activity and result separately if necessary. Keep them from the same coherent run. Save a longer continuous recording as reference so edits preserve the actual sequence.
6. **Edit for comprehension.** Cut idle time, label shortened waits, add brief captions and use occasional restrained zooms. Do not imply instantaneous generation. Show enough agent activity to explain the integration, without filling the screen with unreadable logs.
7. **Make it work without sound.** Captions should carry the story. Optional narration can explain the value in plain language. Music and synthetic visuals are unnecessary for the first version.
8. **Export to the actual library requirements.** Check duration, aspect ratio, codec, size, audio and upload/link rules when the destination is known. Keep an editable master for alternate exports.
9. **Check the final clip.** Watch at its likely embedded size and muted. Ask a viewer to explain what the plugin does and what action they would take next. If the benefit is unclear, simplify the clip before adding more features.

## Lower-effort fallback

If the full design edit is unreliable during rehearsal, publish a truthful 20–30 second connection walkthrough: panel → Connect → preview → real browser-to-agent acknowledgement. Describe the demonstrated result as connection and communication. Save the transformation story for a successfully verified edit.

## Evidence used

- `README.md`: product scope, prerequisites, desktop/local HTTP boundaries and current verification summary.
- `docs/verification.md`: actual preview and Steer acknowledgement; accepted-source design variant remains unverified.
- `docs/development-server-verification.md`: installed-host startup, automatic preview and server reuse evidence.
- `docs/panel-ux-verification.md`: current panel wording, connection controls and desktop visual checks.

This brainstorm involved repository reading only. No app edits, recording, publishing or new runtime validation were performed.
