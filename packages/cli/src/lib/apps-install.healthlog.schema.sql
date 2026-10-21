-- Health Log: xyz.tinycloud.sample.healthlog
-- One SQLite database, `healthlog`, in the user's `applications` space.
-- Every statement is idempotent (IF NOT EXISTS) so the app can re-run this file.
-- Comments next to tables, views and columns become the knowledge bundle's descriptions
-- (node scripts/okf.mjs generate), so keep them true.

-- One row per logged meal, with calories and macros. Every write carries a client-generated op_id (UNIQUE): replaying an operation never creates a second row.
CREATE TABLE IF NOT EXISTS meal (
  id        INTEGER PRIMARY KEY AUTOINCREMENT, -- Row id.
  op_id     TEXT    NOT NULL UNIQUE, -- Client-generated operation id; the idempotency key.
  day       TEXT    NOT NULL CHECK (day = date(day)), -- The user's local calendar date, YYYY-MM-DD (not the UTC date).
  slot      TEXT    NOT NULL CHECK (slot IN ('breakfast', 'lunch', 'dinner', 'snack')), -- Which meal of the day.
  name      TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 200), -- What was eaten, 1 to 200 characters.
  kcal      INTEGER NOT NULL CHECK (kcal BETWEEN 0 AND 5000), -- Calories, a whole number from 0 to 5000.
  protein_g REAL    NOT NULL DEFAULT 0 CHECK (protein_g >= 0), -- Protein in grams.
  carbs_g   REAL    NOT NULL DEFAULT 0 CHECK (carbs_g >= 0), -- Carbohydrate in grams.
  fat_g     REAL    NOT NULL DEFAULT 0 CHECK (fat_g >= 0), -- Fat in grams.
  note      TEXT, -- Optional free text.
  source    TEXT    NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'agent', 'import')), -- Who wrote the row. Agents write 'agent'.
  logged_at TEXT    NOT NULL -- ISO 8601 UTC instant of the write.
);

CREATE INDEX IF NOT EXISTS idx_meal_day ON meal(day);

-- One row per logged body weight. Several per day are allowed; day_card shows the latest. Same op_id protocol as meal.
CREATE TABLE IF NOT EXISTS weight (
  id        INTEGER PRIMARY KEY AUTOINCREMENT, -- Row id.
  op_id     TEXT    NOT NULL UNIQUE, -- Client-generated operation id; the idempotency key.
  day       TEXT    NOT NULL CHECK (day = date(day)), -- The user's local calendar date, YYYY-MM-DD (not the UTC date).
  weight_kg REAL    NOT NULL CHECK (weight_kg BETWEEN 20 AND 500), -- Body weight in kilograms, 20 to 500.
  note      TEXT, -- Optional free text.
  source    TEXT    NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'agent', 'import')), -- Who wrote the row. Agents write 'agent'.
  logged_at TEXT    NOT NULL -- ISO 8601 UTC instant of the write.
);

CREATE INDEX IF NOT EXISTS idx_weight_day ON weight(day);

-- Per-day totals of meals plus the latest weight, one row per day that has a meal or a weight. Read only. The app's today card is SELECT * FROM day_card WHERE day = ?; no row means an empty day.
CREATE VIEW IF NOT EXISTS day_card AS
SELECT
  d.day AS day,
  COALESCE((SELECT SUM(m.kcal)      FROM meal m WHERE m.day = d.day), 0) AS kcal,
  COALESCE((SELECT SUM(m.protein_g) FROM meal m WHERE m.day = d.day), 0) AS protein_g,
  COALESCE((SELECT SUM(m.carbs_g)   FROM meal m WHERE m.day = d.day), 0) AS carbs_g,
  COALESCE((SELECT SUM(m.fat_g)     FROM meal m WHERE m.day = d.day), 0) AS fat_g,
  (SELECT COUNT(*) FROM meal m WHERE m.day = d.day) AS meals,
  (SELECT w.weight_kg FROM weight w WHERE w.day = d.day
     ORDER BY w.logged_at DESC, w.id DESC LIMIT 1) AS weight_kg
FROM (SELECT day FROM meal UNION SELECT day FROM weight) AS d;

-- day_card plus trailing 7-day averages (kcal_avg7, weight_avg7), averaged over days that have data. Read only. A view cannot know today's date: query it with WHERE day BETWEEN ? AND ? ORDER BY day. Days without data have no row.
CREATE VIEW IF NOT EXISTS week_rollup AS
SELECT
  c.day AS day,
  c.kcal AS kcal,
  c.protein_g AS protein_g,
  c.carbs_g AS carbs_g,
  c.fat_g AS fat_g,
  c.meals AS meals,
  c.weight_kg AS weight_kg,
  (SELECT ROUND(AVG(p.kcal), 0) FROM day_card p
     WHERE p.meals > 0 AND p.day BETWEEN date(c.day, '-6 days') AND c.day) AS kcal_avg7,
  (SELECT ROUND(AVG(p.weight_kg), 2) FROM day_card p
     WHERE p.weight_kg IS NOT NULL AND p.day BETWEEN date(c.day, '-6 days') AND c.day) AS weight_avg7
FROM day_card c;
