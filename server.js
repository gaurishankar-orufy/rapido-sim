// Rapido-style tester for the W2N Action Screen API: book a ride → action screen to a list of drivers, all at once
// (first Accept wins, withdrawn for the rest) or one by one (Skip / timeout → next driver). No dependencies (Node 20+: built-in http + fetch).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const W2N_API_BASE = (process.env.W2N_API_BASE || 'https://api.webtonativebeta.orufy.in/api/v1/push-notification').replace(/\/+$/, '');
const W2N_API_KEY = process.env.W2N_API_KEY || '';
const W2N_API_SECRET = process.env.W2N_API_SECRET || '';
const APP_ID = process.env.APP_ID || '6a3ba941db31e8b79fc3aa12';

// ponytail: in-memory store, lost on restart; move to SQLite/JSON file if ride history must survive deploys.
const rides = new Map();
const logs = []; // inbound chain calls, newest first
const MAX_LOGS = 200;

const now = () => new Date().toISOString();
const event = (ride, type, detail) => ride.events.push({ at: now(), type, ...(detail && { detail }) });

async function w2n(urlPath, body) {
  const res = await fetch(W2N_API_BASE + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': W2N_API_KEY, 'x-api-secret': W2N_API_SECRET },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok && json.isSuccess !== false, status: res.status, body: json };
}

/** W2N audience for these external user ids: one group per user, so any of them (groups are OR-ed). */
const usersAudience = (userIds) => ({
  type: 'SPECIFIC',
  groups: userIds.map((id) => [{ type: 'USER', field: 'EXTERNAL_USER_ID', operator: 'IS', value: String(id) }]),
});

async function withdraw(ride, attempt, reason) {
  if (!attempt?.requestId || attempt.withdrawn) return;
  attempt.withdrawn = true;
  const result = await w2n(`/action-screen/${encodeURIComponent(attempt.requestId)}/withdraw`, { appId: APP_ID });
  event(ride, 'withdraw', { reason, requestId: attempt.requestId, status: result.status, response: result.body });
}

const current = (ride) => ride.attempts[ride.attempts.length - 1];

/**
 * modes:
 * - broadcast: one request to every driver in the list (or EVERYONE when the list is empty); first Accept wins.
 * - sequential: offered to one driver at a time; a Skip or a timeout withdraws it and offers the next driver.
 */
async function createRide(input) {
  const rideId = 'r_' + crypto.randomUUID().slice(0, 8);
  const drivers = [...new Set((input.drivers || []).map((d) => String(d).trim()).filter(Boolean))];
  const ride = {
    rideId,
    screenId: input.screen_id || 'incoming_call',
    mode: input.mode === 'sequential' && drivers.length ? 'sequential' : 'broadcast',
    drivers,
    status: 'searching',
    data: input.data || {},
    platforms: input.platforms || ['android', 'ios'],
    expiresIn: input.expires_in != null ? Number(input.expires_in) : null,
    attempts: [], // one per request sent: { to, requestId, expiresAt, outcome }
    acceptedBy: null,
    rejectedBy: [],
    events: [],
    createdAt: now(),
  };
  rides.set(rideId, ride);
  await offer(ride, ride.mode === 'sequential' ? [drivers[0]] : drivers);
  return ride;
}

/** Sends one request for [to] (driver ids; empty = EVERYONE) and arms its expiry. */
async function offer(ride, to) {
  const attempt = { to, requestId: null, expiresAt: null, outcome: 'pending' };
  ride.attempts.push(attempt);
  const result = await w2n('/action-screen/send', {
    appId: APP_ID,
    screen_id: ride.screenId,
    platforms: ride.platforms,
    audience: to.length ? usersAudience(to) : { type: 'EVERYONE', groups: [] },
    scheduleType: 'IMMEDIATE',
    ...(ride.expiresIn != null && { expires_in: ride.expiresIn }),
    // ride_id links Accept / Reject chain calls back to this ride; driver_id is set when one driver gets it.
    data: { ...ride.data, ride_id: ride.rideId, ...(to.length === 1 && { driver_id: to[0] }) },
  });
  event(ride, 'send', { to: to.length ? to : 'EVERYONE', status: result.status, response: result.body });
  if (!result.ok || !result.body.requestId) {
    attempt.outcome = 'failed';
    return next(ride);
  }
  attempt.requestId = result.body.requestId;
  attempt.expiresAt = result.body.expiresAt || null;
  ride.expiresAt = attempt.expiresAt;
  if (attempt.expiresAt) {
    setTimeout(async () => {
      if (ride.status !== 'searching' || attempt.outcome !== 'pending') return;
      attempt.outcome = 'timeout';
      event(ride, 'timeout', { to: attempt.to });
      await withdraw(ride, attempt, 'timeout'); // clears it on devices that never answered (iOS can't on its own)
      await next(ride);
    }, Math.max(0, new Date(attempt.expiresAt) - Date.now())).unref(); // never keeps the process alive on its own
  }
}

/** After a Skip / timeout / failed send: the next driver (sequential), else the ride ends. */
async function next(ride) {
  if (ride.status !== 'searching') return;
  const nextDriver = ride.mode === 'sequential' ? ride.drivers[ride.attempts.length] : undefined;
  if (nextDriver) return offer(ride, [nextDriver]);
  ride.status = ride.attempts.some((a) => a.outcome === 'failed') && ride.attempts.every((a) => a.outcome === 'failed') ? 'failed' : 'no_drivers';
  event(ride, ride.status);
}

/** Who answered: the one driver it was offered to, else cookie driver_id, x-driver-id header, body.driver_id. */
function driverOf(req, body, ride) {
  const offeredTo = current(ride)?.to;
  if (offeredTo?.length === 1) return offeredTo[0];
  const cookie = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
  return cookie.driver_id || req.headers['x-driver-id'] || body?.driver_id || body?.variables?.driver_id || 'unknown';
}

async function accept(ride, driver) {
  // Check and set before any await: Node runs this synchronously, so exactly one Accept can win.
  const attempt = current(ride);
  if (ride.status !== 'searching') return { code: 409, body: { ok: false, reason: `ride ${ride.status}`, acceptedBy: ride.acceptedBy } };
  if (!attempt || attempt.outcome !== 'pending' || (attempt.expiresAt && Date.now() > new Date(attempt.expiresAt))) {
    return { code: 409, body: { ok: false, reason: 'offer expired' } };
  }
  ride.status = 'accepted';
  ride.acceptedBy = driver;
  attempt.outcome = 'accepted';
  event(ride, 'accepted', { driver });
  await withdraw(ride, attempt, 'accepted'); // gone from every other driver
  return { code: 200, body: { ok: true, rideId: ride.rideId, acceptedBy: driver } };
}

async function reject(ride, driver) {
  ride.rejectedBy.push(driver);
  event(ride, 'rejected', { driver });
  const attempt = current(ride);
  // One by one: the driver who had it skipped, so it moves on. All at once: the others may still accept.
  if (ride.mode === 'sequential' && ride.status === 'searching' && attempt?.outcome === 'pending') {
    attempt.outcome = 'rejected';
    await withdraw(ride, attempt, 'rejected');
    await next(ride);
  }
}

async function cancel(ride) {
  if (ride.status !== 'searching') return false;
  ride.status = 'cancelled';
  event(ride, 'cancelled');
  await withdraw(ride, current(ride), 'cancelled');
  return true;
}

// ---- HTTP ----

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { resolve({ raw: text }); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','rides','r_1','accept']

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,x-driver-id',
      });
      return res.end();
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
    }
    if (parts[0] !== 'api') return send(res, 404, { ok: false, reason: 'not found' });

    if (req.method === 'GET' && parts[1] === 'logs') return send(res, 200, logs);
    if (req.method === 'GET' && parts[1] === 'rides' && !parts[2]) {
      return send(res, 200, [...rides.values()].reverse());
    }
    if (req.method === 'POST' && parts[1] === 'rides' && !parts[2]) {
      return send(res, 201, await createRide(await readBody(req)));
    }

    const ride = parts[1] === 'rides' && parts[2] ? rides.get(parts[2]) : null;
    if (parts[1] === 'rides' && parts[2] && !ride) return send(res, 404, { ok: false, reason: 'unknown ride' });
    if (req.method === 'GET' && ride && !parts[3]) return send(res, 200, ride);

    if (req.method === 'POST' && ride) {
      const body = await readBody(req);
      const action = parts[3];
      if (action === 'accept' || action === 'reject') {
        // What the app's chain sent, to check variables / cookies / headers.
        logs.unshift({ at: now(), rideId: ride.rideId, action, headers: req.headers, query: Object.fromEntries(url.searchParams), body });
        logs.length = Math.min(logs.length, MAX_LOGS);
      }
      const driver = driverOf(req, body, ride);
      if (action === 'accept') {
        const result = await accept(ride, driver);
        return send(res, result.code, result.body);
      }
      if (action === 'reject') {
        await reject(ride, driver);
        return send(res, 200, { ok: true });
      }
      if (action === 'cancel') {
        return (await cancel(ride)) ? send(res, 200, { ok: true }) : send(res, 409, { ok: false, reason: `ride ${ride.status}` });
      }
      if (action === 'withdraw') { // manual withdraw of the latest request, any status
        const attempt = current(ride);
        if (attempt) attempt.withdrawn = false;
        await withdraw(ride, attempt, 'manual');
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { ok: false, reason: 'not found' });
  } catch (e) {
    send(res, 500, { ok: false, reason: e.message });
  }
});

if (require.main === module) {
  if (!W2N_API_KEY || !W2N_API_SECRET) console.warn('W2N_API_KEY / W2N_API_SECRET not set: W2N calls will be rejected');
  server.listen(PORT, () => console.log(`rapido-sim on :${PORT} → ${W2N_API_BASE} (app ${APP_ID})`));
}

module.exports = { server };
