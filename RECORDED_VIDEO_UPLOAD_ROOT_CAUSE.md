# Recorded Video Upload Root Cause

## Root cause

Production had a split recorded-video pipeline:

- `CLOUDFLARE_STREAM_*` credentials were fully configured
- but `VIDEO_PROCESSING_PROVIDER=local-hls`
- and `VIDEO_DELIVERY_PROFILE=r2-private-hls`

That meant admin uploads did **not** use Cloudflare Stream in production, even though the UI and some lesson metadata still referenced Cloudflare encoding. The result was confusing status text, mixed provider labels, and repeated false alarms where local private-HLS processing looked like a broken Cloudflare upload.

## What was fixed

1. Production provider alignment
   - `VIDEO_PROCESSING_PROVIDER=cloudflare-stream`
   - `VIDEO_DELIVERY_PROFILE=cloudflare-stream`
   - `CLOUDFLARE_STREAM_STATUS_POLL_INITIAL_DELAY_MS=5000`

2. Backend response clarity
   - Upload responses now return the actual processing provider.
   - Local HLS uploads now say they are waiting on private adaptive HLS packaging.
   - Cloudflare uploads continue to say they are waiting on Cloudflare Stream encoding.

3. Admin UI clarity
   - Removed Cloudflare-only wording from generic processing banners.
   - Admin cards now show a provider-aware pipeline label.
   - Processing notices now describe the real active pipeline for each uploaded topic.

4. Config diagnostics
   - Production warnings now explicitly call out the case where Cloudflare credentials are present but inactive because `VIDEO_PROCESSING_PROVIDER` is not `cloudflare-stream`.
   - Production warnings now call out a mismatched `VIDEO_DELIVERY_PROFILE` when Cloudflare is active.

## Expected behavior after fix

- Admin uploads go through Cloudflare Stream in production.
- Uploaded topics stay hidden until Cloudflare marks them ready.
- Admin UI messaging matches the actual provider in use.
- Production health output clearly exposes pipeline misconfiguration before it becomes a user-facing issue.
