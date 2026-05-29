# EduMaster SSC JE / RRB JE Prep Platform

EduMaster is a full-stack exam-prep application for **SSC JE / RRB JE** with:

- learner auth with single-session protection
- structured courses, lessons, premium access, and watch progress
- mock tests, daily quizzes, rankings, streaks, and analytics
- live classes, replay links, chat, and doubt threads
- admin workflows for courses, tests, quizzes, uploads, and live sessions
- payments, subscriptions, referrals, and AI-assisted study flows

The frontend runs as a Vite React app. The backend is mounted under **`/backend/api`** in local development and can be deployed to **Firebase Hosting + Firebase Functions** for a single-origin production setup.

## Local development

```bash
npm install
npm run dev
```

`npm run dev` starts the integrated app server and bootstraps a local Postgres instance that matches `POSTGRES_URL` in `.env` when PostgreSQL binaries are available on your machine.

Useful endpoints:

- `GET /healthz`
- `GET /backend/api/health`
- `GET /backend/api/ready`
- `GET /backend/api/live`

## Production expectations

This repo is configured for production mode with:

- real database-backed platform data
- configured admin credentials
- production-only API surfaces
- persistent storage required unless memory mode is explicitly allowed for local testing

Before production deployment you must provide:

- `JWT_SECRET`
- `PRIVATE_VIDEO_TOKEN_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `CORS_ORIGIN`
- one persistent database: `MONGODB_URI` or `POSTGRES_URL`

Validate production env locally with:

```bash
npm run validate:production
```

Live-class release guide:

- [LIVE_CLASSES_RELEASE_GUIDE.md](./LIVE_CLASSES_RELEASE_GUIDE.md)
- [Low-Cost Video Streaming Architecture](./docs/LOW_COST_VIDEO_STREAMING_ARCHITECTURE.md)
- [Low-Cost Video Streaming Dev Prompt](./docs/LOW_COST_VIDEO_STREAMING_DEV_PROMPT.md)
- [Free DRM-Like Dev Stack](./docs/FREE_DRM_DEV_STACK.md)

## Firebase deployment

Use the guide in [FIREBASE_DEPLOY_GUIDE.md](./FIREBASE_DEPLOY_GUIDE.md).

Quick deploy:

```bash
./deploy-quick.sh YOUR_FIREBASE_PROJECT_ID
```

## Verification

```bash
npm run lint
npm run build
node backend/test-api.js
```

## Notes

- Firebase Hosting is a good low-cost global delivery layer for testing.
- Firebase Functions is suitable for moderate test traffic, not unlimited free production scale.
- Durable uploads and video replay storage still require object storage such as S3/R2/B2.
