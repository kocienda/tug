# Upload retries

Harbor's uploader talks to a storage service that sheds load by answering 503 for a few seconds at a time.

## What we decided

A failed part is sent again after a capped exponential wait with full jitter: the wait doubles from one second and stops growing at thirty. Five attempts is the limit, after which the part is parked in the local queue and the person sees it as paused, never as lost.

## What we set aside

A fixed interval was rejected, because every client that lost its connection at the same moment would come back at the same moment.

## Where it lives

`src/upload/backoff.rs` holds the wait, and `src/upload/queue.rs` holds the parking.
