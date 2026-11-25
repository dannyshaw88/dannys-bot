import type { Request, Response } from "express";

type Handler = (req: Request, res: Response) => Promise<void>;
type Job = {
  state: "running" | "finished";
  status: number;
  body: unknown;
  aborted: boolean;
  endedAt?: number;
};

/** Results are published only after the cycle's finally/lease cleanup finishes. */
export class AutomationCycleJobs {
  private jobs = new Map<string, Job>();
  private active = new Map<string, string>();
  private key(serial: string, cycleId: string) { return JSON.stringify([serial, cycleId]); }

  abort(serial: string, cycleId: string) {
    const job = this.jobs.get(this.key(serial, cycleId));
    if (job?.state === "running") job.aborted = true;
  }

  isAborted(serial: string, cycleId: string) {
    return this.jobs.get(this.key(serial, cycleId))?.aborted === true;
  }

  get(serial: string, cycleId: string) {
    const job = this.jobs.get(this.key(serial, cycleId));
    return job ? { state: job.state, status: job.status, body: job.body } : null;
  }

  start(serial: string, cycleId: string, req: Request, handler: Handler) {
    for (const [key, job] of this.jobs) {
      if (job.endedAt && (Date.now() - job.endedAt > 3_600_000 || this.jobs.size > 1000)) this.jobs.delete(key);
    }
    const key = this.key(serial, cycleId);
    if (this.jobs.has(key)) return true; // Retried start must not execute twice.
    if (this.active.has(serial)) return false;
    const job: Job = { state: "running", status: 200, body: null, aborted: false };
    this.jobs.set(key, job);
    this.active.set(serial, key);
    const response = {
      status(code: number) { job.status = code; return response; },
      json(body: unknown) { job.body = body; return response; },
    } as Response;
    void (async () => {
      try {
        await handler(req, response);
        if (job.body === null) {
          job.status = 500;
          job.body = { ok: false, error: "Automation cycle ended without a result" };
        }
      } catch (error) {
        job.status = 500;
        job.body = { ok: false, error: error instanceof Error ? error.message : "Automation cycle failed" };
      } finally {
        job.endedAt = Date.now();
        job.state = "finished";
        if (this.active.get(serial) === key) this.active.delete(serial);
      }
    })();
    return true;
  }
}
