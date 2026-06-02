"use client";

import { useEffect, useState } from "react";
import type { Photo } from "@/lib/api/types";
import styles from "./AdminPhotoList.module.css";

export function AdminPhotoList({ refreshSignal }: { refreshSignal: number }) {
  const [photos, setPhotos] = useState<Photo[]>([]);

  async function load() {
    const res = await fetch("/api/admin/photos", { cache: "no-store" });
    if (res.ok) setPhotos((await res.json()).photos);
  }

  useEffect(() => {
    void load();
  }, [refreshSignal]);

  async function del(id: string) {
    if (!confirm(`Delete ${id}?`)) return;
    const res = await fetch("/api/admin/photo", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoId: id }),
    });
    if (res.ok) await load();
  }

  if (photos.length === 0) {
    return <p className={styles.empty}>No photos yet.</p>;
  }

  return (
    <ul className={styles.list}>
      {photos.map((p) => (
        <li key={p.id} className={styles.row}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className={styles.thumb}
            src={p.urls.thumb}
            alt={p.title}
            width={96}
            height={96}
          />
          <span className={styles.title}>{p.title}</span>
          <span className={styles.privacy}>
            {p.isPublic ? "Public" : "Private"}
          </span>
          <button
            className={styles.delete}
            type="button"
            onClick={() => del(p.id)}
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}
