import { useState, useRef, useCallback } from "react";
import { Upload, FileText, CheckCircle2, XCircle, Loader2, AlertTriangle, X } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";

interface ParsedProfile {
  accountLabel: string;
  username: string;
  password: string;
  email: string;
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  proxyPassword: string;
  userAgentEmbedded: string;
  userAgentApi: string;
  tags: string;
  dateOfBirth: string;
  notes: string;
  phoneNumber: string;
  twoFASecretKey: string;
  backupCodes: string;
  emailValidationUsername: string;
  emailValidationPassword: string;
  emailValidationPop3Server: string;
  emailValidationPort: string;
}

// Map Jarvee column headers (lowercased, # stripped) to our field names
const COLUMN_MAP: Record<string, keyof ParsedProfile> = {
  "name":                        "accountLabel",
  "email/username":              "email",
  "password":                    "password",
  "proxy username":              "proxyUsername",
  "proxy password":              "proxyPassword",
  "tags":                        "tags",
  "date of birth(us format)":    "dateOfBirth",
  "eb user agent":               "userAgentEmbedded",
  "api user agent":              "userAgentApi",
  "username":                    "username",
  "notes":                       "notes",
  "phone number":                "phoneNumber",
  "2fa secret key":              "twoFASecretKey",
  "backup codes":                "backupCodes",
  "backup codes ":               "backupCodes",
  "email validation username":   "emailValidationUsername",
  "email validation pass":       "emailValidationPassword",
  "email validation pop3server": "emailValidationPop3Server",
  "email validation port":       "emailValidationPort",
};

/**
 * Parse a TSV/tab-delimited file with proper RFC-4180-style quoted cell support.
 * Jarvee wraps multi-line cells (e.g. description) in double-quotes with embedded
 * newlines — a naive line-split breaks those into hundreds of extra "lines".
 */
function parseTSVRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuote = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuote = false;
          i++;
        }
      } else {
        cell += ch;
        i++;
      }
      continue;
    }

    if (ch === '"') { inQuote = true; i++; continue; }
    if (ch === '\t') { row.push(cell); cell = ""; i++; continue; }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = "";
      if (row.some(c => c.trim())) rows.push(row);
      row = [];
      i++;
      continue;
    }

    cell += ch;
    i++;
  }

  // flush last row
  row.push(cell);
  if (row.some(c => c.trim())) rows.push(row);

  return rows;
}

function parseJarveeFile(text: string): ParsedProfile[] {
  const clean = text.startsWith("\ufeff") ? text.slice(1) : text;
  const rows = parseTSVRows(clean);
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/^#/, ""));
  const results: ParsedProfile[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const row: any = {
      accountLabel: "", username: "", password: "", email: "",
      proxyHost: "", proxyPort: "",
      proxyUsername: "", proxyPassword: "", userAgentEmbedded: "", userAgentApi: "",
      tags: "", dateOfBirth: "", notes: "", phoneNumber: "", twoFASecretKey: "",
      backupCodes: "", emailValidationUsername: "", emailValidationPassword: "",
      emailValidationPop3Server: "", emailValidationPort: "",
    };

    headers.forEach((header, idx) => {
      const val = (cells[idx] || "").trim();

      if (header === "proxy-url/proxy-ip:port" || header === "proxy url/proxy ip:port") {
        const match = val.match(/^(.+):(\d+)$/);
        if (match) { row.proxyHost = match[1]; row.proxyPort = match[2]; }
        else if (val) row.proxyHost = val;
        return;
      }

      const field = COLUMN_MAP[header];
      if (field) row[field] = val;
    });

    if (!row.username && row.email && !row.email.includes("@")) {
      row.username = row.email;
      row.email = "";
    }

    if (row.username || row.email) results.push(row as ParsedProfile);
  }

  return results;
}

interface ImportResult {
  success: boolean;
  username: string;
  error?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportProfilesDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedProfile[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);

