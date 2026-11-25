-- How the invite last reached its invitee (#839): the admin sees whether the email went out or the link was copied.
ALTER TABLE "store_invites" ADD COLUMN "email_status" TEXT;
ALTER TABLE "store_invites"
    ADD CONSTRAINT "store_invites_email_status_check" CHECK (email_status IN ('sent', 'failed', 'copied'));
