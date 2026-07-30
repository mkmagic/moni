-- The login password must never be able to unwrap the credential key
-- (issue #7, requirement from #18). 0012 made the column nullable and the
-- code stopped writing it, but a database carried over from before this
-- change still holds password-wrapped CK ciphertext at rest — which is the
-- exact thing the change exists to remove. Drop it, so the invariant holds
-- in the data and not only in the code.
--
-- Nothing is lost that the code could still use: no code path reads
-- wrapped_credential_key from a password method any more.
UPDATE "user_unlock_methods" SET "wrapped_credential_key" = NULL WHERE "type" = 'password-argon2id';
