import authWorker from "./index.js";
import { handleShortRedirect, shortRedirectKey } from "./short-redirects.js";

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const frontendOrigin = new URL(env.FRONTEND_ORIGIN);
    const hostname = url.hostname.toLowerCase();

    if (hostname === `www.${frontendOrigin.hostname.toLowerCase()}`) {
      const target = new URL(`${url.pathname}${url.search}`, frontendOrigin);
      return new Response(null, {
        status: 308,
        headers: {
          Location: target.toString(),
          "Cache-Control": "no-store",
        },
      });
    }

    const key = shortRedirectKey(hostname, env);
    if (key) {
      return handleShortRedirect(request, env, key);
    }

    const response = await authWorker.fetch(request, env, context);
    return removeUnsupportedAuthorizeParameters(url, response);
  },
};

function removeUnsupportedAuthorizeParameters(requestUrl, response) {
  if (requestUrl.pathname !== "/auth/login" || response.status < 300 || response.status >= 400) {
    return response;
  }

  const location = response.headers.get("Location");
  if (!location) return response;

  const target = new URL(location);
  if (target.origin !== "https://github.com" || target.pathname !== "/login/oauth/authorize") {
    return response;
  }

  target.searchParams.delete("repository_id");
  const headers = new Headers(response.headers);
  headers.set("Location", target.toString());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
