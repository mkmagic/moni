export function syncTimeLabel(date: Date): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jerusalem",
  }).format(date);
  return `Last synced ${formatted} (Israel time)`;
}
