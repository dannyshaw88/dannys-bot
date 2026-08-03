import { AppLayout } from "@/components/layout/AppLayout";
import { EbProxyAudit } from "@/components/EbProxyAudit";

export function EbAuditPage() {
  return (
    <AppLayout>
      <div className="p-6 max-w-5xl mx-auto">
        <EbProxyAudit />
      </div>
    </AppLayout>
  );
}
