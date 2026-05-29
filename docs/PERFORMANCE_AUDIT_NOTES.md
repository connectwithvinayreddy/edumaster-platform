# Performance Audit Notes

## Git snapshot

- Current pushed commit: `f6958a1`
- Remote: `origin/main`

## High-confidence bottlenecks

### 1. Monolithic frontend bundle

- Current production bundle includes a single large JS asset around `3.5 MB`.
- The app eagerly imports major workspaces into the root shell:
  - `src/App.tsx`
  - `src/components/CourseFigmaTab.tsx`
  - `src/components/CoursesTab.tsx`
  - `src/components/TestSeriesFigmaTab.tsx`
  - `src/components/LiveClassesFigmaTab.tsx`
- No meaningful route-level code splitting is present for the main student/admin workspaces.

### 2. Oversized root shell

- `src/App.tsx` is about `8.7k` lines.
- `src/components/CourseFigmaTab.tsx` is about `5.9k` lines.
- `src/components/CoursesTab.tsx` is about `3.6k` lines.
- `src/components/TestSeriesFigmaTab.tsx` is about `3.6k` lines.

This makes parse time, hydration time, and rerender scope larger than necessary.

### 3. Overview endpoint is too broad and refreshed too often

- `src/App.tsx` refreshes the full platform overview every `20 seconds`.
- `backend/platform/platform.controller.js` returns `platformRepository.getOverview(userId)`.
- `backend/lib/repositories.js#getOverview` loads and assembles:
  - all visible courses
  - all tests for attempt
  - live classes
  - subscriptions
  - notifications
  - analytics
  - session activity
  - admin analytics for admins

This is a wide payload and it causes broad rerenders because the entire `overview` object is replaced.

### 4. Repeated screen-local polling and timers

- `src/App.tsx` has a global `20s` overview refresh loop.
- `src/components/AdminVideoUpload.tsx` polls every `5s` while processing exists.
- `src/components/OverviewFigmaTab.tsx` runs a `5s` mobile carousel interval.
- `src/components/TestSeriesFigmaTab.tsx` runs a `1s` exam timer and multiple persistence effects.
- `src/components/CoursesTab.tsx` has many playback, retry, progress, security, and inspection timers/effects.

Individually these are understandable, but together they raise background work and rerender frequency.

### 5. Course player screen has too much responsibility

- `src/components/CoursesTab.tsx` combines:
  - course catalog
  - filtering
  - lesson list logic
  - protected playback fetch
  - prefetching
  - resume cache
  - progress sync
  - HLS setup
  - fullscreen
  - live recording access
  - anti-capture / devtools checks

This increases the chance that unrelated state changes rerender the whole screen.

### 6. Test screen keeps a lot of synchronous state in one tree

- `src/components/TestSeriesFigmaTab.tsx` manages:
  - catalog
  - detail state
  - resume draft storage
  - submitted attempts
  - exam session timer
  - question palette
  - result and solution flows

The current design is feature-rich but high-churn.

### 7. Backend overview assembly likely over-fetches

- `platformRepository.getOverview()` builds a rich aggregate view every time.
- This is convenient for UI development, but expensive for:
  - overview tab
  - courses tab
  - tests tab
  - live tab
  - admin dashboard

The current response shape encourages one huge refresh rather than domain-specific fetching.

## Practical optimization priorities

1. Split the app shell into lazy-loaded workspace chunks.
2. Break the overview API into smaller, cacheable domain endpoints.
3. Stop refreshing the whole overview object every 20 seconds.
4. Isolate high-churn player/test state from catalog/shell rendering.
5. Add list virtualization or incremental rendering where lesson/test/admin lists grow.
6. Add backend pagination and selective field loading for admin and catalog data.

## Areas most likely to produce visible speed gains

- initial app load
- tab switch latency
- overview refresh smoothness
- courses/player state changes
- test series exam interactions
- admin CRUD list refreshes
