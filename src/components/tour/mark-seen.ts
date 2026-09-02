/**
 * Records that the user has met the guided tour, from ANY entry point — the
 * dashboard prompt (start or decline) and the Settings › Help replay alike — so
 * the first-run prompt never reappears once the tour has been experienced.
 *
 * Fire-and-forget and non-fatal: the write is idempotent server-side
 * (markTourSeen keeps the original timestamp), and the worst case of a failed
 * POST is the prompt greeting them once more, never a blocked screen.
 */
export function markTourSeen(): void {
  void fetch("/api/profile/tour-seen", { method: "POST" }).catch(() => undefined);
}
