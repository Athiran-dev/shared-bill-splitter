-- Homes, members, bills and shares. Money is stored as whole cents.
-- Members, bills and shares use an AUTOINCREMENT "seq" so insertion order is kept exactly.

CREATE TABLE homes (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  CONSTRAINT chk_homes_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE TABLE members (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT NOT NULL,
  home_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  CONSTRAINT uq_members_id UNIQUE (id),
  CONSTRAINT chk_members_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT fk_members_home FOREIGN KEY (home_id) REFERENCES homes (id)
);
CREATE INDEX idx_members_home ON members (home_id, seq);

CREATE TABLE bills (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL,
  home_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  CONSTRAINT uq_bills_id UNIQUE (id),
  -- Stops zero, negative and fractional totals.
  CONSTRAINT chk_bills_total_positive_int
    CHECK (typeof(total_cents) = 'integer' AND total_cents > 0),
  CONSTRAINT chk_bills_title_not_blank CHECK (length(trim(title)) > 0),
  CONSTRAINT fk_bills_home FOREIGN KEY (home_id) REFERENCES homes (id)
);
CREATE INDEX idx_bills_home ON bills (home_id, seq);

CREATE TABLE shares (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL,
  bill_id         TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  paid_at         TEXT,
  idempotency_key TEXT,
  CONSTRAINT uq_shares_id UNIQUE (id),
  -- A member has at most one share per bill.
  CONSTRAINT uq_shares_bill_member UNIQUE (bill_id, member_id),
  CONSTRAINT chk_shares_amount_non_negative
    CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  -- A share is either unpaid (no time, no key) or paid (both set).
  CONSTRAINT chk_shares_paid_consistent
    CHECK ((paid_at IS NULL) = (idempotency_key IS NULL)),
  CONSTRAINT fk_shares_bill FOREIGN KEY (bill_id) REFERENCES bills (id),
  CONSTRAINT fk_shares_member FOREIGN KEY (member_id) REFERENCES members (id)
);
CREATE INDEX idx_shares_bill ON shares (bill_id, seq);
CREATE INDEX idx_shares_member ON shares (member_id);
