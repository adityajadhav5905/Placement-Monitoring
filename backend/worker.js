import { Hono } from 'hono';
import { cors } from 'hono/cors';
import mysql from 'mysql2/promise';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { OAuthProvider, AuthorizationError } from '@cloudflare/workers-oauth-provider';

const app = new Hono();

// Retrieve the per-request pool stored in Hono context
function getDbPool(c) {
  return c.get('pool');
}

async function ensureVisitorStatsTable(pool) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitor_stats (
        visit_date DATE NOT NULL,
        count INT NOT NULL DEFAULT 0,
        PRIMARY KEY (visit_date)
      )
    `);
  } catch (error) {
    console.error('Error ensuring visitor_stats table:', error);
  }
}

// Database Connection Middleware
// Creates a fresh mysql2 connection per request using Hyperdrive (or direct credentials in local dev)
// wrapped in a pool/connection interface compatible with all routes.
// Hyperdrive manages the underlying connection pool.
app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return await next();
  }

  const hyperdrive = c.env.HYPERDRIVE;
  const usingHyperdrive = !!hyperdrive;

  const config = usingHyperdrive
    ? {
        host: hyperdrive.host,
        port: hyperdrive.port ? parseInt(String(hyperdrive.port), 10) : 3306,
        user: hyperdrive.user,
        password: hyperdrive.password,
        database: hyperdrive.database,
        ssl: false,
        disableEval: true
      }
    : {
        host: c.env.DATABASE_HOST || c.env.DB_HOST || '127.0.0.1',
        port: parseInt(c.env.DATABASE_PORT || c.env.DB_PORT || '3306', 10),
        user: c.env.DATABASE_USER || c.env.DB_USER || 'root',
        password: c.env.DATABASE_PASSWORD || c.env.DB_PASSWORD,
        database: c.env.DATABASE_NAME || c.env.DB_NAME || 'placement_monitoring',
        ssl: false,
        disableEval: true
      };

  const connection = await mysql.createConnection(config);

  const pool = {
    query: (...args) => connection.query(...args),
    getConnection: async () => ({
      query: (...args) => connection.query(...args),
      beginTransaction: () => connection.beginTransaction(),
      commit: () => connection.commit(),
      rollback: () => connection.rollback(),
      ping: () => connection.ping(),
      release: () => {}
    })
  };

  // Store pool and connection mode in Hono context for this request
  c.set('pool', pool);
  c.set('usingHyperdrive', usingHyperdrive);

  await next();
});

// Helpers & Validations
const VALID_DEPARTMENTS = ['AIDS', 'CE', 'ECE', 'ENTC', 'IT'];

const normalizeDate = (dateStr) => {
  if (!dateStr) return null;
  if (typeof dateStr !== 'string') {
    if (dateStr instanceof Date && !isNaN(dateStr)) {
      return dateStr.toISOString().split('T')[0];
    }
    return null;
  }
  const trimmed = dateStr.trim();
  const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }
  const ymdMatch = trimmed.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = ymdMatch[2].padStart(2, '0');
    const day = ymdMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const d = new Date(trimmed);
  if (d instanceof Date && !isNaN(d.getTime())) {
    return d.toISOString().split('T')[0];
  }
  return null;
};

const validateDate = (dateStr) => {
  if (!dateStr) return true;
  return normalizeDate(dateStr) !== null;
};

const parseNumericCtc = (val) => {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') return isNaN(val) ? null : val;
  if (typeof val === 'string') {
    const match = val.replace(/,/g, '').match(/\d+(\.\d+)?/);
    if (match) return parseFloat(match[0]);
  }
  return null;
};

const isStrictNumber = (val) => {
  if (typeof val === 'number') return !isNaN(val);
  if (typeof val === 'string') {
    return parseNumericCtc(val) !== null;
  }
  return false;
};

const isStrictInt = (val) => {
  if (typeof val === 'number') return Number.isInteger(val);
  if (typeof val === 'string') {
    const num = parseNumericCtc(val);
    return num !== null && Number.isInteger(num);
  }
  return false;
};

const normalizeBranches = (branchesInput) => {
  if (!branchesInput) return [];
  let branchList = [];
  if (typeof branchesInput === 'string') {
    const upper = branchesInput.trim().toUpperCase();
    if (upper === 'ALL' || upper === 'ALL BRANCHES' || upper === 'ALL BRANCH' || upper === 'EVERY') {
      return [...VALID_DEPARTMENTS];
    }
    branchList = branchesInput.split(/[,\/|]/).map(b => b.trim());
  } else if (Array.isArray(branchesInput)) {
    for (const item of branchesInput) {
      if (typeof item === 'string') {
        const upper = item.trim().toUpperCase();
        if (upper === 'ALL' || upper === 'ALL BRANCHES' || upper === 'ALL BRANCH' || upper === 'EVERY') {
          return [...VALID_DEPARTMENTS];
        }
        branchList.push(item.trim());
      }
    }
  }

  const mapped = new Set();
  const aliasMap = {
    'AIDS': 'AIDS', 'AI': 'AIDS', 'DS': 'AIDS', 'AI&DS': 'AIDS', 'AI & DS': 'AIDS', 'ARTIFICIAL INTELLIGENCE': 'AIDS', 'DATA SCIENCE': 'AIDS',
    'CE': 'CE', 'CS': 'CE', 'CSE': 'CE', 'COMPUTER': 'CE', 'COMPUTER SCIENCE': 'CE', 'COMPUTER ENGINEERING': 'CE',
    'IT': 'IT', 'INFORMATION TECHNOLOGY': 'IT',
    'ENTC': 'ENTC', 'E&TC': 'ENTC', 'ETC': 'ENTC', 'ELECTRONICS & TELECOMMUNICATION': 'ENTC', 'ELECTRONICS AND TELECOMMUNICATION': 'ENTC',
    'ECE': 'ECE', 'ELECTRONICS': 'ECE', 'ELECTRONICS AND COMMUNICATION': 'ECE', 'ELECTRONICS & COMMUNICATION': 'ECE'
  };

  for (const b of branchList) {
    const upper = b.toUpperCase();
    if (VALID_DEPARTMENTS.includes(upper)) {
      mapped.add(upper);
    } else if (aliasMap[upper]) {
      mapped.add(aliasMap[upper]);
    }
  }

  return Array.from(mapped);
};


// Dynamic CORS Middleware
app.use('*', async (c, next) => {
  // Allow all origins for /mcp endpoint
  if (c.req.path === '/mcp' || c.req.path.startsWith('/mcp/')) {
    return await next();
  }

  const allowedOrigins = c.env.ALLOWED_ORIGINS 
    ? c.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [];

  const corsMiddleware = cors({
    origin: (origin) => {
      const isLocal = !origin || 
        /^http:\/\/localhost(:\d+)?$/.test(origin) || 
        /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
      const isAllowedProd = allowedOrigins.includes(origin);

      if (isLocal || isAllowedProd) {
        return origin;
      }
      return null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
  });

  return corsMiddleware(c, next);
});

// API Key Authentication Middleware for REST mutations
app.use('*', async (c, next) => {
  // Let OAuth routes and discovery endpoints handle their own flows
  const path = c.req.path;
  if (
    path === '/mcp' ||
    path.startsWith('/mcp/') ||
    path === '/authorize' ||
    path === '/token' ||
    path === '/register' ||
    path.startsWith('/.well-known/')
  ) {
    return await next();
  }

  if (['POST', 'PUT', 'DELETE'].includes(c.req.method)) {
    const apiKey = c.env.API_KEY;
    if (!apiKey) return await next();

    let clientKey = c.req.header('X-API-Key') || new URL(c.req.url).searchParams.get('apiKey');
    if (!clientKey && c.req.header('Authorization')) {
      const auth = c.req.header('Authorization');
      clientKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim();
    }

    if (clientKey === apiKey) return await next();

    return c.json({ error: 'Unauthorized: Invalid or missing API key' }, 401);
  }
  await next();
});

// 1. Get visited companies (Optimized to avoid Cartesian product)
app.get('/api/companies', async (c) => {
  const pool = getDbPool(c);
  try {
    const query = `
      SELECT 
        d.drive_id,
        c.company_name AS company,
        d.role,
        d.ctc,
        d.jd_link,
        d.eligibility_10th,
        d.eligibility_12th,
        d.eligibility_cgpa,
        d.eligibility_backlog,
        d.visiting_date,
        COALESCE(s_agg.first_placement_date, d.visiting_date) AS date,
        COALESCE(s_agg.students_placed, 0) AS students_placed,
        b_agg.eligible_branches
      FROM placement_drives d
      JOIN companies c ON d.company_id = c.company_id
      LEFT JOIN (
        SELECT drive_id, GROUP_CONCAT(branch ORDER BY branch SEPARATOR ', ') AS eligible_branches
        FROM branches
        GROUP BY drive_id
      ) b_agg ON d.drive_id = b_agg.drive_id
      LEFT JOIN (
        SELECT placed_drive_id, COUNT(*) AS students_placed, MIN(placement_date) AS first_placement_date
        FROM students
        WHERE placed_drive_id IS NOT NULL
        GROUP BY placed_drive_id
      ) s_agg ON d.drive_id = s_agg.placed_drive_id
      ORDER BY date DESC
    `;
    const [rows] = await pool.query(query);
    return c.json(rows);
  } catch (error) {
    console.error('Error fetching companies:', error);
    return c.json({ error: `Database error in /companies: ${error.message}` }, 500);
  }
});

// 2. Get placed students
app.get('/api/students', async (c) => {
  const pool = getDbPool(c);
  try {
    const query = `
      SELECT 
        s.student_id,
        s.student_first_name,
        s.student_last_name,
        CONCAT(s.student_first_name, ' ', s.student_last_name) AS student_name,
        s.email,
        s.department,
        c.company_name AS company_placed,
        d.role,
        d.ctc,
        s.placement_date AS date_placed
      FROM students s
      JOIN placement_drives d ON s.placed_drive_id = d.drive_id
      JOIN companies c ON d.company_id = c.company_id
      ORDER BY s.placement_date DESC
    `;
    const [rows] = await pool.query(query);
    return c.json(rows);
  } catch (error) {
    console.error('Error fetching students:', error);
    return c.json({ error: `Database error in /students: ${error.message}` }, 500);
  }
});

// 3. Get Overview Stats (Parallelized & Consolidated)
app.get('/api/stats/overview', async (c) => {
  const pool = getDbPool(c);
  try {
    // Parallelize independent overview queries
    const [
      [totalPlacedRows],
      [ctcRows],
      [drivesSummaryRows],
      [deptMaxCtcRows],
      _visitorUpdate
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM students WHERE placed_drive_id IS NOT NULL'),
      pool.query(`
        SELECT d.ctc 
        FROM students s 
        JOIN placement_drives d ON s.placed_drive_id = d.drive_id
        WHERE d.ctc IS NOT NULL
      `),
      pool.query(`
        SELECT 
          COUNT(*) AS totalDrives,
          COUNT(DISTINCT company_id) AS totalCompanies
        FROM placement_drives
      `),
      pool.query(`
        SELECT s.department, MAX(d.ctc) AS max_ctc 
        FROM students s 
        JOIN placement_drives d ON s.placed_drive_id = d.drive_id 
        WHERE s.department IS NOT NULL AND s.department IN ('AIDS', 'CE', 'ECE', 'ENTC', 'IT')
        GROUP BY s.department
      `),
      pool.query(`
        INSERT INTO visitor_stats (visit_date, count) 
        VALUES (CURDATE(), 1) 
        ON DUPLICATE KEY UPDATE count = count + 1
      `).catch(err => {
        console.error('Error with visitor stats update:', err.message);
        return null;
      })
    ]);

    const totalPlaced = totalPlacedRows[0]?.total || 0;
    const totalCompanies = drivesSummaryRows[0]?.totalCompanies || 0;
    const totalDrives = drivesSummaryRows[0]?.totalDrives || 0;
    const deptMaxCtc = deptMaxCtcRows || [];

    let highestCTC = 0;
    let averageCTC = 0;
    let medianCTC = 0;
    let modeCTC = 0;

    if (ctcRows.length > 0) {
      const ctcs = ctcRows.map(row => Number(row.ctc)).sort((a, b) => a - b);
      highestCTC = Math.max(...ctcs);
      const sum = ctcs.reduce((acc, val) => acc + val, 0);
      averageCTC = Number((sum / ctcs.length).toFixed(2));

      const mid = Math.floor(ctcs.length / 2);
      if (ctcs.length % 2 === 0) {
        medianCTC = Number(((ctcs[mid - 1] + ctcs[mid]) / 2).toFixed(2));
      } else {
        medianCTC = ctcs[mid];
      }

      const counts = {};
      let maxCount = 0;
      let modes = [];
      ctcs.forEach(val => {
        counts[val] = (counts[val] || 0) + 1;
        if (counts[val] > maxCount) {
          maxCount = counts[val];
          modes = [val];
        } else if (counts[val] === maxCount) {
          modes.push(val);
        }
      });
      modeCTC = modes[0];
    }

    // Retrieve visitor counts in a single unified query
    const [visitorSummaryRows] = await pool.query(`
      SELECT 
        COALESCE(SUM(count), 1) AS totalVisitors,
        COALESCE(MAX(CASE WHEN visit_date = CURDATE() THEN count END), 1) AS dailyVisitors
      FROM visitor_stats
    `).catch(() => [[{ totalVisitors: 1, dailyVisitors: 1 }]]);

    const dailyVisitors = visitorSummaryRows[0]?.dailyVisitors || 1;
    const totalVisitors = Number(visitorSummaryRows[0]?.totalVisitors) || 1;

    return c.json({
      totalPlaced,
      highestCTC,
      averageCTC,
      medianCTC,
      modeCTC,
      totalCompanies,
      totalDrives,
      deptMaxCtc,
      dailyVisitors,
      totalVisitors
    });
  } catch (error) {
    console.error('Error fetching overview stats:', error);
    return c.json({ error: `Database error in /overview: ${error.message}` }, 500);
  }
});

// 4. Get Analytics Stats (Parallelized)
app.get('/api/stats/analytics', async (c) => {
  const pool = getDbPool(c);
  try {
    const [
      [deptCounts],
      [deptAvgCtc],
      [companyCounts],
      [timelineTrends]
    ] = await Promise.all([
      pool.query(`
        SELECT department, COUNT(*) AS count 
        FROM students 
        WHERE placed_drive_id IS NOT NULL AND department IS NOT NULL AND department IN ('AIDS', 'CE', 'ECE', 'ENTC', 'IT')
        GROUP BY department
      `),
      pool.query(`
        SELECT s.department, ROUND(AVG(d.ctc), 2) AS avg_ctc 
        FROM students s 
        JOIN placement_drives d ON s.placed_drive_id = d.drive_id 
        WHERE s.department IS NOT NULL AND s.department IN ('AIDS', 'CE', 'ECE', 'ENTC', 'IT')
        GROUP BY s.department
      `),
      pool.query(`
        SELECT c.company_name AS company, COUNT(*) AS count 
        FROM students s 
        JOIN placement_drives d ON s.placed_drive_id = d.drive_id 
        JOIN companies c ON d.company_id = c.company_id 
        GROUP BY c.company_name
      `),
      pool.query(`
        SELECT DATE_FORMAT(visiting_date, '%Y-%m-%d') AS date, COUNT(*) AS count 
        FROM placement_drives 
        WHERE visiting_date IS NOT NULL
        GROUP BY visiting_date
        ORDER BY visiting_date ASC
      `)
    ]);

    return c.json({
      deptCounts,
      deptAvgCtc,
      companyCounts,
      timelineTrends
    });
  } catch (error) {
    console.error('Error fetching analytics stats:', error);
    return c.json({ error: error.message, stack: error.stack }, 500);
  }
});

// 5. Companies APIs
app.get('/api/companies/list', async (c) => {
  const pool = getDbPool(c);
  try {
    const [rows] = await pool.query('SELECT company_id, company_name FROM companies ORDER BY company_name ASC');
    return c.json(rows);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

app.get('/api/companies/search', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json([]);
  const pool = getDbPool(c);
  try {
    const [rows] = await pool.query(
      'SELECT company_id, company_name FROM companies WHERE company_name LIKE ?',
      [`%${q}%`]
    );
    return c.json(rows);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

app.get('/api/companies/:id', async (c) => {
  const id = c.req.param('id');
  const pool = getDbPool(c);
  try {
    const [rows] = await pool.query('SELECT company_id, company_name FROM companies WHERE company_id = ?', [id]);
    if (rows.length === 0) return c.json({ error: 'Company not found' }, 404);
    return c.json(rows[0]);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

app.post('/api/companies', async (c) => {
  const { company_name } = await c.req.json().catch(() => ({}));
  if (!company_name || typeof company_name !== 'string' || !company_name.trim()) {
    return c.json({ error: 'company_name is required' }, 400);
  }
  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT company_id FROM companies WHERE LOWER(company_name) = ?', [company_name.trim().toLowerCase()]);
    if (existing.length > 0) {
      await connection.rollback();
      return c.json({ error: 'Company already exists' }, 409);
    }
    const [result] = await connection.query('INSERT INTO companies (company_name) VALUES (?)', [company_name.trim()]);
    await connection.commit();
    return c.json({ success: true, company_id: result.insertId, company_name: company_name.trim() }, 211);
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

app.put('/api/companies/:id', async (c) => {
  const id = c.req.param('id');
  const { company_name } = await c.req.json().catch(() => ({}));
  if (!company_name || typeof company_name !== 'string' || !company_name.trim()) {
    return c.json({ error: 'company_name is required' }, 400);
  }
  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT company_id FROM companies WHERE company_id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Company not found' }, 404);
    }
    await connection.query('UPDATE companies SET company_name = ? WHERE company_id = ?', [company_name.trim(), id]);
    await connection.commit();
    return c.json({ success: true, company_id: Number(id), company_name: company_name.trim() });
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

app.delete('/api/companies/:id', async (c) => {
  const id = c.req.param('id');
  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT company_id FROM companies WHERE company_id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Company not found' }, 404);
    }
    const [drives] = await connection.query('SELECT drive_id FROM placement_drives WHERE company_id = ?', [id]);
    if (drives.length > 0) {
      await connection.rollback();
      return c.json({ error: 'Cannot delete company with active placement drives' }, 409);
    }
    await connection.query('DELETE FROM companies WHERE company_id = ?', [id]);
    await connection.commit();
    return c.json({ success: true, company_id: Number(id) });
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

// 6. Placement Drives APIs
app.get('/api/drives', async (c) => {
  const pool = getDbPool(c);
  try {
    const query = `
      SELECT 
        d.drive_id, d.company_id, c.company_name, d.visiting_date, d.role, d.jd_link,
        d.ctc, d.eligibility_10th, d.eligibility_12th, d.eligibility_cgpa, d.eligibility_backlog,
        GROUP_CONCAT(b.branch ORDER BY b.branch SEPARATOR ', ') AS branches
      FROM placement_drives d
      JOIN companies c ON d.company_id = c.company_id
      LEFT JOIN branches b ON d.drive_id = b.drive_id
      GROUP BY d.drive_id
      ORDER BY d.visiting_date DESC
    `;
    const [rows] = await pool.query(query);
    return c.json(rows);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

app.get('/api/drives/search', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json([]);
  const pool = getDbPool(c);
  try {
    const query = `
      SELECT d.drive_id, d.company_id, c.company_name, d.visiting_date, d.role, d.ctc
      FROM placement_drives d
      JOIN companies c ON d.company_id = c.company_id
      WHERE c.company_name LIKE ? OR d.role LIKE ?
    `;
    const [rows] = await pool.query(query, [`%${q}%`, `%${q}%`]);
    return c.json(rows);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

app.get('/api/drives/:id', async (c) => {
  const id = c.req.param('id');
  const pool = getDbPool(c);
  try {
    const query = `
      SELECT d.drive_id, d.company_id, c.company_name, d.visiting_date, d.role, d.jd_link,
             d.ctc, d.eligibility_10th, d.eligibility_12th, d.eligibility_cgpa, d.eligibility_backlog
      FROM placement_drives d
      JOIN companies c ON d.company_id = c.company_id
      WHERE d.drive_id = ?
    `;
    const [rows] = await pool.query(query, [id]);
    if (rows.length === 0) return c.json({ error: 'Drive not found' }, 404);
    return c.json(rows[0]);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

app.get('/api/companies/:id/drives', async (c) => {
  const company_id = c.req.param('id');
  const pool = getDbPool(c);
  try {
    const [rows] = await pool.query('SELECT drive_id, role, ctc, visiting_date FROM placement_drives WHERE company_id = ?', [company_id]);
    return c.json(rows);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

app.post('/api/drives', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    company_id, visiting_date, role, jd_link,
    ctc, eligibility_10th, eligibility_12th, eligibility_cgpa, eligibility_backlog
  } = body;

  if (!company_id) return c.json({ error: 'company_id is required' }, 400);
  if (visiting_date && !validateDate(visiting_date)) return c.json({ error: 'visiting_date is invalid' }, 400);
  if (ctc !== undefined && !isStrictNumber(ctc)) return c.json({ error: 'ctc must be a valid numeric value without units (e.g. 9.5)' }, 400);
  if (eligibility_10th !== undefined && !isStrictInt(eligibility_10th)) return c.json({ error: 'eligibility_10th must be a valid integer percentage without units (e.g. 68)' }, 400);
  if (eligibility_12th !== undefined && !isStrictInt(eligibility_12th)) return c.json({ error: 'eligibility_12th must be a valid integer percentage without units (e.g. 70)' }, 400);
  if (eligibility_cgpa !== undefined && !isStrictNumber(eligibility_cgpa)) return c.json({ error: 'eligibility_cgpa must be a valid numeric value without units (e.g. 8.5)' }, 400);

  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [company] = await connection.query('SELECT company_id FROM companies WHERE company_id = ?', [company_id]);
    if (company.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Company not found' }, 404);
    }
    const [result] = await connection.query(
      `INSERT INTO placement_drives (
        company_id, visiting_date, role, jd_link, ctc,
        eligibility_10th, eligibility_12th, eligibility_cgpa, eligibility_backlog
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        company_id, visiting_date || null, role || 'Software Engineer', jd_link || null,
        ctc !== undefined ? Number(ctc) : 1.00,
        eligibility_10th !== undefined ? Number(eligibility_10th) : 50,
        eligibility_12th !== undefined ? Number(eligibility_12th) : 50,
        eligibility_cgpa !== undefined ? Number(eligibility_cgpa) : 6.00,
        eligibility_backlog || null
      ]
    );
    await connection.commit();
    return c.json({ success: true, drive_id: result.insertId }, 211);
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

