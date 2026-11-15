-- Store copilot weekly report (#550): the owners each report was delivered to, so a retry sends only to the rest.

ALTER TABLE "copilot_weekly_reports" ADD COLUMN "delivered_to" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
