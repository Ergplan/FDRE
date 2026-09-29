// Page-level gate: send signed-out visitors to /login. API routes check the session
// themselves (they are excluded here so large engine uploads are not buffered).
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "./lib/session";

const PUBLIC = ["/login", "/setup"];

export async function proxy(request) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  const session = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();
  const url = new URL("/login", request.url);
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|report_assets|.*\\.(?:png|jpg|svg|ico|json|js|css|woff2?)$).*)"],
};
