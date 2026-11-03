// Fast redirect for signed-out visitors. This only checks that a session cookie exists;
// every page and API route still validates the session against the database.
import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (!request.cookies.has("cw_session")) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/permissions/:path*", "/merchant/:path*", "/passports/:path*", "/account"],
};
