export const USER_UPLOAD_MOUNT_PREFIX = "/mnt/user-uploads/";

export function isUserUploadMountPath(path: string): boolean {
  return (
    path.startsWith(USER_UPLOAD_MOUNT_PREFIX) &&
    !path.includes("..") &&
    !/[\r\n]/.test(path)
  );
}

export function buildUserUploadReference(path: string): string {
  if (!isUserUploadMountPath(path)) {
    throw new Error(
      `Upload completed without a readable ${USER_UPLOAD_MOUNT_PREFIX} path`,
    );
  }
  return `(user uploaded file to ${path})`;
}

export function appendUserUploadReferences(
  text: string,
  uploadPaths: string[],
): string {
  const rawContent = text.trim();
  if (uploadPaths.length === 0) {
    return rawContent;
  }

  const fileRefs = uploadPaths.map(buildUserUploadReference).join("\n");
  return rawContent ? `${rawContent}\n\n${fileRefs}` : fileRefs;
}
