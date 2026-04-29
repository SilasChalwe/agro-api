const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

test('health endpoint responds OK', async () => {
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
  const body = await res.json();
  server.close();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
});
