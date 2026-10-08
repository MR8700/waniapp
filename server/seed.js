import { openDb } from './db.js';
import { uid, sha, rand } from './util.js';
import { randomBytes } from 'node:crypto';

export function seed(db, now = Date.now()) {
  const est = uid(), r = (sql, ...a) => db.prepare(sql).run(...a);
  r('INSERT INTO establishments VALUES(?,?,?,?)', est, 'WANI — Bar, Grillades & Buvette', 'ACTIVE', now);
  const zones = { 'Jardin Paillote': ['J01', 'J02', 'J04'], 'Salle climatisée': ['S01', 'S02'], 'Salon VIP': ['VIP01', 'VIP02'] }, tokens = {};
  let s = 0;
  for (const [name, codes] of Object.entries(zones)) {
    const z = uid(); r('INSERT INTO zones VALUES(?,?,?,?)', z, est, name, s++);
    for (const c of codes) {
      const p = uid(), t = rand(16);
      r('INSERT INTO reception_points VALUES(?,?,?,?,?,1)', p, est, z, c, 'Table ' + c);
      r('INSERT INTO qr_tokens VALUES(?,?,1,NULL,?)', t, p, now);
      tokens[c] = t;
    }
  }
  const cat = {};
  ['Boissons', 'Grillades', 'Accompagnements', 'Plats', 'Desserts', 'Autres'].forEach((n, i) => {
    cat[n] = uid();
    r('INSERT INTO categories VALUES(?,?,?,?)', cat[n], est, n, i);
  });

  const P = [
    ['Brakina', 'Boissons', 700, 'https://lh3.googleusercontent.com/aida-public/AB6AXuD5XK1epN3gkCUVJmEBAatgH9sbH88diTIrdSn6dLkSINMnAbKWVpwASVQeBE5vyYFhR34P87oU1i6IznJuN6Zs3wWxufNwEnJS0yd6U9huClUuKhWAFolWd-1u9uWcAipmvVJXhw7Y3FbbO15H7nm77mdv7QJF78bGBaCc7OMg72GJ5xRKH4Q7UF90w-BuksL1nVQzkwgMyx_RK082uS5u-wHD2gK1vMouMbiCkfY', 'brakina,biere brakina,biere', 1, 'Bouteille 65cl bien givrée au décapsuleur'],
    ['Flag Spéciale', 'Boissons', 1000, 'https://lh3.googleusercontent.com/aida-public/AB6AXuDgKjYZ_f8V6LgzC2A9yEPqVKjNU2wvLygwOaIQYT4RFu9VJICQZki-3ayRdF_GP_WAo3h_HMjd4lN3YfyFpC7pZjHm-95FDXgN1JE9GB5kV5X_FTGD-uo3gR1tPX34rDidJrzP80ukE0uiWqoSpbz0ij3q3ICrmf9mMT83RjtEn6bw45JPK0r3dz_snXB7xv0XdGR7GdjV4bGrJR-DwTP7A8waKCITHJg-4KZgORU', 'flag,flag speciale', 1, 'Grande bouteille 65cl servie glacée'],
    ['Jus de Bissap', 'Boissons', 500, 'https://lh3.googleusercontent.com/aida-public/AB6AXuCTUdyPj1hIvEQa9L_GYcTuez8J3nWDIyODzqYVhjZ399kgNCw7diKOmSqw_GJw5T-7GHUCmU60ARrmtasVSqfc4qSjNbzkmYYTlX2KTl08BoJk5WvYFUMCX7Xo7bU7bS93kCbp2HH5fakvg5yJBZNNrZ8T6DCdUzqGYTcj8nJ_wZHmZM3-l6cI2F2B5I3UUNuyBImLeFYUxSRCfnnjo4q-5y7-lW80kKHdfCjeQuI', 'bissap,jus de bissap,jus', 1, 'Bouteille 50cl fraîcheur maison & glaçons'],
    ['Guinness Extra Stout', 'Boissons', 1200, 'https://lh3.googleusercontent.com/aida-public/AB6AXuC5wEYbAxzV1yb0Z7VXNwkEkdawJEeAu3GN2aYe5djkaQgkmvFJJcTpo8zajKD16tCr7lbpKWmi8Ws1BgjC8o2EjF9dFUgrK3laEy7hjkBXSA-N2Hx1yMYdGfcz5-EruVNklVaVDJnU4s3ucxhIim8CEYGtW-omRkVs2FCzo0gdo1JDbSWZqyQ5324AfjWsi2yaN7o8PrLlGGf62Wzku0moODnigUoURC9RXDmNX_4', 'guinness,stout', 1, 'Format 33cl servi très frais'],
    ['Soda', 'Boissons', 500, null, 'coca,fanta,sucrerie', 1, 'Canette 33cl bien fraîche au choix'],
    ['Eau minérale', 'Boissons', 300, null, 'eau,eau minerale', 1, 'Bouteille 1.5L capsulée'],
    ['Poulet bicyclette', 'Grillades', 3500, 'https://lh3.googleusercontent.com/aida-public/AB6AXuCfvwWiq5ZhZ7_GQzDtY5q-l6R57Tkg04zQY_ZHRYvTHjb1juLEcx09xp97eZ-MeEV5q8AY6ImcJb3l1xXoG2hiV328g_0_XtcH_8nqLIlvvjs9mVt_7Sl6WB21BHm1Yk6dy7wJJD5T8vm9Gy_IM9nTkFAj7LrgGmlN9pnVi7McR2DFnI7qby5D_WdSludakeV3iiYGCeUu3QScslrbMfI9e-AjFAMwBhx_V4ntUWE', 'poulet,poulet bicyclette', 0, 'Grillé entier au charbon, assaisonné kankan & oignons'],
    ['Brochettes de bœuf', 'Grillades', 1500, null, 'brochettes,brochette', 0, 'Portion de 5 brochettes marinées braisées'],
    ['Alloco', 'Accompagnements', 1000, 'https://lh3.googleusercontent.com/aida-public/AB6AXuB5cJMdSLQmx7Ys1OYLvx-QpIWZm3psQX_YI68zxIRl75yHh1p7OR5Jpagns-5NMnZquy25o1DqphcBUUKuZnon2wFosVlQrldStjB4_OZw1a-yTnmfIli8BmInAp9MD4kHSVapfrTpplLTbQr2hqvmHrn6KovGl_D98WU7yg0Z0szU7dcfMk7RLmW1ERj7VbvGNmwHdnG5eMDp-L3DWd9qumaFeItMvESi0mh9VD4', 'banane,alloco,aloco', 0, 'Bananes plantains frites croustillantes piment doux'],
    ['Riz sauce', 'Plats', 1500, null, 'riz', 0, 'Riz blanc local avec sauce tomate ou arachide'],
    ['Salade de fruits', 'Desserts', 800, null, 'fruits', 0, 'Coupe de mangue, papaye et ananas frais']
  ];

  for (const [n, c, price, img, al, track, desc] of P) {
    const id = uid();
    r('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)', id, est, cat[c], n, desc || '', price, img || null, al, track, 'ACTIVE', now, now);
    if (track) r('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?)', uid(), id, 'INITIAL', 100, 'seed', null, now);
  }

  const code = randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-');
  r('INSERT INTO invites VALUES(?,?,NULL,?,?,?,1)', sha(code), 'ROLE', est, 'MANAGER', now + 86400e3);
  return { est, tokens, managerInvite: code };
}

if (process.argv[1]?.endsWith('seed.js')) {
  const db = openDb(process.env.DB || './data/app.db');
  const s = seed(db);
  console.log('Code gérant (24h, usage unique):', s.managerInvite);
  console.log('QR tokens:', s.tokens);
}
