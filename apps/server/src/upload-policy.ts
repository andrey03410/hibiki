export const MAX_MEDIA_UPLOAD_BYTES = 2 * 1024 ** 3;
export const MAX_ARCHIVE_UPLOAD_BYTES = 20 * 1024 ** 3;
export function uploadPolicy(archive: boolean) {
  return {
    limits: {
      files: archive ? 1 : 100,
      fileSize: archive ? MAX_ARCHIVE_UPLOAD_BYTES : MAX_MEDIA_UPLOAD_BYTES,
      fields: 20,
    },
    throwFileSizeLimit: false,
  };
}
