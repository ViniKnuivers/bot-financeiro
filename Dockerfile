# syntax=docker/dockerfile:1

# ---- build: instala tudo, gera o Prisma Client e compila o TypeScript ----
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# O postinstall roda `prisma generate`, que precisa do schema já copiado.
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: só dependências de produção e o JS compilado ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# --ignore-scripts: o postinstall (prisma generate) não é necessário aqui, o client
# gerado já foi compilado para dist/ no estágio anterior.
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
