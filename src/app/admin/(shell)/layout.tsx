import { requirePlatformAdmin } from "@/lib/admin/session";
import { AdminNav } from "./admin-nav-menu";
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
      <AdminNav email={session.user.email} />
      <main id="admin-main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
        {children}
      </main>
    </div>
  );
}
