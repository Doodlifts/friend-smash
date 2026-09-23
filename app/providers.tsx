"use client";

/* app/providers.tsx — client-side context providers.
   AuthProvider = Rare Friends wallet sign-in (FriendSDK wallet + owned
   discovery + SIWE). It is lightweight (viem only), so it's always mounted. */

import AuthProvider from "@/components/auth/AuthProvider";

export default function Providers({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
