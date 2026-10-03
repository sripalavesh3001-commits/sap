# SAP Points Activity Management System (Render-ready, no disk needed)

Data (students, submissions AND certificate PDFs) is stored in a Turso (libSQL/SQLite) database,
so the host needs no persistent disk, and it works on Render's free plan.

## Local run (uses a local file DB automatically)
    npm install && npm start      # http://localhost:3000   (admin: /admin)

## Environment variables (production)
    NODE_ENV=production
    ADMIN_USER=<your username>
    ADMIN_PASS=<strong password>
    TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io
    TURSO_AUTH_TOKEN=<token>

## Render settings
    Build Command: npm install
    Start Command: npm start
    Health Check Path: /healthz
