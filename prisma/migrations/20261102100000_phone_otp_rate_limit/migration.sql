-- CreateTable
CREATE TABLE "phone_otp_sends" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_otp_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "phone_otp_sends_phone_sent_at_idx" ON "phone_otp_sends"("phone", "sent_at");
