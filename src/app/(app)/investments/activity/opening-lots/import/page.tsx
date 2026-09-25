import { requireSession } from "@/domain/auth";
import {
  OPENING_LOT_AI_CONVERSION_PROMPT,
  OPENING_LOT_CSV_COLUMNS,
} from "@/lib/investments/opening-lots-csv";
import { OpeningLotImportScreen } from "./opening-lot-import-screen";

export default async function OpeningLotImportPage() {
  await requireSession();
  return (
    <OpeningLotImportScreen
      prompt={OPENING_LOT_AI_CONVERSION_PROMPT}
      columns={[...OPENING_LOT_CSV_COLUMNS]}
    />
  );
}
