'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === '0' ? false : { rejectUnauthorized: false },
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => console.error('pg pool error', err.message));

async function query(text, params) {
  return pool.query(text, params);
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id   BIGINT PRIMARY KEY,
      coins         INTEGER NOT NULL DEFAULT 120,
      ton_balance   BIGINT  NOT NULL DEFAULT 0,
      data          JSONB   NOT NULL DEFAULT '{}'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS seen_txs (
      hash          TEXT PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id            BIGSERIAL PRIMARY KEY,
      telegram_id   BIGINT NOT NULL,
      dest          TEXT NOT NULL,
      amount        BIGINT NOT NULL,
      fee           BIGINT NOT NULL,
      net           BIGINT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wd_uid ON withdrawals(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals(status);

    CREATE TABLE IF NOT EXISTS unmatched (
      id            BIGSERIAL PRIMARY KEY,
      hash          TEXT,
      value         BIGINT,
      comment       TEXT,
      source        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS referrals (
      invited       BIGINT PRIMARY KEY,
      referrer      BIGINT NOT NULL,
      reward        BIGINT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer);

    CREATE TABLE IF NOT EXISTS daily_bonus (
      day           DATE PRIMARY KEY,
      spent         BIGINT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS wheel_spins (
      day           DATE NOT NULL,
      telegram_id   BIGINT NOT NULL,
      PRIMARY KEY (day, telegram_id)
    );

    CREATE TABLE IF NOT EXISTS daily_convert (
      day           DATE PRIMARY KEY,
      spent_nano    BIGINT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS user_convert (
      day           DATE NOT NULL,
      telegram_id   BIGINT NOT NULL,
      coins         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, telegram_id)
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key           TEXT PRIMARY KEY,
      value         JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  // ensure mode row
  await query(`
    INSERT INTO app_state (key, value) VALUES ('mode', '{"mode":"on"}'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `);
  console.log('DB schema ready');
}

module.exports = { pool, query, withClient, initSchema };
