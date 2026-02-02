FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY workers ./workers
COPY services ./services
COPY db ./db

RUN npm run build

ENV NODE_ENV=production
EXPOSE 4010

CMD ["node", "dist/services/verifier-gateway/server.js"]

