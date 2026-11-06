
FROM node:22-alpine

WORKDIR /app

# Copy workspace manifests first for dependency installation
COPY package.json package-lock.json ./

COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json

# Install dependencies for all workspaces
RUN npm ci

# Copy the complete monorepo
COPY . .

# Build the React frontend
RUN npm run build:web

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["npm", "run", "start", "-w", "@fb/api"]
