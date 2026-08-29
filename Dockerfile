# ─────────────────────────────────────────────────────────
# Dockerfile — TCP Flow-Control Simulator
# Multi-stage build: deps → production image
# ─────────────────────────────────────────────────────────

# ── Stage 1: install dependencies ────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only package files first (layer-cache friendly)
COPY backend/package*.json ./backend/

RUN cd backend && npm ci --omit=dev

# ── Stage 2: production image ─────────────────────────────
FROM node:20-alpine AS runner

# Add non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/backend/node_modules ./backend/node_modules

# Copy application source
COPY backend/  ./backend/
COPY frontend/ ./frontend/

# Ensure data directory exists and is writable
RUN mkdir -p backend/data && \
    echo "[]" > backend/data/users.json && \
    chown -R appuser:appgroup /app

USER appuser

# Render / Railway inject PORT at runtime; fallback to 3000
ENV PORT=3000 \
    NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "backend/server.js"]
