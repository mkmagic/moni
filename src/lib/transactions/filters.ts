// Filter vocabulary shared by the transactions page's server read and its
// client-side toolbar.
//
// This lives in `lib`, not in `src/domain/transactions.ts`, for a hard reason:
// a client component that imports a *value* from the domain layer pulls
// `src/db/client.ts` — and therefore `pg` — into the browser bundle, which
// fails the build on `dns`/`net`/`tls`. Types are erased and safe to import
// from the domain layer; runtime constants are not.

/** `EntryFilters.categoryId` value meaning "entries with no category at all".
 * A real category id is a UUID, so this can never collide with one, and it
 * survives a round-trip through the page's `?category=` search param. */
export const NO_CATEGORY = "none";
