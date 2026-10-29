/**
 * UPLOADS GO OUT THROUGH `XMLHttpRequest` NOW (it is the only API that reports upload progress —
 * see `postWithProgress` in `composer/attachments.ts`), while these tests describe the server by
 * stubbing `global.fetch`. This stand-in bridges the two: an XHR whose `send` calls whatever
 * `globalThis.fetch` is at that moment, reports a half-way and a finished progress event, and
 * turns a rejected fetch into `onerror` the way a dropped connection does.
 *
 * Install it after `GlobalRegistrator.register()`, which puts happy-dom's own XHR on the global.
 */
type ProgressLike = {
  lengthComputable: boolean;
  loaded: number;
  total: number;
};

export class FetchBackedXhr {
  status = 0;
  responseText = "";
  withCredentials = false;
  upload: { onprogress: ((event: ProgressLike) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private method = "GET";
  private url = "";

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body?: BodyInit | null) {
    const total = 100;
    void (async () => {
      try {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total });
        const response = await globalThis.fetch(this.url, {
          method: this.method,
          credentials: this.withCredentials ? "include" : "same-origin",
          body: body ?? null,
        });
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: total,
          total,
        });
        this.status = response.status;
        this.responseText = await response.text().catch(() => "");
        this.onload?.();
      } catch {
        this.onerror?.();
      }
    })();
  }

  abort() {
    this.onabort?.();
  }
}

export function installFetchBackedXhr() {
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FetchBackedXhr;
}
