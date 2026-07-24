import { CompanyTypes, createScraper } from 'israeli-bank-scrapers';

(async function() {
  try {
    const options = {
      companyId: CompanyTypes.leumi, 
      startDate: new Date('2020-05-01'),
      combineInstallments: false,
      showBrowser: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    };

    const credentials = {
      username: 'YOUR_USERNAME',
      password: 'YOUR_PASSWORD'
    };

    console.log(`Starting Bank Leumi scraper...`);
    const scraper = createScraper(options);
    const scrapeResult = await scraper.scrape(credentials);

    if (scrapeResult.success) {
      console.log(`Successfully scraped Leumi!`);
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
