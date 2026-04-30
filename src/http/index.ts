/**
 * Phase 6 \u2014 HTTP transport barrel.
 */

export {
  routeRequest,
  listRoutes,
  _resetInboundRegistryForTesting,
  _resetRateLimitersForTesting,
} from './router.js';
export { createNodeListener, startCockpitServer } from './node-adapter.js';
export { cloudFunctionsHandler } from './cloud-functions-adapter.js';
export {
  TokenBucketLimiter,
  checkAdminAuth,
  defaultSecurityHeaders,
  rateLimitConfigFromEnv,
  requestIdFor,
} from './security.js';
export type {
  CockpitHttpRequest,
  CockpitHttpResponse,
  CockpitRoute,
  CockpitRouteHandler,
} from './types.js';
export type { RouteInfo } from './router.js';
export type { RunningServer, StartServerOptions } from './node-adapter.js';
export type { RateLimitConfig, RateLimitDecision } from './security.js';
