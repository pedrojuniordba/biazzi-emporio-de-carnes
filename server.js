const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (required for Railway, Heroku, Render, Fly.io, nginx etc.)
app.set('trust proxy', 1);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — restrict in production via ALLOWED_ORIGIN env var
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

// Rate limiting — 200 req/min per IP
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em breve.' }
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // serve frontend

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
// Use DATA_DIR env var to point to a persistent volume in cloud environments
// e.g. on Railway/Render: set DATA_DIR=/data
const dataDir = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(dataDir, 'biazzi.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    phone      TEXT,
    total      REAL    NOT NULL DEFAULT 0,
    payment    TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'pending',
    order_date TEXT    NOT NULL DEFAULT (date('now','localtime')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    type     TEXT    NOT NULL,
    qty      REAL    NOT NULL,
    price    REAL    NOT NULL,
    subtotal REAL    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER,
    name          TEXT    NOT NULL,
    phone         TEXT,
    total         REAL    NOT NULL,
    payment       TEXT    NOT NULL,
    status        TEXT    NOT NULL,
    items_json    TEXT    NOT NULL,
    created_at    TEXT    NOT NULL,
    resolved_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// Migration: add order_date to existing databases
try {
  db.exec(`ALTER TABLE orders ADD COLUMN order_date TEXT NOT NULL DEFAULT (date('now','localtime'))`);
  // Backfill existing rows with created_at date
  db.exec(`UPDATE orders SET order_date = date(created_at) WHERE order_date IS NULL OR order_date = ''`);
} catch(e) { /* column already exists */ }

// Migration: add order_date to history table
try {
  db.exec(`ALTER TABLE history ADD COLUMN order_date TEXT`);
  db.exec(`UPDATE history SET order_date = date(created_at) WHERE order_date IS NULL`);
} catch(e) { /* already exists */ }

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getOrderWithItems(id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
  return order;
}

function getAllOrders() {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  return orders.map(o => {
    o.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id);
    return o;
  });
}

// ─── ROUTES: ORDERS ───────────────────────────────────────────────────────────

// GET all orders
app.get('/api/orders', (req, res) => {
  try {
    res.json(getAllOrders());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET single order
app.get('/api/orders/:id', (req, res) => {
  const order = getOrderWithItems(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// POST create order
app.post('/api/orders', (req, res) => {
  const { name, phone, items, payment, order_date } = req.body;
  if (!name || !items?.length || !payment)
    return res.status(400).json({ error: 'name, items and payment are required' });

  const total = items.reduce((s, i) => s + i.subtotal, 0);
  const date = order_date || new Date().toISOString().split('T')[0];

  const createOrder = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO orders (name, phone, total, payment, order_date) VALUES (?, ?, ?, ?, ?)`
    ).run(name, phone || '', total, payment, date);

    const orderId = result.lastInsertRowid;

    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, type, qty, price, subtotal) VALUES (?, ?, ?, ?, ?)`
    );
    for (const item of items) {
      insertItem.run(orderId, item.type, item.qty, item.price, item.subtotal);
    }

    return getOrderWithItems(orderId);
  });

  try {
    res.status(201).json(createOrder());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update order
app.put('/api/orders/:id', (req, res) => {
  const { name, phone, items, payment, status, order_date } = req.body;
  const id = req.params.id;

  const updateOrder = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!existing) throw new Error('NOT_FOUND');
    
    const total = items ? items.reduce((s, i) => s + i.subtotal, 0) : existing.total;

    db.prepare(`
      UPDATE orders SET
        name = COALESCE(?, name),
        phone = COALESCE(?, phone),
        total = ?,
        payment = COALESCE(?, payment),
        status = COALESCE(?, status),
        order_date = COALESCE(?, order_date),
        updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(name, phone, total, payment, status, order_date, id);

    if (items) {
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      const insertItem = db.prepare(
        `INSERT INTO order_items (order_id, type, qty, price, subtotal) VALUES (?, ?, ?, ?, ?)`
      );
      for (const item of items) {
        insertItem.run(id, item.type, item.qty, item.price, item.subtotal);
      }
    }

    const updated = getOrderWithItems(id);

    // Auto-add to history when status changes to paid or cancelled
    const newStatus = status || existing.status;
    if ((newStatus === 'paid' || newStatus === 'cancelled') && existing.status === 'pending') {
      db.prepare(`
        INSERT INTO history (order_id, name, phone, total, payment, status, items_json, created_at, order_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        updated.id, updated.name, updated.phone, updated.total,
        updated.payment, newStatus,
        JSON.stringify(updated.items), updated.created_at, updated.order_date
      );
    }

    return updated;
  });

  try {
    res.json(updateOrder());
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'Order not found' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE order
app.delete('/api/orders/:id', (req, res) => {
  const result = db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
  res.json({ success: true });
});

// ─── ROUTES: HISTORY ─────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM history ORDER BY id DESC').all();
    res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items_json) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ROUTES: STATS ────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  try {
    const totalOrders   = db.prepare(`SELECT COUNT(*) as c FROM orders`).get().c;
    const paid          = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='paid'`).get().c;
    const pending       = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='pending'`).get().c;
    const cancelled     = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='cancelled'`).get().c;
    const revenue       = db.prepare(`SELECT COALESCE(SUM(total),0) as s FROM orders WHERE status='paid'`).get().s;

    const itemTotals    = db.prepare(`
      SELECT oi.type, SUM(oi.qty) as qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'cancelled'
      GROUP BY oi.type
    `).all();

    const payTotals     = db.prepare(`
      SELECT payment, COALESCE(SUM(total),0) as total
      FROM orders WHERE status='paid'
      GROUP BY payment
    `).all();

    res.json({ totalOrders, paid, pending, cancelled, revenue, itemTotals, payTotals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WHATSAPP RESUMO ─────────────────────────────────────────────────────────

function buildDailySummary(date) {
  const today = date || new Date().toISOString().split('T')[0];

  const orders = db.prepare(`
    SELECT * FROM orders WHERE order_date = ? AND status != 'cancelled'
  `).all(today);

  if (orders.length === 0) return null;

  const paid      = orders.filter(o => o.status === 'paid');
  const pending   = orders.filter(o => o.status === 'pending');
  const revenue   = paid.reduce((s, o) => s + o.total, 0);

  // Item totals
  const items = db.prepare(`
    SELECT oi.type, SUM(oi.qty) as qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.order_date = ? AND o.status != 'cancelled'
    GROUP BY oi.type
  `).all(today);

  const meatQty    = items.filter(i => i.type === 'meat' || i.type === 'ribs').reduce((s, i) => s + i.qty, 0);
  const chickenQty = items.find(i => i.type === 'chicken')?.qty || 0;

  const fmt = n => 'R$ ' + n.toFixed(2).replace('.', ',');
  const dateBR = new Date(today + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

  const msg = [
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
    chickenQty > 0 ? `  • 🍗 Frango Assado: ${chickenQty.toFixed(0)} unidades` : null,
    ``,
    `💰 *Receita do Dia: ${fmt(revenue)}*`,
    ``,
    `_Enviado automaticamente pelo app Biazzi_`
  ].filter(l => l !== null).join('\n');

  return msg;
}

async function sendWhatsApp(message) {
  const phone  = process.env.WHATSAPP_PHONE;
  const apiKey = process.env.CALLMEBOT_APIKEY;

  if (!phone || !apiKey) {
    console.log('[WhatsApp] WHATSAPP_PHONE ou CALLMEBOT_APIKEY não configurados — resumo não enviado.');
    return false;
  }

  const encoded = encodeURIComponent(message);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encoded}&apikey=${apiKey}`;

  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(url);
    const body = await res.text();
    console.log(`[WhatsApp] Enviado. Status: ${res.status} — ${body.slice(0, 80)}`);
    return res.ok;
  } catch (e) {
    console.error('[WhatsApp] Erro ao enviar:', e.message);
    return false;
  }
}

// Manual trigger endpoint (para testar sem esperar às 20h)
app.post('/api/whatsapp/send-summary', async (req, res) => {
  const date = req.body?.date || new Date().toISOString().split('T')[0];
  const msg  = buildDailySummary(date);

  if (!msg) return res.json({ success: false, message: 'Nenhum pedido encontrado para essa data.' });

  const ok = await sendWhatsApp(msg);
  res.json({ success: ok, preview: msg });
});

// GET preview do resumo (sem enviar)
app.get('/api/whatsapp/preview', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const msg  = buildDailySummary(date);
  res.json({ date, preview: msg || 'Nenhum pedido para essa data.' });
});

// ─── CRON: toda domingo às 20h (fuso configurável via TZ env var) ─────────────
// TZ=America/Sao_Paulo (padrão)
// Expressão: segundo minuto hora dia mês dia-semana
// '0 0 20 * * 0' = todo domingo às 20:00:00
cron.schedule('0 0 20 * * 0', async () => {
  console.log('[Cron] Executando resumo dominical às 20h...');
  const today = new Date().toISOString().split('T')[0];
  const msg   = buildDailySummary(today);

  if (!msg) {
    console.log('[Cron] Nenhum pedido hoje, resumo não enviado.');
    return;
  }

  await sendWhatsApp(msg);
}, {
  timezone: process.env.TZ || 'America/Sao_Paulo'
});

console.log('[Cron] Agendado: resumo dominical às 20h (America/Sao_Paulo)');

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🥩 Biazzi Empório da Carne — App rodando:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   DB:      ${path.join(dataDir, 'biazzi.db')}`);
  if (process.env.APP_URL) console.log(`   Internet: ${process.env.APP_URL}`);
  console.log('');
});
