/**
 * A mail's HTML as a page for a frame with every sandbox flag off: no scripts, no forms, no way
 * out. What comes first rules, so the mail can't loosen it: nothing is fetched (no tracking
 * pictures, no fonts from elsewhere), only pictures inside the mail itself show, and a link would
 * open a window, which the sandbox doesn't allow, so a click goes nowhere.
 */
export function framedMail(html: string) {
  return [
    "<!doctype html>",
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    `<base target="_blank">`,
    "<style>html{color-scheme:light}body{margin:12px;font:13px/1.55 'Segoe UI',sans-serif;color:#1c1b20;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>",
    html,
  ].join("\n");
}
