import { handler, HttpError, requireUser } from "@/lib/auth";
import { xlsxToCsv } from "@/lib/xlsxToCsv";

// Excel → CSV so the browser-side profile parser can read .xlsx uploads (PVsyst, SCADA exports).
export const POST = handler(async (req) => {
  await requireUser();
  const { data } = await req.json().catch(() => ({}));
  if (typeof data !== "string" || !data) throw new HttpError(400, "data (base64 .xlsx) is required.");
  const buf = Buffer.from(data, "base64");
  if (buf.length > 25 * 1024 * 1024) throw new HttpError(413, "Workbook is larger than 25 MB.");
  try {
    return Response.json(await xlsxToCsv(buf));
  } catch (err) {
    throw new HttpError(400, `Could not read the workbook: ${err.message}`);
  }
});
