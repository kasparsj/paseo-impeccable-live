# VAL-POLL
Surface: background process.
Needs: Owned helper.
Behavior: Exactly one live-poll process per run; timeout repolls, exit ends run, nonzero/malformed output exposes error. Plugin owns polling; agent turns do not wait for browser input.
Evidence: Real child-process protocol fixtures for timeout/event/exit/error and cancellation.
