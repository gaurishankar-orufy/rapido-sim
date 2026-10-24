// Smoke check against a fake W2N. All at once: three drivers accept together → one wins, withdrawn once.
// One by one: d1 skips → withdrawn, offered to d2 → d2 accepts.
const http = require('node:http');
const assert = require('node:assert');

const calls = [];
let nextId = 1;
const fakeW2n = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ path: req.url, body: JSON.parse(body || '{}'), key: req.headers['x-api-key'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('/send')
      ? { isSuccess: true, requestId: `req_${nextId++}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), platforms: ['android'] }
      : { isSuccess: true }));
  });
});

const user = (id) => [{ type: 'USER', field: 'EXTERNAL_USER_ID', operator: 'IS', value: id }];

fakeW2n.listen(0, async () => {
  process.env.W2N_API_BASE = `http://127.0.0.1:${fakeW2n.address().port}/api`;
  process.env.W2N_API_KEY = 'k';
  process.env.W2N_API_SECRET = 's';
  const { server } = require('./server');
  server.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body = {}, headers = {}) =>
      fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const get = async (p) => (await fetch(base + p)).json();

    // ---- All at once ----
    const b = await (await post('/api/rides', { screen_id: 'incoming_call', drivers: ['d1', 'd2', 'd3'], data: { order_id: 'A1', ride_id: 'spoofed' } })).json();
    assert.equal(b.mode, 'broadcast');
    const sent = calls.at(-1);
    assert.equal(sent.path, '/api/action-screen/send');
    assert.equal(sent.key, 'k');
    assert.deepEqual(sent.body.audience, { type: 'SPECIFIC', groups: [user('d1'), user('d2'), user('d3')] });
    assert.equal(sent.body.data.ride_id, b.rideId, 'server-made ride_id wins over the one in data');
    assert.equal(sent.body.data.order_id, 'A1');

    const answers = await Promise.all(['d1', 'd2', 'd3'].map((d) => post(`/api/rides/${b.rideId}/accept`, {}, { cookie: `driver_id=${d}` })));
    assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409, 409], 'exactly one accept wins');
    const bFinal = await get(`/api/rides/${b.rideId}`);
    assert.equal(bFinal.status, 'accepted');
    const bWithdraws = calls.filter((c) => c.path === `/api/action-screen/${bFinal.attempts[0].requestId}/withdraw`);
    assert.equal(bWithdraws.length, 1, 'withdrawn once');
    assert.equal(bWithdraws[0].body.appId, '6a3ba941db31e8b79fc3aa12');
    assert.equal((await post(`/api/rides/${b.rideId}/cancel`)).status, 409, 'an accepted ride cannot be cancelled');

    // ---- One by one ----
    const s = await (await post('/api/rides', { screen_id: 'incoming_call', mode: 'sequential', drivers: ['d1', 'd2'], data: {} })).json();
    assert.equal(s.mode, 'sequential');
    assert.deepEqual(calls.at(-1).body.audience.groups, [user('d1')]);
    assert.equal(calls.at(-1).body.data.driver_id, 'd1');
    const firstRequest = s.attempts[0].requestId;

    await post(`/api/rides/${s.rideId}/reject`); // d1 skips (identified as the driver it was offered to)
    assert.ok(calls.some((c) => c.path === `/api/action-screen/${firstRequest}/withdraw`), "d1's request withdrawn");
    assert.deepEqual(calls.at(-1).body.audience.groups, [user('d2')], 'offered to d2 next');

    assert.equal((await post(`/api/rides/${s.rideId}/accept`)).status, 200);
    const sFinal = await get(`/api/rides/${s.rideId}`);
    assert.equal(sFinal.status, 'accepted');
    assert.equal(sFinal.acceptedBy, 'd2');
    assert.deepEqual(sFinal.rejectedBy, ['d1']);

    // A list that runs out → no_drivers.
    const e = await (await post('/api/rides', { mode: 'sequential', drivers: ['x1'], data: {} })).json();
    await post(`/api/rides/${e.rideId}/reject`);
    assert.equal((await get(`/api/rides/${e.rideId}`)).status, 'no_drivers');

    console.log(`smoke OK: all at once → one winner (${bFinal.acceptedBy}); one by one → d1 skipped, d2 accepted; list exhausted → no_drivers`);
    server.close();
    fakeW2n.close();
  });
});
