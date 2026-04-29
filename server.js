const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const API_PREFIX = '/v1';
const DATA_DIR = path.join(__dirname, 'data');
const FARMS_FILE = path.join(DATA_DIR, 'farms.json');
const TRACKS_FILE = path.join(DATA_DIR, 'tracks.json');
const EVENTS_FILE = path.join(DATA_DIR, 'geofence-events.json');
const API_KEYS_FILE = path.join(DATA_DIR, 'api-keys.json');
const requestBuckets = new Map();
const sseClients = new Map();

app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');next();});
app.use(express.json({ limit: '1mb' }));
app.use(require('cors')({ origin: true }));
app.use(express.static(path.join(__dirname)));

ensureDataFiles();

app.use((req, res, next) => {
  const tenantId = req.header('x-tenant-id');
  const apiKey = req.header('x-api-key');

  if (!req.path.startsWith(API_PREFIX)) {
    return next();
  }

  if (req.path === `${API_PREFIX}/health` || req.path === `${API_PREFIX}/openapi.json`) {
    return next();
  }

  const isDemo = req.header('x-demo-client') === 'true';
  if (isDemo) {
    req.tenantId = 'demo-tenant';
    return next();
  }

  if (!tenantId || !apiKey) {
    return res.status(401).json({ error: 'x-tenant-id and x-api-key headers are required (or x-demo-client: true)' });
  }

  if (!isApiKeyValid(tenantId, apiKey)) {
    return res.status(403).json({ error: 'invalid api credentials' });
  }

  req.tenantId = tenantId;
  next();
});

app.use((req, res, next) => {
  if (!req.tenantId) return next();
  const key = `${req.tenantId}:${Math.floor(Date.now() / 60000)}`;
  const count = (requestBuckets.get(key) || 0) + 1;
  requestBuckets.set(key, count);

  if (count > 600) {
    return res.status(429).json({ error: 'rate limit exceeded for tenant' });
  }

  next();
});

app.get(`${API_PREFIX}/health`, (_req, res) => {
  res.json({ ok: true, service: 'agro-api', timestamp: new Date().toISOString() });
});

app.get(`${API_PREFIX}/openapi.json`, (_req, res) => {
  res.json({
    openapi: '3.1.0',
    info: { title: 'Agro API', version: '1.0.0' },
    servers: [{ url: API_PREFIX }],
    components: { securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' }, DemoClient: { type: 'apiKey', in: 'header', name: 'x-demo-client' } } },
  });
});

app.post(`${API_PREFIX}/farms`, asyncHandler(async (req, res) => {
  const { name, boundary } = req.body || {};

  if (!Array.isArray(boundary) || boundary.length < 3 || !boundary.every(isValidLatLng)) {
    return res.status(400).json({ error: 'boundary must be an array of at least 3 [lat, lng] coordinates' });
  }

  const farms = await readJson(FARMS_FILE);
  const farm = {
    id: crypto.randomUUID(),
    tenantId: req.tenantId,
    name: typeof name === 'string' ? name : `farm-${Date.now()}`,
    boundary,
    createdAt: new Date().toISOString(),
  };

  farms.push(farm);
  await writeJson(FARMS_FILE, farms);
  res.status(201).json({ message: 'Farm saved', farm });
}));

app.get(`${API_PREFIX}/farms`, asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 50 } = req.query;
  const farms = (await readJson(FARMS_FILE)).filter((f) => f.tenantId === req.tenantId);
  res.json(paginate(farms, page, pageSize));
}));

app.post(`${API_PREFIX}/tracks/start`, asyncHandler(async (req, res) => {
  const { deviceId, label } = req.body || {};
  if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ error: 'deviceId is required' });

  const tracks = await readJson(TRACKS_FILE);
  const track = {
    id: crypto.randomUUID(),
    tenantId: req.tenantId,
    deviceId,
    label: typeof label === 'string' ? label : null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    points: [],
    lastEventState: {},
  };

  tracks.push(track);
  await writeJson(TRACKS_FILE, tracks);
  res.status(201).json({ trackId: track.id, track });
}));

app.post(`${API_PREFIX}/tracks/:trackId/point`, asyncHandler(async (req, res) => {
  const { trackId } = req.params;
  const { latitude, longitude, accuracy, speed, heading, altitude, timestamp } = req.body || {};

  if (!isValidNumber(latitude, -90, 90) || !isValidNumber(longitude, -180, 180)) {
    return res.status(400).json({ error: 'latitude/longitude are required and valid' });
  }

  if (isValidNumber(accuracy, 0) && accuracy > 30) {
    return res.status(422).json({ error: 'low GPS quality: accuracy too high (>30m)' });
  }

  const tracks = await readJson(TRACKS_FILE);
  const idx = tracks.findIndex((t) => t.id === trackId && t.tenantId === req.tenantId);
  if (idx === -1) return res.status(404).json({ error: 'Track not found' });

  const track = tracks[idx];
  const lastPoint = track.points[track.points.length - 1];

  if (lastPoint && isStaleOrJump(lastPoint, { latitude, longitude, timestamp })) {
    return res.status(422).json({ error: 'GPS point rejected as stale or unrealistic jump' });
  }

  const point = {
    latitude,
    longitude,
    accuracy: isValidNumber(accuracy, 0) ? accuracy : null,
    speed: isValidNumber(speed, 0) ? speed : null,
    heading: isValidNumber(heading, 0, 360) ? heading : null,
    altitude: isValidNumber(altitude) ? altitude : null,
    timestamp: typeof timestamp === 'string' ? timestamp : new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };

  track.points.push(point);
  tracks[idx] = track;
  await writeJson(TRACKS_FILE, tracks);

  const events = await evaluateGeofences(req.tenantId, track, point);
  broadcast(req.tenantId, { type: 'point', trackId: track.id, point, events });

  res.status(201).json({ message: 'Point recorded', point, events });
}));

