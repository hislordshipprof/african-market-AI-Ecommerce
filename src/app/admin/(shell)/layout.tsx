import { requirePlatformAdmin } from "@/lib/admin/session";
import { getAdminHomeCounts } from "@/lib/admin/home-counts";
import { Suspense } from "react";
import { AdminShell } from "./admin-nav-menu";
import { AdminAssistantDock } from "./assistant/admin-assistant-dock";
import styles from "./admin-shell.module.css";

export default async function AdminShellLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePlatformAdmin();

  return (
    <div className={`${styles.shell} lg:flex`}>
      <a
        href="#admin-main"
        className="sr-only z-50 rounded-md bg-card px-4 py-2 text-sm font-medium text-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-2 focus:outline-offset-2 focus:outline-ring"
      >
        Skip to content
      </a>
      {/* Not awaited: the menu badges stream in when the queue counts are read. */}
      <AdminShell email={session.user.email} counts={getAdminHomeCounts()}>
        {children}
      </AdminShell>
      <Suspense fallback={null}>
        <AdminAssistantDock />
      </Suspense>
    </div>
  );
}
