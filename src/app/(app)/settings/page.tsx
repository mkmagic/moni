import { redirect } from "next/navigation";

/** /settings has no content of its own — Profile is the first tab. */
export default function SettingsIndexPage() {
  redirect("/settings/profile");
}
