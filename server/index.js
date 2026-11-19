const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { pool, tx, migrate, hashPin, checkPin, startListener, notify, listeners } = require('./db');
const adminRouter = require('./admin');

const CONFIG = {
  restaurant: process.env.RESTAURANT_NAME || 'Ember & Bao',
  terminal: process.env.TERMINAL_NAME || 'Terminal 2',
  currency: process.env.CURRENCY_SYMBOL || 'Rs ',
  taxLabel: process.env.TAX_LABEL || 'VAT',
  taxRate: Number(process.env.TAX_RATE ?? 0.18),          // fraction, e.g. 0.18 = 18%
  serviceRate: Number(process.env.SERVICE_RATE ?? 0.10),  // fraction
  lateMinutes: Number(process.env.LATE_MINUTES ?? 12),
  timezone: process.env.TZ_DISPLAY || 'Asia/Colombo',
};

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const int = (v) => (v === null || v === undefined || v === '' ? null : parseInt(v, 10));

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function computeTotals(order, items) {
  const subtotal = items.reduce((s, i) => s + i.qty * (i.unit_price_cents + i.addons_cents), 0);
  const discount = Math.round(subtotal * (order.discount_pct || 0) / 100);
  const base = subtotal - discount;
  const service = order.service_on ? Math.round(base * CONFIG.serviceRate) : 0;
  const tax = Math.round(base * CONFIG.taxRate);
  const tip = Math.round(base * (order.tip_pct || 0) / 100);
  const total = base + service + tax + tip;
  return { subtotal_cents: subtotal, discount_cents: discount, service_cents: service, tax_cents: tax, tip_cents: tip, total_cents: total };
}

async function saveTotals(client, orderId) {
  const { rows: [o] } = await client.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  const { rows: items } = await client.query('SELECT qty, unit_price_cents, addons_cents FROM order_items WHERE order_id=$1', [orderId]);
  const t = computeTotals(o, items);
  await client.query(
    `UPDATE orders SET subtotal_cents=$2, discount_cents=$3, service_cents=$4, tax_cents=$5, tip_cents=$6, total_cents=$7 WHERE id=$1`,
    [orderId, t.subtotal_cents, t.discount_cents, t.service_cents, t.tax_cents, t.tip_cents, t.total_cents]);
  return t;
}

// Derive a single display status for an order from its KOTs and items.
function orderStatus(o) {
  if (o.status === 'paid') return 'paid';
  if (o.status === 'void') return 'void';
  if (o.bill_printed_at) return 'billed';
  if (o.kot_ready > 0) return 'ready';
  if (o.kot_live > 0) return 'kitchen';
  if (o.pending_items > 0 || o.item_count === 0) return 'ordering';
  return 'dining';
}

const ORDER_SUMMARY_SQL = `
  SELECT o.*, t.code AS table_code, s.name AS staff_name,
    (SELECT count(*)::int FROM order_items i WHERE i.order_id=o.id) AS item_count,
    (SELECT coalesce(sum(qty),0)::int FROM order_items i WHERE i.order_id=o.id) AS item_qty,
    (SELECT count(*)::int FROM order_items i WHERE i.order_id=o.id AND i.kot_id IS NULL) AS pending_items,
    (SELECT count(*)::int FROM kots k WHERE k.order_id=o.id) AS kot_count,
    (SELECT count(*)::int FROM kots k WHERE k.order_id=o.id AND k.status IN ('held','new','cooking')) AS kot_live,
    (SELECT count(*)::int FROM kots k WHERE k.order_id=o.id AND k.status='ready') AS kot_ready
  FROM orders o
  LEFT JOIN dining_tables t ON t.id=o.table_id
  LEFT JOIN staff s ON s.id=o.staff_id`;

async function loadOrder(id, client = pool) {
  const { rows: [o] } = await client.query(`${ORDER_SUMMARY_SQL} WHERE o.id=$1`, [id]);
  if (!o) throw new HttpError(404, 'Order not found');
  const { rows: items } = await client.query(
    `SELECT i.*, k.kot_no, k.status AS kot_status, st.name AS station_name
     FROM order_items i LEFT JOIN kots k ON k.id=i.kot_id LEFT JOIN stations st ON st.id=i.station_id
     WHERE i.order_id=$1 ORDER BY i.id`, [id]);
  const { rows: kots } = await client.query(
    `SELECT k.*, st.name AS station_name FROM kots k LEFT JOIN stations st ON st.id=k.station_id
     WHERE k.order_id=$1 ORDER BY k.id`, [id]);
  o.display_status = orderStatus(o);
  o.items = items;
  o.kots = kots;
  Object.assign(o, computeTotals(o, items));
  return o;
}

