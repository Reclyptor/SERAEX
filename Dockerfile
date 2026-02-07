# syntax=docker/dockerfile:1

# ============================================
# Stage 1: Dependencies
# ============================================
FROM node:22-slim AS deps

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# ============================================
# Stage 2: Builder
# ============================================
FROM node:22-slim AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application
RUN npm run build

# Prune devDependencies for production
RUN npm prune --production

# ============================================
# Stage 3: Production
# ============================================
FROM node:22-slim AS production

WORKDIR /app

# Set to production
ENV NODE_ENV=production

# Install system dependencies for media processing
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      mkvtoolnix \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs seraex

# Copy built application
COPY --from=builder --chown=seraex:nodejs /app/lib ./lib
COPY --from=builder --chown=seraex:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=seraex:nodejs /app/package.json ./package.json

# Switch to non-root user
USER seraex

# No EXPOSE: worker connects outbound to Temporal Server via gRPC

# Start the worker
CMD ["node", "lib/worker.js"]
