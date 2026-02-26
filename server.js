const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

/* ──────────────────────────────────────────────────────────────
   HELPERS GLOBAIS (⭐ conversão centralizada e segura)
────────────────────────────────────────────────────────────── */
const toNumber = v => Number(v) || 0;
const fmtBRL = n => 'R$ ' + toNumber(n).toFixed(2).replace('.', ',');

/* ──────────────────────────────────────────────────────────────
   MIDDLEWARE
────────────────────────────────────────────────────────────── */
app.use(helmet({ contentSecurityPolicy: false }));
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em breve.' }
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ──────────────────────────────────────────────────────────────
   DATABASE
────────────────────────────────────────────────────────────── */
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
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      qty NUMERIC NOT NULL,
      price NUMERIC NOT NULL,
      subtotal NUMERIC NOT NULL
    );

    CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY,
      order_id INTEGER,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      total NUMERIC NOT NULL,
      payment TEXT NOT NULL,
      status TEXT NOT NULL,
      items_json TEXT NOT NULL,
      order_date DATE,
      created_at TIMESTAMP NOT NULL,
      resolved_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  console.log('✅ Banco inicializado');
}

/* ──────────────────────────────────────────────────────────────
   HELPERS ORDERS
────────────────────────────────────────────────────────────── */
async function getOrderWithItems(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (!rows.length) return null;

  const order = rows[0];

  const items = await pool.query(
    'SELECT * FROM order_items WHERE order_id = $1',
    [id]
  );

  order.items = items.rows;
  order.created_at = order.created_at?.toLocaleString('pt-BR');
  order.order_date = order.order_date?.toISOString().split('T')[0];

  return order;
}

async function getAllOrders() {
  const { rows } = await pool.query('SELECT * FROM orders ORDER BY id DESC');

  const orders = [];
  for (const o of rows) {
    const items = await pool.query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [o.id]
    );

    o.items = items.rows;
    o.created_at = o.created_at?.toLocaleString('pt-BR');
    o.order_date = o.order_date?.toISOString().split('T')[0];

    orders.push(o);
  }

  return orders;
}

/* ──────────────────────────────────────────────────────────────
   ROUTES ORDERS
────────────────────────────────────────────────────────────── */
app.get('/api/orders', async (_, res) => {
  try {
    res.json(await getAllOrders());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orders', async (req, res) => {
  const { name, phone, payment, order_date } = req.body;

  if (!name || !req.body.items?.length || !payment)
    return res.status(400).json({ error: 'name, items and payment são obrigatórios' });

  /* ⭐ conversão segura aqui */
  const items = req.body.items.map(i => ({
    type: i.type,
    qty: toNumber(i.qty),
    price: toNumber(i.price),
    subtotal: toNumber(i.subtotal)
  }));

  const total = items.reduce((s, i) => s + i.subtotal, 0);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO orders (name, phone, total, payment, order_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, phone || '', total, payment, order_date]
    );

    const orderId = rows[0].id;

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, type, qty, price, subtotal)
         VALUES ($1,$2,$3,$4,$5)`,
        [orderId, item.type, item.qty, item.price, item.subtotal]
      );
    }

    await client.query('COMMIT');

    res.status(201).json(await getOrderWithItems(orderId));

  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ──────────────────────────────────────────────────────────────
   WHATSAPP SUMMARY (⭐ BUG TOTALMENTE RESOLVIDO AQUI)
────────────────────────────────────────────────────────────── */
async function buildDailySummary(date) {
  const today = date || new Date().toISOString().split('T')[0];

  const { rows: orders } = await pool.query(
    `SELECT * FROM orders WHERE order_date = $1 AND status != 'cancelled'`,
    [today]
  );

  if (!orders.length) return null;

  const paid = orders.filter(o => o.status === 'paid');
  const pending = orders.filter(o => o.status === 'pending');

  const revenue = paid.reduce((s, o) => s + toNumber(o.total), 0);

  const { rows: items } = await pool.query(`
    SELECT oi.type, SUM(oi.qty) as qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.order_date = $1 AND o.status != 'cancelled'
    GROUP BY oi.type
  `, [today]);

  const meatQty = items
    .filter(i => i.type === 'meat' || i.type === 'ribs')
    .reduce((s, i) => s + toNumber(i.qty), 0);

  const chickenQty = toNumber(
    items.find(i => i.type === 'chicken')?.qty
  );

  return [
    `🥩 *Biazzi Empório da Carne*`,
    ``,
    `📦 Pedidos: ${orders.length}`,
    `💰 Receita: ${fmtBRL(revenue)}`,
    ``,
    meatQty > 0 ? `🥩 Carne: ${meatQty.toFixed(2)} kg` : null,
    chickenQty > 0 ? `🍗 Frango: ${chickenQty.toFixed(0)} un` : null
  ].filter(Boolean).join('\n');
}

/* ──────────────────────────────────────────────────────────────
   START
────────────────────────────────────────────────────────────── */
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 App rodando na porta ${PORT}`);
  });
}).catch(e => {
  console.error('Erro ao inicializar banco:', e.message);
  process.exit(1);
});
