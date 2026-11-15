-- Cleanup runs on every rate-limit take; without this it scans the whole table.
CREATE INDEX "app_rate_limits_window_start_idx" ON "app_rate_limits"("window_start");
