import { useState, useCallback, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useCreateProfile } from "@/hooks/use-profiles";
import { toast } from "@/hooks/use-toast";
import { userAgents } from "@/shared/userAgents";
import {
  CheckCircle2, AlertCircle, Loader2, Instagram, Trash2, Upload,
  Eye, EyeOff, ClipboardPaste,
} from "lucide-react";


// ── Types ─────────────────────────────────────────────────────────────────────

type RowStatus = "pending" | "adding" | "added" | "error";

type ParsedRow = {
  id: string;
  username: string;
  password: string;
  twoFASecret: string;
  email: string;
  emailPassword: string;
  status: RowStatus;
  errorMsg?: string;
  profileId?: number;
};

// ── Parser ────────────────────────────────────────────────────────────────────

function parseRaw(raw: string): ParsedRow[] {
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#"))
    .map((line, i) => {
      const parts = line.split(":");
      const username = parts[0]?.trim() ?? "";
      const password = parts[1]?.trim() ?? "";
      const twoFASecret = parts[2]?.trim() ?? "";

      let email = "";
      let emailPassword = "";

      if (parts.length >= 5) {
        email = parts[3]?.trim() ?? "";
        emailPassword = parts.slice(4).join(":").trim();
      } else if (parts.length === 4) {
        // Could be email-only or emailpassword — check for @
        const p3 = parts[3]?.trim() ?? "";
        if (p3.includes("@")) {
          email = p3;
        } else {
          emailPassword = p3;
        }
      }

      return {
        id: `${i}-${username}-${Date.now()}`,
        username,
        password,
        twoFASecret,
        email,
        emailPassword,
        status: "pending" as RowStatus,
      };
    })
    .filter(r => r.username.length > 0);
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ row }: { row: ParsedRow }) {
  if (row.status === "adding") return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600">
      <Loader2 className="w-3 h-3 animate-spin" /> Adding…
    </span>
  );
  if (row.status === "added") return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-600">
      <CheckCircle2 className="w-3 h-3" /> Added
    </span>
  );
  if (row.status === "error") return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-600" title={row.errorMsg}>
      <AlertCircle className="w-3 h-3" /> Error
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">
      Pending
    </span>
  );
}

// ── Masked cell ───────────────────────────────────────────────────────────────