// ---------- auth ----------
app.get('/api/config', (req, res) => res.json(CONFIG));

app.post('/api/login', wrap(async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!/^\d{4,8}$/.test(pin)) bad('Enter your PIN');
  const { rows } = await pool.query('SELECT * FROM staff WHERE active');
  const user = rows.find((s) => checkPin(pin, s.pin_hash));
  if (!user) throw new HttpError(401, 'Wrong PIN');
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO sessions(token, staff_id) VALUES ($1,$2)', [token, user.id]);
  res.setHeader('Set-Cookie', `pos_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 16}${req.secure ? '; Secure' : ''}`);
  res.json({ id: user.id, name: user.name, initials: user.initials, role: user.role });
}));

async function auth(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie).pos_session;
    if (!token) throw new HttpError(401, 'Not signed in');
    const { rows: [u] } = await pool.query(
      `SELECT s.id, s.name, s.initials, s.role FROM sessions x JOIN staff s ON s.id=x.staff_id
       WHERE x.token=$1 AND s.active AND x.created_at > now() - interval '16 hours'`, [token]);
    if (!u) throw new HttpError(401, 'Session expired');
    req.user = u; req.token = token;
    next();
  } catch (e) { next(e); }
}
app.use('/api', auth);

app.get('/api/me', (req, res) => res.json(req.user));
app.use('/api/admin', adminRouter({ pool, tx, hashPin, checkPin, notify, wrap, HttpError }));
app.post('/api/logout', wrap(async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE token=$1', [req.token]);
  res.setHeader('Set-Cookie', 'pos_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
}));

// ---------- live events (SSE, fanned out across instances via LISTEN/NOTIFY) ----------
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (kind) => res.write(`data: ${kind}\n\n`);
  const hb = setInterval(() => res.write(': hb\n\n'), 25000);
  listeners.add(send);
  req.on('close', () => { clearInterval(hb); listeners.delete(send); });
});

// ---------- menu ----------
app.get('/api/menu', wrap(async (req, res) => {
  const { rows: categories } = await pool.query('SELECT * FROM categories ORDER BY sort, id');
  const { rows: items } = await pool.query(
    `SELECT m.*, st.name AS station_name, st.code AS station_code,
       coalesce((SELECT json_agg(json_build_object('id',a.id,'name',a.name,'price_cents',a.price_cents) ORDER BY a.id)
                 FROM item_addons a WHERE a.item_id=m.id), '[]') AS addons
     FROM menu_items m JOIN stations st ON st.id=m.station_id WHERE m.active ORDER BY m.sort, m.id`);
  const { rows: stations } = await pool.query('SELECT * FROM stations ORDER BY sort, id');
  res.json({ categories: categories.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) })), stations });
}));

// ---------- floor + queue ----------
app.get('/api/floor', wrap(async (req, res) => {
  const { rows: areas } = await pool.query('SELECT * FROM areas ORDER BY sort, id');
  const { rows: tables } = await pool.query('SELECT * FROM dining_tables WHERE active ORDER BY sort, id');
  const { rows: open } = await pool.query(`${ORDER_SUMMARY_SQL} WHERE o.status='open' ORDER BY o.opened_at`);
  for (const o of open) o.display_status = orderStatus(o);
  const byTable = Object.fromEntries(open.filter((o) => o.table_id).map((o) => [o.table_id, o]));
  const outTables = tables.map((t) => {
    const o = byTable[t.id];
    return { ...t, status: o ? o.display_status : 'free', order: o ? {
      id: o.id, order_no: o.order_no, guests: o.guests, opened_at: o.opened_at, total_cents: o.total_cents } : null };
  });
  const queue = open.filter((o) => o.type !== 'dinein').map((o) => ({
    id: o.id, order_no: o.order_no, type: o.type, customer_name: o.customer_name, opened_at: o.opened_at,
    total_cents: o.total_cents, status: o.display_status }));
  const { rows: [counts] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM kots WHERE status IN ('held','new','cooking','ready')) AS live_tickets,
            (SELECT count(*)::int FROM orders WHERE status='paid' AND closed_at::date = (now() AT TIME ZONE $1)::date) AS closed_today`,
    [CONFIG.timezone]);
  const seated = outTables.filter((t) => t.order);
  res.json({
    areas: areas.map((a) => ({ ...a, tables: outTables.filter((t) => t.area_id === a.id) })),
    queue,
    stats: { tables: tables.length, seated: seated.length, covers: seated.reduce((s, t) => s + t.order.guests, 0), ...counts },
  });
}));

// ---------- orders ----------
app.post('/api/orders', wrap(async (req, res) => {
  const { type } = req.body;
  if (!['dinein', 'takeaway', 'delivery', 'counter'].includes(type)) bad('Unknown order type');
  const tableId = int(req.body.table_id);
  if (type === 'dinein' && !tableId) bad('Pick a table');
  if (type === 'takeaway' && !req.body.customer_name) bad('Customer name is required');
  if (type === 'delivery' && (!req.body.customer_name || !req.body.address)) bad('Name and address are required');
  if (tableId) {
    const { rows: [tbl] } = await pool.query('SELECT id FROM dining_tables WHERE id=$1 AND active', [tableId]);
    if (!tbl) bad('Table not found');
    const { rows: [existing] } = await pool.query("SELECT id FROM orders WHERE table_id=$1 AND status='open'", [tableId]);
    if (existing) return res.json(await loadOrder(existing.id));
  }
  const guests = Math.max(1, int(req.body.guests) || (type === 'dinein' ? 2 : 1));
  const { rows: [o] } = await pool.query(
    `INSERT INTO orders(type, table_id, guests, customer_name, phone, address, staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [type, type === 'dinein' ? tableId : null, guests, req.body.customer_name || null, req.body.phone || null, req.body.address || null, req.user.id]);
  notify('floor');
  res.status(201).json(await loadOrder(o.id));
}));

