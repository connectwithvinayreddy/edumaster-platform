# Video Watch Limit Fix Prompt

## Problem summary

We need to fix secure lesson video replay behavior for protected course videos.

Current user-reported issues:

1. After a learner completes the first full watch, reopening the lesson starts near the end again instead of restarting from `0`.
2. After the learner completes the second full watch, the system should block any further playback, but access is still being allowed in some cases.
3. Seeking to the end or landing a few seconds before the end can create confusing behavior around completion, replay count, and resume position.
4. The current implementation mixes two different systems:
   - secure playback watch-state tracking in `backend/lib/video-watch-limits.js`
   - lesson progress resume state in `watch_history.progress_seconds`

This causes inconsistent behavior between:

- resume position
- completed watch count
- replay limit enforcement
- UI state

## Current root causes

### 1. Resume position is taken from lesson progress, not watch-cycle state

Protected lesson playback currently returns:

- `resumeSeconds: Number(lessonProgress?.progressSeconds || 0)`

This means if the learner watched to `20:00 / 20:07`, the next open can resume at about `20:00`, even if the previous watch should be considered fully completed and the next replay should restart from `0`.

### 2. Completion counting and resume behavior are not using one source of truth

There is already a chunk-based backend watch-limit engine in:

- `backend/lib/video-watch-limits.js`

It tracks:

- `completedFullWatches`
- `watchedSegments`
- `lastPositionSeconds`
- `revisionBufferUsedSeconds`
- `isLocked`

But player bootstrap/resume still depends on watch-history progress instead of a replay-cycle-aware resume rule.

### 3. Replay completion is being interpreted differently in multiple places

There is also a separate completion aggregator in:

- `backend/workers/watch-aggregator.cjs`

That can increment watch counts using `watchSeconds >= threshold`.

The system needs one clear rule for:

- what counts as one completed watch
- when the next replay should restart from `0`
- when the user should be blocked entirely

## Required target behavior

Use these rules as the expected product behavior.

### Rule A: Incomplete watch resumes from last valid position

If the learner has not yet completed the current watch cycle:

- reopening the video should resume from the last valid tracked position
- small seek-back or buffering differences are acceptable

### Rule B: Completed watch resets next replay to the beginning

As soon as a full watch is completed:

- increment `completedFullWatches` by `1`
- clear current-cycle resume position for the next watch
- the next allowed replay must start from `0`

Example:

- first full watch completed -> `completedFullWatches = 1`
- next open should return `resumeSeconds = 0`

### Rule C: Second completed full watch blocks future playback

For course videos:

- allowed completed full watches = `2`

Behavior:

- after first full completion: allow another replay, starting at `0`
- after second full completion: block further playback

If the product still wants a tiny post-limit grace window, it must be explicitly defined and enforced consistently. Otherwise:

- after second full completion, deny access immediately

### Rule D: Seek-to-end must not create fake watch completions

If the learner jumps from early in the video to near the end:

- this must not count as a completed watch
- it must not unlock the next watch cycle
- it must not consume a full replay count

### Rule E: Near-end reopen after full completion must not happen

If a full watch was already completed, the next allowed replay must not reopen at:

- `duration - 7 seconds`
- `duration - 5 seconds`
- any near-end value from old progress history

It must reopen from:

- `0`

## Implementation direction

Implement the fix with a single source of truth for protected lesson replay state.

### Backend requirements

1. Define replay resume position from secure watch state, not from `watch_history.progress_seconds`.
2. Add a replay-aware resume resolver for protected videos:
   - if current watch cycle is incomplete, resume from `lastPositionSeconds`
   - if a full watch cycle was just completed and another replay is still allowed, resume from `0`
   - if the allowed full watch limit is exhausted, reject playback
3. Make completion-state transitions explicit:
   - when `currentCycleUniqueWatchedSeconds >= fullWatchThresholdSeconds`
   - increment `completedFullWatches`
   - clear `watchedSegments`
   - clear `currentCycleUniqueWatchedSeconds`
   - reset `lastPositionSeconds` to `0` for the next watch cycle
4. Ensure any fallback progress-based resume path for protected videos does not override the secure replay resume decision.
5. Make post-limit behavior deterministic:
   - if `completedFullWatches >= allowedFullWatches`, block playback
   - do not rely on stale `watch_history.progress_seconds`
6. Review whether `revisionBufferSeconds` should exist for course video replays at all.
   - If business rule is “exactly 2 full watches only,” remove or bypass revision buffer for protected course lesson replay enforcement.
   - If business rule is “2 full watches + limited tail grace,” document that precisely and test it precisely.

### Frontend requirements

1. Do not set protected video player resume position directly from stale lesson progress for replay cycles.
2. Respect backend-provided `resumeSeconds` as the source of truth for protected lesson playback.
3. After a completed replay, reopening the lesson should start from `0` when backend allows another watch.
4. If backend blocks playback after limit reached, show a clear message such as:
   - `Maximum lesson video rewatch limit reached.`

## Acceptance criteria

### Scenario 1: First full watch

Given:

