import type { ReactNode } from "react";
import { SettingsTabs } from "./settings-tabs";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">Your profile and linked institutions</p>
      </div>
      <SettingsTabs />
      {children}
    </div>
  );
}
