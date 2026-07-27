import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { listCategories, listRules } from "@/domain/categorization";
import { RulesTable } from "@/components/rules-table";

export default async function RulesPage() {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const [rules, categories] = await Promise.all([listRules(session), listCategories(session)]);

  return <RulesTable rules={rules} categories={categories} />;
}
