import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Clock, User, Zap } from "lucide-react";
import { format } from "date-fns";
import { type Profile } from "@shared/schema";

export function Dashboard() {
  const { data: apiCalls, isLoading } = useQuery<any[]>({
    queryKey: ["/api/instagram-api-calls"],
    refetchInterval: 5000,
  });

  const { data: profiles } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
  });

  const getUsername = (profileId: number) =>
    profiles?.find(p => p.id === profileId)?.username || `ID: ${profileId}`;

  return (
    <AppLayout>
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Live view of all Instagram API calls made by the automation engine.</p>
      </div>

      <Card className="desktop-card border-none shadow-sm">
        <CardHeader className="border-b border-border/50 bg-muted/5">
          <CardTitle className="text-lg flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" /> API Call Log
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto max-h-[70vh]">
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
                <tr>
                  <th className="px-6 py-4 font-bold bg-muted/30 whitespace-nowrap">Timestamp</th>
                  <th className="px-6 py-4 font-bold bg-muted/30 whitespace-nowrap">Account</th>
                  <th className="px-6 py-4 font-bold bg-muted/30 whitespace-nowrap">Operation</th>
                  <th className="px-6 py-4 font-bold bg-muted/30 whitespace-nowrap">Duration</th>
                  <th className="px-6 py-4 font-bold bg-muted/30 w-full">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td colSpan={5} className="px-6 py-4 bg-muted/10 h-12" />
                    </tr>
                  ))
                ) : !apiCalls || apiCalls.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                      <Activity className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
                      <p className="text-sm font-medium">No API calls recorded yet</p>
                      <p className="text-xs mt-1">Start an automation tool to see activity here.</p>
                    </td>
                  </tr>
                ) : (
                  apiCalls.map((call: any) => (
                    <tr key={call.id} className="hover:bg-accent/5 transition-colors">
                      <td className="px-6 py-3.5 whitespace-nowrap text-muted-foreground text-xs font-mono">
                        <span className="flex items-center gap-1.5">
                          <Clock className="w-3 h-3 shrink-0" />
                          {format(new Date(call.date), "MMM d, HH:mm:ss")}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 font-medium text-foreground whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <User className="w-3.5 h-3.5 text-primary" />
                          {getUsername(call.profileId)}
                        </div>
                      </td>
                      <td className="px-6 py-3.5 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-wider">
                          {call.operationName}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 whitespace-nowrap text-xs text-muted-foreground font-mono">
                        {call.durationMs != null ? `${call.durationMs}ms` : "—"}
                      </td>
                      <td className="px-6 py-3.5 text-foreground leading-relaxed">
                        {call.message || "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </AppLayout>
  );
}
