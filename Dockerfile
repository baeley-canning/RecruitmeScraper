FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install Node deps first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Playwright browser is pre-installed in the base image, but stealth plugin
# needs Chromium specifically — verify it's present.
RUN npx playwright install chromium

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/index.js"]
