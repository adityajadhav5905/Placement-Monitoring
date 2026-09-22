import pool from './db.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WORKER_URL = 'http://127.0.0.1:8787';
const API_KEY = process.env.API_KEY || 'fca62d64a27546855b39922e967a1fb53086eb293c66f7f6a7cd67f8976a4dfc';

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  [PASS] ${msg}`); passed++; }
function fail(msg, err) { console.error(`  [FAIL] ${msg} ${err ? '— ' + err : ''}`); failed++; }

async function run() {
  console.log('\n=== TESTING WORKER REMOTE MCP & REST ENDPOINTS ===\n');

  // 1. Health check
  try {
    const res = await fetch(`${WORKER_URL}/health`);
    const data = await res.json();
    if (res.status === 200 && data.status === 'OK') {
      pass('GET /health returned 200 OK');
    } else {
      fail('GET /health', JSON.stringify(data));
    }
  } catch (e) {
    fail('GET /health error', e.message);
  }

  // 2. Unauthenticated MCP request (should be 401)
  try {
    const res = await fetch(`${WORKER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      })
    });
    if (res.status === 401) {
      pass('POST /mcp without API Key rejected with 401 Unauthorized');
    } else {
      fail('POST /mcp without API Key', `Expected 401, got ${res.status}`);
    }
  } catch (e) {
    fail('POST /mcp unauth error', e.message);
  }

  // 3. Authenticated MCP tools/list
  let tools = [];
  try {
    const res = await fetch(`${WORKER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      })
    });

    const text = await res.text();
    if (res.status === 200) {
      const match = text.match(/data:\s*({.+})/);
      if (match) {
        const parsed = JSON.parse(match[1]);
        tools = parsed.result?.tools || [];
        pass(`POST /mcp tools/list discovered ${tools.length} MCP tools`);
      } else {
        fail('POST /mcp tools/list SSE parse', text);
      }
    } else {
      fail('POST /mcp tools/list', `Status ${res.status}: ${text}`);
    }
  } catch (e) {
    fail('POST /mcp tools/list error', e.message);
  }

  // 4. Test MCP ping tool
  try {
    const res = await fetch(`${WORKER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'ping',
          arguments: {}
        }
      })
    });
    const text = await res.text();
    if (res.status === 200 && text.includes('Placement Monitoring MCP Server is active')) {
      pass('POST /mcp call ping tool succeeded');
    } else {
      fail('POST /mcp call ping tool', text);
    }
  } catch (e) {
    fail('POST /mcp ping error', e.message);
  }

  // 5. Test MCP list_companies tool
  try {
    const res = await fetch(`${WORKER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'list_companies',
          arguments: {}
        }
      })
    });
    const text = await res.text();
    if (res.status === 200 && text.includes('result')) {
      pass('POST /mcp call list_companies with Bearer auth succeeded');
    } else {
      fail('POST /mcp call list_companies', text);
    }
  } catch (e) {
    fail('POST /mcp list_companies error', e.message);
  }

  // 6. Test MCP mutation: create_company tool
  const tempName = `Test_MCP_Comp_${Date.now()}`;
  let createdCompId = null;
  try {
    const res = await fetch(`${WORKER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'create_company',
          arguments: {
            company_name: tempName
          }
        }
      })
    });
    const text = await res.text();
    if (res.status === 200 && text.includes('Company created successfully')) {
      pass('POST /mcp call create_company tool mutation succeeded');
      // Extract created company ID from text
      const idMatch = text.match(/ID:\s*(\d+)/);
      if (idMatch) createdCompId = parseInt(idMatch[1]);
    } else {
      fail('POST /mcp call create_company', text);
    }
  } catch (e) {
    fail('POST /mcp create_company error', e.message);
  }

  // 7. Cleanup created company if present
  if (createdCompId) {
    try {
      await pool.query('DELETE FROM companies WHERE company_id = ?', [createdCompId]);
      pass(`Cleaned up temporary test company ID ${createdCompId}`);
    } catch (e) {
      console.warn('Cleanup failed:', e.message);
    }
  }

  // 8. REST GET endpoints check
  try {
    const res = await fetch(`${WORKER_URL}/api/companies`);
    if (res.status === 200) {
      pass('REST GET /api/companies works as read-only');
    } else {
      fail('REST GET /api/companies', `status ${res.status}`);
    }
  } catch (e) {
    fail('REST GET /api/companies error', e.message);
  }

  await pool.end();

  console.log(`\n=== RESULTS: ${passed} PASSED, ${failed} FAILED ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
