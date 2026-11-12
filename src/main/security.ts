import type { Session } from "electron";

/**
 * A local document needs no web capabilities. Deny every permission request
 * and pin the content policy; the renderer cannot reach the network at all.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function hardenSession(session: Session): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders ?? {}) };
    responseHeaders["Content-Security-Policy"] = [CONTENT_SECURITY_POLICY];
    callback({ responseHeaders });
  });
}