  const reset = () => {
    setParsed(null);
    setFileName("");
    setResults(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFile = useCallback((file: File) => {
    setFileName(file.name);
    setResults(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      try {
        const profiles = parseJarveeFile(text);
        if (profiles.length === 0) {
          toast({ title: "No profiles found", description: "The file appears empty or has an unsupported format.", variant: "destructive" });
          setParsed(null);
        } else {
          setParsed(profiles);
        }
      } catch {
        toast({ title: "Parse error", description: "Could not read the file. Make sure it's a Jarvee export.", variant: "destructive" });
      }
    };
    // Try UTF-16 LE (Jarvee default), fall back gracefully
    reader.readAsText(file, "UTF-16LE");
  }, [toast]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleImport = async () => {
    if (!parsed || parsed.length === 0) return;
    setImporting(true);
    try {
      const res = await fetch("/api/profiles/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profiles: parsed }),
      });
      const data = await res.json();
      setResults(data.results);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      const ok = data.results.filter((r: ImportResult) => r.success).length;
      const fail = data.results.filter((r: ImportResult) => !r.success).length;
      toast({
        title: "Import complete",
        description: `${ok} imported${fail ? `, ${fail} failed` : ""}`,
        variant: fail > 0 ? "destructive" : "default",
      });
    } catch {
      toast({ title: "Import failed", description: "Server error during import.", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    if (!importing) { reset(); onOpenChange(false); }
  };

  const successCount = results?.filter(r => r.success).length ?? 0;
  const failCount = results?.filter(r => !r.success).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary" /> Import Profiles
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Import accounts from a Jarvee export file (.txt tab-separated, UTF-16 LE).
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4 py-2">
          {/* Drop zone */}
          {!parsed && !results && (
            <div
              className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors ${
                isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              data-testid="dropzone-import"
            >
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                <FileText className="w-7 h-7 text-primary" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-foreground">Drop your Jarvee export here</p>
                <p className="text-sm text-muted-foreground mt-1">or click to browse — .txt / .csv files</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv"
                className="hidden"
                onChange={onFileChange}
                data-testid="input-import-file"
              />
            </div>
          )}

          {/* Preview */}
          {parsed && !results && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-muted-foreground">{fileName}</span>
                  <Badge variant="secondary">{parsed.length} profile{parsed.length !== 1 ? "s" : ""} found</Badge>
                </div>
                <button onClick={reset} className="text-muted-foreground hover:text-foreground transition-colors" data-testid="button-clear-import">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="border border-border rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-60">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">#</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">Username</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">Email</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">Proxy</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">2FA</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">Tags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.map((p, i) => (
                        <tr key={i} className="border-t border-border hover:bg-muted/20">
                          <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                          <td className="px-3 py-2 font-mono font-semibold">{p.username || <span className="text-destructive">—</span>}</td>
                          <td className="px-3 py-2 text-muted-foreground truncate max-w-[120px]">{p.email || "—"}</td>
                          <td className="px-3 py-2 font-mono text-muted-foreground">{p.proxyHost ? `${p.proxyHost}:${p.proxyPort}` : "—"}</td>
                          <td className="px-3 py-2">{p.twoFASecretKey ? <Badge variant="outline" className="text-[10px]">Yes</Badge> : "—"}</td>
                          <td className="px-3 py-2 text-muted-foreground truncate max-w-[100px]">{p.tags || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {parsed.some(p => !p.username) && (
                <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  Some rows have no username and may be skipped during import.
                </div>
              )}
            </div>
          )}

          {/* Results */}
          {results && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                {successCount > 0 && (
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                    <CheckCircle2 className="w-4 h-4" /> {successCount} imported
                  </div>
                )}
                {failCount > 0 && (
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-destructive bg-destructive/5 border border-destructive/20 rounded-lg px-3 py-2">
                    <XCircle className="w-4 h-4" /> {failCount} failed
                  </div>
                )}
              </div>
              {failCount > 0 && (
                <div className="border border-border rounded-xl overflow-hidden">
                  <div className="overflow-auto max-h-48">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2 font-bold text-muted-foreground">Username</th>
                          <th className="text-left px-3 py-2 font-bold text-muted-foreground">Status</th>
                          <th className="text-left px-3 py-2 font-bold text-muted-foreground">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.filter(r => !r.success).map((r, i) => (
                          <tr key={i} className="border-t border-border">
                            <td className="px-3 py-2 font-mono">{r.username}</td>
                            <td className="px-3 py-2"><Badge variant="destructive" className="text-[10px]">Failed</Badge></td>
                            <td className="px-3 py-2 text-muted-foreground">{r.error}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={importing}>
            {results ? "Close" : "Cancel"}
          </Button>
          {parsed && !results && (
            <Button onClick={handleImport} disabled={importing || parsed.length === 0} data-testid="button-confirm-import">
              {importing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing…</> : `Import ${parsed.length} Profile${parsed.length !== 1 ? "s" : ""}`}
            </Button>
          )}
          {results && (
            <Button onClick={reset} variant="outline">
              Import Another File
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
