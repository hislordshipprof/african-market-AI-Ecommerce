-- Insert a well-known system user for automated actions (auto-cancel, acceptance alerts).
-- This user's ID is referenced by src/lib/system-actor.ts.
INSERT INTO "users" ("id", "name", "email", "email_verified", "role", "created_at", "updated_at")
VALUES (
  'system_00000000000000000000000',
  'System',
  'system@platform.internal',
  true,
  'system',
  NOW(),
  NOW()
)
ON CONFLICT ("id") DO NOTHING;
