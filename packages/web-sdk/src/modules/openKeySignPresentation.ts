/**
 * The presentation OpenKey shows beside the requesting origin when it signs a runtime permission grant. It is display-only:
 * the signed bytes never include it, and the names are the app's own claims, which OpenKey renders as such.
 */
export interface OpenKeySignPresentation {
  protocolVersion: 1;
  displayName?: string;
  onBehalfOf?: string;
  iconUrl?: string;
}

/** The largest icon OpenKey accepts, as the length of its `data:` URI. */
const MAX_ICON_URI_LENGTH = 32 * 1024;
const ICON_DATA_URI = /^data:image\/(?:png|jpeg|webp)(?:;base64)?,/i;

/**
 * The presentation for a grant the app asks for. `iconUrl` is sent only as a small png, jpeg or webp `data:` URI, so OpenKey
 * never fetches a URL the app chose; any other icon is left out.
 */
export function openKeySignPresentation(
  manifest: { name: string; icon?: string },
  onBehalfOf: string | undefined,
): OpenKeySignPresentation {
  const icon = manifest.icon;
  const iconIsAccepted = icon !== undefined && icon.length <= MAX_ICON_URI_LENGTH && ICON_DATA_URI.test(icon);
  return {
    protocolVersion: 1,
    displayName: manifest.name,
    ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
    ...(iconIsAccepted ? { iconUrl: icon } : {}),
  };
}
