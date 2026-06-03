FROM node:22-alpine AS base

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package*.json ./
COPY backend/package*.json ./backend/

RUN npm ci
RUN cd backend && npm ci

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

CMD ["npm", "run", "start"]
