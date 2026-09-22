const DEPLOYED_URL = 'https://placement-monitoring-backend-production.adityajadhav5905.workers.dev';
const API_KEY = 'fca62d64a27546855b39922e967a1fb53086eb293c66f7f6a7cd67f8976a4dfc';

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  [PASS] ${msg}`); passed++; }
function fail(msg, err) { console.error(`  [FAIL] ${msg} ${err ? '— ' + err : ''}`); failed++; }

async function run() {
  console.log(`\n=== VERIFYING LIVE DEPLOYED WORKER AT: ${DEPLOYED_URL} ===\n`);

  // 1. GET /health
  try {
    const res = await fetch(`${DEPLOYED_URL}/health`);
    const data = await res.json();
    if (res.status === 200 && data.status === 'OK' && data.database === 'Connected') {
      pass(`GET /health: Status 200 OK (database: ${data.database}, mode: ${data.mode})`);
    } else {
      fail('GET /health', JSON.stringify(data));
    }
  } catch (e) {
    fail('GET /health error', e.message);
  }

  // 2. Unauthenticated MCP request (should be 401)
  try {
    const res = await fetch(`${DEPLOYED_URL}/mcp`, {
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
      pass('Unauthenticated POST /mcp correctly rejected with 401 Unauthorized');
    } else {
      fail('Unauthenticated POST /mcp', `Expected 401, got ${res.status}`);
    }
  } catch (e) {
    fail('Unauthenticated POST /mcp error', e.message);
  }

  // 3. Authenticated MCP tool discovery (tools/list)
  let toolCount = 0;
  try {
    const res = await fetch(`${DEPLOYED_URL}/mcp`, {
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
        const tools = parsed.result?.tools || [];
        toolCount = tools.length;
        pass(`Authenticated MCP tool discovery succeeded: ${toolCount} tools registered`);
      } else {
        fail('MCP tools/list SSE data parsing', text);
      }
    } else {
      fail('MCP tools/list request', `Status ${res.status}: ${text}`);
    }
  } catch (e) {
    fail('MCP tools/list error', e.message);
  }

  // 4. Authenticated MCP ping tool call
  try {
    const res = await fetch(`${DEPLOYED_URL}/mcp`, {
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
      pass('MCP ping tool call returned active status confirmation');
    } else {
      fail('MCP ping tool call', text);
    }
  } catch (e) {
    fail('MCP ping tool call error', e.message);
  }

  // 5. Authenticated MCP mutation: create_company tool
  const tempCompName = `Live_MCP_Verification_${Date.now()}`;
  let createdCompId = null;
  try {
    const res = await fetch(`${DEPLOYED_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'create_company',
          arguments: {
            company_name: tempCompName
          }
        }
      })
    });
    const text = await res.text();
    if (res.status === 200 && text.includes('Company created successfully')) {
      pass('Authenticated mutation through MCP create_company succeeded (211 response)');
      const match = text.match(/ID:\s*(\d+)/);
      if (match) createdCompId = parseInt(match[1]);
    } else {
      fail('MCP create_company mutation', text);
    }
  } catch (e) {
    fail('MCP create_company mutation error', e.message);
  }

  // 6. Authenticated MCP mutation cleanup: delete_company tool
  if (createdCompId) {
    try {
      const res = await fetch(`${DEPLOYED_URL}/mcp`, {
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
            name: 'delete_company',
            arguments: {
              company_id: createdCompId
            }
          }
        })
      });
      const text = await res.text();
      if (res.status === 200 && text.includes('deleted successfully')) {
        pass(`Authenticated MCP delete_company cleaned up test company ID ${createdCompId}`);
      } else {
        fail('MCP delete_company cleanup', text);
      }
    } catch (e) {
      fail('MCP delete_company cleanup error', e.message);
    }
  }

  // 7. Existing REST GET endpoints
  try {
    const res = await fetch(`${DEPLOYED_URL}/api/companies`);
    const data = await res.json();
    if (res.status === 200 && Array.isArray(data)) {
      pass(`REST GET /api/companies returned ${data.length} companies`);
    } else {
      fail('REST GET /api/companies', `Status ${res.status}`);
    }
  } catch (e) {
    fail('REST GET /api/companies error', e.message);
  }

  try {
    const res = await fetch(`${DEPLOYED_URL}/api/stats/overview`);
    const data = await res.json();
    if (res.status === 200 && data.totalCompanies !== undefined) {
      pass(`REST GET /api/stats/overview returned stats (Total Companies: ${data.totalCompanies}, Total Drives: ${data.totalDrives})`);
    } else {
      fail('REST GET /api/stats/overview', `Status ${res.status}`);
    }
  } catch (e) {
    fail('REST GET /api/stats/overview error', e.message);
  }

  console.log(`\n=== LIVE VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
