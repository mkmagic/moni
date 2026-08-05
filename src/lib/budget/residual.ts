// The residual ("everything else") ceiling's vocabulary.
//
// Lives in `lib` rather than `@/domain/budget` so client components can
// import it without dragging the domain layer — and `pg` — into the browser
// bundle. A type would be safe to import from the domain (types are erased);
// these are runtime values, and they are not. See `src/lib/recurring/range.ts`,
// which exists for the same reason.

/**
 * The key the residual ceiling occupies wherever ceilings are keyed by
 * category id — the in-force map in the domain layer, the React key and the
 * `<select>` value in the budget screen, and the DELETE route's path segment.
 *
 * Deliberately not a uuid, so it can never collide with a real category, and
 * deliberately not `null`: a map keyed by `string | null` makes every lookup
 * a nullable one for the sake of a single row. In the **database** it is
 * `category_id IS NULL` — this constant never reaches a column.
 */
export const RESIDUAL_KEY = "everything-else";

/** What the residual row is called wherever it is shown. */
export const RESIDUAL_NAME = "Everything else";
