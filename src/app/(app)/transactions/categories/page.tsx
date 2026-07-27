import { requireSession } from "@/domain/auth";
import { requireOnboarded } from "@/domain/onboarding";
import { listCategoryTree } from "@/domain/categorization";
import { CategoriesManager } from "@/components/categories-manager";

export default async function CategoriesPage() {
  const session = await requireSession();
  await requireOnboarded(session.userId);
  const groups = await listCategoryTree(session);

  return <CategoriesManager groups={groups} />;
}
