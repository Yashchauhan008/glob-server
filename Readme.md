# Glob API

Express + TypeScript + Postgres + Redis + Socket.IO. Runs on port **3008**.

## Setup
```
npm install
cp .env.example .env   # then fill values (DATABASE_URL, JWT_SECRET, SMTP_*, REDIS_URL, AWS_* can be dummy)
npx dbmate --url "$DATABASE_URL" --no-dump-schema up
npm run dev:watch
```
Needs Postgres 18 (`uuidv7()`), database `glob`, and Redis. Registration sends an email code via SMTP.

## Modules
`/auth`, `/ideas`, `/products`, `/todos`, `/leads`, `/dashboard`, `/csv`; Socket.IO presence (live cursors) in `src/modules/presence`.
