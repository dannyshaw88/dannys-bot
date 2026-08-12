import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle2, Clipboard, Download, FileSearch, FileText, Upload, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";

type JarveeProfile = Record<string, string | string[] | undefined>;

const FIELDS: Array<[string, string]> = [
  ["username", "Username"], ["password", "Password"], ["email", "Email address"], ["emailPassword", "Email password"],
  ["description", "Description"],
  ["proxyHost", "Proxy host"], ["proxyPort", "Proxy port"], ["proxyUsername", "Proxy username"],
  ["proxyPassword", "Proxy password"], ["twoFASecretKey", "2FA secret key"], ["backupCodes", "Backup codes"],
  ["phoneNumber", "Phone number"], ["userAgentApi", "API user agent"], ["userAgentEmbedded", "Embedded browser user agent"],
  ["deviceId", "Device ID"], ["deviceUuid", "Device UUID"], ["phoneId", "Phone ID"], ["adid", "Advertising ID"],
  ["apiCookies", "API cookies"], ["tags", "Tags"], ["notes", "Notes"], ["accStatus", "Account status"],
  ["followedUsernames", "Followed usernames"],
];

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(binary);
}

export default function JarveeBinaryViewerPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [fileName, setFileName] = useState("");
  const [profiles, setProfiles] = useState<JarveeProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const readFile = async (file?: File) => {
    if (!file) return;
    setError("");
    setFileName(file.name);
    setProfiles([]);
    setLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const isJarveeBinary = bytes[0] === 0xFF && bytes[1] === 0xFE && bytes[2] === 0xFF && bytes[3] === 0xFF && bytes[4] === 0xFF;
      if (isJarveeBinary) {
        const response = await fetch("/api/profiles/parse-jarvee", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileBase64: encodeBase64(bytes) }),
        });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.profiles) || data.profiles.length === 0) {
          throw new Error(data.error ?? "No account information was found in this Jarvee file.");
        }
        setProfiles(data.profiles);
      } else {
        const encoding = bytes[0] === 0xFF && bytes[1] === 0xFE ? "utf-16le" : bytes[0] === 0xFE && bytes[1] === 0xFF ? "utf-16be" : "utf-8";
        const text = new TextDecoder(encoding).decode(buffer);
        const lines = text.split(/\r?\n/).filter(line => line.trim());
        const headers = (lines.shift() ?? "").split(/\t|,/).map(value => value.trim());
        const parsed = lines.map(line => {
          const values = line.split(/\t|,/);
          return Object.fromEntries(headers.map((header, index) => [header || `Column ${index + 1}`, values[index]?.trim() ?? ""]));
        }).filter(row => Object.values(row).some(Boolean));
        if (!parsed.length) throw new Error("No readable account information was found in this file.");
        setProfiles(parsed);
      }
    } catch {
      setProfiles([]);
      setError("No readable Jarvee account information was found in this file.");
    } finally {
      setLoading(false);
    }
  };

  const getExportText = () => profiles.map((profile, index) => [
    `Account ${index + 1}`,
    ...FIELDS.map(([key, label]) => `${label}: ${Array.isArray(profile[key]) ? profile[key].join("\n") : profile[key] ?? ""}`),
  ].join("\n")).join("\n\n" + "=".repeat(72) + "\n\n");

  const copyText = async () => {
    const output = getExportText();
    await navigator.clipboard.writeText(output);
    toast({ title: "Text copied to clipboard" });
  };

  const copyField = async (label: string, value: string | string[] | undefined) => {
    const text = Array.isArray(value) ? value.join("\n") : value ?? "";
    if (!text) return;
    await navigator.clipboard.writeText(text);
    toast({ title: `${label} copied to clipboard` });
  };

  const exportTextFile = () => {
    const blob = new Blob([getExportText() + "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const baseName = fileName.replace(/\.[^/.]+$/, "") || "jarvee-account-details";
    anchor.download = `${baseName}-details.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast({ title: "Export downloaded", description: "The extracted Jarvee details were saved as a text file." });
  };

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto pb-10">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2.5 rounded-xl bg-primary/10 text-primary"><FileSearch className="w-5 h-5" /></div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Import Jarvee Binary File</h1>
            <p className="text-sm text-muted-foreground mt-1">Temporary reader — inspect a Jarvee profile file without importing accounts.</p>
          </div>
        </div>

        <div className="desktop-card p-6 mb-5">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary"><Upload className="w-4 h-4" /></div>
            <div className="flex-1">
              <h2 className="text-sm font-semibold">Choose a Jarvee binary file</h2>
              <p className="text-xs text-muted-foreground mt-1">The file is read locally and converted to text. Nothing is saved, uploaded, or added to Accounts.</p>
              <input ref={inputRef} type="file" className="hidden" onChange={e => void readFile(e.target.files?.[0])} />
              <div className="flex items-center gap-3 mt-4">
                <Button onClick={() => inputRef.current?.click()}><Upload className="w-4 h-4 mr-2" />Browse</Button>
                {fileName && <span className="text-sm text-foreground truncate">{fileName}</span>}
              </div>
            </div>
          </div>
          {error && <div className="mt-4 flex items-center gap-2 text-sm text-destructive"><AlertCircle className="w-4 h-4" />{error}</div>}
          {fileName && !error && !loading && <div className="mt-4 flex items-center gap-2 text-xs text-emerald-600"><CheckCircle2 className="w-4 h-4" />Account data extracted — display only; no account import occurred.</div>}
        </div>

        <div className="desktop-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2"><FileText className="w-4 h-4 text-primary" /><h2 className="text-sm font-semibold">Jarvee account information</h2></div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={!profiles.length} onClick={() => void copyText()}><Clipboard className="w-3.5 h-3.5 mr-1.5" />Copy text</Button>
              <Button variant="outline" size="sm" disabled={!profiles.length} onClick={exportTextFile}><Download className="w-3.5 h-3.5 mr-1.5" />Export .txt</Button>
            </div>
          </div>
          {loading ? (
            <div className="py-20 flex justify-center items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Extracting account information…</div>
          ) : !profiles.length ? (
            <div className="py-20 text-center text-sm text-muted-foreground">Browse for a Jarvee file to view usernames, passwords, email addresses, proxies, 2FA, cookies, and device information here.</div>
          ) : (
            <div className="p-5 space-y-5">
              {profiles.map((profile, index) => (
                <div key={index} className="rounded-lg border border-border overflow-hidden">
                  <div className="px-4 py-3 bg-muted/40 text-sm font-semibold">Account {index + 1}{profile.username ? ` — ${profile.username}` : ""}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border">
                    {FIELDS.map(([key, label]) => (
                      <div key={key} className="bg-background px-4 py-3 min-w-0">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
                        {key === "followedUsernames" ? (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-sm text-primary font-medium">
                              {Array.isArray(profile[key]) ? `${profile[key].length} usernames` : "View usernames"}
                            </summary>
                            <div className="mt-2 max-h-64 overflow-auto rounded border border-border bg-muted/30 p-2 text-sm text-foreground whitespace-pre-line">
                              {Array.isArray(profile[key]) ? profile[key].join("\n") : profile[key] || "No data extracted"}
                            </div>
                          </details>
                        ) : (
                          <div className="mt-1 flex items-start gap-2">
                            <div className="min-w-0 flex-1 text-sm text-foreground break-all whitespace-pre-wrap">
                              {Array.isArray(profile[key]) ? profile[key].join("\n") : profile[key] || "No data extracted"}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-primary"
                              title={`Copy ${label}`}
                              aria-label={`Copy ${label}`}
                              disabled={!profile[key] || (Array.isArray(profile[key]) && profile[key].length === 0)}
                              onClick={() => void copyField(label, profile[key])}
                            >
                              <Clipboard className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}