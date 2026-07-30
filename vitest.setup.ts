// Loads .env so DB-backed tests (tests/db/**) see DATABASE_URL etc. without
// each test file wiring dotenv itself.
import "dotenv/config";
import { ensureTestDatabase, TEST_APP_DATABASE_URL } from "./tests/db/setup-test-db";

// DB tests (tests/db/**) must run against the isolated `moni_test` database,
// never the shared dev `moni` database another process may be reseeding
// concurrently (see tests/db/setup-test-db.ts). `src/db/client.ts` builds
// its connection pool from `DATABASE_URL` at module-load time, and vitest
// runs this setup file before a test file's own imports, so overriding it
// here — before anything imports src/db/client.ts — is what makes every
// `withUser()` call in the suite land on moni_test as the `moni_app` role.
process.env.DATABASE_URL = TEST_APP_DATABASE_URL;

// src/lib/auth/webauthn-config.ts throws the first time a passkey route
// *uses* these (not at import — a route module that threw on import would
// break `next build`), deliberately, so a real deployment can never mint
// passkeys against a guessed RP ID. Give the suite the localhost defaults
// unless the developer's own .env already says otherwise. Config only: no
// test here fakes an authenticator.
process.env.MONI_WEBAUTHN_RP_ID ??= "localhost";
process.env.MONI_WEBAUTHN_ORIGIN ??= "http://localhost:3000";

await ensureTestDatabase();
