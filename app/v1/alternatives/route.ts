import {
  authenticateRequest,
  handleAlternativesLookup,
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
    await authenticateRequest(request);
    const body = await readJsonBody(request);
    const result = await handleAlternativesLookup(body);
    return jsonResponse(request, 200, result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
