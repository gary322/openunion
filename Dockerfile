FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY workers ./workers
COPY services ./services
COPY db ./db
COPY public ./public
COPY openapi.yaml README.md ./

RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db
COPY --from=build /app/public ./public
COPY --from=build /app/openapi.yaml ./openapi.yaml

EXPOSE 3000

CMD ["node", "dist/server.js"]

