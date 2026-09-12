# Opening-lot CSV conversion

Moni accepts one opening investment lot per row, with this exact required header:

```csv
account,isin,symbol,exchange,trade_date,quantity,remaining_quantity,unit_cost,total_cost,currency,fee,ils_fx_rate,broker_lot_id
```

`account`, `trade_date`, `quantity`, and `currency` are required. `trade_date` uses
`YYYY-MM-DD`. Supply at least one of `unit_cost` or `total_cost`, and at least one
durable security identity: `isin`, or both `symbol` and `exchange`. A ticker alone
is rejected. Blank `remaining_quantity` means the original `quantity`; `fee` and
`broker_lot_id` are optional.

When `ils_fx_rate` is present, Moni locks that exact user-entered decimal. Leave it
blank when the source export has no ILS rate; Moni then tries the Bank of Israel
rate for the trade date and records an unresolved rate without blocking the import
when no usable observation exists.

## Copy-paste AI conversion prompt

The same UI-independent canonical prompt is exported as
`OPENING_LOT_AI_CONVERSION_PROMPT` from
`src/lib/investments/opening-lots-csv.ts`:

```text
Convert my brokerage or spreadsheet export into a CSV containing opening investment lots.

Output only CSV, with this exact header and column order:
account,isin,symbol,exchange,trade_date,quantity,remaining_quantity,unit_cost,total_cost,currency,fee,ils_fx_rate,broker_lot_id

Use one row per lot. Keep all quantities, costs, fees, and FX rates as exact decimal text without currency symbols or thousands separators. Use YYYY-MM-DD for trade_date and a three-letter uppercase currency code. account must contain the broker account reference used in Moni. quantity is the original lot quantity; leave remaining_quantity blank to make it equal quantity. At least one of unit_cost or total_cost is required. fee and broker_lot_id are optional. At least one of isin or symbol+exchange is required; a symbol without exchange is invalid. If the source has an ILS exchange rate for the acquisition, place it in ils_fx_rate verbatim. Leave ils_fx_rate blank if your export has no ILS rate. Do not invent missing values, combine lots, or add commentary.
```

Copy it into your own AI tool together with the brokerage or spreadsheet export.
Review the resulting preview before promoting it; the AI is a formatting aid and
never writes to Moni.
