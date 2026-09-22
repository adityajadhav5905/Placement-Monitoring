import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './db.js';
import { parseAndApplyUpdates } from './aiService.js';
import ical from 'ical-generator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();

// Hardened CORS: allow local development and configured production origins
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin: (origin, callback) => {
    const isLocal = !origin || 
      /^http:\/\/localhost(:\d+)?$/.test(origin) || 
      /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
    const isAllowedProd = ALLOWED_ORIGINS.includes(origin);

    if (isLocal || isAllowedProd) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use(express.json());

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '127.0.0.1';

// API Key Authentication Middleware
const authenticateApiKey = (req, res, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();
  const clientKey = req.header('X-API-Key') || req.query.apiKey;
  if (clientKey === apiKey) return next();
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
};

// Protect all mutations (POST, PUT, DELETE)
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return authenticateApiKey(req, res, next);
  }
  next();
});

// In-memory TTL Cache for read-heavy stats and listings
const cache = new Map();
const getCached = (key) => {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
};
const setCached = (key, data, ttlMs = 15000) => {
  cache.set(key, { data, expiry: Date.now() + ttlMs });
};
const clearCache = () => {
  cache.clear();
};

// Invalidate cache on mutations
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    clearCache();
  }
  next();
});

// Initialize custom_events and visitor_stats tables on startup (Fixed connection leak)
const initDb = async () => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query(`
      CREATE TABLE IF NOT EXISTS custom_events (
        event_id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        event_date DATE NOT NULL,
        start_time TIME DEFAULT '09:00:00',
        end_time TIME DEFAULT '17:00:00'
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS visitor_stats (
        visit_date DATE PRIMARY KEY,
        count INT DEFAULT 0
      )
    `);
    try {
      await connection.query('ALTER TABLE placement_drives DROP COLUMN form_link');
    } catch (_) {}
    console.log('Database tables verified/initialized.');
  } catch (error) {
    console.error('Error initializing database tables:', error);
  } finally {
    if (connection) connection.release();
  }
};

initDb();

