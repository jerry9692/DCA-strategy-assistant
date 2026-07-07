# Multi-stage build: backend + frontend → single image with nginx.

# --- Stage 1: Build frontend ---
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
# 国内 npm 镜像加速（淘宝源）
RUN npm config set registry https://registry.npmmirror.com
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: Backend + serve frontend static ---
FROM python:3.12-slim AS runtime
WORKDIR /app

# 国内 PyPI 镜像加速（清华源）
RUN pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple && \
    pip config set global.trusted-host pypi.tuna.tsinghua.edu.cn

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
#
# UID/GID 1001 is fixed for reproducibility, but groupadd/useradd fail
# with "GID already in use" when the host or base image already has
# that GID. The `|| true` fallback lets the build proceed — the
# subsequent `chown` still works because the user gets created via
# the useradd path on success, or via the existing entry in
# /etc/passwd on failure.
RUN mkdir -p /app/backend/data && \
    (groupadd --system --gid 1001 dca || true) && \
    (useradd --system --uid 1001 --gid dca --home /app --shell /usr/sbin/nologin dca || \
        usermod -u 1001 -g dca -d /app -s /usr/sbin/nologin dca 2>/dev/null || true) && \
    chown -R dca:dca /app

# Expose port
EXPOSE 8010

# Liveness probe — /api/health is cheap (no yfinance, no backtest) and
# is safe to call before the SPA mount resolves.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import sys, urllib.request; \
      sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8010/api/health', timeout=3).status == 200 else 1)"

# Drop root. The entrypoint below re-chowns the (potentially mounted)
# data directory before starting uvicorn so the runtime user can write
# to it.
USER dca

# Run uvicorn serving both API and static files
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010", "--app-dir", "backend"]
