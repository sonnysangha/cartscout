import {
  ApiHttpError,
  authenticateRequest,
  handleCouponsLookup,
  handleRouteError,
  jsonResponse,
  optionsResponse,
  readJsonBody,
} from "@/lib/backend";

export const maxDuration = 60;

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
    const result = await handleCouponsLookup(
      body.merchant,
      cacheOnly,
      force,
      identity,
      reporter,
    );
    return jsonResponse(request, 200, result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