app.put('/api/drives/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const {
    visiting_date, role, jd_link, ctc,
    eligibility_10th, eligibility_12th, eligibility_cgpa, eligibility_backlog
  } = body;

  if (visiting_date !== undefined && visiting_date !== null && !validateDate(visiting_date)) return c.json({ error: 'visiting_date is invalid' }, 400);
  if (ctc !== undefined && ctc !== null && !isStrictNumber(ctc)) return c.json({ error: 'ctc must be a valid numeric value without units (e.g. 9.5)' }, 400);
  if (eligibility_10th !== undefined && eligibility_10th !== null && !isStrictInt(eligibility_10th)) return c.json({ error: 'eligibility_10th must be a valid integer percentage without units (e.g. 68)' }, 400);
  if (eligibility_12th !== undefined && eligibility_12th !== null && !isStrictInt(eligibility_12th)) return c.json({ error: 'eligibility_12th must be a valid integer percentage without units (e.g. 70)' }, 400);
  if (eligibility_cgpa !== undefined && eligibility_cgpa !== null && !isStrictNumber(eligibility_cgpa)) return c.json({ error: 'eligibility_cgpa must be a valid numeric value without units (e.g. 8.5)' }, 400);

  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT drive_id FROM placement_drives WHERE drive_id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Drive not found' }, 404);
    }
    await connection.query(
      `UPDATE placement_drives SET 
        visiting_date = COALESCE(?, visiting_date),
        role = COALESCE(?, role),
        jd_link = COALESCE(?, jd_link),
        ctc = COALESCE(?, ctc),
        eligibility_10th = COALESCE(?, eligibility_10th),
        eligibility_12th = COALESCE(?, eligibility_12th),
        eligibility_cgpa = COALESCE(?, eligibility_cgpa),
        eligibility_backlog = COALESCE(?, eligibility_backlog)
      WHERE drive_id = ?`,
      [
        visiting_date !== undefined ? visiting_date : null,
        role !== undefined ? role : null,
        jd_link !== undefined ? jd_link : null,
        ctc !== undefined ? (ctc !== null ? Number(ctc) : null) : null,
        eligibility_10th !== undefined ? (eligibility_10th !== null ? Number(eligibility_10th) : null) : null,
        eligibility_12th !== undefined ? (eligibility_12th !== null ? Number(eligibility_12th) : null) : null,
        eligibility_cgpa !== undefined ? (eligibility_cgpa !== null ? Number(eligibility_cgpa) : null) : null,
        eligibility_backlog !== undefined ? eligibility_backlog : null,
        id
      ]
    );
    await connection.commit();
    return c.json({ success: true, drive_id: Number(id) });
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

