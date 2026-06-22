# Node 20 LTS on Alpine — small image, global fetch available (used by openid-client
# and by the docker-compose healthcheck).
FROM node:20-alpine

WORKDIR /app

# Install dependencies first so Docker layer caching skips `npm install`
# when only source code changes.
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 3000
CMD ["node", "src/index.js"]
