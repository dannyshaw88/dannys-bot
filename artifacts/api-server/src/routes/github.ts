import { Router, type IRouter } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";

const router: IRouter = Router();

router.get("/github/releases", async (_req, res) => {
  try {
    const connectors = new ReplitConnectors();
    const response = await connectors.proxy("github", "/user/repos", {
      method: "GET",
    });
    const repos: any[] = await response.json();

    if (!Array.isArray(repos) || repos.length === 0) {
      res.json([]);
      return;
    }

    const allReleases: any[] = [];

    await Promise.all(
      repos.map(async (repo: any) => {
        try {
          const relResponse = await connectors.proxy(
            "github",
            `/repos/${repo.full_name}/releases`,
            { method: "GET" }
          );
          const releases: any[] = await relResponse.json();
          if (Array.isArray(releases)) {
            releases.forEach((r) => allReleases.push({ ...r, repo: repo.full_name }));
          }
        } catch {
        }
      })
    );

    allReleases.sort(
      (a, b) =>
        new Date(b.published_at ?? b.created_at ?? 0).getTime() -
        new Date(a.published_at ?? a.created_at ?? 0).getTime()
    );

    res.json(allReleases);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to fetch releases" });
  }
});

export default router;
