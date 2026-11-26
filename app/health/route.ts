import { jsonResponse, optionsResponse } from "@/lib/backend";

export async function OPTIONS(request: Request) {
  return optionsResponse(request);
}

export async function GET(request: Request) {
  return jsonResponse(request, 200, { ok: true, runtime: "nextjs+convex" });
}
