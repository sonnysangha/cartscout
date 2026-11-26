import {
  authenticateRequest,
  handleReport,
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
    const { identity, reporter } = await authenticateRequest(request);
    const body = await readJsonBody(request);
    const result = await handleReport(body, identity, reporter);
    return jsonResponse(request, 200, result);
  } catch (error) {
    return handleRouteError(request, error);
  }
}
