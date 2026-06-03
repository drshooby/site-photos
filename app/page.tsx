import { listPrivatePhotos, listPublicPhotos } from "@/lib/api/client";
import { PhotoGrid } from "@/components/PhotoGrid";
import type { Photo } from "@/lib/api/types";
import styles from "./page.module.css";

function merge(public_: Photo[], private_: Photo[]): Photo[] {
  const byId = new Map<string, Photo>();
  for (const p of public_) byId.set(p.id, p);
  for (const p of private_) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export default async function HomePage() {
  const pub = await listPublicPhotos();
  const priv = await listPrivatePhotos();
  const privPhotos = "forbidden" in priv ? [] : priv.photos;
  const photos = merge(pub.photos, privPhotos);

  return (
    <main className={styles.main}>
      <PhotoGrid photos={photos} />
    </main>
  );
}
