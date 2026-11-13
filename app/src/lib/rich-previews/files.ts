import { tryClient } from "@/lib/client";

/**
 * 同站文件的「还在不在 / 多大」探测：一次 HEAD 拿状态码和 content-length。
 * `missing` 只对 404 成立；其它答案（含网络失败前的拒答）都不算「没了」。
 */
export async function probeRemoteFile(
  url: string,
): Promise<{ missing: boolean; size: number | null }> {
  const response = await tryClient(url, { method: "HEAD" });
  const length = Number(response.headers.get("content-length"));
  return {
    missing: response.status === 404,
    size:
      response.ok && Number.isFinite(length) && length > 0 ? length : null,
  };
}

/** 同站文件的大小（拿不到为 null）；用于「文件卡显示大小」的 queryFn。 */
export async function remoteFileSize(url: string): Promise<number | null> {
  const { size } = await probeRemoteFile(url);
  return size;
}

/** 文本文件的正文（预览用，大文件可能慢，不设请求超时）。失败抛带状态码的 Error。 */
export async function readFileText(url: string): Promise<string> {
  const response = await tryClient(url, { timeoutMs: 0 });
  if (!response.ok) throw new Error(String(response.status));
  return response.text();
}

/** 文件二进制（docx 预览用，可能几 MB，不设请求超时）。失败抛带状态码的 Error。 */
export async function downloadFileBlob(
  url: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await tryClient(url, { signal, timeoutMs: 0 });
  if (!response.ok) throw new Error(String(response.status));
  return response.blob();
}
