-- Tenders read by the tender engine (Tender to Bid): the full reading with its page evidence,
-- shared by the team so a tender read once can be opened again. seed_key marks built-in reads.
CREATE TABLE IF NOT EXISTS tender_reads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed_key      text UNIQUE,
  file_name     text NOT NULL,
  title         text NOT NULL DEFAULT '',
  issuer        text NOT NULL DEFAULT '',
  tender_number text NOT NULL DEFAULT '',
  tender_type   text NOT NULL DEFAULT '',
  capacity_mw   double precision,
  mode          text NOT NULL DEFAULT 'rules',
  sha256        text,
  pages         integer,
  found         integer,
  fields        integer,
  result        jsonb NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tender_reads_created_idx ON tender_reads (created_at DESC);