app.delete('/api/drives/:id', async (c) => {
  const id = c.req.param('id');
  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT drive_id FROM placement_drives WHERE drive_id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Drive not found' }, 404);
    }
    const [placed] = await connection.query('SELECT student_id FROM students WHERE placed_drive_id = ?', [id]);
    if (placed.length > 0) {
      await connection.rollback();
      return c.json({ error: 'Cannot delete drive with placed students. Unplace students first.' }, 409);
    }
    await connection.query('DELETE FROM branches WHERE drive_id = ?', [id]);
    await connection.query('DELETE FROM placement_drives WHERE drive_id = ?', [id]);
    await connection.commit();
    return c.json({ success: true, drive_id: Number(id) });
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

// 7. Branches APIs
app.get('/api/drives/:id/branches', async (c) => {
  const id = c.req.param('id');
  const pool = getDbPool(c);
  try {
    const [rows] = await pool.query('SELECT branch FROM branches WHERE drive_id = ?', [id]);
    return c.json(rows);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

app.post('/api/drives/:id/branches', async (c) => {
  const id = c.req.param('id');
  const { branch } = await c.req.json().catch(() => ({}));
  if (!branch || typeof branch !== 'string' || !branch.trim()) {
    return c.json({ error: 'branch is required' }, 400);
  }
  const bName = branch.trim().toUpperCase();
  if (!VALID_DEPARTMENTS.includes(bName)) {
    return c.json({ error: `Invalid department. Must be one of: ${VALID_DEPARTMENTS.join(', ')}` }, 400);
  }
  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [drive] = await connection.query('SELECT drive_id FROM placement_drives WHERE drive_id = ?', [id]);
    if (drive.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Drive not found' }, 404);
    }
    const [existing] = await connection.query('SELECT branch FROM branches WHERE drive_id = ? AND branch = ?', [id, bName]);
    if (existing.length > 0) {
      await connection.rollback();
      return c.json({ error: 'Branch mapping already exists' }, 409);
    }
    await connection.query('INSERT INTO branches (drive_id, branch) VALUES (?, ?)', [id, bName]);
    await connection.commit();
    return c.json({ success: true, drive_id: Number(id), branch: bName }, 211);
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

app.delete('/api/drives/:id/branches/:branch', async (c) => {
  const id = c.req.param('id');
  const branch = c.req.param('branch');
  const bName = branch.trim().toUpperCase();

  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT branch FROM branches WHERE drive_id = ? AND branch = ?', [id, bName]);
    if (existing.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Branch mapping not found' }, 404);
    }
    await connection.query('DELETE FROM branches WHERE drive_id = ? AND branch = ?', [id, bName]);
    await connection.commit();
    return c.json({ success: true, drive_id: Number(id), branch: bName });
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

// 8. Students APIs
app.get('/api/students/list', async (c) => {
  const pool = getDbPool(c);
  try {
    const [rows] = await pool.query('SELECT student_id, student_first_name, student_last_name, department FROM students');
    return c.json(rows);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

app.get('/api/students/search', async (c) => {
  const name = c.req.query('name');
  const student_name = c.req.query('student_name');
  const first_name = c.req.query('first_name') || c.req.query('student_first_name');
  const last_name = c.req.query('last_name') || c.req.query('student_last_name');
  const q = c.req.query('q');
  const email = c.req.query('email');
  const department = c.req.query('department');
  const placed = c.req.query('placed');
  const company_name = c.req.query('company_name');
  const drive_id = c.req.query('drive_id');

  const pool = getDbPool(c);
  try {
    let query = `
      SELECT s.*, d.role, d.ctc, c.company_name AS company_placed
      FROM students s
      LEFT JOIN placement_drives d ON s.placed_drive_id = d.drive_id
      LEFT JOIN companies c ON d.company_id = c.company_id
      WHERE 1=1
    `;
    const params = [];

    if (first_name && last_name) {
      query += ' AND (LOWER(s.student_first_name) LIKE ? AND LOWER(s.student_last_name) LIKE ?)';
      params.push(`%${first_name.trim().toLowerCase()}%`, `%${last_name.trim().toLowerCase()}%`);
    } else if (first_name) {
      query += ' AND LOWER(s.student_first_name) LIKE ?';
      params.push(`%${first_name.trim().toLowerCase()}%`);
    } else if (last_name) {
      query += ' AND LOWER(s.student_last_name) LIKE ?';
      params.push(`%${last_name.trim().toLowerCase()}%`);
    } else if (name || student_name || q) {
      const generalSearch = (name || student_name || q).trim();
      const parts = generalSearch.split(/\s+/);
      if (parts.length >= 2) {
        query += " AND ((LOWER(s.student_first_name) LIKE ? AND LOWER(s.student_last_name) LIKE ?) OR CONCAT(s.student_first_name, ' ', s.student_last_name) LIKE ? OR s.student_first_name LIKE ? OR s.student_last_name LIKE ?)";
        params.push(`%${parts[0].toLowerCase()}%`, `%${parts.slice(1).join(' ').toLowerCase()}%`, `%${generalSearch}%`, `%${generalSearch}%`, `%${generalSearch}%`);
      } else {
        query += " AND (CONCAT(s.student_first_name, ' ', s.student_last_name) LIKE ? OR s.student_first_name LIKE ? OR s.student_last_name LIKE ?)";
        params.push(`%${generalSearch}%`, `%${generalSearch}%`, `%${generalSearch}%`);
      }
    }

    if (email) {
      query += ' AND s.email LIKE ?';
      params.push(`%${email.trim()}%`);
    }
    if (department) {
      const dName = department.trim().toUpperCase();
      if (!VALID_DEPARTMENTS.includes(dName)) {
        return c.json({ error: 'Invalid department' }, 400);
      }
      query += ' AND s.department = ?';
      params.push(dName);
    }
    if (placed !== undefined) {
      if (placed === 'true') query += ' AND s.placed_drive_id IS NOT NULL';
      else if (placed === 'false') query += ' AND s.placed_drive_id IS NULL';
    }
    if (company_name) {
      query += ' AND c.company_name LIKE ?';
      params.push(`%${company_name.trim()}%`);
    }
    if (drive_id) {
      query += ' AND s.placed_drive_id = ?';
      params.push(Number(drive_id));
    }

    query += ' ORDER BY s.student_first_name, s.student_last_name ASC';
    const [rows] = await pool.query(query, params);
    return c.json(rows);
  } catch (error) {
    console.error('Error in /api/students/search:', error);
    return c.json({ error: `Database error: ${error.message || error}` }, 500);
  }
});

// Record placement unified smart endpoint
app.post('/api/students/record-placement', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    student_id, student_first_name, first_name,
    student_last_name, last_name, student_name, name,
    company_name, company_id, role, drive_id, placement_date
  } = body;

  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    let student = null;
    if (student_id) {
      const [rows] = await connection.query('SELECT * FROM students WHERE student_id = ?', [student_id]);
      if (rows.length > 0) student = rows[0];
    }

    const fName = (student_first_name || first_name || '').trim();
    const lName = (student_last_name || last_name || '').trim();
    const fullName = (student_name || name || '').trim();

    if (!student && fName && lName) {
      let [rows] = await connection.query(
        'SELECT * FROM students WHERE LOWER(student_first_name) = ? AND LOWER(student_last_name) = ?',
        [fName.toLowerCase(), lName.toLowerCase()]
      );
      if (rows.length === 0) {
        [rows] = await connection.query(
          'SELECT * FROM students WHERE LOWER(student_first_name) LIKE ? AND LOWER(student_last_name) LIKE ?',
          [`%${fName.toLowerCase()}%`, `%${lName.toLowerCase()}%`]
        );
      }
      if (rows.length > 0) student = rows[0];
    }

    if (!student && fullName) {
      const parts = fullName.split(/\s+/);
      if (parts.length >= 2) {
        let [rows] = await connection.query(
          'SELECT * FROM students WHERE LOWER(student_first_name) = ? AND LOWER(student_last_name) = ?',
          [parts[0].toLowerCase(), parts.slice(1).join(' ').toLowerCase()]
        );
        if (rows.length === 0) {
          [rows] = await connection.query(
            'SELECT * FROM students WHERE LOWER(student_first_name) LIKE ? AND LOWER(student_last_name) LIKE ?',
            [`%${parts[0].toLowerCase()}%`, `%${parts.slice(1).join(' ').toLowerCase()}%`]
          );
        }
        if (rows.length > 0) student = rows[0];
      }
      if (!student) {
        const [rows] = await connection.query(
          "SELECT * FROM students WHERE CONCAT(LOWER(student_first_name), ' ', LOWER(student_last_name)) LIKE ? OR LOWER(student_first_name) LIKE ? OR LOWER(student_last_name) LIKE ?",
          [`%${fullName.toLowerCase()}%`, `%${fullName.toLowerCase()}%`, `%${fullName.toLowerCase()}%`]
        );
        if (rows.length > 0) student = rows[0];
      }
    }

    if (!student) {
      await connection.rollback();
      return c.json({ error: `Student not found for name: "${fName} ${lName}" ${fullName ? `(${fullName})` : ''}`.trim() }, 404);
    }

    let resolvedDriveId = drive_id;
    let resolvedRole = role;
    let resolvedCompanyName = company_name;

    if (!resolvedDriveId) {
      let compId = company_id;
      if (!compId && company_name) {
        const trimmedComp = company_name.trim();
        let [compRows] = await connection.query(
          'SELECT * FROM companies WHERE LOWER(company_name) = ? OR LOWER(company_name) LIKE ? ORDER BY LENGTH(company_name) ASC',
          [trimmedComp.toLowerCase(), `%${trimmedComp.toLowerCase()}%`]
        );
        if (compRows.length > 0) {
          compId = compRows[0].company_id;
          resolvedCompanyName = compRows[0].company_name;
        } else {
          const [insComp] = await connection.query('INSERT INTO companies (company_name) VALUES (?)', [trimmedComp]);
          compId = insComp.insertId;
          resolvedCompanyName = trimmedComp;
        }
      }

      if (compId) {
        const [drives] = await connection.query(
          'SELECT * FROM placement_drives WHERE company_id = ? ORDER BY visiting_date DESC, drive_id DESC',
          [compId]
        );

        if (drives.length > 0) {
          let chosenDrive = null;
          if (role && role.trim()) {
            const rTrim = role.trim().toLowerCase();
            chosenDrive = drives.find(d => d.role && d.role.trim().toLowerCase() === rTrim) ||
                          drives.find(d => d.role && (d.role.toLowerCase().includes(rTrim) || rTrim.includes(d.role.toLowerCase())));
          }
          if (!chosenDrive) {
            chosenDrive = drives[0];
          }
          resolvedDriveId = chosenDrive.drive_id;
          resolvedRole = chosenDrive.role;
        } else {
          const [insDrive] = await connection.query(
            `INSERT INTO placement_drives (company_id, visiting_date, role, ctc, eligibility_10th, eligibility_12th, eligibility_cgpa)
             VALUES (?, ?, ?, 1.0, 50, 50, 6.00)`,
            [compId, normalizeDate(placement_date) || new Date().toISOString().slice(0, 10), role || 'Software Engineer']
          );
          resolvedDriveId = insDrive.insertId;
          resolvedRole = role || 'Software Engineer';
        }
      }
    } else {
      const [driveRows] = await connection.query(
        'SELECT d.*, c.company_name FROM placement_drives d JOIN companies c ON d.company_id = c.company_id WHERE d.drive_id = ?',
        [resolvedDriveId]
      );
      if (driveRows.length > 0) {
        resolvedRole = driveRows[0].role;
        resolvedCompanyName = driveRows[0].company_name;
      }
    }

    if (!resolvedDriveId) {
      await connection.rollback();
      return c.json({ error: 'Could not resolve a placement drive or company.' }, 400);
    }

    const pDate = normalizeDate(placement_date) || new Date().toISOString().slice(0, 10);

    await connection.query(
      'UPDATE students SET placed_drive_id = ?, placement_date = ? WHERE student_id = ?',
      [resolvedDriveId, pDate, student.student_id]
    );

    await connection.commit();

    return c.json({
      success: true,
      message: 'Student placement recorded successfully',
      student_id: student.student_id,
      student_name: `${student.student_first_name} ${student.student_last_name}`,
      company: resolvedCompanyName,
      role: resolvedRole,
      drive_id: resolvedDriveId,
      placement_date: pDate
    });
  } catch (error) {
    await connection.rollback();
    return c.json({ error: `Database error: ${error.message}` }, 500);
  } finally {
    connection.release();
  }
});

app.get('/api/students/:id', async (c) => {
  const id = c.req.param('id');
  const pool = getDbPool(c);
  try {
    const [rows] = await pool.query('SELECT student_id, student_first_name, student_last_name, email, department, placed_drive_id, placement_date FROM students WHERE student_id = ?', [id]);
    if (rows.length === 0) return c.json({ error: 'Student not found' }, 404);
    return c.json(rows[0]);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

app.post('/api/students', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rawFirstName = body.student_first_name !== undefined ? body.student_first_name : body.first_name;
  const rawLastName = body.student_last_name !== undefined ? body.student_last_name : body.last_name;
  const student_first_name = typeof rawFirstName === 'string' ? rawFirstName.trim() : rawFirstName;
  const student_last_name = typeof rawLastName === 'string' ? rawLastName.trim() : rawLastName;
  const { email, department, placement_date } = body;

  if (!student_first_name || typeof student_first_name !== 'string' || !student_first_name.trim()) return c.json({ error: 'student_first_name (or first_name) is required' }, 400);
  if (!student_last_name || typeof student_last_name !== 'string' || !student_last_name.trim()) return c.json({ error: 'student_last_name (or last_name) is required' }, 400);
  if (department) {
    const dName = department.trim().toUpperCase();
    if (!VALID_DEPARTMENTS.includes(dName)) {
      return c.json({ error: `department must be one of: ${VALID_DEPARTMENTS.join(', ')}` }, 400);
    }
  }
  if (placement_date && !validateDate(placement_date)) return c.json({ error: 'placement_date is invalid' }, 400);

  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO students (student_first_name, student_last_name, email, department, placement_date) VALUES (?, ?, ?, ?, ?)`,
      [
        student_first_name.trim(), student_last_name.trim(), email ? email.trim() : null,
        department ? department.trim().toUpperCase() : null,
        normalizeDate(placement_date) || null
      ]
    );
    await connection.commit();
    return c.json({ success: true, student_id: result.insertId }, 211);
  } catch (error) {
    await connection.rollback();
    return c.json({ error: `Database error: ${error.message || error}` }, 500);
  } finally {
    connection.release();
  }
});

app.put('/api/students/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const rawFirstName = body.student_first_name !== undefined ? body.student_first_name : body.first_name;
  const rawLastName = body.student_last_name !== undefined ? body.student_last_name : body.last_name;
  const student_first_name = typeof rawFirstName === 'string' ? rawFirstName.trim() : rawFirstName;
  const student_last_name = typeof rawLastName === 'string' ? rawLastName.trim() : rawLastName;
  const { email, department, placement_date } = body;

  if (department !== undefined && department !== null) {
    const dName = department.trim().toUpperCase();
    if (!VALID_DEPARTMENTS.includes(dName)) {
      return c.json({ error: `department must be one of: ${VALID_DEPARTMENTS.join(', ')}` }, 400);
    }
  }
  if (placement_date !== undefined && placement_date !== null && !validateDate(placement_date)) return c.json({ error: 'placement_date is invalid' }, 400);

  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT student_id FROM students WHERE student_id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Student not found' }, 404);
    }
    await connection.query(
      `UPDATE students SET 
        student_first_name = COALESCE(?, student_first_name),
        student_last_name = COALESCE(?, student_last_name),
        email = COALESCE(?, email),
        department = COALESCE(?, department),
        placement_date = COALESCE(?, placement_date)
      WHERE student_id = ?`,
      [
        student_first_name !== undefined ? student_first_name : null,
        student_last_name !== undefined ? student_last_name : null,
        email !== undefined ? (email ? email.trim() : null) : null,
        department !== undefined ? (department ? department.trim().toUpperCase() : null) : null,
        placement_date !== undefined ? normalizeDate(placement_date) : null,
        id
      ]
    );
    await connection.commit();
    return c.json({ success: true, student_id: Number(id) });
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

app.delete('/api/students/:id', async (c) => {
  const id = c.req.param('id');
  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT student_id FROM students WHERE student_id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Student not found' }, 404);
    }
    await connection.query('DELETE FROM students WHERE student_id = ?', [id]);
    await connection.commit();
    return c.json({ success: true, student_id: Number(id) });
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

// 9. Placement Actions APIs (Atomic Transactions)
app.post('/api/placement/place', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { student_id, drive_id, placement_date } = body;

  if (!student_id) return c.json({ error: 'student_id is required' }, 400);
  if (!drive_id) return c.json({ error: 'drive_id is required' }, 400);

  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [student] = await connection.query('SELECT student_id, student_first_name, student_last_name, department, placed_drive_id FROM students WHERE student_id = ?', [student_id]);
    if (student.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Student not found' }, 404);
    }
    const [drive] = await connection.query('SELECT d.*, c.company_name FROM placement_drives d JOIN companies c ON d.company_id = c.company_id WHERE d.drive_id = ?', [drive_id]);
    if (drive.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Placement drive not found' }, 404);
    }
    const pDate = normalizeDate(placement_date) || new Date().toISOString().slice(0, 10);
    await connection.query('UPDATE students SET placed_drive_id = ?, placement_date = ? WHERE student_id = ?', [drive_id, pDate, student_id]);
    await connection.commit();
    return c.json({
      success: true,
      student_id,
      student_name: `${student[0].student_first_name} ${student[0].student_last_name}`,
      company: drive[0].company_name,
      role: drive[0].role,
      drive_id,
      placement_date: pDate
    });
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

app.post('/api/students/place', async (c) => {
  return await app.fetch(new Request(new URL('/api/placement/place', c.req.url), c.req.raw), c.env, c.executionCtx);
});

app.post('/api/placement/unplace', async (c) => {
  const { student_id } = await c.req.json().catch(() => ({}));
  if (!student_id) return c.json({ error: 'student_id is required' }, 400);

  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [student] = await connection.query('SELECT student_id, placed_drive_id FROM students WHERE student_id = ?', [student_id]);
    if (student.length === 0) {
      await connection.rollback();
      return c.json({ error: 'Student not found' }, 404);
    }
    if (!student[0].placed_drive_id) {
      await connection.rollback();
      return c.json({ error: 'Student is not currently placed' }, 400);
    }
    await connection.query('UPDATE students SET placed_drive_id = NULL, placement_date = NULL WHERE student_id = ?', [student_id]);
    await connection.commit();
    return c.json({ success: true, student_id });
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

app.post('/api/students/unplace', async (c) => {
  return await app.fetch(new Request(new URL('/api/placement/unplace', c.req.url), c.req.raw), c.env, c.executionCtx);
});

// 10. Compound Setup API (Transactions)
app.post('/api/companies/setup', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    company_name, visiting_date, role, jd_link,
    ctc, eligibility_10th, eligibility_12th, eligibility_cgpa, eligibility_backlog,
    branches
  } = body;

  if (!company_name || typeof company_name !== 'string' || !company_name.trim()) {
    return c.json({ error: 'company_name is required' }, 400);
  }

  const normVisitingDate = normalizeDate(visiting_date) || new Date().toISOString().slice(0, 10);
  const numericCtc = parseNumericCtc(ctc) !== null ? parseNumericCtc(ctc) : 1;
  const numeric10th = parseNumericCtc(eligibility_10th) !== null ? Math.round(parseNumericCtc(eligibility_10th)) : 50;
  const numeric12th = parseNumericCtc(eligibility_12th) !== null ? Math.round(parseNumericCtc(eligibility_12th)) : 50;
  const numericCgpa = parseNumericCtc(eligibility_cgpa) !== null ? parseNumericCtc(eligibility_cgpa) : 6.00;
  const resolvedRole = (role && role.trim()) ? role.trim() : 'Software Engineer';
  const normalizedBranches = normalizeBranches(branches);

  const pool = getDbPool(c);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    let [compRows] = await connection.query('SELECT company_id, company_name FROM companies WHERE LOWER(company_name) = ?', [company_name.trim().toLowerCase()]);
    let companyId;
    if (compRows.length > 0) {
      companyId = compRows[0].company_id;
    } else {
      const [insertComp] = await connection.query('INSERT INTO companies (company_name) VALUES (?)', [company_name.trim()]);
      companyId = insertComp.insertId;
    }

    let [driveRows] = await connection.query(
      'SELECT drive_id FROM placement_drives WHERE company_id = ? AND LOWER(role) = ?',
      [companyId, resolvedRole.toLowerCase()]
    );

    let driveId;
    if (driveRows.length > 0) {
      driveId = driveRows[0].drive_id;
      await connection.query(
        `UPDATE placement_drives SET
          visiting_date = COALESCE(?, visiting_date),
          jd_link = COALESCE(?, jd_link),
          ctc = ?,
          eligibility_10th = ?,
          eligibility_12th = ?,
          eligibility_cgpa = ?,
          eligibility_backlog = COALESCE(?, eligibility_backlog)
        WHERE drive_id = ?`,
        [
          normVisitingDate,
          jd_link || null,
          numericCtc,
          numeric10th,
          numeric12th,
          numericCgpa,
          eligibility_backlog || null,
          driveId
        ]
      );
    } else {
      const [insertDrive] = await connection.query(
        `INSERT INTO placement_drives (
          company_id, visiting_date, role, jd_link, 
          ctc, eligibility_10th, eligibility_12th, eligibility_cgpa, eligibility_backlog
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          normVisitingDate,
          resolvedRole,
          jd_link || null,
          numericCtc,
          numeric10th,
          numeric12th,
          numericCgpa,
          eligibility_backlog || null
        ]
      );
      driveId = insertDrive.insertId;
    }

    if (normalizedBranches.length > 0) {
      await connection.query('DELETE FROM branches WHERE drive_id = ?', [driveId]);
      for (const branch of normalizedBranches) {
        await connection.query('INSERT INTO branches (drive_id, branch) VALUES (?, ?)', [driveId, branch]);
      }
    }

    await connection.commit();
    return c.json({
      success: true,
      company_id: companyId,
      company_name: company_name.trim(),
      drive_id: driveId,
      role: resolvedRole,
      ctc: numericCtc,
      branches: normalizedBranches
    }, 211);
  } catch (error) {
    await connection.rollback();
    return c.json({ error: 'Database error' }, 500);
  } finally {
    connection.release();
  }
});

// 11. Reports APIs
app.get('/api/reports/placements', async (c) => {
  const pool = getDbPool(c);
  try {
    const query = `
      SELECT 
        s.student_id,
        CONCAT(s.student_first_name, ' ', s.student_last_name) AS student_name,
        s.department AS branch,
        c.company_name AS company,
        d.role,
        d.ctc
      FROM students s
      JOIN placement_drives d ON s.placed_drive_id = d.drive_id
      JOIN companies c ON d.company_id = c.company_id
      ORDER BY s.placement_date DESC
    `;
    const [rows] = await pool.query(query);
    return c.json(rows);
  } catch (error) {
    console.error('Error fetching placements report:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

app.get('/api/reports/branches-stats', async (c) => {
  const pool = getDbPool(c);
  try {
    const query = `
      SELECT 
        s.department AS branch,
        COUNT(*) AS placed_count,
        ROUND(AVG(d.ctc), 2) AS average_ctc,
        MAX(d.ctc) AS max_ctc
      FROM students s
      JOIN placement_drives d ON s.placed_drive_id = d.drive_id
      GROUP BY s.department
      ORDER BY placed_count DESC
    `;
    const [rows] = await pool.query(query);
    return c.json(rows);
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
});

// Production health check endpoint
// Reports connection mode (Hyperdrive vs direct) without exposing credentials.
app.get('/health', async (c) => {
  const pool = getDbPool(c);
  const usingHyperdrive = c.get('usingHyperdrive');
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    return c.json({
      status: 'OK',
      database: 'Connected',
      mode: usingHyperdrive ? 'hyperdrive' : 'direct',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    return c.json({
      status: 'Error',
      error: 'Database connection failed',
      mode: usingHyperdrive ? 'hyperdrive' : 'direct',
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// ─── Remote MCP Endpoint & Tools ──────────────────────────────────────────

/** Helper: call an existing REST route internally, returning parsed JSON. */
async function callRoute(method, path, body, env, ctx, apiKey) {
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey || '',
  };
  const init = { method, headers };
  if (body !== undefined && body !== null) {
    init.body = JSON.stringify(body);
  }

  const req = new Request(`http://localhost${path}`, init);
  const res = await app.fetch(req, env, ctx);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function formatMcpResponse(status, json, successMsg = null) {
  if (status >= 400) {
    return {
      content: [{ type: 'text', text: `Error (${status}): ${json.error || JSON.stringify(json)}` }],
      isError: true,
    };
  }
  const text = successMsg || JSON.stringify(json, null, 2);
  return {
    content: [{ type: 'text', text }],
  };
}

/** Build and return a configured McpServer with all placement tools registered. */
function buildMcpServer(env, ctx) {
  const apiKey = env.API_KEY;

  const server = new McpServer({
    name: 'placement-monitoring',
    version: '1.0.0',
  });

  // Health / verification ping tool
  server.tool(
    'ping',
    'Verify Placement Monitoring MCP server connectivity and status.',
    {},
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ status: 'OK', message: 'Placement Monitoring MCP Server is active.', timestamp: new Date().toISOString() }, null, 2) }],
    })
  );

  // ── Companies Tools ───────────────────────────────────────────────────────

  server.tool(
    'list_companies',
    'Retrieve a list of all registered companies and their placement drives with student placement counts.',
    {},
    async () => {
      const { status, json } = await callRoute('GET', '/api/companies', null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'search_companies',
    'Search registered companies by name. Call this tool before creating drives or student placements to find the correct company_id.',
    {
      query: z.string().describe('Company name prefix or search keyword (e.g. "Google", "Micro")'),
    },
    async ({ query }) => {
      const { status, json } = await callRoute('GET', `/api/companies/search?q=${encodeURIComponent(query)}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'get_company',
    'Get details for a specific company by its company_id.',
    {
      company_id: z.number().int().describe('Company ID'),
    },
    async ({ company_id }) => {
      const { status, json } = await callRoute('GET', `/api/companies/${company_id}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'create_company',
    'Create a new company record. Before calling this, check if the company already exists using search_companies. DO NOT supply company_id (it is auto-generated). To register a company alongside its placement drive and branches in one action, use setup_company instead.',
    {
      company_name: z.string().describe('Name of the company to register'),
    },
    async ({ company_name }) => {
      const { status, json } = await callRoute('POST', '/api/companies', { company_name }, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 211 ? `Company created successfully. ID: ${json.company_id}, Name: ${json.company_name}` : null);
    }
  );

  server.tool(
    'add_company',
    'Alias for create_company: Add a new company record.',
    {
      company_name: z.string().describe('Name of the company to register'),
    },
    async ({ company_name }) => {
      const { status, json } = await callRoute('POST', '/api/companies', { company_name }, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 211 ? `Company added successfully. ID: ${json.company_id}, Name: ${json.company_name}` : null);
    }
  );

  server.tool(
    'update_company',
    'Update an existing company name by company_id. Caller must obtain the valid company_id first using search_companies.',
    {
      company_id: z.number().int().describe('Company ID to update'),
      company_name: z.string().describe('New company name'),
    },
    async ({ company_id, company_name }) => {
      const { status, json } = await callRoute('PUT', `/api/companies/${company_id}`, { company_name }, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Company ${company_id} updated to: ${json.company_name}` : null);
    }
  );

  server.tool(
    'delete_company',
    'Delete a company by company_id. Fails if the company has dependent placement drives. Obtain the company_id first using search_companies.',
    {
      company_id: z.number().int().describe('Company ID to delete'),
    },
    async ({ company_id }) => {
      const { status, json } = await callRoute('DELETE', `/api/companies/${company_id}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Company ${company_id} deleted successfully.` : null);
    }
  );

  // ── Placement Drives Tools ────────────────────────────────────────────────

  server.tool(
    'list_drives',
    'List all placement drives with eligibility, CTC, and branch information.',
    {},
    async () => {
      const { status, json } = await callRoute('GET', '/api/drives', null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'search_drives',
    'Search and filter placement drives by company, role, ctc, dates, or branch. Note: branch must be one of: AIDS, CE, ECE, ENTC, IT.',
    {
      company_id: z.number().int().optional().describe('Filter by Company ID'),
      company_name: z.string().optional().describe('Filter by Company Name'),
      role: z.string().optional().describe('Filter by role title'),
      min_ctc: z.number().optional().describe('Minimum CTC (LPA) as numeric value'),
      max_ctc: z.number().optional().describe('Maximum CTC (LPA) as numeric value'),
      start_date: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      end_date: z.string().optional().describe('End date (YYYY-MM-DD)'),
      branch: z.enum(['AIDS', 'CE', 'ECE', 'ENTC', 'IT']).optional().describe('Filter by eligible branch'),
    },
    async (params) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) query.set(key, String(value));
      }
      const qs = query.toString() ? `?${query.toString()}` : '';
      const { status, json } = await callRoute('GET', `/api/drives/search${qs}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'get_drive',
    'Get details of a specific placement drive by its drive_id.',
    {
      drive_id: z.number().int().describe('Drive ID'),
    },
    async ({ drive_id }) => {
      const { status, json } = await callRoute('GET', `/api/drives/${drive_id}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'get_company_drives',
    'Get all placement drives for a particular company_id.',
    {
      company_id: z.number().int().describe('Company ID'),
    },
    async ({ company_id }) => {
      const { status, json } = await callRoute('GET', `/api/companies/${company_id}/drives`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'create_drive',
    'Create a new placement drive. DO NOT supply drive_id. Numbers MUST be strictly numeric (no units like LPA, %, or CGPA). E.g., ctc: 9.5, eligibility_10th: 60, eligibility_12th: 60, eligibility_cgpa: 7.0.',
    {
      company_id: z.number().int().describe('Company ID (required)'),
      visiting_date: z.string().optional().describe('Date of visit (YYYY-MM-DD)'),
      role: z.string().optional().describe('Job profile title (e.g. "Software Engineer")'),
      jd_link: z.string().optional().describe('Job Description URL'),
      ctc: z.number().optional().describe('CTC in LPA (number only, e.g. 9.5)'),
      eligibility_10th: z.number().int().optional().describe('10th min percentage (number only, e.g. 60)'),
      eligibility_12th: z.number().int().optional().describe('12th min percentage (number only, e.g. 60)'),
      eligibility_cgpa: z.number().optional().describe('CGPA min criteria (number only, e.g. 7.0)'),
      eligibility_backlog: z.string().optional().describe('Backlog criteria policy'),
    },
    async (args) => {
      const { status, json } = await callRoute('POST', '/api/drives', args, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 211 ? `Drive created successfully. drive_id: ${json.drive_id}` : null);
    }
  );

  server.tool(
    'add_drive',
    'Alias for create_drive: Add a new placement drive.',
    {
      company_id: z.number().int().describe('Company ID (required)'),
      visiting_date: z.string().optional().describe('Date of visit (YYYY-MM-DD)'),
      role: z.string().optional().describe('Job profile title'),
      jd_link: z.string().optional().describe('JD link URL'),
      ctc: z.number().optional().describe('CTC in LPA (number only, e.g. 9.5)'),
      eligibility_10th: z.number().int().optional().describe('10th min percentage (e.g. 60)'),
      eligibility_12th: z.number().int().optional().describe('12th min percentage (e.g. 60)'),
      eligibility_cgpa: z.number().optional().describe('CGPA min criteria (e.g. 7.0)'),
      eligibility_backlog: z.string().optional().describe('Backlog criteria policy'),
    },
    async (args) => {
      const { status, json } = await callRoute('POST', '/api/drives', args, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 211 ? `Drive added successfully. drive_id: ${json.drive_id}` : null);
    }
  );

  server.tool(
    'update_drive',
    'Update an existing placement drive details. Only provided fields are updated. Numbers MUST be strictly numeric.',
    {
      drive_id: z.number().int().describe('Drive ID to update (required)'),
      company_id: z.number().int().optional().describe('Company ID'),
      visiting_date: z.string().optional().describe('Date of visit (YYYY-MM-DD)'),
      role: z.string().optional().describe('Job profile title'),
      jd_link: z.string().optional().describe('JD link URL'),
      ctc: z.number().optional().describe('CTC in LPA (number only, e.g. 10.5)'),
      eligibility_10th: z.number().int().optional().describe('10th min percentage (number only, e.g. 65)'),
      eligibility_12th: z.number().int().optional().describe('12th min percentage (number only, e.g. 65)'),
      eligibility_cgpa: z.number().optional().describe('CGPA min criteria (number only, e.g. 7.5)'),
      eligibility_backlog: z.string().optional().describe('Backlog criteria'),
    },
    async ({ drive_id, ...fields }) => {
      const { status, json } = await callRoute('PUT', `/api/drives/${drive_id}`, fields, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Drive ${drive_id} updated successfully.` : null);
    }
  );

  server.tool(
    'delete_drive',
    'Delete a placement drive by drive_id. Fails if students are currently placed in it — unplace them first.',
    {
      drive_id: z.number().int().describe('Drive ID to delete'),
    },
    async ({ drive_id }) => {
      const { status, json } = await callRoute('DELETE', `/api/drives/${drive_id}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Drive ${drive_id} deleted successfully.` : null);
    }
  );

  // ── Branches Tools ────────────────────────────────────────────────────────

  server.tool(
    'get_drive_branches',
    'Get eligible branches mapped to a drive_id.',
    {
      drive_id: z.number().int().describe('Drive ID'),
    },
    async ({ drive_id }) => {
      const { status, json } = await callRoute('GET', `/api/drives/${drive_id}/branches`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'add_branch',
    'Add an eligible branch to a drive_id. Branch must be one of: AIDS, CE, ECE, ENTC, IT.',
    {
      drive_id: z.number().int().describe('Drive ID'),
      branch: z.enum(['AIDS', 'CE', 'ECE', 'ENTC', 'IT']).describe('Branch code to add'),
    },
    async ({ drive_id, branch }) => {
      const { status, json } = await callRoute('POST', `/api/drives/${drive_id}/branches`, { branch }, env, ctx, apiKey);
      return formatMcpResponse(status, json, (status === 211 || status === 200) ? `Branch ${branch} added to drive ${drive_id}.` : null);
    }
  );

  server.tool(
    'add_branch_to_drive',
    'Alias for add_branch: Add an eligible branch to a drive_id.',
    {
      drive_id: z.number().int().describe('Drive ID'),
      branch: z.enum(['AIDS', 'CE', 'ECE', 'ENTC', 'IT']).describe('Branch code to add'),
    },
    async ({ drive_id, branch }) => {
      const { status, json } = await callRoute('POST', `/api/drives/${drive_id}/branches`, { branch }, env, ctx, apiKey);
      return formatMcpResponse(status, json, (status === 211 || status === 200) ? `Branch ${branch} added to drive ${drive_id}.` : null);
    }
  );

  server.tool(
    'remove_branch',
    'Remove an eligible branch from a drive_id. Branch must be one of: AIDS, CE, ECE, ENTC, IT.',
    {
      drive_id: z.number().int().describe('Drive ID'),
      branch: z.enum(['AIDS', 'CE', 'ECE', 'ENTC', 'IT']).describe('Branch code to remove'),
    },
    async ({ drive_id, branch }) => {
      const { status, json } = await callRoute('DELETE', `/api/drives/${drive_id}/branches/${encodeURIComponent(branch)}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Branch ${branch} removed from drive ${drive_id}.` : null);
    }
  );

  server.tool(
    'remove_branch_from_drive',
    'Alias for remove_branch: Remove an eligible branch from a drive_id.',
    {
      drive_id: z.number().int().describe('Drive ID'),
      branch: z.enum(['AIDS', 'CE', 'ECE', 'ENTC', 'IT']).describe('Branch code to remove'),
    },
    async ({ drive_id, branch }) => {
      const { status, json } = await callRoute('DELETE', `/api/drives/${drive_id}/branches/${encodeURIComponent(branch)}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Branch ${branch} removed from drive ${drive_id}.` : null);
    }
  );

  // ── Students Tools ────────────────────────────────────────────────────────

  server.tool(
    'list_students',
    'List all placed students with company, role, department, and CTC.',
    {},
    async () => {
      const { status, json } = await callRoute('GET', '/api/students', null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'search_students',
    'Search and filter students by name, first/last name, email, department, placement status, or company. Call this before placing or updating a student to obtain the correct student_id.',
    {
      name: z.string().optional().describe('Search by student full name or general query'),
      first_name: z.string().optional().describe('Search by student first name'),
      last_name: z.string().optional().describe('Search by student last name'),
      email: z.string().optional().describe('Search by email'),
      department: z.enum(['AIDS', 'CE', 'ECE', 'ENTC', 'IT']).optional().describe('Filter by department'),
      placed: z.enum(['true', 'false']).optional().describe('Filter by placement status'),
      company_name: z.string().optional().describe('Filter by company placed in'),
      drive_id: z.number().int().optional().describe('Filter by drive ID placed in'),
    },
    async (params) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) query.set(key, String(value));
      }
      const qs = query.toString() ? `?${query.toString()}` : '';
      const { status, json } = await callRoute('GET', `/api/students/search${qs}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'get_student',
    'Get specific student details by student_id.',
    {
      student_id: z.number().int().describe('Student ID'),
    },
    async ({ student_id }) => {
      const { status, json } = await callRoute('GET', `/api/students/${student_id}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'create_student',
    'Create a new student record. DO NOT supply student_id. Department must be one of: AIDS, CE, ECE, ENTC, IT.',
    {
      student_first_name: z.string().optional().describe('First name (or pass first_name)'),
      student_last_name: z.string().optional().describe('Last name (or pass last_name)'),
      first_name: z.string().optional().describe('First name alias'),
      last_name: z.string().optional().describe('Last name alias'),
      email: z.string().optional().describe('Email address'),
      department: z.enum(['AIDS', 'CE', 'ECE', 'ENTC', 'IT']).optional().describe('Department (AIDS, CE, ECE, ENTC, IT)'),
      placement_date: z.string().optional().describe('Date of placement (YYYY-MM-DD)'),
      placed_drive_id: z.number().int().optional().describe('Drive ID placed in'),
    },
    async (args) => {
      const { status, json } = await callRoute('POST', '/api/students', args, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 211 ? `Student created successfully. student_id: ${json.student_id}` : null);
    }
  );

  server.tool(
    'add_student',
    'Alias for create_student: Add a new student record.',
    {
      student_first_name: z.string().optional().describe('First name (or pass first_name)'),
      student_last_name: z.string().optional().describe('Last name (or pass last_name)'),
      first_name: z.string().optional().describe('First name alias'),
      last_name: z.string().optional().describe('Last name alias'),
      email: z.string().optional().describe('Email address'),
      department: z.enum(['AIDS', 'CE', 'ECE', 'ENTC', 'IT']).optional().describe('Department (AIDS, CE, ECE, ENTC, IT)'),
      placement_date: z.string().optional().describe('Date of placement (YYYY-MM-DD)'),
      placed_drive_id: z.number().int().optional().describe('Drive ID placed in'),
    },
    async (args) => {
      const { status, json } = await callRoute('POST', '/api/students', args, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 211 ? `Student added successfully. student_id: ${json.student_id}` : null);
    }
  );

  server.tool(
    'update_student',
    'Update profile details of an existing student by student_id. For placing or unplacing, prefer record_placement / place_student / unplace_student.',
    {
      student_id: z.number().int().describe('Student ID to update'),
      student_first_name: z.string().optional().describe('New first name'),
      student_last_name: z.string().optional().describe('New last name'),
      email: z.string().optional().describe('New email address'),
      department: z.enum(['AIDS', 'CE', 'ECE', 'ENTC', 'IT']).optional().describe('New department'),
      placement_date: z.string().optional().describe('New placement date (YYYY-MM-DD)'),
      placed_drive_id: z.number().int().optional().describe('New placed drive ID'),
    },
    async ({ student_id, ...fields }) => {
      const { status, json } = await callRoute('PUT', `/api/students/${student_id}`, fields, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Student ${student_id} updated successfully.` : null);
    }
  );

  server.tool(
    'delete_student',
    'Permanently delete a student record by student_id.',
    {
      student_id: z.number().int().describe('Student ID to delete'),
    },
    async ({ student_id }) => {
      const { status, json } = await callRoute('DELETE', `/api/students/${student_id}`, null, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Student ${student_id} deleted successfully.` : null);
    }
  );

  // ── Placement Placement / Unplacement Tools ───────────────────────────────

  server.tool(
    'record_placement',
    'Atomically find a student by their first & last name (or full name/ID), resolve the placement drive for the company (matching role or moving on with whatever role that company has), and record the placement. Automatically defaults placement date to today if omitted.',
    {
      student_first_name: z.string().optional().describe('First name'),
      student_last_name: z.string().optional().describe('Last name'),
      student_name: z.string().optional().describe('Full name (e.g. Neeraj Gogate)'),
      student_id: z.number().int().optional().describe('Student ID'),
      company_name: z.string().describe('Company name where placed (e.g. Atomberg Technologies)'),
      role: z.string().optional().describe('Job role or profile title'),
      placement_date: z.string().optional().describe('Placement date (YYYY-MM-DD or DD/MM/YYYY). Defaults to today.'),
    },
    async (args) => {
      const { status, json } = await callRoute('POST', '/api/students/record-placement', args, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Placement recorded: ${json.student_name} at ${json.company} (${json.role}) on ${json.placement_date}.` : null);
    }
  );

  server.tool(
    'place_student',
    'Mark a student as placed in a drive atomically in a database transaction.',
    {
      student_id: z.number().int().describe('Student ID'),
      drive_id: z.number().int().describe('Placement Drive ID'),
      placement_date: z.string().optional().describe('Placement date (YYYY-MM-DD). Defaults to today.'),
    },
    async (args) => {
      const { status, json } = await callRoute('POST', '/api/placement/place', args, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Student ${args.student_id} placed in drive ${args.drive_id} on ${json.placement_date}.` : null);
    }
  );

  server.tool(
    'unplace_student',
    'Unplace a student from their current drive atomically in a transaction. Clears placed_drive_id and placement_date.',
    {
      student_id: z.number().int().describe('Student ID to unplace'),
    },
    async ({ student_id }) => {
      const { status, json } = await callRoute('POST', '/api/placement/unplace', { student_id }, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 200 ? `Student ${student_id} unplaced successfully.` : null);
    }
  );

  // ── Compound Company Setup Tool ───────────────────────────────────────────

  server.tool(
    'setup_company',
    'Atomically register or update a company, create/update its placement drive, and map its eligible branches in a single transaction. Automatically expands "All Branches" and handles flexible date/CTC formats.',
    {
      company_name: z.string().describe('Company name (required)'),
      visiting_date: z.string().optional().describe('Drive date (YYYY-MM-DD or DD/MM/YYYY)'),
      role: z.string().optional().describe('Job profile title. Defaults to Software Engineer.'),
      jd_link: z.string().optional().describe('JD URL'),
      ctc: z.union([z.number(), z.string()]).optional().describe('CTC in LPA (e.g. 12 or "12 LPA")'),
      eligibility_10th: z.union([z.number(), z.string()]).optional().describe('Min 10th % (e.g. 60 or "60%")'),
      eligibility_12th: z.union([z.number(), z.string()]).optional().describe('Min 12th % (e.g. 60 or "60%")'),
      eligibility_cgpa: z.union([z.number(), z.string()]).optional().describe('Min CGPA (e.g. 6.74 or "6.74 CGPA")'),
      eligibility_backlog: z.string().optional().describe('Backlog criteria'),
      branches: z.union([z.array(z.string()), z.string()]).optional().describe('Eligible branch codes or "All Branches"'),
    },
    async (args) => {
      const { status, json } = await callRoute('POST', '/api/companies/setup', args, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 211 ? `Setup complete: company_id ${json.company_id}, drive_id ${json.drive_id}, branches: ${JSON.stringify(json.branches)}` : null);
    }
  );

  server.tool(
    'setup_company_and_drive',
    'Alias for setup_company: Atomically register or update a company, create/update its placement drive, and map its eligible branches.',
    {
      company_name: z.string().describe('Company name (required)'),
      visiting_date: z.string().optional().describe('Drive date (YYYY-MM-DD or DD/MM/YYYY)'),
      role: z.string().optional().describe('Job profile title. Defaults to Software Engineer.'),
      jd_link: z.string().optional().describe('JD URL'),
      ctc: z.union([z.number(), z.string()]).optional().describe('CTC in LPA (e.g. 12 or "12 LPA")'),
      eligibility_10th: z.union([z.number(), z.string()]).optional().describe('Min 10th % (e.g. 60 or "60%")'),
      eligibility_12th: z.union([z.number(), z.string()]).optional().describe('Min 12th % (e.g. 60 or "60%")'),
      eligibility_cgpa: z.union([z.number(), z.string()]).optional().describe('Min CGPA (e.g. 6.74 or "6.74 CGPA")'),
      eligibility_backlog: z.string().optional().describe('Backlog criteria'),
      branches: z.union([z.array(z.string()), z.string()]).optional().describe('Eligible branch codes or "All Branches"'),
    },
    async (args) => {
      const { status, json } = await callRoute('POST', '/api/companies/setup', args, env, ctx, apiKey);
      return formatMcpResponse(status, json, status === 211 ? `Setup complete: company_id ${json.company_id}, drive_id ${json.drive_id}, branches: ${JSON.stringify(json.branches)}` : null);
    }
  );

  // ── Statistics & Reporting Tools ──────────────────────────────────────────

  server.tool(
    'get_stats',
    'Get placement overview statistics: total placed, highest CTC, average CTC, median CTC, mode CTC, total companies, total drives, department breakdown.',
    {},
    async () => {
      const { status, json } = await callRoute('GET', '/api/stats/overview', null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'get_overview_stats',
    'Alias for get_stats: Get placement overview statistics.',
    {},
    async () => {
      const { status, json } = await callRoute('GET', '/api/stats/overview', null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'get_analytics',
    'Get placement analytics: department-wise placement counts, average CTC by department, company-wise placement counts, timeline trends.',
    {},
    async () => {
      const { status, json } = await callRoute('GET', '/api/stats/analytics', null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'get_analytics_stats',
    'Alias for get_analytics: Get placement analytics.',
    {},
    async () => {
      const { status, json } = await callRoute('GET', '/api/stats/analytics', null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'get_placement_report',
    'Get full relational placement report: every placed student with company, role, department, and CTC.',
    {},
    async () => {
      const { status, json } = await callRoute('GET', '/api/reports/placements', null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  server.tool(
    'get_branch_statistics',
    'Get branch-wise placement statistics (placed count, average ctc, max ctc).',
    {},
    async () => {
      const { status, json } = await callRoute('GET', '/api/reports/branches-stats', null, env, ctx, apiKey);
      return formatMcpResponse(status, json);
    }
  );

  return server;
}

// ─── OAuth 2.1 Authorization Endpoint UI & Action ───────────────────────────

app.get('/authorize', async (c) => {
  let oauthRequest;
  try {
    oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (error) {
    if (error && error.redirectUri) {
      const redirect = new URL(error.redirectUri);
      redirect.searchParams.set('error', error.code || 'invalid_request');
      redirect.searchParams.set('error_description', error.description || error.message);
      if (error.state) redirect.searchParams.set('state', error.state);
      if (error.issuer) redirect.searchParams.set('iss', error.issuer);
      return c.redirect(redirect.toString(), 302);
    }
    return c.html(`
      <!DOCTYPE html>
      <html>
      <head><title>OAuth Authorization Error</title><style>body{font-family:system-ui,sans-serif;padding:2rem;background:#090d16;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#131b2e;padding:2rem;border-radius:16px;border:1px solid #ef4444;max-width:440px}h2{color:#ef4444;margin-bottom:0.75rem}</style></head>
      <body>
        <div class="card">
          <h2>Authorization Error</h2>
          <p style="color:#94a3b8;line-height:1.5">${error?.description || error?.message || 'Invalid OAuth request'}</p>
        </div>
      </body>
      </html>
    `, 400);
  }

  let client = null;
  try {
    client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  } catch (e) {}

  const clientName = client?.clientName || oauthRequest.clientId || 'Claude';

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Authorize Claude — Placement Monitoring</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: #090d16;
          color: #e2e8f0;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          padding: 1.5rem;
        }
        .card {
          background: #131b2e;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 16px;
          padding: 2.5rem 2rem;
          width: 100%;
          max-width: 440px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
        }
        .badge {
          display: inline-block;
          background: rgba(99, 102, 241, 0.15);
          color: #818cf8;
          border: 1px solid rgba(99, 102, 241, 0.3);
          font-size: 0.75rem;
          font-weight: 600;
          padding: 4px 10px;
          border-radius: 9999px;
          margin-bottom: 1rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        h1 { font-size: 1.35rem; font-weight: 700; color: #fff; margin-bottom: 0.5rem; }
        p.subtitle { color: #94a3b8; font-size: 0.88rem; margin-bottom: 1.5rem; line-height: 1.5; }
        .permissions {
          background: #0b1120;
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 10px;
          padding: 1rem;
          margin-bottom: 1.5rem;
        }
        .perm-title { font-size: 0.75rem; font-weight: 600; color: #64748b; text-transform: uppercase; margin-bottom: 0.5rem; letter-spacing: 0.05em; }
        .perm-item { font-size: 0.85rem; color: #cbd5e1; display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
        .perm-item::before { content: "✓"; color: #34d399; font-weight: bold; }
        label { display: block; font-size: 0.85rem; font-weight: 500; color: #cbd5e1; margin-bottom: 0.5rem; }
        input[type="password"] {
          width: 100%;
          padding: 0.75rem 1rem;
          background: #0b1120;
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 8px;
          color: #fff;
          font-size: 0.95rem;
          outline: none;
          margin-bottom: 1.5rem;
        }
        input:focus { border-color: #6366f1; }
        .btn-submit {
          width: 100%;
          background: linear-gradient(135deg, #6366f1, #4f46e5);
          color: #fff;
          border: none;
          padding: 0.85rem;
          border-radius: 8px;
          font-size: 0.95rem;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.2s;
        }
        .btn-submit:hover { opacity: 0.9; }
        .footer { text-align: center; margin-top: 1.25rem; font-size: 0.75rem; color: #64748b; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">OAuth 2.1 Authorization</span>
        <h1>Authorize ${clientName}</h1>
        <p class="subtitle">Connect your Placement Monitoring MCP server to Claude to allow read/write management.</p>
        
        <div class="permissions">
          <div class="perm-title">Permissions Granted</div>
          <div class="perm-item">Manage Placement Drives & Companies</div>
          <div class="perm-item">Manage Students & Placement Records</div>
          <div class="perm-item">Generate Analytics & Placement Reports</div>
        </div>

        <form method="POST" action="/authorize">
          <input type="hidden" name="client_id" value="${oauthRequest.clientId || ''}">
          <input type="hidden" name="redirect_uri" value="${oauthRequest.redirectUri || ''}">
          <input type="hidden" name="response_type" value="${oauthRequest.responseType || 'code'}">
          <input type="hidden" name="state" value="${oauthRequest.state || ''}">
          <input type="hidden" name="code_challenge" value="${oauthRequest.codeChallenge || ''}">
          <input type="hidden" name="code_challenge_method" value="${oauthRequest.codeChallengeMethod || ''}">
          <input type="hidden" name="scope" value="${oauthRequest.scope ? oauthRequest.scope.join(' ') : 'mcp'}">
          <input type="hidden" name="resource" value="${oauthRequest.resource || ''}">

          <label for="apiKey">Admin API Key</label>
          <input type="password" id="apiKey" name="apiKey" placeholder="Enter your server API_KEY" required autofocus>

          <button type="submit" class="btn-submit">Authorize & Connect</button>
        </form>

        <div class="footer">Placement Monitoring System • Cloudflare OAuth Provider</div>
      </div>
    </body>
    </html>
  `;

  return c.html(html);
});

app.post('/authorize', async (c) => {
  const formData = await c.req.formData();
  const apiKeyInput = formData.get('apiKey');
  const serverApiKey = c.env.API_KEY;

  if (!apiKeyInput || apiKeyInput !== serverApiKey) {
    return c.html(`
      <!DOCTYPE html>
      <html>
      <head><title>Authorization Failed</title><style>body{font-family:system-ui,sans-serif;padding:2rem;background:#090d16;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#131b2e;padding:2rem;border-radius:16px;border:1px solid #ef4444;max-width:400px;text-align:center}h2{color:#ef4444;margin-bottom:1rem}a{color:#818cf8;text-decoration:none}</style></head>
      <body>
        <div class="card">
          <h2>Invalid API Key</h2>
          <p style="color:#94a3b8;margin-bottom:1.5rem">The API key provided does not match the server configuration.</p>
          <a href="javascript:history.back()">← Go Back & Try Again</a>
        </div>
      </body>
      </html>
    `, 401);
  }

  const rawUrl = new URL(c.req.url);
  rawUrl.searchParams.set('client_id', formData.get('client_id') || '');
  rawUrl.searchParams.set('redirect_uri', formData.get('redirect_uri') || '');
  rawUrl.searchParams.set('response_type', formData.get('response_type') || 'code');
  if (formData.get('state')) rawUrl.searchParams.set('state', formData.get('state'));
  if (formData.get('code_challenge')) rawUrl.searchParams.set('code_challenge', formData.get('code_challenge'));
  if (formData.get('code_challenge_method')) rawUrl.searchParams.set('code_challenge_method', formData.get('code_challenge_method'));
  if (formData.get('scope')) rawUrl.searchParams.set('scope', formData.get('scope'));
  if (formData.get('resource')) rawUrl.searchParams.set('resource', formData.get('resource'));

  const reconstructedReq = new Request(rawUrl.toString(), {
    method: 'GET',
    headers: c.req.raw.headers,
  });

  let oauthRequest;
  try {
    oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(reconstructedReq);
  } catch (error) {
    if (error && error.redirectUri) {
      const redirect = new URL(error.redirectUri);
      redirect.searchParams.set('error', error.code || 'invalid_request');
      redirect.searchParams.set('error_description', error.description || error.message);
      if (error.state) redirect.searchParams.set('state', error.state);
      if (error.issuer) redirect.searchParams.set('iss', error.issuer);
      return c.redirect(redirect.toString(), 302);
    }
    return c.text(error?.description || error?.message || 'Invalid authorization parameters', 400);
  }

  let client = null;
  try {
    client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  } catch (e) {}

  const grantedScopes = oauthRequest.scope && oauthRequest.scope.length > 0 ? oauthRequest.scope : ['mcp'];

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: 'admin',
    metadata: { clientName: client?.clientName || 'Claude' },
    scope: grantedScopes,
    props: {
      userId: 'admin',
      role: 'admin',
    },
  });

  return c.redirect(redirectTo, 302);
});

// Catch-all 404
app.notFound((c) => c.json({ error: 'Not Found' }, 404));

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error in worker:', err);
  return c.json({ error: `Internal Server Error: ${err.message || err}` }, 500);
});

// ─── OAuth Provider & MCP Handlers ──────────────────────────────────────────

const apiHandler = {
  async fetch(request, env, ctx) {
    // Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization, Accept, mcp-session-id, mcp-protocol-version',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Build McpServer with placement tools
    const server = buildMcpServer(env, ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless for Cloudflare Workers
    });

    await server.connect(transport);
    const response = await transport.handleRequest(request);

    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  }
};

const defaultHandler = {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  }
};

const oauthProvider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler,
  defaultHandler,

  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',

  scopesSupported: ['mcp', 'placement:admin'],

  resourceMetadata: {
    resource: 'https://placement-monitoring-backend-production.adityajadhav5905.workers.dev/mcp',
    authorization_servers: ['https://placement-monitoring-backend-production.adityajadhav5905.workers.dev'],
    scopes_supported: ['mcp', 'placement:admin'],
    bearer_methods_supported: ['header'],
    resource_name: 'Placement Monitoring MCP Server',
  },

  clientIdMetadataDocumentEnabled: true,
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Direct API_KEY support for internal tools, scripts, and tests
    const apiKeyHeader = request.headers.get('X-API-Key');
    if (url.pathname === '/mcp' && apiKeyHeader && env.API_KEY && apiKeyHeader === env.API_KEY) {
      return apiHandler.fetch(request, env, ctx);
    }
    return oauthProvider.fetch(request, env, ctx);
  }
};


