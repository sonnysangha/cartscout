import {
  ApiHttpError,
  authenticateRequest,
  getConvexStore,
  handleCouponsLookup,
  handleRouteError,
  jsonResponse,
  optionsResponse,
  readJsonBody,
} from "@/lib/backend";
import { COUPON_STREAM_TYPE, streamCouponScan } from "@/lib/coupon-stream";
import { normalizeMerchant } from "@/server/oxylabs.js";

export const maxDuration = 120;

export async function OPTIONS(request: Request) {
  return optionsResponse(request);
}

export async function POST(request: Request) {
  try {
    const { identity, reporter } = await authenticateRequest(request);
    const body = await readJsonBody(request);
    if (Object.hasOwn(body, "cacheOnly") && typeof body.cacheOnly !== "boolean") {
      throw new ApiHttpError(400, "The cacheOnly option must be true or false.");
    }
    if (Object.hasOwn(body, "force") && typeof body.force !== "boolean") {
      throw new ApiHttpError(400, "The force option must be true or false.");
    }
    const cacheOnly = body.cacheOnly === true;
    const force = !cacheOnly && body.force === true;
    const merchant = normalizeMerchant(body.merchant);
    const lookup = (token?: string) => handleCouponsLookup(merchant, cacheOnly, force, identity, reporter, token);
    const streaming = request.headers.get("accept") === COUPON_STREAM_TYPE;
    const active = merchant && await getConvexStore().activeCouponProgress(reporter, merchant, Date.now()).catch(() => null);
    if (active) {
      const resumed = cacheOnly && streaming && streamCouponScan(request, active, lookup, true);
      if (resumed) return resumed;
      throw new ApiHttpError(409, "CartScout is already checking this shop.", { code: "scan_in_progress" });
    }
    if (streaming && !cacheOnly && merchant) {
      const token = crypto.randomUUID();
      const stream = streamCouponScan(request, token, () => lookup(token));
      if (stream) return stream;
    }
    const result = await lookup();
    return jsonResponse(request, 200, result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
