import type { Dispatch, ReactNode, SetStateAction } from "react";
/** Contract for the complete Make a Post editor. Keeping this boundary separate
 * allows its history, caption and image controls to evolve independently. */
export interface HumanSessionMakePostSectionProps { settings:Record<string,any>; setSettings:Dispatch<SetStateAction<Record<string,any>>>; children?:ReactNode; }
export function HumanSessionMakePostSection({children}:HumanSessionMakePostSectionProps) { return <>{children}</>; }