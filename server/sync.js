// Offline-first sync between the shop server (POS_MODE=local) and the cloud copy on Railway (POS_MODE=mirror).
//
// The shop server is the master. Database triggers record every change in sync_outbox, in the same
// transaction as the change itself, so nothing can be missed. A background worker sends the queue to
// the cloud whenever the internet is up; when it's down the queue simply grows and drains later.
// Orders, kitchen tickets, printing and payments never wait for the internet.
const crypto = require('crypto');
const express = require('express');

// Tables copied to the cloud, parents before children. sessions, print_jobs and sync tables stay local.
const TABLES = [
  ['staff', ['id']], ['areas', ['id']], ['dining_tables', ['id']], ['printers', ['id']], ['stations', ['id']],
  ['categories', ['id']], ['menu_items', ['id']], ['item_addons', ['id']], ['menu_item_images', ['item_id']],
  ['suppliers', ['id']], ['ingredients', ['id']], ['recipe_items', ['menu_item_id', 'ingredient_id']],
  ['shifts', ['id']], ['orders', ['id']], ['kots', ['id']], ['order_items', ['id']], ['item_voids', ['id']],
  ['refunds', ['id']], ['cash_movements', ['id']], ['audit_log', ['id']], ['purchases', ['id']],
  ['purchase_items', ['id']], ['supplier_payments', ['id']], ['stock_moves', ['id']],
  ['settings', ['key']], ['app_images', ['key']],
];
const PK = Object.fromEntries(TABLES);
// Shop-only settings never go to the cloud copy: the print bridge token and the n8n integration (its signing secret).
const LOCAL_ONLY_SETTINGS = { has: (k) => /^(bridge|n8n)_/.test(k) };
const BATCH_BYTES = 3 * 1024 * 1024;

const SYNC_SQL = `
CREATE TABLE IF NOT EXISTS sync_outbox (
  id          BIGSERIAL PRIMARY KEY,
  tbl         TEXT NOT NULL,
  op          CHAR(1) NOT NULL,          -- I, U, D
  pk          JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);

-- Records which row changed. The worker reads the row's current state when it sends,
-- so a row edited 20 times while offline is sent once, as it is now.
CREATE OR REPLACE FUNCTION sync_capture() RETURNS trigger AS $$
DECLARE r jsonb; p jsonb := '{}'::jsonb; k text;
BEGIN
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'settings' AND (r->>'key' LIKE 'bridge\_%' OR r->>'key' LIKE 'n8n\_%') THEN RETURN NULL; END IF; -- shop-only values
  FOREACH k IN ARRAY TG_ARGV LOOP p := p || jsonb_build_object(k, r -> k); END LOOP;
  INSERT INTO sync_outbox(tbl, op, pk) VALUES (TG_TABLE_NAME, left(TG_OP, 1), p);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
`;

