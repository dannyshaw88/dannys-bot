import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { ChevronDown, ChevronUp, BookOpen, Zap, Shield, Users, Bot, Settings, HelpCircle, Download } from "lucide-react";

const FAQ_SECTIONS = [
  {
    icon: Zap,
    title: "Getting Started",
    color: "text-blue-500",
    bg: "bg-blue-500/10",
    items: [
      {
        q: "What is Equinox?",
        a: "Equinox is a Windows desktop Instagram automation dashboard. It manages multiple Instagram accounts at once and automates growth actions — follows, unfollows, DMs, likes, story views, and human browsing sessions — entirely through the Instagram Private Mobile API (the same API Instagram's own app uses). No browser scraping, no Puppeteer bots, just clean mobile API calls.",
      },
      {
        q: "How do I add my first account?",
        a: "Click Create an Account in the left sidebar. Enter a username and password at minimum. For best results, also add: a Proxy (host, port, credentials), an API User Agent from your device or Jarvee export, and your 2FA secret key if the account uses two-factor authentication. Click Save. The account appears in the Accounts page.",
      },
      {
        q: "How do I import accounts from Jarvee?",
        a: "Go to the Accounts page and click the Import button in the top-right toolbar. Drag and drop your Jarvee .txt export file (UTF-16 LE tab-separated). Equinox reads all columns including Username, Password, Proxy, API User Agent, Device ID, UUID, Phone ID, ADID, 2FA Secret Key, and ApiCookies. A preview table shows what was found before you confirm. Click Import to create or update all profiles in one go.",
      },
      {
        q: "How do I update Equinox?",
        a: "Equinox checks for updates automatically each time it launches. When a new version is available it downloads silently in the background and installs on next restart. You will see a notification in the title bar when an update is ready. You can also download the latest installer manually from the GitHub Releases page.",
      },
      {
        q: "Where is my data stored?",
        a: "All data (accounts, settings, stats, action logs) is stored in a SQLite database inside your Windows user data folder — typically C:\\Users\\YourName\\AppData\\Roaming\\Equinox\\database.db. Your data is never uploaded anywhere. The database persists across installs and updates.",
      },
    ],
  },
  {
    icon: Users,
    title: "Account Management",
    color: "text-emerald-500",
    bg: "bg-emerald-500/10",
    items: [
      {
        q: "What does Verify Account do?",
        a: "Verify checks that the account's mobile API session is still valid. It attempts a lightweight authenticated request using the stored mobile session cookies (igApiCookies). If the session is valid the account turns green. If not, it re-authenticates using the username and password. If Instagram requires a challenge (CAPTCHA, email/SMS code) the embedded browser opens automatically so you can complete it manually.",
      },
      {
        q: "Why is my account showing Invalid Session?",
        a: "This means the stored mobile session cookies have expired or been invalidated by Instagram. Open the account, click Verify, and complete any challenge that appears in the browser window. Once you pass the challenge the session is refreshed and automation resumes. If the account is frequently going invalid, check your proxy — a changing or shared IP triggers session invalidation.",
      },
      {
        q: "What is Fix Captcha?",
        a: "Fix Captcha uses the 2captcha.com service to solve Instagram's image challenges automatically without you having to do it manually. Add your 2captcha API key in Settings → 2Captcha. Then select accounts and click Fix Captcha in the Actions menu. Each solved captcha costs a small credit from your 2captcha balance.",
      },
      {
        q: "Can I run multiple accounts on the same proxy?",
        a: "Technically yes, but it is not recommended. Instagram links accounts that share an IP address. If one account on a proxy gets flagged or banned, the others on that proxy face higher risk. Best practice is one residential or mobile proxy per account.",
      },
      {
        q: "What are Tags and how do I use them?",
        a: "Tags are free-form labels you can add to any account (e.g. niche, country, status). They appear in the Accounts table. You can filter and group accounts by tag. Tags are purely organisational — they have no effect on automation.",
      },
    ],
  },
  {
    icon: Bot,
    title: "Tools & Automation",
    color: "text-violet-500",
    bg: "bg-violet-500/10",
    items: [
      {
        q: "How does the Follow Tool work?",
        a: "The Follow Tool follows users from a source list. You configure: Source Accounts (accounts whose followers/followings to scrape), daily follow limits, delay between follows, optional filters (min/max followers, following count, post count), and optionally liking a post or viewing stories before following. The tool runs on a schedule you define — e.g. every 2–4 hours — and stops when the daily cap is reached.",
      },
      {
        q: "How does the Unfollow Tool work?",
        a: "Unfollow Tool removes follows that are older than a configured number of days and optionally skips users who have followed back. You can also upload a whitelist of usernames that are never unfollowed. Unfollows are paced with configurable delays to look natural.",
      },
      {
        q: "What is a Human Session?",
        a: "A Human Session simulates natural mobile browsing behaviour: visiting the notification tray, liking timeline posts, watching stories, browsing the Explore page, and optionally reposting content. It runs on its own schedule and makes the account look like a real active user. This is important for account health — purely follow/unfollow accounts look robotic to Instagram.",
      },
      {
        q: "What is the Contact Tool (DM Tool)?",
        a: "The Contact Tool sends a direct message to every new follower of the account. You write one or more message templates (with spintax support for variety) and set a delay. Each time a new follower is detected the tool queues a DM and sends it after the configured delay.",
      },
      {
        q: "What are Source Accounts?",
        a: "A Source Account is any Instagram username you want the Follow Tool to pull leads from. You can source from: that account's followers list, their followings list, or posts/reels under a hashtag. For each source you can add as many accounts or hashtags as you want. The tool cycles through all sources evenly.",
      },
      {
        q: "What do the tool timers mean?",
        a: "Each tool has a Min and Max run interval (in minutes/hours). After a tool run completes, the next run is scheduled at a random time within that window. This randomisation makes the automation look more natural. Shorter windows = more frequent runs. The Accounts page shows an estimated items/hour rate and the exact time of the next scheduled run.",
      },
      {
        q: "How do I use Spintax in messages?",
        a: "Spintax lets you write one template that produces different outputs each time. Use curly braces with pipe separators: {Hello|Hi|Hey} {there|friend|!}. Equinox picks one option from each group at random, so recipients see a different variation. This reduces the chance of Instagram flagging repeated identical messages.",
      },
    ],
  },
  {
    icon: Shield,
    title: "Proxies",
    color: "text-orange-500",
    bg: "bg-orange-500/10",
    items: [
      {
        q: "What type of proxy should I use?",
        a: "Mobile 4G/LTE proxies are the gold standard for Instagram — they use IP addresses from real mobile carriers which Instagram trusts most. Residential rotating proxies are a good second choice. Datacenter proxies work but carry higher risk. Never use shared or free proxies.",
      },
      {
        q: "How do I add proxies?",
        a: "Go to Proxy Manager in the left sidebar. Click Add Proxy and fill in Host, Port, and optionally Username and Password. You can also bulk-import proxies by pasting a list in host:port or host:port:user:pass format. Once added, open each account and assign a proxy from the dropdown.",
      },
      {
        q: "What does the proxy health check do?",
        a: "The health check sends a test request through each proxy and measures latency. Green = working, Red = unreachable or blocked. Run it before starting automation to catch bad proxies early.",
      },
    ],
  },
  {
    icon: Settings,
    title: "Settings & Data",
    color: "text-slate-500",
    bg: "bg-slate-500/10",
    items: [
      {
        q: "What is HikerAPI and do I need it?",
        a: "HikerAPI is a third-party Instagram data API used for follower/following scraping and user lookups. When enabled in Settings, all data-fetch operations (finding users to follow, resolving usernames, checking profiles) go through HikerAPI instead of using your accounts' own session requests. This protects your accounts from scraping-related rate limits and bans. It is highly recommended for any serious multi-account setup. Add your API token from hikerapi.com in Settings → HikerAPI.",
      },
      {
        q: "What is the Skip Followed Users setting?",
        a: "When enabled, a user that any of your accounts has ever followed will never be followed again by any other account. This prevents multiple accounts from repeatedly following the same person. The global follow history is stored in the database.",
      },
      {
        q: "How do I back up my database?",
        a: "In Settings → Data & Backup, click Create Backup. This saves a timestamped copy of database.db to your chosen backup folder. You can restore any backup from the same page. Automating backups via Windows Task Scheduler is also possible — just copy the database.db file from the userData folder on a schedule.",
      },
      {
        q: "How do I export accounts?",
        a: "On the Accounts page, select the accounts you want to export (or select all), then click Actions → Export Selected. This downloads a CSV file you can open in Excel or re-import into another Equinox installation.",
      },
    ],
  },
  {
    icon: HelpCircle,
    title: "Safety & Limits",
    color: "text-rose-500",
    bg: "bg-rose-500/10",
    items: [
      {
        q: "What are safe daily limits for follows and unfollows?",
        a: "There is no single universal answer — it depends on account age, trust score, proxy quality, and whether Human Sessions are running. As a starting guideline: new accounts (under 3 months) should stay at 20–30 follows/day and ramp up slowly over weeks. Established accounts (1+ year, active history) can handle 80–150/day. Always start low, monitor for action blocks, and increase gradually.",
      },
      {
        q: "What happens if I get an action block?",
        a: "The engine detects action blocks automatically and pauses that specific action for the account. You will see a Blocked log entry in the Activity Log. The account continues running other tools. Action blocks typically lift within 24–48 hours. If blocks are frequent, reduce your daily limits, improve your proxy, or increase delays between actions.",
      },
      {
        q: "Will Instagram ban my account?",
        a: "Any automation carries some risk. Equinox is designed to minimise that risk by using the mobile API (same as the real app), running Human Sessions to simulate natural behaviour, randomising delays, and enforcing configurable limits. Accounts on quality mobile proxies with conservative limits and active Human Sessions have the lowest ban risk. Never use datacenter proxies or very high daily limits on new accounts.",
      },
      {
        q: "Is Equinox detectable by Instagram?",
        a: "Equinox uses Instagram's Private Mobile API — the exact same endpoints as the official Instagram app. Each account sends requests with its own device fingerprint (User Agent, Device ID, UUID, Phone ID, ADID) so traffic looks like a real phone. Human Sessions further normalise behaviour. The main detection risk comes from unnatural patterns (too many actions, no browsing, proxy quality) rather than the API calls themselves.",
      },
    ],
  },
];

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border/60 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-start justify-between gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      >
        <span className="text-sm font-medium text-foreground leading-snug">{q}</span>
        {open
          ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        }
      </button>
      {open && (
        <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed border-t border-border/40 pt-3">
          {a}
        </div>
      )}
    </div>
  );
}

