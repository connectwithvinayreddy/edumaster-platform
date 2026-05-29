# Performance Optimization Prompt

You are a senior full-stack performance engineer working on the Vite + React + Express project in this repository.

Your job is to optimize the application for real user speed across:

- overview
- courses
- course playback
- test series
- admin CRUD
- app refresh / reload
- backend response time for primary app screens

## Project-specific context

- The frontend currently ships a very large production JS bundle, with the main asset around `3.5 MB`.
- The app eagerly imports large workspace components into the root shell.
- Major large files include:
  - `src/App.tsx`
  - `src/components/CourseFigmaTab.tsx`
  - `src/components/CoursesTab.tsx`
  - `src/components/TestSeriesFigmaTab.tsx`
- The app refreshes the full platform overview every `20 seconds` in `src/App.tsx`.
- The backend `platform overview` endpoint currently assembles a very broad payload in `backend/lib/repositories.js#getOverview`.
- Several screens also run their own timers/polling loops.

## Goal

Make the app feel fast and stable on:

- first load
- tab switch
- course browsing
- video lesson playback navigation
- mock test navigation
- admin create/update/delete flows
- reload and refresh recovery

## Non-negotiable constraints

- Do not change product behavior unless the change is explicitly justified as a performance fix.
- Do not break:
  - protected video playback
  - watch progress tracking
  - Razorpay course unlock flow
  - admin upload flows
  - live classes
- Preserve existing UX and business logic unless a change is clearly beneficial and documented.
- Prefer targeted refactors over cosmetic rewrites.

## What to analyze first

1. Frontend bundle composition
   - identify what should be lazy-loaded
   - identify what should stay in the initial shell
2. Render hotspots
   - find components with high state churn and broad rerender scope
   - detect unnecessary memo churn and prop instability
3. Network/data hotspots
   - find oversized endpoints
   - find endpoints used too frequently
   - identify duplicated or overly broad refreshes
4. Long lists and heavy trees
   - detect where virtualization or incremental rendering is needed
5. Player/test loop overhead
   - review timers, polling, progress sync, and event listeners

## Required deliverables

Produce work in phases.

### Phase 1: Evidence

Give a concise audit with:

- biggest frontend bottlenecks
- biggest backend bottlenecks
- likely root causes of lag
- specific files and functions involved

### Phase 2: Optimization plan

Create a prioritized plan with:

- impact
- complexity
- regression risk
- exact files to change

### Phase 3: Implementation

Implement the highest-value changes first, especially:

- route/workspace code splitting
- overview payload reduction or split fetching
- rerender isolation for courses/tests/admin
- reduced refresh/poll pressure
- safe caching or memoization where it materially helps

### Phase 4: Verification

Measure before/after where possible:

- build output / chunk sizes
- initial load improvements
- tab switch responsiveness
- API response size/time for overview and catalog flows

## Strong candidate improvements

- Use `React.lazy` and `Suspense` for major workspaces.
- Move heavy tab components out of the root eager bundle.
- Split `platform overview` into smaller endpoints or staged fetching.
- Stop replacing the full overview tree when only one section changes.
- Memoize only where it reduces real rerender cost.
- Extract playback logic into focused hooks/components so catalog UI does not rerender with player state.
- Extract exam runtime state away from catalog/detail presentation.
- Add virtualization for long admin/course/test lists if they can grow materially.
- Add backend pagination and lighter DTOs for admin and catalog lists.
- Replace polling with event-driven refresh where feasible, or reduce poll scope.

## Success criteria

The task is successful only if:

- production JS is meaningfully smaller
- initial render feels faster
- switching between overview/courses/tests/live/admin is smoother
- admin CRUD refresh is lighter
- course and test flows feel less laggy
- no protected playback regressions are introduced

## Output format

When you respond:

1. Start with the highest-severity performance findings.
2. Then give the prioritized optimization plan.
3. Then implement changes.
4. Then verify with concrete evidence.

Do not give generic performance advice. Work from the actual files and architecture in this repo.
