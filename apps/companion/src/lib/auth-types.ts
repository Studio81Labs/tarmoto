import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface User {
    id: string;
    email: string;
    displayName: string;
    phone?: string | undefined;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }

  interface Session {
    user: {
      id: string;
      email: string;
      displayName: string;
      phone?: string | undefined;
    };
    accessToken: string;
    error?: "RefreshTokenError";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    email: string;
    displayName: string;
    phone?: string | undefined;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    error?: "RefreshTokenError" | undefined;
  }
}
