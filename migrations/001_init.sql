CREATE TABLE IF NOT EXISTS submissions (
  id         serial PRIMARY KEY,
  student    text NOT NULL,
  score      integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submissions_leaderboard_idx
  ON submissions (score DESC, created_at ASC);
