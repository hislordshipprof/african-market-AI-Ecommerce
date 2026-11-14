-- A recipe key is never empty (#25). Rows an empty key let in were lookups that could never be found.
DELETE FROM "recipes" WHERE "key" = '';
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_key_not_empty" CHECK ("key" <> '');
