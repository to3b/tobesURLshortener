import authWorker from "./index.js";
import { handleShortRedirect, shortRedirectKey } from "./short-redirects.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const frontendOrigin = new URL(env.FRONTEND_ORIGIN);
    const authOrigin = new URL(env.AUTH_ORIGIN);
    const hostname = url.hostname.toLowerCase();

    if (hostname === `www.${frontendOrigin.hostname.toLowerCase()}`) {
      const target = new URL(`${url.pathname}${url.search}`, frontendOrigin);
      return new Response(null, {
        status: 308,
        headers: {
          Location: target.toString(),
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    }

    const key = shortRedirectKey(hostname, env);
    if (key) {
      return handleShortRedirect(request, env, key);
    }

    if (hostname === authOrigin.hostname.toLowerCase()) {
      return authWorker.fetch(request, env);
    }

    return new Response("Not found.\n", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  },
};
