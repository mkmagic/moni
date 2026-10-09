// For an assistant that can drive the user's own browser (Claude in Chrome,
// Codex, …). IBKR's own "Configure with AI" builder was tried first: it caps
// prompts at 200 characters and hung without producing a query. The user logs
// in themselves; the assistant only fills in the query and then checks it
// against the query's info window, which lists every section, option and
// delivery setting. Keep the sections in step with the manual steps in
// page.tsx and with what ibkr-flex.ts reads.
export const IBKR_SETUP_PROMPT = `Help me set up an Interactive Brokers (IBKR) Flex Query for my personal-finance app, Moni, by controlling my web browser. Work only inside IBKR's Client Portal.

Ground rules
- Never type my IBKR username, password or two-factor code. Open the Client Portal login page and wait until I tell you I'm logged in.
- Change only what is listed below. Don't edit or delete any other Flex Query or setting.
- Ask me before clicking "Generate New Token": it immediately cancels any existing Flex token.
- Never repeat the token in your replies or anywhere else. Tell me where it is on screen and I'll copy it myself.

Step 1: Flex token
1. Go to Performance & Reports → Flex Queries. Click the gear next to "Flex Web Service Configuration".
2. If "Flex Web Service Status" is unticked, tick it.
3. If a Current Token is already shown, ask me whether to keep it. Otherwise, with my OK, click "Generate New Token", choose the longest expiry offered, and leave the IP address empty.

Step 2: Activity Flex Query
1. Back on Flex Queries, click the + next to "Activity Flex Query". Set Query Name to "Moni".
2. Configure these sections. Click each one, set it up, then click Save at the bottom of its window. "Select All" is the first row of the field list.
   - Account Information: tick ONLY "Account ID" and "Currency". Do not use Select All here.
   - Open Positions: tick both options, "Summary" and "Lot". Then Select All.
   - Cash Report: tick the option "Currency Breakout". Then Select All.
   - Net Asset Value (NAV) in Base: Select All.
   - Trades: keep the option "Execution" ticked. Then Select All.
   - Cash Transactions: Select All.
   - Change in Dividend Accruals: Select All.
   - Corporate Actions: Select All.
3. Under Delivery Configuration, set Format to "XML" and Period to "Last 365 Calendar Days".
4. Leave General Configuration at its defaults. Check that "Breakout by Day?" is No and Date Format is yyyyMMdd.
5. Click Continue, then confirm to create the query.

Step 3: Verify
1. On Flex Queries, click the (i) info icon next to the "Moni" query. Its details window lists every section, option and delivery setting.
2. Check each item and show me a checklist marking each one ✓ or ✗:
   - All 8 sections from step 2 are present.
   - Account Information lists Account ID and Currency.
   - Open Positions shows the options Summary and Lot.
   - Cash Report shows Currency Breakout.
   - Trades shows Execution.
   - Format is XML and Period is Last 365 Calendar Days.
   - Breakout by Day is No.
3. If anything is ✗, close the window, click the pencil next to the query, fix it, save, and verify again until everything is ✓.

Step 4: Hand back
Tell me the Query ID shown in the details window. I'll paste the token and the Query ID into Moni myself.`;