app.get('/api/orders/:id', wrap(async (req, res) => res.json(await loadOrder(int(req.params.id)))));

app.patch('/api/orders/:id', wrap(async (req, res) => {
  const id = int(req.params.id);
  const allowed = {
    guests: (v) => Math.max(1, int(v)),
    discount_pct: (v) => { const n = int(v); if (![0, 10, 20].includes(n)) bad('Bad discount'); return n; },
    service_on: (v) => !!v,
    tip_pct: (v) => { const n = int(v); if (n < 0 || n > 50) bad('Bad tip'); return n; },
    split_ways: (v) => { const n = int(v); if (n < 1 || n > 10) bad('Bad split'); return n; },
    payment_method: (v) => { if (!['card', 'cash', 'wallet'].includes(v)) bad('Bad payment method'); return v; },
    customer_name: (v) => v || null, phone: (v) => v || null, address: (v) => v || null,
  };
  const sets = []; const vals = [id];
  for (const [k, fn] of Object.entries(allowed)) {
    if (k in req.body) { vals.push(fn(req.body[k])); sets.push(`${k}=$${vals.length}`); }
  }
  if (!sets.length) bad('Nothing to update');
  await tx(async (c) => {
    const r = await c.query(`UPDATE orders SET ${sets.join(', ')} WHERE id=$1 AND status='open'`, vals);
    if (!r.rowCount) bad('Order is closed');
    await saveTotals(c, id);
  });
  notify('order');
  res.json(await loadOrder(id));
}));

