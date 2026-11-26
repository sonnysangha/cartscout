import {
  authenticateRequest,
  getConvexStore,
  handleRouteError,
  jsonResponse,
  optionsResponse,
} from "@/lib/backend";

export async function OPTIONS(request: Request) {
  return optionsResponse(request);
}

export async function GET(request: Request) {
  try {
    const { identity } = await authenticateRequest(request);
    const store = getConvexStore();
    const isPro = identity.plan === "pro";
    if (!isPro) {
      return jsonResponse(request, 200, {
        locked: true,
        count: await store.winsCount(Date.now()),
        wins: [],
      });
    }
    return jsonResponse(request, 200, {
      locked: false,
      wins: await store.recentWins(Date.now(), 12),
    });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
