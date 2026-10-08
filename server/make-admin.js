import { openDb } from './db.js';
const db = openDb(process.env.DB || './data/app.db');
const r = db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(process.argv[2]);
console.log(r.changes ? 'admin ok' : 'utilisateur introuvable');
