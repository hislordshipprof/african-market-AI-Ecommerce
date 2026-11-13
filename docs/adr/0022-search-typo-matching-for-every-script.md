# 22. Typo-tolerant search matches every script, whatever the database locale

Date: 2026-11-13 · Status: accepted (#493)

## Context

Catalog search ranks exact, prefix and full-text matches first, then catches typos with pg_trgm trigram similarity. pg_trgm keeps only the characters the database locale calls letters. The lane and CI databases use the C locale, so a Ge'ez name such as "ዶሮ ወጥ" gives no trigrams: `similarity('ዶሮ ወጥ', 'ዶሮ ወጥ')` is 0 and a one-character typo finds nothing. The same holds for Arabic, N'Ko or Tifinagh. Production's locale (Neon) was not probed; lanes never touch Neon. Full-text search still matches whole words in these scripts, so exact names and single words already worked.

Options compared in the lane database (PostgreSQL 18, C locale):

| Option | Ge'ez typo "ዶሮ ወፕ" vs "ዶሮ ወጥ" | Locale-independent | Latin unchanged |
|---|---|---|---|
| pg_trgm as is | 0 | no | yes |
| An ICU collation on the arguments | 0 (pg_trgm ignores the expression collation) | no | yes |
| A `simple` tsvector beside `english` | no match (whole words only, no typos) | yes | yes |
| `pg_c_utf8` collation with Unicode `[[:alnum:]]` | works | yes | yes, but needs PostgreSQL 17+ on Neon, which is unverified |
| Own trigram functions, pg_trgm kept for ASCII | 0.5 | yes | yes |

## Decision

Search uses five SQL functions from migration `20261113130000_search_similarity`, and no query calls pg_trgm directly:

- `search_words(t)` splits words on ASCII spaces and punctuation only. Every other character counts as a letter, so no list of scripts is needed and the locale is never consulted.
- `search_similarity(a, b)` and `search_word_similarity(q, doc)` mean the same as pg_trgm's `similarity` and `strict_word_similarity`. When both strings are pure ASCII they call pg_trgm, so Latin relevance is exactly what it was. Otherwise they build pg_trgm's padded word trigrams from `search_words`.
- `search_word_similarity` is bounded so its cost grows linearly with the name. It reads only the first 64 words of the name. A run of words starts and ends on a word that shares a trigram with the query, and spans at most one word more than the query has, with the query's word count capped at 8. An unbounded search over every run took minutes on a 2,000-word name.

Storefront search, the assistant's `search_catalog` (which calls the storefront search), copilot listing search and the assistant's ingredient lookup all call these functions.

Evidence (lane database, 2026-11-13): with the ASCII branch switched off, the own trigram path equals pg_trgm on all 5,340 pairs of 534 ASCII catalog names and 10 queries, for both functions. "ዶሮ ወጥ" scores 1 against itself and 0.5 against the typo "ዶሮ ወፕ". With the bounds, the forced own path differs from pg_trgm on 15 of 13,884 ASCII pairs (548 names, as bare names and with three pack labels, × 13 queries), by at most 0.007 and only at scores below 0.08, so no pair crosses the 0.3 typo threshold.

Cost, measured on 548 names with three pack labels (the storefront's name-plus-labels shape), running both word similarities and `search_similarity` on each row: a Ge'ez query takes 54–90 ms, about 100–160 µs a row. A worst-case 2,000-word name whose every word matches costs about 3 ms a row. ASCII rows are slower than raw pg_trgm, 17 ms against 4 ms for the same 548 rows, because these SQL functions are not inlined and test each row for ASCII.

## Consequences

- A name that mixes scripts, or a non-ASCII Latin name the copilot does not pass through `unaccent`, is now scored the way a UTF-8 locale would score it, on every database.
- Non-ASCII punctuation (the Ethiopic wordspace "፡", curly quotes) counts as part of a word. Typed names use spaces, so this costs little.
- `lower()` still follows the locale outside ASCII. Ge'ez, Arabic, N'Ko and Tifinagh have no case, so it does not matter for them. It does matter for capitalised accented Latin in the copilot, which does not apply `unaccent`: under the C locale `search_similarity('ÉPICE', 'épice')` is 0.33, where pg_trgm gave 1 by dropping both letters. The match still clears the 0.3 threshold; only its rank moves.
- A one-character typo in a two-character Ge'ez word, such as "ዶሬ" for "ዶሮ", finds nothing. Storefront typo matching needs a query of three or more characters, and the pair scores only 0.2. Ge'ez is a syllabary, so many words are two characters long; closing this gap needs a different rule for short syllabic words and is left for a follow-up.
- Full-text search still uses the `english` configuration. For other scripts that means exact words, which the trigram match now backs up.
- Once Neon is confirmed on PostgreSQL 17+, `search_words` could split on `[[:alnum:]]` under `pg_c_utf8` instead, keeping the same callers.