function MaskedCell({ value, placeholder }: { value: string; placeholder?: string }) {
  const [show, setShow] = useState(false);
  if (!value) return <span className="text-muted-foreground/40 text-xs italic">{placeholder ?? "—"}</span>;
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <span className="text-xs font-mono truncate max-w-[120px]">
        {show ? value : "•".repeat(Math.min(value.length, 12))}
      </span>
      <button
        onClick={() => setShow(v => !v)}
        className="text-muted-foreground hover:text-foreground shrink-0"
        title={show ? "Hide" : "Show"}
      >
        {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
      </button>
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function BulkImportPage() {
  const [rawText, setRawText] = useState("");
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const createProfileMutation = useCreateProfile();
  const textareaRef = useRef<HTMLTextAreaElement>(null);


  // ── Selection ──────────────────────────────────────────────────────────────

  const pendingRows = rows.filter(r => r.status === "pending");
  const allPendingSelected = pendingRows.length > 0 && pendingRows.every(r => selectedIds.has(r.id));

  const toggleAll = () => {
    if (allPendingSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        pendingRows.forEach(r => next.delete(r.id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        pendingRows.forEach(r => next.add(r.id));
        return next;
      });
    }
  };

  const toggleRow = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Add accounts ───────────────────────────────────────────────────────────

  const addRows = useCallback(async (idsToAdd: string[]) => {
    if (idsToAdd.length === 0) return;
    setAdding(true);

    let successCount = 0;
    let errorCount = 0;

    for (const id of idsToAdd) {
      const row = rows.find(r => r.id === id);
      if (!row || row.status !== "pending") continue;

      setRows(prev => prev.map(r => r.id === id ? { ...r, status: "adding" } : r));

      try {
        const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
        const created = await createProfileMutation.mutateAsync({
          username: row.username,
          password: row.password,
          accountLabel: row.username,
          twoFASecretKey: row.twoFASecret || null,
          emailValidationUsername: row.email || null,
          emailValidationPassword: row.emailPassword || null,
          proxyHost: "",
          proxyPort: null,
          proxyUsername: "",
          proxyPassword: "",
          userAgentApi: ua.api,
          userAgentEmbedded: ua.embedded,
        });

        localStorage.setItem(`trustscore_v2_${created.id}`, "noob");
        setRows(prev => prev.map(r => r.id === id ? { ...r, status: "added", profileId: created.id } : r));
        setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create";
        setRows(prev => prev.map(r => r.id === id ? { ...r, status: "error", errorMsg: msg } : r));
        errorCount++;
      }
    }

    setAdding(false);

    if (successCount > 0 && errorCount === 0) {
      toast({ title: `${successCount} account${successCount !== 1 ? "s" : ""} added`, description: "Now visible on the Accounts page." });
    } else if (successCount > 0) {
      toast({ title: `${successCount} added, ${errorCount} failed`, description: "Check error rows for details.", variant: "destructive" });
    } else {
      toast({ title: "All failed", description: "Check error rows for details.", variant: "destructive" });
    }
  }, [rows, createProfileMutation]);

  // ── Sort & Add (parse + immediately add all in one click) ──────────────────

  const handleSortAndAdd = useCallback(async () => {
    if (!rawText.trim()) {
      toast({ title: "Nothing to sort", description: "Paste account data above first.", variant: "destructive" });
      return;
    }
    const parsed = parseRaw(rawText);
    if (parsed.length === 0) {
      toast({ title: "No accounts found", description: "Check your format: username:password:2fasecret", variant: "destructive" });
      return;
    }
    setRows(parsed);
    setSelectedIds(new Set(parsed.map(r => r.id)));
    setAdding(true);

    let successCount = 0;
    let errorCount = 0;

    for (const row of parsed) {
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, status: "adding" } : r));
      try {
        const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
        const created = await createProfileMutation.mutateAsync({
          username: row.username,
          password: row.password,
          accountLabel: row.username,
          twoFASecretKey: row.twoFASecret || null,
          emailValidationUsername: row.email || null,
          emailValidationPassword: row.emailPassword || null,
          proxyHost: "",
          proxyPort: null,
          proxyUsername: "",
          proxyPassword: "",
          userAgentApi: ua.api,
          userAgentEmbedded: ua.embedded,
        });
        localStorage.setItem(`trustscore_v2_${created.id}`, "noob");
        setRows(prev => prev.map(r => r.id === row.id ? { ...r, status: "added", profileId: created.id } : r));
        setSelectedIds(prev => { const next = new Set(prev); next.delete(row.id); return next; });
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create";
        setRows(prev => prev.map(r => r.id === row.id ? { ...r, status: "error", errorMsg: msg } : r));
        errorCount++;
      }
    }

    setAdding(false);

    if (successCount > 0 && errorCount === 0) {
      toast({ title: `${successCount} account${successCount !== 1 ? "s" : ""} added`, description: "Now visible on the Accounts page." });
    } else if (successCount > 0) {
      toast({ title: `${successCount} added, ${errorCount} failed`, description: "Check error rows for details.", variant: "destructive" });
    } else {
      toast({ title: "All failed", description: "Check error rows for details.", variant: "destructive" });
    }
  }, [rawText, createProfileMutation]);

  const handleAddRow = (id: string) => addRows([id]);

  // ── Remove row ─────────────────────────────────────────────────────────────

  const removeRow = (id: string) => {
    setRows(prev => prev.filter(r => r.id !== id));
    setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
  };

  // ── Clear ──────────────────────────────────────────────────────────────────

  const handleClear = () => {
    setRawText("");
    setRows([]);
    setSelectedIds(new Set());
  };

  const selectedPendingCount = [...selectedIds].filter(id => rows.find(r => r.id === id)?.status === "pending").length;

  return (
    <AppLayout>
      <div className="w-full pb-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Bulk Account Import</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Paste credentials to parse and add accounts in bulk. No proxies are assigned automatically.
            </p>
          </div>
          {rows.length > 0 && (
            <Button variant="ghost" size="sm" onClick={handleClear} className="text-muted-foreground">
              Clear all
            </Button>
          )}
        </div>

        {/* Raw input section */}
        <div className="rounded-lg border border-border bg-card p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Raw Account Data To Sort
            </label>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono bg-muted px-1.5 py-0.5 rounded">user:pass:2fasecret</span>
              <span>or</span>
              <span className="font-mono bg-muted px-1.5 py-0.5 rounded">user:pass:2fasecret:email:emailpass</span>
            </div>
          </div>
          <textarea
            ref={textareaRef}
            value={rawText}
            onChange={e => setRawText(e.target.value)}
            placeholder={"whkuf8435:VLteamVrcD9:WPW4UBVLYLZ7JK5SL2JOABZLXIPPK7OV\nmatheuscaldeirakqz:72DvwGQU3H:L3AGCX24VYHM6EU37GO3OD3PLD34DOFY:vamtliam@hotmail.com:ttxq6RVU0S"}
            rows={6}
            className="w-full font-mono text-xs bg-background border border-border rounded-md px-3 py-2 resize-y outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
            spellCheck={false}
          />
          <div className="flex items-center justify-between mt-3">
            <p className="text-[11px] text-muted-foreground">
              One account per line. Each row is auto-detected by field count.
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    setRawText(text);
                  } catch {
                    toast({ title: "Clipboard unavailable", description: "Paste manually into the text box.", variant: "destructive" });
                  }
                }}
                className="h-8 text-xs gap-1.5"
              >
                <ClipboardPaste className="w-3.5 h-3.5" /> Paste
              </Button>
              <Button
                size="sm"
                onClick={handleSortAndAdd}
                disabled={!rawText.trim() || adding}
                className="h-8 text-xs gap-1.5"
              >
                {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Sort & Add
              </Button>
            </div>
          </div>
        </div>

        {/* Staging list */}
        {rows.length > 0 && (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            {/* List toolbar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={allPendingSelected}
                  onCheckedChange={toggleAll}
                  disabled={pendingRows.length === 0}
                />
                <span className="text-xs text-muted-foreground">
                  {rows.length} account{rows.length !== 1 ? "s" : ""} parsed
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs font-medium">
                {adding && <span className="flex items-center gap-1 text-blue-600"><Loader2 className="w-3 h-3 animate-spin" />Adding…</span>}
                {rows.filter(r => r.status === "added").length > 0 && (
                  <span className="text-green-600"><CheckCircle2 className="w-3 h-3 inline mr-0.5" />{rows.filter(r => r.status === "added").length} added</span>
                )}
                {rows.filter(r => r.status === "error").length > 0 && (
                  <span className="text-red-600">{rows.filter(r => r.status === "error").length} failed</span>
                )}
                {pendingRows.length > 0 && !adding && (
                  <span className="text-muted-foreground">{pendingRows.length} pending</span>
                )}
              </div>
            </div>

            {/* Column headers */}
            <div className="grid grid-cols-[20px_180px_140px_180px_200px_130px_90px_60px] gap-x-3 px-4 py-2 border-b border-border bg-muted/20 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              <div />
              <div>Username</div>
              <div>Password</div>
              <div>2FA Secret</div>
              <div>Email</div>
              <div>Email Pass</div>
              <div>Status</div>
              <div />
            </div>

            {/* Rows */}
            <div className="divide-y divide-border/30 max-h-[520px] overflow-y-auto">
              {rows.map((row, idx) => {
                const isSelected = selectedIds.has(row.id);
                const isPending = row.status === "pending";
                const isEven = idx % 2 === 1;
                return (
                  <div
                    key={row.id}
                    className={`grid grid-cols-[20px_180px_140px_180px_200px_130px_90px_60px] gap-x-3 px-4 py-1.5 items-center transition-colors ${
                      isSelected && isPending
                        ? "bg-primary/8"
                        : row.status === "added"
                        ? "opacity-50"
                        : isEven
                        ? "bg-slate-50/60"
                        : "bg-white"
                    }`}
                  >
                    {/* Checkbox */}
                    <div>
                      <Checkbox
                        checked={isSelected && isPending}
                        disabled={!isPending}
                        onCheckedChange={() => isPending && toggleRow(row.id)}
                      />
                    </div>

                    {/* Username */}
                    <div className="min-w-0">
                      <span className="inline-flex items-center gap-1 text-xs font-semibold truncate">
                        <Instagram className="w-3 h-3 text-muted-foreground shrink-0" />
                        {row.username || <span className="text-red-500 italic">missing</span>}
                      </span>
                    </div>

                    {/* Password */}
                    <div className="min-w-0">
                      <MaskedCell value={row.password} placeholder="no password" />
                    </div>

                    {/* 2FA Secret */}
                    <div className="min-w-0">
                      <MaskedCell value={row.twoFASecret} placeholder="no 2FA" />
                    </div>

                    {/* Email */}
                    <div className="min-w-0">
                      {row.email
                        ? <span className="text-xs truncate block max-w-[190px]">{row.email}</span>
                        : <span className="text-muted-foreground/40 text-xs italic">no email</span>
                      }
                    </div>

                    {/* Email Password */}
                    <div className="min-w-0">
                      <MaskedCell value={row.emailPassword} placeholder="no email pass" />
                    </div>

                    {/* Status */}
                    <div>
                      <StatusBadge row={row} />
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 justify-end">
                      {isPending && (
                        <button
                          onClick={() => handleAddRow(row.id)}
                          disabled={adding}
                          className="text-[10px] font-semibold text-blue-600 hover:text-blue-800 disabled:opacity-40 transition-colors whitespace-nowrap"
                          title="Add this account"
                        >
                          Add
                        </button>
                      )}
                      {isPending && (
                        <button
                          onClick={() => removeRow(row.id)}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                          title="Remove row"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer summary */}
            <div className="px-4 py-2 border-t border-border bg-muted/20 flex items-center gap-4 text-[11px] text-muted-foreground">
              {(() => {
                const added = rows.filter(r => r.status === "added").length;
                const errors = rows.filter(r => r.status === "error").length;
                const pending = rows.filter(r => r.status === "pending").length;
                return (
                  <>
                    {pending > 0 && <span>{pending} pending</span>}
                    {added > 0 && <span className="text-green-600 font-medium">{added} added</span>}
                    {errors > 0 && <span className="text-red-600 font-medium">{errors} error{errors !== 1 ? "s" : ""}</span>}
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* Empty state */}
        {rows.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-card/50 flex flex-col items-center justify-center py-20 text-center">
            <Instagram className="w-10 h-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No accounts sorted yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Paste credential lines above and click "Sort & Add"</p>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
