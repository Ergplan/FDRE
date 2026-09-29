export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  const { migrate } = await import("./lib/db");
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await migrate();
      return;
    } catch (err) {
      console.error(`[db] migration attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("Database migrations failed");
}
