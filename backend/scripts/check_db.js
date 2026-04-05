#!/usr/bin/env node
require('dotenv').config({ path: 'backend/.env' });
const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER || 'localhost',
  database: process.env.DB_NAME || 'ZaneeStore',
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD || '',
  options: {
    encrypt: String(process.env.DB_ENCRYPT) === 'true',
    trustServerCertificate: String(process.env.DB_TRUST_CERT) !== 'false',
    enableArithAbort: true,
  },
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 1433,
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

(async () => {
  try {
    const pool = await sql.connect(config);
    const username = process.argv[2];
    let result;
    if (username) {
      result = await pool.request().input('username', sql.NVarChar, username).query(
        'SELECT TOP 10 * FROM dbo.Users WHERE Username = @username ORDER BY CreatedAt DESC'
      );
    } else {
      result = await pool.request().query('SELECT TOP 10 * FROM dbo.Users ORDER BY CreatedAt DESC');
    }
    console.log(JSON.stringify(result.recordset, null, 2));
    await sql.close();
    process.exit(0);
  } catch (err) {
    console.error((err && err.message) || err);
    try {
      await sql.close();
    } catch (e) {}
    process.exit(1);
  }
})();
