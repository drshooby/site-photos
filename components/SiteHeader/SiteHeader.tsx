import Link from "next/link";
import { getCurrentEmail } from "@/lib/auth/session";
import { getCurrentRole } from "@/lib/auth/roles";
import styles from "./SiteHeader.module.css";

export async function SiteHeader() {
  const email = await getCurrentEmail();
  const role = email ? await getCurrentRole() : null;

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand}>
          Gallery
        </Link>
        <nav className={styles.nav}>
          {email ? (
            <>
              <span className={styles.identity}>
                {email}
                {role ? (
                  <span className={styles.role}>
                    {" · "}
                    {role === "admin" ? (
                      <Link href="/admin" className={styles.roleLink}>
                        {role}
                      </Link>
                    ) : (
                      role
                    )}
                  </span>
                ) : null}
              </span>
              <Link href="/auth/logout" className={styles.link}>
                Sign out
              </Link>
            </>
          ) : (
            <Link href="/auth/login" className={styles.link}>
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
