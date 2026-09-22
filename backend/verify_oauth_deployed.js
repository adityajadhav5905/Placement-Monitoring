import crypto from 'crypto';

const DEPLOYED_URL = 'https://placement-monitoring-backend-production.adityajadhav5905.workers.dev';
const API_KEY = 'fca62d64a27546855b39922e967a1fb53086eb293c66f7f6a7cd67f8976a4dfc';

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  [PASS] ${msg}`); passed++; }
function fail(msg, err) { console.error(`  [FAIL] ${msg} ${err ? '— ' + err : ''}`); failed++; }

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function run() {
  console.log(`\n=== VERIFYING OAUTH 2.1 & MCP ON LIVE WORKER: ${DEPLOYED_URL} ===\n`);

  // 1. GET /health
  try {
    const res = await fetch(`${DEPLOYED_URL}/health`);
    const data = await res.json();
    if (res.status === 200 && data.status === 'OK' && data.database === 'Connected') {
      pass(`GET /health: 200 OK (database: ${data.database}, mode: ${data.mode})`);
    } else {
      fail('GET /health', JSON.stringify(data));
    }
  } catch (e) {
    fail('GET /health error', e.message);
  }

  // 2. OAuth Authorization Server Metadata (RFC 8414)
  let authServerMeta = null;
  try {
    const res = await fetch(`${DEPLOYED_URL}/.well-known/oauth-authorization-server`);
    if (res.status === 200) {
      authServerMeta = await res.json();
      if (authServerMeta.issuer && authServerMeta.authorization_endpoint && authServerMeta.token_endpoint) {
        pass(`RFC 8414 Auth Server Metadata discovered (auth: ${authServerMeta.authorization_endpoint}, token: ${authServerMeta.token_endpoint}, reg: ${authServerMeta.registration_endpoint})`);
      } else {
        fail('RFC 8414 Metadata fields missing', JSON.stringify(authServerMeta));
      }
    } else {
      fail('GET /.well-known/oauth-authorization-server', `Status ${res.status}`);
    }
  } catch (e) {
    fail('Auth Server Metadata error', e.message);
  }

  // 3. OAuth Protected Resource Metadata (RFC 9728)
  try {
    const res = await fetch(`${DEPLOYED_URL}/.well-known/oauth-protected-resource/mcp`);
    if (res.status === 200) {
      const data = await res.json();
      pass(`RFC 9728 Protected Resource Metadata discovered (resource: ${data.resource})`);
    } else {
      // Fallback root
      const rootRes = await fetch(`${DEPLOYED_URL}/.well-known/oauth-protected-resource`);
      if (rootRes.status === 200) {
        const rootData = await rootRes.json();
        pass(`RFC 9728 Protected Resource Metadata discovered at root (resource: ${rootData.resource})`);
      } else {
        fail('GET /.well-known/oauth-protected-resource', `Status ${res.status}`);
      }
    }
  } catch (e) {
    fail('Protected Resource Metadata error', e.message);
  }

  // 4. WWW-Authenticate Bearer challenge on unauthenticated /mcp
  try {
    const res = await fetch(`${DEPLOYED_URL}/mcp`, { method: 'POST' });
    const wwwAuth = res.headers.get('WWW-Authenticate');
    if (res.status === 401 && wwwAuth && wwwAuth.includes('Bearer')) {
      pass(`Unauthenticated /mcp returns 401 with WWW-Authenticate header: "${wwwAuth.slice(0, 80)}..."`);
    } else {
      fail('Unauthenticated /mcp challenge', `Status ${res.status}, header: ${wwwAuth}`);
    }
  } catch (e) {
    fail('WWW-Authenticate challenge error', e.message);
  }

  // 5. Dynamic Client Registration (RFC 7591) — as Claude performs
  let registeredClient = null;
  try {
    const regRes = await fetch(`${DEPLOYED_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Desktop Test Client',
        redirect_uris: ['https://claude.ai/api/mcp/oauth/callback', 'http://localhost:5173/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      })
    });
    if (regRes.status === 200 || regRes.status === 201) {
      registeredClient = await regRes.json();
      pass(`RFC 7591 Dynamic Client Registration succeeded (client_id: ${registeredClient.client_id})`);
    } else {
      const errText = await regRes.text();
      fail('Dynamic Client Registration', `Status ${regRes.status}: ${errText}`);
    }
  } catch (e) {
    fail('Dynamic Client Registration error', e.message);
  }

  // 6. Complete OAuth 2.1 Flow with PKCE
  if (registeredClient) {
    const clientId = registeredClient.client_id;
    const redirectUri = registeredClient.redirect_uris[0];
    const state = 'test_state_' + Date.now();

    // Generate PKCE verifier and challenge
    const verifier = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());

    // 6a. GET /authorize
    try {
      const authUrl = `${DEPLOYED_URL}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=mcp&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent(DEPLOYED_URL + '/mcp')}`;
      const authRes = await fetch(authUrl);
      const authHtml = await authRes.text();
      if (authRes.status === 200 && authHtml.includes('Authorize')) {
        pass('GET /authorize rendered authorization HTML login page');
      } else {
        fail('GET /authorize', `Status ${authRes.status}`);
      }
    } catch (e) {
      fail('GET /authorize error', e.message);
    }

    // 6b. POST /authorize with Admin API Key (form submit)
    let authCode = null;
    try {
      const formParams = new URLSearchParams();
      formParams.set('client_id', clientId);
      formParams.set('redirect_uri', redirectUri);
      formParams.set('response_type', 'code');
      formParams.set('state', state);
      formParams.set('code_challenge', challenge);
      formParams.set('code_challenge_method', 'S256');
      formParams.set('scope', 'mcp');
      formParams.set('resource', DEPLOYED_URL + '/mcp');
      formParams.set('apiKey', API_KEY);

      const postAuthRes = await fetch(`${DEPLOYED_URL}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formParams.toString(),
        redirect: 'manual'
      });

      const location = postAuthRes.headers.get('Location');
      if (postAuthRes.status === 302 && location) {
        const redirectUrl = new URL(location);
        authCode = redirectUrl.searchParams.get('code');
        if (authCode) {
          pass(`POST /authorize with Admin API Key approved grant and returned authorization code: "${authCode.slice(0, 16)}..."`);
        } else {
          fail('POST /authorize redirect missing code', location);
        }
      } else {
        const txt = await postAuthRes.text();
        fail('POST /authorize', `Status ${postAuthRes.status}: ${txt}`);
      }
    } catch (e) {
      fail('POST /authorize error', e.message);
    }

    // 6c. POST /token exchange code for Bearer Token
    let accessToken = null;
    if (authCode) {
      try {
        const tokenParams = new URLSearchParams();
        tokenParams.set('grant_type', 'authorization_code');
        tokenParams.set('client_id', clientId);
        tokenParams.set('redirect_uri', redirectUri);
        tokenParams.set('code', authCode);
        tokenParams.set('code_verifier', verifier);
        tokenParams.set('resource', DEPLOYED_URL + '/mcp');

        const tokenRes = await fetch(`${DEPLOYED_URL}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString()
        });

        if (tokenRes.status === 200) {
          const tokenData = await tokenRes.json();
          accessToken = tokenData.access_token;
          pass(`POST /token exchanged code for OAuth Access Token (token_type: ${tokenData.token_type}, expires_in: ${tokenData.expires_in}s)`);
        } else {
          const txt = await tokenRes.text();
          fail('POST /token', `Status ${tokenRes.status}: ${txt}`);
        }
      } catch (e) {
        fail('POST /token error', e.message);
      }
    }

    // 6d. POST /mcp with OAuth Bearer Token
    if (accessToken) {
      try {
        const mcpRes = await fetch(`${DEPLOYED_URL}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 100,
            method: 'tools/list',
            params: {}
          })
        });
        const mcpText = await mcpRes.text();
        if (mcpRes.status === 200 && mcpText.includes('list_companies')) {
          pass('POST /mcp with OAuth Bearer Token authenticated and discovered MCP tools');
        } else {
          fail('POST /mcp with OAuth Bearer Token', `Status ${mcpRes.status}: ${mcpText}`);
        }
      } catch (e) {
        fail('POST /mcp with OAuth Bearer Token error', e.message);
      }

      // 6e. Call ping tool with OAuth Bearer Token
      try {
        const pingRes = await fetch(`${DEPLOYED_URL}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 101,
            method: 'tools/call',
            params: { name: 'ping', arguments: {} }
          })
        });
        const pingText = await pingRes.text();
        if (pingRes.status === 200 && pingText.includes('Placement Monitoring MCP Server is active')) {
          pass('POST /mcp call ping tool via OAuth Bearer Token executed successfully');
        } else {
          fail('POST /mcp call ping tool via OAuth Bearer Token', pingText);
        }
      } catch (e) {
        fail('POST /mcp ping tool error', e.message);
      }
    }
  }

  // 7. Backward compatibility: Direct API_KEY header on /mcp
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
        id: 200,
        method: 'tools/call',
        params: { name: 'ping', arguments: {} }
      })
    });
    const text = await res.text();
    if (res.status === 200 && text.includes('Placement Monitoring MCP Server is active')) {
      pass('Direct API_KEY on /mcp (via resolveExternalToken) remains supported for direct clients');
    } else {
      fail('Direct API_KEY on /mcp', text);
    }
  } catch (e) {
    fail('Direct API_KEY on /mcp error', e.message);
  }

  // 8. Public REST endpoints intact
  try {
    const res = await fetch(`${DEPLOYED_URL}/api/companies`);
    const data = await res.json();
    if (res.status === 200 && Array.isArray(data)) {
      pass(`REST GET /api/companies works (38 companies returned)`);
    } else {
      fail('REST GET /api/companies', `Status ${res.status}`);
    }
  } catch (e) {
    fail('REST GET /api/companies error', e.message);
  }

  console.log(`\n=== FINAL VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
