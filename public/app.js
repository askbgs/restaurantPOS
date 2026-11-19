/* Restaurant POS — single-page client (no build step). */
(() => {
  'use strict';

  // ---------- state ----------
  const S = {
    user: null, cfg: null, menu: null, floor: null,
    tab: 'floor', order: null,
    areaFilter: 'all', cat: null, search: '',
    kitchen: null, station: 'all',
    history: null, histFilter: 'all', histSel: null, histOrder: null,
    payMethod: 'card', modal: null, live: false,
  };
  const COURSES = ['drink', 'starter', 'main', 'dessert'];
  const COURSE_LABEL = { drink: 'Drink', starter: 'Starter', main: 'Main', dessert: 'Dessert' };
  const TYPE_LABEL = { dinein: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery', counter: 'Counter' };
  const STATUS_LABEL = { free: 'Free', ordering: 'Ordering', kitchen: 'In kitchen', ready: 'Food ready', dining: 'Dining', billed: 'Bill printed', paid: 'Paid', void: 'Void' };
  const KOT_LABEL = { held: 'On hold', new: 'Sent', cooking: 'Cooking', ready: 'Ready', served: 'Served' };
  const SPICE = [['Standard', 'As listed'], ['Mild', '●'], ['Medium', '●●'], ['Hot', '●●●'], ['Thai hot', '●●●●']];

  const $ = (sel, root = document) => root.querySelector(sel);
  const root = $('#root');
  const modalEl = $('#modal');

  // ---------- utils ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => (S.cfg?.currency ?? '') + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const clock = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: S.cfg?.timezone });
  const mins = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 60000));
  const pct = (f) => `${+(f * 100).toFixed(3)}%`;
  const orderTitle = (o) => (o.type === 'dinein' ? `Table ${o.table_code}` : `${TYPE_LABEL[o.type]} #${o.order_no}`);
  const lineTotal = (i) => i.qty * (i.unit_price_cents + i.addons_cents);

  function toast(msg, err) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') { S.user = null; renderLogin(); throw new Error('Signed out'); }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const run = (fn) => (...a) => Promise.resolve(fn(...a)).catch((e) => { if (e.message !== 'Signed out') toast(e.message, true); });

  // ---------- data loading ----------
  async function loadFloor() { S.floor = await api('/floor'); }
  async function loadOrder(id) { S.order = await api('/orders/' + (id || S.order.id)); if (S.order.payment_method) S.payMethod = S.order.payment_method; }
  async function loadKitchen() { S.kitchen = await api('/kitchen'); S.kitchen.fetchedAt = Date.now(); }
  async function loadHistory() {
    S.history = await api('/history');
    if (S.histSel) S.histOrder = await api('/orders/' + S.histSel).catch(() => null);
  }

  async function refresh() {
    const jobs = [loadFloor()];
    if (S.order && (S.tab === 'order' || S.tab === 'bill')) {
      jobs.push(loadOrder().then(() => { if (S.order.status !== 'open') { S.order = null; } }).catch(() => { S.order = null; }));
    }
    if (S.tab === 'kitchen') jobs.push(loadKitchen());
    if (S.tab === 'history') jobs.push(loadHistory());
    await Promise.all(jobs);
    render();
  }

  let refreshTimer;
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(run(refresh), 250); }

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.onopen = () => { S.live = true; updateLiveDot(); };
    es.onmessage = () => scheduleRefresh();
    es.onerror = () => { S.live = false; updateLiveDot(); };
  }
  function updateLiveDot() { const d = $('.live-dot'); if (d) d.classList.toggle('off', !S.live); }

  // ---------- login ----------
  let pin = '';
  function renderLogin(err = '') {
    modalEl.innerHTML = '';
    root.innerHTML = `
      <div class="login"><div class="login-box">
        <div class="hd"><div class="eyebrow">${esc(S.cfg?.terminal || '')}</div><h1>${esc(S.cfg?.restaurant || 'POS')}</h1>
          <div class="muted" style="margin-top:4px">Enter your staff PIN</div></div>
        <div class="pin-dots">${[0, 1, 2, 3].map((i) => `<i class="${i < pin.length ? 'f' : ''}"></i>`).join('')}${pin.length > 4 ? `<span>+${pin.length - 4}</span>` : ''}</div>
        <div class="login-err">${esc(err)}</div>
        <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-act="pin" data-k="${n}">${n}</button>`).join('')}
          <button type="button" data-act="pin" data-k="back">⌫</button><button type="button" data-act="pin" data-k="0">0</button>
          <button type="button" data-act="pin" data-k="ok" style="background:var(--red);color:#fff">→</button></div>
      </div></div>`;
  }
  async function pinKey(k) {
    if (k === 'back') pin = pin.slice(0, -1);
    else if (k === 'ok') {
      if (pin.length < 4) return renderLogin('PIN is at least 4 digits');
      try {
        S.user = await api('/login', { body: { pin } });
        pin = '';
        return boot();
      } catch (e) { pin = ''; return renderLogin(e.message); }
    } else if (pin.length < 8) pin += k;
    renderLogin();
  }

  // ---------- header ----------
  function header() {
    const f = S.floor?.stats || {};
    const o = S.order;
    const tab = (id, title, sub, disabled) => `
      <button type="button" class="tab ${S.tab === id ? 'active' : ''}" data-act="tab" data-tab="${id}" ${disabled ? 'disabled' : ''}>
        <b>${title}</b><small>${esc(sub)}</small></button>`;
    return `
      <header class="topbar">
        <div class="brand"><div class="logo">${esc((S.cfg.restaurant.match(/\b\w/g) || ['P']).slice(0, 2).join('').toUpperCase())}</div>
          <div><b>${esc(S.cfg.restaurant)}</b><small>${esc(S.cfg.terminal)}</small></div></div>
        <nav class="tabs">
          ${tab('floor', 'Floor', `${f.seated ?? 0}/${f.tables ?? 0} tables`)}
          ${tab('order', 'Order', o ? orderTitle(o) : 'New order')}
          ${tab('kitchen', 'Kitchen', `${f.live_tickets ?? 0} live tickets`)}
          ${tab('bill', 'Bill', o ? money(o.total_cents) : 'No order', !o)}
          ${tab('history', 'History', `${f.closed_today ?? 0} closed`)}
        </nav>
        <div class="top-right">
          <span class="live-dot ${S.live ? '' : 'off'}" title="Live updates"></span>
          <span class="clock" id="clock">${clock(Date.now())}</span>
          <button type="button" class="avatar" data-act="logout" title="${esc(S.user.name)} · ${esc(S.user.role)}">${esc(S.user.initials)}</button>
        </div>
      </header>`;
  }

  // ---------- floor ----------
  function floorView() {
    const F = S.floor;
    const areas = F.areas.filter((a) => S.areaFilter === 'all' || String(a.id) === S.areaFilter);
    const tableCard = (t) => {
      const o = t.order;
      return `<button type="button" class="tcard ${t.status}" data-act="table" data-id="${t.id}">
        <div class="row1"><span class="code">${esc(t.code)}</span><span class="seats">${t.seats} seats</span></div>
        <span class="st">${STATUS_LABEL[t.status]}</span>
        ${o ? `<div class="meta"><span>${o.guests} guest${o.guests > 1 ? 's' : ''}</span><span>${mins(o.opened_at)} min</span></div>
               <div class="amt">${money(o.total_cents)}</div>` : ''}
      </button>`;
    };
    return `
      <section class="floor">
        <div class="floor-main scroll">
          <div class="page-head">
            <div><div class="eyebrow">Dine-in</div><h1 class="title">Floor</h1>
              <div class="muted">${F.stats.seated} of ${F.stats.tables} tables seated · ${F.stats.covers} covers · ${F.stats.live_tickets} tickets in the kitchen</div></div>
            <div class="seg">
              <button type="button" class="${S.areaFilter === 'all' ? 'on' : ''}" data-act="area" data-id="all">All</button>
              ${F.areas.map((a) => `<button type="button" class="${S.areaFilter === String(a.id) ? 'on' : ''}" data-act="area" data-id="${a.id}">${esc(a.short)}</button>`).join('')}
            </div>
          </div>
          <div class="legend">
            ${['free', 'ordering', 'kitchen', 'ready', 'dining', 'billed'].map((s) => `<span><i class="sw ${s}"></i>${STATUS_LABEL[s]}</span>`).join('')}
          </div>
          ${areas.map((a) => `
            <div class="area"><h3>${esc(a.name)}<small>${a.tables.filter((t) => t.order).length} of ${a.tables.length} occupied</small></h3>
              <div class="grid4">${a.tables.map(tableCard).join('')}</div></div>`).join('')}
          <div style="height:28px"></div>
        </div>
        ${queuePanel()}
      </section>`;
  }

  function queuePanel() {
    const q = S.floor.queue;
    return `
      <aside class="queue">
        <div class="queue-head"><div class="eyebrow">Off-floor</div><h2>Order queue</h2></div>
        <div class="qnew">
          ${['takeaway', 'delivery', 'counter'].map((t) => `<button type="button" data-act="new-order" data-type="${t}"><small>+ New</small><b>${TYPE_LABEL[t]}</b></button>`).join('')}
        </div>
        <div class="scroll" style="flex:1">
          ${q.length ? q.map((o) => `
            <button type="button" class="qitem" data-act="open-order" data-id="${o.id}">
              <div><div><span class="tag">${TYPE_LABEL[o.type]}</span><b>#${o.order_no}</b></div>
                <div style="margin-top:4px">${esc(o.customer_name || 'Walk-in')}</div>
                <div class="s ${o.status}">${STATUS_LABEL[o.status]}</div></div>
              <div style="text-align:right"><b>${money(o.total_cents)}</b><div class="muted" style="margin-top:4px">${mins(o.opened_at)} min</div></div>
            </button>`).join('') : '<div class="empty">No takeaway, delivery or counter orders open.</div>'}
        </div>
      </aside>`;
  }

  // ---------- order ----------
  function startView() {
    const cards = [
      ['dinein', 'Pick a table on the floor plan.'],
      ['takeaway', 'Customer collects. Name and phone on the ticket.'],
      ['delivery', 'Address prints on the expo ticket.'],
      ['counter', 'Quick sale. Sends the KOT and goes straight to payment.'],
    ];
    return `<section class="start scroll"><div class="eyebrow">New order</div><h1 class="title">Start an order</h1>
      <div class="start-grid">${cards.map(([t, d]) => `<button type="button" data-act="new-order" data-type="${t}"><b>${TYPE_LABEL[t]}</b><span>${d}</span></button>`).join('')}</div></section>`;
  }

  function dishAreaHtml() {
    const cats = S.menu.categories;
    let title, items, sub;
    const q = S.search.trim().toLowerCase();
    if (q) {
      items = cats.flatMap((c) => c.items).filter((i) => i.name.toLowerCase().includes(q));
      title = `Results for “${esc(S.search.trim())}”`; sub = `${items.length} dishes`;
    } else {
      const c = cats.find((x) => x.id === S.cat) || cats[0];
      items = c.items; title = esc(c.name);
      sub = `${items.length} dishes · fires as ${COURSE_LABEL[c.default_course].toLowerCase()}`;
    }
    return `<h3>${title}<small>${sub}</small></h3>
      <div class="dgrid">${items.map((i) => `
        <div class="dish">
          <button type="button" class="add" data-act="quick-add" data-id="${i.id}">
            <span class="n">${esc(i.name)}</span><span class="tags">${i.tags.map(esc).join(' · ')}</span><span class="p">${money(i.price_cents)}</span>
          </button>
          <button type="button" class="opt" data-act="options" data-id="${i.id}">Options</button>
        </div>`).join('') || '<div class="empty">No dishes found.</div>'}</div>`;
  }

  function orderView() {
    if (!S.order) return startView();
    const o = S.order;
    const cats = S.menu.categories;
    if (!S.cat) S.cat = cats[0]?.id;
    const pending = o.items.filter((i) => !i.kot_id);
    const byCourse = COURSES.map((c) => [c, o.items.filter((i) => i.course === c)]).filter(([, l]) => l.length);
    const ticketTotal = o.subtotal_cents - o.discount_cents + o.tax_cents;
    return `
      <section class="order">
        <aside class="cats scroll"><div class="label">MENU</div>
          ${cats.map((c) => `<button type="button" class="cat ${c.id === S.cat && !S.search ? 'on' : ''}" data-act="cat" data-id="${c.id}">${esc(c.name)}<small>${c.items.length}</small></button>`).join('')}
        </aside>
        <div class="dishes">
          <div class="searchbar"><input id="search" type="search" placeholder="Search dishes..." value="${esc(S.search)}" autocomplete="off"><span class="muted">Tap to add · Options for extras</span></div>
          <div class="dish-area scroll" id="dish-area" style="flex:1">${dishAreaHtml()}</div>
        </div>
        <aside class="ticket">
          <div class="ticket-head">
            <div><div class="eyebrow">${TYPE_LABEL[o.type]}</div><h2>${esc(orderTitle(o))}</h2>
              <div class="muted" style="font-size:14px">Opened ${clock(o.opened_at)} · ${mins(o.opened_at)} min · ${esc(o.staff_name || '')}</div>
              ${o.type !== 'dinein' && o.customer_name ? `<div style="font-size:14px;margin-top:4px">${esc(o.customer_name)}${o.phone ? ' · ' + esc(o.phone) : ''}</div>` : ''}
              ${o.address ? `<div class="muted" style="font-size:13px">${esc(o.address)}</div>` : ''}
              ${!o.kots.length ? `<button type="button" class="link-red" style="margin-top:8px" data-act="void">Cancel order</button>` : ''}
            </div>
            ${o.type === 'dinein' ? `<div><div class="muted" style="font-size:12px;margin-bottom:4px">Guests</div>
              <div class="stepper"><button type="button" data-act="guests" data-d="-1">−</button><span>${o.guests}</span><button type="button" data-act="guests" data-d="1">+</button></div></div>` : ''}
          </div>
          <div class="ticket-lines">
            ${byCourse.length ? byCourse.map(([c, lines]) => `
              <div class="course-h">${COURSE_LABEL[c]}<small>${((n) => `${n} item${n === 1 ? '' : 's'}`)(lines.reduce((s, i) => s + i.qty, 0))}</small></div>
              ${lines.map(lineHtml).join('')}`).join('') : '<div class="empty">Tap a dish to start the ticket.</div>'}
          </div>
          <div class="totals">
            <div class="r"><span>Subtotal</span><span>${money(o.subtotal_cents)}</span></div>
            ${o.discount_cents ? `<div class="r muted"><span>Discount ${o.discount_pct}%</span><span>−${money(o.discount_cents)}</span></div>` : ''}
            <div class="r muted"><span>${esc(S.cfg.taxLabel)} ${pct(S.cfg.taxRate)}</span><span>${money(o.tax_cents)}</span></div>
            <div class="r grand"><span>Total</span><b>${money(ticketTotal)}</b></div>
          </div>
          <div class="ticket-actions">
            <button type="button" class="btn" data-act="tab" data-tab="bill" ${o.items.length ? '' : 'disabled'}>Bill</button>
            <button type="button" class="btn red" data-act="review-kot" ${pending.length ? '' : 'disabled'}>
              <span>Review KOT</span><small>${pending.length ? `${pending.reduce((s, i) => s + i.qty, 0)} new item${pending.length > 1 || pending[0].qty > 1 ? 's' : ''}` : 'All sent'}</small></button>
          </div>
        </aside>
      </section>`;
  }

  function modsHtml(i) {
    const parts = [];
    if (i.spice) parts.push(esc(i.spice));
    for (const a of i.addons || []) parts.push('+ ' + esc(a.name));
    let h = parts.join(' · ');
    if (i.note) h += `${h ? ' · ' : ''}<span class="note">! ${esc(i.note)}</span>`;
    return h;
  }

  function lineHtml(i) {
    return `<div class="line">
      <div class="r"><span>${i.qty} × ${esc(i.name)}</span><span>${money(lineTotal(i))}</span></div>
      ${modsHtml(i) ? `<div class="mods">${modsHtml(i)}</div>` : ''}
      ${i.kot_id ? `<span class="badge">KOT #${i.kot_no} · ${KOT_LABEL[i.kot_status]}</span>`
        : `<div class="ctl"><button type="button" data-act="qty" data-id="${i.id}" data-q="${i.qty - 1}">−</button><button type="button" data-act="qty" data-id="${i.id}" data-q="${i.qty + 1}">+</button>
           <span class="badge new" style="margin-top:0">New · not sent</span></div>`}
    </div>`;
  }

  // ---------- kitchen ----------
  function kitchenView() {
    if (!S.kitchen) return '<section class="kds"><div class="empty">Loading…</div></section>';
    const { kots, stations } = S.kitchen;
    const live = kots.filter((k) => S.station === 'all' || k.station_id === null || String(k.station_id) === S.station);
    const count = (sid) => kots.filter((k) => k.station_id === sid).length;
    const drift = Math.floor((Date.now() - S.kitchen.fetchedAt) / 1000);
    const cols = [['new', 'New'], ['cooking', 'Cooking'], ['ready', 'Ready'], ['held', 'On hold']];
    const action = { new: 'Start cooking', cooking: 'Mark ready', ready: 'Picked up · clear', held: 'Fire now' };
    const card = (k) => {
      const title = k.type === 'dinein' ? `Table ${k.table_code}` : `${TYPE_LABEL[k.type]} #${k.order_no}`;
      const age = Math.floor((k.age_sec + drift) / 60);
      const late = k.status === 'cooking' && age >= S.cfg.lateMinutes;
      const cls = late ? 'late' : k.status === 'ready' ? 'ready' : k.status === 'held' ? 'held' : '';
      return `<div class="kcard ${cls}">
        <div class="kh"><div><b>${esc(title)}</b><small>KOT #${k.kot_no} · ${esc(k.station_name || 'All')} · ${k.type === 'dinein' ? `${k.guests} pax` : TYPE_LABEL[k.type]}${k.is_addon ? ' · Add-on' : ''}</small></div>
          <div class="age">${age}m${late ? '<small style="display:block">LATE</small>' : k.status === 'held' ? '<small style="display:block">HOLD</small>' : ''}</div></div>
        ${k.items.map((i) => `<button type="button" class="ki ${i.done ? 'done' : ''}" data-act="tick" data-id="${i.id}"><span>${i.qty}</span>
          <span><span class="nm">${esc(i.name)}</span>${modsHtml(i) ? `<small>${modsHtml(i)}</small>` : ''}</span></button>`).join('')}
        <button type="button" class="act ${k.status}" data-act="advance" data-id="${k.id}">${action[k.status]}</button>
      </div>`;
    };
    return `
      <section class="kds">
        <div class="kds-head">
          <div class="kds-title"><div class="eyebrow">Kitchen display</div><h2>${S.station === 'all' ? 'All stations' : esc(stations.find((s) => String(s.id) === S.station)?.name || '')}</h2></div>
          <div class="stabs">
            <button type="button" class="stab ${S.station === 'all' ? 'on' : ''}" data-act="station" data-id="all"><b>All</b><small>${kots.length} live</small></button>
            ${stations.map((s) => `<button type="button" class="stab ${S.station === String(s.id) ? 'on' : ''}" data-act="station" data-id="${s.id}"><b>${esc(s.name)}</b><small>${count(s.id)} live</small></button>`).join('')}
          </div>
          <div class="kds-hint">Tap an item to tick it off. Tap the bar to move the ticket on.</div>
        </div>
        <div class="kcols">
          ${cols.map(([st, label]) => {
            const list = live.filter((k) => k.status === st);
            return `<div class="kcol ${st === 'held' ? 'hold' : ''}"><div class="kcol-h">${label.toUpperCase()}<small>${list.length}</small></div>
              <div class="kcol-b">${list.map(card).join('') || '<div class="empty" style="padding:8px">—</div>'}</div></div>`;
          }).join('')}
        </div>
      </section>`;
  }

  // ---------- bill ----------
  function billView() {
    const o = S.order;
    if (!o) return startView();
    const pending = o.items.filter((i) => !i.kot_id);
    const segBtn = (act, val, cur, label, extra = '') => `<button type="button" class="${String(val) === String(cur) ? 'on' : ''}" data-act="${act}" data-v="${val}" ${extra}>${label}</button>`;
    const per = o.split_ways > 1 ? Math.ceil(o.total_cents / o.split_ways) : 0;
    return `
      <section class="bill">
        <div class="bill-left scroll"><div class="inner">
          <div class="eyebrow">Bill · ${TYPE_LABEL[o.type]}</div>
          <h1 class="title" style="font-size:44px">${esc(orderTitle(o))}</h1>
          <div class="muted">Opened ${clock(o.opened_at)} · ${mins(o.opened_at)} min · ${esc(o.staff_name || '')}${o.bill_printed_at ? ` · Bill printed ${clock(o.bill_printed_at)}` : ''}</div>
          ${pending.length ? `<div class="warn"><span>${pending.length} item${pending.length > 1 ? 's have' : ' has'} not been sent to the kitchen.</span>
            <button type="button" data-act="tab" data-tab="order">Back to order</button></div>` : '<div style="height:22px"></div>'}
          <div class="blines">${o.items.map((i) => `<div class="bline"><span>${i.qty}</span><span>${esc(i.name)}${modsHtml(i) ? `<small>${modsHtml(i)}</small>` : ''}</span><span>${money(lineTotal(i))}</span></div>`).join('') || '<div class="empty">No items yet.</div>'}</div>
          <div class="bsum" style="margin-top:14px">
            <div class="r"><span>Subtotal</span><span>${money(o.subtotal_cents)}</span></div>
            ${o.discount_cents ? `<div class="r"><span>Discount ${o.discount_pct}%</span><span>−${money(o.discount_cents)}</span></div>` : ''}
            ${o.service_on ? `<div class="r"><span>Service charge ${pct(S.cfg.serviceRate)}</span><span>${money(o.service_cents)}</span></div>` : ''}
            <div class="r"><span>${esc(S.cfg.taxLabel)} ${pct(S.cfg.taxRate)}</span><span>${money(o.tax_cents)}</span></div>
            ${o.tip_cents ? `<div class="r"><span>Tip ${o.tip_pct}%</span><span>${money(o.tip_cents)}</span></div>` : ''}
            <div class="r total"><span>Total</span><b>${money(o.total_cents)}</b></div>
            ${per ? `<div class="r" style="margin-top:8px"><span>Per person · ${o.split_ways} ways</span><b>${money(per)}</b></div>` : ''}
          </div>
        </div></div>
        <aside class="bill-right">
          <div class="bill-opts">
            <div class="msec"><div class="hd"><b>Discount</b>${o.discount_cents ? `<small>−${money(o.discount_cents)}</small>` : ''}</div>
              <div class="seg full">${segBtn('bill-set', 0, o.discount_pct, 'None', 'data-k="discount_pct"')}${segBtn('bill-set', 10, o.discount_pct, '10%', 'data-k="discount_pct"')}${segBtn('bill-set', 20, o.discount_pct, 'Staff 20%', 'data-k="discount_pct"')}</div></div>
            <div class="msec"><div class="hd"><b>Service charge</b><small>${money(o.service_cents)}</small></div>
              <div class="seg full">${segBtn('bill-set', 'false', String(o.service_on), 'Off', 'data-k="service_on"')}${segBtn('bill-set', 'true', String(o.service_on), pct(S.cfg.serviceRate), 'data-k="service_on"')}</div></div>
            <div class="msec"><div class="hd"><b>Tip</b>${o.tip_cents ? `<small>${money(o.tip_cents)}</small>` : ''}</div>
              <div class="seg full">${[0, 10, 15, 18].map((t) => segBtn('bill-set', t, o.tip_pct, t ? t + '%' : 'None', 'data-k="tip_pct"')).join('')}</div></div>
            <div class="msec"><div class="hd"><b>Split</b>${per ? `<small>${money(per)} each</small>` : ''}</div>
              <div class="seg full">${[1, 2, 3, 4].map((t) => segBtn('bill-set', t, o.split_ways, t === 1 ? 'One bill' : `${t} ways`, 'data-k="split_ways"')).join('')}</div></div>
            <div class="msec" style="border-bottom:0"><div class="hd"><b>Payment method</b></div>
              <div class="seg full">${['card', 'cash', 'wallet'].map((m) => segBtn('pay-method', m, S.payMethod, m[0].toUpperCase() + m.slice(1))).join('')}</div>
              ${S.payMethod === 'cash' ? `<label style="display:block;margin-top:14px;font-size:14px;font-weight:600">Cash received</label>
                <input id="cash-in" inputmode="decimal" style="width:100%;margin-top:6px;padding:10px;border:2px solid #9a9a9a;font-size:18px" placeholder="0.00">
                <div id="change" class="muted" style="margin-top:6px"></div>` : ''}
            </div>
          </div>
          <div class="due">
            <div class="r"><span>Amount due</span><b>${money(o.total_cents)}</b></div>
            <div class="acts">
              <button type="button" class="btn" data-act="print-bill" ${o.items.length ? '' : 'disabled'}>Print bill</button>
              <button type="button" class="btn red" data-act="charge" ${o.items.length ? '' : 'disabled'}>Charge ${money(o.total_cents)}</button>
            </div>
          </div>
        </aside>
      </section>`;
  }

  // ---------- history ----------
  function historyView() {
    if (!S.history) return '<section class="hist"><div class="empty">Loading…</div></section>';
    const H = S.history;
    const list = H.orders.filter((o) => S.histFilter === 'all' || o.type === S.histFilter);
    const d = S.histOrder;
    return `
      <section class="hist">
        <div class="scroll">
          <div class="page-head" style="border-bottom:0">
            <div><div class="eyebrow">Today</div><h1 class="title">Orders</h1>
              <div class="muted">${H.stats.paid} paid · ${money(H.stats.collected_cents)} collected · ${H.stats.open} open</div></div>
            <div class="seg">${['all', 'dinein', 'takeaway', 'delivery', 'counter'].map((t) => `<button type="button" class="${S.histFilter === t ? 'on' : ''}" data-act="hist-filter" data-v="${t}">${t === 'all' ? 'All' : TYPE_LABEL[t]}</button>`).join('')}</div>
          </div>
          <div class="htable-wrap">
            <table class="htable"><thead><tr><th>Order</th><th>Type</th><th>Table / Guest</th><th>Items · KOT</th><th>Opened</th><th>Status</th><th>Total</th></tr></thead>
            <tbody>${list.map((o) => `<tr class="${S.histSel === o.id ? 'sel' : ''}" data-act="hist-sel" data-id="${o.id}">
              <td><b>#${o.order_no}</b></td><td>${TYPE_LABEL[o.type]}</td>
              <td class="name">${o.type === 'dinein' ? `Table ${esc(o.table_code)} · ${o.guests} pax` : esc(o.customer_name || 'Walk-in')}</td>
              <td>${o.item_qty} · ${o.kot_count}</td><td>${clock(o.opened_at)}</td>
              <td><span class="s ${o.display_status}">${STATUS_LABEL[o.display_status]}</span></td><td><b>${money(o.total_cents)}</b></td></tr>`).join('')
              || '<tr><td colspan="7" class="muted">No orders yet today.</td></tr>'}</tbody></table>
          </div>
        </div>
        <aside class="hdetail scroll">
          ${d ? `<div class="hd"><div class="eyebrow">${TYPE_LABEL[d.type]} · #${d.order_no}</div><h2>${esc(d.type === 'dinein' ? `Table ${d.table_code}` : d.customer_name || orderTitle(d))}</h2>
              <div class="muted">${d.type === 'dinein' ? `${d.guests} guests · ` : ''}Opened ${clock(d.opened_at)}${d.closed_at ? ` · Closed ${clock(d.closed_at)}` : ''}</div>
              ${d.status === 'open' ? `<button type="button" class="btn dark" style="margin-top:12px" data-act="open-order" data-id="${d.id}">Open order</button>` : ''}
              ${d.status === 'paid' ? `<div style="margin-top:8px"><b>${money(d.total_cents)}</b> · ${esc((d.payment_method || '').toUpperCase())}</div>` : ''}</div>
            <div class="sec"><div class="lbl">ITEMS</div>${d.items.map((i) => `<div class="r"><span>${i.qty}</span><span>${esc(i.name)}</span><span>${money(lineTotal(i))}</span></div>`).join('') || '<div class="muted">None</div>'}</div>
            <div class="sec"><div class="lbl">KITCHEN TICKETS</div>${d.kots.map((k) => `<div class="k"><b>#${k.kot_no}</b><span>${esc(k.station_name || 'All')}</span><span class="muted">${KOT_LABEL[k.status]}${k.served_at ? ' · ' + clock(k.served_at) : ''}</span></div>`).join('') || '<div class="muted">None</div>'}</div>`
            : '<div class="empty" style="padding:28px 20px">Select an order to see its items and kitchen tickets.</div>'}
        </aside>
      </section>`;
  }

  // ---------- modals ----------
  function renderModal() {
    const m = S.modal;
    if (!m) { modalEl.innerHTML = ''; return; }
    let html = '';
    if (m.kind === 'options') {
      const i = m.item;
      const price = (i.price_cents + i.addons.filter((a) => m.addons.has(a.id)).reduce((s, a) => s + a.price_cents, 0)) * m.qty;
      html = `<div class="modal">
        <div class="modal-head"><div><div class="eyebrow">${esc(m.catName)} · ${esc(i.station_name)} station · ${money(i.price_cents)}</div><h2>${esc(i.name)}</h2></div></div>
        <div class="modal-body">
          ${i.has_spice ? `<div class="msec"><div class="hd"><b>Spice level</b><small>Prints on the ticket</small></div>
            <div class="chips">${SPICE.map(([n, d]) => `<button type="button" class="chip ${m.spice === n ? 'on' : ''}" data-act="opt-spice" data-v="${n}">${n}<small>${d}</small></button>`).join('')}</div></div>` : ''}
          ${i.addons.length ? `<div class="msec"><div class="hd"><b>Add-ons</b><small>Tap to toggle</small></div>
            <div class="chips">${i.addons.map((a) => `<button type="button" class="chip ${m.addons.has(a.id) ? 'on' : ''}" data-act="opt-addon" data-id="${a.id}">${esc(a.name)}<small>+${money(a.price_cents)}</small></button>`).join('')}</div></div>` : ''}
          <div class="msec"><div class="hd"><b>Course</b><small>Mains and desserts can be held until fired</small></div>
            <div class="chips">${COURSES.map((c) => `<button type="button" class="chip ${m.course === c ? 'on' : ''}" data-act="opt-course" data-v="${c}">${COURSE_LABEL[c]}${c === m.defCourse ? '<small>Default</small>' : ''}</button>`).join('')}</div></div>
          <div class="msec" style="border-bottom:0"><div class="hd"><b>Kitchen note</b><small>Allergies, no onion, etc.</small></div>
            <textarea id="opt-note" rows="2" maxlength="200" placeholder="e.g. No peanuts">${esc(m.note)}</textarea></div>
        </div>
        <div class="modal-foot">
          <div class="stepper"><button type="button" data-act="opt-qty" data-d="-1">−</button><span>${m.qty}</span><button type="button" data-act="opt-qty" data-d="1">+</button></div>
          <div class="grow"></div>
          <button type="button" class="btn" data-act="close-modal">Cancel</button>
          <button type="button" class="btn red" data-act="opt-add"><span>Add to order</span><span>${money(price)}</span></button>
        </div></div>`;
    } else if (m.kind === 'kot') {
      const tickets = kotGroups(m.mode, m.hold);
      const o = S.order;
      html = `<div class="modal wide">
        <div class="modal-head"><div><div class="eyebrow">Review before sending</div><h2>${tickets.length} ticket${tickets.length > 1 ? 's' : ''} for ${esc(orderTitle(o))}</h2></div>
          <div class="seg"><button type="button" class="${m.mode === 'station' ? 'on' : ''}" data-act="kot-mode" data-v="station">Per station</button><button type="button" class="${m.mode === 'single' ? 'on' : ''}" data-act="kot-mode" data-v="single">Single ticket</button></div></div>
        <div class="modal-body kot-preview">${tickets.map((t) => `
          <div class="kot"><div class="kh"><div class="a"><span>KOT · NEW</span><span>${esc((t.station?.name || 'ALL').toUpperCase())}</span></div>
            <h4>${esc(orderTitle(o))}</h4><div class="muted" style="font-size:13px">${clock(Date.now())} · ${esc(S.user.name)}${o.type === 'dinein' ? ` · ${o.guests} guests` : ''}</div>
            ${o.kots.length ? '<span class="flag">ADD-ON</span>' : ''}${t.held ? '<span class="flag hold">HOLD</span>' : ''}</div>
            ${t.items.map((i) => `<div class="ki"><span>${i.qty}</span><span>${esc(i.name)}${modsHtml(i) ? `<small>${modsHtml(i)}</small>` : ''}</span></div>`).join('')}
            <div class="kf">→ ${esc(t.station?.printer || 'Expo printer')}</div></div>`).join('')}
        </div>
        <div class="modal-foot">
          <button type="button" class="chip ${m.hold ? 'on' : ''}" data-act="kot-hold">Hold mains & desserts</button>
          <span class="muted grow">${m.hold ? 'Mains and desserts wait on hold until the kitchen fires them.' : 'All tickets fire immediately.'}</span>
          <button type="button" class="btn" data-act="close-modal">Keep editing</button>
          <button type="button" class="btn red" data-act="kot-send"><span>Send ${tickets.length} ticket${tickets.length > 1 ? 's' : ''}</span></button>
        </div></div>`;
    } else if (m.kind === 'customer') {
      html = `<div class="modal"><div class="modal-head"><div><div class="eyebrow">New order</div><h2>${TYPE_LABEL[m.type]}</h2></div></div>
        <div class="modal-body"><div class="msec" style="border-bottom:0">
          <label>Customer name</label><input id="c-name" maxlength="80" autocomplete="off">
          <label>Phone</label><input id="c-phone" maxlength="20" inputmode="tel" placeholder="+94 ">
          ${m.type === 'delivery' ? '<label>Delivery address</label><textarea id="c-addr" rows="3" maxlength="300"></textarea>' : ''}
        </div></div>
        <div class="modal-foot"><div class="grow"></div><button type="button" class="btn" data-act="close-modal">Cancel</button>
          <button type="button" class="btn red" data-act="customer-go"><span>Start order</span></button></div></div>`;
    } else if (m.kind === 'confirm') {
      html = `<div class="modal" style="width:min(460px,100%)"><div class="modal-head"><div><div class="eyebrow">Confirm</div><h2 style="font-size:24px">${esc(m.title)}</h2></div></div>
        <div class="modal-body"><div class="msec" style="border-bottom:0">${esc(m.text)}</div></div>
        <div class="modal-foot"><div class="grow"></div><button type="button" class="btn" data-act="close-modal">Back</button>
          <button type="button" class="btn red" data-act="confirm-yes"><span>${esc(m.yes)}</span></button></div></div>`;
    }
    modalEl.innerHTML = `<div class="overlay" data-act="overlay">${html}</div>`;
    if (m.kind === 'customer') setTimeout(() => $('#c-name')?.focus(), 30);
  }

  function kotGroups(mode, hold) {
    const pending = S.order.items.filter((i) => !i.kot_id);
    const groups = new Map();
    for (const it of pending) {
      const held = hold && (it.course === 'main' || it.course === 'dessert');
      const key = `${mode === 'single' ? 'all' : it.station_id}|${held}`;
      if (!groups.has(key)) groups.set(key, { station: mode === 'single' ? null : S.menu.stations.find((s) => s.id === it.station_id), held, items: [] });
      groups.get(key).items.push(it);
    }
    return [...groups.values()];
  }

  // ---------- print ----------
  function printBill(o) {
    const P = $('#print');
    const r = (a, b) => `<div class="r"><span>${a}</span><span>${b}</span></div>`;
    P.innerHTML = `<h3>${esc(S.cfg.restaurant)}</h3><div class="c">${esc(S.cfg.terminal)}</div><hr>
      <div>${esc(orderTitle(o))} · Order #${o.order_no}</div><div>${new Date().toLocaleString('en-GB', { timeZone: S.cfg.timezone })}</div>
      <div>Server: ${esc(o.staff_name || '')}${o.type === 'dinein' ? ` · Guests: ${o.guests}` : ''}</div><hr>
      ${o.items.map((i) => r(`${i.qty} x ${esc(i.name)}`, money(lineTotal(i)))).join('')}<hr>
      ${r('Subtotal', money(o.subtotal_cents))}
      ${o.discount_cents ? r(`Discount ${o.discount_pct}%`, '-' + money(o.discount_cents)) : ''}
      ${o.service_on ? r(`Service ${pct(S.cfg.serviceRate)}`, money(o.service_cents)) : ''}
      ${r(`${esc(S.cfg.taxLabel)} ${pct(S.cfg.taxRate)}`, money(o.tax_cents))}
      ${o.tip_cents ? r(`Tip ${o.tip_pct}%`, money(o.tip_cents)) : ''}<hr>
      <b>${r('TOTAL', money(o.total_cents))}</b>
      ${o.split_ways > 1 ? r(`Per person (${o.split_ways})`, money(Math.ceil(o.total_cents / o.split_ways))) : ''}
      <hr><div class="c">Thank you!</div>`;
    window.print();
  }

  // ---------- render ----------
  function render() {
    if (!S.user) return renderLogin();
    let view = '';
    if (S.tab === 'floor') view = floorView();
    else if (S.tab === 'order') view = orderView();
    else if (S.tab === 'kitchen') view = kitchenView();
    else if (S.tab === 'bill') view = billView();
    else if (S.tab === 'history') view = historyView();
    // preserve focus/caret in search box across re-renders
    const active = document.activeElement?.id;
    const caret = active === 'search' ? document.activeElement.selectionStart : null;
    const scrolls = [...root.querySelectorAll('.scroll, .ticket-lines, .kcol-b')].map((e) => e.scrollTop);
    root.innerHTML = `<div class="app">${header()}<main>${view}</main></div>`;
    [...root.querySelectorAll('.scroll, .ticket-lines, .kcol-b')].forEach((e, i) => { if (scrolls[i]) e.scrollTop = scrolls[i]; });
    if (active === 'search') { const s = $('#search'); s.focus(); if (caret !== null) s.setSelectionRange(caret, caret); }
    renderModal();
  }

  // ---------- actions ----------
  async function openOrder(id, tab = 'order') {
    await loadOrder(id);
    S.tab = tab; S.search = '';
    render();
  }

  async function createOrder(body) {
    const o = await api('/orders', { body });
    S.order = o; S.tab = 'order'; S.search = ''; S.modal = null;
    S.payMethod = 'card';
    await loadFloor();
    render();
  }

  async function setTab(tab) {
    S.tab = tab;
    if (tab === 'kitchen') await loadKitchen();
    if (tab === 'history') await loadHistory();
    if ((tab === 'order' || tab === 'bill') && S.order) await loadOrder();
    render();
  }

  const ACT = {
    pin: (d) => pinKey(d.k),
    tab: (d) => setTab(d.tab),
    logout: () => { S.modal = { kind: 'confirm', title: `Sign out ${S.user.name}?`, text: 'The next person can sign in with their own PIN.', yes: 'Sign out',
      run: async () => { await api('/logout', { body: {} }); S.user = null; S.order = null; S.modal = null; renderLogin(); } }; renderModal(); },
    area: (d) => { S.areaFilter = d.id; render(); },
    table: async (d) => {
      const t = S.floor.areas.flatMap((a) => a.tables).find((x) => String(x.id) === d.id);
      if (t.order) return openOrder(t.order.id);
      return createOrder({ type: 'dinein', table_id: t.id, guests: Math.min(2, t.seats) });
    },
    'new-order': (d) => {
      if (d.type === 'dinein') { S.tab = 'floor'; return render(); }
      if (d.type === 'counter') return createOrder({ type: 'counter' });
      S.modal = { kind: 'customer', type: d.type }; renderModal();
    },
    'customer-go': () => createOrder({ type: S.modal.type, customer_name: $('#c-name').value.trim(), phone: $('#c-phone').value.trim(), address: $('#c-addr')?.value.trim() }),
    'open-order': (d) => openOrder(d.id),
    cat: (d) => { S.cat = +d.id; S.search = ''; render(); },
    'quick-add': async (d) => {
      const item = S.menu.categories.flatMap((c) => c.items).find((i) => String(i.id) === d.id);
      S.order = await api(`/orders/${S.order.id}/items`, { body: { menu_item_id: item.id, qty: 1 } });
      render();
    },
    options: (d) => {
      const cat = S.menu.categories.find((c) => c.items.some((i) => String(i.id) === d.id));
      const item = cat.items.find((i) => String(i.id) === d.id);
      S.modal = { kind: 'options', item, catName: cat.name, defCourse: cat.default_course, course: cat.default_course, spice: 'Standard', addons: new Set(), note: '', qty: 1 };
      renderModal();
    },
    'opt-spice': (d) => { S.modal.spice = d.v; keepNote(); renderModal(); },
    'opt-addon': (d) => { const id = +d.id; S.modal.addons.has(id) ? S.modal.addons.delete(id) : S.modal.addons.add(id); keepNote(); renderModal(); },
    'opt-course': (d) => { S.modal.course = d.v; keepNote(); renderModal(); },
    'opt-qty': (d) => { S.modal.qty = Math.max(1, S.modal.qty + +d.d); keepNote(); renderModal(); },
    'opt-add': async () => {
      keepNote();
      const m = S.modal;
      S.order = await api(`/orders/${S.order.id}/items`, { body: { menu_item_id: m.item.id, qty: m.qty, spice: m.spice, addon_ids: [...m.addons], course: m.course, note: m.note.trim() } });
      S.modal = null; render();
    },
    qty: async (d) => { S.order = await api('/items/' + d.id, { method: 'PATCH', body: { qty: +d.q } }); render(); },
    guests: async (d) => { S.order = await api('/orders/' + S.order.id, { method: 'PATCH', body: { guests: Math.max(1, S.order.guests + +d.d) } }); render(); },
    void: () => { S.modal = { kind: 'confirm', title: `Cancel ${orderTitle(S.order)}?`, text: 'Nothing has been sent to the kitchen. The order will be voided.', yes: 'Cancel order',
      run: async () => { await api(`/orders/${S.order.id}/void`, { body: {} }); S.order = null; S.modal = null; S.tab = 'floor'; await loadFloor(); render(); } }; renderModal(); },
    'review-kot': () => { S.modal = { kind: 'kot', mode: 'station', hold: false }; renderModal(); },
    'kot-mode': (d) => { S.modal.mode = d.v; renderModal(); },
    'kot-hold': () => { S.modal.hold = !S.modal.hold; renderModal(); },
    'kot-send': async () => {
      const r = await api(`/orders/${S.order.id}/kots`, { body: { mode: S.modal.mode, hold_later: S.modal.hold } });
      S.order = r.order; S.modal = null;
      toast(`Sent ${r.kots.length} ticket${r.kots.length > 1 ? 's' : ''} to the kitchen`);
      if (S.order.type === 'counter') S.tab = 'bill';
      await loadFloor(); render();
    },
    station: (d) => { S.station = d.id; render(); },
    advance: async (d) => { await api(`/kots/${d.id}/advance`, { body: {} }); await loadKitchen(); await loadFloor(); render(); },
    tick: async (d) => { await api(`/items/${d.id}/toggle-done`, { body: {} }); await loadKitchen(); render(); },
    'bill-set': async (d) => {
      const v = d.k === 'service_on' ? d.v === 'true' : +d.v;
      S.order = await api('/orders/' + S.order.id, { method: 'PATCH', body: { [d.k]: v } }); render();
    },
    'pay-method': (d) => { S.payMethod = d.v; render(); },
    'print-bill': async () => { S.order = await api(`/orders/${S.order.id}/print-bill`, { body: {} }); render(); printBill(S.order); },
    charge: () => {
      const o = S.order;
      const pending = o.items.filter((i) => !i.kot_id).length;
      const doIt = async () => {
        const paid = await api(`/orders/${o.id}/pay`, { body: { payment_method: S.payMethod } });
        toast(`Paid ${money(paid.total_cents)} · ${orderTitle(paid)}`);
        S.order = null; S.modal = null; S.tab = 'floor'; await loadFloor(); render();
      };
      S.modal = { kind: 'confirm', title: `Charge ${money(o.total_cents)} by ${S.payMethod}?`,
        text: pending ? `${pending} unsent item${pending > 1 ? 's' : ''} will be removed before charging.` : `This closes ${orderTitle(o)}${o.type === 'dinein' ? ' and frees the table' : ''}.`,
        yes: 'Charge', run: doIt };
      renderModal();
    },
    'hist-filter': (d) => { S.histFilter = d.v; render(); },
    'hist-sel': async (d) => { S.histSel = +d.id; S.histOrder = await api('/orders/' + d.id); render(); },
    'confirm-yes': () => S.modal.run(),
    'close-modal': () => { S.modal = null; renderModal(); },
    overlay: () => {},
  };
  function keepNote() { const n = $('#opt-note'); if (n && S.modal) S.modal.note = n.value; }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    if (el.dataset.act === 'overlay') { if (e.target === el) { S.modal = null; renderModal(); } return; }
    const fn = ACT[el.dataset.act];
    if (fn) run(fn)(el.dataset);
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') {
      S.search = e.target.value;
      $('#dish-area').innerHTML = dishAreaHtml();
      document.querySelectorAll('.cat').forEach((b) => b.classList.toggle('on', !S.search && +b.dataset.id === S.cat));
    }
    if (e.target.id === 'cash-in') {
      const got = Math.round(parseFloat(e.target.value || '0') * 100);
      const ch = got - S.order.total_cents;
      $('#change').textContent = got ? (ch >= 0 ? `Change: ${money(ch)}` : `Short by ${money(-ch)}`) : '';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (!S.user && /^[0-9]$/.test(e.key)) pinKey(e.key);
    else if (!S.user && e.key === 'Backspace') pinKey('back');
    else if (!S.user && e.key === 'Enter') pinKey('ok');
    else if (e.key === 'Escape' && S.modal) { S.modal = null; renderModal(); }
  });

  // tick: clock every 15s, full re-render each minute for ages (skip while a modal or input is active)
  setInterval(() => { const c = $('#clock'); if (c && S.cfg) c.textContent = clock(Date.now()); }, 15000);
  setInterval(() => { if (S.user && !S.modal && document.activeElement?.tagName !== 'INPUT') render(); }, 60000);

  // ---------- boot ----------
  async function boot() {
    S.cfg = S.cfg || await fetch('/api/config').then((r) => r.json());
    document.title = `${S.cfg.restaurant} · POS`;
    try { S.user = await api('/me'); } catch { return renderLogin(); }
    [S.menu] = await Promise.all([api('/menu'), loadFloor()]);
    if (!S.es) { S.es = true; connectEvents(); }
    render();
  }
  run(boot)();
})();
