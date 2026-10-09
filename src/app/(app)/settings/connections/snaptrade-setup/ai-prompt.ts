// For an assistant that can drive the user's own browser (Claude in Chrome,
// Codex, …). The user signs up and logs in themselves — SnapTrade asks for a
// password and a two-factor code, and linking a brokerage means logging in to
// that brokerage. The assistant only finds its way around the dashboard and
// checks the result. Keep it in step with the manual steps in page.tsx.
export const SNAPTRADE_SETUP_PROMPT = `Help me set up SnapTrade for my personal-finance app, Moni, by controlling my web browser. Work only inside the SnapTrade dashboard at dashboard.snaptrade.com.

Ground rules
- Never type a password, two-factor code or recovery code — mine for SnapTrade or for any brokerage. When a login or code is needed, stop and wait until I tell you I've done it.
- Change only what is listed below. Don't delete, disable or change any existing connection, and don't change any other setting.
- Never press "Rotate" next to the Consumer Key: it replaces the key at once and breaks any app already using it.
- Never pick "Read & trade". Moni only reads.
- Never repeat the Client ID or Consumer Key in your replies or anywhere else, and don't reveal the Consumer Key with the eye icon. Tell me where each one is on screen and I'll copy them myself.

Step 1: Account
1. If I don't have a SnapTrade account yet, open dashboard.snaptrade.com/signup and wait while I sign up, verify my email and log in.

Step 2: Two-factor sign-in
1. Click my name at the bottom left, then "Account settings", then the "Security" tab.
2. If "Authenticator app" already says On, go to step 3. Otherwise click "Turn on" next to it and wait while I scan the code with my authenticator app and finish.

Step 3: Link my brokerages
1. Go to Home. Under Connections, ask me which brokerages I want to link (for example Schwab or Vanguard US) and skip any that are already listed.
2. For each one: click the button to connect an account, choose "Read-only", click Continue, search for the brokerage under "Select your institution" and pick it. Then wait while I log in to the brokerage myself.

Step 4: Verify
1. Go back to Home and show me a checklist marking each item ✓ or ✗:
   - Security: Authenticator app is On.
   - Every brokerage I asked for is listed under Connections.
   - Each of those connections has Status "Active".
   - Each of those connections has Access "Read-only".
2. If anything is ✗, tell me what's wrong and what I need to do. Don't fix a connection by deleting it.

Step 5: Hand back
1. Open Build → API Keys. Tell me where the "Client ID" and "Consumer Key" fields are on screen — each has a copy button — and stop. I'll copy both into Moni myself.`;
