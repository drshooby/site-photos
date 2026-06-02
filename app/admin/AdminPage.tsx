"use client";

import { useState } from "react";
import { AdminUpload } from "@/components/AdminUpload";
import { AdminPhotoList } from "@/components/AdminPhotoList";
import styles from "./admin.module.css";

export function AdminPage() {
  const [refreshSignal, setRefreshSignal] = useState(0);
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>David Shubov</p>
        <h1 className={styles.title}>Admin</h1>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Upload</h2>
        <AdminUpload onUploaded={() => setRefreshSignal((n) => n + 1)} />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Photos</h2>
        <AdminPhotoList refreshSignal={refreshSignal} />
      </section>
    </main>
  );
}
