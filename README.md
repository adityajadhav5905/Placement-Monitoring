# Placement Monitoring Hub - Production Deployment Guide

This project provides a campus placement monitoring system with a React SPA frontend, an Express REST API backend, and an MCP server integration for data ingestion and mutations.

## System Architecture

```
Claude + MCP ──(Mutations w/ X-API-Key)──> Express REST API ──> MySQL
User Browser ────────────────(Read Only GET)───────┘
```

## Running the Stack locally with Docker Compose

To test the entire stack locally in a production-like environment, run:

```bash
docker compose up --build
```

This starts:
1. **Database**: MySQL on port `3306` (with health checks).
2. **Backend**: REST API on port `5000` (waits for Database to be healthy).
3. **Frontend**: NGINX serving static React assets on port `8080` (redirecting SPA routing internally).

### Production Environment Variables

Configure these variables inside your production runtime or container environment:

| Variable | Target | Description |
| :--- | :--- | :--- |
| `DATABASE_HOST` | Backend | MySQL server domain/address |
| `DATABASE_PORT` | Backend | MySQL connection port (default `3306`) |
| `DATABASE_USER` | Backend | MySQL connection user name |
| `DATABASE_PASSWORD`| Backend | MySQL connection user password |
| `DATABASE_NAME` | Backend | Database schema name |
| `API_KEY` | Backend | Authentication token for POST/PUT/DELETE mutations |
| `GEMINI_API_KEY` | Backend | Google Generative AI API Key for update parsers |
| `BACKEND_URL` | MCP Server | Endpoint for Claude MCP commands to forward calls |

---

## Health Checks & Lifecycle Management

- **Health Check Route**: The backend exposes `GET /health` which validates database connection pool availability.
- **Graceful Shutdown**: The REST server traps `SIGTERM` and `SIGINT` signals to gracefully close the Express listener and close the MySQL connection pool before exiting.
