# Stage 1: Base build
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Stage 2: Production release
FROM node:20-alpine

WORKDIR /app

COPY --from=build /app /app

ENV PORT=5000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 5000

USER node

CMD ["node", "server.js"]
