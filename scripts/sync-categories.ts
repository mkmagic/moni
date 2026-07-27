// Brings every existing user's category tree up to date with the shipped
// default set (src/lib/categorization/default-categories.ts).
//
// WHY THIS EXISTS: categories are seeded per user at signup, so adding one to
// the shipped set reaches only accounts created afterwards — leaving every
// existing user with a built-in rule pointing at a key they don't have. Run
// this after upgrading whenever default-categories.ts gained an entry.
//
// It needs no password: categories are plaintext Tier-2 labels, so this can
// run for all users without anyone's data key. It is additive and idempotent
// — a category the user renamed keeps its name, because `builtin_key` is the
// identity, not the name.
//
// What it does NOT do: re-categorize entries that already have a category.
// If a shipped rule was retargeted (as the card-settlement one was, from
// Credit Card Fees to Credit Card Payment), entries categorized under the old
// answer keep it, and have to be corrected in the UI.
import "dotenv/config";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { syncDefaultCategories } from "@/domain/categorization";

async function main(): Promise<void> {
  // The one place a query runs outside a per-user scope: enumerating users is
  // not user-owned data. Everything after this goes through the domain layer,
  // which sets `app.user_id` per user.
  const rows = await db.select({ id: users.id, email: users.email }).from(users);

  let total = 0;
  for (const user of rows) {
    const added = await syncDefaultCategories(user.id);
    total += added;
    console.log(`${user.email}: ${added === 0 ? "already up to date" : `+${added} categories`}`);
  }
  console.log(`\nDone. ${rows.length} users, ${total} categories added.`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
