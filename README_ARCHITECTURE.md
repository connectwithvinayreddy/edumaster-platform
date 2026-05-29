# EduMaster Architecture Overview

## Current integrated build

The project is now organized as a **single user-facing React app** served by the root Express/Vite server, while the product backend is mounted under **`/backend/api`**.

### Runtime shape

- **Root server**: `server.ts`
  - serves the React app
  - keeps Stripe helper routes for checkout/session verification
  - mounts the backend Express app under `/backend`
- **Backend domain app**: `backend/server.cjs`
  - auth, users, courses, tests, quiz, analytics, admin, notifications, engagement, payments, platform overview
  - auto-falls back to in-memory mode when MongoDB is unavailable
- **Frontend app**: `src/App.tsx`
  - JWT login/register/logout
  - course browsing, mock tests, daily quiz, live classes, analytics, plans, admin

## Product modules

- Authentication and user/device session tracking
- Course hierarchy with lesson progression and premium access
- Mock tests with timer, negative marking, scorecard, rank, percentile inputs
- Daily quiz with streak and leaderboard loop
- Performance analytics and AI recommendations
- Live classes and replay-ready session catalog
- Payment simulation and instant-access enrollment
- Admin metrics, sample seed, course creation, and question upload

## Scalability target

The target design supports **10K to 100K learners** using:

- stateless API pods behind a load balancer
- Redis for cache, leaderboard, and session acceleration
- PostgreSQL/Firestore for durable transactional + document workloads
- S3-compatible storage for notes, recordings, and premium assets
- WebSocket/Agora/Zoom integrations for live experiences

## Important docs

- [HLD_LLD.md](./HLD_LLD.md)
- [API_DESIGN.md](./API_DESIGN.md)
- [DB_SCHEMA.sql](./DB_SCHEMA.sql)
- [TEST_ENGINE_LOGIC.md](./TEST_ENGINE_LOGIC.md)
- [DEPLOYMENT_ARCHITECTURE.md](./DEPLOYMENT_ARCHITECTURE.md)
- [USER_FLOW.md](./USER_FLOW.md)
- [Low-Cost Video Streaming Architecture](./docs/LOW_COST_VIDEO_STREAMING_ARCHITECTURE.md)
- [Low-Cost Video Streaming Dev Prompt](./docs/LOW_COST_VIDEO_STREAMING_DEV_PROMPT.md)
