import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign In — Store Admin",
  robots: { index: false, follow: false },
};

export default function SignInLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
