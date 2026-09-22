// Writes that come from a page on another site are refused; tools and same-site pages are not affected.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const harness = require('../test-support/harness');

const send = (base, method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
  });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});
const login = { username: 'owner', password: 'ownerpass123' };

test('cross-origin writes are refused, same-origin and header-less ones work', async () => {
  const h = await harness.start();
  try {
    const host = new URL(h.base).host;
    const evil = await send(h.base, 'POST', '/api/login', { headers: { Origin: 'https://evil.example' }, body: login });
    assert.equal(evil.status, 403);
    assert.ok(!evil.headers['set-cookie'], 'no session is created for a foreign page');
    assert.equal((await send(h.base, 'POST', '/api/login', { headers: { Origin: `http://${host}` }, body: login })).status, 200);
    const plain = await send(h.base, 'POST', '/api/login', { body: login });
    assert.equal(plain.status, 200, 'a request without Origin still works');
    const cookie = plain.headers['set-cookie'][0].split(';')[0];
    const attack = { headers: { Cookie: cookie, Origin: 'https://evil.example' } };
    assert.equal((await send(h.base, 'POST', '/api/instances', { ...attack, body: { name: 'x', port: 25999 } })).status, 403);
    assert.equal((await send(h.base, 'DELETE', `/api/instances/${h.inst.id}`, attack)).status, 403);
    assert.equal((await send(h.base, 'GET', '/api/instances', attack)).status, 200, 'reads are not affected');
  } finally { await h.stop(); }
});