app.post(`${API_PREFIX}/tracks/:trackId/stop`, asyncHandler(async (req, res) => {
  const tracks = await readJson(TRACKS_FILE);
  const idx = tracks.findIndex((t) => t.id === req.params.trackId && t.tenantId === req.tenantId);
  if (idx === -1) return res.status(404).json({ error: 'Track not found' });
  tracks[idx].endedAt = new Date().toISOString();
  await writeJson(TRACKS_FILE, tracks);
  res.json({ message: 'Track stopped', track: tracks[idx] });
}));

app.get(`${API_PREFIX}/tracks`, asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 20, deviceId } = req.query;
  let tracks = (await readJson(TRACKS_FILE)).filter((t) => t.tenantId === req.tenantId);
  if (deviceId) tracks = tracks.filter((t) => t.deviceId === deviceId);
  res.json(paginate(tracks, page, pageSize));
}));

app.get(`${API_PREFIX}/events`, asyncHandler(async (req, res) => {
  const events = (await readJson(EVENTS_FILE)).filter((e) => e.tenantId === req.tenantId);
  res.json(events);
}));

app.get(`${API_PREFIX}/stream`, (req, res) => {
  const tenantId = req.tenantId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clients = sseClients.get(tenantId) || [];
  clients.push(res);
  sseClients.set(tenantId, clients);

  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  req.on('close', () => {
    const nextClients = (sseClients.get(tenantId) || []).filter((c) => c !== res);
    sseClients.set(tenantId, nextClients);
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  for (const [file, fallback] of [[FARMS_FILE, '[]'], [TRACKS_FILE, '[]'], [EVENTS_FILE, '[]'], [API_KEYS_FILE, JSON.stringify([{ tenantId: 'demo-tenant', apiKey: 'demo-key' }], null, 2)]]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, fallback);
  }
}

function asyncHandler(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
async function readJson(filePath) { return JSON.parse(await fsp.readFile(filePath, 'utf-8')); }
async function writeJson(filePath, data) { await fsp.writeFile(filePath, JSON.stringify(data, null, 2)); }
function isValidLatLng(v) { return Array.isArray(v) && v.length === 2 && isValidNumber(v[0], -90, 90) && isValidNumber(v[1], -180, 180); }
function isValidNumber(value, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) { return Number.isFinite(value) && value >= min && value <= max; }
function isApiKeyValid(tenantId, apiKey) {
  const keys = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf-8'));
  return keys.some((k) => k.tenantId === tenantId && k.apiKey === apiKey);
}
function paginate(items, page, pageSize) {
  const p = Math.max(parseInt(page, 10) || 1, 1); const ps = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 200);
  const start = (p - 1) * ps;
  return { items: items.slice(start, start + ps), page: p, pageSize: ps, total: items.length };
}
function broadcast(tenantId, payload) {
  for (const client of (sseClients.get(tenantId) || [])) client.write(`data: ${JSON.stringify(payload)}\n\n`);
}
async function evaluateGeofences(tenantId, track, point) {
  const farms = (await readJson(FARMS_FILE)).filter((f) => f.tenantId === tenantId);
  const events = await readJson(EVENTS_FILE);
  const created = [];
  for (const farm of farms) {
    const inside = pointInPolygon([point.latitude, point.longitude], farm.boundary);
    const prev = track.lastEventState[farm.id] || 'outside';
    const now = inside ? 'inside' : 'outside';
    if (prev !== now) {
      const event = { id: crypto.randomUUID(), tenantId, trackId: track.id, farmId: farm.id, type: inside ? 'enter' : 'exit', at: new Date().toISOString() };
      events.push(event); created.push(event);
      track.lastEventState[farm.id] = now;
    }
  }
  if (created.length) await writeJson(EVENTS_FILE, events);
  return created;
}
function pointInPolygon([lat, lng], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lng) !== (yj > lng)) && (lat < ((xj - xi) * (lng - yi)) / ((yj - yi) || 1e-7) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function isStaleOrJump(lastPoint, candidate) {
  const t1 = new Date(lastPoint.timestamp).getTime();
  const t2 = new Date(candidate.timestamp || Date.now()).getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 <= t1) return true;
  const dtSec = (t2 - t1) / 1000;
  const distM = haversine(lastPoint.latitude, lastPoint.longitude, candidate.latitude, candidate.longitude);
  return (distM / dtSec) > 70;
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1); const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
