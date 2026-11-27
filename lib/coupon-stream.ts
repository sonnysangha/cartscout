import { ConvexClient } from "convex/browser";
import { after } from "next/server";
import { api } from "@/convex/_generated/api";
import { corsHeaders, handleRouteError } from "@/lib/backend";

export const COUPON_STREAM_TYPE = "application/x-ndjson";

export function streamCouponScan(
  request: Request,
  token: string,
  result: () => Promise<unknown>,
  resume = false,
) {
  const address = process.env.CONVEX_URL?.trim() || process.env.NEXT_PUBLIC_CONVEX_URL?.trim()
    || process.env.CONVEX_SITE_URL?.trim().replace(/\.convex\.site\/?$/, ".convex.cloud");
  if (!address) return null;

  const client = new ConvexClient(address);
  const encoder = new TextEncoder();
  let cancel = () => {};
  let work: Promise<void> | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const push = (value: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener("abort", stop);
        clearTimeout(timer);
        unsubscribe?.();
        void client.close().catch(() => {});
      };
      const stop = () => {
        if (closed) return;
        cleanup();
        controller.close();
      };
      cancel = cleanup;
      const finish = () => {
        work ??= result().then(data => {
          push({ type: "result", status: 200, data });
        }).catch(async error => {
          const response = handleRouteError(request, error);
          push({ type: "result", status: response.status, data: await response.json() });
        }).finally(stop);
      };

      push({ type: "connected" });
      unsubscribe = client.onUpdate(api.couponProgress.read, { token }, update => {
        if (!update || update.finished) {
          if (resume) finish();
        } else {
          push({ type: "progress", checked: update.checked, total: update.total, coupons: update.coupons });
        }
      }, () => {
        if (resume) finish();
      });
      request.signal.addEventListener("abort", stop, { once: true });
      if (!resume) finish();
      else timer = setTimeout(finish, 110_000);
      if (request.signal.aborted) stop();
    },
    cancel() { cancel(); },
  });
  // Closing the popup cancels its subscription. The scan can still save its final result.
  if (!resume) after(async () => { await work; });
  return new Response(body, {
    headers: {
      "Content-Type": `${COUPON_STREAM_TYPE}; charset=utf-8`,
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      ...corsHeaders(request),
    },
  });
}
