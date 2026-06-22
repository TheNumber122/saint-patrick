-- ============================================================
-- TELEGRAM BOT FARM — COMPLETE SUPABASE SCHEMA
-- Single source of truth. Run on a fresh database.
-- Sections:
--   1. accounts table
--   2. accounts indexes
--   3. auto-update trigger
--   4. claim_due_accounts  (atomic claiming)
--   5. increment_error     (record helpers)
--   6. record_click
--   7. record_daily
--   8. balances table + view
-- ============================================================


-- ============================================================
-- 1. ACCOUNTS TABLE
-- ============================================================
CREATE TABLE accounts (
  id                BIGSERIAL PRIMARY KEY,
  instance_id       INTEGER NOT NULL CHECK (instance_id BETWEEN 1 AND 12),
  user_id           BIGINT NOT NULL,
  phone             VARCHAR(20),
  session_string    TEXT NOT NULL,
  is_active         BOOLEAN DEFAULT true,
  next_clicker_time TIMESTAMPTZ,
  next_daily_time   TIMESTAMPTZ,
  next_leave_time   TIMESTAMPTZ DEFAULT NULL,
  last_error        TEXT,
  error_count       INTEGER DEFAULT 0,
  total_clicks      INTEGER DEFAULT 0,
  total_dailies     INTEGER DEFAULT 0,
  last_click_at     TIMESTAMPTZ,
  last_daily_at     TIMESTAMPTZ,
  cap               INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN accounts.cap IS
  'Click counter that resets on cap limit; triggers a longer delay when reached.';
COMMENT ON COLUMN accounts.next_leave_time IS
  'When to next leave all broadcast channels. NULL = this account never participates in channel cleanup.';


-- ============================================================
-- 2. ACCOUNTS INDEXES
-- ============================================================
CREATE INDEX idx_accounts_instance_id     ON accounts(instance_id);
CREATE INDEX idx_accounts_instance_active ON accounts(instance_id, is_active)  WHERE is_active = true;
CREATE INDEX idx_accounts_next_clicker    ON accounts(next_clicker_time)        WHERE is_active = true;
CREATE INDEX idx_accounts_next_daily      ON accounts(next_daily_time)          WHERE is_active = true;
CREATE INDEX idx_accounts_next_leave      ON accounts(next_leave_time)          WHERE is_active = true;


-- ============================================================
-- 3. AUTO-UPDATE TIMESTAMP TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- 4. ATOMIC ACCOUNT CLAIMING
--
-- Locks due accounts with FOR UPDATE SKIP LOCKED, bumps
-- next_clicker_time and next_daily_time before returning them,
-- preventing race conditions across multiple instances.
--
-- next_leave_time is intentionally NOT bumped here; the
-- application updates it after leaveChannels() completes.
--
-- Returns both the post-bump column values AND the original
-- pre-bump times (original_*_time) so callers know which
-- task(s) were actually due.
-- ============================================================
CREATE OR REPLACE FUNCTION claim_due_accounts(
  p_instance_id       INTEGER,
  p_now               TIMESTAMPTZ,
  p_clicker_delay_min INTEGER,
  p_clicker_delay_max INTEGER,
  p_daily_delay       INTEGER
)
RETURNS TABLE (
  id                    BIGINT,
  instance_id           INTEGER,
  user_id               BIGINT,
  phone                 VARCHAR,
  session_string        TEXT,
  is_active             BOOLEAN,
  next_clicker_time     TIMESTAMPTZ,
  next_daily_time       TIMESTAMPTZ,
  next_leave_time       TIMESTAMPTZ,
  last_error            TEXT,
  error_count           INTEGER,
  total_clicks          INTEGER,
  total_dailies         INTEGER,
  last_click_at         TIMESTAMPTZ,
  last_daily_at         TIMESTAMPTZ,
  cap                   INTEGER,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ,
  original_clicker_time TIMESTAMPTZ,
  original_daily_time   TIMESTAMPTZ,
  original_leave_time   TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT
      a.id,
      a.instance_id,
      a.user_id,
      a.phone,
      a.session_string,
      a.is_active,
      a.next_clicker_time AS original_clicker,
      a.next_daily_time   AS original_daily,
      a.next_leave_time   AS original_leave,
      a.last_error,
      a.error_count,
      a.total_clicks,
      a.total_dailies,
      a.last_click_at,
      a.last_daily_at,
      a.cap,
      a.created_at,
      a.updated_at
    FROM accounts a
    WHERE
      a.instance_id = p_instance_id
      AND a.is_active = true
      AND (
        a.next_clicker_time <= p_now
        OR a.next_daily_time <= p_now
        OR (a.next_leave_time IS NOT NULL AND a.next_leave_time <= p_now)
      )
    FOR UPDATE SKIP LOCKED
  )
  UPDATE accounts
  SET
    next_clicker_time = CASE
      WHEN accounts.next_clicker_time <= p_now
      THEN p_now + ((p_clicker_delay_min + random() * p_clicker_delay_max) || ' minutes')::INTERVAL
      ELSE accounts.next_clicker_time
    END,
    next_daily_time = CASE
      WHEN accounts.next_daily_time <= p_now
      THEN p_now + (p_daily_delay || ' minutes')::INTERVAL
      ELSE accounts.next_daily_time
    END
    -- next_leave_time is updated by the application after leaveChannels() completes
  FROM claimed
  WHERE accounts.id = claimed.id
  RETURNING
    accounts.id,
    accounts.instance_id,
    accounts.user_id,
    accounts.phone,
    accounts.session_string,
    accounts.is_active,
    claimed.original_clicker AS next_clicker_time,
    claimed.original_daily   AS next_daily_time,
    claimed.original_leave   AS next_leave_time,
    accounts.last_error,
    accounts.error_count,
    accounts.total_clicks,
    accounts.total_dailies,
    accounts.last_click_at,
    accounts.last_daily_at,
    accounts.cap,
    accounts.created_at,
    accounts.updated_at,
    claimed.original_clicker AS original_clicker_time,
    claimed.original_daily   AS original_daily_time,
    claimed.original_leave   AS original_leave_time;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_due_accounts TO anon, authenticated, service_role;


-- ============================================================
-- 5. ATOMIC RECORD HELPER — increment_error
--
-- Increments error_count and sets last_error.
-- Disables the account when error_count reaches 3.
-- Returns the new error_count so the caller can log correctly.
-- ============================================================
CREATE OR REPLACE FUNCTION increment_error(
  p_user_id BIGINT,
  p_error   TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE accounts
  SET
    error_count = error_count + 1,
    last_error  = p_error,
    is_active   = CASE WHEN error_count + 1 >= 3 THEN false ELSE is_active END
  WHERE user_id = p_user_id
  RETURNING error_count INTO v_new_count;

  RETURN v_new_count;
END;
$$;

GRANT EXECUTE ON FUNCTION increment_error TO anon, authenticated, service_role;


-- ============================================================
-- 6. ATOMIC RECORD HELPER — record_click
--
-- Increments total_clicks and cap.
-- When cap + 1 hits p_cap_limit: resets cap to 0 and schedules
-- the long cap-delay next click time.
-- Otherwise: increments cap and uses the normal next click time.
-- Clears error state on success.
-- Returns new cap value (0 = just reset, >0 = running count).
-- ============================================================
CREATE OR REPLACE FUNCTION record_click(
  p_user_id           BIGINT,
  p_cap_limit         INTEGER,
  p_next_clicker_cap  TIMESTAMPTZ,   -- long delay used when cap resets
  p_next_clicker_norm TIMESTAMPTZ    -- normal delay for every other click
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_new_cap INTEGER;
BEGIN
  UPDATE accounts
  SET
    total_clicks      = total_clicks + 1,
    cap               = CASE WHEN cap + 1 >= p_cap_limit THEN 0           ELSE cap + 1            END,
    next_clicker_time = CASE WHEN cap + 1 >= p_cap_limit THEN p_next_clicker_cap ELSE p_next_clicker_norm END,
    last_click_at     = NOW(),
    error_count       = 0,
    last_error        = NULL
  WHERE user_id = p_user_id
  RETURNING cap INTO v_new_cap;

  RETURN v_new_cap;
END;
$$;

GRANT EXECUTE ON FUNCTION record_click TO anon, authenticated, service_role;


-- ============================================================
-- 7. ATOMIC RECORD HELPER — record_daily
--
-- Increments total_dailies, sets next_daily_time, clears errors.
-- ============================================================
CREATE OR REPLACE FUNCTION record_daily(
  p_user_id         BIGINT,
  p_next_daily_time TIMESTAMPTZ
)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounts
  SET
    total_dailies   = total_dailies + 1,
    next_daily_time = p_next_daily_time,
    last_daily_at   = NOW(),
    error_count     = 0,
    last_error      = NULL
  WHERE user_id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_daily TO anon, authenticated, service_role;


-- ============================================================
-- 8. BALANCES TABLE + VIEW
--
-- Per-account balance snapshots gathered by the balance-checker.
-- One row inserted per check run per account.
-- ============================================================
CREATE TABLE balances (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  phone       VARCHAR(20),
  instance_id INTEGER,
  stars       NUMERIC(10, 2) NOT NULL DEFAULT 0,
  referrals   INTEGER        NOT NULL DEFAULT 0,
  checked_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE balances IS
  'Per-account balance snapshots. One row per check run per account.';
COMMENT ON COLUMN balances.stars IS
  'Star balance extracted from bot profile (💰 Баланс: X ⭐️)';
COMMENT ON COLUMN balances.referrals IS
  'Activated referral count (✅ Активировали бота: X)';

CREATE INDEX idx_balances_user_id    ON balances(user_id);
CREATE INDEX idx_balances_checked_at ON balances(checked_at DESC);
CREATE INDEX idx_balances_instance   ON balances(instance_id);

-- Latest balance per user_id (used by the dashboard)
CREATE OR REPLACE VIEW latest_balances AS
SELECT DISTINCT ON (user_id)
  id, user_id, phone, instance_id, stars, referrals, checked_at
FROM balances
ORDER BY user_id, checked_at DESC;

GRANT SELECT ON latest_balances      TO anon, authenticated, service_role;
GRANT INSERT ON balances             TO service_role;
GRANT USAGE  ON SEQUENCE balances_id_seq TO service_role;


-- ============================================================
-- OPTIONAL — Enable leave-channels for all existing accounts.
-- Spreads next_leave_time randomly across the next 24–48 h.
-- Run separately, only once, when you're ready to activate.
-- ============================================================
-- UPDATE accounts
-- SET next_leave_time = NOW() + (
--   INTERVAL '1440 minutes' +
--   (random() * 1440)::INTEGER * INTERVAL '1 minute'
-- )
-- WHERE next_leave_time IS NULL;