// The category set every new user is seeded with (docs/design/categorization.md).
//
// Two levels only — the depth-1 cap from data-model.md §5. Nesting children
// under their group in the data (rather than a flat list with `parentKey`)
// makes both of the invariants the domain layer enforces structural here: a
// child can't declare a classification that differs from its parent's, and
// it can't declare a color that differs either (Maybe's
// `inherit_color_from_parent`).
//
// Parent names follow the Plaid personal-finance-category taxonomy, which is
// what a model matches against most reliably; the children are where the
// Israeli specifics live (Arnona, Vaad Bayit, Bituach Leumi, Kupat Holim,
// car test). `key` is written to `categories.builtin_key` and is the stable
// identity built-in rules resolve through, so it survives a rename — never
// change one once shipped.
//
// `color` is a globals.css token name, never a raw color value
// (docs/design/ui-and-feel.md). `icon` is a lucide name, rendered through a
// lookup with a fallback so an unknown name degrades instead of throwing.

export type CategoryClassification = "income" | "expense" | "transfer";

/** The palette a category color may be drawn from — token names only, never
 * raw color values (docs/design/ui-and-feel.md). A user-created category
 * picks one of these; a subcategory inherits its parent's. */
export const CATEGORY_COLORS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;

export type CategoryColor = (typeof CATEGORY_COLORS)[number];

export function isCategoryColor(value: string): value is CategoryColor {
  return (CATEGORY_COLORS as readonly string[]).includes(value);
}

export interface DefaultCategoryChild {
  key: string;
  name: string;
  icon: string;
}

export interface DefaultCategoryGroup {
  key: string;
  name: string;
  classification: CategoryClassification;
  color: string;
  icon: string;
  children: DefaultCategoryChild[];
}

