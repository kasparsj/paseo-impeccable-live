# Live panel UX follow-up

Base: PR #1 verified open at `71d49d69d7b14cb900ca22ed48e7a2546cc6b1f8`.
Local branch: `feat/live-panel-ux-follow-up`. No publication or PR changes.

Surface mode: Operate. Preserve Paseo theme tokens, native controls and existing Impeccable lifecycle.

1. Add read-only panel discovery and readiness checks. Opening never launches a server or helper; only associated responders may be reused automatically after explicit connection. Unassociated responders require a labeled choice. Check regression coverage for inspection, selection and ownership.
2. Reduce the panel to idle, discovering, selection, starting, connected and error views. Show one primary action; put the app and URL first, settings/details above bounded logs, and retain separate session/server stops. Check state mapping, override validation, retry versus recheck copy and log provenance.
3. Apply Impeccable distill/clarify, then polish. Check keyboard focus, field errors, narrow layouts and both themes using the rendered Paseo panel.
4. Run existing typecheck/tests without installing dependencies. Use isolated fixtures for startup, cancellation and failures. Have a fresh native Codex reviewer inspect the final diff; fix findings and repeat affected checks.

Acceptance: existing event IDs, pending-event gates, monorepo launch/preview split, ownership, cancellation and reload cleanup remain covered. Runtime evidence records exact exercised scenarios and any gaps; active user sessions remain untouched.
