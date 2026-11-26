/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as cache from "../cache.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as ledger from "../ledger.js";
import type * as oxylabs from "../oxylabs.js";
import type * as store from "../store.js";
import type * as wins from "../wins.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  cache: typeof cache;
  crons: typeof crons;
  http: typeof http;
  ledger: typeof ledger;
  oxylabs: typeof oxylabs;
  store: typeof store;
  wins: typeof wins;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  actionCache: import("@convex-dev/action-cache/_generated/component.js").ComponentApi<"actionCache">;
};
