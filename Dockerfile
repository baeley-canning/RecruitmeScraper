FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install ALL deps first (including devDeps for TypeScript compiler)
COPY package.json package-lock.json* ./
RUN npm install

# Compile TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDeps after build so the final image is smaller
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/index.js"]
