# Webhook Delivery Engine

A self-hostable webhook delivery engine: durably persist an event, deliver it to a
pre-registered subscription, and guarantee delivery or an explicit, replayable failure.

## Quick start

```bash
docker compose up -d
cp .env.example .env
npm install
npm run migrate
npm start   # http://localhost:3000