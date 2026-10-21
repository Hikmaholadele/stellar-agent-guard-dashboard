"use client";

import { useEffect, useState } from "react";
import { DemoBadge } from "./DemoBadge.tsx";
import { Tabs } from "./bits.tsx";
import { AriaAnnouncer } from "./AriaAnnouncer.tsx";
import { ThemeProvider } from "./ThemeProvider.tsx";
import { PrivacyToggle, ThemeToggle } from "./ThemeToggle.tsx";

/**
 * Layout shell providing:
 * - Desktop: Collapsible sidebar (icon-only when collapsed)
 * - Mobile (<768px): Slide-over navigation drawer (hamburger menu)
 * - State persistence in localStorage for both sidebar and drawer
 * - Touch gestures for mobile drawer (swipe to close)
 * - Keyboard focus trapping for accessibility
 */
export function LayoutShell({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);
  const [touchStartY, setTouchStartY] = useState<number | null>(null);

  // Load sidebar state from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("sidebar-collapsed");
    if (saved === "true" || saved === "false") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSidebarCollapsed(saved === "true");
    }
  }, []);

  // Save sidebar state to localStorage when it changes
  useEffect(() => {
    localStorage.setItem("sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // Handle touch gestures for mobile drawer
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1 && e.touches[0]) {
        const touch = e.touches[0];
        setTouchStartX(touch.clientX);
        setTouchStartY(touch.clientY);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (touchStartX !== null && touchStartY !== null && drawerOpen && e.changedTouches[0]) {
        const touch = e.changedTouches[0];
        const diffX = touch.clientX - touchStartX;
        const diffY = touch.clientY - touchStartY;

        // If swipe left (negative diffX) and horizontal movement is greater than vertical
        if (diffX < -50 && Math.abs(diffX) > Math.abs(diffY)) {
          setDrawerOpen(false);
        }
      }
    };

    window.addEventListener("touchstart", handleTouchStart);
    window.addEventListener("touchend", handleTouchEnd);

    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, [drawerOpen, touchStartX, touchStartY]);

  // Handle escape key to close drawer
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drawerOpen) {
        e.preventDefault();
        setDrawerOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [drawerOpen]);

  // Determine if we're on mobile (width < 768px)
  const isMobile = typeof window !== "undefined" ? window.innerWidth < 768 : false;

  // Handle resize to close drawer when going from mobile to desktop
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768 && drawerOpen) {
        setDrawerOpen(false);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [drawerOpen]);

  return (
    <>
      <ThemeProvider>
        <AriaAnnouncer />
        <div className="shell">
          {/* Mobile-only hamburger menu button */}
          {isMobile && (
            <div className="mobile-header">
              <div className="brand">
                <h1>Stellar Agent Guard</h1>
                <span>operator console</span>
              </div>
              <button
                className="secondary"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation menu"
                aria-controls="mobile-drawer"
                aria-expanded={drawerOpen}
              >
                ☰
              </button>
            </div>
          )}

          {/* Desktop header */}
          {!isMobile && (
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
          )}

          {/* Desktop sidebar / Mobile drawer content */}
          <div className={`sidebar-container ${sidebarCollapsed ? "collapsed" : ""}`}>
            {/* Sidebar header (always visible) */}
            <div className="sidebar-header">
              <div className="brand">
                <h1>Stellar Agent Guard</h1>
                <span>operator console</span>
              </div>
              {/* Sidebar collapse/expand button (desktop only) */}
              {!isMobile && (
                <button
                  className="secondary sidebar-toggle"
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  aria-controls="sidebar-content"
                >
                  {sidebarCollapsed ? "»" : "«"}
                </button>
              )}
            </div>

            {/* Sidebar content */}
            <nav className="sidebar-content" aria-label="Main navigation">
              <div
                className="row"
                style={{ justifyContent: "space-between", marginBottom: "16px", gap: "8px" }}
              >
                <Tabs />
                <div className="row" style={{ gap: "8px", alignItems: "center" }}>
                  <PrivacyToggle />
                  <ThemeToggle />
                </div>
              </div>
              {children}
            </nav>
          </div>

          {/* Main content area */}
          <main className={`main-content ${sidebarCollapsed ? "expanded" : ""}`}>
            {/* Desktop-only header (if not mobile) */}
            {!isMobile && (
              <div
                className="row"
                style={{ justifyContent: "space-between", marginBottom: "16px" }}
              >
                <div className="spacer"></div> {/* Empty space to maintain height alignment */}
                <div className="spacer"></div>
              </div>
            )}
            <div className="content">{children}</div>
          </main>
        </div>

        {/* Mobile drawer backdrop */}
        {drawerOpen && (
          <div
            className="mobile-backdrop"
            onClick={() => setDrawerOpen(false)}
            role="presentation"
          />
        )}

        {/* Mobile drawer */}
        {drawerOpen && (
          <div
            className="mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-drawer-title"
          >
            <div className="mobile-drawer-header">
              <h2 id="mobile-drawer-title">Navigation</h2>
              <button
                className="secondary"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation menu"
              >
                ×
              </button>
            </div>
            <nav className="mobile-drawer-content" aria-label="Mobile navigation">
              <div
                className="row"
                style={{ justifyContent: "space-between", marginBottom: "16px", gap: "8px" }}
              >
                <Tabs />
                <div className="row" style={{ gap: "8px", alignItems: "center" }}>
                  <PrivacyToggle />
                  <ThemeToggle />
                </div>
              </div>
              {children}
            </nav>
          </div>
        )}
      </ThemeProvider>
    </>
  );
}
