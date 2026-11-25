-- The plan an applicant says they want on /sell (#838). Interest only: it charges and binds no one; the owner
-- still chooses and pays on the plan page. Null on applications sent before the question existed.
ALTER TABLE "store_applications" ADD COLUMN "plan_choice" TEXT;
ALTER TABLE "store_applications"
    ADD CONSTRAINT "store_applications_plan_choice_check" CHECK ("plan_choice" IN ('starter', 'pro', 'undecided'));

-- An approved store reads its own application, so the plan page can preselect the plan its applicant chose.
CREATE POLICY store_applications_own_store ON "store_applications"
  FOR SELECT TO app_user
  USING ("store_id" = current_setting('app.store_id', true));
