# hajirhubBE

## Production Deployment

Backend production URL:

```text
https://api.purbatechlabs.com
```

Web app:

```text
https://app.purbatechlabs.com
```

### Hostinger Node.js Settings

- Startup file: `server.js`
- Start command: `npm start`
- App port: use the `PORT` environment variable supplied by hosting, or set `PORT=3001`
- Node command used by the app:

```json
{
  "scripts": {
    "start": "node server.js"
  }
}
```

### Required Environment Variables

Set these in Hostinger Node.js hosting:

```text
PORT=3001
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=...
CREDENTIALS_ENCRYPTION_KEY=...
CORS_ORIGIN=https://app.purbatechlabs.com,https://www.purbatechlabs.com
ENABLE_DEVICE_TIME_SYNC=false
DEVICE_TIME_SYNC_INTERVAL_HOURS=6
```

Do not use `*` for `CORS_ORIGIN` in production when credentials are enabled.

### Biometric Terminal Settings

```text
Server: api.purbatechlabs.com
Port: 443
Protocol: HTTPS
Path/routes:
/iclock/getrequest
/iclock/cdata
```

ZKTeco ADMS routes run on the same Express app and same hosting port as the API.
The plain `/iclock/...` paths are the preferred production terminal paths, and
`/api/iclock/...` is also supported for development/proxy setups:

```text
GET  /iclock/getrequest
GET  /iclock/cdata
POST /iclock/cdata
GET  /api/iclock/getrequest
GET  /api/iclock/cdata
POST /api/iclock/cdata
```

Dashboard device management is authenticated and available at both paths:

```text
GET    /api/hardware/devices
POST   /api/hardware/devices
PUT    /api/hardware/devices/:id
DELETE /api/hardware/devices/:id

GET    /api/iclock/devices
POST   /api/iclock/devices
PUT    /api/iclock/devices/:id
DELETE /api/iclock/devices/:id
```

### Production Smoke Tests

```bash
curl https://api.purbatechlabs.com/health
curl "https://api.purbatechlabs.com/iclock/getrequest?SN=TEST001"
curl -X POST "https://api.purbatechlabs.com/iclock/cdata?SN=TEST001&table=ATTLOG" -d "1\t2026-05-18 09:30:00\t0\t1"
```
