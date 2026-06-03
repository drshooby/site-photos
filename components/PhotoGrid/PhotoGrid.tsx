"use client";

import Image from "next/image";
import { MasonryPhotoAlbum } from "react-photo-album";
import "react-photo-album/masonry.css";
import type { Photo } from "@/lib/api/types";
import styles from "./PhotoGrid.module.css";

export type PhotoGridProps = {
  photos: Photo[];
};

export function PhotoGrid({ photos }: PhotoGridProps) {
  if (photos.length === 0) {
    return <p className={styles.empty}>No photographs yet.</p>;
  }

  const items = photos.map((p) => ({
    key: p.id,
    src: p.urls.medium,
    width: p.width,
    height: p.height,
    alt: p.title || "",
    href: p.urls.large,
    title: p.title,
  }));

  return (
    <MasonryPhotoAlbum
      photos={items}
      defaultContainerWidth={1280}
      columns={(w) => (w < 768 ? 1 : w < 1280 ? 2 : 3)}
      spacing={(w) => (w < 768 ? 20 : w < 1280 ? 24 : 32)}
      render={{
        image: (_, { photo }) => (
          <Image
            src={photo.src}
            alt={photo.alt || ""}
            width={photo.width}
            height={photo.height}
            sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 33vw"
            className={styles.img}
          />
        ),
        extras: (_, { photo }) =>
          photo.title ? <p className={styles.title}>{photo.title}</p> : null,
        link: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.cell}
          >
            {children}
          </a>
        ),
      }}
    />
  );
}
