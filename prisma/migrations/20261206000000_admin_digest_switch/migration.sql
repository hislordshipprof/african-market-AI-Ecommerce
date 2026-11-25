-- The platform admin's daily digest email (#834): on by default, switched off in AI and onboarding settings.
ALTER TABLE "platform_settings" ADD COLUMN "admin_digest_enabled" BOOLEAN NOT NULL DEFAULT true;
