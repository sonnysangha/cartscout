import {
  authenticateRequest,
  handleAlternativesLookup,
  handleRouteError,
  jsonResponse,
  optionsResponse,
  readJsonBody,
} from "@/lib/backend";

export async function OPTIONS(request: Request) {
  return optionsResponse(request);
}

export async function POST(request: Request) {
  try {
    await authenticateRequest(request);
    const result = await handleAlternativesLookup(await readJsonBody(request), true);
    return jsonResponse(request, 200, result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
