export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 10_000);
}

export function safeFilename(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'document';
}
