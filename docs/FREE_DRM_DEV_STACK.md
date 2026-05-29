# Free DRM-Like Dev Stack

## Goal

Get the strongest low-cost video protection this repo can realistically support without paying for a commercial DRM platform right now.

## What is already in this repo

- Shaka-based DRM-capable playback path for protected manifests in the web player
- Android `FLAG_SECURE` support for black screenshots at the app-window level
- iOS recording and background blackout handling
- signed protected playback URLs
- moving watermark support in protected video playback
- single-session style account protection

## What you can do for free

### 1. Use Shaka Player for DRM-capable web playback

This repo already has `shaka-player` installed and wired for protected manifests.

Why it helps:

- supports encrypted media playback APIs in browsers
- works for DASH and HLS flows depending on platform
- gives us the right player foundation for future DRM upgrades

Official source:

- https://github.com/shaka-project/shaka-player

### 2. Package adaptive video for free

Use:

- `ffmpeg`
- `Bento4`

This is enough to generate an adaptive video ladder for testing and delivery.

This repo now includes:

- [scripts/package-free-video-ladder.sh](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/scripts/package-free-video-ladder.sh)

Example:

```bash
./scripts/package-free-video-ladder.sh ./uploads/lesson.mp4 ./tmp/lesson-cmaf
```

That produces:

- `stream.mpd`
- `master.m3u8`

Official sources:

- https://www.bento4.com/
- https://ffmpeg.org/

### 3. Test DRM playback with public test vectors

For development only, use official public DRM test vectors such as Axinom’s.

These are useful for:

- validating that Shaka playback works
- validating key-system negotiation
- validating that protected playback paths open in supported browsers

They are not a replacement for your own production DRM setup.

Official source:

- https://docs.axinom.com/general/tools/test-vectors

### 4. Keep Android screenshot blocking enabled

This remains your strongest free protection for the full Android app.

Official sources:

- https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_SECURE
- https://developer.android.com/security/fraud-prevention/activities

### 5. Keep iOS capture blackout enabled

iOS can react strongly to recording and mirroring, but cannot fully stop the first screenshot.

Official sources:

- https://developer.apple.com/documentation/uikit/uiscreen/captureddidchangenotification
- https://developer.apple.com/documentation/uikit/uiapplication/userdidtakescreenshotnotification

### 6. Keep signed URLs and watermarking

These are the most important zero-budget protections after native screenshot blocking.

Use:

- short-lived playback URLs
- user-tied watermark text
- one-session access controls

## Important limit

This free stack is useful, but it is not full production DRM for your own catalog.

Without a real DRM provider or your own licensed infrastructure, you do not get:

- production Widevine license service for your content
- production FairPlay credentials for your content
- enterprise multi-DRM license servers

What you do get:

- adaptive streaming
- stronger player plumbing
- dev-time DRM playback testing
- much stronger Android protection
- harder casual copying and sharing

## Recommended low-budget path

### Right now

1. Keep using Android `FLAG_SECURE`
2. Keep iOS blackout handling
3. Use signed URLs everywhere
4. Use watermark overlays on protected lessons
5. Package lessons as adaptive HLS/DASH

### For testing

1. Run the local packaging helper
2. Validate Shaka playback with public DRM test vectors
3. Verify Android screenshot blocking on real devices

### Later, when budget exists

Add:

- real Widevine / FairPlay / PlayReady license service
- encrypted packaging bound to your own keys and licenses

## Repo notes

If you want to experiment with protected manifest playback in this repo later, the relevant config lives in:

- [.env.example](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/.env.example)
- [backend/lib/config.js](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/backend/lib/config.js)
- [backend/lib/repositories.js](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/backend/lib/repositories.js)
- [src/components/ResilientHlsVideo.tsx](/Users/anudeepreddypolu/Downloads/remix_-edumaster_-ssc-&-rrb-je-prep-platform/src/components/ResilientHlsVideo.tsx)

Use this document as a practical guide for the free path, not as a guarantee of Netflix-style protection for every browser and every screen.
