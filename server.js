const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

/* ─────────────────────────────────────────────
   HELPERS
──────────────────────────────────────────── */
const toNumber = v => Number(v) || 0;
const fmtBRL = n => 'R$ ' + toNumber(n).toFixed(2).replace('.', ',');

/* ─────────────────────────────────────────────
   MIDDLEWARE
──────────────────────────────────────────── */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200
}));

app.use(express.json({ limit: '1mb' }));

/* ─────────────────────────────────────────────
   DATABASE
──────────────────────────────────────────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      total NUMERIC NOT NULL DEFAULT 0,
      payment TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      order_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  console.log('✅ Banco inicializado');
}

/* ─────────────────────────────────────────────
   API TEST (debug rápido)
──────────────────────────────────────────── */
app.get('/api/health', (_, res) => {
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────
   STATIC + FRONTEND (⭐ ORDEM CORRETA)
──────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, 'public')));

/* fallback SPA */
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ─────────────────────────────────────────────
   START
──────────────────────────────────────────── */
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on ${PORT}`);
  });
}).catch(e => {
  console.error('Erro ao iniciar:', e);
  process.exit(1);
});