export function ReadmePage() {
  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto pb-12">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-xl bg-primary/10 text-primary">
              <BookOpen className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">README &amp; FAQ</h1>
              <p className="text-sm text-muted-foreground">Everything you need to know to get started and get the most out of Equinox.</p>
            </div>
          </div>
        </div>

        {/* What is Equinox */}
        <div className="desktop-card p-6 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Zap className="w-4 h-4" />
            </div>
            <h2 className="text-base font-semibold">About Equinox</h2>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed mb-3">
            <strong className="text-foreground">Equinox</strong> is a Windows desktop Instagram automation dashboard built for professionals managing multiple accounts. It handles follows, unfollows, direct messages, likes, story views, and human browsing sessions — all through Instagram's own Private Mobile API. This means every request looks exactly like it came from a real phone running the Instagram app.
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed mb-3">
            The embedded browser (which you see when fixing challenges) is <strong className="text-foreground">never used for automation</strong>. It exists solely so you can manually complete verification challenges (CAPTCHA, email/SMS codes) when Instagram requires them. All actual bot work goes through the mobile API.
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Equinox stores everything locally on your machine — no cloud, no subscriptions, no data sent anywhere. Your accounts, sessions, stats, and logs live in a single SQLite database on your PC that you fully own and control.
          </p>

          <div className="grid grid-cols-3 gap-3 mt-5">
            {[
              { icon: Bot,      label: "Mobile API Only",      desc: "i.instagram.com — same as the real app" },
              { icon: Shield,   label: "Local & Private",      desc: "No cloud sync, all data stays on your PC" },
              { icon: Download, label: "Auto-Updates",         desc: "Silent updates via GitHub Releases" },
            ].map(({ icon: Icon, label, desc }) => (
              <div key={label} className="bg-muted/30 rounded-xl p-4 border border-border/50 text-center">
                <Icon className="w-5 h-5 text-primary mx-auto mb-2" />
                <p className="text-xs font-semibold text-foreground mb-1">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Quick-Start */}
        <div className="desktop-card p-6 mb-6">
          <h2 className="text-base font-semibold mb-4">Quick-Start Checklist</h2>
          <ol className="space-y-2">
            {[
              "Add at least one proxy in Proxy Manager (mobile or residential recommended)",
              "Create an account — paste username, password, and assign the proxy",
              "Click Verify Account to establish a mobile API session",
              "Add your HikerAPI token in Settings if you have one (strongly recommended)",
              "Open the account → Follow Tool → add a Source Account and set daily limits",
              "Enable the Follow Tool toggle — the first run starts immediately",
              "Enable the Human Session tool to simulate natural browsing alongside automation",
              "Watch the Dashboard → Activity Log to confirm actions are running",
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-muted-foreground">
                <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>

        {/* FAQ Sections */}
        <div className="space-y-6">
          {FAQ_SECTIONS.map(({ icon: Icon, title, color, bg, items }) => (
            <div key={title} className="desktop-card p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className={`p-2 rounded-lg ${bg} ${color}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <h2 className="text-base font-semibold">{title}</h2>
              </div>
              <div className="space-y-2">
                {items.map(({ q, a }) => (
                  <FAQItem key={q} q={q} a={a} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