// 1. Get visited companies (Optimized to avoid Cartesian product)
app.get('/api/companies', async (req, res) => {
  try {
    const cached = getCached('companies');
    if (cached) return res.json(cached);

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
    setCached('companies', rows, 15000);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. Get placed students
app.get('/api/students', async (req, res) => {
  try {
    const cached = getCached('students');
    if (cached) return res.json(cached);

    const query = `
      SELECT 
        s.student_id,
        CONCAT(s.student_first_name, ' ', s.student_last_name) AS student_name,
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
    setCached('students', rows, 15000);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. Get Overview Stats (Parallelized & Consolidated)
app.get('/api/stats/overview', async (req, res) => {
  try {
    const cached = getCached('stats_overview');
    if (cached) return res.json(cached);

    // Parallelize all independent overview queries concurrently
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
        console.error('Error updating visitor stats:', err);
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

      // Median
      const mid = Math.floor(ctcs.length / 2);
      if (ctcs.length % 2 === 0) {
        medianCTC = Number(((ctcs[mid - 1] + ctcs[mid]) / 2).toFixed(2));
      } else {
        medianCTC = ctcs[mid];
      }

      // Mode
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

    const result = {
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
    };

    setCached('stats_overview', result, 15000);
    res.json(result);
  } catch (error) {
    console.error('Error fetching overview stats:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 4. Get Analytical Stats (Parallelized)
app.get('/api/stats/analytics', async (req, res) => {
  try {
    const cached = getCached('stats_analytics');
    if (cached) return res.json(cached);

    // Parallelize all analytics queries
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

    const result = {
      deptCounts,
      deptAvgCtc,
      companyCounts,
      timelineTrends
    };

    setCached('stats_analytics', result, 15000);
    res.json(result);
  } catch (error) {
    console.error('Error fetching analytics stats:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


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
  // Handle DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }
  // Handle standard YYYY-MM-DD
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
    // Extract first numeric / float occurrence
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


// ==========================================
// 5. Companies API
// ==========================================

// List all companies
app.get('/api/companies/list', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM companies ORDER BY company_name ASC');
    res.json(rows);
  } catch (error) {
    console.error('Error listing companies:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Search companies
app.get('/api/companies/search', async (req, res) => {
  try {
    const { name } = req.query;
    let query = 'SELECT * FROM companies';
    const params = [];
    if (name) {
      query += ' WHERE company_name LIKE ?';
      params.push(`%${name}%`);
    }
    query += ' ORDER BY company_name ASC';
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Error searching companies:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get company by ID
app.get('/api/companies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM companies WHERE company_id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching company:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create company
app.post('/api/companies', async (req, res) => {
  try {
    const { company_name } = req.body;
    if (!company_name || typeof company_name !== 'string' || !company_name.trim()) {
      return res.status(400).json({ error: 'company_name is required and must be a non-empty string' });
    }

    const [existing] = await pool.query('SELECT company_id FROM companies WHERE LOWER(company_name) = ?', [company_name.trim().toLowerCase()]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Company already exists' });
    }

    const [result] = await pool.query('INSERT INTO companies (company_name) VALUES (?)', [company_name.trim()]);
    res.status(211).json({ company_id: result.insertId, company_name: company_name.trim() });
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Update company
app.put('/api/companies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { company_name } = req.body;
    if (!company_name || typeof company_name !== 'string' || !company_name.trim()) {
      return res.status(400).json({ error: 'company_name is required and must be a non-empty string' });
    }

    const [existing] = await pool.query('SELECT company_id FROM companies WHERE company_id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const [duplicate] = await pool.query('SELECT company_id FROM companies WHERE LOWER(company_name) = ? AND company_id != ?', [company_name.trim().toLowerCase(), id]);
    if (duplicate.length > 0) {
      return res.status(400).json({ error: 'Another company with this name already exists' });
    }

    await pool.query('UPDATE companies SET company_name = ? WHERE company_id = ?', [company_name.trim(), id]);
    res.json({ company_id: Number(id), company_name: company_name.trim() });
  } catch (error) {
    console.error('Error updating company:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete company
app.delete('/api/companies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await pool.query('SELECT company_id FROM companies WHERE company_id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const [drives] = await pool.query('SELECT drive_id FROM placement_drives WHERE company_id = ?', [id]);
    if (drives.length > 0) {
      return res.status(400).json({ error: 'Company has dependent drives' });
    }

    await pool.query('DELETE FROM companies WHERE company_id = ?', [id]);
    res.json({ success: true, message: 'Company deleted successfully' });
  } catch (error) {
    console.error('Error deleting company:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==========================================
// 6. Placement Drives API
// ==========================================

// List all drives
app.get('/api/drives', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT d.*, c.company_name AS company
      FROM placement_drives d
      JOIN companies c ON d.company_id = c.company_id
      ORDER BY d.visiting_date DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error listing drives:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Search drives
app.get('/api/drives/search', async (req, res) => {
  try {
    const { company_id, company_name, role, min_ctc, max_ctc, start_date, end_date, branch } = req.query;
    let query = `
      SELECT DISTINCT d.*, c.company_name AS company
      FROM placement_drives d
      JOIN companies c ON d.company_id = c.company_id
      LEFT JOIN branches b ON d.drive_id = b.drive_id
      WHERE 1=1
    `;
    const params = [];

    if (company_id) {
      query += ' AND d.company_id = ?';
      params.push(company_id);
    }
    if (company_name) {
      query += ' AND c.company_name LIKE ?';
      params.push(`%${company_name}%`);
    }
    if (role) {
      query += ' AND d.role LIKE ?';
      params.push(`%${role}%`);
    }
    if (min_ctc) {
      if (isNaN(Number(min_ctc))) return res.status(400).json({ error: 'min_ctc must be a number' });
      query += ' AND d.ctc >= ?';
      params.push(Number(min_ctc));
    }
    if (max_ctc) {
      if (isNaN(Number(max_ctc))) return res.status(400).json({ error: 'max_ctc must be a number' });
      query += ' AND d.ctc <= ?';
      params.push(Number(max_ctc));
    }
    if (start_date) {
      if (!validateDate(start_date)) return res.status(400).json({ error: 'start_date is invalid' });
      query += ' AND d.visiting_date >= ?';
      params.push(start_date);
    }
    if (end_date) {
      if (!validateDate(end_date)) return res.status(400).json({ error: 'end_date is invalid' });
      query += ' AND d.visiting_date <= ?';
      params.push(end_date);
    }
    if (branch) {
      const bName = branch.trim().toUpperCase();
      if (!VALID_DEPARTMENTS.includes(bName)) {
        return res.status(400).json({ error: 'Invalid department/branch' });
      }
      query += ' AND b.branch = ?';
      params.push(bName);
    }

    query += ' ORDER BY d.visiting_date DESC';
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Error searching drives:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get drive by ID
app.get('/api/drives/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(`
      SELECT d.*, c.company_name AS company
      FROM placement_drives d
      JOIN companies c ON d.company_id = c.company_id
      WHERE d.drive_id = ?
    `, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Drive not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching drive:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get company drives
app.get('/api/companies/:id/drives', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(`
      SELECT d.*, c.company_name AS company
      FROM placement_drives d
      JOIN companies c ON d.company_id = c.company_id
      WHERE d.company_id = ?
      ORDER BY d.visiting_date DESC
    `, [id]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching company drives:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create drive
app.post('/api/drives', async (req, res) => {
  try {
    const {
      company_id, visiting_date, role, jd_link,
      ctc, eligibility_10th, eligibility_12th, eligibility_cgpa, eligibility_backlog
    } = req.body;

    if (!company_id) {
      return res.status(400).json({ error: 'company_id is required' });
    }

    if (visiting_date && !validateDate(visiting_date)) {
      return res.status(400).json({ error: 'visiting_date must be a valid date' });
    }

    const [company] = await pool.query('SELECT company_id FROM companies WHERE company_id = ?', [company_id]);
    if (company.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    if (ctc !== undefined && !isStrictNumber(ctc)) return res.status(400).json({ error: 'ctc must be a valid numeric value without units (e.g. 9.5)' });
    if (eligibility_10th !== undefined && !isStrictInt(eligibility_10th)) return res.status(400).json({ error: 'eligibility_10th must be a valid integer percentage without units (e.g. 68)' });
    if (eligibility_12th !== undefined && !isStrictInt(eligibility_12th)) return res.status(400).json({ error: 'eligibility_12th must be a valid integer percentage without units (e.g. 70)' });
    if (eligibility_cgpa !== undefined && !isStrictNumber(eligibility_cgpa)) return res.status(400).json({ error: 'eligibility_cgpa must be a valid numeric value without units (e.g. 8.5)' });

    const [result] = await pool.query(
      `INSERT INTO placement_drives (
        company_id, visiting_date, role, jd_link,
        ctc, eligibility_10th, eligibility_12th, eligibility_cgpa, eligibility_backlog
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        company_id,
        visiting_date || null,
        role || 'Software Engineer',
        jd_link || null,
        ctc !== undefined ? Number(ctc) : 1,
        eligibility_10th !== undefined ? Number(eligibility_10th) : 50,
        eligibility_12th !== undefined ? Number(eligibility_12th) : 50,
        eligibility_cgpa !== undefined ? Number(eligibility_cgpa) : 6.00,
        eligibility_backlog || null
      ]
    );
    res.status(211).json({ drive_id: result.insertId, company_id, role });
  } catch (error) {
    console.error('Error creating drive:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Update drive
app.put('/api/drives/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      company_id, visiting_date, role, jd_link,
      ctc, eligibility_10th, eligibility_12th, eligibility_cgpa, eligibility_backlog
    } = req.body;

    const [drive] = await pool.query('SELECT drive_id FROM placement_drives WHERE drive_id = ?', [id]);
    if (drive.length === 0) {
      return res.status(404).json({ error: 'Drive not found' });
    }

    if (company_id !== undefined) {
      const [company] = await pool.query('SELECT company_id FROM companies WHERE company_id = ?', [company_id]);
      if (company.length === 0) {
        return res.status(404).json({ error: 'Company not found' });
      }
    }

    if (visiting_date !== undefined && visiting_date !== null && !validateDate(visiting_date)) {
      return res.status(400).json({ error: 'visiting_date must be a valid date' });
    }

    if (ctc !== undefined && ctc !== null && !isStrictNumber(ctc)) return res.status(400).json({ error: 'ctc must be a valid numeric value without units (e.g. 9.5)' });
    if (eligibility_10th !== undefined && eligibility_10th !== null && !isStrictInt(eligibility_10th)) return res.status(400).json({ error: 'eligibility_10th must be a valid integer percentage without units (e.g. 68)' });
    if (eligibility_12th !== undefined && eligibility_12th !== null && !isStrictInt(eligibility_12th)) return res.status(400).json({ error: 'eligibility_12th must be a valid integer percentage without units (e.g. 70)' });
    if (eligibility_cgpa !== undefined && eligibility_cgpa !== null && !isStrictNumber(eligibility_cgpa)) return res.status(400).json({ error: 'eligibility_cgpa must be a valid numeric value without units (e.g. 8.5)' });

    await pool.query(
      `UPDATE placement_drives SET 
        company_id = COALESCE(?, company_id),
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
        company_id !== undefined ? company_id : null,
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
    res.json({ success: true, message: 'Drive updated successfully' });
  } catch (error) {
    console.error('Error updating drive:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete drive
app.delete('/api/drives/:id', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;

    const [drive] = await connection.query('SELECT drive_id FROM placement_drives WHERE drive_id = ?', [id]);
    if (drive.length === 0) {
      return res.status(404).json({ error: 'Drive not found' });
    }

    const [students] = await connection.query('SELECT student_id FROM students WHERE placed_drive_id = ?', [id]);
    if (students.length > 0) {
      return res.status(400).json({ error: 'Drive has placed students' });
    }

    await connection.beginTransaction();
    await connection.query('DELETE FROM branches WHERE drive_id = ?', [id]);
    await connection.query('DELETE FROM placement_drives WHERE drive_id = ?', [id]);
    await connection.commit();

    res.json({ success: true, message: 'Drive and its branch records deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting drive:', error);
    res.status(500).json({ error: 'Database error' });
  } finally {
    connection.release();
  }
});

// ==========================================
// 7. Branches API
// ==========================================

// Get branches for a drive
app.get('/api/drives/:id/branches', async (req, res) => {
  try {
    const { id } = req.params;
    const [drive] = await pool.query('SELECT drive_id FROM placement_drives WHERE drive_id = ?', [id]);
    if (drive.length === 0) {
      return res.status(404).json({ error: 'Drive not found' });
    }
    const [rows] = await pool.query('SELECT branch FROM branches WHERE drive_id = ?', [id]);
    res.json(rows.map(r => r.branch));
  } catch (error) {
    console.error('Error fetching drive branches:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Add branch to a drive
app.post('/api/drives/:id/branches', async (req, res) => {
  try {
    const { id } = req.params;
    const { branch } = req.body;
    if (!branch || typeof branch !== 'string' || !branch.trim()) {
      return res.status(400).json({ error: 'branch is required and must be a non-empty string' });
    }
    const bName = branch.trim().toUpperCase();

    if (!VALID_DEPARTMENTS.includes(bName)) {
      return res.status(400).json({ error: `Invalid department. Must be one of: ${VALID_DEPARTMENTS.join(', ')}` });
    }

    const [drive] = await pool.query('SELECT drive_id FROM placement_drives WHERE drive_id = ?', [id]);
    if (drive.length === 0) {
      return res.status(404).json({ error: 'Drive not found' });
    }

    const [existing] = await pool.query('SELECT branch FROM branches WHERE drive_id = ? AND branch = ?', [id, bName]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Duplicate branch' });
    }

    await pool.query('INSERT INTO branches (drive_id, branch) VALUES (?, ?)', [id, bName]);
    res.status(211).json({ drive_id: Number(id), branch: bName });
  } catch (error) {
    console.error('Error adding branch to drive:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Remove branch from a drive
app.delete('/api/drives/:id/branches/:branch', async (req, res) => {
  try {
    const { id, branch } = req.params;
    const bName = branch.trim().toUpperCase();

    const [drive] = await pool.query('SELECT drive_id FROM placement_drives WHERE drive_id = ?', [id]);
    if (drive.length === 0) {
      return res.status(404).json({ error: 'Drive not found' });
    }

    const [existing] = await pool.query('SELECT branch FROM branches WHERE drive_id = ? AND branch = ?', [id, bName]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Branch mapping not found' });
    }

    await pool.query('DELETE FROM branches WHERE drive_id = ? AND branch = ?', [id, bName]);
    res.json({ success: true, message: 'Branch removed successfully' });
  } catch (error) {
    console.error('Error removing branch:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==========================================
// 8. Students API
// ==========================================

// List all students
app.get('/api/students/list', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM students ORDER BY student_first_name, student_last_name ASC');
    res.json(rows);
  } catch (error) {
    console.error('Error listing students:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Search students
app.get('/api/students/search', async (req, res) => {
  try {
    const {
      name, student_name, first_name, student_first_name,
      last_name, student_last_name, q, email, department, placed, company_name, drive_id
    } = req.query;

    let query = `
      SELECT s.*, d.role, d.ctc, c.company_name AS company_placed
      FROM students s
      LEFT JOIN placement_drives d ON s.placed_drive_id = d.drive_id
      LEFT JOIN companies c ON d.company_id = c.company_id
      WHERE 1=1
    `;
    const params = [];

    const fName = first_name || student_first_name;
    const lName = last_name || student_last_name;
    const generalSearch = name || student_name || q;

    if (fName && lName) {
      query += ' AND (LOWER(s.student_first_name) LIKE ? AND LOWER(s.student_last_name) LIKE ?)';
      params.push(`%${fName.trim().toLowerCase()}%`, `%${lName.trim().toLowerCase()}%`);
    } else if (fName) {
      query += ' AND LOWER(s.student_first_name) LIKE ?';
      params.push(`%${fName.trim().toLowerCase()}%`);
    } else if (lName) {
      query += ' AND LOWER(s.student_last_name) LIKE ?';
      params.push(`%${lName.trim().toLowerCase()}%`);
    } else if (generalSearch) {
      const trimmed = generalSearch.trim();
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        query += " AND ((LOWER(s.student_first_name) LIKE ? AND LOWER(s.student_last_name) LIKE ?) OR CONCAT(s.student_first_name, ' ', s.student_last_name) LIKE ? OR s.student_first_name LIKE ? OR s.student_last_name LIKE ?)";
        params.push(`%${parts[0].toLowerCase()}%`, `%${parts.slice(1).join(' ').toLowerCase()}%`, `%${trimmed}%`, `%${trimmed}%`, `%${trimmed}%`);
      } else {
        query += " AND (CONCAT(s.student_first_name, ' ', s.student_last_name) LIKE ? OR s.student_first_name LIKE ? OR s.student_last_name LIKE ?)";
        params.push(`%${trimmed}%`, `%${trimmed}%`, `%${trimmed}%`);
      }
    }

    if (email) {
      query += ' AND s.email LIKE ?';
      params.push(`%${email.trim()}%`);
    }
    if (department) {
      const dName = department.trim().toUpperCase();
      if (!VALID_DEPARTMENTS.includes(dName)) {
        return res.status(400).json({ error: 'Invalid department' });
      }
      query += ' AND s.department = ?';
      params.push(dName);
    }
    if (placed !== undefined) {
      if (placed === 'true') {
        query += ' AND s.placed_drive_id IS NOT NULL';
      } else if (placed === 'false') {
        query += ' AND s.placed_drive_id IS NULL';
      }
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
    res.json(rows);
  } catch (error) {
    console.error('Error searching students:', error);
    res.status(500).json({ error: `Database error: ${error.message || error}` });
  }
});

// Get student by ID
app.get('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(`
      SELECT s.*, d.role, d.ctc, c.company_name AS company_placed
      FROM students s
      LEFT JOIN placement_drives d ON s.placed_drive_id = d.drive_id
      LEFT JOIN companies c ON d.company_id = c.company_id
      WHERE s.student_id = ?
    `, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching student:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create student
app.post('/api/students', async (req, res) => {
  try {
    const rawFirstName = req.body.student_first_name !== undefined ? req.body.student_first_name : req.body.first_name;
    const rawLastName = req.body.student_last_name !== undefined ? req.body.student_last_name : req.body.last_name;
    const student_first_name = typeof rawFirstName === 'string' ? rawFirstName.trim() : rawFirstName;
    const student_last_name = typeof rawLastName === 'string' ? rawLastName.trim() : rawLastName;
    const { email, department, placement_date, placed_drive_id } = req.body;

    if (!student_first_name || typeof student_first_name !== 'string' || !student_first_name.trim()) {
      return res.status(400).json({ error: 'student_first_name (or first_name) is required' });
    }
    if (!student_last_name || typeof student_last_name !== 'string' || !student_last_name.trim()) {
      return res.status(400).json({ error: 'student_last_name (or last_name) is required' });
    }

    if (department !== undefined && department !== null) {
      const dName = department.trim().toUpperCase();
      if (!VALID_DEPARTMENTS.includes(dName)) {
        return res.status(400).json({ error: `department must be one of: ${VALID_DEPARTMENTS.join(', ')}` });
      }
    }

    if (placement_date && !validateDate(placement_date)) {
      return res.status(400).json({ error: 'placement_date must be a valid date' });
    }

    if (placed_drive_id) {
      const [drive] = await pool.query('SELECT drive_id FROM placement_drives WHERE drive_id = ?', [placed_drive_id]);
      if (drive.length === 0) {
        return res.status(404).json({ error: 'Drive not found' });
      }
    }

    const [result] = await pool.query(
      `INSERT INTO students (student_first_name, student_last_name, email, department, placement_date, placed_drive_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        student_first_name.trim(),
        student_last_name.trim(),
        email || null,
        department ? department.trim().toUpperCase() : null,
        placement_date || null,
        placed_drive_id || null
      ]
    );
    res.status(211).json({ student_id: result.insertId, student_first_name, student_last_name });
  } catch (error) {
    console.error('Error creating student:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Update student
app.put('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const rawFirstName = req.body.student_first_name !== undefined ? req.body.student_first_name : req.body.first_name;
    const rawLastName = req.body.student_last_name !== undefined ? req.body.student_last_name : req.body.last_name;
    const student_first_name = typeof rawFirstName === 'string' ? rawFirstName.trim() : rawFirstName;
    const student_last_name = typeof rawLastName === 'string' ? rawLastName.trim() : rawLastName;
    const { email, department, placement_date, placed_drive_id } = req.body;

    const [student] = await pool.query('SELECT student_id FROM students WHERE student_id = ?', [id]);
    if (student.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    if (department !== undefined && department !== null) {
      const dName = department.trim().toUpperCase();
      if (!VALID_DEPARTMENTS.includes(dName)) {
        return res.status(400).json({ error: `department must be one of: ${VALID_DEPARTMENTS.join(', ')}` });
      }
    }

    if (placement_date !== undefined && placement_date !== null && !validateDate(placement_date)) {
      return res.status(400).json({ error: 'placement_date must be a valid date' });
    }

    if (placed_drive_id !== undefined && placed_drive_id !== null) {
      const [drive] = await pool.query('SELECT drive_id FROM placement_drives WHERE drive_id = ?', [placed_drive_id]);
      if (drive.length === 0) {
        return res.status(404).json({ error: 'Drive not found' });
      }
    }

    await pool.query(
      `UPDATE students SET
        student_first_name = COALESCE(?, student_first_name),
        student_last_name = COALESCE(?, student_last_name),
        email = COALESCE(?, email),
        department = COALESCE(?, department),
        placement_date = COALESCE(?, placement_date),
        placed_drive_id = COALESCE(?, placed_drive_id)
      WHERE student_id = ?`,
      [
        student_first_name !== undefined ? student_first_name.trim() : null,
        student_last_name !== undefined ? student_last_name.trim() : null,
        email !== undefined ? email : null,
        department !== undefined ? (department ? department.trim().toUpperCase() : null) : null,
        placement_date !== undefined ? placement_date : null,
        placed_drive_id !== undefined ? placed_drive_id : null,
        id
      ]
    );
    res.json({ success: true, message: 'Student updated successfully' });
  } catch (error) {
    console.error('Error updating student:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete student
app.delete('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await pool.query('SELECT student_id FROM students WHERE student_id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    await pool.query('DELETE FROM students WHERE student_id = ?', [id]);
    res.json({ success: true, message: 'Student deleted successfully' });
  } catch (error) {
    console.error('Error deleting student:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==========================================
// 9. Placement Operations API (Transactions)
// ==========================================

// Record placement by student name/id and company/drive (unified smart endpoint)
app.post('/api/students/record-placement', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const {
      student_id, student_first_name, first_name,
      student_last_name, last_name, student_name, name,
      company_name, company_id, role, drive_id, placement_date
    } = req.body;

    await connection.beginTransaction();

    // 1. Locate student
    let student = null;
    if (student_id) {
      const [rows] = await connection.query('SELECT * FROM students WHERE student_id = ?', [student_id]);
      if (rows.length > 0) student = rows[0];
    }

    const fName = (student_first_name || first_name || '').trim();
    const lName = (student_last_name || last_name || '').trim();
    const fullName = (student_name || name || '').trim();

    if (!student && fName && lName) {
      // Exact match first
      let [rows] = await connection.query(
        'SELECT * FROM students WHERE LOWER(student_first_name) = ? AND LOWER(student_last_name) = ?',
        [fName.toLowerCase(), lName.toLowerCase()]
      );
      if (rows.length === 0) {
        // Substring / fuzzy match
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
        const pFirst = parts[0];
        const pLast = parts.slice(1).join(' ');
        let [rows] = await connection.query(
          'SELECT * FROM students WHERE LOWER(student_first_name) = ? AND LOWER(student_last_name) = ?',
          [pFirst.toLowerCase(), pLast.toLowerCase()]
        );
        if (rows.length === 0) {
          [rows] = await connection.query(
            'SELECT * FROM students WHERE LOWER(student_first_name) LIKE ? AND LOWER(student_last_name) LIKE ?',
            [`%${pFirst.toLowerCase()}%`, `%${pLast.toLowerCase()}%`]
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
      return res.status(404).json({ error: `Student not found for name: "${fName} ${lName}" ${fullName ? `(${fullName})` : ''}`.trim() });
    }

    // 2. Locate Drive / Company
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
          // Auto create company if not existing
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
          // If role doesn't match or not specified, move on with whatever role that company has (first/latest drive)
          if (!chosenDrive) {
            chosenDrive = drives[0];
          }
          resolvedDriveId = chosenDrive.drive_id;
          resolvedRole = chosenDrive.role;
        } else {
          // Create default drive for this company
          const [insDrive] = await connection.query(
            `INSERT INTO placement_drives (company_id, visiting_date, role, ctc, eligibility_10th, eligibility_12th, eligibility_cgpa)
             VALUES (?, ?, ?, 1.0, 50, 50, 6.00)`,
            [compId, normalizeDate(placement_date) || new Date().toISOString().split('T')[0], role || 'Software Engineer']
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
      return res.status(400).json({ error: 'Could not resolve a placement drive or company.' });
    }

    // 3. Resolve Placement Date (Default to today's date if not explicitly specified)
    const pDate = normalizeDate(placement_date) || new Date().toISOString().split('T')[0];

    // 4. Update student record
    await connection.query(
      'UPDATE students SET placed_drive_id = ?, placement_date = ? WHERE student_id = ?',
      [resolvedDriveId, pDate, student.student_id]
    );

    await connection.commit();

    res.json({
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
    console.error('Error recording placement:', error);
    res.status(500).json({ error: `Database error: ${error.message}` });
  } finally {
    connection.release();
  }
});

// Place a student by IDs
app.post('/api/students/place', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { student_id, drive_id, placement_date } = req.body;
    if (!student_id || !drive_id) {
      return res.status(400).json({ error: 'student_id and drive_id are required' });
    }

    const [studentRows] = await connection.query('SELECT student_id, placed_drive_id, student_first_name, student_last_name FROM students WHERE student_id = ?', [student_id]);
    if (studentRows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const [driveRows] = await connection.query(
      'SELECT d.*, c.company_name FROM placement_drives d JOIN companies c ON d.company_id = c.company_id WHERE d.drive_id = ?',
      [drive_id]
    );
    if (driveRows.length === 0) {
      return res.status(404).json({ error: 'Drive not found' });
    }
    const drive = driveRows[0];

    // Default to today's date if not explicitly passed
    const pDate = normalizeDate(placement_date) || new Date().toISOString().split('T')[0];

    await connection.beginTransaction();
    await connection.query(
      'UPDATE students SET placed_drive_id = ?, placement_date = ? WHERE student_id = ?',
      [drive_id, pDate, student_id]
    );
    await connection.commit();

    res.json({
      success: true,
      message: 'Student placed successfully',
      student_id,
      student_name: `${studentRows[0].student_first_name} ${studentRows[0].student_last_name}`,
      company: drive.company_name,
      role: drive.role,
      drive_id,
      placement_date: pDate
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error placing student:', error);
    res.status(500).json({ error: 'Database error' });
  } finally {
    connection.release();
  }
});

// Unplace a student
app.post('/api/students/unplace', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { student_id } = req.body;
    if (!student_id) {
      return res.status(400).json({ error: 'student_id is required' });
    }

    const [studentRows] = await connection.query('SELECT student_id, placed_drive_id FROM students WHERE student_id = ?', [student_id]);
    if (studentRows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    const student = studentRows[0];

    if (!student.placed_drive_id) {
      return res.status(400).json({ error: 'Student is not placed' });
    }

    await connection.beginTransaction();
    await connection.query(
      'UPDATE students SET placed_drive_id = NULL, placement_date = NULL WHERE student_id = ?',
      [student_id]
    );
    await connection.commit();

    res.json({ success: true, message: 'Student unplaced successfully', student_id });
  } catch (error) {
    await connection.rollback();
    console.error('Error unplacing student:', error);
    res.status(500).json({ error: 'Database error' });
  } finally {
    connection.release();
  }
});

// ==========================================
// 10. Compound Setup API (Transactions)
// ==========================================

// Create/update company + drive + branches atomically
app.post('/api/companies/setup', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const {
      company_name, visiting_date, role, jd_link,
      ctc, eligibility_10th, eligibility_12th, eligibility_cgpa, eligibility_backlog,
      branches
    } = req.body;

    if (!company_name || typeof company_name !== 'string' || !company_name.trim()) {
      return res.status(400).json({ error: 'company_name is required' });
    }

    const normVisitingDate = normalizeDate(visiting_date) || new Date().toISOString().split('T')[0];
    const numericCtc = parseNumericCtc(ctc) !== null ? parseNumericCtc(ctc) : 1;
    const numeric10th = parseNumericCtc(eligibility_10th) !== null ? Math.round(parseNumericCtc(eligibility_10th)) : 50;
    const numeric12th = parseNumericCtc(eligibility_12th) !== null ? Math.round(parseNumericCtc(eligibility_12th)) : 50;
    const numericCgpa = parseNumericCtc(eligibility_cgpa) !== null ? parseNumericCtc(eligibility_cgpa) : 6.00;
    const resolvedRole = (role && role.trim()) ? role.trim() : 'Software Engineer';

    const normalizedBranches = normalizeBranches(branches);

    await connection.beginTransaction();

    let [compRows] = await connection.query('SELECT company_id, company_name FROM companies WHERE LOWER(company_name) = ?', [company_name.trim().toLowerCase()]);
    let companyId;
    if (compRows.length > 0) {
      companyId = compRows[0].company_id;
    } else {
      const [insertComp] = await connection.query('INSERT INTO companies (company_name) VALUES (?)', [company_name.trim()]);
      companyId = insertComp.insertId;
    }

    // Check if drive with matching role already exists for this company
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

    // Update branches
    if (normalizedBranches.length > 0) {
      await connection.query('DELETE FROM branches WHERE drive_id = ?', [driveId]);
      for (const branch of normalizedBranches) {
        await connection.query('INSERT INTO branches (drive_id, branch) VALUES (?, ?)', [driveId, branch]);
      }
    }

    await connection.commit();
    res.status(211).json({
      success: true,
      company_id: companyId,
      company_name: company_name.trim(),
      drive_id: driveId,
      role: resolvedRole,
      ctc: numericCtc,
      branches: normalizedBranches
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error in compound setup:', error);
    res.status(500).json({ error: 'Database error' });
  } finally {
    connection.release();
  }
});

// ==========================================
// 11. Reports API
// ==========================================

// Get detailed placement report
app.get('/api/reports/placements', async (req, res) => {
  try {
    const query = `
      SELECT 
        s.student_id,
        CONCAT(s.student_first_name, ' ', s.student_last_name) AS student_name,
        s.department AS student_department,
        s.placement_date,
        d.drive_id,
        c.company_name AS company,
        d.role,
        d.ctc
      FROM students s
      JOIN placement_drives d ON s.placed_drive_id = d.drive_id
      JOIN companies c ON d.company_id = c.company_id
      ORDER BY s.placement_date DESC
    `;
    const [rows] = await pool.query(query);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching placement report:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get branch wise placement statistics
app.get('/api/reports/branches-stats', async (req, res) => {
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
    res.json(rows);
  } catch (error) {
    console.error('Error fetching branches statistics:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Health Check Endpoint
app.get('/health', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    connection.release();
    res.status(200).json({ status: 'OK', database: 'Connected' });
  } catch (error) {
    console.error('Health check database error:', error.message);
    res.status(500).json({ status: 'Error', error: 'Database connection failed' });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Express server running on http://${HOST}:${PORT}`);
});

const gracefulShutdown = () => {
  console.log('SIGTERM/SIGINT received. Shutting down gracefully...');
  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      await pool.end();
      console.log('Database connection pool closed.');
      process.exit(0);
    } catch (err) {
      console.error('Error closing database pool during shutdown:', err);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
