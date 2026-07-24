import { CompanyTypes, createScraper } from 'israeli-bank-scrapers';

(async function() {
  try {
    // read documentation below for available options
    const options = {
      companyId: CompanyTypes.leumi, 
      startDate: new Date('2026-01-01'),
      combineInstallments: false,
      showBrowser: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    };

    // read documentation below for information about credentials
    const credentials = {
      username: 'test',
      password: 'pass'
    };

    const scraper = createScraper(options);
    const scrapeResult = await scraper.scrape(credentials);

    if (scrapeResult.success) {
      scrapeResult.accounts.forEach((account) => {
        console.log(`found ${account.txns.length} transactions for account number ${account.accountNumber}`);
      });
    }
    else {
      throw new Error(scrapeResult.errorType);
    }
  } catch(e) {
    console.error(`scraping failed for the following reason: ${e.message}`);
  }
})();
