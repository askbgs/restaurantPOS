// Demo data matching the Ember & Bao design. Prices are in cents (LKR by default).
module.exports = async function seed(pool, hashPin) {
  const q = (sql, params) => pool.query(sql, params);

  const staff = [
    ['Ravi K.', 'RK', 'Captain', '1234'],
    ['Manager', 'MG', 'Manager', '0000'],
    ['Kitchen', 'KT', 'Kitchen', '1111'],
  ];
  for (const [name, initials, role, pin] of staff) {
    await q('INSERT INTO staff(name, initials, role, pin_hash) VALUES ($1,$2,$3,$4)', [name, initials, role, hashPin(pin)]);
  }

  const areas = [['Main hall', 'Main hall', 1], ['Patio', 'Patio', 2], ['Bar counter', 'Bar', 3]];
  const areaIds = [];
  for (const a of areas) {
    const { rows } = await q('INSERT INTO areas(name, short, sort) VALUES ($1,$2,$3) RETURNING id', a);
    areaIds.push(rows[0].id);
  }
  const tables = [
    ['T1', 0, 2], ['T2', 0, 2], ['T3', 0, 4], ['T4', 0, 4], ['T5', 0, 4], ['T6', 0, 6], ['T7', 0, 6], ['T8', 0, 8],
    ['P1', 1, 2], ['P2', 1, 2], ['P3', 1, 4], ['P4', 1, 4],
    ['B1', 2, 1], ['B2', 2, 1], ['B3', 2, 2], ['B4', 2, 2],
  ];
  let s = 0;
  for (const [code, ai, seats] of tables) {
    await q('INSERT INTO dining_tables(code, area_id, seats, sort) VALUES ($1,$2,$3,$4)', [code, areaIds[ai], seats, s++]);
  }

  const stations = [['WOK', 'Wok', 'Wok printer'], ['STEAM', 'Steam', 'Steam printer'], ['GRILL', 'Grill', 'Grill printer'],
    ['COLD', 'Cold', 'Cold printer'], ['BAR', 'Bar', 'Bar printer']];
  const st = {};
  s = 0;
  for (const [code, name, printer] of stations) {
    const { rows } = await q('INSERT INTO stations(code, name, printer, sort) VALUES ($1,$2,$3,$4) RETURNING id', [code, name, printer, s++]);
    st[code] = rows[0].id;
  }

  // [category, course, items: [name, price(major units), station, tags, spice, addons]]
  const SAUCE = [['Extra sauce', 300], ['Side of rice', 600]];
  const menu = [
    ['Small Plates', 'starter', [
      ['Sea Salt Edamame', 1200, 'COLD', ['Cold', 'Veg'], false, []],
      ['Crispy Chilli Cauliflower', 1800, 'WOK', ['Wok', 'Veg'], true, SAUCE],
      ['Korean Fried Wings', 2400, 'GRILL', ['Grill'], true, SAUCE],
      ['Tuna Tataki', 2800, 'COLD', ['Cold'], false, []],
      ['Salt & Pepper Squid', 2200, 'WOK', ['Wok'], true, SAUCE],
    ]],
    ['Dim Sum', 'starter', [
      ['Har Gow (4)', 1800, 'STEAM', ['Steam'], false, []],
      ['Pork Siu Mai (4)', 1600, 'STEAM', ['Steam'], false, []],
      ['Veg Crystal Dumplings', 1500, 'STEAM', ['Steam', 'Veg'], false, []],
      ['Char Siu Bao (3)', 1700, 'STEAM', ['Steam'], false, []],
    ]],
    ['Noodles', 'main', [
      ['Pad Kee Mao', 2600, 'WOK', ['Wok'], true, SAUCE],
      ['Ramen Set › Tonkotsu', 3200, 'WOK', ['Wok'], false, [['Extra egg', 300], ['Extra chashu', 700]]],
      ['Dan Dan Noodles', 2400, 'WOK', ['Wok'], true, []],
      ['Singapore Noodles', 2400, 'WOK', ['Wok'], true, []],
    ]],
    ['Rice & Bowls', 'main', [
      ['Thai Green Curry', 3400, 'WOK', ['Wok'], true, SAUCE],
      ['Chicken Katsu Curry', 3400, 'GRILL', ['Grill'], false, SAUCE],
      ['Kimchi Fried Rice', 2600, 'WOK', ['Wok'], true, [['Fried egg', 300]]],
      ['Stone Pot Bibimbap', 3200, 'GRILL', ['Grill'], true, []],
    ]],
    ['Robata Grill', 'main', [
      ['Gochujang Short Rib', 5200, 'GRILL', ['Grill'], true, []],
      ['Miso Black Cod', 5600, 'GRILL', ['Grill'], false, []],
      ['Chicken Yakitori (3)', 2200, 'GRILL', ['Grill'], false, []],
    ]],
    ['Combos', 'main', [
      ['Lunch Bento', 3800, 'GRILL', ['Grill'], false, []],
      ['Dim Sum Platter', 4200, 'STEAM', ['Steam'], false, []],
      ['Noodle + Bao Set', 3600, 'WOK', ['Wok'], true, []],
    ]],
    ['Desserts', 'dessert', [
      ['Matcha Tiramisu', 1800, 'COLD', ['Cold'], false, []],
      ['Mango Sago', 1400, 'COLD', ['Cold', 'Veg'], false, []],
      ['Black Sesame Ice Cream', 1200, 'COLD', ['Cold', 'Veg'], false, []],
    ]],
    ['Drinks', 'drink', [
      ['Jasmine Iced Tea', 1000, 'BAR', ['Bar'], false, []],
      ['Lychee Martini', 2800, 'BAR', ['Bar'], false, []],
      ['Yuzu Soda', 900, 'BAR', ['Bar'], false, []],
      ['Thai Milk Tea', 1100, 'BAR', ['Bar'], false, []],
    ]],
  ];
  let cs = 0;
  for (const [cname, course, items] of menu) {
    const { rows } = await q('INSERT INTO categories(name, default_course, sort) VALUES ($1,$2,$3) RETURNING id', [cname, course, cs++]);
    const cid = rows[0].id;
    let is = 0;
    for (const [name, price, station, tags, spice, addons] of items) {
      const r = await q(
        'INSERT INTO menu_items(category_id, station_id, name, price_cents, tags, has_spice, sort) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [cid, st[station], name, price * 100, tags.concat(spice ? ['Spice level'] : []), spice, is++]);
      for (const [an, ap] of addons) {
        await q('INSERT INTO item_addons(item_id, name, price_cents) VALUES ($1,$2,$3)', [r.rows[0].id, an, ap * 100]);
      }
    }
  }
};
