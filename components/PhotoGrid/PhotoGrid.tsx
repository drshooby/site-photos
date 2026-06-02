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
    <ul className={styles.grid}>
      {photos.map((p) => (
        <li key={p.id} className={styles.cell}>
          <a
            href={p.urls.large}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.imgLink}
          >
            <Image
              src={p.urls.medium}
              alt={p.title || ""}
              width={1200}
              height={800}
              sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 33vw"
              className={styles.img}
            />
          </a>
          {p.title ? <p className={styles.title}>{p.title}</p> : null}
        </li>
      ))}
    </ul>
  );
}
