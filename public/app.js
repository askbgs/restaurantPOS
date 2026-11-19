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
    admin: { section: 'items', data: null, sel: null, cat: 'all', q: '', printing: null, audit: null, auditFilter: '' },
    shift: null, shifts: [], shiftSel: null, shiftDetail: null,
    rep: { preset: 'today', from: '', to: '', data: null },
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
  const isPending = (i) => !i.kot_id && !i.served_direct;
  const lineTotal = (i) => (i.qty - (i.void_qty || 0)) * (i.unit_price_cents + i.addons_cents);

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
  async function loadFloor() { [S.floor, S.shift] = await Promise.all([api('/floor'), api('/shift')]); }
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
    if (S.tab === 'shift') await loadShift();
    if (S.tab === 'admin' || S.tab === 'reports') { const h = $('header.topbar'); if (h) h.outerHTML = header(); return; }
    render();
  }

  let refreshTimer;
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(run(refresh), 250); }

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.onopen = () => { S.live = true; updateLiveDot(); };
    es.onmessage = (e) => {
      if (e.data === 'menu') api('/menu').then((m) => { S.menu = m; }).catch(() => {});
      if (e.data === 'settings') fetch('/api/config').then((x) => x.json()).then((c) => { S.cfg = c; document.title = `${c.restaurant} · POS`; scheduleRefresh(); }).catch(() => {});
      scheduleRefresh();
    };
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
          ${tab('shift', 'Shift', S.shift?.shift ? `#${S.shift.shift.id} open` : 'Not open')}
          ${isManager() ? tab('reports', 'Reports', 'Sales') : ''}
          ${isManager() ? tab('admin', 'Admin', 'Menu & staff') : ''}
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
            ${i.image_ver ? `<img class="dish-img" src="/menu-img/${i.id}?v=${i.image_ver}" alt="" loading="lazy">` : ''}
            <span class="n">${esc(i.name)}</span><span class="tags">${i.tags.map(esc).join(' · ')}${i.no_kot ? `${i.tags.length ? ' · ' : ''}<b class="ready-tag">Ready · no KOT</b>` : ''}</span><span class="p">${money(i.price_cents)}</span>
          </button>
          <button type="button" class="opt" data-act="options" data-id="${i.id}">Options</button>
        </div>`).join('') || '<div class="empty">No dishes found.</div>'}</div>`;
  }

  function orderView() {
    if (!S.order) return startView();
    const o = S.order;
    const cats = S.menu.categories;
    if (!S.cat) S.cat = cats[0]?.id;
    const pending = o.items.filter(isPending);
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
              <button type="button" class="link-red" style="margin-top:8px" data-act="void">${o.kots.length || o.items.some((i) => i.served_direct) ? 'Void order' : 'Cancel order'}</button>
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
    const left = eq(i);
    return `<div class="line ${left === 0 ? 'voided' : ''}">
      <div class="r"><span>${left} × ${esc(i.name)}</span><span>${left === 0 ? 'VOID' : money(lineTotal(i))}</span></div>
      ${modsHtml(i) ? `<div class="mods">${modsHtml(i)}</div>` : ''}
      ${i.void_qty ? `<div class="mods note-red">${i.void_qty} voided</div>` : ''}
      ${i.kot_id || i.served_direct ? `<div class="ctl"><span class="badge ${i.served_direct ? 'direct' : ''}" style="margin-top:0">${i.served_direct ? 'Served · no KOT' : `KOT #${i.kot_no} · ${KOT_LABEL[i.kot_status]}`}</span>
           ${left > 0 ? `<button type="button" class="void-btn" data-act="void-item" data-id="${i.id}">Void</button>` : ''}</div>`
        : `<div class="ctl"><button type="button" data-act="qty" data-id="${i.id}" data-q="${i.qty - 1}">−</button><button type="button" data-act="qty" data-id="${i.id}" data-q="${i.qty + 1}">+</button>
           <span class="badge new" style="margin-top:0">New · not sent</span>
           <button type="button" class="nokot-btn" data-act="no-kot" data-id="${i.id}" title="Already cooked or ready-made: mark served without a kitchen ticket">No KOT</button></div>`}
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
        ${k.items.map((i) => `<button type="button" class="ki ${i.done || eq(i) === 0 ? 'done' : ''}" data-act="tick" data-id="${i.id}"><span>${eq(i) === 0 ? '<b class="note-red">VOID</b>' : eq(i)}</span>
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
    const pending = o.items.filter(isPending);
    const segBtn = (act, val, cur, label, extra = '') => `<button type="button" class="${String(val) === String(cur) ? 'on' : ''}" data-act="${act}" data-v="${val}" ${extra}>${label}</button>`;
    const per = o.split_ways > 1 ? Math.ceil(o.total_cents / o.split_ways) : 0;
    return `
      <section class="bill">
        <div class="bill-left scroll"><div class="inner">
          <div class="eyebrow">Bill · ${TYPE_LABEL[o.type]}</div>
          <h1 class="title" style="font-size:44px">${esc(orderTitle(o))}</h1>
          <div class="muted">Opened ${clock(o.opened_at)} · ${mins(o.opened_at)} min · ${esc(o.staff_name || '')}${o.bill_printed_at ? ` · Bill printed ${clock(o.bill_printed_at)}` : ''}</div>
          ${pending.length ? `<div class="warn"><span>${pending.length} item${pending.length > 1 ? 's have' : ' has'} not been sent to the kitchen. Charging sends ${pending.length > 1 ? 'them' : 'it'} automatically.</span>
            <button type="button" data-act="tab" data-tab="order">Back to order</button></div>` : '<div style="height:22px"></div>'}
          <div class="blines">${o.items.filter((i) => eq(i) > 0).map((i) => `<div class="bline"><span>${eq(i)}</span><span>${esc(i.name)}${modsHtml(i) ? `<small>${modsHtml(i)}</small>` : ''}</span><span>${money(lineTotal(i))}</span></div>`).join('') || '<div class="empty">No items yet.</div>'}</div>
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
              ${d.status === 'paid' ? `<div style="margin-top:8px"><b>${money(d.total_cents)}</b> · ${esc((d.payment_method || '').toUpperCase())}${d.refunded_cents ? ` · <span class="note-red">refunded ${money(d.refunded_cents)}</span>` : ''}</div>` : ''}
              <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
                ${d.status === 'paid' && d.refunded_cents < d.total_cents ? `<button type="button" class="btn" data-act="refund" data-id="${d.id}">Refund</button>` : ''}
                ${d.items.length ? `<button type="button" class="btn" data-act="reprint" data-id="${d.id}">Reprint ${d.status === 'paid' ? 'receipt' : 'bill'}</button>` : ''}</div></div>
            <div class="sec"><div class="lbl">ITEMS</div>${d.items.map((i) => `<div class="r ${eq(i) === 0 ? 'voided' : ''}"><span>${eq(i)}</span><span>${esc(i.name)}${i.void_qty ? ` <span class="note-red">(${i.void_qty} voided)</span>` : ''}</span><span>${money(lineTotal(i))}</span></div>`).join('') || '<div class="muted">None</div>'}</div>
            ${d.voids.length ? `<div class="sec"><div class="lbl">VOIDS</div>${d.voids.map((v) => `<div class="note-line"><b>${v.qty} × ${esc(v.name)}</b> · ${money(v.amount_cents)}<div class="muted">${clock(v.created_at)} · ${esc(v.reason)} · ${esc(v.staff_name || '')}${v.approved_name && v.approved_name !== v.staff_name ? ` · approved by ${esc(v.approved_name)}` : ''}</div></div>`).join('')}</div>` : ''}
            ${d.refunds.length ? `<div class="sec"><div class="lbl">REFUNDS</div>${d.refunds.map((r) => `<div class="note-line"><b>${money(r.amount_cents)}</b> · ${esc(r.method)}<div class="muted">${clock(r.created_at)} · ${esc(r.reason)} · ${esc(r.staff_name || '')}${r.approved_name && r.approved_name !== r.staff_name ? ` · approved by ${esc(r.approved_name)}` : ''}</div></div>`).join('')}</div>` : ''}
            <div class="sec"><div class="lbl">KITCHEN TICKETS</div>${d.kots.map((k) => `<div class="k"><b>#${k.kot_no}</b><span>${esc(k.station_name || 'All')}</span><span class="muted">${KOT_LABEL[k.status]}${k.served_at ? ' · ' + clock(k.served_at) : ''} · <button type="button" class="link-red" style="font-size:13px" data-act="kot-reprint" data-id="${k.id}">Reprint</button></span></div>`).join('') || '<div class="muted">None</div>'}</div>`
            : '<div class="empty" style="padding:28px 20px">Select an order to see its items and kitchen tickets.</div>'}
        </aside>
      </section>`;
  }

  // ---------- admin ----------
  const ADMIN_SECTIONS = [['items', 'Menu items'], ['categories', 'Categories'], ['floor', 'Floor & tables'], ['stations', 'Stations'], ['staff', 'Staff'], ['printers', 'Printers'], ['audit', 'Audit log'], ['settings', 'Settings']];
  const ADMIN_PATH = { item: 'items', category: 'categories', area: 'areas', table: 'tables', station: 'stations', staff: 'staff' };
  const ADMIN_NOUN = { item: 'dish', category: 'category', area: 'area', table: 'table', station: 'station', staff: 'staff member' };
  const isManager = () => S.user?.role === 'Manager';
  const major = (c) => ((c || 0) / 100).toFixed(2);
  async function loadAdmin() { S.admin.data = await api('/admin/data'); }

  const field = (label, input, hint = '') => `<div class="field"><label>${label}</label>${input}${hint ? `<small>${hint}</small>` : ''}</div>`;
  const inp = (name, val, extra = '') => `<input name="${name}" value="${esc(val ?? '')}" ${extra}>`;
  const sel = (name, opts, cur) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const check = (name, on, label) => `<label class="check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> ${label}</label>`;
  const addonRow = (a = {}) => `<div class="addon-row"><input data-f="name" placeholder="Add-on name" value="${esc(a.name || '')}">
    <input data-f="price" inputmode="decimal" placeholder="0.00" value="${a.price_cents != null ? major(a.price_cents) : ''}">
    <button type="button" data-act="admin-addon-del" title="Remove">✕</button></div>`;

  function imgPreview(rec) {
    const A = S.admin;
    const src = A.img ? A.img.url : !A.imgRemove && rec?.image_ver ? `/menu-img/${rec.id}?v=${rec.image_ver}` : '';
    return src ? `<img src="${src}" alt="">` : '<span>No photo</span>';
  }
  function resetImg() { if (S.admin.img) URL.revokeObjectURL(S.admin.img.url); S.admin.img = null; S.admin.imgRemove = false; }
  // Shrink to max 800px and re-encode as JPEG in the browser so uploads stay small.
  async function resizeImage(file) {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => { throw new Error('Could not read that image'); });
    const k = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.82));
    if (!blob) throw new Error('Could not process that image');
    return blob;
  }
  async function uploadImage(id, blob) {
    const res = await fetch(`/api/admin/items/${id}/image`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob, credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Photo upload failed');
  }

  function adminForm() {
    const A = S.admin; const D = A.data; const s = A.sel;
    if (!s) return `<div class="empty" style="padding:28px 20px">Select a row to edit it, or add a new one.</div>`;
    const find = (list) => (s.id ? list.find((x) => x.id === s.id) : null);
    let rec, body;
    if (s.kind === 'item') {
      rec = find(D.items) || { name: '', category_id: A.cat !== 'all' ? +A.cat : D.categories[0]?.id, station_id: D.stations[0]?.id, price_cents: 0, tags: [], has_spice: false, active: true, sort: 0, addons: [] };
      body = field('Dish name', inp('name', rec.name, 'required maxlength="80"'))
        + `<div class="two">${field('Category', sel('category_id', D.categories.map((c) => [c.id, c.name]), rec.category_id))}
             ${field('Kitchen station', sel('station_id', D.stations.map((x) => [x.id, x.name]), rec.station_id))}</div>`
        + `<div class="two">${field(`Price (${esc(S.cfg.currency.trim())})`, inp('price', major(rec.price_cents), 'inputmode="decimal" required'))}
             ${field('Sort order', inp('sort', rec.sort, 'inputmode="numeric"'))}</div>`
        + field('Tags', inp('tags', rec.tags.filter((t) => t !== 'Spice level').join(', '), 'placeholder="Wok, Veg"'), 'Comma separated. Shown under the dish name.')
        + `<div class="field">${check('has_spice', rec.has_spice, 'Ask for spice level')}${check('active', rec.active, 'Show on menu')}
             ${check('send_kot', !rec.no_kot, 'Send to kitchen (print a KOT)')}
             <small style="margin-top:-4px">Untick for ready-made items such as bottled drinks, cakes or pre-made short eats. They are served straight away, and staff can still choose per order.</small></div>`
        + `<div class="field"><label>Photo</label>
             <div class="img-edit"><div class="img-box" id="img-box">${imgPreview(rec)}</div>
               <div class="img-actions"><label class="btn" style="cursor:pointer">Choose photo<input type="file" id="img-file" accept="image/*" hidden></label>
                 <button type="button" class="link-red" data-act="admin-img-remove">Remove photo</button>
                 <small class="muted">Resized to 800 px before upload.</small></div></div></div>`
        + `<div class="field"><label>Add-ons</label><div id="addons">${rec.addons.map(addonRow).join('')}</div>
             <button type="button" class="link-red" data-act="admin-addon-add">+ Add add-on</button></div>`;
    } else if (s.kind === 'category') {
      rec = find(D.categories) || { name: '', default_course: 'main', sort: D.categories.length };
      body = field('Category name', inp('name', rec.name, 'required maxlength="60"'))
        + field('Fires as course', sel('default_course', D.courses.map((c) => [c, COURSE_LABEL[c]]), rec.default_course), 'Default course for dishes in this category.')
        + field('Sort order', inp('sort', rec.sort, 'inputmode="numeric"'));
    } else if (s.kind === 'area') {
      rec = find(D.areas) || { name: '', short: '', sort: D.areas.length + 1 };
      body = field('Area name', inp('name', rec.name, 'required maxlength="40"'))
        + field('Short label', inp('short', rec.short, 'maxlength="20"'), 'Used on the Floor filter buttons.')
        + field('Sort order', inp('sort', rec.sort, 'inputmode="numeric"'));
    } else if (s.kind === 'table') {
      rec = find(D.tables) || { code: '', area_id: D.areas[0]?.id, seats: 2, sort: D.tables.length, active: true };
      body = `<div class="two">${field('Table code', inp('code', rec.code, 'required maxlength="10" placeholder="T9"'))}${field('Seats', inp('seats', rec.seats, 'inputmode="numeric" required'))}</div>`
        + field('Area', sel('area_id', D.areas.map((a) => [a.id, a.name]), rec.area_id))
        + field('Sort order', inp('sort', rec.sort, 'inputmode="numeric"'))
        + `<div class="field">${check('active', rec.active, 'Show on floor')}</div>`
        + (rec.busy ? '<div class="warn" style="margin:0">This table has an open order right now.</div>' : '');
    } else if (s.kind === 'station') {
      rec = find(D.stations) || { code: '', name: '', printer: '', sort: D.stations.length };
      body = `<div class="two">${field('Code', inp('code', rec.code, 'required maxlength="12" placeholder="FRY"'))}${field('Name', inp('name', rec.name, 'required maxlength="30"'))}</div>`
        + field('Printer label', inp('printer', rec.printer, 'maxlength="60"'), 'Shown at the bottom of each KOT.')
        + field('Sort order', inp('sort', rec.sort, 'inputmode="numeric"'));
    } else if (s.kind === 'staff') {
      rec = find(D.staff) || { name: '', initials: '', role: 'Server', active: true };
      body = `<div class="two">${field('Name', inp('name', rec.name, 'required maxlength="40"'))}${field('Initials', inp('initials', rec.initials, 'maxlength="3"'))}</div>`
        + field('Role', sel('role', D.roles.map((r) => [r, r]), rec.role), 'Only Managers can open Admin.')
        + field(s.id ? 'New PIN' : 'PIN', inp('pin', '', `inputmode="numeric" maxlength="8" autocomplete="off" ${s.id ? 'placeholder="Leave blank to keep"' : 'required'}`), '4–8 digits. Must be unique.')
        + `<div class="field">${check('active', rec.active, 'Can sign in')}</div>`;
    }
    const canDelete = s.id && s.kind !== 'staff';
    return `<form id="admin-form" autocomplete="off">
      <div class="hd"><div class="eyebrow">${s.id ? 'Edit' : 'New'} ${ADMIN_NOUN[s.kind]}</div><h2>${esc(s.id ? rec.name || rec.code : `Add ${ADMIN_NOUN[s.kind]}`)}</h2></div>
      <div class="form-body">${body}</div>
      <div class="form-foot">
        ${canDelete ? `<button type="button" class="btn" data-act="admin-delete">Delete</button>` : '<span></span>'}
        <button type="button" class="btn" data-act="admin-cancel">Cancel</button>
        <button type="submit" class="btn red">Save</button>
      </div></form>`;
  }

  function adminList() {
    const A = S.admin; const D = A.data;
    const selRow = (kind, id) => (A.sel?.kind === kind && A.sel?.id === id ? 'sel' : '');
    const head = (title, sub, kind, extra = '') => `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Admin</div><h1 class="title">${title}</h1><div class="muted">${sub}</div></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${extra}<button type="button" class="btn dark" data-act="admin-new" data-kind="${kind}">+ Add ${ADMIN_NOUN[kind]}</button></div></div>`;
    const catName = (id) => D.categories.find((c) => c.id === id)?.name || '—';
    const stName = (id) => D.stations.find((c) => c.id === id)?.name || '—';
    if (A.section === 'items') {
      const q = A.q.trim().toLowerCase();
      const list = D.items.filter((i) => (A.cat === 'all' || i.category_id === +A.cat) && (!q || i.name.toLowerCase().includes(q)));
      return head('Menu items', `${D.items.filter((i) => i.active).length} on the menu · ${D.items.filter((i) => !i.active).length} hidden`, 'item',
        `<button type="button" class="btn" data-act="admin-sample-menu">Load Asian menu</button>
         <input id="admin-q" class="admin-search" type="search" placeholder="Search dishes..." value="${esc(A.q)}">
         <select id="admin-cat" class="admin-select"><option value="all">All categories</option>${D.categories.map((c) => `<option value="${c.id}" ${String(c.id) === A.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`)
        + `<div class="htable-wrap"><table class="htable"><thead><tr><th>Dish</th><th>Category</th><th>Station</th><th>Add-ons</th><th>Status</th><th style="text-align:right">Price</th></tr></thead><tbody>
          ${list.map((i) => `<tr class="${selRow('item', i.id)}" data-act="admin-sel" data-kind="item" data-id="${i.id}">
            <td class="name"><div class="dish-cell">${i.image_ver ? `<img src="/menu-img/${i.id}?v=${i.image_ver}" alt="" loading="lazy">` : '<span class="noimg"></span>'}
              <div><b>${esc(i.name)}</b><div class="muted" style="font-size:12.5px">${i.tags.map(esc).join(' · ')}</div></div></div></td><td>${esc(catName(i.category_id))}</td><td>${esc(stName(i.station_id))}</td>
            <td>${i.addons.length || '—'}</td><td><span class="s ${i.active ? 'paid' : 'void'}">${i.active ? 'On menu' : 'Hidden'}</span>${i.no_kot ? '<div class="muted" style="font-size:12px">No KOT</div>' : ''}</td><td style="text-align:right"><b>${money(i.price_cents)}</b></td></tr>`).join('')
            || '<tr><td colspan="6" class="muted">No dishes match.</td></tr>'}</tbody></table></div>`;
    }
    if (A.section === 'categories') {
      return head('Categories', `${D.categories.length} categories · shown in sort order on the Order screen`, 'category')
        + `<div class="htable-wrap"><table class="htable"><thead><tr><th>Sort</th><th>Category</th><th>Fires as</th><th>Dishes</th></tr></thead><tbody>
          ${D.categories.map((c) => `<tr class="${selRow('category', c.id)}" data-act="admin-sel" data-kind="category" data-id="${c.id}">
            <td>${c.sort}</td><td class="name"><b>${esc(c.name)}</b></td><td>${COURSE_LABEL[c.default_course]}</td><td>${c.item_count}</td></tr>`).join('')}</tbody></table></div>`;
    }
    if (A.section === 'floor') {
      return head('Floor & tables', `${D.areas.length} areas · ${D.tables.filter((t) => t.active).length} tables on the floor`, 'table',
        `<button type="button" class="btn" data-act="admin-new" data-kind="area">+ Add area</button>`)
        + D.areas.map((a) => `<div class="area" style="padding-top:8px">
            <h3 style="display:flex;align-items:baseline;gap:8px">${esc(a.name)}<small>${a.table_count} tables</small>
              <button type="button" class="link-red" data-act="admin-sel" data-kind="area" data-id="${a.id}">Edit area</button></h3>
            <div class="grid4">${D.tables.filter((t) => t.area_id === a.id).map((t) => `
              <button type="button" class="tcard ${t.active ? 'free' : 'dining'} ${selRow('table', t.id) ? 'ordering' : ''}" style="min-height:96px" data-act="admin-sel" data-kind="table" data-id="${t.id}">
                <div class="row1"><span class="code" style="font-size:24px">${esc(t.code)}</span><span class="seats">${t.seats} seats</span></div>
                <span class="st">${t.active ? (t.busy ? 'Open order' : 'On floor') : 'Hidden'}</span></button>`).join('')}
              <button type="button" class="tcard" style="min-height:96px;justify-content:center;color:var(--red-ink);font-weight:700" data-act="admin-new" data-kind="table" data-area="${a.id}">+ Add table</button>
            </div></div>`).join('') + '<div style="height:28px"></div>';
    }
    if (A.section === 'stations') {
      return head('Kitchen stations', 'Each station gets its own KOT and its own column filter on the Kitchen screen', 'station')
        + `<div class="htable-wrap"><table class="htable"><thead><tr><th>Sort</th><th>Code</th><th>Station</th><th>Printer</th><th>Dishes</th></tr></thead><tbody>
          ${D.stations.map((s) => `<tr class="${selRow('station', s.id)}" data-act="admin-sel" data-kind="station" data-id="${s.id}">
            <td>${s.sort}</td><td><b>${esc(s.code)}</b></td><td class="name">${esc(s.name)}</td><td>${esc(s.printer)}</td><td>${s.item_count}</td></tr>`).join('')}</tbody></table></div>`;
    }
    if (A.section === 'printers') return printersList();
    if (A.section === 'audit') return auditList();
    if (A.section === 'settings') {
      const st = D.settings;
      const p = (f) => +(f * 100).toFixed(3);
      return `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Admin</div><h1 class="title">Settings</h1>
          <div class="muted">Shown in the header, on bills and on kitchen tickets. Saved for every terminal.</div></div></div>
        <form id="settings-form" class="settings-form" autocomplete="off">
          <div class="two">${field('Restaurant name', inp('restaurant', st.restaurant, 'required maxlength="40"'))}
            ${field('Terminal name', inp('terminal', st.terminal, 'required maxlength="40" placeholder="Asian Cuisine"'), 'Shown under the restaurant name, e.g. Asian Cuisine.')}</div>
          <div class="two">${field('Currency symbol', inp('currency', st.currency.trim(), 'maxlength="6"'), 'e.g. Rs, LKR, ₹, $')}
            ${field('Late ticket after (minutes)', inp('lateMinutes', st.lateMinutes, 'inputmode="numeric"'))}</div>
          <div class="two">${field('Tax label', inp('taxLabel', st.taxLabel, 'required maxlength="20"'))}
            ${field('Tax rate (%)', inp('taxRate', p(st.taxRate), 'inputmode="decimal"'))}</div>
          <div class="two">${field('Service charge (%)', inp('serviceRate', p(st.serviceRate), 'inputmode="decimal"'))}<div></div></div>
          <button type="submit" class="btn red" style="min-width:200px;text-align:center">Save settings</button>
        </form>
        <div class="settings-form" style="margin-top:8px;border-top:1px solid var(--line);padding-top:22px">
          <h3 style="margin:0 0 6px">Sample menu</h3>
          <div class="muted" style="margin-bottom:12px">Replace the menu with Short Eats, Sri Lankan, Indian, Chinese, Thai, Japanese, Korean, Desserts and Drinks.</div>
          <button type="button" class="btn" data-act="admin-sample-menu">Load Asian menu</button>
        </div>`;
    }
    return head('Staff', `${D.staff.filter((s) => s.active).length} active · sign in with a PIN`, 'staff')
      + `<div class="htable-wrap"><table class="htable"><thead><tr><th></th><th>Name</th><th>Role</th><th>Status</th></tr></thead><tbody>
        ${D.staff.map((s) => `<tr class="${selRow('staff', s.id)}" data-act="admin-sel" data-kind="staff" data-id="${s.id}">
          <td style="width:52px"><span class="avatar" style="display:inline-grid">${esc(s.initials)}</span></td><td class="name"><b>${esc(s.name)}</b>${s.id === S.user.id ? ' <span class="muted">(you)</span>' : ''}</td>
          <td>${esc(s.role)}</td><td><span class="s ${s.active ? 'paid' : 'void'}">${s.active ? 'Active' : 'Disabled'}</span></td></tr>`).join('')}</tbody></table></div>`;
  }

  function adminView() {
    if (!isManager()) return '<section class="start"><h1 class="title">Managers only</h1><div class="muted">Sign in with a Manager PIN to open Admin.</div></section>';
    if (!S.admin.data) return '<section class="hist"><div class="empty">Loading…</div></section>';
    return `<section class="admin">
      <aside class="cats scroll"><div class="label">ADMIN</div>
        ${ADMIN_SECTIONS.map(([id, label]) => `<button type="button" class="cat ${S.admin.section === id ? 'on' : ''}" data-act="admin-section" data-id="${id}">${label}</button>`).join('')}
      </aside>
      <div class="scroll" id="admin-list">${adminList()}</div>
      <aside class="hdetail scroll admin-form">${S.admin.sel?.kind === 'printer' ? printerForm()
        : S.admin.section === 'audit' ? '<div class="empty" style="padding:28px 20px">The audit log is read-only. Entries cannot be edited or deleted.</div>'
        : S.admin.section === 'printers' ? `<div class="empty" style="padding:28px 20px">
            <b>How printing works</b><br><br>1. Add each thermal printer with its IP address (most LAN printers use port 9100).<br><br>
            2. Choose which printer gets bills and which station prints where.<br><br>
            3. Run the print bridge on any PC on the same network. It stays connected and prints jobs within a second.<br><br>
            If no printer is set, the app falls back to the browser print dialog.</div>`
        : S.admin.section === 'settings'
        ? '<div class="empty" style="padding:28px 20px">Changes apply to every terminal straight away. Tax and service charge changes apply to open and new orders; paid orders keep their totals.</div>'
        : adminForm()}</aside>
    </section>`;
  }

  function readAdminForm() {
    const f = $('#admin-form');
    const fd = new FormData(f);
    const body = Object.fromEntries([...fd.entries()].filter(([k]) => !['has_spice', 'active', 'send_kot'].includes(k)));
    if (f.querySelector('[name="has_spice"]')) body.has_spice = fd.has('has_spice');
    if (f.querySelector('[name="active"]')) body.active = fd.has('active');
    if (f.querySelector('[name="send_kot"]')) body.send_kot = fd.has('send_kot');
    if (S.admin.sel.kind === 'item') {
      body.addons = [...f.querySelectorAll('.addon-row')].map((r) => ({ name: r.querySelector('[data-f="name"]').value, price: r.querySelector('[data-f="price"]').value || 0 }));
    }
    return body;
  }
  async function adminSave() {
    const s = S.admin.sel;
    const body = readAdminForm();
    const path = `/admin/${ADMIN_PATH[s.kind]}${s.id ? '/' + s.id : ''}`;
    const out = await api(path, { method: s.id ? 'PATCH' : 'POST', body });
    if (s.kind === 'item') {
      const id = s.id || out.id;
      if (S.admin.img) await uploadImage(id, S.admin.img.blob);
      else if (S.admin.imgRemove && s.id) await api(`/admin/items/${id}/image`, { method: 'DELETE' });
      resetImg();
    }
    toast(`${s.id ? 'Saved' : 'Added'} ${body.name || body.code || ADMIN_NOUN[s.kind]}`);
    await afterAdminChange(s.id ? s : null);
  }
  async function afterAdminChange(keepSel) {
    await Promise.all([loadAdmin(), loadFloor(), api('/menu').then((m) => { S.menu = m; })]);
    if (!S.menu.categories.some((c) => c.id === S.cat)) S.cat = S.menu.categories[0]?.id;
    S.admin.sel = keepSel;
    if (S.admin.sel?.kind === 'staff' && S.admin.sel.id === S.user.id) S.user = await api('/me');
    render();
  }

  // ---------- approval / form modal ----------
  // Generic form modal. needPin shows a manager/cashier PIN box when the signed-in role can't approve alone.
  const VOID_REASONS = ['Customer changed mind', 'Wrong item entered', 'Kitchen mistake', 'Out of stock', 'Long wait'];
  const REFUND_REASONS = ['Food quality', 'Wrong order', 'Overcharged', 'Long wait', 'Item not delivered'];
  const CASH_REASONS = { out: ['Supplier payment', 'Bought ingredients', 'Petty cash', 'Bank deposit'], in: ['Extra change', 'Owner top-up', 'Float correction'] };
  const canApprove = (roles) => roles.includes(S.user.role);
  function formModal({ eyebrow = 'Confirm', title, body = '', reasons, roles, submit, onSubmit, wide }) {
    const needPin = roles && !canApprove(roles);
    S.modal = { kind: 'form', eyebrow, title, wide, onSubmit, html: body
      + (reasons ? `<label>Reason</label><div class="chips" style="margin-bottom:8px">${reasons.map((r) => `<button type="button" class="chip" data-act="fill-reason" data-v="${esc(r)}">${esc(r)}</button>`).join('')}</div>
          <input name="reason" maxlength="200" placeholder="Or type a reason" required>` : '')
      + (needPin ? `<label>${roles.join(' or ')} PIN</label><input name="approval_pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off" required placeholder="Ask a ${roles[0].toLowerCase()} to enter their PIN">
          <small class="muted" style="display:block;margin-top:4px">Your role (${esc(S.user.role)}) needs approval for this.</small>` : ''),
      submit };
    renderModal();
  }
  const eq = (i) => i.qty - (i.void_qty || 0);

  // ---------- shift ----------
  async function loadShift() {
    const [cur, list] = await Promise.all([api('/shift'), api('/shifts')]);
    S.shift = cur; S.shifts = list.shifts;
    if (S.shiftSel) S.shiftDetail = await api('/shifts/' + S.shiftSel).catch(() => null);
  }
  const drawerRow = (l, v, cls = '') => `<div class="r ${cls}"><span>${l}</span><span>${v}</span></div>`;
  function shiftCard(sum) {
    const sh = sum.shift;
    const v = sh.counted_cents != null ? sh.counted_cents - sum.expected_cents : null;
    return `<div class="shift-grid">
      <div class="shift-box"><div class="lbl">SALES</div>
        ${drawerRow('Orders paid', sum.sales.orders)}${drawerRow('Covers', sum.sales.covers)}
        ${drawerRow('Gross sales', `<b>${money(sum.sales.gross_cents)}</b>`)}
        ${drawerRow('Discounts', '−' + money(sum.sales.discount_cents))}${drawerRow('Service charge', money(sum.sales.service_cents))}
        ${drawerRow(esc(S.cfg.taxLabel), money(sum.sales.tax_cents))}${drawerRow('Tips', money(sum.sales.tip_cents))}
        ${drawerRow('Refunds', '−' + money(sum.refunds.total_cents))}
        ${drawerRow('Net sales', `<b>${money(sum.sales.gross_cents - sum.refunds.total_cents)}</b>`, 'tot')}</div>
      <div class="shift-box"><div class="lbl">PAYMENTS (after refunds)</div>
        ${['cash', 'card', 'wallet'].map((m) => drawerRow(m[0].toUpperCase() + m.slice(1), money(sum.payments[m] - sum.refunds[m]))).join('')}
        <div class="lbl" style="margin-top:16px">VOIDS</div>
        ${drawerRow(`Items voided (${sum.voids.count})`, money(sum.voids.amount_cents))}${drawerRow('Orders voided', sum.voids.orders)}</div>
      <div class="shift-box drawer"><div class="lbl">CASH DRAWER</div>
        ${drawerRow('Opening float', money(sh.float_cents))}${drawerRow('Cash sales', money(sum.payments.cash))}
        ${drawerRow('Cash refunds', '−' + money(sum.refunds.cash))}${drawerRow('Cash in', money(sum.cash.in_cents))}${drawerRow('Cash out', '−' + money(sum.cash.out_cents))}
        ${drawerRow('Expected in drawer', `<b>${money(sum.expected_cents)}</b>`, 'tot')}
        ${v != null ? drawerRow('Counted', `<b>${money(sh.counted_cents)}</b>`) + drawerRow(v === 0 ? 'Balanced' : v > 0 ? 'Over' : 'Short', `<b>${money(Math.abs(v))}</b>`, v === 0 ? '' : 'bad') : ''}</div>
    </div>
    ${sum.cash.movements.length ? `<div class="shift-box" style="margin-top:12px"><div class="lbl">CASH IN / OUT</div>
      ${sum.cash.movements.map((m) => drawerRow(`${clock(m.created_at)} · ${m.kind === 'in' ? 'In' : 'Out'} · ${esc(m.reason)} <span class="muted">(${esc(m.staff_name || '')})</span>`, (m.kind === 'in' ? '' : '−') + money(m.amount_cents))).join('')}</div>` : ''}
    ${sum.refund_list.length ? `<div class="shift-box" style="margin-top:12px"><div class="lbl">REFUNDS</div>
      ${sum.refund_list.map((r) => drawerRow(`${clock(r.created_at)} · #${r.order_no} · ${esc(r.reason)} <span class="muted">(${r.method})</span>`, '−' + money(r.amount_cents))).join('')}</div>` : ''}`;
  }
  function shiftView() {
    if (!S.shift) return '<section class="hist"><div class="empty">Loading…</div></section>';
    const cur = S.shift.shift ? S.shift : null;
    const d = S.shiftDetail;
    return `<section class="hist">
      <div class="scroll">
        <div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Cash drawer</div><h1 class="title">Shift</h1>
          <div class="muted">${cur ? `Shift #${cur.shift.id} open since ${clock(cur.shift.opened_at)} · opened by ${esc(cur.shift.opened_by_name || '')}` : 'No shift is open. Open one before taking payments.'}</div></div>
          ${cur ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn" data-act="cash-move" data-kind="in">Cash in</button>
              <button type="button" class="btn" data-act="cash-move" data-kind="out">Cash out</button>
              <button type="button" class="btn" data-act="shift-print" data-id="${cur.shift.id}">Print X report</button>
              <button type="button" class="btn red" data-act="shift-close">Close shift</button></div>` : ''}</div>
        <div style="padding:0 28px 28px">
          ${cur ? `${cur.open_orders ? `<div class="warn" style="margin-top:0">${cur.open_orders} order${cur.open_orders > 1 ? 's are' : ' is'} still open. You can close the shift, but those bills will be taken in the next shift.</div>` : ''}${shiftCard(cur)}`
            : `<form id="shift-open-form" class="shift-open"><div class="field"><label>Opening float (cash in the drawer)</label>
                <input name="float" inputmode="decimal" placeholder="0.00" required></div>
                <button type="submit" class="btn red">Open shift</button></form>`}
          <h3 style="margin:28px 0 8px">Past shifts</h3>
          <table class="htable"><thead><tr><th>Shift</th><th>Opened</th><th>Closed</th><th>Orders</th><th>Gross</th><th>Expected</th><th>Counted</th><th>Variance</th></tr></thead><tbody>
            ${S.shifts.filter((x) => x.status === 'closed').map((x) => { const v = x.counted_cents - x.expected_cents; return `<tr class="${S.shiftSel === x.id ? 'sel' : ''}" data-act="shift-sel" data-id="${x.id}">
              <td><b>#${x.id}</b></td><td>${new Date(x.opened_at).toLocaleString('en-GB', { timeZone: S.cfg.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}<div class="muted" style="font-size:12.5px">${esc(x.opened_by_name || '')}</div></td>
              <td>${clock(x.closed_at)}<div class="muted" style="font-size:12.5px">${esc(x.closed_by_name || '')}</div></td><td>${x.orders}</td><td>${money(x.gross_cents)}</td>
              <td>${money(x.expected_cents)}</td><td>${money(x.counted_cents)}</td><td><span class="s ${v === 0 ? 'paid' : 'ready'}">${v === 0 ? 'Balanced' : (v > 0 ? 'Over ' : 'Short ') + money(Math.abs(v))}</span></td></tr>`; }).join('')
              || '<tr><td colspan="8" class="muted">No closed shifts yet.</td></tr>'}</tbody></table>
        </div>
      </div>
      <aside class="hdetail scroll">${d ? `<div class="hd"><div class="eyebrow">Z report · shift #${d.shift.id}</div><h2>${money(d.sales.gross_cents - d.refunds.total_cents)}</h2>
          <div class="muted">${esc(d.shift.opened_by_name || '')} → ${esc(d.shift.closed_by_name || '')}${d.shift.note ? ` · ${esc(d.shift.note)}` : ''}</div>
          <button type="button" class="btn" style="margin-top:12px" data-act="shift-print" data-id="${d.shift.id}">Reprint Z report</button></div>
          <div class="sec compact">${shiftCard(d)}</div>`
        : '<div class="empty" style="padding:28px 20px">Select a past shift to see its Z report.</div>'}</aside>
    </section>`;
  }
  function zReportPrint(sum) {
    const P = $('#print'); const sh = sum.shift;
    const r = (a, b) => `<div class="r"><span>${a}</span><span>${b}</span></div>`;
    const v = sh.counted_cents != null ? sh.counted_cents - sum.expected_cents : null;
    P.innerHTML = `<h3>${esc(S.cfg.restaurant)}</h3><div class="c">${sh.status === 'closed' ? 'Z REPORT · SHIFT CLOSE' : 'X REPORT · SHIFT SO FAR'}</div><hr>
      ${r('Shift', '#' + sh.id)}${r('Opened', clock(sh.opened_at) + ' · ' + esc(sh.opened_by_name || ''))}${sh.closed_at ? r('Closed', clock(sh.closed_at) + ' · ' + esc(sh.closed_by_name || '')) : ''}<hr>
      ${r('Orders paid', sum.sales.orders)}${r('Gross sales', money(sum.sales.gross_cents))}${r('Discounts', '-' + money(sum.sales.discount_cents))}
      ${r('Service', money(sum.sales.service_cents))}${r(esc(S.cfg.taxLabel), money(sum.sales.tax_cents))}${r('Tips', money(sum.sales.tip_cents))}
      ${r('Refunds', '-' + money(sum.refunds.total_cents))}<b>${r('Net sales', money(sum.sales.gross_cents - sum.refunds.total_cents))}</b><hr>
      ${['cash', 'card', 'wallet'].map((m) => r(m, money(sum.payments[m] - sum.refunds[m]))).join('')}<hr>
      ${r('Float', money(sh.float_cents))}${r('Cash sales', money(sum.payments.cash))}${r('Cash refunds', '-' + money(sum.refunds.cash))}
      ${r('Cash in', money(sum.cash.in_cents))}${r('Cash out', '-' + money(sum.cash.out_cents))}<b>${r('Expected', money(sum.expected_cents))}</b>
      ${v != null ? r('Counted', money(sh.counted_cents)) + `<b>${r(v === 0 ? 'Balanced' : v > 0 ? 'Over' : 'Short', money(Math.abs(v)))}</b>` : ''}<hr>
      ${r(`Voided items (${sum.voids.count})`, money(sum.voids.amount_cents))}${r('Voided orders', sum.voids.orders)}
      <br><div>Signature: ____________</div>`;
    window.print();
  }
  // Sri Lankan note/coin counter for closing the drawer
  const DENOMS = [5000, 2000, 1000, 500, 100, 50, 20, 10, 5, 2, 1];

  // ---------- reports ----------
  const isoDay = (d) => d.toLocaleDateString('en-CA', { timeZone: S.cfg.timezone });
  function rangeFor(preset) {
    const now = new Date(); const day = 86400000;
    const today = isoDay(now);
    if (preset === 'today') return [today, today];
    if (preset === 'yesterday') { const y = isoDay(new Date(now - day)); return [y, y]; }
    if (preset === '7d') return [isoDay(new Date(now - 6 * day)), today];
    if (preset === '30d') return [isoDay(new Date(now - 29 * day)), today];
    if (preset === 'month') return [today.slice(0, 8) + '01', today];
    return [S.rep.from, S.rep.to];
  }
  async function loadReport() {
    const [from, to] = rangeFor(S.rep.preset);
    S.rep.from = from; S.rep.to = to;
    S.rep.data = await api(`/reports?from=${from}&to=${to}`);
  }
  function barChart(points, { label, valueFmt = money, height = 180, tickEvery = 1 }) {
    // single-series bar chart, inline SVG; hover shows a tooltip via <title> plus a custom tip
    const max = Math.max(1, ...points.map((p) => p.v));
    const n = points.length; const W = 760; const H = height; const pad = { l: 4, r: 4, t: 10, b: 24 };
    const bw = (W - pad.l - pad.r) / n; const gap = Math.min(6, Math.max(2, bw * 0.25));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    const bars = points.map((p, i) => {
      const w = Math.max(1, Math.min(44, bw - gap)); const x = pad.l + i * bw + (bw - w) / 2; const top = y(p.v); const h = H - pad.b - top;
      const r = Math.min(4, w / 2, h);
      const path = h > 0 ? `M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${H - pad.b} Z` : '';
      return `<g class="bar" data-tip="${esc(p.label)}: ${esc(valueFmt(p.v))}${p.extra ? ' · ' + esc(p.extra) : ''}">
        <rect x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" fill="transparent"/>
        ${path ? `<path d="${path}" class="bar-fill"/>` : ''}
        ${i % tickEvery === 0 ? `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle" class="tick">${esc(p.tick)}</text>` : ''}</g>`;
    }).join('');
    const maxLabel = valueFmt(max);
    return `<div class="chart" role="img" aria-label="${esc(label)}"><div class="chart-max muted">Peak ${esc(maxLabel)}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="bars">
        <line x1="0" x2="${W}" y1="${H - pad.b}" y2="${H - pad.b}" class="axis"/>${bars}</svg><div class="chart-tip hidden"></div></div>`;
  }
  const kpi = (label, value, sub = '') => `<div class="kpi"><div class="lbl">${label}</div><div class="v">${value}</div>${sub ? `<div class="muted sub">${sub}</div>` : ''}</div>`;
  const meterTable = (rows, cols, valueKey = 'cents') => {
    const max = Math.max(1, ...rows.map((r) => r[valueKey]));
    return `<table class="htable rep"><thead><tr>${cols.map((c) => `<th style="${c.right ? 'text-align:right' : ''}">${c.h}</th>`).join('')}</tr></thead><tbody>
      ${rows.map((r) => `<tr>${cols.map((c) => `<td style="${c.right ? 'text-align:right' : ''}" class="${c.meter ? 'meter-cell' : ''}">${c.meter ? `<div class="meter"><i style="width:${(r[valueKey] / max) * 100}%"></i></div>` : ''}${c.f(r)}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${cols.length}" class="muted">Nothing in this period.</td></tr>`}</tbody></table>`;
  };
  function reportsView() {
    if (!isManager()) return '<section class="start"><h1 class="title">Managers only</h1></section>';
    const R = S.rep; const d = R.data;
    const presets = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['custom', 'Custom']];
    const head = `<div class="page-head rep-head" style="border-bottom:0"><div><div class="eyebrow">Reports</div><h1 class="title">Sales</h1>
        <div class="muted">${d ? (d.from === d.to ? d.from : `${d.from} → ${d.to}`) : ''}</div></div>
      <div class="rep-controls no-print">
        <div class="seg">${presets.map(([k, l]) => `<button type="button" class="${R.preset === k ? 'on' : ''}" data-act="rep-preset" data-v="${k}">${l}</button>`).join('')}</div>
        ${R.preset === 'custom' ? `<form id="rep-range" class="rep-range"><input type="date" name="from" value="${R.from}" required><span>→</span><input type="date" name="to" value="${R.to}" required><button class="btn dark" type="submit">Apply</button></form>` : ''}
        <button type="button" class="btn" data-act="rep-csv">Export CSV</button><button type="button" class="btn" data-act="rep-print">Print / PDF</button>
      </div></div>`;
    if (!d) return `<section class="reports scroll">${head}<div class="empty">Loading…</div></section>`;
    const K = d.kpis;
    const TYPE = (t) => TYPE_LABEL[t] || t;
    const hours = d.by_hour.filter((h, i, a) => a.slice(0, i + 1).some((x) => x.cents) && a.slice(i).some((x) => x.cents));
    return `<section class="reports scroll">${head}
      <div class="rep-body">
        <div class="kpis">
          ${kpi('Net sales', money(K.net_cents), `${money(K.gross_cents)} gross − ${money(K.refunds_cents)} refunds`)}
          ${kpi('Orders', K.orders, `${K.dinein_orders} dine-in · ${K.orders - K.dinein_orders} other`)}
          ${kpi('Average bill', money(K.avg_bill_cents), K.covers ? `${money(K.avg_per_cover_cents)} per cover · ${K.covers} covers` : '')}
          ${kpi('Discounts', money(K.discount_cents), d.discounts.map((x) => `${x.pct}% × ${x.orders}`).join(' · '))}
          ${kpi('Service · ' + esc(S.cfg.taxLabel), money(K.service_cents), `${money(K.tax_cents)} ${esc(S.cfg.taxLabel)} · ${money(K.tip_cents)} tips`)}
          ${kpi('Voids & refunds', money(K.voided_cents + K.refunds_cents), `${K.voided_items} items · ${K.voided_orders} orders voided · ${K.refunds_count} refunds`)}
        </div>
        ${d.days > 1 ? `<div class="rep-card"><h3>Sales by day</h3>${barChart(d.by_day.map((x) => ({ v: x.cents, label: x.day, tick: x.day.slice(8), extra: `${x.orders} orders` })), { label: 'Sales by day', tickEvery: d.days > 16 ? Math.ceil(d.days / 16) : 1 })}</div>` : ''}
        <div class="rep-card"><h3>Busy hours <small class="muted">by order start time</small></h3>${hours.length
          ? barChart(hours.map((h) => ({ v: h.cents, label: `${h.hour}:00–${h.hour + 1}:00`, tick: `${(h.hour % 12) || 12}${h.hour < 12 ? 'a' : 'p'}`, extra: `${h.orders} orders` })), { label: 'Sales by hour', height: 150 })
          : '<div class="muted">No sales in this period.</div>'}</div>
        <div class="rep-grid">
          <div class="rep-card"><h3>By category</h3>${meterTable(d.by_category, [{ h: 'Category', f: (r) => esc(r.category), meter: true }, { h: 'Qty', f: (r) => r.qty, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }])}</div>
          <div class="rep-card"><h3>Top 10 dishes</h3>${meterTable(d.top_items, [{ h: 'Dish', f: (r) => `${esc(r.name)}<div class="muted" style="font-size:12px">${esc(r.category)}</div>`, meter: true }, { h: 'Qty', f: (r) => r.qty, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }], 'qty')}</div>
          <div class="rep-card"><h3>Slowest dishes <small class="muted">on the menu</small></h3>${meterTable(d.slow_items, [{ h: 'Dish', f: (r) => `${esc(r.name)}<div class="muted" style="font-size:12px">${esc(r.category)}</div>` }, { h: 'Qty', f: (r) => r.qty, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }])}</div>
          <div class="rep-card"><h3>Order types</h3>${meterTable(d.by_type, [{ h: 'Type', f: (r) => TYPE(r.type), meter: true }, { h: 'Orders', f: (r) => r.orders, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }])}
            <h3 style="margin-top:22px">Payments</h3>${meterTable(d.by_payment, [{ h: 'Method', f: (r) => (r.method || '').toUpperCase(), meter: true }, { h: 'Taken', f: (r) => money(r.cents), right: true }, { h: 'Refunded', f: (r) => (r.refund_cents ? '−' + money(r.refund_cents) : '—'), right: true }, { h: 'Net', f: (r) => money(r.cents - r.refund_cents), right: true }])}</div>
          <div class="rep-card"><h3>Staff</h3>${meterTable(d.staff, [{ h: 'Name', f: (r) => `${esc(r.name)}<div class="muted" style="font-size:12px">${esc(r.role)}</div>`, meter: true }, { h: 'Orders', f: (r) => r.orders, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }, { h: 'Avg bill', f: (r) => money(r.avg_cents), right: true }, { h: 'Voids', f: (r) => r.voids, right: true }])}</div>
          <div class="rep-card"><h3>Tables</h3>${meterTable(d.tables, [{ h: 'Table', f: (r) => `${esc(r.code)} <span class="muted">${esc(r.area)}</span>`, meter: true }, { h: 'Turns', f: (r) => r.orders, right: true }, { h: 'Covers', f: (r) => r.covers, right: true }, { h: 'Avg time', f: (r) => `${r.avg_minutes} min`, right: true }, { h: 'Sales', f: (r) => money(r.cents), right: true }])}</div>
        </div>
        <div class="rep-card"><h3>Voided items</h3>${meterTable(d.voids, [{ h: 'Time', f: (r) => new Date(r.created_at).toLocaleString('en-GB', { timeZone: S.cfg.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) }, { h: 'Order', f: (r) => '#' + r.order_no }, { h: 'Item', f: (r) => `${r.qty} × ${esc(r.name)}` }, { h: 'Reason', f: (r) => esc(r.reason) }, { h: 'By', f: (r) => esc(r.staff_name || '') }, { h: 'Approved', f: (r) => esc(r.approved_name || '') }, { h: 'Value', f: (r) => money(r.amount_cents), right: true }], 'amount_cents')}</div>
        <div class="rep-card"><h3>Refunds</h3>${meterTable(d.refunds, [{ h: 'Time', f: (r) => new Date(r.created_at).toLocaleString('en-GB', { timeZone: S.cfg.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) }, { h: 'Order', f: (r) => '#' + r.order_no }, { h: 'Method', f: (r) => r.method }, { h: 'Reason', f: (r) => esc(r.reason) }, { h: 'By', f: (r) => esc(r.staff_name || '') }, { h: 'Approved', f: (r) => esc(r.approved_name || '') }, { h: 'Amount', f: (r) => money(r.amount_cents), right: true }], 'amount_cents')}</div>
      </div></section>`;
  }
  function reportCsv() {
    const d = S.rep.data; if (!d) return;
    const m = (c) => (c / 100).toFixed(2);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const out = [];
    const sec = (title, header, rows) => { out.push(q(title)); out.push(header.map(q).join(',')); rows.forEach((r) => out.push(r.map(q).join(','))); out.push(''); };
    const K = d.kpis;
    sec(`${S.cfg.restaurant} sales report ${d.from} to ${d.to}`, ['Measure', 'Value'], [
      ['Orders', K.orders], ['Gross sales', m(K.gross_cents)], ['Refunds', m(K.refunds_cents)], ['Net sales', m(K.net_cents)],
      ['Subtotal', m(K.subtotal_cents)], ['Discounts', m(K.discount_cents)], ['Service charge', m(K.service_cents)], [S.cfg.taxLabel, m(K.tax_cents)],
      ['Tips', m(K.tip_cents)], ['Average bill', m(K.avg_bill_cents)], ['Covers', K.covers], ['Voided items', K.voided_items], ['Voided value', m(K.voided_cents)], ['Voided orders', K.voided_orders]]);
    sec('Sales by day', ['Date', 'Orders', 'Sales'], d.by_day.map((x) => [x.day, x.orders, m(x.cents)]));
    sec('Sales by hour', ['Hour', 'Orders', 'Sales'], d.by_hour.map((x) => [`${x.hour}:00`, x.orders, m(x.cents)]));
    sec('By category', ['Category', 'Qty', 'Sales'], d.by_category.map((x) => [x.category, x.qty, m(x.cents)]));
    sec('Dishes sold', ['Dish', 'Category', 'Qty', 'Sales'], d.all_items.map((x) => [x.name, x.category, x.qty, m(x.cents)]));
    sec('Order types', ['Type', 'Orders', 'Sales'], d.by_type.map((x) => [TYPE_LABEL[x.type] || x.type, x.orders, m(x.cents)]));
    sec('Payments', ['Method', 'Orders', 'Taken', 'Refunded', 'Net'], d.by_payment.map((x) => [x.method, x.orders, m(x.cents), m(x.refund_cents), m(x.cents - x.refund_cents)]));
    sec('Staff', ['Name', 'Role', 'Orders', 'Sales', 'Avg bill', 'Tips', 'Voids'], d.staff.map((x) => [x.name, x.role, x.orders, m(x.cents), m(x.avg_cents), m(x.tip_cents), x.voids]));
    sec('Tables', ['Table', 'Area', 'Turns', 'Covers', 'Avg minutes', 'Sales'], d.tables.map((x) => [x.code, x.area, x.orders, x.covers, x.avg_minutes, m(x.cents)]));
    sec('Voided items', ['Time', 'Order', 'Item', 'Qty', 'Value', 'Reason', 'By', 'Approved by'], d.voids.map((x) => [x.created_at, x.order_no, x.name, x.qty, m(x.amount_cents), x.reason, x.staff_name, x.approved_name]));
    sec('Refunds', ['Time', 'Order', 'Method', 'Amount', 'Reason', 'By', 'Approved by'], d.refunds.map((x) => [x.created_at, x.order_no, x.method, m(x.amount_cents), x.reason, x.staff_name, x.approved_name]));
    const blob = new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `sales-${d.from}_to_${d.to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- admin: printers + audit ----------
  async function loadPrinting() { S.admin.printing = await api('/admin/printing'); }
  async function loadAudit() { S.admin.audit = (await api('/admin/audit?action=' + encodeURIComponent(S.admin.auditFilter || ''))).entries; }
  function printersList() {
    const P = S.admin.printing;
    if (!P) return '<div class="empty">Loading…</div>';
    const seen = P.bridge_seen ? (Date.now() - new Date(P.bridge_seen)) / 1000 : null;
    const online = seen !== null && seen < 60;
    const opts = (cur) => `<option value="">— None (print in browser) —</option>${P.printers.map((p) => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
    const origin = location.origin;
    return `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Admin</div><h1 class="title">Printers</h1>
        <div class="muted">Kitchen tickets, void slips, bills and Z reports print automatically through the print bridge.</div></div>
        <button type="button" class="btn dark" data-act="admin-new" data-kind="printer">+ Add printer</button></div>
      <div style="padding:0 28px 28px">
        <div class="bridge ${online ? 'on' : ''}"><div><b>Print bridge: ${online ? 'online' : 'offline'}</b>
          <div class="muted">${seen === null ? 'Never connected yet.' : online ? 'Connected and waiting for jobs.' : `Last seen ${new Date(P.bridge_seen).toLocaleString('en-GB', { timeZone: S.cfg.timezone })}.`}</div></div>
          <a class="btn" href="/bridge/print-bridge.js" download>Download print-bridge.js</a></div>
        <div class="field" style="margin-top:14px"><label>Run this on the PC next to the printers (needs Node.js 18 or newer):</label>
          ${P.bridge_token ? `<div class="cmd"><code id="bridge-cmd">node print-bridge.js --server ${esc(origin)} --token ${esc(P.bridge_token)}</code><button type="button" class="btn" data-act="copy-cmd">Copy</button></div>` : '<div class="muted">Create a bridge token first.</div>'}
          <button type="button" class="link-red" style="margin-top:8px" data-act="bridge-token">${P.bridge_token ? 'Regenerate token (the old one stops working)' : 'Create bridge token'}</button></div>
        <h3 style="margin:22px 0 8px">Printers</h3>
        <table class="htable"><thead><tr><th>Name</th><th>Connection</th><th>Address</th><th>Paper</th><th>Status</th><th></th></tr></thead><tbody>
          ${P.printers.map((p) => `<tr class="${S.admin.sel?.kind === 'printer' && S.admin.sel.id === p.id ? 'sel' : ''}" data-act="admin-sel" data-kind="printer" data-id="${p.id}">
            <td class="name"><b>${esc(p.name)}</b></td><td>${p.conn === 'network' ? 'Network' : 'Shared / USB'}</td><td><code>${esc(p.address)}</code></td>
            <td>${p.width_chars >= 42 ? '80 mm' : '58 mm'}</td><td><span class="s ${p.active ? 'paid' : 'void'}">${p.active ? 'Active' : 'Off'}</span></td>
            <td><button type="button" class="link-red" data-act="printer-test" data-id="${p.id}">Test print</button></td></tr>`).join('')
            || '<tr><td colspan="6" class="muted">No printers yet. Add one to start printing automatically.</td></tr>'}</tbody></table>
        <h3 style="margin:26px 0 8px">What prints where</h3>
        <form id="routing-form" class="routing">
          <div class="two">${field('Bills, receipts, refunds & Z reports', `<select name="bill_printer_id">${opts(P.bill_printer_id)}</select>`)}
            ${field('Kitchen tickets (default)', `<select name="kitchen_printer_id">${opts(P.kitchen_printer_id)}</select>`, 'Used for single tickets and stations without their own printer.')}</div>
          <div class="station-routing">${P.stations.map((s) => field(`${esc(s.name)} station`, `<select name="st_${s.id}">${opts(s.printer_id).replace('— None (print in browser) —', '— Use default kitchen printer —')}</select>`)).join('')}</div>
          <button type="submit" class="btn red" style="min-width:180px;text-align:center">Save routing</button>
        </form>
        <h3 style="margin:26px 0 8px">Recent print jobs</h3>
        <table class="htable"><thead><tr><th>Job</th><th>What</th><th>Printer</th><th>Status</th><th>Time</th><th></th></tr></thead><tbody>
          ${P.jobs.map((j) => `<tr><td>#${j.id}</td><td class="name">${esc(j.title)}${j.error ? `<div class="note-red">${esc(j.error)}</div>` : ''}</td><td>${esc(j.printer_name)}</td>
            <td><span class="s ${j.status === 'done' ? 'paid' : j.status === 'failed' ? 'ready' : 'void'}">${({ pending: 'Waiting', sent: 'Printing', done: 'Printed', failed: 'Failed' })[j.status]}</span></td>
            <td>${clock(j.created_at)}</td><td>${j.status === 'failed' || j.status === 'pending' ? `<button type="button" class="link-red" data-act="job-retry" data-id="${j.id}">Retry</button>` : ''}</td></tr>`).join('')
            || '<tr><td colspan="6" class="muted">No print jobs yet.</td></tr>'}</tbody></table>
      </div>`;
  }
  function printerForm() {
    const s = S.admin.sel; const P = S.admin.printing;
    const rec = (s.id && P.printers.find((p) => p.id === s.id)) || { name: '', conn: 'network', address: '', width_chars: 48, active: true };
    return `<form id="printer-form" autocomplete="off">
      <div class="hd"><div class="eyebrow">${s.id ? 'Edit' : 'New'} printer</div><h2>${esc(s.id ? rec.name : 'Add printer')}</h2></div>
      <div class="form-body">
        ${field('Name', inp('name', rec.name, 'required maxlength="40" placeholder="Kitchen XP80"'))}
        ${field('Connection', sel('conn', [['network', 'Network (LAN / Wi-Fi)'], ['share', 'Windows shared or USB device']], rec.conn))}
        ${field('Address', inp('address', rec.address, 'required maxlength="200" placeholder="192.168.1.50:9100"'), 'Network: IP:port (port 9100 by default). Windows shared printer: \\\\localhost\\XP80. Linux USB: /dev/usb/lp0')}
        ${field('Paper width', sel('width_chars', [[48, '80 mm (48 characters)'], [42, '80 mm, large font (42)'], [32, '58 mm (32 characters)']], rec.width_chars))}
        <div class="field">${check('active', rec.active, 'Printer is on')}</div>
      </div>
      <div class="form-foot">
        ${s.id ? '<button type="button" class="btn" data-act="printer-delete">Delete</button>' : '<span></span>'}
        <button type="button" class="btn" data-act="admin-cancel">Cancel</button>
        <button type="submit" class="btn red">Save</button></div></form>`;
  }
  const AUDIT_FILTERS = [['', 'Everything'], ['item.void', 'Item voids'], ['order.void', 'Order voids'], ['order.refund', 'Refunds'], ['order.discount', 'Discounts'], ['item.no_kot', 'Served without KOT'],
    ['bill.', 'Bills & reprints'], ['shift.', 'Shifts'], ['cash.', 'Cash in / out'], ['login', 'Sign-ins'], ['admin.', 'Admin changes']];
  function auditList() {
    const A = S.admin;
    if (!A.audit) return '<div class="empty">Loading…</div>';
    return `<div class="page-head" style="border-bottom:0"><div><div class="eyebrow">Admin</div><h1 class="title">Audit log</h1>
        <div class="muted">Every void, refund, discount, reprint, shift, cash movement, sign-in and admin change. Latest 300.</div></div>
        <select id="audit-filter" class="admin-select" style="width:220px">${AUDIT_FILTERS.map(([v, l]) => `<option value="${v}" ${v === (A.auditFilter || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="htable-wrap"><table class="htable"><thead><tr><th>Time</th><th>What</th><th>Details</th><th>By</th><th>Approved by</th></tr></thead><tbody>
        ${A.audit.map((e) => `<tr><td>${new Date(e.created_at).toLocaleString('en-GB', { timeZone: S.cfg.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}</td>
          <td><span class="s ${/void|refund|failed/.test(e.action) ? 'ready' : 'paid'}">${esc(e.action)}</span></td><td class="name">${esc(e.summary)}</td>
          <td>${esc(e.staff_name || '—')}</td><td>${esc(e.approved_name || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing logged yet.</td></tr>'}
      </tbody></table></div>`;
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
          <div class="msec"><div class="hd"><b>Kitchen ticket</b><small>${m.item.no_kot ? 'This dish is ready-made by default' : 'Untick if it is already cooked'}</small></div>
            <div class="chips"><button type="button" class="chip ${m.sendKot ? 'on' : ''}" data-act="opt-kot" data-v="1">Send to kitchen<small>Prints a KOT</small></button>
              <button type="button" class="chip ${!m.sendKot ? 'on' : ''}" data-act="opt-kot" data-v="0">Already prepared<small>Served now, no KOT</small></button></div></div>
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
    } else if (m.kind === 'form') {
      html = `<form class="modal ${m.wide ? 'wide' : ''}" id="modal-form" style="width:min(${m.wide ? 640 : 520}px,100%)" autocomplete="off">
        <div class="modal-head"><div><div class="eyebrow">${esc(m.eyebrow)}</div><h2 style="font-size:24px">${esc(m.title)}</h2></div></div>
        <div class="modal-body"><div class="msec form-modal" style="border-bottom:0">${m.html}</div></div>
        <div class="modal-foot"><div class="grow"></div><button type="button" class="btn" data-act="close-modal">Back</button>
          <button type="submit" class="btn red"><span>${esc(m.submit)}</span></button></div></form>`;
    } else if (m.kind === 'confirm') {
      html = `<div class="modal" style="width:min(460px,100%)"><div class="modal-head"><div><div class="eyebrow">Confirm</div><h2 style="font-size:24px">${esc(m.title)}</h2></div></div>
        <div class="modal-body"><div class="msec" style="border-bottom:0">${esc(m.text)}</div></div>
        <div class="modal-foot"><div class="grow"></div><button type="button" class="btn" data-act="close-modal">Back</button>
          <button type="button" class="btn red" data-act="confirm-yes"><span>${esc(m.yes)}</span></button></div></div>`;
    }
    modalEl.innerHTML = `<div class="overlay" data-act="overlay">${html}</div>`;
    if (m.kind === 'customer') setTimeout(() => $('#c-name')?.focus(), 30);
    if (m.kind === 'form') setTimeout(() => $('#modal-form input:not([type=hidden])')?.focus(), 30);
  }

  function kotGroups(mode, hold) {
    const pending = S.order.items.filter(isPending);
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
      ${o.items.filter((i) => eq(i) > 0).map((i) => r(`${eq(i)} x ${esc(i.name)}`, money(lineTotal(i)))).join('')}<hr>
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
    else if (S.tab === 'admin') view = adminView();
    else if (S.tab === 'shift') view = shiftView();
    else if (S.tab === 'reports') view = reportsView();
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
    if (tab === 'admin' && isManager()) await loadAdmin();
    if (tab === 'shift') await loadShift();
    if (tab === 'reports' && isManager()) await loadReport();
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
      S.modal = { kind: 'options', item, catName: cat.name, defCourse: cat.default_course, course: cat.default_course, spice: 'Standard', addons: new Set(), note: '', qty: 1, sendKot: !item.no_kot };
      renderModal();
    },
    'opt-spice': (d) => { S.modal.spice = d.v; keepNote(); renderModal(); },
    'opt-addon': (d) => { const id = +d.id; S.modal.addons.has(id) ? S.modal.addons.delete(id) : S.modal.addons.add(id); keepNote(); renderModal(); },
    'opt-course': (d) => { S.modal.course = d.v; keepNote(); renderModal(); },
    'opt-kot': (d) => { S.modal.sendKot = d.v === '1'; keepNote(); renderModal(); },
    'opt-qty': (d) => { S.modal.qty = Math.max(1, S.modal.qty + +d.d); keepNote(); renderModal(); },
    'opt-add': async () => {
      keepNote();
      const m = S.modal;
      S.order = await api(`/orders/${S.order.id}/items`, { body: { menu_item_id: m.item.id, qty: m.qty, spice: m.spice, addon_ids: [...m.addons], course: m.course, note: m.note.trim(), no_kot: !m.sendKot } });
      S.modal = null; render();
    },
    qty: async (d) => { S.order = await api('/items/' + d.id, { method: 'PATCH', body: { qty: +d.q } }); render(); },
    'no-kot': async (d) => {
      const i = S.order.items.find((x) => String(x.id) === d.id);
      S.order = await api('/items/' + d.id, { method: 'PATCH', body: { served_direct: true } });
      toast(`${i.qty} × ${i.name} served without a kitchen ticket`); render();
    },
    guests: async (d) => { S.order = await api('/orders/' + S.order.id, { method: 'PATCH', body: { guests: Math.max(1, S.order.guests + +d.d) } }); render(); },
    void: () => {
      const o = S.order;
      if (o.kots.length || o.items.some((i) => i.served_direct)) {
        return formModal({ eyebrow: 'Void order', title: `Void ${orderTitle(o)}?`, roles: ['Manager'], submit: 'Void order', reasons: VOID_REASONS,
          body: `<p class="muted" style="margin-top:0">Everything on this order is cancelled and the kitchen gets a VOID slip for tickets still cooking. ${money(o.total_cents)} will not be charged.</p>`,
          onSubmit: async (v) => {
            await api(`/orders/${o.id}/void`, { body: v });
            toast(`${orderTitle(o)} voided`); S.order = null; S.modal = null; S.tab = 'floor'; await loadFloor(); render();
          } });
      }
      S.modal = { kind: 'confirm', title: `Cancel ${orderTitle(S.order)}?`, text: 'Nothing has been sent to the kitchen. The order will be voided.', yes: 'Cancel order',
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
    'print-bill': async () => {
      S.order = await api(`/orders/${S.order.id}/print-bill`, { body: {} }); render();
      if (S.order.printed_to_printer) toast('Bill sent to the printer'); else printBill(S.order);
    },
    charge: () => {
      const o = S.order;
      const pending = o.items.filter(isPending).length;
      if (!S.shift?.shift) {
        S.modal = { kind: 'confirm', title: 'Open a shift first', text: 'Payments are recorded against the open shift so the cash drawer can be balanced at the end of the day.', yes: 'Go to Shift',
          run: async () => { S.modal = null; await setTab('shift'); } };
        return renderModal();
      }
      const doIt = async () => {
        const paid = await api(`/orders/${o.id}/pay`, { body: { payment_method: S.payMethod } });
        toast(`Paid ${money(paid.total_cents)} · ${orderTitle(paid)}`);
        S.order = null; S.modal = null; S.tab = 'floor'; await loadFloor(); render();
      };
      S.modal = { kind: 'confirm', title: `Charge ${money(o.total_cents)} by ${S.payMethod}?`,
        text: pending ? `${pending} item${pending > 1 ? 's have' : ' has'} not been sent yet. ${pending > 1 ? 'They' : 'It'} will be sent to the kitchen now and included in this bill.` : `This closes ${orderTitle(o)}${o.type === 'dinein' ? ' and frees the table' : ''}.`,
        yes: 'Charge', run: doIt };
      renderModal();
    },
    'hist-filter': (d) => { S.histFilter = d.v; render(); },
    'hist-sel': async (d) => { S.histSel = +d.id; S.histOrder = await api('/orders/' + d.id); render(); },
    'admin-section': async (d) => {
      resetImg(); S.admin.section = d.id; S.admin.sel = null;
      if (d.id === 'printers') await loadPrinting();
      if (d.id === 'audit') await loadAudit();
      render();
    },
    'admin-sel': (d) => { resetImg(); S.admin.sel = { kind: d.kind, id: +d.id }; render(); },
    'admin-img-remove': () => {
      resetImg(); S.admin.imgRemove = true;
      $('#img-box').innerHTML = imgPreview(null); $('#img-file').value = '';
    },
    'admin-new': (d) => {
      resetImg();
      S.admin.sel = { kind: d.kind, id: null }; render();
      if (d.area) { const a = $('#admin-form [name="area_id"]'); if (a) a.value = d.area; }
      $('#admin-form input')?.focus();
    },
    'admin-sample-menu': () => {
      S.modal = { kind: 'confirm', title: 'Load the Asian menu?',
        text: 'This replaces the current categories and dishes. Dishes that appear on past orders are kept but hidden, so history stays correct. You can edit everything afterwards.',
        yes: 'Load menu',
        run: async () => {
          S.modal = null; renderModal();
          const r = await api('/admin/sample-menu', { body: {} });
          S.cfg = await fetch('/api/config').then((x) => x.json());
          S.admin.section = 'items'; S.admin.cat = 'all';
          toast(`Loaded ${r.items} dishes in ${r.categories} categories`);
          await afterAdminChange(null);
        } };
      renderModal();
    },
    'admin-cancel': () => { resetImg(); S.admin.sel = null; render(); },
    'admin-addon-add': () => { $('#addons').insertAdjacentHTML('beforeend', addonRow()); $('#addons .addon-row:last-child input').focus(); },
    'admin-addon-del': (d, el) => el.closest('.addon-row').remove(),
    'admin-delete': () => {
      const s = S.admin.sel;
      S.modal = { kind: 'confirm', title: `Delete this ${ADMIN_NOUN[s.kind]}?`, text: 'This cannot be undone.', yes: 'Delete',
        run: async () => { S.modal = null; renderModal(); await api(`/admin/${ADMIN_PATH[s.kind]}/${s.id}`, { method: 'DELETE' }); toast('Deleted'); await afterAdminChange(null); } };
      renderModal();
    },
    'void-item': (d) => {
      const i = S.order.items.find((x) => String(x.id) === d.id);
      const left = eq(i);
      formModal({ eyebrow: 'Void item', title: `Void ${i.name}`, roles: ['Manager'], submit: 'Void', reasons: VOID_REASONS,
        body: `<p class="muted" style="margin-top:0">${i.served_direct ? 'Already served without a kitchen ticket.' : `Already sent on KOT #${i.kot_no}. The kitchen will get a VOID slip.`}</p>
          ${left > 1 ? `<label>How many to void (of ${left})</label><input name="qty" type="number" min="1" max="${left}" value="${left}" required>` : '<input type="hidden" name="qty" value="1">'}`,
        onSubmit: async (v) => { S.order = await api(`/items/${i.id}/void`, { body: v }); S.modal = null; toast(`Voided ${v.qty} × ${i.name}`); render(); } });
    },
    refund: (d) => {
      const o = S.histOrder;
      const left = o.total_cents - o.refunded_cents;
      formModal({ eyebrow: 'Refund', title: `Refund #${o.order_no}`, roles: ['Manager'], submit: 'Refund', reasons: REFUND_REASONS,
        body: `<p class="muted" style="margin-top:0">Paid ${money(o.total_cents)} by ${esc(o.payment_method)}${o.refunded_cents ? `, already refunded ${money(o.refunded_cents)}` : ''}. Up to ${money(left)} can be refunded.</p>
          <div class="two"><div><label>Amount</label><input name="amount" inputmode="decimal" value="${(left / 100).toFixed(2)}" required></div>
          <div><label>Refund as</label><select name="method">${['cash', 'card', 'wallet'].map((m) => `<option value="${m}" ${m === o.payment_method ? 'selected' : ''}>${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}</select></div></div>`,
        onSubmit: async (v) => {
          S.histOrder = await api(`/orders/${o.id}/refund`, { body: v }); S.modal = null;
          toast(`Refunded ${money(Math.round(v.amount * 100))}`); await loadHistory(); render();
        } });
    },
    reprint: async (d) => {
      const o = await api(`/orders/${d.id}/reprint`, { body: {} });
      if (o.printed_to_printer) toast('Sent to the bill printer'); else printBill(o);
    },
    'kot-reprint': async (d) => { await api(`/kots/${d.id}/reprint`, { body: {} }); toast('Ticket sent to the kitchen printer'); },
    'fill-reason': (d) => { const r = $('#modal-form [name="reason"]'); if (r) { r.value = d.v; r.focus(); } },
    'shift-sel': async (d) => { S.shiftSel = +d.id; S.shiftDetail = await api('/shifts/' + d.id); render(); },
    'shift-print': async (d) => {
      const r = await api(`/shifts/${d.id}/print`, { body: {} });
      if (r.printed_to_printer) toast('Report sent to the printer');
      else zReportPrint(+d.id === S.shift?.shift?.id ? S.shift : await api('/shifts/' + d.id));
    },
    'cash-move': (d) => {
      const isIn = d.kind === 'in';
      formModal({ eyebrow: 'Cash drawer', title: isIn ? 'Cash in' : 'Cash out (paid out)', roles: ['Manager', 'Cashier'], submit: isIn ? 'Add cash' : 'Take cash out', reasons: CASH_REASONS[d.kind],
        body: `<label>Amount</label><input name="amount" inputmode="decimal" placeholder="0.00" required><input type="hidden" name="kind" value="${d.kind}">`,
        onSubmit: async (v) => { S.shift = await api('/shift/cash', { body: v }); S.modal = null; toast(`Cash ${v.kind} ${money(Math.round(v.amount * 100))} recorded`); await loadShift(); render(); } });
    },
    'shift-close': () => {
      const cur = S.shift;
      formModal({ eyebrow: `Close shift #${cur.shift.id}`, title: `Expected in drawer: ${money(cur.expected_cents)}`, roles: ['Manager', 'Cashier'], submit: 'Close shift & print Z report', wide: true,
        body: `<label>Count the drawer <small class="muted">(optional helper: notes and coins)</small></label>
          <div class="denoms">${DENOMS.map((n) => `<label class="denom"><span>${n}</span><input data-denom="${n}" type="number" min="0" inputmode="numeric" placeholder="0"></label>`).join('')}</div>
          <div class="two" style="margin-top:12px"><div><label>Counted cash</label><input name="counted" id="counted" inputmode="decimal" placeholder="0.00" required></div>
          <div><label>Difference</label><div id="variance" class="variance muted">Enter the count</div></div></div>
          <label>Note (optional)</label><input name="note" maxlength="300" placeholder="e.g. short 100, coins given as change">`,
        onSubmit: async (v) => {
          const r = await api('/shift/close', { body: v });
          S.modal = null; S.shiftSel = r.shift.id;
          toast(r.printed_to_printer ? 'Shift closed. Z report sent to the printer.' : 'Shift closed');
          await loadFloor(); await loadShift(); render();
          if (!r.printed_to_printer) zReportPrint(r);
        } });
    },
    'rep-preset': async (d) => { S.rep.preset = d.v; if (d.v !== 'custom') { S.rep.data = null; render(); await loadReport(); } render(); },
    'rep-csv': () => reportCsv(),
    'rep-print': () => { document.body.classList.add('print-report'); window.print(); },
    'printer-test': async (d, el) => { await api(`/admin/printing/printers/${d.id}/test`, { body: {} }); toast('Test page queued'); await loadPrinting(); render(); },
    'printer-delete': () => {
      const s = S.admin.sel;
      S.modal = { kind: 'confirm', title: 'Delete this printer?', text: 'Stations using it will fall back to the default kitchen printer.', yes: 'Delete',
        run: async () => { S.modal = null; renderModal(); await api(`/admin/printing/printers/${s.id}`, { method: 'DELETE' }); S.admin.sel = null; await loadPrinting(); render(); } };
      renderModal();
    },
    'bridge-token': async () => {
      await api('/admin/printing/token', { body: {} }); await loadPrinting(); render(); toast('New bridge token created. Restart the bridge with the new command.');
    },
    'copy-cmd': async () => { try { await navigator.clipboard.writeText($('#bridge-cmd').textContent); toast('Command copied'); } catch { toast('Select the command and copy it', true); } },
    'job-retry': async (d) => { await api(`/admin/printing/jobs/${d.id}/retry`, { body: {} }); await loadPrinting(); render(); },
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
    if (fn) run(fn)(el.dataset, el);
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'admin-form') { e.preventDefault(); run(adminSave)(); }
    if (e.target.id === 'modal-form') {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      const btn = e.target.querySelector('[type=submit]'); btn.disabled = true;
      run(async () => { try { await S.modal.onSubmit(v); } finally { if (btn.isConnected) btn.disabled = false; } })();
    }
    if (e.target.id === 'shift-open-form') {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      run(async () => { await api('/shift/open', { body: v }); toast('Shift opened'); await loadFloor(); await loadShift(); render(); })();
    }
    if (e.target.id === 'printer-form') {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = { ...Object.fromEntries(f.entries()), active: f.has('active') };
      const s = S.admin.sel;
      run(async () => {
        const out = await api(`/admin/printing/printers${s.id ? '/' + s.id : ''}`, { method: s.id ? 'PATCH' : 'POST', body });
        toast(s.id ? 'Printer saved' : 'Printer added'); S.admin.sel = { kind: 'printer', id: s.id || out.id }; await loadPrinting(); render();
      })();
    }
    if (e.target.id === 'routing-form') {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target).entries());
      const stations = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('st_')).map(([k, v]) => [k.slice(3), v || null]));
      run(async () => {
        await api('/admin/printing/routing', { method: 'PATCH', body: { bill_printer_id: f.bill_printer_id || null, kitchen_printer_id: f.kitchen_printer_id || null, stations } });
        toast('Printer routing saved'); await loadPrinting(); render();
      })();
    }
    if (e.target.id === 'rep-range') {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target).entries());
      S.rep.from = f.from; S.rep.to = f.to;
      run(async () => { await loadReport(); render(); })();
    }
    if (e.target.id === 'settings-form') {
      e.preventDefault();
      run(async () => {
        await api('/admin/settings', { method: 'PATCH', body: Object.fromEntries(new FormData(e.target).entries()) });
        S.cfg = await fetch('/api/config').then((x) => x.json());
        toast('Settings saved');
        await afterAdminChange(null);
      })();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'audit-filter') { S.admin.auditFilter = e.target.value; run(async () => { await loadAudit(); render(); })(); }
    if (e.target.id === 'img-file' && e.target.files[0]) {
      run(async () => {
        const blob = await resizeImage(e.target.files[0]);
        resetImg();
        S.admin.img = { blob, url: URL.createObjectURL(blob) };
        $('#img-box').innerHTML = imgPreview(null);
      })();
    }
    if (e.target.id === 'admin-cat') { S.admin.cat = e.target.value; $('#admin-list').innerHTML = adminList(); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.dataset.denom !== undefined || e.target.id === 'counted') {
      if (e.target.dataset.denom !== undefined) {
        const sum = [...document.querySelectorAll('[data-denom]')].reduce((t, x) => t + (+x.dataset.denom) * (parseInt(x.value, 10) || 0), 0);
        $('#counted').value = sum ? sum.toFixed(2) : '';
      }
      const c = Math.round(parseFloat($('#counted').value || '') * 100);
      const vEl = $('#variance');
      if (!Number.isFinite(c)) { vEl.textContent = 'Enter the count'; vEl.className = 'variance muted'; }
      else {
        const v = c - S.shift.expected_cents;
        vEl.textContent = v === 0 ? 'Balanced' : `${v > 0 ? 'Over' : 'Short'} by ${money(Math.abs(v))}`;
        vEl.className = 'variance ' + (v === 0 ? 'ok' : 'bad');
      }
    }
    if (e.target.id === 'admin-q') {
      S.admin.q = e.target.value;
      const pos = e.target.selectionStart;
      $('#admin-list').innerHTML = adminList();
      const q = $('#admin-q'); q.focus(); q.setSelectionRange(pos, pos);
    }
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
  // chart hover tooltips
  document.addEventListener('mouseover', (e) => {
    const bar = e.target.closest('.bar');
    const chart = e.target.closest('.chart');
    if (!chart) return;
    const tip = chart.querySelector('.chart-tip');
    chart.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
    if (!bar) { tip.classList.add('hidden'); return; }
    bar.classList.add('hover');
    tip.textContent = bar.dataset.tip;
    const cr = chart.getBoundingClientRect(); const br = bar.getBoundingClientRect();
    tip.classList.remove('hidden');
    tip.style.left = `${Math.min(cr.width - tip.offsetWidth, Math.max(0, br.left - cr.left + br.width / 2 - tip.offsetWidth / 2))}px`;
  });
  document.addEventListener('mouseleave', (e) => { if (e.target.classList?.contains('chart')) e.target.querySelector('.chart-tip').classList.add('hidden'); }, true);
  window.addEventListener('afterprint', () => document.body.classList.remove('print-report'));
  document.addEventListener('keydown', (e) => {
    if (!S.user && /^[0-9]$/.test(e.key)) pinKey(e.key);
    else if (!S.user && e.key === 'Backspace') pinKey('back');
    else if (!S.user && e.key === 'Enter') pinKey('ok');
    else if (e.key === 'Escape' && S.modal) { S.modal = null; renderModal(); }
  });

  // tick: clock every 15s, full re-render each minute for ages (skip while a modal or input is active)
  setInterval(() => { const c = $('#clock'); if (c && S.cfg) c.textContent = clock(Date.now()); }, 15000);
  setInterval(() => { if (S.user && !S.modal && !['admin', 'reports', 'shift'].includes(S.tab) && document.activeElement?.tagName !== 'INPUT') render(); }, 60000);

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
