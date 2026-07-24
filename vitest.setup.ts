// Loads .env so DB-backed tests (tests/db/**) see DATABASE_URL etc. without
// each test file wiring dotenv itself.
import "dotenv/config";
