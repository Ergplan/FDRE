export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  const { migrate } = await import("./lib/db");
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await migrate();
      const { seedProfiles } = await import("./lib/profiles");
      const n = await seedProfiles();
      if (n) console.log(`[db] loaded ${n} built-in resource profiles`);
      const { seedTenderReads } = await import("./lib/tenders");
      const t = await seedTenderReads().catch((err) => { console.error(`[tenders] seed: ${err.message}`); return 0; });
      if (t) console.log(`[db] loaded ${t} built-in tender readings`);
      const { purgeOldActivity } = await import("./lib/activity");
      await purgeOldActivity().catch((err) => console.error(`[activity] purge: ${err.message}`));
      return;
    } catch (err) {
      console.error(`[db] migration attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("Database migrations failed");
}
