/**
 * One stop on the guided product tour. The tour navigates to `route`, waits for
 * `anchor` to mount, then spotlights it with the card of copy beside it.
 *
 * **This array is the tour.** Adding a major feature means adding a stop here —
 * see AGENTS.md §7. Keep the itinerary in the order a newcomer should meet the
 * app: the dashboard's own pieces first, then each section in sidebar order,
 * then the settings that shape it.
 */
export interface TourStep {
  /** Stable, unique key — used for React keys and the progress counter. */
  id: string;
  /** The route this stop lives on. The tour routes here before showing it. */
  route: string;
  /**
   * CSS selector of the element to spotlight. Omit for a centered card with no
   * spotlight (the welcome/finish stops). If the selector matches nothing on
   * `route` — an empty section, a control hidden on this viewport — the stop
   * degrades to a centered card rather than pointing at nothing.
   */
  anchor?: string;
  title: string;
  /** One or two sentences. Keep it short; the tour is a map, not a manual. */
  body: string;
}

// U+2068 FIRST STRONG ISOLATE / U+2069 POP DIRECTIONAL ISOLATE — the
// character-level equivalent of <bdi>, used because `body` is plain text. Two
// Hebrew terms in an English sentence render swapped without per-term isolation
// (ui-developer feedback, 2026-08-05).
const FSI = "⁨";
const PDI = "⁩";

export const TOUR_STEPS: TourStep[] = [
  {
    id: "net-worth",
    route: "/dashboard",
    anchor: '[data-tour="dash-net-worth"]',
    title: "Your net worth",
    body: "Everything you own minus what you owe — your whole financial picture in one number, tracked over time.",
  },
  {
    id: "this-month",
    route: "/dashboard",
    anchor: '[data-tour="dash-this-month"]',
    title: "This month",
    body: "Income, spending, and how you're tracking against budget — updated as new transactions arrive.",
  },
  {
    id: "insights",
    route: "/dashboard",
    anchor: '[data-tour="dash-insights"]',
    title: "What needs you",
    body: "Moni gathers anything worth a look here — transactions to categorize, budgets slipping, connections to refresh.",
  },
  {
    id: "sync",
    route: "/dashboard",
    anchor: '[data-tour="dash-sync"]',
    title: "Keep it current",
    body: "Refresh your connections whenever you like. You confirm with your passkey — nothing syncs without you.",
  },
  {
    id: "transactions",
    route: "/transactions",
    anchor: '[data-tour="nav-/transactions"]',
    title: "Transactions",
    body: "Every payment and deposit, categorized. Search, filter, and fix a category in a click.",
  },
  {
    id: "budget",
    route: "/budget",
    anchor: '[data-tour="nav-/budget"]',
    title: "Budget",
    body: "Set a monthly ceiling per category and see, at a glance, where you stand.",
  },
  {
    id: "accounts",
    route: "/accounts",
    anchor: '[data-tour="nav-/accounts"]',
    title: "Accounts",
    body: "All your accounts, grouped by how quickly you can reach the money.",
  },
  {
    id: "investments",
    route: "/investments",
    anchor: '[data-tour="nav-/investments"]',
    title: "Investments",
    body: "Your portfolio — holdings, allocation, and how its value moves over time.",
  },
  {
    id: "long-term-savings",
    route: "/long-term-savings",
    anchor: '[data-tour="nav-/long-term-savings"]',
    title: "Long-term savings",
    body: `Your pension, ${FSI}קרן השתלמות${PDI} and ${FSI}קופת גמל${PDI}, from the reports you import.`,
  },
  {
    id: "ai-settings",
    route: "/settings/ai",
    anchor: '[data-tour="settings-ai"]',
    title: "AI, on your terms",
    body: "Turn on Smart Categorize and manage agent (MCP) access here. AI is always opt-in and, in this version, strictly read-only.",
  },
  {
    id: "done",
    route: "/dashboard",
    title: "You're all set",
    body: "That's the tour. Household sharing is on the way. You can replay this anytime from Settings › Help.",
  },
];
