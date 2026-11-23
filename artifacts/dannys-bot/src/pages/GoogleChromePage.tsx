import { BrowserPanel } from "@/components/BrowserPanel";

// Reserved synthetic-browser ID, outside the range generated for Phone Farm devices.
// Keep in sync with GOOGLE_CHROME_BROWSER_PROFILE_ID in the API server.
const GOOGLE_CHROME_BROWSER_PROFILE_ID = 10_000_000;

export function GoogleChromeTabContent() {
  return (
    <div className="h-[calc(100vh-190px)] min-h-[480px] w-full">
      <BrowserPanel
        profileId={GOOGLE_CHROME_BROWSER_PROFILE_ID}
        userAgent=""
        username="Google Chrome"
        forceStream
        genericBrowser
      />
    </div>
  );
}
