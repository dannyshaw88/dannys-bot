/** Keep the browser's HTTP connections free while server-side phone work runs. */
export async function automationCycleRequest(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status !== 202) return response;
  const accepted = await response.clone().json();
  if (accepted.background !== true || typeof accepted.cycleId !== "string") return response;
  const statusUrl = `${url}/jobs/${encodeURIComponent(accepted.cycleId)}`;
  while (true) {
    await new Promise<void>((resolve, reject) => {
      const signal = init.signal;
      const onAbort = () => { clearTimeout(timer); reject(new DOMException("Cycle wait aborted", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 1500);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    const statusResponse = await fetch(statusUrl, { signal: init.signal, cache: "no-store" });
    if (!statusResponse.ok) return statusResponse;
    const job = await statusResponse.json();
    if (job.state === "running") continue;
    if (job.state !== "finished" || !Number.isInteger(job.status)) throw new Error("Invalid automation job result");
    return new Response(JSON.stringify(job.body), {
      status: job.status, headers: { "Content-Type": "application/json" },
    });
  }
}
