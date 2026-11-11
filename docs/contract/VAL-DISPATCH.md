# VAL-DISPATCH
Surface: agent API.
Needs: Validated binding and polled event.
Behavior: Send event plus exact IDs and reply instructions to only the bound agent. Busy agents may queue. Send acceptance means delivered, never completed. Failed or uncertain send pauses polling and retains event; explicit retry warns that prior delivery may have succeeded and can duplicate work. No automatic retry. Preserve Impeccable delivery acknowledgements and pending carbonize/live-complete gates.
Evidence: Dispatch capture, error/uncertain/retry integration; no claim of source completion from send.
