---
name: israeli-scraper
description: Guidelines on installing, updating, and using the israeli-bank-scrapers library in the Moni project.
---

# Israeli Bank Scrapers Skill

This document explains how to set up, troubleshoot, and use the `israeli-bank-scrapers` library for retrieving financial transactions for the Moni project.

## 1. Installation

Navigate to your dependencies directory and install the package:
```bash
npm init -y
npm install israeli-bank-scrapers --save
```

### Puppeteer Troubleshooting (macOS / arm64)
The `israeli-bank-scrapers` library uses Puppeteer, which downloads a Chrome binary. Sometimes this installation fails silently or throws `Failed to launch the browser process: no such file`.

To fix this, either force Puppeteer to install Chrome:
```bash
npx puppeteer browsers install chrome
```
**Or** pass your system's native Chrome path in the scraper options:
```javascript
executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

## 2. Version Verification and Updates

To ensure you have the correct/latest version:
```bash
npm ls israeli-bank-scrapers
```

To update the package to the latest version:
```bash
npm install israeli-bank-scrapers@latest --save
```

## 3. Example Scripts

In the `scripts/` directory of this skill, you will find template `.mjs` scripts to test basic connectivity:

- **`leumi.mjs`**: Basic scraper for Bank Leumi.
- **`isracard.mjs`**: Scraper for Isracard, pulling exactly the last month of transactions.

### Running the Scripts
1. Provide the actual credentials in the script (`username`/`password` for banks, or `id`/`card6Digits`/`password` for credit cards).
2. Run the script using Node.js:
   ```bash
   node leumi.mjs
   ```
3. Look out for the `GENERIC` or `INVALID_PASSWORD` error if the credentials are not filled out correctly.
4. On success, the script will output the list of `txns` containing `date`, `description`, `chargedAmount`, `status`, etc., to allow you to verify the transaction fields.
