export const LOCAL_HOST = 'local'

/** True for this Mac's local host; false for an SSH alias or an unknown host. */
export function isLocalHost(host: string | null | undefined): boolean {
  return host === LOCAL_HOST
}
