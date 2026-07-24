import { CompanyTypes, createScraper } from 'israeli-bank-scrapers';

(async function() {
  try {
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 1);

    const options = {
      companyId: CompanyTypes.isracard, 
      startDate: startDate,
      combineInstallments: false,
      showBrowser: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    };

    const credentials = {
      id: '',           // Your ID number (Teudat Zehut)
      card6Digits: '',  // Last 6 digits of your credit card
      password: ''      // Your password
    };

    console.log(`Starting Isracard scraper from ${startDate.toISOString().split('T')[0]}...`);
    const scraper = createScraper(options);
    const scrapeResult = await scraper.scrape(credentials);

    if (scrapeResult.success) {
      console.log(`Successfully scraped Isracard!`);
      scrapeResult.accounts.forEach((account) => {
        console.log(`\n=== Account: ${account.accountNumber} ===`);
        console.log(`Found ${account.txns.length} transactions.`);
        console.log(account.txns);
      });
    } else {
      throw new Error(scrapeResult.errorType);
    }
  } catch(e) {
    console.error(`scraping failed for the following reason: ${e.message}`);
  }
})();
