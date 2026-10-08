const NUM = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };
const MOD = new Set(['pimente', 'pimentee', 'pimentes', 'fraiche', 'fraiches', 'frais', 'glace', 'glacee', 'glacees', 'bien', 'sans', 'sucre', 'chaud', 'chaude', 'tres']);
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

const sim = (a, b) => a === b ? 1 : (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1) ? 0.75 : 0;

// Interprète une transcription vocale FR : extrait les lignes de produits, quantités, modificateurs et confiance
export function interpret(text, products = []) {
  const toks = norm(text), used = new Array(toks.length).fill(false), items = [];
  const keys = (products || []).flatMap(p => [p.name, ...String(p.aliases || '').split(',').filter(Boolean)].map(k => ({ p, k: norm(k) }))).filter(x => x.k.length).sort((a, b) => b.k.length - a.k.length);

  for (const { p, k } of keys) {
    for (let i = 0; i + k.length <= toks.length; i++) {
      if (used.slice(i, i + k.length).some(Boolean)) continue;
      const s = k.map((w, j) => sim(w, toks[i + j]));
      if (s.some(x => !x)) continue;
      let qty = 1, st = i;
      for (let b = i - 1; b >= Math.max(0, i - 3); b--) {
        const n = /^\d+$/.test(toks[b]) ? +toks[b] : NUM[toks[b]];
        if (n) { qty = Math.min(n, 99); st = b; break; }
      }
      const mods = [];
      let e = i + k.length;
      while (e < toks.length && (MOD.has(toks[e]) || toks[e] === 'de')) {
        if (MOD.has(toks[e])) mods.push(toks[e]);
        e++;
      }
      for (let x = st; x < e; x++) used[x] = true;
      const existing = items.find(it => it.product_id === p.id && it.note === mods.join(' '));
      if (existing) existing.quantity += qty;
      else items.push({ product_id: p.id, name: p.name, quantity: qty, note: mods.join(' '), confidence: Math.min(...s) === 1 ? 0.95 : 0.7 });
    }
  }

  const rest = toks.filter((t, i) => !used[i] && !['et', 'je', 'veux', 'voudrais', 'svp', 'sil', 'vous', 'plait', 'pour', 'moi', 'avec', 'a', 'de', 'des', 'du', 'la', 'le', 'les', 'bonjour', 'donnez', 'donne', 'prends', 'prendre'].includes(t) && !NUM[t] && !/^\d+$/.test(t));
  const confidence = items.length ? +(Math.min(...items.map(i => i.confidence)) * (rest.length ? 0.8 : 1)).toFixed(2) : 0;
  return { items, unmatched: rest.join(' '), confidence, requires_confirmation: true };
}
