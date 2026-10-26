/**
 * Configuration the server injects into `index.html` at request time (see the
 * server's `runtimeConfigMiddleware`). It is read rather than bundled so the
 * values track the deployment that served the page, not whatever was true when
 * the bundle was built.
 */
export interface RuntimeConfig {
  networkId?: string;
  /** The drip the server dispenses, as whole tNIGHT, ready to render. */
  dropAmountTNight?: string;
}

declare global {
  interface Window {
    __APP_CONFIG__?: RuntimeConfig;
  }
}

export const runtimeConfig = (): RuntimeConfig => window.__APP_CONFIG__ ?? {};
