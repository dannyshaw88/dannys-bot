import {
  ChevronLeft,
  Home,
  Power,
  Keyboard,
  ImagePlus,
  Wifi,
  Search,
  Bell,
  Heart,
  MessageCircle,
  UserCircle,
  MoreHorizontal,
  Camera,
  Instagram,
  Smartphone,
} from "lucide-react";

/**
 * Visual-only phone mirror used by TrustScore detail settings.
 * It intentionally has no device props, event handlers, or API calls.
 */
export function FakeTrustScoreMirror({ trustScoreLabel }: { trustScoreLabel?: string }) {
  return (
    <div className="lg:sticky lg:top-4 self-start w-full max-w-[340px] mx-auto">
      <div className="mb-2 flex items-center justify-between px-1">
        <div>
          <p className="text-xs font-semibold text-foreground">Device Mirror</p>
          <p className="text-[10px] text-muted-foreground">
            Preview only · {trustScoreLabel ?? "not connected"}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
          Offline
        </span>
      </div>

      <div
        aria-label="Fake phone mirror preview"
        className="pointer-events-none flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-zinc-900 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-mono text-[9px] text-white/25">S1</span>
            <span className="truncate text-[10px] font-semibold text-white/75">Fake Android Device</span>
            <span className="shrink-0 text-[9px] text-white/30">A13</span>
          </div>
          <span className="shrink-0 text-[9px] font-mono text-white/25">preview</span>
        </div>

        <div className="relative aspect-[9/16] overflow-hidden bg-[#101114] text-white">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_75%_15%,rgba(26,210,242,0.18),transparent_34%),linear-gradient(155deg,#111827_0%,#0f172a_46%,#080b12_100%)]" />

          <div className="relative flex h-full flex-col">
            <div className="flex items-center justify-between px-3 pt-2 text-[8px] text-white/70">
              <span>9:41</span>
              <div className="flex items-center gap-1.5">
                <Wifi className="h-2.5 w-2.5" />
                <span className="h-2 w-3.5 rounded-[2px] border border-white/60 p-px">
                  <span className="block h-full w-2/3 rounded-[1px] bg-white/70" />
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between border-b border-white/10 px-3 py-3">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan-400/20 text-cyan-300">
                  <Instagram className="h-4 w-4" />
                </div>
                <span className="text-[13px] font-bold tracking-tight">Instagram</span>
              </div>
              <div className="flex items-center gap-2 text-white/70">
                <Heart className="h-3.5 w-3.5" />
                <MessageCircle className="h-3.5 w-3.5" />
                <Camera className="h-3.5 w-3.5" />
              </div>
            </div>

            <div className="flex items-center gap-2 px-3 py-3">
              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-cyan-300 via-blue-500 to-violet-600 p-[2px]">
                <div className="flex h-full w-full items-center justify-center rounded-full bg-zinc-900">
                  <UserCircle className="h-4 w-4 text-white/80" />
                </div>
              </div>
              <div className="h-1.5 w-20 rounded-full bg-white/70" />
              <div className="ml-auto h-1.5 w-8 rounded-full bg-white/20" />
            </div>

            <div className="mx-3 overflow-hidden rounded-xl border border-white/10 bg-white/[0.07]">
              <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <div className="h-5 w-5 rounded-full bg-cyan-300/30" />
                  <div className="h-1.5 w-14 rounded-full bg-white/55" />
                </div>
                <MoreHorizontal className="h-3.5 w-3.5 text-white/50" />
              </div>
              <div className="flex aspect-square items-center justify-center bg-gradient-to-br from-cyan-500/20 via-blue-500/10 to-violet-500/20">
                <div className="rounded-full border border-cyan-300/30 bg-cyan-300/10 p-7">
                  <Smartphone className="h-8 w-8 text-cyan-200/70" />
                </div>
              </div>
              <div className="flex items-center gap-3 px-3 py-2 text-white/70">
                <Heart className="h-4 w-4" />
                <MessageCircle className="h-4 w-4" />
                <span className="ml-auto h-1.5 w-16 rounded-full bg-white/20" />
              </div>
            </div>

            <div className="mt-auto px-3 pb-4 pt-4">
              <div className="mb-2 flex items-center gap-2 text-[9px] text-white/45">
                <Search className="h-3 w-3" />
                <span>Search</span>
                <Bell className="ml-auto h-3 w-3" />
              </div>
              <div className="h-1.5 w-24 rounded-full bg-white/25" />
              <div className="mt-1.5 h-1.5 w-36 rounded-full bg-white/10" />
            </div>
          </div>

          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/25 px-3 py-1 text-[8px] font-medium text-white/40">
            Fake mirror preview
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-white/10 bg-zinc-900 px-2 py-2">
          {[
            { icon: <ChevronLeft className="h-3.5 w-3.5" />, label: "Back" },
            { icon: <ImagePlus className="h-3.5 w-3.5" />, label: "Image" },
            { icon: <Home className="h-3.5 w-3.5" />, label: "Home" },
          ].map(control => (
            <div key={control.label} className="flex min-w-[38px] flex-col items-center gap-0.5 text-white/35">
              {control.icon}
              <span className="text-[7px]">{control.label}</span>
            </div>
          ))}
          <div className="mx-1 h-4 w-px bg-white/10" />
          <div className="flex min-w-[38px] flex-col items-center gap-0.5 text-white/35">
            <Power className="h-3 w-3" />
            <span className="text-[7px]">Power</span>
          </div>
          <div className="mx-1 h-4 w-px bg-white/10" />
          <div className="flex min-w-[38px] flex-col items-center gap-0.5 text-white/35">
            <Keyboard className="h-3 w-3" />
            <span className="text-[7px]">Keyboard</span>
          </div>
        </div>
      </div>
    </div>
  );
}