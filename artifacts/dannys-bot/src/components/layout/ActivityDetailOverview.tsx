import type { ComponentType, ReactNode } from "react";
import {
  BarChart2,
  Clapperboard,
  Heart,
  ImagePlus,
  Mail,
  UserPlus,
  Zap,
} from "lucide-react";
import { normalizeActivityDetail } from "./activityDetailUtils";

type ActivityMetric = {
  pattern: RegExp;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  color: string;
};

const ACTIVITY_METRICS: ActivityMetric[] = [
  { pattern: /^\d+\s+follows?\s+done$/i, icon: UserPlus, color: "text-blue-500" },
  { pattern: /^\d+\s+likes?\s+done$/i, icon: Heart, color: "text-rose-500" },
  { pattern: /^\d+\s+DMs$/i, icon: Mail, color: "text-violet-500" },
  { pattern: /^\d+\s+posts?\s+uploaded$/i, icon: ImagePlus, color: "text-fuchsia-500" },
  { pattern: /^\d+\s+feed\s+shares$/i, icon: Zap, color: "text-amber-500" },
  { pattern: /^\d+\s+reels?\s+watched$/i, icon: Clapperboard, color: "text-sky-500" },
  { pattern: /^\d+\s+posts?\s+scrolled$/i, icon: BarChart2, color: "text-teal-500" },
];

function renderMetricPart(part: string, index: number): ReactNode {
  const metric = ACTIVITY_METRICS.find(candidate => candidate.pattern.test(part.trim()));
  if (!metric) return <span key={`detail-${index}`}>{part}</span>;

  const Icon = metric.icon;
  return (
    <span key={`detail-${index}`} className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon className={`w-3.5 h-3.5 shrink-0 ${metric.color}`} aria-hidden />
      <span>{part}</span>
    </span>
  );
}

export function ActivityDetailOverview({
  detail,
  className = "",
}: {
  detail?: string;
  className?: string;
}) {
  const normalized = normalizeActivityDetail(detail);
  if (!normalized) return null;

  const parts = normalized.split(/,\s*/);
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap ${className}`}>
      {parts.map((part, index) => (
        <span key={`part-${index}`} className="inline-flex items-center gap-2">
          {index > 0 && <span className="text-muted-foreground/60">,</span>}
          {renderMetricPart(part, index)}
        </span>
      ))}
    </span>
  );
}