# Core Service — single-container deploy (backend serves the built dashboard
# itself, same origin, no separate frontend host needed).
FROM node:20-slim

WORKDIR /app

# Install backend deps first (better layer caching — this layer only
# invalidates when package.json changes, not on every source edit).
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm install
# (postinstall in package.json runs `npm --prefix frontend install` automatically)

# Now copy the rest of the source and build both.
COPY . .
RUN npm run build
RUN npm run build:frontend

# Create runtime directories.
# /app/data is where SQLite writes the DB file — on Railway, mount a
# persistent volume here so data survives redeploys (see README).
# /app/logs is where Winston writes core.log — not volume-backed by default
# (logs are also visible in Railway's log viewer), but the directory must
# exist or Winston will fail to start.
RUN mkdir -p /app/data /app/logs

ENV NODE_ENV=production

# Railway injects its own PORT at runtime and expects the app to bind to
# 0.0.0.0 — set HOST=0.0.0.0 in Railway's service variables (see README).
EXPOSE 4000

CMD ["npm", "run", "start"]
