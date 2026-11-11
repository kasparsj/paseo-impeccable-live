# VAL-START
Surface: background CLI.
Needs: Validated preflight.
Behavior: Serialize starts; repeated start with identical config reuses only plugin-owned run; changed config is refused until stopped. Refuse any preexisting helper. Capture helper PID/port/token from boot; these are ownership identity, never returned to UI.
Evidence: Real helper start/status; collision and concurrent-start traces.
