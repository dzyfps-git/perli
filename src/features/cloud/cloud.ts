import type { CloudKind, CloudPlace, S3Setup, ServerSetup } from "../../api";

/** Where Perli's own cloud places show, as a server shows its shares. */
export const CLOUD_ROOT = "\\\\Perli Cloud";

/** True for the list of places and anything in one. */
export function isPerliCloud(path: string) {
  const low = path.toLowerCase().replace(/\\+$/, "");
  const root = CLOUD_ROOT.toLowerCase();
  return low === root || low.startsWith(`${root}\\`);
}

/** The name of the place a cloud path is in, or undefined for the list of places. */
export const placeName = (path: string) => (isPerliCloud(path) ? path.slice(CLOUD_ROOT.length + 1).split("\\")[0] || undefined : undefined);

/** A place's own folder, not one inside it. */
export const isPlaceRoot = (path: string) => !!placeName(path) && path.replace(/\\+$/, "").split("\\").length === 4;

export const placePath = (place: CloudPlace) => `${CLOUD_ROOT}\\${place.name}`;

export const KIND_LABELS: Record<CloudKind, string> = {
  s3: "S3 storage",
  oneDrive: "OneDrive",
  dropbox: "Dropbox",
  google: "Google Drive",
  phone: "Phone",
  webDav: "WebDAV",
  ftp: "FTP",
  sftp: "SFTP",
};

export interface S3Preset {
  id: string;
  label: string;
  region: string;
  /** What the form asks for in place of the region, such as R2's account. */
  asks?: string;
  /** The address from the region, or from what it asks for. None: the user types it. */
  endpoint?: (value: string) => string;
  /** The bucket goes in the path rather than in the host name. */
  pathStyle?: boolean;
}

export const S3_PRESETS: S3Preset[] = [
  { id: "aws", label: "Amazon S3", region: "us-east-1", endpoint: (region) => `https://s3.${region}.amazonaws.com` },
  { id: "r2", label: "Cloudflare R2", region: "auto", asks: "Account ID", endpoint: (account) => `https://${account}.r2.cloudflarestorage.com` },
  { id: "b2", label: "Backblaze B2", region: "us-west-004", endpoint: (region) => `https://s3.${region}.backblazeb2.com` },
  { id: "wasabi", label: "Wasabi", region: "us-east-1", endpoint: (region) => `https://s3.${region}.wasabisys.com` },
  { id: "minio", label: "MinIO", region: "us-east-1", pathStyle: true },
  { id: "custom", label: "Other S3 storage", region: "us-east-1" },
];

export interface S3Fields {
  /** The region, or what the preset asks for in its place. */
  value: string;
  endpoint: string;
  bucket: string;
  keyId: string;
  pathStyle: boolean;
}

/** The setup the form's fields make. An address typed with no scheme gets https. */
export function s3Setup(preset: S3Preset, fields: S3Fields): S3Setup {
  const value = fields.value.trim();
  const typed = fields.endpoint.trim();
  const endpoint = preset.endpoint ? preset.endpoint(value || preset.region) : /^[a-z]+:\/\//i.test(typed) ? typed : `https://${typed}`;
  return {
    preset: preset.id,
    endpoint: endpoint.replace(/\/+$/, ""),
    region: preset.asks ? preset.region : value || preset.region,
    bucket: fields.bucket.trim(),
    pathStyle: preset.pathStyle ?? fields.pathStyle,
    keyId: fields.keyId.trim(),
  };
}

/** What still keeps the form from going, or undefined once it can. */
export function s3Missing(preset: S3Preset, fields: S3Fields, secret: string) {
  if (preset.asks && !fields.value.trim()) return `Type the ${preset.asks}`;
  if (!preset.endpoint && !fields.endpoint.trim()) return "Type the address, such as http://localhost:9000";
  if (!fields.bucket.trim()) return "Type the bucket's name";
  if (!fields.keyId.trim() || !secret) return "Type the access key and its secret";
  return undefined;
}

export type ServerProtocol = "sftp" | "ftp" | "ftps" | "webDav";

export const SERVER_PROTOCOLS: { id: ServerProtocol; label: string; port: number; note: string }[] = [
  { id: "sftp", label: "SFTP", port: 22, note: "Over SSH, as Linux servers and NAS boxes have" },
  { id: "ftps", label: "FTPS", port: 21, note: "FTP over TLS" },
  { id: "ftp", label: "FTP", port: 21, note: "Sent as plain text: for a home network or an old server" },
  { id: "webDav", label: "WebDAV", port: 0, note: "Nextcloud, ownCloud, Synology or a NAS" },
];

export interface ServerFields {
  host: string;
  port: string;
  user: string;
  folder: string;
  keyFile: string;
}

/** What still has to be typed before a server can be tried, or undefined when nothing does. */
export function serverMissing(protocol: ServerProtocol, fields: ServerFields) {
  if (!fields.host.trim()) return protocol === "webDav" ? "Type the address, such as https://cloud.example.com/remote.php/dav/files/me" : "Type the server's name or address";
  const port = fields.port.trim();
  if (port && !(/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536)) return "A port is a number from 1 to 65535";
  return undefined;
}

/** The kind and setup the server sheet's fields stand for. `hostKey` is the one a Test showed. */
export function serverSetup(protocol: ServerProtocol, fields: ServerFields, hostKey = ""): { kind: CloudKind; server: ServerSetup } {
  const server: ServerSetup = {
    host: fields.host.trim(),
    port: Number(fields.port.trim()) || 0,
    user: fields.user.trim(),
    folder: protocol === "webDav" ? "" : fields.folder.trim().replace(/\\/g, "/"),
    secure: protocol === "ftps",
    keyFile: protocol === "sftp" ? fields.keyFile.trim().replace(/^"|"$/g, "") : "",
    hostKey: protocol === "sftp" ? hostKey : "",
  };
  return { kind: protocol === "ftps" ? "ftp" : protocol, server };
}

/** A name for a server place: its host, with no scheme or path. */
export const serverName = (host: string) => host.trim().replace(/^[a-z]+:\/\//i, "").split(/[/:]/)[0] || "Server";
