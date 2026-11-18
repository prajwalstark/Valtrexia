-- Email channels keep their recipients in `config`, where owners can see and
-- change them; they have nothing secret to encrypt. Webhook channels still
-- must have their encrypted destination.
ALTER TABLE "notification_channels" ALTER COLUMN "secret_enc" DROP NOT NULL;

ALTER TABLE notification_channels
  ADD CONSTRAINT notification_channels_secret_check
    CHECK ((type = 'webhook') = (secret_enc IS NOT NULL));
