import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Photo, PhotosResponse } from "./types";

const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export async function listMockPhotos(): Promise<PhotosResponse> {
  const dir = path.join(process.cwd(), "public/mock");

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { photos: [] };
  }

  const files = entries.filter((name) =>
    ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase()),
  );

  const entriesWithMtime = await Promise.all(
    files.map(async (filename): Promise<[number, Photo]> => {
      const filePath = path.join(dir, filename);
      const [stat, metadata] = await Promise.all([
        fs.stat(filePath),
        sharp(filePath).metadata(),
      ]);
      const ext = path.extname(filename);
      const id = path.basename(filename, ext);
      const url = `/mock/${filename}`;
      return [
        stat.mtimeMs,
        {
          id,
          title: id,
          isPublic: true,
          createdAt: stat.mtime.toISOString(),
          width: metadata.width ?? 0,
          height: metadata.height ?? 0,
          urls: { thumb: url, medium: url, large: url },
        },
      ];
    }),
  );

  entriesWithMtime.sort(([a], [b]) => b - a);

  return { photos: entriesWithMtime.map(([, photo]) => photo) };
}
