import type { ReactNode } from "react";
import type { Profile, Tool } from "@shared/schema";
import { ContactToolPanel } from "@/components/tools/ContactToolPanel";
export function HumanSessionContactSection({tool,profile,children}:{tool:Tool;profile:Profile;children?:ReactNode}) { if (children) return <>{children}</>; return <div className="mt-[25px] border border-border rounded-xl overflow-hidden">{tool.enabled&&<div className="p-4"><ContactToolPanel tool={tool} profile={profile} embedded/></div>}</div>; }