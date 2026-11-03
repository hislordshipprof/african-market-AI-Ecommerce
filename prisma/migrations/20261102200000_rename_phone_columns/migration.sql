-- Rename columns to match Better Auth phoneNumber plugin expectations
ALTER TABLE "users" RENAME COLUMN "phone" TO "phone_number";
ALTER TABLE "users" RENAME COLUMN "phone_verified" TO "phone_number_verified";
