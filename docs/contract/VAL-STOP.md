# VAL-STOP
Surface: CLI/filesystem.
Needs: Owned run.
Behavior: Abort poll then revalidate current helper PID/port/token before stop; refuse replaced helper. Stop removes owned injection. Unload awaits cleanup. Stop during startup waits for serialized startup then cleanup; foreign helpers remain untouched.
Evidence: Fixture race/replacement/unload traces plus real helper injection before/after.
