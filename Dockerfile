# Multi-stage build: backend + frontend → single image with nginx.

# --- Stage 1: Build frontend ---
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: Backend + serve frontend static ---
FROM python:3.12-slim AS runtime
WORKDIR /app

# Install backend dependencies
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ ./backend/

# Copy built frontend
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Create data directory and grant it to the unprivileged user below.
# Named volumes mount over this directory; the entrypoint re-chowns on
# startup so the runtime user can always write to /app/backend/data.
RUN mkdir -p /app/backend/data && \
    groupadd --system --gid 1001 dca && \
    useradd --system --uid 1001 --gid dca --home /app --shell /usr/sbin/nologin dca && \
    chown -R dca:dca /app

# Expose port
EXPOSE 8000

# Liveness probe — /api/health is cheap (no yfinance, no backtest) and
# is safe to call before the SPA mount resolves.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import sys, urllib.request; \
        sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).status == 200 else 1)"

# Drop root. The entrypoint below re-chowns the (potentially mounted)
# data directory before starting uvicorn so the runtime user can write
# to it.
USER dca

# Run uvicorn serving both API and static files
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "backend"]
