"use client";

import { useState } from "react";
import styles from "./AdminUpload.module.css";

const ALLOWED = ["image/jpeg", "image/png", "image/webp"];

export function AdminUpload({ onUploaded }: { onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [status, setStatus] = useState<string>("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (!ALLOWED.includes(file.type)) {
      setStatus("Unsupported file type. Use JPEG, PNG, or WebP.");
      return;
    }
    setStatus("Requesting upload URL.");

    const presignRes = await fetch("/api/admin/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
        title,
        isPublic,
      }),
    });
    if (!presignRes.ok) {
      setStatus(`Presign failed: ${presignRes.status}`);
      return;
    }
    const { url, fields, photoId } = await presignRes.json();

    setStatus("Uploading.");
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v as string);
    form.append("file", file);

    const upload = await fetch(url, { method: "POST", body: form });
    if (!upload.ok) {
      setStatus(`Upload failed: ${upload.status}`);
      return;
    }

    setStatus("Processing.");
    const start = Date.now();
    const deadline = start + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const list = await fetch("/api/admin/photos").then((r) => r.json());
      if (list.photos?.some((p: { id: string }) => p.id === photoId)) {
        setStatus("Done.");
        setFile(null);
        setTitle("");
        setIsPublic(false);
        onUploaded();
        return;
      }
      setStatus(`Processing (${Math.round((Date.now() - start) / 1000)}s).`);
    }
    setStatus("Still processing. Refresh later.");
  }

  return (
    <form onSubmit={submit} className={styles.form}>
      <label className={styles.field}>
        <span className={styles.label}>Title</span>
        <input
          className={styles.input}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>File</span>
        <input
          className={styles.fileInput}
          type="file"
          accept={ALLOWED.join(",")}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
      </label>

      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          checked={isPublic}
          onChange={(e) => setIsPublic(e.target.checked)}
        />
        <span>Public</span>
      </label>

      <div>
        <button className={styles.submit} type="submit" disabled={!file}>
          Upload
        </button>
      </div>

      {status ? <p className={styles.status}>{status}</p> : null}
    </form>
  );
}
