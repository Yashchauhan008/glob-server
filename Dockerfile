FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM node:24-alpine

WORKDIR /app

RUN npm install -g dbmate

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/db ./db
COPY --from=builder /app/email-templates ./email-templates

RUN mkdir -p files tmp logs

EXPOSE 3008

CMD ["sh", "-c", "dbmate --no-dump-schema up && npm run start"]
