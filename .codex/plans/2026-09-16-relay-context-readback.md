# Relay required-context readback

Owner: relay PR #30, review finding 4027432504.

Require the readback legacy contexts array to equal the API projection of the
single configured App-bound check. Reject extra, missing, empty, duplicate or
malformed projection values; never silently bless a configuration that can stall
all merges. Preserve every existing producer, review and administrator check.

Verify the five added negative cases plus the complete admission suite. This
repairs diagnostic configuration verification only; synchronous governor
activation and protected canaries remain separately required.
