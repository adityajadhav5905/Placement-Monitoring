/**
 * compare_endpoints.js
 *
 * Requires both servers to already be running before this script is executed:
 *   - Express server:    node server.js   (port 5000)
 *   - Wrangler dev:      npx wrangler dev (port 8787)
 *
 * Usage:
 *   node compare_endpoints.js
 */

import pool from './db.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EXPRESS_URL = 'http://127.0.0.1:5000';
const WORKER_URL  = 'http://127.0.0.1:8787';
const API_KEY     = process.env.API_KEY || 'fca62d64a27546855b39922e967a1fb53086eb293c66f7f6a7cd67f8976a4dfc';

let testsPassed = 0;
let testsFailed  = 0;

function pass(name) { console.log(`  [PASS] ${name}`); testsPassed++; }
function fail(name, details = '') { console.error(`  [FAIL] ${name}${details ? ' — ' + details : ''}`); testsFailed++; }

async function waitFor(url, label, attempts = 15) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.status === 200) { console.log(`  ✓ ${label} is up (${url})`); return true; }
    } catch (_) {}
    await sleep(1000);
  }
  return false;
}

async function compareEndpoints() {
  const routes = [
    '/health',
    '/api/companies',
    '/api/students',
    '/api/stats/overview',
    '/api/stats/analytics',
    '/api/companies/list',
    '/api/reports/placements',
    '/api/reports/branches-stats',
  ];

  // Endpoints to skip strict schema comparison (internal/monitoring endpoints
  // may intentionally add extra fields like mode, timestamp in the Worker)
  const schemaExcluded = new Set(['/health']);

  for (const path of routes) {
    let expRes, wrkRes, expBody, wrkBody;
    try {
      [expRes, wrkRes] = await Promise.all([
        fetch(`${EXPRESS_URL}${path}`),
        fetch(`${WORKER_URL}${path}`),
      ]);
      [expBody, wrkBody] = await Promise.all([
        expRes.json(),
        wrkRes.json(),
      ]);
    } catch (err) {
      fail(`GET ${path}`, err.message);
      continue;
    }

    if (expRes.status === wrkRes.status) {
      pass(`GET ${path}  status ${expRes.status}`);
    } else {
      fail(`GET ${path}  status`, `Express=${expRes.status} Worker=${wrkRes.status}`);
      console.log('    Express body:', JSON.stringify(expBody).slice(0, 200));
      console.log('    Worker body :', JSON.stringify(wrkBody).slice(0, 200));
      continue;
    }

    // Compare top-level JSON keys — skip for internal monitoring endpoints
    if (!schemaExcluded.has(path)) {
      const expKeys = Array.isArray(expBody)
        ? (expBody.length > 0 ? Object.keys(expBody[0]).sort().join(',') : '(empty array)')
        : Object.keys(expBody).sort().join(',');
      const wrkKeys = Array.isArray(wrkBody)
        ? (wrkBody.length > 0 ? Object.keys(wrkBody[0]).sort().join(',') : '(empty array)')
        : Object.keys(wrkBody).sort().join(',');

      if (expKeys === wrkKeys) {
        pass(`GET ${path}  schema "${expKeys.slice(0,80)}"`);
      } else {
        fail(`GET ${path}  schema`, `\n    Express: ${expKeys}\n    Worker : ${wrkKeys}`);
      }
    } else {
      pass(`GET ${path}  schema (excluded — internal endpoint)`);
    }
  }
}

async function testMutationAuth() {
  // Should be rejected without API key
  const [expRej, wrkRej] = await Promise.all([
    fetch(`${EXPRESS_URL}/api/companies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    fetch(`${WORKER_URL}/api/companies`,  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  ]);
  (expRej.status === 401 && wrkRej.status === 401)
    ? pass('POST /api/companies without API key → 401 on both')
    : fail('POST /api/companies without API key → 401', `Express=${expRej.status} Worker=${wrkRej.status}`);

  // Should succeed with API key
  const tempName = `TestCompare_${Date.now()}`;
  const [expOk, wrkOk] = await Promise.all([
    fetch(`${EXPRESS_URL}/api/companies`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY }, body: JSON.stringify({ company_name: tempName + '_Exp' }) }),
    fetch(`${WORKER_URL}/api/companies`,  { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY }, body: JSON.stringify({ company_name: tempName + '_Wrk' }) }),
  ]);

  const [expData, wrkData] = await Promise.all([expOk.json(), wrkOk.json()]);

  (expOk.status === 211 && wrkOk.status === 211)
    ? pass('POST /api/companies with API key → 211 on both')
    : fail('POST /api/companies with API key → 211', `Express=${expOk.status} Worker=${wrkOk.status}`);

  // Cleanup
  const idsToDelete = [expData.company_id, wrkData.company_id].filter(Boolean);
  if (idsToDelete.length > 0) {
    try {
      await pool.query(`DELETE FROM companies WHERE company_id IN (${idsToDelete.map(() => '?').join(',')})`, idsToDelete);
      console.log(`  (cleaned up ${idsToDelete.length} test rows)`);
    } catch (err) {
      console.warn('  Warning: cleanup failed:', err.message);
    }
  }

  // Test invalid body → 400 on both
  const [expBad, wrkBad] = await Promise.all([
    fetch(`${EXPRESS_URL}/api/companies`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY }, body: '{"company_name":""}' }),
    fetch(`${WORKER_URL}/api/companies`,  { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY }, body: '{"company_name":""}' }),
  ]);
  (expBad.status === 400 && wrkBad.status === 400)
    ? pass('POST /api/companies with empty name → 400 on both')
    : fail('POST /api/companies with empty name → 400', `Express=${expBad.status} Worker=${wrkBad.status}`);
}

async function main() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  Placement Monitoring — Backend vs Worker E2E');
  console.log('══════════════════════════════════════════════\n');

  console.log('Checking servers are up...');
  const [expUp, wrkUp] = await Promise.all([
    waitFor(EXPRESS_URL, 'Express (port 5000)'),
    waitFor(WORKER_URL,  'Wrangler dev (port 8787)'),
  ]);

  if (!expUp) { console.error('\n✖ Express server is not running on port 5000. Start it with: node server.js'); process.exit(1); }
  if (!wrkUp) { console.error('\n✖ Wrangler dev is not running on port 8787. Start it with: npx wrangler dev'); process.exit(1); }

  console.log('\n── GET endpoint comparison ──');
  await compareEndpoints();

  console.log('\n── Mutation / auth tests ──');
  await testMutationAuth();

  await pool.end();

  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  PASSED: ${testsPassed}   FAILED: ${testsFailed}`);
  console.log(`══════════════════════════════════════════════\n`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
