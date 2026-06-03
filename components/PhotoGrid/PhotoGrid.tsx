import Image from "next/image";
import type { Photo } from "@/lib/api/types";
import styles from "./PhotoGrid.module.css";

export type PhotoGridProps = {
  photos: Photo[];
};

export function PhotoGrid({ photos }: PhotoGridProps) {
  if (photos.length === 0) {
    return <p className={styles.empty}>No photographs yet.</p>;
  }

  return (
    <div className={styles.columns}>
      {photos.map((p) => (
        <a
          key={p.id}
          href={p.urls.large}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.cell}
        >
          <Image
            src={p.urls.medium}
            alt={p.title || ""}
            width={p.width}
            height={p.height}
            sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 33vw"
            className={styles.img}
          />
          {p.title ? <p className={styles.title}>{p.title}</p> : null}
        </a>
      ))}
    </div>
  );
}
