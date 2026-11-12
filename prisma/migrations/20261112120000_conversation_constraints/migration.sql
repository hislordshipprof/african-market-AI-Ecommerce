-- Shopper constraints (#485): allergens, dietary claims and ingredients saved for the conversation.
ALTER TABLE "ai_conversations" ADD COLUMN "constraints" JSONB NOT NULL DEFAULT '{}';
