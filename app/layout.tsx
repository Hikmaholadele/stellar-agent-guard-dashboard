import type { Metadata, Viewport } from "next";
import { DemoBadge } from "../components/DemoBadge.tsx";
import { SecretKeyGuard } from "../components/SecretKeyGuard.tsx";
import { Tabs } from "../components/bits.tsx";
import { AriaAnnouncer } from "../components/AriaAnnouncer.tsx";
import { PwaRegistrar } from "../components/PwaRegistrar.tsx";
import { ThemeProvider } from "../components/ThemeProvider.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { ToastContainer } from "../components/ToastContainer.tsx";
import { UnsavedChangesProvider } from "../components/UnsavedChangesProvider.tsx";
import { PWA_MANIFEST_PATH, PWA_THEME_COLOR } from "../lib/guard/pwa.ts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stellar Agent Guard — operator console",
  description:
    "Configure, watch and freeze stellar-agent-guard smart accounts. Every action is signed in your own wallet and every number is read from the chain.",
  // Ties the document to the web app manifest, which is what makes the page
  // installable as a standalone app on supported browsers.
  manifest: PWA_MANIFEST_PATH,
  applicationName: "Stellar Agent Guard",
  icons: {
    icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
  },
  appleWebApp: {
    capable: true,
    title: "Agent Guard",
    statusBarStyle: "black-translucent",
  },
};

/**
 * `themeColor` lives in the viewport export rather than `metadata` in this
 * version of Next: the browser chrome tint is a viewport concern, and declaring
 * it there is what keeps the installed app's title bar the same dark as the
 * manifest's `theme_color`.
 */
export const viewport: Viewport = {
  themeColor: PWA_THEME_COLOR,
  colorScheme: "dark light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var saved = localStorage.getItem('theme');
                if (saved) {
                  document.documentElement.setAttribute('data-theme', saved);
                } else {
                  var prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
                  document.documentElement.setAttribute('data-theme', prefersLight ? 'light' : 'dark');
                }
              } catch(e) {}
            `,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <PwaRegistrar />
          <AriaAnnouncer />
          <ToastContainer />
          <SecretKeyGuard />
          <UnsavedChangesProvider>
            <div className="shell">
              <DemoBadge />
              <header className="top">
                <div className="brand">
                  <h1>Stellar Agent Guard</h1>
                  <span>operator console</span>
                </div>
                <div className="row">
                  <span className="pill">Soroban testnet</span>
                  <a href="https://github.com/aigbagbobila/stellar-agent-guard-contracts">
                    contracts
                  </a>
                  <a href="https://github.com/aigbagbobila/stellar-agent-guard-sdk">sdk</a>
                </div>
              </header>
              <div
                className="row"
                style={{ justifyContent: "space-between", marginBottom: "16px" }}
              >
                <Tabs />
                <ThemeToggle />
              </div>
              {children}
            </div>
          </UnsavedChangesProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
