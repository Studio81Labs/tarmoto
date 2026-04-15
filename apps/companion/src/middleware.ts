import { auth } from "@/lib/auth";

export default auth((req) => {
  const { nextUrl, auth: session } = req;
  const isAuthenticated = !!session?.user;
  const isAuthPage = nextUrl.pathname.startsWith("/login") ||
    nextUrl.pathname.startsWith("/register") ||
    nextUrl.pathname.startsWith("/forgot-password");
  const isApiRoute = nextUrl.pathname.startsWith("/api");

  if (isApiRoute) return;

  if (isAuthPage && isAuthenticated) {
    return Response.redirect(new URL("/", nextUrl));
  }

  if (!isAuthPage && !isAuthenticated) {
    const loginUrl = new URL("/login", nextUrl);
    loginUrl.searchParams.set("callbackUrl", nextUrl.pathname);
    return Response.redirect(loginUrl);
  }
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
