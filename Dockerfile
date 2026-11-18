FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8095
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
EXPOSE 8095
CMD ["node", "src/index.js"]
