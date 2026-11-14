// Parts of hyparquet-compressors, which ships them as plain JavaScript without their own types.
declare module "hyparquet-compressors/src/brotli.js" {
  export function decompressBrotli(input: Uint8Array, outputLength: number): Uint8Array;
}
declare module "hyparquet-compressors/src/gzip.js" {
  export function gunzip(input: Uint8Array, output: Uint8Array): Uint8Array;
}
declare module "hyparquet-compressors/src/lz4.js" {
  export function decompressLz4(input: Uint8Array, outputLength: number): Uint8Array;
  export function decompressLz4Raw(input: Uint8Array, outputLength: number): Uint8Array;
}