- learner opens protected lesson video for the first time

When:

- learner watches enough real coverage to satisfy the completion threshold

Then:

- `completedFullWatches = 1`
- next open is allowed
- next open returns `resumeSeconds = 0`

### Scenario 2: Second full watch

Given:

- learner already has `completedFullWatches = 1`

When:

- learner watches the second full replay to completion

Then:

- `completedFullWatches = 2`
- next open is denied
- playback does not start near the end from stale progress

### Scenario 3: Forward seek abuse

Given:

- learner opens the lesson at the beginning

When:

- learner seeks from early in the video to near the end

Then:

- no full watch is counted
- no replay count is consumed as completed
- no new replay cycle starts

### Scenario 4: Incomplete replay resume

Given:

- learner watched only part of the current replay cycle

When:

- learner closes and reopens the lesson

Then:

- playback resumes from the tracked partial position
- not from `0`
- not from a stale older position from a previous completed cycle

### Scenario 5: Completed-cycle restart

Given:

- learner completed one full watch

When:

- learner opens the lesson again

Then:

- playback starts from `0`
- not from `duration - 7`
- not from the previous completed cycle’s last position

## Required backend tests

Add or update tests in:

- `backend/__tests__/video-watch-limits.test.cjs`

### New tests to add

1. `completed first watch resets next replay resume to zero`
   - simulate first full watch completion
   - assert `completedFullWatches === 1`
   - assert next replay resume decision is `0`

2. `second completed watch blocks next playback request`
   - simulate two full completions
   - assert third open throws `VIDEO_WATCH_LIMIT_REACHED`

3. `incomplete cycle resumes from last tracked position`
   - simulate partial watch only
   - assert resume position equals partial position

4. `seek to near end does not count as completion`
   - simulate large forward jump
   - assert completion count unchanged
   - assert next open is not treated as a new cycle

5. `completed-cycle stale progress does not override zero resume`
   - set `watch_history.progress_seconds = duration - 7`
   - set secure watch state to `completedFullWatches = 1`, next cycle not started
   - assert returned protected playback `resumeSeconds === 0`

6. `blocked user cannot reopen from stale progress`
   - set `completedFullWatches = 2`
   - set `watch_history.progress_seconds = duration - 7`
   - assert playback request is rejected

7. `backward seek does not create extra completion credit`
   - partial watch
   - seek backward
   - finish normally
   - assert exactly one completion

8. `reopening multiple times before completion does not increment watch count`
   - open
   - watch partial
   - close
   - reopen
   - close
   - reopen
   - assert completion count still `0`

## Required integration tests

Add integration coverage around the protected lesson player endpoint.

Suggested cases:

1. First open returns `resumeSeconds = 0`
2. Partial watch heartbeat updates cause next open to return partial resume
3. First full completion causes next open to return `resumeSeconds = 0`
4. Second full completion causes next open to fail with watch-limit error
5. Stale lesson progress near the end does not override replay-cycle reset

## Important design decision to make explicit

Before implementation, choose one of these and encode it in tests:

### Option A: Strict rule

- course protected video = exactly 2 completed watches
- after second completion, no more playback at all
- no revision buffer

### Option B: Soft rule

- course protected video = 2 completed watches
- then allow only a small defined revision buffer
- example: 30 seconds total across all later opens

If the business rule is what the user described, choose **Option A**.

## Recommended implementation prompt

Use this prompt for the engineering pass:

```text
Fix protected lesson replay enforcement so secure course videos behave like a strict two-completed-watch system.

Requirements:

1. Use the secure watch-state system as the source of truth for protected lesson replay state.
2. For protected lesson playback, do not derive resumeSeconds from watch_history.progress_seconds when deciding replay-cycle resume behavior.
3. If the learner has an incomplete current replay cycle, resume from the secure watch state's last valid partial position.
4. If the learner completed one full watch, the next allowed replay must start from 0.
5. If the learner completed two full watches, block the next playback request with VIDEO_WATCH_LIMIT_REACHED.
6. Seeking forward to the end or near the end must never count as a completed watch.
7. Stale progress values near the end of the video must not cause reopen-at-end behavior after a completed replay cycle.
8. If revisionBufferSeconds currently allows access after two completed course-video watches, remove or bypass that behavior for protected course lesson replays unless explicitly required by product.

Implementation tasks:

- Add a backend helper that resolves protected replay resumeSeconds from secure watch state.
- Update the protected lesson player response to use that helper.
- Reset replay-cycle resume to 0 after each completed full watch.
- Enforce blocking after the second completed full watch for course protected videos.
- Keep partial-progress resume working for incomplete cycles.
- Add backend unit tests and protected-player integration tests covering:
  - partial resume
  - first completion then restart at 0
  - second completion then blocked
  - seek-forward abuse
  - stale near-end lesson progress not overriding secure replay-cycle reset

Success criteria:

- first completed watch => count 1, next replay starts at 0
- second completed watch => count 2, next replay blocked
- near-end stale progress never reopens completed replay from 7 seconds before the end
- forward-seek-to-end does not count as a completed watch
```

