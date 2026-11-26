import {
  accountDetails,
  authenticateRequest,
  handleRouteError,
  jsonResponse,
  optionsResponse,
} from "@/lib/backend";

export async function OPTIONS(request: Request) {
  return optionsResponse(request);
}

export async function GET(request: Request) {
  try {
    const { identity, reporter } = await authenticateRequest(request);
    return jsonResponse(request, 200, await accountDetails(identity, reporter));
  } catch (error) {
    return handleRouteError(request, error);
  }
}
