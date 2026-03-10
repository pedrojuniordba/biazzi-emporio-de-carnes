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

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use('/api/', rateLimit({
  windowMs: 60 * 1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em breve.' }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── DATABASE SETUP (PostgreSQL) ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id         SERIAL PRIMARY KEY,
      name       TEXT    NOT NULL,
      phone      TEXT    DEFAULT '',
      total      NUMERIC NOT NULL DEFAULT 0,
      payment    TEXT    NOT NULL,
      status     TEXT    NOT NULL DEFAULT 'pending',
      order_date DATE    NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id       SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      type     TEXT    NOT NULL,
      qty      NUMERIC NOT NULL,
      price    NUMERIC NOT NULL,
      subtotal NUMERIC NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      id          SERIAL PRIMARY KEY,
      order_id    INTEGER,
      name        TEXT    NOT NULL,
      phone       TEXT    DEFAULT '',
      total       NUMERIC NOT NULL,
      payment     TEXT    NOT NULL,
      status      TEXT    NOT NULL,
      items_json  TEXT    NOT NULL,
      order_date  DATE,
      created_at  TIMESTAMP NOT NULL,
      resolved_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stock (
      id         SERIAL PRIMARY KEY,
      sale_date  DATE    NOT NULL UNIQUE,
      meat       NUMERIC NOT NULL DEFAULT 0,
      ribs       NUMERIC NOT NULL DEFAULT 0,
      chicken    NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  console.log('✅ Banco de dados inicializado.');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function getOrderWithItems(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (!rows.length) return null;
  const order = rows[0];
  const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
  order.items = items.rows;
  order.created_at = order.created_at?.toLocaleString('pt-BR');
  order.order_date = order.order_date?.toISOString().split('T')[0];
  return order;
}

async function getAllOrders() {
  const { rows } = await pool.query('SELECT * FROM orders ORDER BY id DESC');
  const orders = [];
  for (const o of rows) {
    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [o.id]);
    o.items = items.rows;
    o.created_at = o.created_at?.toLocaleString('pt-BR');
    o.order_date = o.order_date?.toISOString().split('T')[0];
    orders.push(o);
  }
  return orders;
}

// ─── ROUTES: ORDERS ───────────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  try { res.json(await getAllOrders()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await getOrderWithItems(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  const { name, phone, items, payment, order_date } = req.body;
  if (!name || !items?.length || !payment)
    return res.status(400).json({ error: 'name, items and payment are required' });

  const total = items.reduce((s, i) => s + i.subtotal, 0);
  const date = order_date || new Date().toISOString().split('T')[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO orders (name, phone, total, payment, order_date) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, phone || '', total, payment, date]
    );
    const orderId = rows[0].id;
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, type, qty, price, subtotal) VALUES ($1,$2,$3,$4,$5)`,
        [orderId, item.type, item.qty, item.price, item.subtotal]
      );
    }
    // Abate do estoque ao registrar reserva
    const meatQty    = items.filter(i=>i.type==='meat').reduce((s,i)=>s+parseFloat(i.qty),0);
    const ribsQty    = items.filter(i=>i.type==='ribs').reduce((s,i)=>s+parseFloat(i.qty),0);
    const chickenQty = items.filter(i=>i.type==='chicken').reduce((s,i)=>s+parseFloat(i.qty),0);
    if (meatQty || ribsQty || chickenQty) {
      await client.query(`
        UPDATE stock SET
          meat    = GREATEST(0, meat - $1),
          ribs    = GREATEST(0, ribs - $2),
          chicken = GREATEST(0, chicken - $3),
          updated_at = NOW()
        WHERE sale_date = $4`,
        [meatQty, ribsQty, chickenQty, date]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(await getOrderWithItems(orderId));
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.put('/api/orders/:id', async (req, res) => {
  const { name, phone, items, payment, status, order_date } = req.body;
  const id = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const existing = rows[0];
    const total = items ? items.reduce((s, i) => s + i.subtotal, 0) : existing.total;

    await client.query(`
      UPDATE orders SET
        name = COALESCE($1, name), phone = COALESCE($2, phone),
        total = $3, payment = COALESCE($4, payment),
        status = COALESCE($5, status), order_date = COALESCE($6, order_date),
        updated_at = NOW()
      WHERE id = $7`,
      [name, phone, total, payment, status, order_date, id]
    );

    if (items) {
      await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);
      for (const item of items) {
        await client.query(
          `INSERT INTO order_items (order_id, type, qty, price, subtotal) VALUES ($1,$2,$3,$4,$5)`,
          [id, item.type, item.qty, item.price, item.subtotal]
        );
      }
    }

    const updated = await getOrderWithItems(id);
    const newStatus = status || existing.status;
    const existingStatus = existing.status;

    if ((newStatus === 'paid' || newStatus === 'cancelled') && existingStatus === 'pending') {
      await client.query(`
        INSERT INTO history (order_id, name, phone, total, payment, status, items_json, created_at, order_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [updated.id, updated.name, updated.phone, updated.total,
         updated.payment, newStatus, JSON.stringify(updated.items),
         existing.created_at, updated.order_date]
      );
      // Cancelamento: devolve ao estoque
      if (newStatus === 'cancelled') {
        const meatQty    = updated.items.filter(i=>i.type==='meat').reduce((s,i)=>s+parseFloat(i.qty),0);
        const ribsQty    = updated.items.filter(i=>i.type==='ribs').reduce((s,i)=>s+parseFloat(i.qty),0);
        const chickenQty = updated.items.filter(i=>i.type==='chicken').reduce((s,i)=>s+parseFloat(i.qty),0);
        if (meatQty || ribsQty || chickenQty) {
          await client.query(`
            UPDATE stock SET
              meat    = meat + $1,
              ribs    = ribs + $2,
              chicken = chicken + $3,
              updated_at = NOW()
            WHERE sale_date = $4`,
            [meatQty, ribsQty, chickenQty, updated.order_date]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json(updated);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.delete('/api/orders/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ROUTES: HISTORY ─────────────────────────────────────────────────────────
app.get('/api/history', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM history ORDER BY id DESC');
    res.json(rows.map(r => ({
      ...r,
      items: JSON.parse(r.items_json),
      created_at: r.created_at?.toLocaleString('pt-BR'),
      resolved_at: r.resolved_at?.toLocaleString('pt-BR'),
      order_date: r.order_date?.toISOString().split('T')[0]
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ROUTES: STATS ────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const totalOrders = (await pool.query(`SELECT COUNT(*) as c FROM orders`)).rows[0].c;
    const paid        = (await pool.query(`SELECT COUNT(*) as c FROM orders WHERE status='paid'`)).rows[0].c;
    const pending     = (await pool.query(`SELECT COUNT(*) as c FROM orders WHERE status='pending'`)).rows[0].c;
    const cancelled   = (await pool.query(`SELECT COUNT(*) as c FROM orders WHERE status='cancelled'`)).rows[0].c;
    const revenue     = (await pool.query(`SELECT COALESCE(SUM(total),0) as s FROM orders WHERE status='paid'`)).rows[0].s;
    const itemTotals  = (await pool.query(`
      SELECT oi.type, SUM(oi.qty) as qty FROM order_items oi
      JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled' GROUP BY oi.type
    `)).rows;
    const payTotals   = (await pool.query(`
      SELECT payment, COALESCE(SUM(total),0) as total FROM orders WHERE status='paid' GROUP BY payment
    `)).rows;
    res.json({ totalOrders, paid, pending, cancelled, revenue, itemTotals, payTotals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────
async function buildDailySummary(date) {
  const today = date || new Date().toISOString().split('T')[0];
  const { rows: orders } = await pool.query(
    `SELECT * FROM orders WHERE order_date = $1 AND status != 'cancelled'`, [today]
  );
  if (!orders.length) return null;

  const paid    = orders.filter(o => o.status === 'paid');
  const pending = orders.filter(o => o.status === 'pending');
  const revenue = paid.reduce((s, o) => s + parseFloat(o.total), 0);

  const { rows: items } = await pool.query(`
    SELECT oi.type, SUM(oi.qty) as qty FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.order_date = $1 AND o.status != 'cancelled' GROUP BY oi.type`, [today]
  );

  const meatQty    = items.filter(i => i.type === 'meat' || i.type === 'ribs').reduce((s, i) => s + parseFloat(i.qty), 0);
  const chickenQty = items.find(i => i.type === 'chicken')?.qty || 0;
  const fmt = n => 'R$ ' + parseFloat(n).toFixed(2).replace('.', ',');
  const dateBR = new Date(today + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

  return [
    `🥩 *Biazzi Empório da Carne*`,
    `📅 Resumo de ${dateBR}`,
    ``,
    `📦 *Pedidos*`,
    `  • Total: ${orders.length}`,
    `  • Pagos: ${paid.length}`,
    pending.length > 0 ? `  • Pendentes: ${pending.length}` : null,
    ``,
    `🍖 *Produtos Vendidos*`,
    meatQty > 0    ? `  • 🥩 Carne & Costela: ${meatQty.toFixed(2)} kg` : null,
    chickenQty > 0 ? `  • 🍗 Frango Assado: ${parseFloat(chickenQty).toFixed(0)} unidades` : null,
    ``,
    `💰 *Receita do Dia: ${fmt(revenue)}*`,
    ``,
    `_Enviado automaticamente pelo app Biazzi_`
  ].filter(l => l !== null).join('\n');
}

async function sendWhatsApp(message) {
  const phone  = process.env.WHATSAPP_PHONE;
  const apiKey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apiKey) {
    console.log('[WhatsApp] Variáveis não configuradas — resumo não enviado.');
    return false;
  }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(url);
    console.log(`[WhatsApp] Status: ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error('[WhatsApp] Erro:', e.message);
    return false;
  }
}

app.post('/api/whatsapp/send-summary', async (req, res) => {
  const date = req.body?.date || new Date().toISOString().split('T')[0];
  const msg  = await buildDailySummary(date);
  if (!msg) return res.json({ success: false, message: 'Nenhum pedido encontrado para essa data.' });
  const ok = await sendWhatsApp(msg);
  res.json({ success: ok, preview: msg });
});

app.get('/api/whatsapp/preview', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const msg  = await buildDailySummary(date);
  res.json({ date, preview: msg || 'Nenhum pedido para essa data.' });
});

cron.schedule('0 0 20 * * 0', async () => {
  console.log('[Cron] Resumo dominical às 20h...');
  const today = new Date().toISOString().split('T')[0];
  const msg   = await buildDailySummary(today);
  if (msg) await sendWhatsApp(msg);
  else console.log('[Cron] Sem pedidos hoje.');
}, { timezone: process.env.TZ || 'America/Sao_Paulo' });

// ─── ROUTES: STOCK ────────────────────────────────────────────────────────────
// GET estoque por data
app.get('/api/stock/:date', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM stock WHERE sale_date = $1', [req.params.date]);
    if (!rows.length) return res.json({ sale_date: req.params.date, meat: 0, ribs: 0, chicken: 0 });
    const r = rows[0];
    res.json({ ...r, sale_date: r.sale_date?.toISOString().split('T')[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST/PUT define estoque para uma data (upsert)
app.post('/api/stock', async (req, res) => {
  const { sale_date, meat, ribs, chicken } = req.body;
  if (!sale_date) return res.status(400).json({ error: 'sale_date is required' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO stock (sale_date, meat, ribs, chicken)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (sale_date) DO UPDATE SET
        meat = $2, ribs = $3, chicken = $4, updated_at = NOW()
      RETURNING *`,
      [sale_date, parseFloat(meat)||0, parseFloat(ribs)||0, parseFloat(chicken)||0]
    );
    const r = rows[0];
    res.json({ ...r, sale_date: r.sale_date?.toISOString().split('T')[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// In-memory token store (survives restarts via re-login)
const validTokens = new Set();

// Rate limit for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos.' }
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  const APP_PASSWORD = process.env.APP_PASSWORD;

  if (!APP_PASSWORD) {
    // Se não houver senha configurada, acesso livre (modo dev)
    const token = generateToken();
    validTokens.add(token);
    return res.json({ success: true, token });
  }

  if (!password || password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  const token = generateToken();
  validTokens.add(token);
  res.json({ success: true, token });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) validTokens.delete(token);
  res.json({ success: true });
});

app.get('/api/auth/verify', (req, res) => {
  const token = req.headers['x-auth-token'];
  const APP_PASSWORD = process.env.APP_PASSWORD;
  // Se não há senha configurada, sempre autenticado
  if (!APP_PASSWORD) return res.json({ valid: true });
  res.json({ valid: token ? validTokens.has(token) : false });
});

// Middleware de autenticação para todas as rotas /api (exceto auth)
function requireAuth(req, res, next) {
  const APP_PASSWORD = process.env.APP_PASSWORD;
  if (!APP_PASSWORD) return next(); // sem senha = livre
  const token = req.headers['x-auth-token'];
  if (!token || !validTokens.has(token)) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  next();
}

// Aplicar auth em todas as rotas de dados
app.use('/api/orders', requireAuth);
app.use('/api/history', requireAuth);
app.use('/api/stats', requireAuth);
app.use('/api/whatsapp', requireAuth);
app.use('/api/stock', requireAuth);

// ─── START ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🥩 Biazzi Empório da Carne — App rodando na porta ${PORT}`);
    if (process.env.APP_URL) console.log(`   URL: ${process.env.APP_URL}`);
  });
}).catch(e => {
  console.error('Erro ao inicializar banco:', e.message);
  process.exit(1);
});
