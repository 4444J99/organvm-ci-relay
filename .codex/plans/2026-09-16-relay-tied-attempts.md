# Resolve tied workflow attempts without inventing temporal order

Owner: relay PR #30, review finding 4027757996. Equal-resolution timestamps
cannot order reruns by creation ID. Evaluate all attempts at the latest start
time; admission requires each one to pass existing identity, job, step and
current-base checkout proof. Any failed/pending attempt prevents admission.
Sort tied IDs only for deterministic receipt selection and retain each accepted
run/attempt and checkout proof in the result. Older timestamps remain superseded.

Verification: all 77 admission/enforcement tests pass on Node 22.23.2,
including reversed history, failed/pending lower-ID reruns and a second tied
success with stale checkout evidence. No live governance activation is claimed.
