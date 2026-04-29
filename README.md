# agro-api

Multi-tenant open-source geofencing + movement tracking API (token-free maps using OpenStreetMap).

## Quick start
```bash
npm install
npm test
npm start
```
Open `http://localhost:3000/map.html`.

## Deploy to Vercel (Serverless)
1. Push this repo to GitHub.
2. Import the repo in Vercel.
3. Deploy (the included `vercel.json` routes `/v1/*` to `api.js` and serves `map.html` at `/`).
4. Use your Vercel URL (for example `https://your-project.vercel.app`) on your phone.

Default demo auth headers:
- `x-tenant-id: demo-tenant`
- `x-api-key: demo-key`


## Phone Demo (No API key required)
- Open `http://localhost:3000/map.html` on your phone.
- Tap **Start Tracking** and allow GPS/location access when prompted.
- If GPS is off, the app will ask you to enable location.
- Move around your field boundary, then tap **Stop & Save Geofence**.
- Demo mode works with header `x-demo-client: true` and automatically uses `demo-tenant`.

## Implemented now
1. API key auth + tenant isolation.
2. Rate limiting per tenant.
3. API versioning (`/v1`) + OpenAPI endpoint (`/v1/openapi.json`).
4. Pagination/filter on list endpoints.
5. Async non-blocking file persistence.
6. Centralized error middleware.
7. GPS quality filtering and unrealistic-jump rejection.
8. Geofence enter/exit event generation.
9. Real-time SSE stream (`/v1/stream`).
10. Basic automated test for health endpoint.

## Endpoints
- `GET /v1/health`
- `GET /v1/openapi.json`
- `POST /v1/farms`
- `GET /v1/farms?page=1&pageSize=50`
- `POST /v1/tracks/start`
- `POST /v1/tracks/:trackId/point`
- `POST /v1/tracks/:trackId/stop`
- `GET /v1/tracks?page=1&pageSize=20&deviceId=tractor-01`
- `GET /v1/events`
- `GET /v1/stream`


## Author
- **Chalwe Silas** — CEO & Founder, Covian Hive Technologies
