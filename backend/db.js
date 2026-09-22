import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const pool = mysql.createPool({
  host: process.env.DATABASE_HOST || process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DATABASE_PORT || process.env.DB_PORT || '3306'),
  user: process.env.DATABASE_USER || process.env.DB_USER || 'root',
  password: process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD,
  database: process.env.DATABASE_NAME || process.env.DB_NAME || 'placement_monitoring',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

export default pool;