export const DEFAULT_CATEGORIES: DefaultCategoryGroup[] = [
  {
    key: "income",
    name: "Income",
    classification: "income",
    color: "chart-2",
    icon: "circle-dollar-sign",
    children: [
      { key: "income-salary", name: "Salary", icon: "banknote" },
      { key: "income-national-insurance", name: "National Insurance", icon: "landmark" },
      { key: "income-investments", name: "Interest & Dividends", icon: "trending-up" },
      { key: "income-refunds", name: "Refunds", icon: "receipt" },
      { key: "income-other", name: "Other Income", icon: "coins" },
    ],
  },
  {
    key: "food",
    name: "Food & Drink",
    classification: "expense",
    color: "chart-1",
    icon: "utensils",
    children: [
      { key: "food-groceries", name: "Groceries", icon: "shopping-basket" },
      { key: "food-restaurants", name: "Restaurants & Cafés", icon: "coffee" },
      { key: "food-delivery", name: "Food Delivery", icon: "bike" },
    ],
  },
  {
    key: "transport",
    name: "Transportation",
    classification: "expense",
    color: "chart-4",
    icon: "bus",
    children: [
      { key: "transport-fuel", name: "Fuel", icon: "fuel" },
      { key: "transport-public", name: "Public Transport", icon: "train-front" },
      { key: "transport-taxi", name: "Taxi & Rideshare", icon: "car" },
      { key: "transport-parking", name: "Parking & Tolls", icon: "circle-parking" },
      // Israeli specific: the annual רישוי/טסט road-worthiness test, which
      // arrives as its own charge alongside compulsory car insurance.
      { key: "transport-car-insurance", name: "Car Insurance & Test", icon: "shield-check" },
      { key: "transport-maintenance", name: "Car Maintenance", icon: "wrench" },
    ],
  },
  {
    key: "housing",
    name: "Housing & Utilities",
    classification: "expense",
    color: "chart-5",
    icon: "house",
    children: [
      { key: "housing-rent", name: "Rent", icon: "key" },
      { key: "housing-mortgage", name: "Mortgage", icon: "landmark" },
      // Israeli specific: ארנונה, the municipal property tax.
      { key: "housing-arnona", name: "Arnona (Municipal Tax)", icon: "building" },
      // Israeli specific: ועד בית, the building maintenance committee fee.
      { key: "housing-vaad-bayit", name: "Vaad Bayit", icon: "users" },
      { key: "housing-electricity", name: "Electricity", icon: "zap" },
      { key: "housing-water", name: "Water", icon: "droplet" },
      { key: "housing-internet", name: "Internet & TV", icon: "wifi" },
      { key: "housing-cellular", name: "Cellular", icon: "smartphone" },
      { key: "housing-maintenance", name: "Home Maintenance", icon: "hammer" },
    ],
  },
  {
    key: "health",
    name: "Healthcare",
    classification: "expense",
    color: "chart-3",
    icon: "pill",
    children: [
      // Israeli specific: קופת חולים, the public health fund (Clalit,
      // Maccabi, Meuhedet, Leumit) — a monthly charge for most households.
      { key: "health-fund", name: "Health Fund", icon: "stethoscope" },
      { key: "health-pharmacy", name: "Pharmacy", icon: "pill" },
      { key: "health-dental", name: "Dental", icon: "smile" },
      { key: "health-insurance", name: "Health Insurance", icon: "shield-plus" },
    ],
  },
  {
    key: "shopping",
    name: "Shopping",
    classification: "expense",
    color: "chart-1",
    icon: "shopping-cart",
    children: [
      { key: "shopping-clothing", name: "Clothing", icon: "shirt" },
      { key: "shopping-electronics", name: "Electronics", icon: "laptop" },
      { key: "shopping-home", name: "Home & Furniture", icon: "sofa" },
      { key: "shopping-online", name: "Online Shopping", icon: "package" },
    ],
  },
  {
    key: "entertainment",
    name: "Entertainment",
    classification: "expense",
    color: "chart-5",
    icon: "drama",
    children: [
      { key: "entertainment-subscriptions", name: "Subscriptions", icon: "tv" },
      { key: "entertainment-culture", name: "Culture & Events", icon: "ticket" },
      { key: "entertainment-sports", name: "Sports & Fitness", icon: "dumbbell" },
      { key: "entertainment-travel", name: "Travel & Vacation", icon: "plane" },
    ],
  },
  {
    key: "services",
    name: "Services",
    classification: "expense",
    color: "chart-4",
    icon: "briefcase",
    children: [
      { key: "services-education", name: "Education", icon: "graduation-cap" },
      { key: "services-childcare", name: "Childcare", icon: "baby" },
      { key: "services-professional", name: "Professional Services", icon: "scale" },
      { key: "services-personal-care", name: "Personal Care", icon: "scissors" },
    ],
  },
  {
    key: "financial",
    name: "Financial",
    classification: "expense",
    color: "chart-3",
    icon: "credit-card",
    children: [
      { key: "financial-bank-fees", name: "Bank Fees", icon: "receipt" },
      { key: "financial-card-fees", name: "Credit Card Fees", icon: "credit-card" },
      { key: "financial-loans", name: "Loan Payments", icon: "handshake" },
      { key: "financial-taxes", name: "Taxes", icon: "percent" },
      { key: "financial-savings", name: "Savings & Investments", icon: "piggy-bank" },
      { key: "financial-insurance", name: "Insurance", icon: "umbrella" },
    ],
  },
  {
    key: "giving",
    name: "Gifts & Donations",
    classification: "expense",
    color: "chart-2",
    icon: "hand-heart",
    children: [
      { key: "giving-gifts", name: "Gifts", icon: "gift" },
      { key: "giving-charity", name: "Charity", icon: "heart-handshake" },
    ],
  },
  {
    key: "transfers",
    name: "Transfers",
    classification: "transfer",
    color: "chart-4",
    icon: "arrow-left-right",
    children: [
      { key: "transfers-internal", name: "Internal Transfer", icon: "arrow-left-right" },
      { key: "transfers-cash", name: "Cash Withdrawal", icon: "banknote" },
      // The monthly card settlement debited from the bank account. It is a
      // move of money, not spending: the purchases it settles are already in
      // the ledger as entries on the card account, so counting it as an
      // expense would count every card purchase twice.
      { key: "transfers-card-payment", name: "Credit Card Payment", icon: "credit-card" },
    ],
  },
];

export interface FlatDefaultCategory {
  key: string;
  name: string;
  classification: CategoryClassification;
  color: string;
  icon: string;
  parentKey: string | null;
}

/** Parents first, then children — the order rows must be inserted in, since
 * a child's `parent_id` FK needs its parent to exist. */
export function flattenDefaultCategories(): FlatDefaultCategory[] {
  const parents = DEFAULT_CATEGORIES.map((g) => ({
    key: g.key,
    name: g.name,
    classification: g.classification,
    color: g.color,
    icon: g.icon,
    parentKey: null,
  }));
  const children = DEFAULT_CATEGORIES.flatMap((g) =>
    g.children.map((c) => ({
      key: c.key,
      name: c.name,
      // Inherited, not declared — the two invariants the domain layer
      // enforces for user-created categories hold by construction here.
      classification: g.classification,
      color: g.color,
      icon: c.icon,
      parentKey: g.key,
    })),
  );
  return [...parents, ...children];
}
