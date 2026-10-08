import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,display_name TEXT,is_admin INTEGER DEFAULT 0,status TEXT DEFAULT 'ACTIVE',created_at INTEGER);
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),public_key TEXT UNIQUE NOT NULL,device_name TEXT,platform TEXT,status TEXT NOT NULL DEFAULT 'ACTIVE',created_at INTEGER,last_seen_at INTEGER,revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_dev_user ON devices(user_id);
CREATE TABLE IF NOT EXISTS device_challenges(nonce TEXT PRIMARY KEY,device_id TEXT NOT NULL,expires_at INTEGER,used_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT,device_id TEXT,refresh_hash TEXT UNIQUE,prev_refresh_hash TEXT,expires_at INTEGER,revoked_at INTEGER,created_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_sess_dev ON sessions(device_id);
CREATE TABLE IF NOT EXISTS invites(code_hash TEXT PRIMARY KEY,kind TEXT,user_id TEXT,establishment_id TEXT,role TEXT,expires_at INTEGER,uses_left INTEGER);
CREATE TABLE IF NOT EXISTS recovery_requests(id TEXT PRIMARY KEY,public_key TEXT,device_name TEXT,platform TEXT,claimed_name TEXT,status TEXT DEFAULT 'PENDING',user_id TEXT,device_id TEXT,decided_by TEXT,created_at INTEGER);
CREATE TABLE IF NOT EXISTS establishments(id TEXT PRIMARY KEY,name TEXT,status TEXT DEFAULT 'ACTIVE',created_at INTEGER);
CREATE TABLE IF NOT EXISTS establishment_members(user_id TEXT,establishment_id TEXT,role TEXT NOT NULL,PRIMARY KEY(user_id,establishment_id));
CREATE TABLE IF NOT EXISTS zones(id TEXT PRIMARY KEY,establishment_id TEXT,name TEXT,sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS reception_points(id TEXT PRIMARY KEY,establishment_id TEXT,zone_id TEXT,code TEXT,label TEXT,active INTEGER DEFAULT 1,UNIQUE(establishment_id,code));
CREATE TABLE IF NOT EXISTS qr_tokens(token TEXT PRIMARY KEY,reception_point_id TEXT,active INTEGER DEFAULT 1,expires_at INTEGER,created_at INTEGER);
CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY,establishment_id TEXT,name TEXT,sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,establishment_id TEXT,category_id TEXT,name TEXT,description TEXT,price INTEGER NOT NULL,image TEXT,aliases TEXT DEFAULT '',available INTEGER DEFAULT 1,stock_tracking INTEGER DEFAULT 0,status TEXT DEFAULT 'ACTIVE',created_at INTEGER,updated_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_prod_est ON products(establishment_id);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,establishment_id TEXT,user_id TEXT,device_id TEXT,reception_point_id TEXT,status TEXT,payment_status TEXT DEFAULT 'UNPAID',payment_method TEXT,total INTEGER,note TEXT,voice_message_id TEXT,created_at INTEGER,updated_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_ord_est ON orders(establishment_id,status);CREATE INDEX IF NOT EXISTS ix_ord_user ON orders(user_id);
CREATE TABLE IF NOT EXISTS order_items(id TEXT PRIMARY KEY,order_id TEXT,product_id TEXT,name TEXT,unit_price INTEGER,quantity INTEGER,total INTEGER,note TEXT);
CREATE INDEX IF NOT EXISTS ix_oi_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS order_status_history(id TEXT PRIMARY KEY,order_id TEXT,previous_status TEXT,new_status TEXT,actor_id TEXT,device_id TEXT,created_at INTEGER);
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,order_id TEXT,method TEXT,amount INTEGER,status TEXT,actor_id TEXT,created_at INTEGER);
CREATE TABLE IF NOT EXISTS stock_movements(id TEXT PRIMARY KEY,product_id TEXT,type TEXT,quantity INTEGER,reason TEXT,actor_id TEXT,created_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_sm_prod ON stock_movements(product_id);
CREATE TABLE IF NOT EXISTS voice_messages(id TEXT PRIMARY KEY,establishment_id TEXT,user_id TEXT,order_id TEXT,audio_path TEXT,duration REAL,language TEXT,transcription TEXT,confidence REAL,created_at INTEGER);
CREATE TABLE IF NOT EXISTS idempotency_keys(key TEXT,user_id TEXT,order_id TEXT,PRIMARY KEY(key,user_id));
CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT,establishment_id TEXT,order_id TEXT,type TEXT,message TEXT,created_at INTEGER,read_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_notif ON notifications(user_id,created_at);
CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY,actor_id TEXT,device_id TEXT,action TEXT,resource_type TEXT,resource_id TEXT,metadata TEXT,ip TEXT,created_at INTEGER);
`;

export function openDb(path = ':memory:') {
  if (path !== ':memory:') {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {}
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  return db;
}

export const tx = (db, fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};