app.post('/api/orders/:id/items', wrap(async (req, res) => {
  const id = int(req.params.id);
  const qty = Math.max(1, int(req.body.qty) || 1);
  const out = await tx(async (c) => {
    const { rows: [o] } = await c.query("SELECT id FROM orders WHERE id=$1 AND status='open' FOR UPDATE", [id]);
    if (!o) bad('Order is closed');
    const { rows: [m] } = await c.query(
      'SELECT m.*, c.default_course FROM menu_items m JOIN categories c ON c.id=m.category_id WHERE m.id=$1 AND m.active', [int(req.body.menu_item_id)]);
    if (!m) bad('Dish not found');
    const addonIds = (req.body.addon_ids || []).map(int).filter(Boolean);
    const { rows: addons } = addonIds.length
      ? await c.query('SELECT id, name, price_cents FROM item_addons WHERE item_id=$1 AND id = ANY($2)', [m.id, addonIds])
      : { rows: [] };
    const course = ['drink', 'starter', 'main', 'dessert'].includes(req.body.course) ? req.body.course : m.default_course;
    const spice = m.has_spice && req.body.spice && req.body.spice !== 'Standard' ? String(req.body.spice).slice(0, 20) : null;
    const note = req.body.note ? String(req.body.note).slice(0, 200) : null;
    // merge with an identical unsent line
    const { rows: [same] } = await c.query(
      `SELECT id FROM order_items WHERE order_id=$1 AND kot_id IS NULL AND menu_item_id=$2 AND course=$3
         AND spice IS NOT DISTINCT FROM $4 AND note IS NOT DISTINCT FROM $5 AND addons=$6::jsonb`,
      [id, m.id, course, spice, note, JSON.stringify(addons)]);
    if (same) {
      await c.query('UPDATE order_items SET qty=qty+$2 WHERE id=$1', [same.id, qty]);
    } else {
      await c.query(
        `INSERT INTO order_items(order_id, menu_item_id, station_id, name, qty, unit_price_cents, addons, addons_cents, spice, course, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, m.id, m.station_id, m.name, qty, m.price_cents, JSON.stringify(addons), addons.reduce((s, a) => s + a.price_cents, 0), spice, course, note]);
    }
    await saveTotals(c, id);
    return id;
  });
  notify('order');
  res.json(await loadOrder(out));
}));

app.patch('/api/items/:id', wrap(async (req, res) => {
  const itemId = int(req.params.id);
  const qty = int(req.body.qty);
  const orderId = await tx(async (c) => {
    const { rows: [i] } = await c.query(
      "SELECT i.* FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.id=$1 AND o.status='open'", [itemId]);
    if (!i) bad('Item not found');
    if (i.kot_id) bad('Already sent to the kitchen');
    if (!qty || qty < 1) await c.query('DELETE FROM order_items WHERE id=$1', [itemId]);
    else await c.query('UPDATE order_items SET qty=$2 WHERE id=$1', [itemId, qty]);
    await saveTotals(c, i.order_id);
    return i.order_id;
  });
  notify('order');
  res.json(await loadOrder(orderId));
}));

// Send unsent items to the kitchen as KOTs.
app.post('/api/orders/:id/kots', wrap(async (req, res) => {
  const id = int(req.params.id);
  const mode = req.body.mode === 'single' ? 'single' : 'station';
  const holdLater = !!req.body.hold_later; // hold mains & desserts until fired
  const created = await tx(async (c) => {
    const { rows: [o] } = await c.query("SELECT * FROM orders WHERE id=$1 AND status='open' FOR UPDATE", [id]);
    if (!o) bad('Order is closed');
    const { rows: pending } = await c.query('SELECT * FROM order_items WHERE order_id=$1 AND kot_id IS NULL ORDER BY id', [id]);
    if (!pending.length) bad('Nothing new to send');
    const { rows: [prev] } = await c.query('SELECT count(*)::int AS n FROM kots WHERE order_id=$1', [id]);
    const isAddon = prev.n > 0;
    const groups = new Map();
    for (const it of pending) {
      const held = holdLater && (it.course === 'main' || it.course === 'dessert');
      const key = `${mode === 'single' ? 'all' : it.station_id}|${held ? 'held' : 'now'}`;
      if (!groups.has(key)) groups.set(key, { station: mode === 'single' ? null : it.station_id, held, items: [] });
      groups.get(key).items.push(it);
    }
    const out = [];
    for (const g of groups.values()) {
      const { rows: [k] } = await c.query(
        'INSERT INTO kots(order_id, station_id, status, is_addon, staff_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [id, g.station, g.held ? 'held' : 'new', isAddon, req.user.id]);
      await c.query('UPDATE order_items SET kot_id=$1 WHERE id = ANY($2)', [k.id, g.items.map((i) => i.id)]);
      out.push(k);
    }
    // printing a bill then adding items re-opens the bill
    await c.query('UPDATE orders SET bill_printed_at=NULL WHERE id=$1', [id]);
    return out;
  });
  notify('kitchen');
  res.json({ kots: created, order: await loadOrder(id) });
}));

app.post('/api/orders/:id/print-bill', wrap(async (req, res) => {
  const id = int(req.params.id);
  await tx(async (c) => {
    const r = await c.query("UPDATE orders SET bill_printed_at=now() WHERE id=$1 AND status='open'", [id]);
    if (!r.rowCount) bad('Order is closed');
    await saveTotals(c, id);
  });
  notify('floor');
  res.json(await loadOrder(id));
}));

app.post('/api/orders/:id/pay', wrap(async (req, res) => {
  const id = int(req.params.id);
  const method = req.body.payment_method;
  if (!['card', 'cash', 'wallet'].includes(method)) bad('Pick a payment method');
  await tx(async (c) => {
    const { rows: [o] } = await c.query("SELECT * FROM orders WHERE id=$1 AND status='open' FOR UPDATE", [id]);
    if (!o) bad('Order is closed');
    const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM order_items WHERE order_id=$1', [id]);
    if (!n.n) bad('Order has no items');
    await c.query('DELETE FROM order_items WHERE order_id=$1 AND kot_id IS NULL', [id]); // drop unsent lines
    await saveTotals(c, id);
    await c.query("UPDATE orders SET status='paid', payment_method=$2, closed_at=now() WHERE id=$1", [id, method]);
    // anything still in the kitchen stays on the KDS; ready tickets for counter/takeaway are cleared by kitchen
  });
  notify('floor');
  res.json(await loadOrder(id));
}));

app.post('/api/orders/:id/void', wrap(async (req, res) => {
  const id = int(req.params.id);
  await tx(async (c) => {
    const r = await c.query("UPDATE orders SET status='void', closed_at=now() WHERE id=$1 AND status='open'", [id]);
    if (!r.rowCount) bad('Order is closed');
    await c.query("UPDATE kots SET status='served', served_at=now() WHERE order_id=$1 AND status<>'served'", [id]);
  });
  notify('floor');
  res.json({ ok: true });
}));

// ---------- kitchen display ----------
app.get('/api/kitchen', wrap(async (req, res) => {
  const { rows: kots } = await pool.query(
    `SELECT k.*, st.name AS station_name, st.code AS station_code, o.order_no, o.type, o.guests, o.customer_name,
            t.code AS table_code,
            extract(epoch FROM (now() - k.fired_at))::int AS age_sec
     FROM kots k JOIN orders o ON o.id=k.order_id LEFT JOIN dining_tables t ON t.id=o.table_id
     LEFT JOIN stations st ON st.id=k.station_id
     WHERE k.status <> 'served' ORDER BY k.fired_at, k.id`);
  const ids = kots.map((k) => k.id);
  const { rows: items } = ids.length
    ? await pool.query('SELECT id, kot_id, name, qty, spice, note, addons, done, course FROM order_items WHERE kot_id = ANY($1) ORDER BY id', [ids])
    : { rows: [] };
  for (const k of kots) {
    k.items = items.filter((i) => i.kot_id === k.id);
    k.late = k.status === 'cooking' && k.age_sec > CONFIG.lateMinutes * 60;
  }
  const { rows: stations } = await pool.query('SELECT * FROM stations ORDER BY sort, id');
  res.json({ kots, stations });
}));

const NEXT = { held: 'new', new: 'cooking', cooking: 'ready', ready: 'served' };
app.post('/api/kots/:id/advance', wrap(async (req, res) => {
  const id = int(req.params.id);
  const { rows: [k] } = await pool.query('SELECT * FROM kots WHERE id=$1', [id]);
  if (!k) throw new HttpError(404, 'Ticket not found');
  const next = NEXT[k.status];
  if (!next) bad('Ticket already cleared');
  const stamp = { new: 'fired_at', cooking: 'started_at', ready: 'ready_at', served: 'served_at' }[next];
  await pool.query(`UPDATE kots SET status=$2, ${stamp}=now() WHERE id=$1 AND status=$3`, [id, next, k.status]);
  if (next === 'served') await pool.query('UPDATE order_items SET done=TRUE WHERE kot_id=$1', [id]);
  notify('kitchen');
  res.json({ ok: true, status: next });
}));

app.post('/api/items/:id/toggle-done', wrap(async (req, res) => {
  await pool.query('UPDATE order_items SET done = NOT done WHERE id=$1 AND kot_id IS NOT NULL', [int(req.params.id)]);
  notify('kitchen');
  res.json({ ok: true });
}));

// ---------- history ----------
app.get('/api/history', wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const { rows } = await pool.query(
    `${ORDER_SUMMARY_SQL}
     WHERE (o.status='open' OR (o.opened_at AT TIME ZONE $1)::date = coalesce($2::date, (now() AT TIME ZONE $1)::date))
     ORDER BY o.opened_at DESC`, [CONFIG.timezone, date]);
  for (const o of rows) o.display_status = orderStatus(o);
  const paid = rows.filter((o) => o.status === 'paid');
  res.json({
    orders: rows,
    stats: { paid: paid.length, collected_cents: paid.reduce((s, o) => s + o.total_cents, 0), open: rows.filter((o) => o.status === 'open').length },
  });
}));

// ---------- static SPA ----------
app.get('/healthz', wrap(async (req, res) => { await pool.query('SELECT 1'); res.send('ok'); }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

const PORT = process.env.PORT || 3000;
(async () => {
  await migrate();
  await startListener();
  app.listen(PORT, () => console.log(`POS listening on :${PORT}`));
})().catch((e) => { console.error(e); process.exit(1); });
