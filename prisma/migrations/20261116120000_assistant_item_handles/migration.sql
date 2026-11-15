-- Short item handles (#597): the model passes i3, v12 or c2 instead of a long id; this
-- conversation's map from each handle to its id. Store-scoped through the row's RLS.
ALTER TABLE "ai_conversations" ADD COLUMN "item_handles" JSONB NOT NULL DEFAULT '{}';
