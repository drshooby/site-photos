export type Photo = {
  id: string;
  title: string;
  isPublic: boolean;
  createdAt: string;
  urls: { thumb: string; medium: string; large: string };
};

export type PhotosResponse = { photos: Photo[] };

export type PresignResponse = {
  url: string;
  fields: Record<string, string>;
  photoId: string;
};
