-- Typo-tolerant catalog matching for every script (#493, ADR-0022).
-- pg_trgm keeps only the letters the database locale knows: under the C locale (lanes, CI)
-- Ge'ez or Arabic names give no trigrams and score 0. These functions keep pg_trgm for
-- pure-ASCII text, so Latin relevance is unchanged, and otherwise build pg_trgm's padded
-- word trigrams themselves, splitting words only on ASCII separators so no locale is consulted.

-- The words of t in order, split on ASCII spaces and punctuation only; every other character is a letter.
CREATE OR REPLACE FUNCTION search_words(t text) RETURNS TABLE (n bigint, w text)
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT s.n, s.w
  FROM regexp_split_to_table(t, '[\x01-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+') WITH ORDINALITY AS s(w, n)
  WHERE s.w <> ''
$$;

-- Each word's trigrams, with the word's position: '  w', ' wo', 'wor', 'ord', 'rd '.
CREATE OR REPLACE FUNCTION search_word_trigrams(t text) RETURNS TABLE (n bigint, tri text)
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT s.n, substr(p.padded, i, 3)
  FROM search_words(lower(t)) s
  CROSS JOIN LATERAL (SELECT '  ' || s.w || ' ' AS padded) p
  CROSS JOIN LATERAL generate_series(1, length(p.padded) - 2) AS i
$$;

CREATE OR REPLACE FUNCTION search_trigrams(t text) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT tri), '{}'::text[]) FROM search_word_trigrams(t)
$$;

-- Same meaning as pg_trgm similarity(a, b).
CREATE OR REPLACE FUNCTION search_similarity(a text, b text) RETURNS real
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN a || b ~ '^[\x01-\x7f]*$' THEN similarity(a, b) ELSE (
    SELECT coalesce(count(*) FILTER (WHERE x.ta AND x.tb)::real / nullif(count(*), 0), 0)
    FROM (
      SELECT bool_or(side = 'a') AS ta, bool_or(side = 'b') AS tb
      FROM (SELECT 'a' AS side, tri FROM search_word_trigrams(a) UNION ALL SELECT 'b', tri FROM search_word_trigrams(b)) u
      GROUP BY tri
    ) x
  ) END
$$;

-- Same meaning as pg_trgm strict_word_similarity(q, doc): the best match of q against a run of whole words of doc.
-- Bounded so the cost stays linear (review of #493): only the first 64 words of doc count, a run starts
-- and ends on a word that shares a trigram with q (an unmatched edge word can only lower the score), and
-- a run spans at most one word more than q has, with q's word count capped at 8.
CREATE OR REPLACE FUNCTION search_word_similarity(q text, doc text) RETURNS real
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN q || doc ~ '^[\x01-\x7f]*$' THEN strict_word_similarity(q, doc) ELSE (
    WITH qt AS (SELECT search_trigrams(q) AS t, least((SELECT count(*) FROM search_words(q)), 8) AS words),
      dw AS (SELECT n, tri FROM search_word_trigrams(doc) WHERE n <= 64),
      hit AS (SELECT DISTINCT dw.n FROM dw, qt WHERE dw.tri = ANY (qt.t)),
      spans AS (
        SELECT count(DISTINCT dw.tri) AS total, count(DISTINCT dw.tri) FILTER (WHERE dw.tri = ANY (qt.t)) AS common
        FROM qt
        JOIN hit a ON true
        JOIN hit b ON b.n BETWEEN a.n AND a.n + qt.words
        JOIN dw ON dw.n BETWEEN a.n AND b.n
        GROUP BY a.n, b.n
      )
    SELECT coalesce(max(spans.common::real / (cardinality(qt.t) + spans.total - spans.common)), 0)
    FROM spans, qt
  ) END
$$;