module.exports = function createSync({ pool, tx, wrap, HttpError, notify, MODE, CLOUD_URL, SYNC_TOKEN }) {
  const state = { online: null, lastOkAt: null, lastError: null, lastErrorAt: null, sending: false, snapshot: null };

  async function getState(c, key) { const { rows: [r] } = await c.query('SELECT value FROM sync_state WHERE key=$1', [key]); return r ? r.value : null; }
  async function setState(c, key, value) {
    await c.query('INSERT INTO sync_state(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
  }

  // ---------- setup ----------
  async function setup() {
    await pool.query(SYNC_SQL);
    if (MODE === 'local') {
      for (const [t, cols] of TABLES) {
        await pool.query(`DROP TRIGGER IF EXISTS sync_capture ON ${t}`);
        await pool.query(`CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON ${t}
                          FOR EACH ROW EXECUTE FUNCTION sync_capture(${cols.map((c) => `'${c}'`).join(',')})`);
      }
    } else {
      // standalone / mirror: no change capture
      for (const [t] of TABLES) await pool.query(`DROP TRIGGER IF EXISTS sync_capture ON ${t}`);
    }
  }

  // Serial counters never fall behind the data (matters after a restore, or if the cloud copy is ever promoted).
  async function repairSequences() {
    await pool.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
        FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
        JOIN pg_class t ON t.oid = d.refobjid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
        WHERE s.relkind = 'S' AND t.relnamespace = 'public'::regnamespace
      LOOP
        EXECUTE format('SELECT setval(%L, GREATEST((SELECT coalesce(max(%I),0) FROM %I), 1))', r.seq, r.col, r.tbl);
      END LOOP;
      PERFORM setval('order_no_seq', GREATEST((SELECT coalesce(max(order_no), 1039) FROM orders), (SELECT last_value FROM order_no_seq)));
      PERFORM setval('kot_no_seq', GREATEST((SELECT coalesce(max(kot_no), 2199) FROM kots), (SELECT last_value FROM kot_no_seq)));
    END $$`);
  }

  // ---------- shop server: push worker ----------
  async function rowsFor(tbl, pks) {
    if (!pks.length) return new Map();
    const cols = PK[tbl];
    const cond = `concat_ws('|', ${cols.map((c) => `t.${c}::text`).join(', ')}) = ANY($1)`;
    const keys = pks.map((p) => cols.map((c) => String(p[c])).join('|'));
    const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${tbl} t WHERE ${cond}`, [keys]);
    return new Map(rows.map((r) => [cols.map((c) => String(r.row[c])).join('|'), r.row]));
  }

  async function post(changes) {
    const body = JSON.stringify({ changes });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(`${CLOUD_URL}/sync/ingest`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-sync-token': SYNC_TOKEN },
        body,
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))).error || `Cloud replied ${res.status}`;
        throw Object.assign(new Error(msg), { status: res.status });
      }
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Cloud did not answer (timeout)');
      if (!e.status) throw new Error(`No internet or cloud unreachable (${e.cause?.code || e.message})`);
      throw e;
    } finally { clearTimeout(timer); }
  }

  // First run: send every row once, table by table, so the cloud copy starts complete.
  async function snapshot() {
    for (const [tbl, cols] of TABLES) {
      let last = null;
      for (;;) {
        const order = cols.map((c) => `t.${c}`).join(',');
        const where = last ? `WHERE (${order}) > (${cols.map((_, i) => `$${i + 1}`).join(',')})` : '';
        const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${tbl} t ${where} ORDER BY ${order} LIMIT 300`, last || []);
        if (!rows.length) break;
        let batch = []; let size = 0;
        for (const { row } of rows) {
          if (tbl === 'settings' && LOCAL_ONLY_SETTINGS.has(row.key)) continue;
          const len = JSON.stringify(row).length;
          if (size + len > BATCH_BYTES && batch.length) { await post(batch); batch = []; size = 0; }
          batch.push({ tbl, op: 'U', row }); size += len;
        }
        if (batch.length) await post(batch);
        state.snapshot = `Copying ${tbl}…`;
        const lastRow = rows[rows.length - 1].row;
        last = cols.map((c) => lastRow[c]);
        if (rows.length < 300) break;
      }
    }
    await setState(pool, 'snapshot_done', new Date().toISOString());
    state.snapshot = null;
  }

  async function drainOnce() {
    const { rows: queue } = await pool.query('SELECT id, tbl, op, pk FROM sync_outbox ORDER BY id LIMIT 500');
    if (!queue.length) return 0;
    // Keep only the latest change per row; read rows as they are now.
    const latest = new Map();
    for (const q of queue) latest.set(`${q.tbl}|${JSON.stringify(q.pk)}`, q);
    const ordered = [...latest.values()].sort((a, b) => Number(a.id) - Number(b.id));
    const byTable = new Map();
    for (const q of ordered) { if (!byTable.has(q.tbl)) byTable.set(q.tbl, []); byTable.get(q.tbl).push(q.pk); }
    const current = new Map();
    for (const [tbl, pks] of byTable) current.set(tbl, await rowsFor(tbl, pks));
    const changes = [];
    for (const q of ordered) {
      if (q.tbl === 'settings' && LOCAL_ONLY_SETTINGS.has(q.pk.key)) continue;
      const key = PK[q.tbl].map((c) => String(q.pk[c])).join('|');
      const row = current.get(q.tbl).get(key);
      changes.push(row ? { tbl: q.tbl, op: 'U', row } : { tbl: q.tbl, op: 'D', pk: q.pk });
    }
    // send in size-limited batches, in order
    let batch = []; let size = 0;
    for (const ch of changes) {
      const len = JSON.stringify(ch).length;
      if (size + len > BATCH_BYTES && batch.length) { await post(batch); batch = []; size = 0; }
      batch.push(ch); size += len;
    }
    if (batch.length) await post(batch);
    // remove exactly what was sent (a change committed meanwhile with a lower id stays queued)
    await pool.query('DELETE FROM sync_outbox WHERE id = ANY($1::bigint[])', [queue.map((q) => q.id)]);
    return queue.length;
  }

  async function workerLoop() {
    let backoff = 2000;
    for (;;) {
      let sent = 0;
      try {
        state.sending = true;
        if (!(await getState(pool, 'snapshot_done'))) await snapshot();
        sent = await drainOnce();
        state.online = true; state.lastOkAt = new Date(); state.lastError = null;
        backoff = 2000;
      } catch (e) {
        state.online = false; state.lastError = e.message; state.lastErrorAt = new Date(); state.snapshot = null;
        backoff = Math.min(15000, backoff * 1.6);
      } finally { state.sending = false; }
      await new Promise((r) => setTimeout(r, state.online ? (sent ? 200 : 3000) : backoff));
    }
  }

  // ---------- cloud copy: receive ----------
  const colCache = new Map();
  async function columns(c, tbl) {
    if (!colCache.has(tbl)) {
      const { rows } = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [tbl]);
      colCache.set(tbl, rows.map((r) => r.column_name));
    }
    return colCache.get(tbl);
  }
  let isSuper = null;
  const ingest = express.Router();
  ingest.post('/ingest', express.json({ limit: '25mb' }), wrap(async (req, res) => {
    if (MODE !== 'mirror') throw new HttpError(409, 'This server is not a cloud copy (set POS_MODE=mirror)');
    const got = String(req.headers['x-sync-token'] || '');
    if (!SYNC_TOKEN || got.length !== SYNC_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(SYNC_TOKEN))) {
      throw new HttpError(401, 'Bad sync token');
    }
    const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
    if (isSuper === null) {
      const { rows: [r] } = await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
      isSuper = !!(r && r.rolsuper);
    }
    const apply = async (c, ch) => {
      const cols = PK[ch.tbl];
      if (ch.op === 'D') {
        await c.query(`DELETE FROM ${ch.tbl} WHERE ${cols.map((k, i) => `${k}::text = $${i + 1}`).join(' AND ')}`, cols.map((k) => String(ch.pk[k])));
      } else {
        const all = await columns(c, ch.tbl);
        const set = all.filter((k) => !cols.includes(k)).map((k) => `${k}=EXCLUDED.${k}`).join(', ');
        await c.query(`INSERT INTO ${ch.tbl} SELECT * FROM jsonb_populate_record(NULL::${ch.tbl}, $1)
                       ON CONFLICT (${cols.join(',')}) DO ${set ? `UPDATE SET ${set}` : 'NOTHING'}`, [ch.row]);
      }
    };
    await tx(async (c) => {
      // With superuser rights, foreign-key checks are skipped while applying. Either way, a change that
      // fails because a related row hasn't been applied yet is retried after the others (up to 6 passes).
      if (isSuper) await c.query("SET LOCAL session_replication_role = 'replica'");
      let pending = changes.filter((ch) => PK[ch.tbl]);
      for (let pass = 0; pending.length && pass < 6; pass++) {
        const retry = []; let lastErr = null;
        for (const ch of pending) {
          await c.query('SAVEPOINT ch');
          try { await apply(c, ch); await c.query('RELEASE SAVEPOINT ch'); } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT ch');
            if (!['23503', '23505'].includes(e.code)) throw e; // only ordering problems are retried
            retry.push(ch); lastErr = e;
          }
        }
        if (retry.length === pending.length) throw lastErr; // no progress: give up, the shop retries later
        pending = retry;
      }
      if (pending.length) throw new Error('Could not apply all changes');
      await setState(c, 'last_ingest_at', new Date().toISOString());
    });
    if (changes.some((ch) => ['settings', 'app_images'].includes(ch.tbl))) notify('settings');
    if (changes.some((ch) => ['menu_items', 'categories', 'item_addons', 'menu_item_images'].includes(ch.tbl))) notify('menu');
    notify('sync');
    res.json({ ok: true, applied: changes.length });
  }));

  // ---------- status ----------
  async function status() {
    if (MODE === 'local') {
      const { rows: [q] } = await pool.query('SELECT count(*)::int AS n, min(created_at) AS oldest FROM sync_outbox');
      return { mode: MODE, cloud: CLOUD_URL || null, configured: !!(CLOUD_URL && SYNC_TOKEN), online: state.online, pending: q.n,
        oldest_pending: q.oldest, last_ok_at: state.lastOkAt, last_error: state.lastError, last_error_at: state.lastErrorAt,
        snapshot: state.snapshot, snapshot_done: await getState(pool, 'snapshot_done') };
    }
    if (MODE === 'mirror') return { mode: MODE, last_ingest_at: await getState(pool, 'last_ingest_at') };
    return { mode: MODE };
  }

  function start() {
    if (MODE === 'local' && CLOUD_URL && SYNC_TOKEN) workerLoop();
    else if (MODE === 'local') console.log('Sync: POS_MODE=local but CLOUD_URL / SYNC_TOKEN not set — running without a cloud copy.');
  }

  return { setup, repairSequences, start, status, ingest, TABLES };
};
