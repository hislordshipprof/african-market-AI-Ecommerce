-- When Vercel last reported the store's custom domain verified; null until then (#711).
ALTER TABLE "stores" ADD COLUMN "custom_domain_verified_at" TIMESTAMP(3);
