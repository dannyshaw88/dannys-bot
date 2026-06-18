import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Props {
  open: boolean;
  proxyDisplay: string;
  minutesAgo: number;
  onCancel: () => void;
  onContinue: () => void;
}

export function LoginRateLimitDialog({ open, proxyDisplay, minutesAgo, onCancel, onContinue }: Props) {
  const isNewAccountLimit = minutesAgo === 0;
  const remaining = Math.max(0, 90 - minutesAgo);
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            IP Login Rate Limit Warning
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {isNewAccountLimit ? (
            <>
              <p>
                <span className="font-semibold">{proxyDisplay}</span> has already been used to verify{" "}
                <span className="font-semibold text-amber-600 dark:text-amber-400">3 new accounts today</span>.
              </p>
              <p className="text-muted-foreground">
                Instagram allows roughly <span className="font-semibold text-foreground">3 new account logins per IP per 24 hours</span>.
                Adding a 4th new account on this IP today may increase the risk of login flags.
                Accounts you have already verified here are not affected.
              </p>
            </>
          ) : (
            <>
              <p>
                <span className="font-semibold">{proxyDisplay}</span> was used for a login{" "}
                <span className="font-semibold text-amber-600 dark:text-amber-400">{minutesAgo} minute{minutesAgo !== 1 ? "s" : ""} ago</span>.
              </p>
              <p className="text-muted-foreground">
                Instagram appears to allow only <span className="font-semibold text-foreground">1–2 logins per 90 minutes per IP</span>.
                Each verify counts as 1 login (browser + mobile API together).
                Proceeding now may burn this account.
              </p>
              {remaining > 0 && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                  <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    Safe to retry in <span className="font-bold">{remaining} min</span>
                  </span>
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onContinue}>Continue Anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
